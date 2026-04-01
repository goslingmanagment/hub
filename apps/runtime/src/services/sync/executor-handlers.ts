import {
  assertOwnedPageSyncLease,
  countRecentTerminalDmMessageConversationFailureStreak,
  countActivePageFollows,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  finalizePageDmConversationMessageSync,
  getExistingPageDmMessageIds,
  getPageDmConversationById,
  getCheckpoint,
  getCurrentSubscribers,
  listPageDmConversationsByPlatformConversationIds,
  markPageDmConversationsInvisibleByGeneration,
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  requestPageSync,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  selectNextPageDmMessageSyncCandidate,
  updatePageSyncTimestampCache,
  upsertPageTopSpenders,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertFanPages,
  upsertFans,
  upsertPageFollows,
  upsertPageSubscriptions,
  withOwnedPageSyncTransaction,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type DmSenderRole,
  type MessageCoverageStatus,
  type PageSyncLease,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
  type UpsertPageSubscriptionInput,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  FanslyApiError,
  mapFanslySubscriptionStatus,
  type FanslyAccount,
} from "@agency_hub_core/fansly";
import {
  buildFanslyDmConversationMetadata,
  buildProxyEgressKey,
  fanslyFollowIdToDate,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  getFanslyDmMessageSyncExcludedReason,
  isFanslyDmMessageSyncExcluded,
  toMills,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  type FanslyDmMessageSyncExcludedReason,
  type HttpRequestEvent,
  type HttpRequestObserver,
} from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  resolvePageContextById,
  type ResolvedPageContext,
} from "../page-context.ts";
import { parseFanslyMetadataAccountCreatedAt } from "../fansly.ts";
import { syncOnlyFansTransactions } from "./onlyfans-transactions.ts";
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
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
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
import { lookupHydratedFans, upsertHydratedFansForPage } from "./fan-hydration.ts";
import { syncTransactions } from "./transactions.ts";

type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

const DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD = 3;
const TOP_SPENDERS_STEADY_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_SPENDERS_WINDOW_DAY_MS = 24 * 60 * 60 * 1000;
const TOP_SPENDERS_WINDOW_WEEK_MS = 7 * TOP_SPENDERS_WINDOW_DAY_MS;

function resolveDmConversationCoverageStatus(input: {
  currentMode: "backfill" | "incremental";
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

  if (input.hitWindowCap) {
    return "partial_window";
  }

  return input.existingStatus;
}

function createPageRateLimitWaiter(
  app: AppContext,
  pageContext: ResolvedPageContext,
) {
  return createSyncRateLimitWaiter(app, {
    egressKey: buildProxyEgressKey(pageContext.proxy),
  });
}

export type StreamChunkResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  clearRequestPayload?: boolean;
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
): Promise<FanslyAccountResolution> {
  try {
    const response = await app.adapter.getAccountsByIdsPage(requestContext, [partnerPlatformUserId]);
    if (!Array.isArray(response?.parsed)) {
      return "unknown";
    }
    if (response.parsed.length === 0) {
      return "unresolved";
    }
    return response.parsed.some((account) => account.id === partnerPlatformUserId)
      ? "resolved"
      : "unknown";
  } catch {
    return "unknown";
  }
}

function buildOnlyFansRequestContext(app: AppContext, input: ExecutorRequestContext) {
  if (input.pageContext.platform !== "onlyfans") {
    throw new Error("Expected an OnlyFans page context");
  }

  return {
    auth: input.pageContext.auth,
    proxy: input.pageContext.proxy,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
}

async function triggerFollowersReconcileAnomaly(
  app: AppContext,
  platformAccountId: number,
) {
  await requestPageSync(app.db, {
    pageId: platformAccountId,
    streams: ["followers_reconcile"],
    source: "anomaly",
  });
}

function getFanslyPlatformAccountIdValue(pageContext: ResolvedPageContext) {
  if (pageContext.platform !== "fansly") {
    throw new Error("Expected a Fansly page context");
  }

  const platformAccountId = pageContext.page.platformAccountId ??
    (typeof pageContext.page.metadata["platformAccountId"] === "string"
      ? pageContext.page.metadata["platformAccountId"]
      : null);
  if (!platformAccountId) {
    throw new Error(`Page "${pageContext.page.label}" is missing a Fansly platform account id`);
  }

  return platformAccountId;
}

function assertDmSharedRateLimitEnabled(app: AppContext) {
  if (!app.config.syncSharedRateLimitEnabled) {
    throw new Error("DM sync requires SYNC_SHARED_RATE_LIMIT_ENABLED=true");
  }
}

function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = (content ?? "").trim();
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
    rawValue: number;
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
        platform: "fansly" as const,
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

export async function executeLightChunk(
  app: AppContext,
  input: ExecutorRequestContext,
) {
  await input.telemetry.recordPhaseStarted("page_metadata");
  if (input.pageContext.platform === "fansly") {
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
      username: account.parsed.account.username,
    },
  } satisfies StreamChunkResult;
}

