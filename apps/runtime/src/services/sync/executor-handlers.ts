import {
  aggregateTransactionTopSpenders,
  assertOwnedPageSyncLease,
  countRecentTerminalDmMessageConversationFailureStreak,
  countActivePageFollows,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  finalizePageDmConversationMessageSync,
  findPageById,
  getEarliestSpenderTransactionAt,
  getExistingPageDmMessageIds,
  getPageDmConversationById,
  getCheckpoint,
  getCurrentSubscribers,
  listPageDmConversationsByPlatformConversationIds,
  markPageDmConversationsInvisibleByGeneration,
  PAGE_DM_LIVE_BACKFILL_CAP,
  requestPageSync,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  selectNextPageDmMessageDeepBackfillCandidate,
  selectNextPageDmMessageSyncCandidate,
  updatePageSyncTimestampCache,
  upsertPageTopSpenders,
  listPageFanNativeIds,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertFanPages,
  upsertFanPageExternalPresences,
  upsertFans,
  upsertPageFollows,
  upsertPageSubscriptions,
  withOwnedPageSyncTransaction,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type DmSenderRole,
  type MessageCoverageStatus,
  type PageSyncLease,
  type SyncRequestSource,
  type SyncStream,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
  type UpsertPageSubscriptionInput,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  FanslyApiError,
  mapFanslySubscriptionStatus,
  type FanslyAccount,
  type FanslyFollower,
} from "@agency_hub_core/fansly";
import { sql } from "drizzle-orm";
import {
  buildFanslyDmConversationMetadata,
  fanslyFollowIdToDate,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  getFanslyDmMessageSyncExcludedReason,
  isFanslyDmMessageSyncExcluded,
  normalizeDmMessageText,
  millsFromInteger,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  type FanslyDmMessageSyncExcludedReason,
  type HttpRequestEvent,
  type HttpRequestObserver,
} from "@agency_hub_core/shared";

import type { CanonicalStream } from "@agency_hub_core/platform-core";

import { appPlatformRegistry } from "../../platforms/registry.ts";
import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import {
  resolvePageContextById,
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
  type ResolvedPageContext,
} from "../page-context.ts";
import {
  parseFanslyMetadataAccountCreatedAt,
  resolveFanslyPlatformAccountId,
} from "../fansly.ts";
import { buildFanslyFollowerPresenceSignals } from "../fansly-presence.ts";
import {
  summarizeCheckpoint,
  type DmMessagesChunkSummary,
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkYieldReason, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  emptyDmMessagesCursorState,
  parseDmConversationCursorState,
  parseDmMessagesCursorState,
  parseFollowersCursorState,
  parseFollowersReconcileCursorState,
  parseSubscribersCursorState,
  parseTopSpendersCursorState,
  type DmMessagesCursorState,
  type FollowersCursorState,
  type FollowersReconcileCursorState,
  type SubscribersCursorState,
  type TopSpendersCursorState,
  type TopSpendersCursorWindow,
} from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import {
  isOnlyFansDmPollingEnabled,
  isOnlyFansDmPollingStream,
  ONLYFANS_DM_POLLING_DISABLED_MESSAGE,
} from "./onlyfans-dm-polling.ts";
import {
  executeOfapiDmConversationsChunk,
  executeOfapiDmMessagesChunk,
  isOfapiDmSyncEligiblePage,
} from "./ofapi-dm-sync.ts";
import {
  executeOfapiAudienceChunk,
  isOfapiAudienceSyncEligiblePage,
} from "./ofapi-audience-sync.ts";
import {
  isOfapiFanIdentitiesEligiblePage,
  syncOfapiFanIdentities,
} from "./ofapi-fan-identities.ts";
import { isOnlyFansTopSpendersEnabled } from "./onlyfans-top-spenders.ts";
import {
  dmRetentionDate,
  normalizeDmTipAmountCents,
  normalizeFanslyTimestamp,
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
  trimFanslyFollowerPayload,
  trimFanslyMessagingGroupsPayload,
} from "./shared.ts";
import { lookupHydratedFans, upsertHydratedFansForPage, type HydrationCaptureContext } from "./fan-hydration.ts";
import { syncTransactions } from "./transactions.ts";

export type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

const DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD = 3;
const ONLYMONSTER_DM_MESSAGE_SYNC_EXCLUDED_REASON_CHAT_NOT_FOUND = "onlymonster_chat_not_found";
const TOP_SPENDERS_STEADY_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_SPENDERS_WINDOW_DAY_MS = 24 * 60 * 60 * 1000;
const TOP_SPENDERS_WINDOW_WEEK_MS = 7 * TOP_SPENDERS_WINDOW_DAY_MS;

function shouldSkipOnlyFansDmPolling(
  app: AppContext,
  input: {
    pageContext: ResolvedPageContext;
    stream: SyncStream;
  },
) {
  return input.pageContext.platform === "onlyfans" &&
    isOnlyFansDmPollingStream(input.stream) &&
    !isOnlyFansDmPollingEnabled(app.config) &&
    // OFAPI-mapped pages run their DM streams through the OFAPI REST handlers.
    !isOfapiDmSyncEligiblePage(app.config, input.pageContext.page);
}

function resolveDmConversationCoverageStatus(input: {
  currentMode: "backfill" | "deep_backfill" | "incremental";
  existingStatus: MessageCoverageStatus;
  overlapFound: boolean;
  providerHistoryExhausted: boolean;
  hitWindowCap: boolean;
}): MessageCoverageStatus {
  if (input.currentMode === "incremental") {
    return input.existingStatus;
  }

  if (input.providerHistoryExhausted || input.overlapFound) {
    return "complete";
  }

  if (input.currentMode === "deep_backfill") {
    return "partial_window";
  }

  if (input.hitWindowCap) {
    return "partial_window";
  }

  return input.existingStatus;
}

function shouldRequestDmMessagesFollowup(conversation: {
  fanId: number | null;
  isVisible: boolean;
  lastMessageId: string | null;
  newestStoredMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSyncAt: Date | null;
  messageCoverageStatus: MessageCoverageStatus;
  metadata: Record<string, unknown>;
}) {
  if (
    !conversation.isVisible ||
    conversation.fanId === null ||
    getFanslyDmMessageSyncExcludedReason(conversation.metadata) !== null
  ) {
    return false;
  }

  if (conversation.messageCoverageStatus === "pending_backfill") {
    return true;
  }

  if (conversation.lastMessageId === conversation.newestStoredMessageId) {
    return false;
  }

  return conversation.lastMessageSyncAt === null ||
    (conversation.lastMessageAt !== null && conversation.lastMessageSyncAt < conversation.lastMessageAt);
}

function createPageRateLimitWaiter(
  app: AppContext,
  pageContext: ResolvedPageContext,
) {
  return createSyncRateLimitWaiter(app, {
    egressKey: pageContext.egressKey,
  });
}

function resolveFanslyDmDeepBackfillContinuationDelayMs(
  config: Pick<
    AppContext["config"],
    "fanslyDmDeepBackfillContinuationDelayMs" | "fanslyDmDeepBackfillContinuationJitterMs"
  >,
) {
  const baseDelayMs = Math.max(0, config.fanslyDmDeepBackfillContinuationDelayMs ?? 0);
  const jitterMs = Math.max(0, config.fanslyDmDeepBackfillContinuationJitterMs ?? 0);
  if (baseDelayMs === 0 && jitterMs === 0) {
    return 0;
  }

  const jitterOffsetMs = jitterMs > 0
    ? Math.round((Math.random() * 2 - 1) * jitterMs)
    : 0;
  return Math.max(0, baseDelayMs + jitterOffsetMs);
}

function isFanslyDmDeepBackfillContinuationConfigured(
  config: Pick<
    AppContext["config"],
    "fanslyDmDeepBackfillContinuationDelayMs" | "fanslyDmDeepBackfillContinuationJitterMs"
  >,
) {
  return (config.fanslyDmDeepBackfillContinuationDelayMs ?? 0) > 0 ||
    (config.fanslyDmDeepBackfillContinuationJitterMs ?? 0) > 0;
}

function resolveFanslyDmDeepBackfillLiveRequestsPerDeep(
  config: Pick<AppContext["config"], "fanslyDmDeepBackfillLiveRequestsPerDeep">,
) {
  return Math.max(1, Math.floor(config.fanslyDmDeepBackfillLiveRequestsPerDeep ?? 4));
}

function getDmMessagesLiveRequestsSinceDeepBackfill(state: DmMessagesCursorState) {
  return Math.max(0, Math.floor(state.liveMessageRequestsSinceDeepBackfill ?? 0));
}

function setDmMessagesLiveRequestsSinceDeepBackfill(
  state: DmMessagesCursorState,
  value: number,
) {
  const next = { ...state };
  const normalized = Math.max(0, Math.floor(value));
  if (normalized > 0) {
    next.liveMessageRequestsSinceDeepBackfill = normalized;
  } else {
    delete next.liveMessageRequestsSinceDeepBackfill;
  }
  return next;
}

function incrementDmMessagesLiveRequestsSinceDeepBackfill(
  state: DmMessagesCursorState,
  quota: number,
) {
  return setDmMessagesLiveRequestsSinceDeepBackfill(
    state,
    Math.min(getDmMessagesLiveRequestsSinceDeepBackfill(state) + 1, quota),
  );
}

export type StreamChunkResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  continuationRetryAt?: Date | null;
  continuationRequestSource?: SyncRequestSource | null;
  stats?: Record<string, unknown>;
};

class DmMessagesChunkRequestObserver implements HttpRequestObserver {
  private readonly touchedConversationIds = new Set<number>();
  private readonly requestGapsMs: number[] = [];
  private requestCount = 0;
  private rateLimit429s = 0;
  private lastStartedAtMs: number | null = null;

  recordConversationTouched(conversationId: number) {
    this.touchedConversationIds.add(conversationId);
  }

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.operation !== "messages") {
      return;
    }

    if (event.state === "started") {
      this.requestCount += 1;

      const startedAtMs = event.timestamp instanceof Date ? event.timestamp.getTime() : Number.NaN;
      if (Number.isFinite(startedAtMs)) {
        if (this.lastStartedAtMs !== null) {
          this.requestGapsMs.push(startedAtMs - this.lastStartedAtMs);
        }
        this.lastStartedAtMs = startedAtMs;
      }
      return;
    }

    if ("httpStatus" in event && event.httpStatus === 429) {
      this.rateLimit429s += 1;
    }
  }

  buildSummary(chunkDurationMs: number): DmMessagesChunkSummary {
    const totalGapMs = this.requestGapsMs.reduce((sum, value) => sum + value, 0);
    return {
      conversationsProcessed: this.touchedConversationIds.size,
      messageFetchRequests: this.requestCount,
      rateLimit429s: this.rateLimit429s,
      chunkDurationMs,
      averageGapMs: this.requestGapsMs.length > 0
        ? Math.round(totalGapMs / this.requestGapsMs.length)
        : 0,
    };
  }
}


function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function hasUnresolvedIdentityMetadata(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.unresolvedIdentity === true;
}

type FanslyAccountResolution = "resolved" | "unresolved" | "unknown";

function isTerminalFanslyServerError(error: unknown): error is FanslyApiError & { status: number } {
  return error instanceof FanslyApiError &&
    typeof error.status === "number" &&
    error.status >= 500 &&
    error.status < 600;
}

