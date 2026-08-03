import {
  aggregateTransactionTopSpenders,
  assertOwnedPageSyncLease,
  countRecentTerminalDmMessageConversationFailureStreak,
  countActivePageFollows,
  countPageFollowsByGeneration,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  finalizePageDmConversationMessageSync,
  getEarliestSpenderTransactionAt,
  getPageDmConversationById,
  getCheckpoint,
  getCurrentSubscribers,
  listPageDmConversationsByPlatformConversationIds,
  listFanslyPurchaseHistoryCaptures,
  listFanslyDmRawPayloadsAfterId,
  listFanslyMessagePurchaseTargetsAfterId,
  markPageDmConversationsInvisibleByGeneration,
  maxPageDmThreadGeneration,
  maxPageFollowGeneration,
  maxPageSubscriptionGeneration,
  PAGE_DM_LIVE_BACKFILL_CAP,
  PageSyncLeaseLostError,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordProjectionDebt,
  requestPageSync,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  selectNextPageDmMessageDeepBackfillCandidate,
  selectNextPageDmMessageSyncCandidate,
  updatePageSyncTimestampCache,
  upsertArchivedPageSubscriptions,
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
} from "@agency_hub_core/shared";

import type { CanonicalStream } from "@agency_hub_core/platform-core";