export async function executeTopSpendersChunk(
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

export async function executeTransactionsChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
  await input.telemetry.recordPhaseStarted("transactions");

  if (input.pageContext.platform === "fansly") {
    const result = await syncTransactions(app, {
      pageLabel: input.pageContext.page.label,
      platformAccountId: input.pageContext.page.id,
      commissionRate: input.pageContext.page.commissionRate,
      requestContext: {
        session: input.pageContext.session,
        proxy: input.pageContext.proxy,
        requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
        rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
      },
      syncRunId: input.syncRunId,
      telemetry: input.telemetry,
      activeLease: input.streamState.leaseToken
        ? {
          requestSeq: input.streamState.leasedSeq ?? input.streamState.requestSeq,
          leaseToken: input.streamState.leaseToken,
        }
        : undefined,
    });

    return {
      satisfied: true,
      yieldReason: null,
      stats: result as Record<string, unknown>,
    } satisfies StreamChunkResult;
  }

  const payload = input.streamState.requestPayload;
  const requestedRevision = asNumber(payload?.revision);
  const transactionsStart = requestedRevision === input.streamState.requestSeq &&
      typeof payload?.onlyFansTransactionsStart === "string"
    ? new Date(payload.onlyFansTransactionsStart)
    : null;

  const result = await syncOnlyFansTransactions(app, {
    pageLabel: input.pageContext.page.label,
    platformAccountId: input.pageContext.page.id,
    platformAccountIdValue: String(input.pageContext.page.platformAccountId),
    pageMetadata: input.pageContext.page.metadata,
    commissionRate: input.pageContext.page.commissionRate,
    rescanStart: transactionsStart,
    requestContext: buildOnlyFansRequestContext(app, input),
    syncRunId: input.syncRunId,
    telemetry: input.telemetry,
    budget: input.budget,
  });

  return {
    satisfied: result.satisfied,
    yieldReason: result.yieldReason,
    clearRequestPayload: result.satisfied && Boolean(transactionsStart),
    stats: result as Record<string, unknown>,
  } satisfies StreamChunkResult;
}

export async function executeSubscribersChunk(
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
    });
    const nextState = page.done
      ? state
      : {
        ...state,
        offset: state.offset + 100,
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
          priceMills: toMills(item.price),
          renewPriceMills: toMills(item.renewPrice),
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
            state,
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
      getFanslyPlatformAccountIdValue(input.pageContext),
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
    });

    let reachedBoundary = false;
    const newestFollowId = state.newestFollowId ?? state.knownFollowId;
    const nextState = page.done
      ? state
      : {
        ...state,
        offset: state.offset + 100,
      };
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: page.accounts,
      });

      const followInputs: UpsertPageFollowInput[] = [];
      const fanPageInputs: UpsertFanPageInput[] = [];
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

      if (pageReachedBoundary || page.done) {
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
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
      getFanslyPlatformAccountIdValue(input.pageContext),
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
      };
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: page.accounts,
      });

      const followInputs: UpsertPageFollowInput[] = [];
      const fanPageInputs: UpsertFanPageInput[] = [];
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

      if (page.done) {
        await upsertPageFollows(dbTx, followInputs);
        await upsertFanPages(dbTx, fanPageInputs);
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
            state,
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: followInputs.length,
        };
      }

      await upsertPageFollows(dbTx, followInputs);
      await upsertFanPages(dbTx, fanPageInputs);
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