async function probeFanslyAccountResolution(
  app: AppContext,
  requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0],
  partnerPlatformUserId: string,
  capture: { platformAccountId: number; syncRunId: number },
): Promise<FanslyAccountResolution> {
  let response: Awaited<ReturnType<AppContext["adapter"]["getAccountsByIdsPage"]>>;
  try {
    response = await app.adapter.getAccountsByIdsPage(requestContext, [partnerPlatformUserId]);
  } catch {
    // Only the probe fetch itself is best-effort ("unknown" verdict); the
    // journal write below stays outside this catch so a failed capture still
    // fails the chunk (Stage 7: never a silent drop).
    return "unknown";
  }

  await persistRawPayload(app.db, {
    platformAccountId: capture.platformAccountId,
    syncRunId: capture.syncRunId,
    endpoint: "account_lookup",
    requestParams: { ids: [partnerPlatformUserId], probe: true },
    responsePayload: response.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, {
    action: "inserting account_lookup probe raw payload",
    platform: "fansly",
  });

  if (!Array.isArray(response?.parsed)) {
    return "unknown";
  }
  if (response.parsed.length === 0) {
    return "unresolved";
  }
  return response.parsed.some((account) => account.id === partnerPlatformUserId)
    ? "resolved"
    : "unknown";
}

async function triggerFollowersReconcileAnomaly(
  app: AppContext,
  platformAccountId: number,
) {
  await requestPageSync(app.db, {
    pageId: platformAccountId,
    streams: ["followers_reconcile"],
    source: "anomaly",
    ...pageSyncDependencyInput(app),
  });
}

type FollowerMappingStream = "followers" | "followers_reconcile";

function uniqueFollowerIds(followers: FanslyFollower[]) {
  return Array.from(new Set(
    followers
      .map((follower) => follower.followerId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  ));
}

async function hydrateFanslyFollowerRows(
  app: AppContext,
  input: {
    requestContext: Parameters<AppContext["adapter"]["getAccountsByIdsPage"]>[0];
    followers: FanslyFollower[];
    accounts: FanslyAccount[];
    telemetry: SyncRunTelemetry;
    stream: FollowerMappingStream;
    offset: number;
    capture: HydrationCaptureContext;
  },
) {
  const sourceFollowerIds = uniqueFollowerIds(input.followers);
  const hydratedAccountsById = new Map<string, FanslyAccount>();

  for (const account of input.accounts) {
    if (account.id) {
      hydratedAccountsById.set(account.id, account);
    }
  }

  const missingAggregationIds = sourceFollowerIds.filter((id) => !hydratedAccountsById.has(id));
  const fallbackHydration = missingAggregationIds.length > 0
    ? await lookupHydratedFans(app, {
      requestContext: input.requestContext,
      platformUserIds: missingAggregationIds,
      telemetry: input.telemetry,
      capture: input.capture,
    })
    : {
      accounts: [] satisfies FanslyAccount[],
      fallbackIds: [] as string[],
    };

  for (const account of fallbackHydration.accounts) {
    if (account.id) {
      hydratedAccountsById.set(account.id, account);
    }
  }

  const fallbackIds = fallbackHydration.fallbackIds.filter(
    (id) => !hydratedAccountsById.has(id),
  );

  if (missingAggregationIds.length > 0) {
    await input.telemetry.addAnomaly({
      code: "followers_missing_aggregation_accounts",
      severity: "warn",
      message: "Follower page omitted aggregation account data for source follower rows; hydrated by ID fallback",
      details: {
        stream: input.stream,
        offset: input.offset,
        sourceFollowerCount: sourceFollowerIds.length,
        missingAggregationAccountCount: missingAggregationIds.length,
        fallbackHydrationMisses: fallbackIds.length,
        examples: missingAggregationIds.slice(0, 5),
      },
    });
  }

  return {
    sourceFollowerIds,
    accounts: Array.from(hydratedAccountsById.values()),
    fallbackIds,
  };
}

function findUnmappedFollowerIds(
  sourceFollowerIds: string[],
  fanMap: Map<string, number>,
) {
  return sourceFollowerIds.filter((id) => !fanMap.has(id));
}

async function recordFollowerMappingBlockedAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    stream: FollowerMappingStream;
    offset: number;
    unmappedFollowerIds: string[];
  },
) {
  await telemetry.addAnomaly({
    code: "followers_unmapped_source_rows",
    severity: "error",
    message: "Follower page contained source rows that could not be mapped after fallback hydration",
    details: {
      stream: input.stream,
      offset: input.offset,
      unmappedFollowerCount: input.unmappedFollowerIds.length,
      examples: input.unmappedFollowerIds.slice(0, 5),
    },
  });
}

function assertDmSharedRateLimitEnabled(app: AppContext) {
  if (!app.config.syncSharedRateLimitEnabled) {
    throw new Error("DM sync requires SYNC_SHARED_RATE_LIMIT_ENABLED=true");
  }
}

function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = normalizeDmMessageText(content);
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function isClearlyImplausibleDmTimestamp(timestamp: Date, now = new Date()) {
  return timestamp.getTime() < Date.UTC(2010, 0, 1) ||
    timestamp.getTime() > now.getTime() + (24 * 60 * 60 * 1000);
}

async function recordDmTimestampAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    rawValue: number | string;
    normalizedAt: Date;
  },
) {
  await telemetry.addAnomaly({
    code: "dm_timestamp_implausible",
    severity: "warn",
    message: "DM timestamp normalized to an implausible value",
    details: {
      context: input.context,
      rawValue: input.rawValue,
      normalizedAt: input.normalizedAt.toISOString(),
    },
  });
}

async function normalizeDmTimestampWithAnomaly(
  telemetry: SyncRunTelemetry,
  input: {
    context: string;
    value: number | null | undefined;
  },
) {
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return null;
  }

  const normalized = normalizeFanslyTimestamp(input.value);
  if (isClearlyImplausibleDmTimestamp(normalized)) {
    await recordDmTimestampAnomaly(telemetry, {
      context: input.context,
      rawValue: input.value,
      normalizedAt: normalized,
    });
  }

  return normalized;
}

function resolveDmSenderRole(
  senderId: string | null | undefined,
  pageAccountId: string,
  partnerPlatformUserId: string | null | undefined,
) {
  if (!senderId) {
    return "unknown" as const;
  }
  if (senderId === pageAccountId) {
    return "model" as const;
  }
  if (partnerPlatformUserId && senderId === partnerPlatformUserId) {
    return "fan" as const;
  }
  return "unknown" as const;
}

async function listOnlyFansKnownDmConversationCandidateIds(
  db: AppContext["db"],
  platformAccountId: number,
  limit = 1000,
) {
  const result = await db.execute<{ platformUserId: string }>(sql`
    select f.platform_user_id as "platformUserId"
    from page_fans fp
    join fans f on f.id = fp.fan_id
    left join fan_spend_lifetime slp
      on slp.platform_account_id = fp.platform_account_id
     and slp.fan_id = fp.fan_id
    where fp.platform_account_id = ${platformAccountId}
      and f.platform_user_id is not null
      and f.platform_user_id <> ''
      and greatest(
            coalesce(fp.total_creator_net_mills, 0),
            coalesce(slp.creator_net_amount_mills, 0)
          ) > 0
    order by greatest(
               coalesce(fp.total_creator_net_mills, 0),
               coalesce(slp.creator_net_amount_mills, 0)
             ) desc,
             slp.last_transaction_at desc nulls last,
             f.id asc
    limit ${limit}
  `);

  return result.rows.map((row) => row.platformUserId);
}

function buildUtcMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextUtcMonthBoundary(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function buildTopSpendersBootstrapWindows(
  accountCreatedAt: Date,
  now: Date,
) {
  const windows: TopSpendersCursorWindow[] = [];
  let cursor = new Date(accountCreatedAt);

  while (cursor.getTime() < now.getTime()) {
    const boundary = nextUtcMonthBoundary(cursor);
    const endedAt = new Date(Math.min(boundary.getTime(), now.getTime()));
    windows.push({
      kind: "month",
      monthKey: buildUtcMonthKey(cursor),
      startedAt: cursor.toISOString(),
      endedAt: endedAt.toISOString(),
    });
    cursor = endedAt;
  }

  return windows;
}

function splitTopSpendersWindow(window: TopSpendersCursorWindow) {
  const nextWindowMs = window.kind === "month"
    ? TOP_SPENDERS_WINDOW_WEEK_MS
    : window.kind === "week"
      ? TOP_SPENDERS_WINDOW_DAY_MS
      : null;
  const nextKind = window.kind === "month"
    ? "week"
    : window.kind === "week"
      ? "day"
      : null;
  if (nextWindowMs === null || nextKind === null) {
    return null;
  }

  const windows: TopSpendersCursorWindow[] = [];
  let cursor = new Date(window.startedAt);
  const endedAt = new Date(window.endedAt);

  while (cursor.getTime() < endedAt.getTime()) {
    const next = new Date(Math.min(cursor.getTime() + nextWindowMs, endedAt.getTime()));
    windows.push({
      kind: nextKind,
      monthKey: window.monthKey,
      startedAt: cursor.toISOString(),
      endedAt: next.toISOString(),
    });
    cursor = next;
  }

  return windows;
}

function computeCompletedTopSpenderMonths(
  totalMonths: number,
  pendingWindows: TopSpendersCursorWindow[],
) {
  const remainingMonths = new Set(pendingWindows.map((window) => window.monthKey)).size;
  return Math.max(0, totalMonths - remainingMonths);
}

function buildTopSpendersBootstrapState(
  accountCreatedAt: Date,
  now: Date,
): TopSpendersCursorState {
  const pendingWindows = buildTopSpendersBootstrapWindows(accountCreatedAt, now);
  return {
    version: 1,
    mode: "bootstrap",
    accountCreatedAt: accountCreatedAt.toISOString(),
    totalMonths: new Set(pendingWindows.map((window) => window.monthKey)).size,
    completedMonths: 0,
    pendingWindows,
    lastWindowStartedAt: null,
    lastWindowEndedAt: null,
  };
}

async function resolveFanslyTopSpendersAccountCreatedAt(
  app: AppContext,
  input: ExecutorRequestContext,
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Top spenders sync is only supported for Fansly pages");
  }

  const metadataCreatedAt = parseFanslyMetadataAccountCreatedAt(input.pageContext.page.metadata);
  if (metadataCreatedAt) {
    return metadataCreatedAt;
  }

  const refreshed = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
  return new Date(refreshed.parsed.account.createdAt);
}

function normalizeTopSpenderIdentityValue(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveTopSpenderSourceIdentity(input: {
  accountId?: string | null;
  correlationAccountId?: string | null;
}) {
  const correlationAccountId = normalizeTopSpenderIdentityValue(input.correlationAccountId);
  if (correlationAccountId) {
    return {
      sourceIdentityKey: `fan:${correlationAccountId}`,
      correlationAccountId,
      accountId: normalizeTopSpenderIdentityValue(input.accountId),
    };
  }

  const accountId = normalizeTopSpenderIdentityValue(input.accountId);
  if (accountId) {
    return {
      sourceIdentityKey: `account:${accountId}`,
      correlationAccountId: null,
      accountId,
    };
  }

  return null;
}

async function upsertTopSpendersWindow(
  app: AppContext,
  input: {
    platformAccountId: number;
    // Platform the correlation ids belong to when creating fan rows.
    platform?: "fansly" | "onlyfans";
    windowStartedAt: Date;
    windowEndedAt: Date;
    telemetry: SyncRunTelemetry;
    items: Array<{
      totalGross: number;
      totalNet: number;
      accountId?: string | null;
      correlationAccountId?: string | null;
    }>;
  },
) {
  if (input.items.length === 0) {
    return 0;
  }

  const validItems: Array<{
    totalGross: number;
    totalNet: number;
    sourceIdentityKey: string;
    accountId: string | null;
    correlationAccountId: string | null;
  }> = [];
  const skippedIdentityExamples: Array<{
    accountId: string | null;
    correlationAccountId: string | null;
  }> = [];

  for (const item of input.items) {
    const identity = resolveTopSpenderSourceIdentity(item);
    if (!identity) {
      if (skippedIdentityExamples.length < 5) {
        skippedIdentityExamples.push({
          accountId: normalizeTopSpenderIdentityValue(item.accountId),
          correlationAccountId: normalizeTopSpenderIdentityValue(item.correlationAccountId),
        });
      }
      continue;
    }

    validItems.push({
      totalGross: item.totalGross,
      totalNet: item.totalNet,
      sourceIdentityKey: identity.sourceIdentityKey,
      accountId: identity.accountId,
      correlationAccountId: identity.correlationAccountId,
    });
  }

  if (skippedIdentityExamples.length > 0) {
    await input.telemetry.addAnomaly({
      code: "top_spenders_missing_identity",
      severity: "warn",
      message: "Skipped top spender rows missing both correlationAccountId and accountId",
      details: {
        skippedCount: input.items.length - validItems.length,
        examples: skippedIdentityExamples,
      },
    });
  }

  if (validItems.length === 0) {
    return 0;
  }

  const fanInputs = validItems.flatMap((item) => (
    item.correlationAccountId
      ? [{
        platform: input.platform ?? "fansly" as const,
        platformUserId: item.correlationAccountId,
      }]
      : []
  ));
  await withOwnedPageSyncTransaction(app.db, async (db) => {
    const fans = fanInputs.length > 0
      ? await upsertFans(db, fanInputs)
      : [];
    const fanIdByPlatformUserId = new Map(
      fans.map((fan) => [fan.platformUserId, fan.id] satisfies [string, number]),
    );

    await upsertPageTopSpenders(db, validItems.map((item) => ({
      platformAccountId: input.platformAccountId,
      sourceIdentityKey: item.sourceIdentityKey,
      correlationAccountId: item.correlationAccountId,
      accountId: item.accountId,
      fanId: item.correlationAccountId
        ? (fanIdByPlatformUserId.get(item.correlationAccountId) ?? null)
        : null,
      grossAmountMills: BigInt(Math.trunc(item.totalGross)),
      creatorNetAmountMills: BigInt(Math.trunc(item.totalNet)),
      sourceWindowStartedAt: input.windowStartedAt,
      sourceWindowEndedAt: input.windowEndedAt,
    })));
  });

  return validItems.length;
}

export async function fanslyLightChunk(
  app: AppContext,
  input: ExecutorRequestContext,
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("fanslyLightChunk received a non-fansly page");
  }
  await input.telemetry.recordPhaseStarted("page_metadata");
  const account = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
  await withOwnedPageSyncTransaction(app.db, async (db) => {
    await updatePageSyncTimestampCache(db, {
      pageId: input.pageContext.page.id,
      syncType: "light",
    });
  });

  return {
    satisfied: true,
    yieldReason: null,
    stats: {
      followerCount: account.parsed.account.followCount,
      subscriberCount: account.parsed.account.subscriberCount,
    },
  } satisfies StreamChunkResult;
}