import { appPlatformRegistry } from "../../platforms/registry.ts";
import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import {
  resolvePageContextById,
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
  type DmConversationCursorState,
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
import { fanslyNewStreamAllowed } from "./fansly-stream-gate.ts";
import {
  assertFanslyPurchaseHistoryTargetKindsConsistent,
  classifyFanslyPurchaseHistoryCapture,
  classifyFanslyPurchaseHistoryCaptures,
  extractFanslyPurchaseHistoryTargets,
  extractFanslyPurchaseHistoryTargetsFromTransactions,
  FANSLY_PURCHASE_HISTORY_RESULT_LIMIT,
  fanslyPurchaseHistoryTargetKey,
  parseFanslyPurchaseHistoryCursorState,
  type FanslyPurchaseHistoryCaptureClassification,
  type FanslyPurchaseHistoryCursorStateV4,
} from "./fansly-purchase-history.ts";
import { isOnlyFansTopSpendersEnabled } from "./onlyfans-top-spenders.ts";
import {
  dmRetentionDate,
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
  trimFanslyFollowerPayload,
  trimFanslyMessagingGroupsPayload,
} from "./shared.ts";
import {
  assertDmSharedRateLimitEnabled,
  DmMessagesChunkRequestObserver,
  FANSLY_DM_MESSAGE_PAGE_LIMIT,
  fetchAndJournalFanslyDmMessagePage,
  normalizeDmTimestampWithAnomaly,
  resolveDmConversationCoverageStatus,
  resolveDmSenderRole,
} from "./fansly-dm-messages.ts";
import { materializeFanslyDmTipContextsBestEffort } from "./fansly-tip-contexts.ts";
import { lookupHydratedFans, upsertHydratedFansForPage, type HydrationCaptureContext } from "./fan-hydration.ts";
import { syncTransactions } from "./transactions.ts";
import {
  FanslyPurchaseHistoryContractError,
  FollowersReconcileConsistencyError,
} from "./errors.ts";

export type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

const DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD = 3;
const PURCHASE_HISTORY_RAW_BATCH_SIZE = 500;
const PURCHASE_HISTORY_MAX_SCAN_BATCHES_PER_CHUNK = 4;
const PURCHASE_HISTORY_TRANSACTION_BATCH_SIZE = 500;
const PURCHASE_HISTORY_MAX_TRANSACTION_SCAN_BATCHES_PER_CHUNK = 4;
const TOP_SPENDERS_STEADY_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function purchaseHistoryCaptureBlockError(
  capture: FanslyPurchaseHistoryCaptureClassification,
) {
  if (capture.outcome === "cursor_missing") {
    return new FanslyPurchaseHistoryContractError({
      code: "purchase_history_cursor_missing",
      message:
        `Fansly purchase-history returned ${capture.orderRows} non-empty rows without a last-row orderId; refusing false completeness`,
    });
  }
  if (capture.outcome === "cursor_repeated") {
    return new FanslyPurchaseHistoryContractError({
      code: "purchase_history_cursor_repeated",
      message:
        `Fansly purchase-history cursor repeated at ${capture.nextBefore ?? capture.requestBefore ?? "page one"}; refusing an unbounded loop`,
    });
  }
  if (capture.outcome === "cursor_conflict") {
    return new FanslyPurchaseHistoryContractError({
      code: "purchase_history_cursor_conflict",
      message:
        "Captured Fansly purchase-history pages disagree on target kind or next cursor; local resolution is required",
    });
  }
  if (capture.outcome === "http_rejected") {
    return new FanslyPurchaseHistoryContractError({
      code: "purchase_history_contract_rejected",
      message:
        `Captured Fansly purchase-history target returned HTTP ${capture.statusCode}; local resolution is required before completeness can be certified`,
    });
  }
  return new FanslyPurchaseHistoryContractError({
    code: "purchase_history_contract_rejected",
    message:
      "Fansly purchase-history response omitted both supported order arrays; captured response requires local parser repair",
  });
}
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
  /** Set when a ramp gate short-circuited the chunk before any egress. Such a
   *  chunk terminates WITHOUT recording a successful sync anywhere. ONLY
   *  fanslyNewStreamSkip sets this — do not extend it to the other
   *  "satisfied but did nothing" skips (onlyfans_top_spenders_disabled,
   *  legacy_ofapi_dm_messages_retired, sweep_not_due, ...): their streams sit
   *  in BLOCK_TASKS / SYNC_DOMAIN_POLICY, where withholding succeeded_at WOULD
   *  degrade chatter-visible block health. That is a separate decision. */
  gatedSkip?: string | null;
};

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = normalizeDmMessageText(content);
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
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
    streamState: PageSyncLease;
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
      requestSeq: input.streamState.leasedSeq ?? input.streamState.requestSeq,
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
  const previousCheckpointState = asRecord(checkpoint?.state);
  const previousGeneration = asNumber(previousCheckpointState?.generation) ?? 0;
  const previousHistoryBackfilledAt = typeof previousCheckpointState?.historyBackfilledAt === "string"
    ? previousCheckpointState.historyBackfilledAt
    : null;
  let state: SubscribersCursorState;
  if (existingState) {
    state = existingState;
  } else {
    const storedGeneration = await maxPageSubscriptionGeneration(
      app.db,
      input.pageContext.page.id,
    );
    state = {
      revision: input.streamState.requestSeq,
      generation: Math.max(previousGeneration, storedGeneration) + 1,
      mode: "active",
      historyBackfilledAt: previousHistoryBackfilledAt,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      providerReportedTotal: null,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
  }

  let processedThisChunk = 0;

  // A non-empty subscribers page is followed by one batched account lookup.
  // Reserve both calls so a chunk never starts a page it cannot hydrate.
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const status = state.mode === "active" ? "3,4" : "5";
    const page = await app.adapter.getSubscribersPage(
      requestContext,
      { limit: 100, offset: state.offset, status },
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
      requestParams: { offset: state.offset, limit: 100, status },
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting subscribers raw payload",
      platform: "fansly",
    });

    if (state.mode === "active" && state.offset === 0 && page.items.length === 0) {
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
    const nextPageState = page.done
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
          mode: state.mode,
        },
      });
      throw new Error("Subscriber sync returned a partial result; refusing destructive finalization");
    }

    const shouldBackfillHistory =
      state.mode === "active" &&
      page.done &&
      state.historyBackfilledAt === null;
    const historyState: SubscribersCursorState = {
      ...state,
      mode: "expired",
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      providerReportedTotal: null,
    };

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
        if (state.mode === "active") {
          fanPageInputs.push({
            fanId,
            platformAccountId: input.pageContext.page.id,
            isSubscriber: true,
            subscriberSince: sourceCreatedAt,
            subscriptionExpiresAt: endsAt,
            autoRenew,
          });
        }
      }

      if (state.mode === "active") {
        await upsertPageSubscriptions(dbTx, subscriptionInputs);
        await upsertFanPages(dbTx, fanPageInputs);
      } else {
        await upsertArchivedPageSubscriptions(dbTx, subscriptionInputs);
      }

      if (state.mode === "active" && page.done) {
        await deactivatePageSubscriptionsByGeneration(dbTx, {
          platformAccountId: input.pageContext.page.id,
          generation: state.generation,
        });
        await refreshFanPageSubscriberState(dbTx, input.pageContext.page.id);
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        if (shouldBackfillHistory) {
          return {
            kind: "progress" as const,
            nextState: historyState,
            checkpoint: await upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "subscribers",
              state: historyState,
            }),
            processedThisPage: subscriptionInputs.length,
          };
        }
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

      if (state.mode === "expired" && page.done) {
        const historyBackfilledAt = new Date().toISOString();
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        return {
          kind: "complete" as const,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "subscribers",
            state: {
              ...state,
              observedCount: finalObservedCount,
              historyBackfilledAt,
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: subscriptionInputs.length,
        };
      }

      return {
        kind: "progress" as const,
        nextState: nextPageState,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: nextPageState,
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
          mode: state.mode,
          pageCount: state.pageCount,
          processedThisChunk,
          providerReportedTotal: state.providerReportedTotal,
        },
      } satisfies StreamChunkResult;
    }

    state = pageWrite.nextState;
    await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(pageWrite.checkpoint));

    if (!input.budget.hasRequestCapacity(2) || !input.budget.hasWallClockCapacity()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(2),
        stats: {
          generation: state.generation,
          mode: state.mode,
          offset: state.offset,
          pageCount: state.pageCount,
          processedThisChunk,
        },
      } satisfies StreamChunkResult;
    }
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(2),
    stats: {
      generation: state.generation,
      mode: state.mode,
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
  const pageContext = input.pageContext;

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
  const previousCheckpointState = asRecord(checkpoint?.state);
  const previousGeneration = asNumber(previousCheckpointState?.generation) ?? 0;
  const previousIsSnapshotRestartMarker =
    previousCheckpointState?.restartReason === "snapshot_mismatch" &&
    asNumber(previousCheckpointState.revision) === input.streamState.requestSeq;
  const previousSnapshotRestartCount = previousIsSnapshotRestartMarker
    ? asNumber(previousCheckpointState?.snapshotRestartCount) ?? 0
    : 0;
  let state: FollowersReconcileCursorState;
  if (existingState) {
    state = existingState;
  } else {
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    const storedGeneration = await maxPageFollowGeneration(app.db, input.pageContext.page.id);
    state = {
      revision: input.streamState.requestSeq,
      generation: Math.max(previousGeneration, storedGeneration) + 1,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      sourceFollowerCount: accountMe.parsed.account.followCount,
      snapshotRestartCount: previousSnapshotRestartCount,
      restartReason: previousIsSnapshotRestartMarker ? "snapshot_mismatch" : null,
      verificationPending: false,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "followers_reconcile",
      state,
    });
  }

  const verifyPendingGeneration = async (processedThisChunk: number) => {
    if (!state.verificationPending) {
      throw new Error("Follower reconcile terminal verification requires a pending generation");
    }

    if (!input.budget.hasRequestCapacity() || !input.budget.hasWallClockCapacity()) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        stats: {
          generation: state.generation,
          pageCount: state.pageCount,
          processedThisChunk,
          verificationPending: true,
        },
      } satisfies StreamChunkResult;
    }

    await assertOwnedPageSyncLease(app.db);
    const finalizationFollowerCount = (
      await refreshPageMetadata(
        app,
        pageContext,
        undefined,
        input.telemetry,
        requestContext.requestObserver,
      )
    ).parsed.account.followCount;
    const verification = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const generationObservedCount = asNumber(await countPageFollowsByGeneration(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      })) ?? 0;
      if (generationObservedCount !== finalizationFollowerCount) {
        return {
          kind: "blocked" as const,
          generationObservedCount,
          finalizationFollowerCount,
        };
      }

      await deactivatePageFollowsByGeneration(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
      });
      await refreshFanPageFollowerState(dbTx, input.pageContext.page.id);
      await rebuildFollowerRollups(
        dbTx,
        input.pageContext.page.id,
        finalizationFollowerCount,
      );
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
            revision: state.revision,
            generation: state.generation,
            offset: state.offset,
            observedCount: state.observedCount,
            pageCount: state.pageCount,
            sourceFollowerCount: finalizationFollowerCount,
            snapshotRestartCount: 0,
            verificationPending: false,
          },
          lastSuccessfulRunId: input.syncRunId,
        }),
        generationObservedCount,
        finalizationFollowerCount,
      };
    });

    if (verification.kind === "blocked") {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_generation_guard",
        severity: "warn",
        message: "Follower reconcile generation did not match the source follower count; refusing destructive finalization",
        details: {
          sourceFollowerCount: verification.finalizationFollowerCount,
          ...(state.sourceFollowerCount !== verification.finalizationFollowerCount
            ? { startingSourceFollowerCount: state.sourceFollowerCount }
            : {}),
          observedCount: state.observedCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
        },
      });
      if (state.snapshotRestartCount < 1) {
        await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers_reconcile",
          state: {
            revision: state.revision,
            generation: state.generation,
            snapshotRestartCount: state.snapshotRestartCount + 1,
            restartReason: "snapshot_mismatch",
            verificationPending: false,
          },
        });
        throw new FollowersReconcileConsistencyError({
          code: "followers_reconcile_snapshot_drift",
          message:
            `Follower reconcile moved during the scan (${verification.generationObservedCount} unique rows ` +
            `for terminal count ${verification.finalizationFollowerCount}, ` +
            `starting count ${state.sourceFollowerCount}); restarting one fresh generation`,
          retryable: true,
        });
      }
      throw new FollowersReconcileConsistencyError({
        code: "followers_reconcile_inconsistent_snapshot",
        message:
          `Follower reconcile generation contained ${verification.generationObservedCount} unique rows ` +
          `for terminal source count ${verification.finalizationFollowerCount} ` +
          `(starting count ${state.sourceFollowerCount}); refusing destructive finalization`,
      });
    }

    if (state.sourceFollowerCount !== verification.finalizationFollowerCount) {
      await input.telemetry.addNote(
        "Follower headline changed during reconcile; terminal exact-count guard passed",
        {
          code: "followers_reconcile_terminal_headline_changed",
          startingSourceFollowerCount: state.sourceFollowerCount,
          terminalSourceFollowerCount: verification.finalizationFollowerCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
        },
      );
    }
    if (state.observedCount !== verification.finalizationFollowerCount) {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_offset_drift_tolerated",
        severity: "warn",
        message: "Follower reconcile raw row count drifted while the unique generation count remained complete",
        details: {
          sourceFollowerCount: verification.finalizationFollowerCount,
          ...(state.sourceFollowerCount !== verification.finalizationFollowerCount
            ? { startingSourceFollowerCount: state.sourceFollowerCount }
            : {}),
          observedCount: state.observedCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
        },
      });
    }
    await input.telemetry.recordCheckpointAdvanced(
      "followers_reconcile",
      summarizeCheckpoint(verification.checkpoint),
    );
    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        generation: state.generation,
        pageCount: state.pageCount,
        processedThisChunk,
        sourceFollowerCount: verification.finalizationFollowerCount,
        startingSourceFollowerCount: state.sourceFollowerCount,
        generationObservedCount: verification.generationObservedCount,
      },
    } satisfies StreamChunkResult;
  };

  if (state.verificationPending) {
    return verifyPendingGeneration(0);
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
        throw new FollowersReconcileConsistencyError({
          code: "followers_reconcile_empty_first_page",
          message: "Follower reconcile returned zero rows; refusing destructive finalization",
        });
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
          reason: "unmapped" as const,
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
        const verificationState = {
          ...state,
          observedCount: finalObservedCount,
          pageCount: state.pageCount,
          verificationPending: true,
        };
        return {
          kind: "verification_pending" as const,
          checkpoint: await upsertCheckpointProgress(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "followers_reconcile",
            state: verificationState,
          }),
          processedThisPage: followInputs.length,
          state: verificationState,
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
      throw new FollowersReconcileConsistencyError({
        code: "followers_reconcile_unmapped_rows",
        message: "Follower reconcile left source follower rows unmapped; refusing destructive finalization",
      });
    }

    processedThisChunk += pageWrite.processedThisPage;
    await input.telemetry.recordCheckpointAdvanced(
      "followers_reconcile",
      summarizeCheckpoint(pageWrite.checkpoint),
    );

    if (pageWrite.kind === "verification_pending") {
      state = pageWrite.state;
      return verifyPendingGeneration(processedThisChunk);
    }

    state = nextState;

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
  type DmConversationSweepCursorState = DmConversationCursorState & {
    observedCount: number;
    snapshotConversationIds: string[];
  };
  const legacySnapshotMissing = Boolean(
    existingState && existingState.snapshotConversationIds === undefined,
  );
  let state: DmConversationSweepCursorState;
  if (existingState) {
    const snapshotConversationIds = existingState.snapshotConversationIds ?? [];
    state = {
      ...existingState,
      snapshotConversationIds,
      observedCount: snapshotConversationIds.length,
    };
  } else {
    const checkpointGeneration = asNumber(checkpointStateRecord?.generation) ?? 0;
    const storedGeneration = await maxPageDmThreadGeneration(app.db, input.pageContext.page.id);
    state = {
      version: 1,
      mode: "full_scan",
      generation: Math.max(checkpointGeneration, storedGeneration) + 1,
      offset: 0,
      observedCount: 0,
      snapshotConversationIds: [],
      pageCount: 0,
      providerTotalMode: "unobserved",
      providerReportedTotal: null,
      unchangedPageStreak: 0,
      fullSweepStartedAt: new Date().toISOString(),
      lastFullSweepCompletedAt: asNullableString(checkpointStateRecord?.lastFullSweepCompletedAt),
    };
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

  const restartSweepAfterCapturedContractDrift = async (guard: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  }): Promise<never> => {
    const storedGeneration = await maxPageDmThreadGeneration(app.db, input.pageContext.page.id);
    const restartState: DmConversationSweepCursorState = {
      version: 1,
      mode: "full_scan",
      generation: Math.max(state.generation, storedGeneration) + 1,
      offset: 0,
      observedCount: 0,
      snapshotConversationIds: [],
      pageCount: 0,
      providerTotalMode: "unobserved",
      providerReportedTotal: null,
      unchangedPageStreak: 0,
      fullSweepStartedAt: new Date().toISOString(),
      lastFullSweepCompletedAt: state.lastFullSweepCompletedAt,
    };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "dm_conversations",
      state: restartState,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "dm_conversations",
      summarizeCheckpoint(progressCheckpoint),
    );
    await input.telemetry.addAnomaly({
      code: guard.code,
      severity: "error",
      message: guard.message,
      details: {
        ...guard.details,
        abandonedGeneration: state.generation,
        restartGeneration: restartState.generation,
      },
    });
    throw new Error(`${guard.message}; restarted the DM conversation sweep`);
  };

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
    const frozenProviderReportedTotal = state.providerReportedTotal;
    const frozenProviderTotalMode = state.providerTotalMode;
    const providerTotalField = page.total as unknown;
    const currentProviderTotalMode = providerTotalField == null
      ? "absent" as const
      : "present" as const;
    const currentProviderReportedTotal = currentProviderTotalMode === "present" &&
        Number.isSafeInteger(providerTotalField) && (providerTotalField as number) >= 0
      ? providerTotalField as number
      : null;
    const nextPageCount = state.pageCount + 1;

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

    if (currentProviderTotalMode === "present" && currentProviderReportedTotal === null) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_provider_total_invalid",
        message:
          "DM conversation sync provider total was present but invalid; refusing to apply the page",
        details: {
          currentProviderReportedTotal: providerTotalField ?? null,
          observedCount: state.snapshotConversationIds.length,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
      continue;
    }

    if (legacySnapshotMissing) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_legacy_snapshot_restart",
        message:
          "DM conversation sync resumed a legacy sweep without its unique-id snapshot; refusing to apply the page",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    if (
      (frozenProviderTotalMode !== "unobserved" &&
        currentProviderTotalMode !== frozenProviderTotalMode) ||
      (frozenProviderTotalMode === "present" &&
        currentProviderReportedTotal !== frozenProviderReportedTotal)
    ) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_provider_total_drift_guard",
        message:
          "DM conversation sync provider total presence or value changed during the sweep; refusing to apply the inconsistent page",
        details: {
          providerTotalMode: frozenProviderTotalMode,
          currentProviderTotalMode,
          providerReportedTotal: frozenProviderReportedTotal,
          currentProviderReportedTotal,
          observedCount: state.observedCount,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    const priorConversationIds = new Set(state.snapshotConversationIds);
    const currentConversationIds = page.items.map((conversation) => conversation.groupId);
    const uniqueCurrentConversationIds = new Set(currentConversationIds);
    const overlappingConversationIds = [...uniqueCurrentConversationIds].filter((conversationId) =>
      priorConversationIds.has(conversationId)
    );
    const duplicateIdsWithinPage = currentConversationIds.length - uniqueCurrentConversationIds.size;
    if (overlappingConversationIds.length > 0 || duplicateIdsWithinPage > 0) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_snapshot_overlap_guard",
        message:
          "DM conversation sync returned duplicate or overlapping group ids; refusing to apply the page",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          overlappingConversationIds: overlappingConversationIds.slice(0, 10),
          overlapCount: overlappingConversationIds.length,
          duplicateIdsWithinPage,
          observedCount: priorConversationIds.size,
          pageCount: nextPageCount,
          offset: state.offset,
        },
      });
    }

    const snapshotConversationIds = [
      ...state.snapshotConversationIds,
      ...uniqueCurrentConversationIds,
    ];
    const finalObservedCount = snapshotConversationIds.length;
    if (currentProviderReportedTotal !== null && (
      finalObservedCount > currentProviderReportedTotal ||
      (page.done && finalObservedCount !== currentProviderReportedTotal)
    )) {
      await restartSweepAfterCapturedContractDrift({
        code: "dm_conversations_partial_page_guard",
        message:
          "DM conversation sync returned a unique-id count that differs from the provider-reported total; refusing destructive finalization",
        details: {
          providerReportedTotal: currentProviderReportedTotal,
          observedCount: finalObservedCount,
          pageCount: nextPageCount,
        },
      });
    }

    state = {
      ...state,
      pageCount: nextPageCount,
      providerTotalMode: frozenProviderTotalMode === "unobserved"
        ? currentProviderTotalMode
        : frozenProviderTotalMode,
      providerReportedTotal: frozenProviderReportedTotal ?? currentProviderReportedTotal,
    };

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

      const headMessage = group?.lastMessage ?? detail?.parsed.lastMessage ?? null;
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
        const headRepairRequestParams = {
          groupId: conversation.groupId,
          limit: 1,
          headRepair: true,
        };
        const rawPayload = await persistRawPayload(app.db, {
          platformAccountId: input.pageContext.page.id,
          syncRunId: input.syncRunId,
          endpoint: "dm_messages",
          requestParams: headRepairRequestParams,
          responsePayload: headRepair.raw,
          mapperVersion: FANSLY_MAPPER_VERSION,
          payloadKind: "dm_messages",
          retainUntil: dmRetentionDate(),
        }, {
          action: "inserting dm_messages head-repair raw payload",
          platform: "fansly",
        });
        await materializeFanslyDmTipContextsBestEffort(app, {
          accountId: input.pageContext.page.id,
          requestParams: headRepairRequestParams,
          responsePayload: headRepair.raw,
          sourceRawPayloadId: rawPayload.id,
          capturedAt: rawPayload.capturedAt,
        });
        const repairedHead = headRepair.items[0] ?? null;
        if (repairedHead) {
          repairedHeads += 1;
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
      observedCount: finalObservedCount,
      snapshotConversationIds,
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
        const destructiveFinalization = state.providerTotalMode === "present";
        if (destructiveFinalization) {
          await markPageDmConversationsInvisibleByGeneration(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
          });
        }
        const completedState = {
          version: 1,
          generation: state.generation,
          observedCount: finalObservedCount,
          providerTotalMode: state.providerTotalMode,
          providerReportedTotal: state.providerReportedTotal,
          destructiveFinalization,
          lastFullSweepCompletedAt: new Date().toISOString(),
        };
        return {
          kind: "complete" as const,
          destructiveFinalization,
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
      if (!pageWrite.destructiveFinalization) {
        await input.telemetry.addNote(
          "DM conversation sweep completed without a provider total; unseen conversations remain visible",
          {
            code: "dm_conversations_provider_total_absent_nondestructive",
            observedCount: finalObservedCount,
            pageCount: state.pageCount,
            providerTotalMode: state.providerTotalMode,
          },
        );
      }
      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          generation: state.generation,
          offset: state.offset,
          pageCount: state.pageCount,
          observedCount: finalObservedCount,
          processedConversations,
          repairedHeads,
          providerTotalMode: state.providerTotalMode,
          providerReportedTotal: state.providerReportedTotal,
          destructiveFinalization: pageWrite.destructiveFinalization,
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
      observedCount: state.observedCount,
      processedConversations,
      repairedHeads,
      providerTotalMode: state.providerTotalMode,
      providerReportedTotal: state.providerReportedTotal,
      fullSweepCompleted: false,
    },
  } satisfies StreamChunkResult;
}