export async function executeDmConversationsChunk(
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
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_conversations");
  await input.telemetry.recordCheckpointLoaded("dm_conversations", summarizeCheckpoint(checkpoint));

  const pageAccountId = getFanslyPlatformAccountIdValue(input.pageContext);
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
        let shouldClearUnresolvableExclusion = Boolean(
          partnerPlatformUserId && accountsById.has(partnerPlatformUserId),
        );

        if (
          !shouldClearUnresolvableExclusion &&
          partnerPlatformUserId &&
          input.budget.hasRequestCapacity() &&
          input.budget.hasWallClockCapacity()
        ) {
          const resolution = await probeFanslyAccountResolution(
            app,
            requestContext,
            partnerPlatformUserId,
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

      if (
        !existing ||
        existing.lastMessageId !== (conversation.lastMessageId ?? null) ||
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
        lastMessageId: conversation.lastMessageId ?? null,
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
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: [...hydratedAccountsById.values()],
        fallbackIds: [...fallbackPartnerIds],
      });

      for (const conversationWrite of conversationWrites) {
        const fanId = conversationWrite.partnerPlatformUserId && conversationWrite.existingFanId === null
          ? (fanMap.get(conversationWrite.partnerPlatformUserId) ?? null)
          : conversationWrite.existingFanId;
        await upsertPageDmConversation(dbTx, {
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

export async function executeDmMessagesChunk(
  app: AppContext,
  input: ExecutorRequestContext & {
    streamState: PageSyncLease;
    syncRunId: number;
  },
) {
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

  const pageAccountId = getFanslyPlatformAccountIdValue(input.pageContext);
  let processedMessages = 0;
  let completedConversations = 0;
  let overlapHits = 0;
  let exhaustedEligibleConversations = false;

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
        const candidate = await selectNextPageDmMessageSyncCandidate(app.db, {
          platformAccountId: input.pageContext.page.id,
        });
        if (!candidate) {
          exhaustedEligibleConversations = true;
          break;
        }

        conversation = await getPageDmConversationById(app.db, candidate.id);
        if (!conversation) {
          exhaustedEligibleConversations = true;
          break;
        }

        const currentMode = conversation.storedMessageCount === 0
          ? "backfill"
          : conversation.lastMessageId !== conversation.newestStoredMessageId
            ? "incremental"
            : conversation.messageCoverageStatus === "pending_backfill"
              ? "backfill"
              : "incremental";

        state = {
          ...emptyDmMessagesCursorState(),
          currentConversationId: conversation.id,
          currentPlatformConversationId: conversation.platformConversationId,
          currentBeforeMessageId: currentMode === "backfill"
            ? conversation.oldestStoredMessageId
            : null,
          currentMode,
        };
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
              groupId: currentConversation.platformConversationId,
              partnerPlatformUserId: currentConversation.partnerPlatformUserId,
              failureStreak,
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
            conversationId: conversation.id,
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

        const oldestMessageId = page.items.at(-1)?.id ?? null;
        const providerHistoryExhausted = page.done || !oldestMessageId;
        const hitWindowCap =
          currentMode === "backfill" &&
          (currentConversation.storedMessageCount + collectedThisConversation) >= PAGE_DM_MESSAGE_HISTORY_LIMIT;
        const shouldComplete = currentMode === "incremental"
          ? overlapFound || providerHistoryExhausted
          : overlapFound || providerHistoryExhausted || hitWindowCap;

        if (shouldComplete) {
          if (overlapFound) {
            overlapHits += 1;
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
            });
            const progressCheckpoint = await upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "dm_messages",
              state: emptyDmMessagesCursorState(),
            });
            return {
              finalizedConversation,
              progressCheckpoint,
            };
          });
          conversation = finalized.finalizedConversation.conversation;
          completedConversations += 1;
          state = emptyDmMessagesCursorState();
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(finalized.progressCheckpoint),
          );
          break;
        }

        state = {
          ...state,
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

    if (!exhaustedEligibleConversations) {
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
) {
  return resolvePageContextById(app, platformAccountId);
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
) {
  switch (input.streamState.stream) {
    case "light":
      return executeLightChunk(app, input);
    case "top_spenders":
      return executeTopSpendersChunk(app, input);
    case "transactions":
      return executeTransactionsChunk(app, input);
    case "subscribers":
      return executeSubscribersChunk(app, input);
    case "dm_conversations":
      return executeDmConversationsChunk(app, input);
    case "dm_messages":
      return executeDmMessagesChunk(app, input);
    case "followers":
      return executeFollowersChunk(app, input);
    case "followers_reconcile":
      return executeFollowersReconcileChunk(app, input);
    default:
      throw new Error(`Unsupported executor stream "${input.streamState.stream}"`);
  }
}