export async function onlyfansLightChunk(
  app: AppContext,
  input: ExecutorRequestContext,
) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("onlyfansLightChunk received a non-onlyfans page");
  }
  // OnlyMonster metadata refresh retired (Stage 18): OnlyFans page identity
  // is static post-onboarding; counts ride the OFAPI audience sweep. An
  // OFAPI-native metadata refresh is a recorded follow-up, not a blocker.
  await input.telemetry.recordPhaseStarted("page_metadata");
  await withOwnedPageSyncTransaction(app.db, async (db) => {
    await updatePageSyncTimestampCache(db, {
      pageId: input.pageContext.page.id,
      syncType: "light",
    });
  });

  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlymonster_retired" },
  } satisfies StreamChunkResult;
}

export async function onlyfansTopSpendersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    syncRunId: number;
  },
) {
  if (isOnlyFansTopSpendersEnabled(app.config)) {
    return executeOnlyFansTopSpendersChunk(app, input);
  }
  // The planner force-pauses the stream while the flag is off, but a manual
  // block resume can race one run in before the next planner cycle re-pauses
  // it — skip gracefully instead of recording a failure (DM-polling pattern).
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_top_spenders_disabled" },
  } satisfies StreamChunkResult;
}

export async function fanslyTopSpendersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Top spenders sync is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("top_spenders");
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "top_spenders");
  await input.telemetry.recordCheckpointLoaded("top_spenders", summarizeCheckpoint(checkpoint));

  const now = new Date();
  const accountCreatedAt = await resolveFanslyTopSpendersAccountCreatedAt(app, input);
  const accountCreatedAtIso = accountCreatedAt.toISOString();
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };

  let initialState = parseTopSpendersCursorState(checkpoint?.state);
  if (!initialState || initialState.accountCreatedAt !== accountCreatedAtIso) {
    initialState = buildTopSpendersBootstrapState(accountCreatedAt, now);
    const initializedCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      state: initialState,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(initializedCheckpoint),
    );
  }
  if (!initialState) {
    throw new Error("Failed to initialize top spenders checkpoint state");
  }
  let state: TopSpendersCursorState = initialState;

  let windowsProcessed = 0;
  let windowsSplit = 0;
  let upsertedRankings = 0;

  const processPendingWindows = async () => {
    while (state.pendingWindows.length > 0) {
      await assertOwnedPageSyncLease(app.db);
      const currentWindow: TopSpendersCursorWindow = state.pendingWindows[0]!;
      const windowStartedAt = new Date(currentWindow.startedAt);
      const windowEndedAt = new Date(currentWindow.endedAt);
      const response = await app.adapter.getEarningsAccountsPage(requestContext, {
        after: windowStartedAt,
        before: windowEndedAt,
      });
      await persistRawPayload(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncRunId: input.syncRunId,
        endpoint: "earnings_accounts",
        requestParams: {
          after: currentWindow.startedAt,
          before: currentWindow.endedAt,
          windowKind: currentWindow.kind,
        },
        responsePayload: response.raw,
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      }, {
        action: "inserting earnings_accounts raw payload",
        platform: "fansly",
      });

      const finerWindows = response.done ? null : splitTopSpendersWindow(currentWindow);
      if (finerWindows) {
        state = {
          ...state,
          pendingWindows: [
            ...finerWindows,
            ...state.pendingWindows.slice(1),
          ],
          completedMonths: computeCompletedTopSpenderMonths(
            state.totalMonths,
            [
              ...finerWindows,
              ...state.pendingWindows.slice(1),
            ],
          ),
          lastWindowStartedAt: currentWindow.startedAt,
          lastWindowEndedAt: currentWindow.endedAt,
        };
        windowsSplit += 1;
      } else {
        if (!response.done) {
          await input.telemetry.addAnomaly({
            code: "top_spenders_window_truncated",
            severity: "warn",
            message: "Top spenders window hit the provider cap at day granularity; results may be truncated",
            details: {
              windowKind: currentWindow.kind,
              monthKey: currentWindow.monthKey,
              startedAt: currentWindow.startedAt,
              endedAt: currentWindow.endedAt,
              returnedItems: response.items.length,
            },
          });
        }

        upsertedRankings += await upsertTopSpendersWindow(app, {
          platformAccountId: input.pageContext.page.id,
          windowStartedAt,
          windowEndedAt,
          telemetry: input.telemetry,
          items: response.items,
        });
        const pendingWindows = state.pendingWindows.slice(1);
        state = {
          ...state,
          pendingWindows,
          completedMonths: computeCompletedTopSpenderMonths(state.totalMonths, pendingWindows),
          lastWindowStartedAt: currentWindow.startedAt,
          lastWindowEndedAt: currentWindow.endedAt,
        };
        windowsProcessed += 1;
      }

      const progressCheckpoint = await upsertCheckpointProgress(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "top_spenders",
        state,
      });
      await input.telemetry.recordCheckpointAdvanced(
        "top_spenders",
        summarizeCheckpoint(progressCheckpoint),
      );

      if (input.budget.shouldYield()) {
        return {
          satisfied: false,
          yieldReason: input.budget.resolveYieldReason(),
          stats: {
            mode: state.mode,
            totalMonths: state.totalMonths,
            completedMonths: state.completedMonths,
            pendingWindows: state.pendingWindows.length,
            windowsProcessed,
            windowsSplit,
            upsertedRankings,
          },
        } satisfies StreamChunkResult;
      }
    }
    return null;
  };

  const resumedPendingWindows = state.pendingWindows.length > 0;
  if (resumedPendingWindows) {
    const yielded = await processPendingWindows();
    if (yielded) {
      return yielded;
    }
  }

  if (state.mode === "bootstrap") {
    state = {
      ...state,
      mode: "steady_state",
      completedMonths: state.totalMonths,
      pendingWindows: [],
    };
    const completedCheckpoint = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      cursorTimestamp: state.lastWindowEndedAt ? new Date(state.lastWindowEndedAt) : now,
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(completedCheckpoint),
    );

    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        mode: "bootstrap",
        totalMonths: state.totalMonths,
        completedMonths: state.completedMonths,
        pendingWindows: 0,
        windowsProcessed,
        windowsSplit,
        upsertedRankings,
      },
    } satisfies StreamChunkResult;
  }

  if (resumedPendingWindows) {
    const completedCheckpoint = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      cursorTimestamp: state.lastWindowEndedAt ? new Date(state.lastWindowEndedAt) : now,
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(completedCheckpoint),
    );

    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        mode: "steady_state",
        totalMonths: state.totalMonths,
        completedMonths: state.completedMonths,
        pendingWindows: 0,
        windowsProcessed,
        windowsSplit,
        upsertedRankings,
      },
    } satisfies StreamChunkResult;
  }

  const steadyStateWindowEndedAt = now;
  const steadyStateWindowStartedAt = new Date(now.getTime() - TOP_SPENDERS_STEADY_STATE_WINDOW_MS);
  const steadyStateWindow = {
    kind: "week" as const,
    monthKey: buildUtcMonthKey(steadyStateWindowStartedAt),
    startedAt: steadyStateWindowStartedAt.toISOString(),
    endedAt: steadyStateWindowEndedAt.toISOString(),
  } satisfies TopSpendersCursorWindow;
  await assertOwnedPageSyncLease(app.db);
  const response = await app.adapter.getEarningsAccountsPage(requestContext, {
    after: steadyStateWindowStartedAt,
    before: steadyStateWindowEndedAt,
  });
  await persistRawPayload(app.db, {
    platformAccountId: input.pageContext.page.id,
    syncRunId: input.syncRunId,
    endpoint: "earnings_accounts",
    requestParams: {
      after: steadyStateWindow.startedAt,
      before: steadyStateWindow.endedAt,
      windowKind: steadyStateWindow.kind,
    },
    responsePayload: response.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, {
    action: "inserting earnings_accounts raw payload",
    platform: "fansly",
  });
  if (response.done) {
    upsertedRankings = await upsertTopSpendersWindow(app, {
      platformAccountId: input.pageContext.page.id,
      windowStartedAt: steadyStateWindowStartedAt,
      windowEndedAt: steadyStateWindowEndedAt,
      telemetry: input.telemetry,
      items: response.items,
    });
    windowsProcessed += 1;
  } else {
    windowsSplit += 1;
    state = {
      ...state,
      pendingWindows: splitTopSpendersWindow(steadyStateWindow) ?? [],
      lastWindowStartedAt: steadyStateWindow.startedAt,
      lastWindowEndedAt: steadyStateWindow.endedAt,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(progressCheckpoint),
    );

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          mode: "steady_state",
          totalMonths: state.totalMonths,
          completedMonths: state.completedMonths,
          pendingWindows: state.pendingWindows.length,
          windowsProcessed,
          windowsSplit,
          upsertedRankings,
        },
      } satisfies StreamChunkResult;
    }

    const yielded = await processPendingWindows();
    if (yielded) {
      return yielded;
    }
  }

  const steadyState = {
    ...state,
    mode: "steady_state" as const,
    completedMonths: state.totalMonths,
    pendingWindows: [],
    lastWindowStartedAt: steadyStateWindowStartedAt.toISOString(),
    lastWindowEndedAt: steadyStateWindowEndedAt.toISOString(),
  } satisfies TopSpendersCursorState;
  const completedCheckpoint = await upsertCheckpoint(app.db, {
    platformAccountId: input.pageContext.page.id,
    stream: "top_spenders",
    cursorTimestamp: steadyStateWindowEndedAt,
    state: steadyState,
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced(
    "top_spenders",
    summarizeCheckpoint(completedCheckpoint),
  );

  return {
    satisfied: true,
    yieldReason: null,
    stats: {
      mode: "steady_state",
      totalMonths: steadyState.totalMonths,
      completedMonths: steadyState.completedMonths,
      pendingWindows: 0,
      windowsProcessed,
      windowsSplit,
      upsertedRankings,
    },
  } satisfies StreamChunkResult;
}

/**
 * top_spenders for OnlyFans pages (docs/ofapi-parity-plan.md Phase 5, D10):
 * the same month-window bootstrap + trailing-7-day steady state as Fansly, but
 * computed from the existing transactions table (zero external requests) using
 * the spenders-v2 transaction filter, so rankings reconcile with the spender
 * projections for the same window. Windows are never split — a DB aggregate
 * has no provider cap. OFAPI lifetime totals are deliberately not used (no
 * monthly windows).
 */
async function executeOnlyFansTopSpendersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    syncRunId: number;
  },
) {
  await input.telemetry.recordPhaseStarted("top_spenders");
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "top_spenders");
  await input.telemetry.recordCheckpointLoaded("top_spenders", summarizeCheckpoint(checkpoint));

  const now = new Date();
  // The account-created-at analog: the earliest spender-relevant transaction.
  const earliestTransactionAt = await getEarliestSpenderTransactionAt(
    app.db,
    input.pageContext.page.id,
  );
  if (!earliestTransactionAt) {
    return {
      satisfied: true,
      yieldReason: null,
      stats: { mode: "empty", reason: "no spender transactions" },
    } satisfies StreamChunkResult;
  }

  const anchorIso = earliestTransactionAt.toISOString();
  let initialState = parseTopSpendersCursorState(checkpoint?.state);
  if (!initialState || initialState.accountCreatedAt !== anchorIso) {
    initialState = buildTopSpendersBootstrapState(earliestTransactionAt, now);
    const initializedCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      state: initialState,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(initializedCheckpoint),
    );
  }
  let state: TopSpendersCursorState = initialState;

  let windowsProcessed = 0;
  let upsertedRankings = 0;

  const processWindow = async (windowStartedAt: Date, windowEndedAt: Date) => {
    const rows = await aggregateTransactionTopSpenders(app.db, {
      platformAccountId: input.pageContext.page.id,
      from: windowStartedAt,
      to: windowEndedAt,
    });
    return upsertTopSpendersWindow(app, {
      platformAccountId: input.pageContext.page.id,
      platform: "onlyfans",
      windowStartedAt,
      windowEndedAt,
      telemetry: input.telemetry,
      items: rows.map((row) => ({
        totalGross: Number(row.grossAmountMills),
        totalNet: Number(row.creatorNetAmountMills),
        correlationAccountId: row.fanPlatformUserId,
      })),
    });
  };

  while (state.pendingWindows.length > 0) {
    await assertOwnedPageSyncLease(app.db);
    const currentWindow = state.pendingWindows[0]!;
    upsertedRankings += await processWindow(
      new Date(currentWindow.startedAt),
      new Date(currentWindow.endedAt),
    );
    windowsProcessed += 1;

    const pendingWindows = state.pendingWindows.slice(1);
    state = {
      ...state,
      pendingWindows,
      completedMonths: computeCompletedTopSpenderMonths(state.totalMonths, pendingWindows),
      lastWindowStartedAt: currentWindow.startedAt,
      lastWindowEndedAt: currentWindow.endedAt,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "top_spenders",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "top_spenders",
      summarizeCheckpoint(progressCheckpoint),
    );

    if (!input.budget.hasWallClockCapacity()) {
      return {
        satisfied: false,
        yieldReason: "wall_clock",
        stats: {
          mode: state.mode,
          totalMonths: state.totalMonths,
          completedMonths: state.completedMonths,
          pendingWindows: state.pendingWindows.length,
          windowsProcessed,
          upsertedRankings,
        },
      } satisfies StreamChunkResult;
    }
  }

  const wasBootstrap = state.mode === "bootstrap";
  if (!wasBootstrap) {
    // Steady state: refresh the trailing seven days, mirroring Fansly's window.
    const steadyStateWindowEndedAt = now;
    const steadyStateWindowStartedAt = new Date(
      now.getTime() - TOP_SPENDERS_STEADY_STATE_WINDOW_MS,
    );
    await assertOwnedPageSyncLease(app.db);
    upsertedRankings += await processWindow(steadyStateWindowStartedAt, steadyStateWindowEndedAt);
    windowsProcessed += 1;
    state = {
      ...state,
      lastWindowStartedAt: steadyStateWindowStartedAt.toISOString(),
      lastWindowEndedAt: steadyStateWindowEndedAt.toISOString(),
    };
  }

  const completedState = {
    ...state,
    mode: "steady_state" as const,
    completedMonths: state.totalMonths,
    pendingWindows: [],
  } satisfies TopSpendersCursorState;
  const completedCheckpoint = await upsertCheckpoint(app.db, {
    platformAccountId: input.pageContext.page.id,
    stream: "top_spenders",
    cursorTimestamp: completedState.lastWindowEndedAt
      ? new Date(completedState.lastWindowEndedAt)
      : now,
    state: completedState,
    lastSuccessfulRunId: input.syncRunId,
  });
  await input.telemetry.recordCheckpointAdvanced(
    "top_spenders",
    summarizeCheckpoint(completedCheckpoint),
  );

  return {
    satisfied: true,
    yieldReason: null,
    stats: {
      mode: wasBootstrap ? "bootstrap" : "steady_state",
      totalMonths: completedState.totalMonths,
      completedMonths: completedState.completedMonths,
      pendingWindows: 0,
      windowsProcessed,
      upsertedRankings,
    },
  } satisfies StreamChunkResult;
}