export async function onlyfansDmMessagesChunk(
  _app: AppContext,
  _input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
): Promise<StreamChunkResult> {
  // OF mirror S0: this handler is retained only as a rollback-compatible code
  // symbol. The legacy per-chat crawler must never issue another vendor call;
  // durable capture jobs use the separate intent-driven ofapi_capture stream.
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: "legacy_ofapi_dm_messages_retired" },
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
  // #135 A2b: finalize/checkpoint failures deferred into projection_debt
  // (repaired by the sweep) instead of failing the chunk.
  let projectionDebtRecorded = 0;
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

        // The fetch + verbatim journal + normalization is the unit shared with
        // the targeted thread backfill (slice C′). It stays inside this
        // try/catch exactly as the bare adapter call did: only a terminal
        // Fansly 5xx reaches the partner-unresolvable recovery below, every
        // other failure (including a capture failure) rethrows as before.
        let messagePage;
        try {
          messagePage = await fetchAndJournalFanslyDmMessagePage(app, {
            requestContext,
            telemetry: input.telemetry,
            syncRunId: input.syncRunId,
            platformAccountId: input.pageContext.page.id,
            platform: input.pageContext.platform,
            pageAccountId,
            conversation: currentConversation,
            before: state.currentBeforeMessageId,
            limit: FANSLY_DM_MESSAGE_PAGE_LIMIT,
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
        const { normalizedMessages, insertedMessageCount, overlapFound } = messagePage;
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

        const { oldestMessageId, providerHistoryExhausted } = messagePage;
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
          // #135 A2b: the message upsert commits on its own; the thread-summary
          // recompute + checkpoint advance ride a SECOND transaction. The
          // summary is a rebuildable projection (facts were journaled at fetch
          // time via persistRawPayload), so when only that second step fails
          // the failure becomes projection_debt for the 5-minute repair sweep
          // instead of re-wedging the whole dm_messages stream the way the
          // 0026 CHECK constraint did (251-270 consecutive 23514s, 05..11.07).
          // Capture, lease, and message-upsert failures keep today's fatal
          // behavior — only finalize/checkpoint gets the debt treatment.
          await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
            await upsertPageDmMessages(dbTx, normalizedMessages);
          });
          let finalized: {
            finalizedConversation: Awaited<ReturnType<typeof finalizePageDmConversationMessageSync>>;
            state: DmMessagesCursorState;
            progressCheckpoint: Awaited<ReturnType<typeof upsertCheckpointProgress>>;
          };
          try {
            finalized = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
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
          } catch (error) {
            if (error instanceof PageSyncLeaseLostError) {
              // Fencing stays fatal: another owner may already be running.
              throw error;
            }

            // Drizzle wraps the pg error in "Failed query: <full SQL>" — the
            // actionable part (constraint name, pg detail) lives in cause.
            const causeMessage = error instanceof Error &&
                error.cause instanceof Error
              ? error.cause.message
              : null;
            const debtSummary = causeMessage !== null
              ? causeMessage
              : error instanceof Error
                ? error.message
                : String(error);
            await recordProjectionDebt(app.db, {
              kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
              platformAccountId: input.pageContext.page.id,
              conversationId: currentConversation.id,
              errorSummary: debtSummary.slice(0, 500),
            });
            app.logger.warn({
              err: error,
              conversationId: currentConversation.id,
              platformAccountId: input.pageContext.page.id,
              currentMode,
            }, "DM thread summary finalize failed; recorded projection debt and continuing");

            // Clear the cursor pin (mirrors the excluded-conversation reset
            // above) so the stream moves on instead of replaying this
            // conversation's wedge from the checkpoint.
            state = emptyDmMessagesCursorState();
            const debtCheckpoint = await withOwnedPageSyncTransaction(app.db, (dbTx) =>
              upsertCheckpointProgress(dbTx, {
                platformAccountId: input.pageContext.page.id,
                stream: "dm_messages",
                state,
              }));
            await input.telemetry.recordCheckpointAdvanced(
              "dm_messages",
              summarizeCheckpoint(debtCheckpoint),
            );
            projectionDebtRecorded += 1;
            continue conversationLoop;
          }
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
          projectionDebtRecorded,
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
            projectionDebtRecorded,
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
          projectionDebtRecorded,
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
        projectionDebtRecorded,
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

function fanslyNewStreamSkip(reason: string): StreamChunkResult {
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: reason },
    gatedSkip: reason,
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

  // The earnings endpoints answer PER FAN: a windowed call without
  // correlationAccountId returns [] (ramp-caught 2026-07-06; probe-confirmed
  // with a fan id → 21 rows). So the capture is a checkpointed keyset walk —
  // SPENDER-scoped (fans with page_fans net > 0; zero-spend fans have no
  // earnings rows), two calls per fan (lifetime stats + monthly). Each
  // successful response is journaled independently before any later request
  // or parsing so a partial per-fan failure cannot discard captured bytes.
  const window = { after: new Date(0), before: new Date() };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "fan_earnings");
  const state = checkpoint?.state as { cursorFanId?: number } | null;
  let cursorFanId = typeof state?.cursorFanId === "number" ? state.cursorFanId : 0;
  // A43 (W8.2): the PERSISTED cursor advances only through one contiguous
  // prefix of successful fans. A fan-scoped rejection stops the walk; it may
  // never be crossed by a later success in the same keyset generation.
  let persistableCursorFanId = cursorFanId;
  let fansFetched = 0;
  let fansSkipped = 0;
  let walkCompleted = false;
  let rejectedFanError: FanslyApiError | null = null;

  const journalFanResponse = async (
    endpoint: "fan_earnings_stats" | "fan_earnings_monthly",
    fan: { fanId: number; platformUserId: string },
    response: { items: unknown; raw?: unknown },
  ) => {
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint,
      requestParams: {
        after: window.after.toISOString(),
        before: window.before.toISOString(),
        fanId: fan.fanId,
        correlationAccountId: fan.platformUserId,
        spendersOnly: true,
      },
      // Real adapters return raw. The fallback keeps older test doubles and
      // replay tooling source-compatible without weakening production capture.
      responsePayload: response.raw ?? response.items,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { action: `inserting ${endpoint} raw payload`, platform: "fansly" });
  };

  // Each fan costs TWO provider calls (lifetime + monthly stats) — reserve
  // both up front so the chunk never overshoots its request budget by one.
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const fans = await listPageFanNativeIds(app.db, {
      platformAccountId: input.pageContext.page.id,
      afterFanId: cursorFanId,
      limit: 1,
      spendersOnly: true,
    });
    const fan = fans[0];
    if (!fan) {
      walkCompleted = true;
      break;
    }

    try {
      const stats = await app.adapter.getEarningsStatsAccountsPage(requestContext, {
        correlationAccountId: fan.platformUserId,
        ...window,
      });
      // Capture each successful provider response before lease checks, parsing,
      // or the second call. A monthly rejection must never erase stats bytes.
      await journalFanResponse("fan_earnings_stats", fan, stats);
      if (!Array.isArray(stats.items)) {
        throw new Error("Fansly fan earnings stats response was not an array");
      }
      await assertOwnedPageSyncLease(app.db);
      const monthly = await app.adapter.getEarningsMonthlyStatsAccountsPage(requestContext, {
        correlationAccountId: fan.platformUserId,
        ...window,
      });
      await journalFanResponse("fan_earnings_monthly", fan, monthly);
      if (!Array.isArray(monthly.items)) {
        throw new Error("Fansly monthly fan earnings response was not an array");
      }
    } catch (error) {
      // A fan-scoped rejection cannot be skipped inside a keyset walk: doing
      // so and later persisting a successful fan would jump the durable cursor
      // over the rejected fan. Stop at the first rejection and persist only
      // the contiguous successful prefix before surfacing the provider error.
      const fanScoped = error instanceof FanslyApiError &&
        typeof error.status === "number" &&
        [400, 404, 410].includes(error.status);
      if (!fanScoped) {
        throw error;
      }
      await input.telemetry.addAnomaly({
        code: "fan_earnings_fan_rejected",
        severity: "warn",
        message: `Stopped fan-earnings walk after HTTP ${error.status} for one fan`,
        details: {
          fanId: fan.fanId,
          platformUserId: fan.platformUserId,
          status: error.status,
          fanslyCode: error.code ?? null,
        },
      });
      fansSkipped += 1;
      rejectedFanError = error;
      break;
    }

    cursorFanId = fan.fanId;
    persistableCursorFanId = fan.fanId;
    fansFetched += 1;
  }

  // Persist only completion or the contiguous successful prefix. If the first
  // fan rejects, leave the checkpoint untouched so retry targets that fan.
  if (walkCompleted) {
    await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "fan_earnings",
      cursorTimestamp: new Date(),
      // A completed walk resets the cursor so the next cadence refreshes.
      state: { cursorFanId: 0, completedAt: new Date().toISOString() },
      lastSuccessfulRunId: input.syncRunId,
    });
  } else if (fansFetched > 0) {
    const progressState = { cursorFanId: persistableCursorFanId };
    if (rejectedFanError) {
      // The prefix is durable progress, but this run is about to fail. Do not
      // stamp it as the stream's last successful run/freshness marker.
      await upsertCheckpointProgress(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "fan_earnings",
        state: progressState,
      });
    } else {
      await upsertCheckpoint(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "fan_earnings",
        cursorTimestamp: new Date(),
        state: progressState,
        lastSuccessfulRunId: input.syncRunId,
      });
    }
  }

  if (rejectedFanError) {
    throw rejectedFanError;
  }

  if (walkCompleted) {
    return {
      satisfied: true,
      yieldReason: null,
      stats: { fansFetched, fansSkipped, walkCompleted: true },
    };
  }
  return {
    satisfied: false,
    // The walk exits on hasRequestCapacity(2) — resolve the reason against
    // the same two-call unit cost or every non-final chunk yields reasonless.
    yieldReason: input.budget.resolveYieldReason(2),
    stats: { fansFetched, fansSkipped, cursorFanId },
  };
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

  // Fansly requires a concrete accountMediaId/accountMediaBundleId. accountIds
  // is only an optional buyer filter, so the old per-fan walk could never be
  // valid. Captured message-purchase transactions are the primary durable
  // discovery source; captured /message pages remain a complementary source
  // for PPV media observed before the matching transaction projection. Both
  // use local keysets, while target-specific purchase_history captures are the
  // durable dedupe set.
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "purchase_history");
  let state: FanslyPurchaseHistoryCursorStateV4 =
    parseFanslyPurchaseHistoryCursorState(checkpoint?.state) ?? {
      version: 4,
      transactionCursorId: 0,
      rawPayloadCursorId: 0,
      pendingTargets: [],
    };
  const captureIndex = classifyFanslyPurchaseHistoryCaptures(
    await listFanslyPurchaseHistoryCaptures(app.db, input.pageContext.page.id),
  );
  const capturedTargetKeys = new Set(captureIndex.capturedTargetKeys);
  const capturedContentIds = new Set(captureIndex.capturedContentIds);
  const validatedCompleteTargetKeys = new Set(captureIndex.validatedCompleteTargetKeys);
  const validatedCompleteContentIds = new Set(captureIndex.validatedCompleteContentIds);
  const resumableByTargetKey = new Map(captureIndex.resumableTargets.map((target) => [
    fanslyPurchaseHistoryTargetKey(target),
    target,
  ]));
  const resumableByContentId = new Map(captureIndex.resumableTargets.map((target) => [
    target.contentId,
    target,
  ]));
  const consumedResumableTargetKeys = new Set<string>();

  // Rebuild the provider cursor from the durable page chain. This covers both
  // ordinary crash windows (raw page committed, checkpoint not advanced) and
  // v3 checkpoints that falsely dropped a target after one non-empty page.
  const reconciledPendingTargets = state.pendingTargets.flatMap((target) => {
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    if (
      validatedCompleteTargetKeys.has(targetKey) ||
      validatedCompleteContentIds.has(target.contentId)
    ) {
      return [];
    }
    const exactResume = resumableByTargetKey.get(targetKey);
    if (exactResume) {
      consumedResumableTargetKeys.add(targetKey);
      return [exactResume];
    }
    // A captured target with the same global content id but a stronger kind
    // replaces stale alternate-kind checkpoint inference.
    if (resumableByContentId.has(target.contentId)) {
      return [];
    }
    return [target];
  });
  for (const resumable of captureIndex.resumableTargets) {
    if (!consumedResumableTargetKeys.has(fanslyPurchaseHistoryTargetKey(resumable))) {
      reconciledPendingTargets.push(resumable);
    }
  }
  if (JSON.stringify(reconciledPendingTargets) !== JSON.stringify(state.pendingTargets)) {
    state = { ...state, version: 4, pendingTargets: reconciledPendingTargets };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "purchase_history",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "purchase_history",
      summarizeCheckpoint(progressCheckpoint),
    );
  }

  // Raw capture is the sole truth. A malformed page or cyclic cursor blocks
  // every later run before egress; parser repairs can unlock the same bytes.
  const blockedCapture = captureIndex.blocked[0];
  if (blockedCapture) {
    throw purchaseHistoryCaptureBlockError(blockedCapture);
  }

  const capturedRequestCursorsByTargetKey = new Map<string, Set<string>>();
  for (const chain of captureIndex.chains) {
    capturedRequestCursorsByTargetKey.set(
      chain.targetKey,
      new Set(chain.requestCursors.map((cursor) => cursor ?? "")),
    );
  }

  let transactionRowsScanned = 0;
  let transactionScanBatches = 0;
  let transactionTargetsDiscovered = 0;
  let transactionSourceExhausted = false;
  let scannedRawPages = 0;
  let scanBatches = 0;
  let targetsFetched = 0;
  let targetsSkipped = 0;
  let pagesFetched = 0;
  let orderRowsCaptured = 0;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    if (state.pendingTargets.length === 0) {
      if (!transactionSourceExhausted) {
        if (
          transactionScanBatches >=
            PURCHASE_HISTORY_MAX_TRANSACTION_SCAN_BATCHES_PER_CHUNK
        ) {
          return {
            satisfied: false,
            yieldReason: null,
            stats: {
              transactionCursorId: state.transactionCursorId,
              transactionRowsScanned,
              transactionScanBatches,
              transactionTargetsDiscovered,
              rawPayloadCursorId: state.rawPayloadCursorId,
              scannedRawPages,
              scanBatches,
              targetsFetched,
              targetsSkipped,
              pagesFetched,
              orderRowsCaptured,
            },
          };
        }

        const transactionRows = await listFanslyMessagePurchaseTargetsAfterId(app.db, {
          pageId: input.pageContext.page.id,
          afterId: state.transactionCursorId,
          limit: PURCHASE_HISTORY_TRANSACTION_BATCH_SIZE,
        });
        transactionScanBatches += 1;
        transactionRowsScanned += transactionRows.length;
        if (transactionRows.length === 0) {
          transactionSourceExhausted = true;
        } else {
          const transactionTargets = extractFanslyPurchaseHistoryTargetsFromTransactions(
            transactionRows,
          );
          assertFanslyPurchaseHistoryTargetKindsConsistent(
            transactionTargets,
            capturedTargetKeys,
          );
          const discovered = transactionTargets.filter((target) =>
            !capturedTargetKeys.has(fanslyPurchaseHistoryTargetKey(target)) &&
            !capturedContentIds.has(target.contentId)
          );
          transactionTargetsDiscovered += discovered.length;
          state = {
            ...state,
            version: 4,
            transactionCursorId: transactionRows.at(-1)!.id,
            pendingTargets: discovered.map((target) => ({ ...target, before: null })),
          };
          // Persist discovery BEFORE egress: a crash can only replay the safe
          // target GET, never advance the transaction cursor past lost work.
          const progressCheckpoint = await upsertCheckpointProgress(app.db, {
            platformAccountId: input.pageContext.page.id,
            stream: "purchase_history",
            state,
          });
          await input.telemetry.recordCheckpointAdvanced(
            "purchase_history",
            summarizeCheckpoint(progressCheckpoint),
          );
          transactionSourceExhausted =
            transactionRows.length < PURCHASE_HISTORY_TRANSACTION_BATCH_SIZE;
        }

        if (state.pendingTargets.length === 0 && !transactionSourceExhausted) {
          continue;
        }
      }

      if (state.pendingTargets.length === 0) {
        if (scanBatches >= PURCHASE_HISTORY_MAX_SCAN_BATCHES_PER_CHUNK) {
          return {
            satisfied: false,
            yieldReason: null,
            stats: {
              transactionCursorId: state.transactionCursorId,
              transactionRowsScanned,
              transactionScanBatches,
              transactionTargetsDiscovered,
              rawPayloadCursorId: state.rawPayloadCursorId,
              scannedRawPages,
              scanBatches,
              targetsFetched,
              targetsSkipped,
              pagesFetched,
              orderRowsCaptured,
            },
          };
        }

        const rawPages = await listFanslyDmRawPayloadsAfterId(app.db, {
          pageId: input.pageContext.page.id,
          afterId: state.rawPayloadCursorId,
          limit: PURCHASE_HISTORY_RAW_BATCH_SIZE,
        });
        scanBatches += 1;
        scannedRawPages += rawPages.length;
        if (rawPages.length === 0) {
          await upsertCheckpoint(app.db, {
            platformAccountId: input.pageContext.page.id,
            stream: "purchase_history",
            cursorTimestamp: new Date(),
            state: {
              ...state,
              pendingTargets: [],
              completedAt: new Date().toISOString(),
            },
            lastSuccessfulRunId: input.syncRunId,
          });
          return {
            satisfied: true,
            yieldReason: null,
            stats: {
              transactionCursorId: state.transactionCursorId,
              transactionRowsScanned,
              transactionScanBatches,
              transactionTargetsDiscovered,
              rawPayloadCursorId: state.rawPayloadCursorId,
              pendingTargets: 0,
              scannedRawPages,
              scanBatches,
              targetsFetched,
              targetsSkipped,
              pagesFetched,
              orderRowsCaptured,
              walkCompleted: true,
            },
          };
        }

        const rawTargets = extractFanslyPurchaseHistoryTargets(
          rawPages.map((row) => row.responsePayload),
        );
        assertFanslyPurchaseHistoryTargetKindsConsistent(
          rawTargets,
          capturedTargetKeys,
        );
        const discovered = rawTargets.filter((target) =>
          !capturedTargetKeys.has(fanslyPurchaseHistoryTargetKey(target)) &&
          !capturedContentIds.has(target.contentId)
        );
        state = {
          ...state,
          version: 4,
          rawPayloadCursorId: rawPages.at(-1)!.id,
          pendingTargets: discovered.map((target) => ({ ...target, before: null })),
        };
        // Advance discovery and persist the whole pending batch BEFORE egress.
        // A worker crash can therefore only replay a safe GET, never lose a
        // discovered media target.
        const progressCheckpoint = await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "purchase_history",
          state,
        });
        await input.telemetry.recordCheckpointAdvanced(
          "purchase_history",
          summarizeCheckpoint(progressCheckpoint),
        );
        if (state.pendingTargets.length === 0) {
          continue;
        }
      }
    }

    const target = state.pendingTargets[0]!;
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    const requestParams = target.kind === "single"
      ? {
        accountMediaId: target.contentId,
        before: target.before,
        limit: FANSLY_PURCHASE_HISTORY_RESULT_LIMIT,
      }
      : {
        accountMediaBundleId: target.contentId,
        before: target.before,
        limit: FANSLY_PURCHASE_HISTORY_RESULT_LIMIT,
      };
    let page: Awaited<ReturnType<AppContext["adapter"]["getMediaOrderHistoryPage"]>>;
    try {
      page = await app.adapter.getMediaOrderHistoryPage(requestContext, requestParams);
    } catch (error) {
      // A deleted media item is target-local. Capture the terminal outcome and
      // move on; auth/rate-limit/server failures and code-99 parameter drift
      // remain stream-level and fail loudly.
      const targetScoped = error instanceof FanslyApiError &&
        typeof error.status === "number" &&
        [404, 410].includes(error.status);
      if (!targetScoped) {
        throw error;
      }
      await persistRawPayload(app.db, {
        platformAccountId: input.pageContext.page.id,
        syncRunId: input.syncRunId,
        endpoint: "purchase_history",
        requestParams,
        responsePayload: {
          error: {
            status: error.status,
            code: error.code ?? null,
          },
        },
        mapperVersion: FANSLY_MAPPER_VERSION,
        payloadKind: "mapping_critical",
        statusCode: error.status,
        errorMessage: error.message,
        retainUntil: retentionDate(),
      }, { action: "capturing rejected purchase_history target", platform: "fansly" });
      const capture = classifyFanslyPurchaseHistoryCapture({
        id: null,
        targetKey,
        requestBefore: target.before,
        statusCode: error.status,
        responsePayload: {
          error: {
            status: error.status,
            code: error.code ?? null,
          },
        },
      });
      if (!capture.terminal || capture.blocked) {
        throw purchaseHistoryCaptureBlockError(capture);
      }
      await input.telemetry.addAnomaly({
        code: "purchase_history_media_rejected",
        severity: "warn",
        message: `Skipped purchase-history media after HTTP ${error.status}`,
        details: {
          mediaKind: target.kind,
          contentId: target.contentId,
          status: error.status,
          fanslyCode: error.code ?? null,
        },
      });
      pagesFetched += 1;
      targetsSkipped += 1;
      capturedTargetKeys.add(targetKey);
      capturedContentIds.add(target.contentId);
      state = { ...state, pendingTargets: state.pendingTargets.slice(1) };
      const progressCheckpoint = await upsertCheckpointProgress(app.db, {
        platformAccountId: input.pageContext.page.id,
        stream: "purchase_history",
        state,
      });
      await input.telemetry.recordCheckpointAdvanced(
        "purchase_history",
        summarizeCheckpoint(progressCheckpoint),
      );
      continue;
    }
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "purchase_history",
      requestParams,
      responsePayload: page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { action: "inserting purchase_history raw payload", platform: "fansly" });

    const capture = classifyFanslyPurchaseHistoryCapture({
      id: null,
      targetKey,
      requestBefore: target.before,
      statusCode: null,
      responsePayload: page.raw,
    });
    if (capture.blocked) {
      // Keep the already-persisted pending target. Every later run reparses
      // this raw fact locally and fails before egress until the parser or data
      // contract is deliberately repaired.
      throw purchaseHistoryCaptureBlockError(capture);
    }

    const orderRows = capture.orderRows!;
    const capturedCursors = capturedRequestCursorsByTargetKey.get(targetKey) ?? new Set<string>();
    capturedCursors.add(target.before ?? "");
    capturedRequestCursorsByTargetKey.set(targetKey, capturedCursors);
    if (
      !capture.terminal &&
      capture.nextBefore !== null &&
      capturedCursors.has(capture.nextBefore)
    ) {
      // The response has already been captured. Leave the checkpoint on the
      // current page so the next run reproduces this blocker locally.
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_cursor_repeated",
        message:
          `Fansly purchase-history cursor cycled back to ${capture.nextBefore}; refusing an unbounded loop`,
      });
    }
    capturedTargetKeys.add(targetKey);
    capturedContentIds.add(target.contentId);
    state = capture.terminal
      ? { ...state, pendingTargets: state.pendingTargets.slice(1) }
      : {
        ...state,
        pendingTargets: [
          { ...target, before: capture.nextBefore! },
          ...state.pendingTargets.slice(1),
        ],
      };
    const progressCheckpoint = await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "purchase_history",
      state,
    });
    await input.telemetry.recordCheckpointAdvanced(
      "purchase_history",
      summarizeCheckpoint(progressCheckpoint),
    );
    pagesFetched += 1;
    if (capture.terminal) {
      targetsFetched += 1;
    }
    orderRowsCaptured += orderRows;
  }

  return {
    satisfied: false,
    yieldReason: input.budget.resolveYieldReason(),
    stats: {
      transactionCursorId: state.transactionCursorId,
      transactionRowsScanned,
      transactionScanBatches,
      transactionTargetsDiscovered,
      rawPayloadCursorId: state.rawPayloadCursorId,
      pendingTargets: state.pendingTargets.length,
      scannedRawPages,
      scanBatches,
      targetsFetched,
      targetsSkipped,
      pagesFetched,
      orderRowsCaptured,
    },
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