export async function executeFanIdentitiesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("Fan identity sync is only supported for OnlyFans pages");
  }

  await input.telemetry.recordPhaseStarted("fan_identities");

  // Stage 14: OFAPI-mapped pages route to the tracking/trial-link family via
  // OFAPI (flag-gated) — the stream keeps its name, the vendor changes.
  if (isOfapiFanIdentitiesEligiblePage(app.config, {
    platform: input.pageContext.platform,
    ofapiAccountId: input.pageContext.page.ofapiAccountId,
  })) {
    const ofapiResult = await syncOfapiFanIdentities(app, {
      pageContext: input.pageContext,
      budget: input.budget,
      telemetry: input.telemetry,
    });
    return {
      satisfied: ofapiResult.satisfied,
      yieldReason: ofapiResult.yieldReason,
      continuationRetryAt: ofapiResult.continuationRetryAt ?? null,
      stats: { vendor: "ofapi", ...ofapiResult.stats },
    } satisfies StreamChunkResult;
  }

  // OnlyMonster identity walker retired (Stage 18): unmapped pages have no
  // identity vendor — map the page to OFAPI (setPageOfapiAccountId) instead.
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_identities_requires_ofapi_mapping" },
  } satisfies StreamChunkResult;
}

export async function fanslyTransactionsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("fanslyTransactionsChunk received a non-fansly page");
  }
  await input.telemetry.recordPhaseStarted("transactions");

  // Resolve the live transaction windowing config ONCE per chunk and thread both
  // scalars into the sync entry points, so every read-site in this chunk
  // (transactions.ts) sees one consistent window.
  const effective = await loadEffectiveConfig(app.db, app.config);
  const transactionLookbackDays = effective.transactionLookbackDays;
  const transactionRescanCapDays = effective.transactionRescanCapDays;

  {
    const result = await syncTransactions(app, {
      pageLabel: input.pageContext.page.label,
      platformAccountId: input.pageContext.page.id,
      commissionRate: input.pageContext.page.commissionRate,
      transactionLookbackDays,
      transactionRescanCapDays,
      requestContext: {
        session: input.pageContext.session,
        proxy: input.pageContext.proxy,
        egressKey: input.pageContext.egressKey,
        requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
        rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
      },
      syncRunId: input.syncRunId,
      telemetry: input.telemetry,
      budget: input.budget,
      activeLease: input.streamState.leaseToken
        ? {
          requestSeq: input.streamState.leasedSeq ?? input.streamState.requestSeq,
          leaseToken: input.streamState.leaseToken,
        }
        : undefined,
    });

    return {
      satisfied: result.satisfied,
      yieldReason: result.yieldReason,
      stats: result as Record<string, unknown>,
    } satisfies StreamChunkResult;
  }
}

export async function onlyfansTransactionsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("onlyfansTransactionsChunk received a non-onlyfans page");
  }
  // OnlyMonster transactions walker retired (Stage 18): OnlyFans transaction
  // truth is the OFAPI webhook lane through the Stage 13 writer gate, with
  // the Stage 14 budget-guarded backfill CLI for history — a pull stream
  // would be a second writer.
  await input.telemetry.recordPhaseStarted("transactions");
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_transactions_webhook_sourced" },
  } satisfies StreamChunkResult;
}

export async function onlyfansSubscribersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (isOfapiAudienceSyncEligiblePage(app.config, input.pageContext.page)) {
    return executeOfapiAudienceChunk(app, input);
  }
  // The planner force-pauses the stream for non-eligible pages, but a manual
  // block resume can race one run in before the next planner cycle re-pauses
  // it — skip gracefully instead of recording a failure (DM-polling pattern).
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_audience_not_eligible" },
  } satisfies StreamChunkResult;
}

export async function fanslySubscribersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Subscriber sync is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("subscribers");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "subscribers");
  await input.telemetry.recordCheckpointLoaded("subscribers", summarizeCheckpoint(checkpoint));

  const existingState = parseSubscribersCursorState(checkpoint?.state, input.streamState.requestSeq);
  const previousGeneration = asNumber(asRecord(checkpoint?.state)?.generation) ?? 0;
  let state = existingState ?? {
    revision: input.streamState.requestSeq,
    generation: previousGeneration + 1,
    offset: 0,
    observedCount: 0,
    pageCount: 0,
    providerReportedTotal: null,
  } satisfies SubscribersCursorState;

  if (!existingState) {
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
  }

  let processedThisChunk = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getSubscribersPage(
      requestContext,
      { limit: 100, offset: state.offset, status: "3,4" },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "subscribers",
      requestParams: { offset: state.offset, limit: 100, status: "3,4" },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting subscribers raw payload",
      platform: "fansly",
    });

    if (state.offset === 0 && page.items.length === 0) {
      const currentSubscribers = await getCurrentSubscribers(app.db, input.pageContext.page.id);
      if (currentSubscribers.rows.length > 0) {
        await input.telemetry.addAnomaly({
          code: "subscribers_empty_first_page_guard",
          severity: "warn",
          message: "Subscriber sync returned zero rows on the first page while current subscriptions already exist",
          details: {
            existingCurrentSubscribers: currentSubscribers.rows.length,
          },
        });
        throw new Error("Subscriber sync returned zero rows; refusing destructive finalization");
      }
    }

    const hydratedFans = await lookupHydratedFans(app, {
      requestContext,
      platformUserIds: page.items.map((item) => item.subscriberId),
      telemetry: input.telemetry,
      capture: { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
    });
    const nextState = page.done
      ? state
      : {
        ...state,
        offset: state.offset + 100,
        observedCount: state.observedCount + page.items.length,
      };
    const finalObservedCount = state.observedCount + page.items.length;
    if (page.done && state.providerReportedTotal !== null && finalObservedCount !== state.providerReportedTotal) {
      await input.telemetry.addAnomaly({
        code: "subscribers_partial_page_guard",
        severity: "warn",
        message: "Subscriber sync returned fewer rows than the provider-reported total; refusing destructive finalization",
        details: {
          providerReportedTotal: state.providerReportedTotal,
          observedCount: finalObservedCount,
          pageCount: state.pageCount,
        },
      });
      throw new Error("Subscriber sync returned a partial result; refusing destructive finalization");
    }

    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: hydratedFans.accounts,
        fallbackIds: hydratedFans.fallbackIds,
      });

      const subscriptionInputs: UpsertPageSubscriptionInput[] = [];
      const fanPageInputs: UpsertFanPageInput[] = [];
      for (const item of page.items) {
        const fanId = fanMap.get(item.subscriberId);
        if (!fanId) {
          continue;
        }

        const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
        const endsAt = item.endsAt ? new Date(item.endsAt) : null;
        const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;
        const canonicalStatus = mapFanslySubscriptionStatus(item.status);
        subscriptionInputs.push({
          platformSubscriptionId: item.id,
          platformAccountId: input.pageContext.page.id,
          fanId,
          platformHistoryId: item.historyId,
          subscriptionTierId: item.subscriptionTierId,
          subscriptionTierName: item.subscriptionTierName,
          subscriptionTierColor: item.subscriptionTierColor,
          planId: item.planId,
          rawStatus: item.status,
          canonicalStatus,
          priceMills: millsFromInteger(item.price),
          renewPriceMills: millsFromInteger(item.renewPrice),
          autoRenew,
          billingCycleDays: item.billingCycle,
          durationDays: item.duration,
          renewDate: item.renewDate ? new Date(item.renewDate) : null,
          sourceCreatedAt,
          sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
          endsAt,
          lastSeenGeneration: state.generation,
        });
        fanPageInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          isSubscriber: true,
          subscriberSince: sourceCreatedAt,
          subscriptionExpiresAt: endsAt,
          autoRenew,
        });
      }

      if (page.done) {
        await upsertPageSubscriptions(dbTx, subscriptionInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await deactivatePageSubscriptionsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        await refreshFanPageSubscriberState(dbTx, input.pageContext.page.id);
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        return {
          kind: "complete" as const,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "subscribers",
            state: {
              ...state,
              observedCount: finalObservedCount,
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: subscriptionInputs.length,
        };
      }

      await upsertPageSubscriptions(dbTx, subscriptionInputs);
      await upsertFanPages(dbTx, fanPageInputs);
      return {
        kind: "progress" as const,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: nextState,
        }),
        processedThisPage: subscriptionInputs.length,
      };
    });
    processedThisChunk += pageWrite.processedThisPage;

    if (pageWrite.kind === "complete") {
      await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(pageWrite.checkpoint));
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          pageCount: state.pageCount,
          processedThisChunk,
          providerReportedTotal: state.providerReportedTotal,
        },
      } satisfies StreamChunkResult;
    }

    state = nextState;
    await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(pageWrite.checkpoint));

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
    },
  } satisfies StreamChunkResult;
}

export async function executeFollowersChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Follower sync is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("followers");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "followers");
  await input.telemetry.recordCheckpointLoaded("followers", summarizeCheckpoint(checkpoint));
  const existingState = parseFollowersCursorState(checkpoint?.state, input.streamState.requestSeq);

  let state: FollowersCursorState;
  if (existingState) {
    state = existingState;
  } else {
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    state = {
      revision: input.streamState.requestSeq,
      knownFollowId: checkpoint?.cursorText ?? null,
      newestFollowId: null,
      offset: 0,
      pageCount: 0,
      sourceFollowerCount: accountMe.parsed.account.followCount,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers",
      state,
    });
  }

  let processedThisChunk = 0;
  let sawKnownCheckpoint = false;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getFollowersPage(
      requestContext,
      resolveFanslyPlatformAccountId(input.pageContext.page),
      {
        offset: state.offset,
        limit: 100,
        minDelayMs: app.config.followerPageDelayMs,
      },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      newestFollowId: state.newestFollowId ?? page.items[0]?.id ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: { offset: state.offset, limit: 100, mode: "incremental" },
      responsePayload: trimFanslyFollowerPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
      platform: "fansly",
    });

    let reachedBoundary = false;
    const newestFollowId = state.newestFollowId ?? state.knownFollowId;
    const nextState = page.done
      ? state
      : {
        ...state,
        offset: state.offset + 100,
      };
    const hydratedFollowers = await hydrateFanslyFollowerRows(app, {
      requestContext,
      followers: page.items,
      accounts: page.accounts,
      telemetry: input.telemetry,
      stream: "followers",
      offset: state.offset,
      capture: { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
    });
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: hydratedFollowers.accounts,
        fallbackIds: hydratedFollowers.fallbackIds,
      });
      const unmappedFollowerIds = findUnmappedFollowerIds(
        hydratedFollowers.sourceFollowerIds,
        fanMap,
      );
      if (unmappedFollowerIds.length > 0) {
        return {
          kind: "blocked" as const,
          unmappedFollowerIds,
        };
      }

      const presenceSignals = buildFanslyFollowerPresenceSignals({
        followers: page.items,
        accounts: hydratedFollowers.accounts,
      });

      const followInputs: UpsertPageFollowInput[] = [];
      const fanPageInputs: UpsertFanPageInput[] = [];
      const fanPagePresenceInputs = [];
      let pageSawKnownCheckpoint = false;
      let pageReachedBoundary = false;

      for (const follower of page.items) {
        if (state.knownFollowId && follower.id === state.knownFollowId) {
          pageSawKnownCheckpoint = true;
          pageReachedBoundary = true;
          break;
        }

        const fanId = fanMap.get(follower.followerId);
        if (!fanId) {
          continue;
        }

        const followedAt = fanslyFollowIdToDate(follower.id);
        followInputs.push({
          platformAccountId: input.pageContext.page.id,
          fanId,
          platformFollowId: follower.id,
          followedAt,
        });
        fanPageInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          isFollower: true,
          followerSince: followedAt,
        });
      }

      for (const signal of presenceSignals) {
        const fanId = fanMap.get(signal.platformUserId);
        if (!fanId) {
          continue;
        }

        fanPagePresenceInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          externalPresenceAt: signal.lastSeenAt,
          externalPresenceObservedAt: signal.observedAt,
          externalPresenceSource: signal.source,
        });
      }

      if (pageReachedBoundary || page.done) {
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await upsertFanPageExternalPresences(dbTx, fanPagePresenceInputs);
        await rebuildFollowerRollups(dbTx, input.pageContext.page.id, state.sourceFollowerCount);
        await updatePageSyncTimestampCache(dbTx, {
          pageId: input.pageContext.page.id,
          syncType: "followers",
        });
        return {
          kind: "complete" as const,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "followers",
            cursorText: newestFollowId,
            state,
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: followInputs.length,
          sawKnownCheckpoint: pageSawKnownCheckpoint,
          reachedBoundary: pageReachedBoundary,
        };
      }

      await upsertPageFollows(dbTx, followInputs);
      await upsertFanPages(dbTx, fanPageInputs);
      await upsertFanPageExternalPresences(dbTx, fanPagePresenceInputs);
      return {
        kind: "progress" as const,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers",
          state: nextState,
        }),
        processedThisPage: followInputs.length,
        sawKnownCheckpoint: pageSawKnownCheckpoint,
        reachedBoundary: pageReachedBoundary,
      };
    });
    if (pageWrite.kind === "blocked") {
      await recordFollowerMappingBlockedAnomaly(input.telemetry, {
        stream: "followers",
        offset: state.offset,
        unmappedFollowerIds: pageWrite.unmappedFollowerIds,
      });
      throw new Error("Follower sync left source follower rows unmapped; refusing checkpoint advancement");
    }

    processedThisChunk += pageWrite.processedThisPage;
    sawKnownCheckpoint ||= pageWrite.sawKnownCheckpoint;

    if (pageWrite.kind === "complete") {
      await input.telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(pageWrite.checkpoint));

      const activeFollowerCount = await countActivePageFollows(app.db, input.pageContext.page.id);
      if (
        activeFollowerCount !== state.sourceFollowerCount ||
        (!!state.knownFollowId && page.done && !sawKnownCheckpoint) ||
        (!!state.knownFollowId && newestFollowId === state.knownFollowId && processedThisChunk > 0)
      ) {
        await triggerFollowersReconcileAnomaly(app, input.pageContext.page.id);
      }

      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          pageCount: state.pageCount,
          processedThisChunk,
          sourceFollowerCount: state.sourceFollowerCount,
          sawKnownCheckpoint,
        },
      } satisfies StreamChunkResult;
    }

    state = nextState;
    await input.telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(pageWrite.checkpoint));

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
          newestFollowId: state.newestFollowId,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
      newestFollowId: state.newestFollowId,
    },
  } satisfies StreamChunkResult;
}

export async function executeFollowersReconcileChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("Follower reconcile is only supported for Fansly pages");
  }

  await input.telemetry.recordPhaseStarted("followers_reconcile");
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "followers_reconcile");
  await input.telemetry.recordCheckpointLoaded("followers_reconcile", summarizeCheckpoint(checkpoint));

  const existingState = parseFollowersReconcileCursorState(
    checkpoint?.state,
    input.streamState.requestSeq,
  );
  const previousGeneration = asNumber(asRecord(checkpoint?.state)?.generation) ?? 0;
  let state: FollowersReconcileCursorState;
  if (existingState) {
    state = existingState;
  } else {
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    state = {
      revision: input.streamState.requestSeq,
    generation: previousGeneration + 1,
    offset: 0,
    observedCount: 0,
    pageCount: 0,
    sourceFollowerCount: accountMe.parsed.account.followCount,
  };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers_reconcile",
      state,
    });
  }

  let processedThisChunk = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getFollowersPage(
      requestContext,
      resolveFanslyPlatformAccountId(input.pageContext.page),
      {
        offset: state.offset,
        limit: 100,
        minDelayMs: app.config.followerPageDelayMs,
      },
    );
    state = {
      ...state,
      pageCount: state.pageCount + 1,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: { offset: state.offset, limit: 100, mode: "reconcile" },
      responsePayload: trimFanslyFollowerPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
      platform: "fansly",
    });

    if (state.offset === 0 && page.items.length === 0 && state.sourceFollowerCount > 0) {
      const existingActiveFollowers = asNumber(
        await countActivePageFollows(app.db, input.pageContext.page.id),
      ) ?? 0;
      if (existingActiveFollowers > 0) {
        await input.telemetry.addAnomaly({
          code: "followers_reconcile_empty_first_page_guard",
          severity: "warn",
          message: "Follower reconcile returned zero rows on the first page while active followers already exist",
          details: {
            sourceFollowerCount: state.sourceFollowerCount,
            existingActiveFollowers,
          },
        });
        throw new Error("Follower reconcile returned zero rows; refusing destructive finalization");
      }
    }

    const nextState = page.done
      ? state
      : {
        ...state,
        offset: state.offset + 100,
        observedCount: state.observedCount + page.items.length,
      };
    const finalObservedCount = state.observedCount + page.items.length;
    if (page.done && finalObservedCount !== state.sourceFollowerCount) {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_partial_page_guard",
        severity: "warn",
        message: "Follower reconcile returned fewer rows than the source follower count; refusing destructive finalization",
        details: {
          sourceFollowerCount: state.sourceFollowerCount,
          observedCount: finalObservedCount,
          pageCount: state.pageCount,
        },
      });
      throw new Error("Follower reconcile returned a partial result; refusing destructive finalization");
    }

    const hydratedFollowers = await hydrateFanslyFollowerRows(app, {
      requestContext,
      followers: page.items,
      accounts: page.accounts,
      telemetry: input.telemetry,
      stream: "followers_reconcile",
      offset: state.offset,
      capture: { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
    });
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: hydratedFollowers.accounts,
        fallbackIds: hydratedFollowers.fallbackIds,
      });
      const unmappedFollowerIds = findUnmappedFollowerIds(
        hydratedFollowers.sourceFollowerIds,
        fanMap,
      );
      if (unmappedFollowerIds.length > 0) {
        return {
          kind: "blocked" as const,
          unmappedFollowerIds,
        };
      }

      const presenceSignals = buildFanslyFollowerPresenceSignals({
        followers: page.items,
        accounts: hydratedFollowers.accounts,
      });

      const followInputs: UpsertPageFollowInput[] = [];
      const fanPageInputs: UpsertFanPageInput[] = [];
      const fanPagePresenceInputs = [];
      for (const follower of page.items) {
        const fanId = fanMap.get(follower.followerId);
        if (!fanId) {
          continue;
        }

        const followedAt = fanslyFollowIdToDate(follower.id);
        followInputs.push({
          platformAccountId: input.pageContext.page.id,
          fanId,
          platformFollowId: follower.id,
          followedAt,
          lastSeenGeneration: state.generation,
        });
        fanPageInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          isFollower: true,
          followerSince: followedAt,
        });
      }

      for (const signal of presenceSignals) {
        const fanId = fanMap.get(signal.platformUserId);
        if (!fanId) {
          continue;
        }

        fanPagePresenceInputs.push({
          fanId,
          platformAccountId: input.pageContext.page.id,
          externalPresenceAt: signal.lastSeenAt,
          externalPresenceObservedAt: signal.observedAt,
          externalPresenceSource: signal.source,
        });
      }

      if (page.done) {
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
        await upsertFanPageExternalPresences(dbTx, fanPagePresenceInputs);
        await deactivatePageFollowsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        await refreshFanPageFollowerState(dbTx, input.pageContext.page.id);
        await rebuildFollowerRollups(dbTx, input.pageContext.page.id, state.sourceFollowerCount);
        await updatePageSyncTimestampCache(dbTx, {
          pageId: input.pageContext.page.id,
          syncType: "followers",
        });
        return {
          kind: "complete" as const,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "followers_reconcile",
            state: {
              ...state,
              observedCount: finalObservedCount,
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: followInputs.length,
        };
      }

      await upsertPageFollows(dbTx, followInputs);
      await upsertFanPages(dbTx, fanPageInputs);
      await upsertFanPageExternalPresences(dbTx, fanPagePresenceInputs);
      return {
        kind: "progress" as const,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers_reconcile",
          state: nextState,
        }),
        processedThisPage: followInputs.length,
      };
    });
    if (pageWrite.kind === "blocked") {
      await recordFollowerMappingBlockedAnomaly(input.telemetry, {
        stream: "followers_reconcile",
        offset: state.offset,
        unmappedFollowerIds: pageWrite.unmappedFollowerIds,
      });
      throw new Error("Follower reconcile left source follower rows unmapped; refusing destructive finalization");
    }

    processedThisChunk += pageWrite.processedThisPage;

    if (pageWrite.kind === "complete") {
      await input.telemetry.recordCheckpointAdvanced(
        "followers_reconcile",
        summarizeCheckpoint(pageWrite.checkpoint),
      );
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          pageCount: state.pageCount,
          processedThisChunk,
          sourceFollowerCount: state.sourceFollowerCount,
        },
      } satisfies StreamChunkResult;
    }

    state = nextState;
    await input.telemetry.recordCheckpointAdvanced(
      "followers_reconcile",
      summarizeCheckpoint(pageWrite.checkpoint),
    );

    if (input.budget.shouldYield()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedThisChunk,
    },
  } satisfies StreamChunkResult;
}

export async function onlyfansDmConversationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  // OFAPI-mapped pages sync DMs via OFAPI REST (decision #49). The parked
  // OnlyMonster polling path was deleted in Stage 18 — unmapped pages skip
  // gracefully (mapping a page is the fix, not resurrecting the vendor).
  if (isOfapiDmSyncEligiblePage(app.config, input.pageContext.page)) {
    return executeOfapiDmConversationsChunk(app, input);
  }
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_dm_requires_ofapi_mapping" },
  } satisfies StreamChunkResult;
}

export async function fanslyDmConversationsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("DM conversation sync is only supported for Fansly pages");
  }

  assertDmSharedRateLimitEnabled(app);
  await input.telemetry.recordPhaseStarted("dm_conversations");

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_conversations");
  await input.telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(checkpoint));

  const pageAccountId = resolveFanslyPlatformAccountId(input.pageContext.page);
  const checkpointStateRecord = asRecord(checkpoint?.state);
  const existingState = parseDmConversationCursorState(checkpoint?.state);
  let state = existingState ?? {
    version: 1 as const,
    mode: "full_scan" as const,
    generation: (asNumber(checkpointStateRecord?.generation) ?? 0) + 1,
    offset: 0,
    pageCount: 0,
    providerReportedTotal: null,
    unchangedPageStreak: 0,
    fullSweepStartedAt: new Date().toISOString(),
    lastFullSweepCompletedAt: asNullableString(checkpointStateRecord?.lastFullSweepCompletedAt),
  };

  if (!existingState) {
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_conversations",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  let processedConversations = 0;
  let repairedHeads = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getMessagingGroupsPage(requestContext, {
      limit: 100,
      offset: state.offset,
      sortOrder: 1,
      flags: 0,
    });
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      providerReportedTotal: state.providerReportedTotal ?? page.total ?? null,
    };

    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "dm_conversations",
      requestParams: { offset: state.offset, limit: 100, sortOrder: 1, flags: 0 },
      responsePayload: trimFanslyMessagingGroupsPayload(page.raw),
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "dm_metadata",
      retainUntil: dmRetentionDate(),
    }, {
      action: "inserting dm conversations raw payload",
      platform: "fansly",
    });

    const accountsById = new Map(page.accounts.map((account) => [account.id, account]));
    const groupsById = new Map(page.groups.map((group) => [group.id, group]));
    const existingConversations = await listPageDmConversationsByPlatformConversationIds(app.db, {
      platformAccountId: input.pageContext.page.id,
      platformConversationIds: page.items.map((conversation) => conversation.groupId),
    });
    const existingByGroupId = new Map(
      existingConversations.map((conversation) => [
        conversation.platformConversationId,
        conversation,
      ]),
    );
    let unchangedPage = true;
    const hydratedAccountsById = new Map<string, FanslyAccount>();
    const fallbackPartnerIds = new Set<string>();
    const conversationWrites: Array<{
      existingFanId: number | null;
      partnerPlatformUserId: string | null;
      partnerUsername: string | null;
      partnerDisplayName: string | null;
      conversationFlags: number;
      unreadCount: number;
      subscriptionTierId: string | null;
      lastMessageId: string | null;
      lastUnreadMessageId: string | null;
      lastMessageAt: Date | null;
      lastMessageSenderId: string | null;
      lastMessageSenderRole: DmSenderRole;
      lastMessagePreview: string | null;
      lastFanMessageAt: Date | null;
      lastModelMessageAt: Date | null;
      storedMessageCount: number;
      newestStoredMessageId: string | null;
      oldestStoredMessageId: string | null;
      messageCoverageStatus: MessageCoverageStatus;
      messageBackfillComplete: boolean;
      lastMessageSyncAt: Date | null;
      isVisible: boolean;
      lastSeenGeneration: number;
      metadata: Record<string, unknown>;
      platformConversationId: string;
    }> = [];

    for (const conversation of page.items) {
      const existing = existingByGroupId.get(conversation.groupId) ?? null;
      const group = groupsById.get(conversation.groupId);
      const aggregatedPartnerIds = Array.from(new Set(
        (group?.users ?? [])
          .map((user) => user.userId)
          .filter((userId) => userId !== pageAccountId),
      ));

      let partnerPlatformUserId = conversation.partnerAccountId ?? null;
      const contradictoryPartner =
        (aggregatedPartnerIds.length === 1 &&
          partnerPlatformUserId !== null &&
          aggregatedPartnerIds[0] !== partnerPlatformUserId) ||
        aggregatedPartnerIds.length > 1;

      if (!partnerPlatformUserId && aggregatedPartnerIds.length === 1) {
        partnerPlatformUserId = aggregatedPartnerIds[0]!;
      }

      const partnerMissingFromAggregationAccounts = Boolean(
        partnerPlatformUserId &&
        page.accounts.length > 0 &&
        !accountsById.has(partnerPlatformUserId),
      );

      let detail: Awaited<ReturnType<AppContext["adapter"]["getGroupDetail"]>> | null = null;
      if ((!partnerPlatformUserId || contradictoryPartner) &&
        !partnerMissingFromAggregationAccounts &&
        input.budget.hasRequestCapacity() &&
        input.budget.hasWallClockCapacity()) {
        detail = await app.adapter.getGroupDetail(requestContext, conversation.groupId);
        await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "group_detail",
          requestParams: { groupId: conversation.groupId },
          responsePayload: detail.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_metadata",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting group_detail raw payload",
          platform: "fansly",
        });
        const detailPartnerIds = Array.from(new Set(
          (detail.parsed.users ?? [])
            .map((user) => user.userId)
            .filter((userId) => userId !== pageAccountId),
        ));
        partnerPlatformUserId = detailPartnerIds.length === 1
          ? detailPartnerIds[0]!
          : null;
      }

      const partnerSnapshot = partnerPlatformUserId
        ? accountsById.get(partnerPlatformUserId) ?? null
        : null;
      const partnerUsername = partnerSnapshot?.username ??
        conversation.partnerUsername ??
        existing?.partnerUsername ??
        null;
      const partnerDisplayName = partnerSnapshot?.displayName ??
        existing?.partnerDisplayName ??
        null;

      if (partnerPlatformUserId && !partnerMissingFromAggregationAccounts) {
        if (partnerSnapshot) {
          hydratedAccountsById.set(partnerPlatformUserId, {
            id: partnerPlatformUserId,
            username: partnerUsername,
            displayName: partnerDisplayName,
            createdAt: partnerSnapshot.createdAt,
            notes: partnerSnapshot.notes,
          });
        } else {
          fallbackPartnerIds.add(partnerPlatformUserId);
        }
      }

      let headMessage = group?.lastMessage ?? detail?.parsed.lastMessage ?? null;
      let lastMessageAt = headMessage
        ? await normalizeDmTimestampWithAnomaly(input.telemetry, {
          context: "dm_conversations:lastMessage",
          value: headMessage.createdAt,
        })
        : null;
      let lastMessageSenderId = headMessage?.senderId ?? null;
      let lastMessageSenderRole = resolveDmSenderRole(
        lastMessageSenderId,
        pageAccountId,
        partnerPlatformUserId,
      );
      let lastMessagePreview = truncateDmPreview(headMessage?.content);

      const needsHeadRepair = !partnerMissingFromAggregationAccounts &&
        (!lastMessageAt || !lastMessageSenderId) &&
        (!existing || existing.lastMessageId !== (conversation.lastMessageId ?? null)) &&
        input.budget.hasRequestCapacity() &&
        input.budget.hasWallClockCapacity();

      if (needsHeadRepair) {
        const headRepair = await app.adapter.getMessagesPage(requestContext, {
          groupId: conversation.groupId,
          limit: 1,
        });
        await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "dm_messages",
          requestParams: { groupId: conversation.groupId, limit: 1, headRepair: true },
          responsePayload: headRepair.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_messages",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting dm_messages head-repair raw payload",
          platform: "fansly",
        });
        const repairedHead = headRepair.items[0] ?? null;
        if (repairedHead) {
          repairedHeads += 1;
          headMessage = repairedHead;
          lastMessageAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
            context: "dm_conversations:headRepair",
            value: repairedHead.createdAt,
          });
          lastMessageSenderId = repairedHead.senderId ?? null;
          lastMessageSenderRole = resolveDmSenderRole(
            lastMessageSenderId,
            pageAccountId,
            partnerPlatformUserId,
          );
          lastMessagePreview = truncateDmPreview(repairedHead.content);
        }
      }

      const preservedLastFanMessageAt = lastMessageAt && lastMessageSenderRole === "fan"
        ? lastMessageAt
        : existing?.lastFanMessageAt ?? null;
      const preservedLastModelMessageAt = lastMessageAt && lastMessageSenderRole === "model"
        ? lastMessageAt
        : existing?.lastModelMessageAt ?? null;
      const existingExcludedReason = getFanslyDmMessageSyncExcludedReason(existing?.metadata);
      let messageSyncExcludedReason: FanslyDmMessageSyncExcludedReason | null =
        partnerMissingFromAggregationAccounts
        ? FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS
        : null;

      if (
        existingExcludedReason ===
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP
      ) {
        let shouldClearUnresolvableExclusion = false;

        if (
          partnerPlatformUserId &&
          input.budget.hasRequestCapacity() &&
          input.budget.hasWallClockCapacity()
        ) {
          const resolution = await probeFanslyAccountResolution(
            app,
            requestContext,
            partnerPlatformUserId,
            { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
          );
          shouldClearUnresolvableExclusion = resolution === "resolved";
        }

        messageSyncExcludedReason = shouldClearUnresolvableExclusion
          ? null
          : FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP;
      }

      const metadata = buildFanslyDmConversationMetadata({
        unresolvedIdentity: !partnerPlatformUserId,
        messageSyncExcludedReason,
      });
      const incomingLastMessageId = conversation.lastMessageId ?? null;
      const preserveHeadForRetry = incomingLastMessageId !== null &&
        (!lastMessageAt || !lastMessageSenderId) &&
        (!existing || existing.lastMessageId !== incomingLastMessageId);

      if (
        !existing ||
        existing.lastMessageId !== incomingLastMessageId ||
        existing.unreadCount !== conversation.unreadCount ||
        !existing.isVisible ||
        hasUnresolvedIdentityMetadata(existing?.metadata) !== hasUnresolvedIdentityMetadata(metadata) ||
        getFanslyDmMessageSyncExcludedReason(existing?.metadata) !==
          getFanslyDmMessageSyncExcludedReason(metadata)
      ) {
        unchangedPage = false;
      }

      conversationWrites.push({
        existingFanId: partnerMissingFromAggregationAccounts
          ? (existing?.fanId ?? null)
          : null,
        platformConversationId: conversation.groupId,
        partnerPlatformUserId,
        partnerUsername,
        partnerDisplayName,
        conversationFlags: conversation.flags,
        unreadCount: conversation.unreadCount,
        subscriptionTierId: conversation.subscriptionTierId ?? null,
        lastMessageId: preserveHeadForRetry ? existing?.lastMessageId ?? null : incomingLastMessageId,
        lastUnreadMessageId: conversation.lastUnreadMessageId ?? null,
        lastMessageAt: lastMessageAt ?? existing?.lastMessageAt ?? null,
        lastMessageSenderId: lastMessageSenderId ?? existing?.lastMessageSenderId ?? null,
        lastMessageSenderRole: lastMessageAt && lastMessageSenderId
          ? lastMessageSenderRole
          : existing?.lastMessageSenderRole ?? "unknown",
        lastMessagePreview: lastMessagePreview ?? existing?.lastMessagePreview ?? null,
        lastFanMessageAt: preservedLastFanMessageAt,
        lastModelMessageAt: preservedLastModelMessageAt,
        storedMessageCount: existing?.storedMessageCount ?? 0,
        newestStoredMessageId: existing?.newestStoredMessageId ?? null,
        oldestStoredMessageId: existing?.oldestStoredMessageId ?? null,
        messageCoverageStatus: existing?.messageCoverageStatus ?? "pending_backfill",
        messageBackfillComplete: existing?.messageBackfillComplete ?? false,
        lastMessageSyncAt: existing?.lastMessageSyncAt ?? null,
        isVisible: true,
        lastSeenGeneration: state.generation,
        metadata,
      });
    }
    processedConversations += conversationWrites.length;

    const nextState = {
      ...state,
      unchangedPageStreak: unchangedPage ? state.unchangedPageStreak + 1 : 0,
      offset: page.done ? state.offset : state.offset + 100,
    };
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      let dmMessagesFollowupNeeded = false;
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: [...hydratedAccountsById.values()],
        fallbackIds: [...fallbackPartnerIds],
      });

      for (const conversationWrite of conversationWrites) {
        const fanId = conversationWrite.partnerPlatformUserId && conversationWrite.existingFanId === null
          ? (fanMap.get(conversationWrite.partnerPlatformUserId) ?? null)
          : conversationWrite.existingFanId;
        const upsertedConversation = await upsertPageDmConversation(dbTx, {
          platformAccountId: input.pageContext.page.id,
          fanId,
          platformConversationId: conversationWrite.platformConversationId,
          partnerPlatformUserId: conversationWrite.partnerPlatformUserId,
          partnerUsername: conversationWrite.partnerUsername,
          partnerDisplayName: conversationWrite.partnerDisplayName,
          conversationFlags: conversationWrite.conversationFlags,
          unreadCount: conversationWrite.unreadCount,
          subscriptionTierId: conversationWrite.subscriptionTierId,
          lastMessageId: conversationWrite.lastMessageId,
          lastUnreadMessageId: conversationWrite.lastUnreadMessageId,
          lastMessageAt: conversationWrite.lastMessageAt,
          lastMessageSenderId: conversationWrite.lastMessageSenderId,
          lastMessageSenderRole: conversationWrite.lastMessageSenderRole,
          lastMessagePreview: conversationWrite.lastMessagePreview,
          lastFanMessageAt: conversationWrite.lastFanMessageAt,
          lastModelMessageAt: conversationWrite.lastModelMessageAt,
          storedMessageCount: conversationWrite.storedMessageCount,
          newestStoredMessageId: conversationWrite.newestStoredMessageId,
          oldestStoredMessageId: conversationWrite.oldestStoredMessageId,
          messageCoverageStatus: conversationWrite.messageCoverageStatus,
          messageBackfillComplete: conversationWrite.messageBackfillComplete,
          lastMessageSyncAt: conversationWrite.lastMessageSyncAt,
          isVisible: conversationWrite.isVisible,
          lastSeenGeneration: conversationWrite.lastSeenGeneration,
          metadata: conversationWrite.metadata,
        });
        if (upsertedConversation && shouldRequestDmMessagesFollowup(upsertedConversation)) {
          dmMessagesFollowupNeeded = true;
        }
      }

      if (page.done) {
        await markPageDmConversationsInvisibleByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        const completedState = {
          version: 1,
          generation: state.generation,
          lastFullSweepCompletedAt: new Date().toISOString(),
        };
        return {
          kind: "complete" as const,
          dmMessagesFollowupNeeded,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_conversations",
            state: completedState,
            lastSuccessfulRunId: input.syncRunId,
          }),
        };
      }

      return {
        kind: "progress" as const,
        dmMessagesFollowupNeeded,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_conversations",
          state: nextState,
        }),
      };
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(pageWrite.checkpoint),
    );

    if (pageWrite.dmMessagesFollowupNeeded) {
      await requestPageSync(app.db, {
        pageId: input.pageContext.page.id,
        streams: ["dm_messages"],
        source: "scheduled",
        ...pageSyncDependencyInput(app),
      });
    }

    if (pageWrite.kind === "complete") {
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          processedConversations,
          repairedHeads,
          providerReportedTotal: state.providerReportedTotal,
          fullSweepCompleted: true,
        },
      } satisfies StreamChunkResult;
    }

    state = nextState;
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      generation: state.generation,
      offset: state.offset,
      pageCount: state.pageCount,
      processedConversations,
      repairedHeads,
      providerReportedTotal: state.providerReportedTotal,
      fullSweepCompleted: false,
    },
  } satisfies StreamChunkResult;
}

export async function onlyfansDmMessagesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<StreamChunkResult> {
  if (isOfapiDmSyncEligiblePage(app.config, input.pageContext.page)) {
    return executeOfapiDmMessagesChunk(app, input);
  }
  // OnlyMonster polling retired (Stage 18) — see onlyfansDmConversationsChunk.
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "onlyfans_dm_requires_ofapi_mapping" },
  } satisfies StreamChunkResult;
}

export async function fanslyDmMessagesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    throw new Error("DM message sync is only supported for Fansly pages");
  }

  assertDmSharedRateLimitEnabled(app);
  await input.telemetry.recordPhaseStarted("dm_messages");

  const chunkStartedAt = Date.now();
  const dmMessagesRequestObserver = new DmMessagesChunkRequestObserver();
  let emittedDmMessagesChunkSummary: DmMessagesChunkSummary | null = null;

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
      dmMessagesRequestObserver,
    ),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_messages");
  await input.telemetry.recordCheckpointLoaded("dm_messages", summarizeCheckpoint(checkpoint));

  let state = parseDmMessagesCursorState(checkpoint?.state) ?? emptyDmMessagesCursorState();

  if (!parseDmMessagesCursorState(checkpoint?.state)) {
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_messages",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_messages",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  const pageAccountId = resolveFanslyPlatformAccountId(input.pageContext.page);
  let processedMessages = 0;
  let completedConversations = 0;
  let overlapHits = 0;
  let exhaustedEligibleConversations = false;
  const deepBackfillMaxRequests = app.config.fanslyDmDeepBackfillEnabled === true
    ? Math.max(0, app.config.fanslyDmDeepBackfillMaxRequestsPerRun ?? 1)
    : 0;
  const deepBackfillLiveRequestsPerDeep =
    resolveFanslyDmDeepBackfillLiveRequestsPerDeep(app.config);
  let deepBackfillRequests = 0;
  let deepBackfillPaused = false;
  let deepBackfillSelectionReason: "quota" | "idle" | null = null;

  const emitDmMessagesChunkSummary = async () => {
    if (emittedDmMessagesChunkSummary) {
      return emittedDmMessagesChunkSummary;
    }

    emittedDmMessagesChunkSummary = dmMessagesRequestObserver.buildSummary(Date.now() - chunkStartedAt);
    await input.telemetry.recordDmMessagesChunkSummary(emittedDmMessagesChunkSummary);
    return emittedDmMessagesChunkSummary;
  };

  try {
    conversationLoop: while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
      await assertOwnedPageSyncLease(app.db);
      let conversation = state.currentConversationId
        ? await getPageDmConversationById(app.db, state.currentConversationId)
        : null;

      if (conversation && isFanslyDmMessageSyncExcluded(conversation.metadata)) {
        state = emptyDmMessagesCursorState();
        const progressCheckpoint = await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state,
        });
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(progressCheckpoint),
        );
        conversation = null;
      }

      if (!conversation || !conversation.isVisible || conversation.fanId === null) {
        let currentMode: "backfill" | "deep_backfill" | "incremental" | null = null;
        const shouldTryQuotaDeepBackfill =
          deepBackfillRequests < deepBackfillMaxRequests &&
          getDmMessagesLiveRequestsSinceDeepBackfill(state) >= deepBackfillLiveRequestsPerDeep;

        if (shouldTryQuotaDeepBackfill) {
          const deepBackfillEffective = await loadEffectiveConfig(app.db, app.config);
          const deepBackfillCandidate = await selectNextPageDmMessageDeepBackfillCandidate(app.db, {
            platformAccountId: input.pageContext.page.id,
            // Stage 17: the exhaustion crawl lifts the per-conversation depth
            // cap; archive coverage (not hot-table size) is the goal.
            ignoreRetentionLimit: deepBackfillEffective.fanslyDeepBackfillIgnoreRetentionLimit === true,
          });
          if (deepBackfillCandidate) {
            conversation = await getPageDmConversationById(app.db, deepBackfillCandidate.id);
            if (!conversation) {
              exhaustedEligibleConversations = true;
              break;
            }

            currentMode = "deep_backfill";
            deepBackfillSelectionReason = "quota";
          } else {
            conversation = null;
          }
        }

        if (!conversation) {
          const candidate = await selectNextPageDmMessageSyncCandidate(app.db, {
            platformAccountId: input.pageContext.page.id,
          });
          if (candidate) {
            conversation = await getPageDmConversationById(app.db, candidate.id);
            if (!conversation) {
              exhaustedEligibleConversations = true;
              break;
            }

            currentMode = conversation.storedMessageCount === 0
              ? "backfill"
              : conversation.lastMessageId !== conversation.newestStoredMessageId
                ? "incremental"
                : conversation.messageCoverageStatus === "pending_backfill"
                  ? "backfill"
                  : "incremental";
          } else if (deepBackfillRequests < deepBackfillMaxRequests) {
            const idleDeepBackfillEffective = await loadEffectiveConfig(app.db, app.config);
            const deepBackfillCandidate = await selectNextPageDmMessageDeepBackfillCandidate(app.db, {
              platformAccountId: input.pageContext.page.id,
              // Stage 17: same exhaustion-crawl semantics as the quota path —
              // both selection paths must honor the lifted depth cap.
              ignoreRetentionLimit:
                idleDeepBackfillEffective.fanslyDeepBackfillIgnoreRetentionLimit === true,
            });
            if (!deepBackfillCandidate) {
              exhaustedEligibleConversations = true;
              break;
            }

            conversation = await getPageDmConversationById(app.db, deepBackfillCandidate.id);
            if (!conversation) {
              exhaustedEligibleConversations = true;
              break;
            }

            currentMode = "deep_backfill";
            deepBackfillSelectionReason = "idle";
          } else {
            exhaustedEligibleConversations = true;
            break;
          }
        }

        if (!conversation || currentMode === null) {
          exhaustedEligibleConversations = true;
          break;
        }

        const nextState: DmMessagesCursorState = {
          ...emptyDmMessagesCursorState(),
          currentConversationId: conversation.id,
          currentPlatformConversationId: conversation.platformConversationId,
          currentBeforeMessageId: currentMode === "backfill" || currentMode === "deep_backfill"
            ? conversation.oldestStoredMessageId
            : null,
          currentMode,
        };
        state = currentMode === "deep_backfill"
          ? setDmMessagesLiveRequestsSinceDeepBackfill(nextState, 0)
          : setDmMessagesLiveRequestsSinceDeepBackfill(
            nextState,
            getDmMessagesLiveRequestsSinceDeepBackfill(state),
          );
        if (currentMode !== "deep_backfill") {
          const progressCheckpoint = await upsertCheckpointProgress(app.db, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_messages",
            state,
          });
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(progressCheckpoint),
          );
        }
      }

      if (!conversation || !state.currentMode) {
        exhaustedEligibleConversations = true;
        break;
      }

      const currentMode = state.currentMode;
      let collectedThisConversation = 0;
      while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
        const currentConversation = conversation;
        await assertOwnedPageSyncLease(app.db);
        dmMessagesRequestObserver.recordConversationTouched(currentConversation.id);

        let page;
        try {
          page = await app.adapter.getMessagesPage(requestContext, {
            groupId: currentConversation.platformConversationId,
            limit: 25,
            before: state.currentBeforeMessageId,
          });
        } catch (error) {
          if (
            !isTerminalFanslyServerError(error) ||
            !currentConversation.partnerPlatformUserId
          ) {
            throw error;
          }

          const failureStreak = await countRecentTerminalDmMessageConversationFailureStreak(
            app.db,
            {
              platformAccountId: input.pageContext.page.id,
              platformConversationId: currentConversation.platformConversationId,
            },
          );
          if (failureStreak < DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD) {
            throw error;
          }

          if (!input.budget.hasRequestCapacity() || !input.budget.hasWallClockCapacity()) {
            throw error;
          }

          const resolution = await probeFanslyAccountResolution(
            app,
            requestContext,
            currentConversation.partnerPlatformUserId,
            { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
          );
          if (resolution !== "unresolved") {
            throw error;
          }

          const progressCheckpoint = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
            await upsertPageDmConversation(dbTx, {
              platformAccountId: currentConversation.platformAccountId,
              fanId: currentConversation.fanId,
              platformConversationId: currentConversation.platformConversationId,
              partnerPlatformUserId: currentConversation.partnerPlatformUserId,
              partnerUsername: currentConversation.partnerUsername,
              partnerDisplayName: currentConversation.partnerDisplayName,
              conversationFlags: currentConversation.conversationFlags,
              unreadCount: currentConversation.unreadCount,
              subscriptionTierId: currentConversation.subscriptionTierId,
              lastMessageId: currentConversation.lastMessageId,
              lastUnreadMessageId: currentConversation.lastUnreadMessageId,
              lastMessageAt: currentConversation.lastMessageAt,
              lastMessageSenderId: currentConversation.lastMessageSenderId,
              lastMessageSenderRole: currentConversation.lastMessageSenderRole,
              lastMessagePreview: currentConversation.lastMessagePreview,
              lastFanMessageAt: currentConversation.lastFanMessageAt,
              lastModelMessageAt: currentConversation.lastModelMessageAt,
              storedMessageCount: currentConversation.storedMessageCount,
              newestStoredMessageId: currentConversation.newestStoredMessageId,
              oldestStoredMessageId: currentConversation.oldestStoredMessageId,
              messageCoverageStatus: currentConversation.messageCoverageStatus,
              messageBackfillComplete: currentConversation.messageBackfillComplete,
              lastMessageSyncAt: currentConversation.lastMessageSyncAt,
              isVisible: currentConversation.isVisible,
              lastSeenGeneration: currentConversation.lastSeenGeneration,
              metadata: {
                ...currentConversation.metadata,
                [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
                  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
              },
            });
            return upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "dm_messages",
              state: emptyDmMessagesCursorState(),
            });
          });
          await input.telemetry.addNote(
            "Excluded DM conversation after repeated 5xx because partner account is unresolvable",
            {
              conversationId: currentConversation.id,
              groupId: currentConversation.platformConversationId,
              partnerPlatformUserId: currentConversation.partnerPlatformUserId,
              partnerUsername: currentConversation.partnerUsername,
              currentMode,
              failureStreak,
              storedMessageCount: currentConversation.storedMessageCount,
              messageCoverageStatus: currentConversation.messageCoverageStatus,
              lastMessageId: currentConversation.lastMessageId,
              newestStoredMessageId: currentConversation.newestStoredMessageId,
              accountResolution: resolution,
              exclusionReason:
                FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
            },
          );

          state = emptyDmMessagesCursorState();
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(progressCheckpoint),
          );
          continue conversationLoop;
        }
        // Stage 1: DM message pages are captured raw (previously zero raw
        // persistence on this path); far-future retention via dmRetentionDate.
        await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "dm_messages",
          requestParams: {
            groupId: currentConversation.platformConversationId,
            limit: 25,
            before: state.currentBeforeMessageId ?? null,
          },
          responsePayload: page.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_messages",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting dm_messages raw payload",
          platform: "fansly",
        });

        const existingIds = await getExistingPageDmMessageIds(app.db, {
          conversationId: currentConversation.id,
          platformMessageIds: page.items.map((message) => message.id),
        });
        const overlapFound = page.items.some((message) => existingIds.has(message.id));

        const normalizedMessages: Parameters<typeof upsertPageDmMessages>[1] = [];
        for (const message of page.items) {
          const createdAt = await normalizeDmTimestampWithAnomaly(input.telemetry, {
            context: "dm_messages:message",
            value: message.createdAt,
          });
          if (!createdAt) {
            continue;
          }

          normalizedMessages.push({
            conversationId: currentConversation.id,
            platformAccountId: input.pageContext.page.id,
            platformMessageId: message.id,
            senderPlatformUserId: message.senderId ?? null,
            senderRole: resolveDmSenderRole(
              message.senderId ?? null,
              pageAccountId,
              currentConversation.partnerPlatformUserId,
            ),
            createdAt,
            content: message.content ?? "",
            totalTipAmountCents: normalizeDmTipAmountCents(
              input.pageContext.platform,
              message.totalTipAmount,
            ),
            inReplyToMessageId: message.inReplyTo ?? null,
            inReplyToRootMessageId: message.inReplyToRoot ?? null,
          });
        }
        const insertedMessageCount = normalizedMessages
          .filter((message) => !existingIds.has(message.platformMessageId))
          .length;
        collectedThisConversation += insertedMessageCount;
        processedMessages += normalizedMessages.length;
        const nextLiveRequestState = deepBackfillMaxRequests <= 0
          ? setDmMessagesLiveRequestsSinceDeepBackfill(state, 0)
          : currentMode === "deep_backfill"
          ? setDmMessagesLiveRequestsSinceDeepBackfill(state, 0)
          : incrementDmMessagesLiveRequestsSinceDeepBackfill(
            state,
            deepBackfillLiveRequestsPerDeep,
          );

        const oldestMessageId = page.items.at(-1)?.id ?? null;
        const providerHistoryExhausted = page.done || !oldestMessageId;
        const hitWindowCap =
          currentMode === "backfill" &&
          (currentConversation.storedMessageCount + collectedThisConversation) >= PAGE_DM_LIVE_BACKFILL_CAP;
        const shouldComplete = currentMode === "deep_backfill"
          ? true
          : currentMode === "incremental"
          ? overlapFound || providerHistoryExhausted
          : overlapFound || providerHistoryExhausted || hitWindowCap;

        if (shouldComplete) {
          if (overlapFound) {
            overlapHits += 1;
          }
          if (currentMode === "deep_backfill") {
            deepBackfillRequests += 1;
          }
          const messageCoverageStatus = resolveDmConversationCoverageStatus({
            currentMode,
            existingStatus: currentConversation.messageCoverageStatus,
            overlapFound,
            providerHistoryExhausted,
            hitWindowCap,
          });
          const finalized = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
            await upsertPageDmMessages(dbTx, normalizedMessages);
            const finalizedConversation = await finalizePageDmConversationMessageSync(dbTx, {
              conversationId: currentConversation.id,
              messageCoverageStatus,
              enforceRetention: await isPageDmPruneAllowed(app),
            });
            const nextState = setDmMessagesLiveRequestsSinceDeepBackfill(
              emptyDmMessagesCursorState(),
              getDmMessagesLiveRequestsSinceDeepBackfill(nextLiveRequestState),
            );
            const progressCheckpoint = await upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "dm_messages",
              state: nextState,
            });
            return {
              finalizedConversation,
              state: nextState,
              progressCheckpoint,
            };
          });
          conversation = finalized.finalizedConversation.conversation;
          completedConversations += 1;
          state = finalized.state;
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(finalized.progressCheckpoint),
          );
          if (
            currentMode === "deep_backfill" &&
            deepBackfillRequests >= deepBackfillMaxRequests
          ) {
            deepBackfillPaused = true;
            break conversationLoop;
          }
          break;
        }

        state = {
          ...nextLiveRequestState,
          currentBeforeMessageId: oldestMessageId,
        };
        const progressCheckpoint = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
          await upsertPageDmMessages(dbTx, normalizedMessages);
          return upsertCheckpointProgress(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "dm_messages",
            state,
          });
        });
        await input.telemetry.recordCheckpointAdvanced(
          "dm_messages",
          summarizeCheckpoint(progressCheckpoint),
        );

        if (input.budget.shouldYield()) {
          break;
        }
      }
    }

    const dmMessagesChunk = await emitDmMessagesChunkSummary();

    if (!exhaustedEligibleConversations && !deepBackfillPaused) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          currentConversationId: state.currentConversationId,
          currentBeforeMessageId: state.currentBeforeMessageId,
          currentMode: state.currentMode,
          processedMessages,
          completedConversations,
          overlapHits,
          deepBackfillRequests,
          dmMessagesChunk,
        },
      } satisfies StreamChunkResult;
    }

    if (
      deepBackfillPaused &&
      isFanslyDmDeepBackfillContinuationConfigured(app.config)
    ) {
      if (deepBackfillSelectionReason === "quota") {
        return {
          satisfied: false,
          yieldReason: null,
          continuationRetryAt: null,
          continuationRequestSource: "scheduled",
          stats: {
            currentConversationId: state.currentConversationId,
            currentBeforeMessageId: state.currentBeforeMessageId,
            currentMode: state.currentMode,
            processedMessages,
            completedConversations,
            overlapHits,
            deepBackfillRequests,
            deepBackfillPaused,
            deepBackfillSelectionReason,
            deepBackfillContinuationDelayMs: 0,
            deepBackfillContinuationRequestSource: "scheduled",
            dmMessagesChunk,
          },
        } satisfies StreamChunkResult;
      }

      const continuationDelayMs = resolveFanslyDmDeepBackfillContinuationDelayMs(app.config);
      const continuationRetryAt = new Date(Date.now() + continuationDelayMs);
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt,
        continuationRequestSource: "scheduled",
        stats: {
          currentConversationId: state.currentConversationId,
          currentBeforeMessageId: state.currentBeforeMessageId,
          currentMode: state.currentMode,
          processedMessages,
          completedConversations,
          overlapHits,
          deepBackfillRequests,
          deepBackfillPaused,
          deepBackfillSelectionReason,
          deepBackfillContinuationDelayMs: continuationDelayMs,
          deepBackfillContinuationRetryAt: continuationRetryAt.toISOString(),
          deepBackfillContinuationRequestSource: "scheduled",
          dmMessagesChunk,
        },
      } satisfies StreamChunkResult;
    }

    const completedCheckpoint = await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_messages",
      state,
      lastSuccessfulRunId: input.syncRunId,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_messages",
      summarizeCheckpoint(completedCheckpoint),
    );

    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        currentConversationId: state.currentConversationId,
        currentBeforeMessageId: state.currentBeforeMessageId,
        currentMode: state.currentMode,
        processedMessages,
        completedConversations,
        overlapHits,
        deepBackfillRequests,
        deepBackfillPaused,
        deepBackfillSelectionReason,
        dmMessagesChunk,
      },
    } satisfies StreamChunkResult;
  } catch (error) {
    await emitDmMessagesChunkSummary().catch(() => undefined);
    throw error;
  }
}

export async function resolveExecutorPageContext(
  app: AppContext,
  platformAccountId: number,
  _stream: SyncStream,
) {
  // Stage 18: platform-specific credential handling lives in
  // resolvePageContextById (OnlyFans pages resolve token-less — OnlyMonster
  // is retired and OFAPI streams authenticate vendor-side).
  return resolvePageContextById(app, platformAccountId);
}

/** Stage 16 ramp gate: flags gate platform egress, never capture. */
function fanslyNewStreamAllowed(
  allowlistCsv: string | undefined,
  pageLabel: string,
) {
  const entries = (allowlistCsv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 || entries.includes(pageLabel);
}

function fanslyNewStreamSkip(reason: string): StreamChunkResult {
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: reason },
  };
}

export async function executeFanEarningsChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return fanslyNewStreamSkip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted("fan_earnings");
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyFanEarningsSyncEnabled !== true) {
    return fanslyNewStreamSkip("flag_off");
  }
  if (!fanslyNewStreamAllowed(effective.fanslyNewStreamPageAllowlist, input.pageContext.page.label)) {
    return fanslyNewStreamSkip("not_allowlisted");
  }

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };

  // Snapshot-shaped: one lifetime page + one monthly page per run. Probe-grade
  // unknown payloads are journaled VERBATIM; typing happens at canonicalization
  // once the ramp captures a live corpus (recorded deviation).
  await assertOwnedPageSyncLease(app.db);
  const stats = await app.adapter.getEarningsStatsAccountsPage(requestContext, {});
  await persistRawPayload(app.db, {
    platformAccountId: input.pageContext.page.id,
    syncRunId: input.syncRunId,
    endpoint: "fan_earnings_stats",
    requestParams: {},
    responsePayload: stats.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, { action: "inserting fan_earnings_stats raw payload", platform: "fansly" });

  await assertOwnedPageSyncLease(app.db);
  const monthly = await app.adapter.getEarningsMonthlyStatsAccountsPage(requestContext, {});
  await persistRawPayload(app.db, {
    platformAccountId: input.pageContext.page.id,
    syncRunId: input.syncRunId,
    endpoint: "fan_earnings_monthly",
    requestParams: {},
    responsePayload: monthly.raw,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  }, { action: "inserting fan_earnings_monthly raw payload", platform: "fansly" });

  await upsertCheckpoint(app.db, {
    platformAccountId: input.pageContext.page.id,
    stream: "fan_earnings",
    cursorTimestamp: new Date(),
    state: { pageLabel: input.pageContext.page.label },
    lastSuccessfulRunId: input.syncRunId,
  });

  return { satisfied: true, yieldReason: null, stats: { pagesFetched: 2 } };
}

export async function executePurchaseHistoryChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return fanslyNewStreamSkip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted("purchase_history");
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyPurchaseHistorySyncEnabled !== true) {
    return fanslyNewStreamSkip("flag_off");
  }
  if (!fanslyNewStreamAllowed(effective.fanslyNewStreamPageAllowlist, input.pageContext.page.label)) {
    return fanslyNewStreamSkip("not_allowlisted");
  }

  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };

  // The order-history endpoint is per-fan and cursorless — the "back-scroll"
  // is a checkpointed keyset walk over the page's fans; a completed walk
  // resets the cursor so the next cadence refreshes incrementally.
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "purchase_history");
  const state = checkpoint?.state as { cursorFanId?: number } | null;
  let cursorFanId = typeof state?.cursorFanId === "number" ? state.cursorFanId : 0;
  let fansFetched = 0;
  let fansSkipped = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const fans = await listPageFanNativeIds(app.db, {
      platformAccountId: input.pageContext.page.id,
      afterFanId: cursorFanId,
      limit: 1,
    });
    const fan = fans[0];
    if (!fan) {
      // Mass-skip circuit breaker: a walk that skipped EVERY fan it touched
      // is a systemic failure (param-contract drift), not a string of dead
      // accounts — refuse to stamp completion (which would repeat the
      // zero-capture "success" every cadence, invisibly) and fail loudly so
      // the executor's retry/incident machinery engages.
      if (fansFetched === 0 && fansSkipped > 0) {
        throw new Error(
          `purchase_history walk skipped all ${fansSkipped} fans without one success`,
        );
      }
      await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "purchase_history",
        cursorTimestamp: new Date(),
        state: { cursorFanId: 0, completedAt: new Date().toISOString() },
        lastSuccessfulRunId: input.syncRunId,
      });
      return {
        satisfied: true,
        yieldReason: null,
        stats: { fansFetched, fansSkipped, walkCompleted: true },
      };
    }

    let page;
    try {
      page = await app.adapter.getMediaOrderHistoryPage(requestContext, {
        accountIds: fan.platformUserId,
        limit: 100,
      });
    } catch (error) {
      // Per-fan isolation: a fan-scoped client rejection (deleted/suspended
      // account) skips THAT fan and keeps walking — without this, the retry
      // path restarts at the same failing fan forever and the walk never
      // passes it. Page-scoped responses still propagate: auth (401/403),
      // rate-limit (429), and Fansly application code 99 (invalid params —
      // a CONTRACT failure, probe-proven, never a property of one fan).
      const fanScoped = error instanceof FanslyApiError &&
        typeof error.status === "number" &&
        [400, 404, 410].includes(error.status) &&
        error.code !== 99;
      if (!fanScoped) {
        throw error;
      }
      await input.telemetry.addAnomaly({
        code: "purchase_history_fan_rejected",
        severity: "warn",
        message: `Skipped purchase-history fan after HTTP ${error.status}`,
        details: {
          fanId: fan.fanId,
          platformUserId: fan.platformUserId,
          status: error.status,
          fanslyCode: error.code ?? null,
        },
      });
      fansSkipped += 1;
      // LOCAL advance only: the walk moves past the fan this run, but the
      // persisted cursor stays behind so a failed run resumes (and the
      // circuit breaker above can refire) instead of sealing the skips in.
      cursorFanId = fan.fanId;
      continue;
    }
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "purchase_history",
      requestParams: { accountIds: fan.platformUserId, limit: 100 },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { action: "inserting purchase_history raw payload", platform: "fansly" });

    cursorFanId = fan.fanId;
    fansFetched += 1;
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "purchase_history",
      state: { cursorFanId },
    });
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: { fansFetched, cursorFanId },
  };
}

export async function executeStreamChunk(
  app: AppContext,
  input: {
    pageContext: ResolvedPageContext;
    streamState: PageSyncLease;
    syncRunId: number;
    telemetry: SyncRunTelemetry;
    budget: SyncChunkBudget;
  },
): Promise<StreamChunkResult> {
  if (shouldSkipOnlyFansDmPolling(app, {
    pageContext: input.pageContext,
    stream: input.streamState.stream,
  })) {
    await input.telemetry.addNote(ONLYFANS_DM_POLLING_DISABLED_MESSAGE, {
      stream: input.streamState.stream,
      pageId: input.pageContext.page.id,
    });
    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        disabledByConfig: true,
      },
    } satisfies StreamChunkResult;
  }

  // Stage 18: registry-dispatched — the adapter's declared capabilities are
  // the routing table (parity with the old switch is pinned by the registry
  // test suite; an undeclared stream for a platform now fails loudly instead
  // of running the wrong platform's handler).
  const handler = appPlatformRegistry
    .get(input.pageContext.platform)
    .pull[input.streamState.stream as CanonicalStream];
  if (handler === undefined) {
    throw new Error(
      `Unsupported executor stream "${input.streamState.stream}" for platform "${input.pageContext.platform}"`,
    );
  }
  return handler(app, input);
}
