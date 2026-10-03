import {
  buildFanslySubscriptionRows,
  expectedFollowersReconcileTerminalPageCount,
  findUnmappedFollowerIds,
  FOLLOWERS_RECONCILE_MAX_SNAPSHOT_RESTARTS,
  FOLLOWERS_RECONCILE_PAGE_SIZE,
  FOLLOWERS_RECONCILE_RETRY_DELAY_MS,
  isStatedEmptyActiveSnapshot,
  SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS,
  SUBSCRIBERS_EMPTY_SNAPSHOT_MAX_RETIREMENTS,
  SUBSCRIBERS_MAX_WALK_RESTARTS,
  SUBSCRIBERS_WALK_RESTART_DELAY_MS,
  uniqueFollowerIds,
} from "../../sync/fansly/lib/audience-rules.ts";
import { readFollowersReconcileCompletion } from "./followers-reconcile-completion.ts";
import {
  buildTopSpendersBootstrapState,
  computeCompletedTopSpenderMonths,
  parseTopSpendersCursorState,
  partitionTopSpenderItems,
  TOP_SPENDERS_STEADY_STATE_WINDOW_MS,
  type TopSpendersCursorState,
} from "../../sync/fansly/lib/money-rules.ts";
import { followersReconcileDecision } from "../../sync/fansly/lib/followers-reconcile-decision.ts";
import { FOLLOWERS_RECONCILE_FLOOR_DEFERRAL, followersReconcileFloor } from "./followers-reconcile-floor.ts";
import {
  aggregateTransactionTopSpenders,
  assertOwnedPageSyncLease,
  clearConversationSyncHealth,
  countOtherDmMessageGroupsFailingSinceLastSuccess,
  countRecentTerminalDmMessageConversationFailureStreak,
  countActivePageFollows,
  countCurrentPageSubscriptionsByGeneration,
  countPageFollowsByGeneration,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  retireLapsedPageSubscriptionsForEmptySnapshot,
  finalizePageDmConversationMessageSync,
  recordFanslyDmHeadAttempt,
  getFanslyDmHeadTarget,
  nextFanslyDmHeadRetryAt,
  getEarliestSpenderTransactionAt,
  getPageDmConversationById,
  getCheckpoint,
  getConversationSyncHealth,
  countConversationSyncFailuresByAccount,
  getPageSyncExecutionContext,
  getPageDmOnboardedAt,
  getCurrentSubscribers,
  maxPageFollowGeneration,
  maxPageSubscriptionGeneration,
  nextConversationSyncBackoffRetryAt,
  PAGE_DM_LIVE_BACKFILL_CAP,
  PAGE_DM_NEW_THREAD_EXTRA_HISTORY_PAGES,
  PageSyncLeaseLostError,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordConversationSyncFailure,
  recordProjectionDebt,
  requestPageSync,
  readPageFollowReconcileActivity,
  readPageFollowDeactivationGenerationBuckets,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  selectNextPageDmMessageDeepBackfillCandidate,
  selectNextPageDmMessageSyncCandidate,
  updatePageSyncTimestampCache,
  upsertArchivedPageSubscriptions,
  upsertPageTopSpenders,
  upsertCheckpoint,
  upsertCheckpointProgress,
  excludePageDmConversationMessageSync,
  upsertPageDmMessages,
  upsertFanPages,
  upsertFanPageExternalPresences,
  upsertFans,
  upsertPageFollows,
  upsertPageSubscriptions,
  withOwnedPageSyncTransaction,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type EmptySnapshotSubscriptionRetirement,
  type PageDmConversationRow,
  type PageSyncLease,
  type SyncStream,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  FanslyApiError,
  type FanslyAccount,
  type FanslyFollower,
} from "@agency_hub_core/fansly";
import {
  compareFanslyFollowIds,
  fanslyFollowIdToDate,
  isFanslyDmMessageSyncExcluded,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

import type { CanonicalStream } from "@agency_hub_core/platform-core";

import { appPlatformRegistry } from "../../platforms/registry.ts";
import type { AppContext } from "../../bootstrap.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { isPageAllowlisted } from "./fansly-stream-gate.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import {
  resolvePageContextById,
  type ResolvedPageContext,
} from "../page-context.ts";
import { resolveFanslyPlatformAccountId } from "../fansly.ts";
import { buildFanslyFollowerPresenceSignals } from "../fansly-presence.ts";
import {
  summarizeCheckpoint,
  type DmMessagesChunkSummary,
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  asNumber,
  asRecord,
  emptyDmMessagesCursorState,
  parseDmMessagesCursorState,
  parseFollowersCursorState,
  parseFollowersReconcileCursorState,
  parseSubscribersCursorState,
  type DmMessagesCursorState,
  type FollowersCursorState,
  type FollowersReconcileCursorState,
  type SubscribersCursorState,
} from "./cursor-state.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
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
import { spreadFanslyContinuation } from "./fansly-lane.ts";
import { isOnlyFansTopSpendersEnabled } from "./onlyfans-top-spenders.ts";
import {
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
} from "./shared.ts";
import {
  captureFanslyFollowerPayload,
  FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
} from "../../sync/fansly/lib/capture-trims.ts";
import {
  assertDmSharedRateLimitEnabled,
  DM_MESSAGES_BREAKER_OUTAGE_LOOKBACK_MS,
  DM_MESSAGES_BREAKER_OUTAGE_OTHER_FAILING_GROUPS,
  DmMessagesChunkRequestObserver,
  FANSLY_DM_MESSAGE_PAGE_LIMIT,
  fetchAndJournalFanslyDmMessagePage,
  isDmHeadStaleByTime,
  isDmMessagePageAfterOnboarding,
  isThreadAttributableFanslyFailure,
  resolveDmConversationCoverageStatus,
} from "./fansly-dm-messages.ts";
import { probeFanslyAccountResolution } from "./fansly-account-probe.ts";
import { upsertHydratedFansForPage } from "../../sync/fansly/lib/fan-hydration.ts";
import { lookupHydratedFans, type HydrationCaptureContext } from "./fan-hydration.ts";
import { FollowersReconcileConsistencyError } from "./errors.ts";
import {
  followersReconcileDeactivationLimit,
} from "../../sync/fansly/lib/followers-reconcile-safety.ts";

// Kept exported from here for the modules and the platform registry that
// already import them from this file; both now live in executor-types.ts so a
// handler module can be a leaf.
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";
import { runFanslyWsHintStep } from "./fansly-ws-hints.ts";
import { runAiMediaAcceleratorStep } from "./ai-media-accelerator.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";
export type { ExecutorRequestContext, StreamChunkResult };

const DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD = 3;
// The deferral (or, with nothing left to wait for, quality hold) of a
// dm_messages chunk whose only work was threads the breaker deferred.
const FANSLY_DM_THREADS_DEFERRED = "fansly_dm_threads_deferred";

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

function isTerminalFanslyServerError(error: unknown): error is FanslyApiError & { status: number } {
  return error instanceof FanslyApiError &&
    typeof error.status === "number" &&
    error.status >= 500 &&
    error.status < 600;
}

/** A partner-account probe failure that speaks for the page, not the partner:
 * auth (401/403), a rate limit (429) or a provider Retry-After deadline. It
 * fails the stream with its own classification and deadline before the
 * thread is deferred; carrying on to other threads would walk straight into
 * the same refusal. */
function isPageLevelFanslyProbeFailure(error: unknown): error is FanslyApiError {
  return error instanceof FanslyApiError &&
    (error.status === 401 || error.status === 403 || error.status === 429 || error.retryAfterAt !== null);
}

async function triggerFollowersReconcileAnomaly(
  app: AppContext,
  platformAccountId: number,
) {
  const receipts = await requestPageSync(app.db, {
    pageId: platformAccountId,
    streams: ["followers_reconcile"],
    source: "anomaly",
    includeQueueState: true,
    // A mid-sweep bump would restart the sweep from offset zero and reset its
    // snapshot-restart bound; the outstanding revision already reconciles.
    coalesceOutstanding: true,
    ...pageSyncDependencyInput(app),
  });
  return receipts?.find(row => row.stream === "followers_reconcile") ?? null;
}

type FollowerMappingStream = "followers" | "followers_reconcile";

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
  // A missing id looked up through the page within the day is not asked
  // again; the caller maps it from its stored fan row.
  const fallbackHydration = missingAggregationIds.length > 0
    ? await lookupHydratedFans(app, {
      requestContext: input.requestContext,
      platformAccountId: input.capture.platformAccountId,
      platformUserIds: missingAggregationIds,
      telemetry: input.telemetry,
      capture: input.capture,
    })
    : {
      accounts: [] satisfies FanslyAccount[],
      fallbackIds: [] as string[],
      reusedIds: [] as string[],
      lookup: null,
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
        fallbackLookupsReused: fallbackHydration.reusedIds.length,
        examples: missingAggregationIds.slice(0, 5),
      },
    });
  }

  return {
    sourceFollowerIds,
    accounts: Array.from(hydratedAccountsById.values()),
    fallbackIds,
    reusedIds: fallbackHydration.reusedIds,
    lookup: fallbackHydration.lookup,
  };
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

async function upsertTopSpendersWindow(
  app: AppContext,
  input: {
    platformAccountId: number;
    // Platform the correlation ids belong to when creating fan rows.
    platform: "fansly" | "onlyfans";
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

  const {
    valid: validItems,
    skippedCount,
    skippedExamples: skippedIdentityExamples,
  } = partitionTopSpenderItems(input.items);

  if (skippedIdentityExamples.length > 0) {
    await input.telemetry.addAnomaly({
      code: "top_spenders_missing_identity",
      severity: "warn",
      message: "Skipped top spender rows missing both correlationAccountId and accountId",
      details: {
        skippedCount,
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
        platform: input.platform,
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
    gatedSkip: "onlyfans_top_spenders_disabled",
  } satisfies StreamChunkResult;
}

/**
 * top_spenders for OnlyFans pages (docs/ofapi-parity-plan.md Phase 5, D10):
 * the same month-window bootstrap + trailing-7-day steady state as the Fansly
 * Sync Engine's `top-spenders` resource, but
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
    gatedSkip: "onlyfans_transactions_webhook_sourced",
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

type SubscribersWalkRestartReason = "total_changed" | "partial_result" | "offset_duplicates";

/** Rewalk from offset zero under the same request revision. */
async function subscribersWalkRestartState(
  db: Parameters<typeof maxPageSubscriptionGeneration>[0],
  platformAccountId: number,
  state: SubscribersCursorState,
): Promise<SubscribersCursorState> {
  const walk = {
    offset: 0,
    observedCount: 0,
    distinctObservedCount: 0,
    pageCount: 0,
    providerReportedTotal: null,
    restartCount: state.restartCount + 1,
  };
  if (state.mode === "expired") {
    // The active walk already finalized; only the archive-only history is reread.
    return { ...state, ...walk };
  }
  // A fresh generation keeps rows stamped by the abandoned walk from counting
  // as seen, and a fresh start keeps them from counting as touched mid-walk.
  const storedGeneration = await maxPageSubscriptionGeneration(db, platformAccountId);
  return {
    ...state,
    ...walk,
    generation: Math.max(state.generation, storedGeneration) + 1,
    walkStartedAt: new Date().toISOString(),
  };
}

/**
 * A cursor written before the walk-start fence cannot say when its active
 * walk began. One still at offset zero has stamped nothing it could vouch for,
 * so its fence starts now, before the read. One already past the first page
 * rewalks from offset zero under a fresh generation and fence rather than
 * guess. Neither is a provider anomaly, so the bounded restart allowance is
 * untouched; the fenced state persists with the walk's next page write.
 */
async function fenceLegacySubscribersWalk(
  db: Parameters<typeof maxPageSubscriptionGeneration>[0],
  platformAccountId: number,
  state: SubscribersCursorState,
): Promise<SubscribersCursorState> {
  const walkStartedAt = new Date().toISOString();
  if (state.offset === 0) {
    return { ...state, walkStartedAt };
  }
  const storedGeneration = await maxPageSubscriptionGeneration(db, platformAccountId);
  return {
    ...state,
    generation: Math.max(state.generation, storedGeneration) + 1,
    walkStartedAt,
    offset: 0,
    observedCount: 0,
    distinctObservedCount: 0,
    pageCount: 0,
    providerReportedTotal: null,
  };
}

/**
 * Until an active walk has written a page, nothing carries its generation, so
 * its start can move up to each read: every row touched before that read is
 * one the read could observe (Audit P-25). Retries of a failed or yielded
 * first read keep the same revision and cursor; judged against the first
 * attempt's start, a subscription that lapsed in between would never count as
 * lapsed and a stated zero would be refused for good. The moved start
 * persists with the walk's first page write.
 */
function refreshUnreadSubscribersWalkStart(state: SubscribersCursorState): SubscribersCursorState {
  const unread = state.mode === "active" &&
    state.offset === 0 &&
    state.pageCount === 0 &&
    state.observedCount === 0;
  return unread ? { ...state, walkStartedAt: new Date().toISOString() } : state;
}

/** Rows touched at or after this instant survive the walk's finalization. */
function subscribersWalkFence(state: SubscribersCursorState) {
  if (state.walkStartedAt === null) {
    throw new Error("Subscriber walk has no start fence; refusing destructive finalization");
  }
  return new Date(state.walkStartedAt);
}

/** The stats trail of a revision whose walks could not be certified past the restart bound. */
function subscribersWithheldStats(
  state: Pick<SubscribersCursorState, "activeWithheldReason" | "historyWithheldReason">,
) {
  return {
    ...(state.activeWithheldReason === undefined ? {} : {
      destructiveFinalization: false,
      finalizationWithheld: true,
      withheldReason: state.activeWithheldReason,
    }),
    ...(state.historyWithheldReason === undefined ? {} : {
      historyCertified: false,
      historyWithheldReason: state.historyWithheldReason,
    }),
  };
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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "subscribers");
  await input.telemetry.recordCheckpointLoaded("subscribers", summarizeCheckpoint(checkpoint));

  const existingState = parseSubscribersCursorState(checkpoint?.state, input.streamState.requestSeq);
  // Only a withheld active completion leaves an active state with a withheld
  // reason, and it closes its revision. Re-reading its last page on a replay
  // could certify the walk and retire the rows it never served.
  if (existingState?.mode === "active" && existingState.activeWithheldReason !== undefined) {
    return {
      satisfied: true,
      yieldReason: null,
      stats: {
        generation: existingState.generation,
        mode: existingState.mode,
        pageCount: existingState.pageCount,
        processedThisChunk: 0,
        providerReportedTotal: existingState.providerReportedTotal,
        ...subscribersWithheldStats(existingState),
      },
    } satisfies StreamChunkResult;
  }
  const previousCheckpointState = asRecord(checkpoint?.state);
  const previousGeneration = asNumber(previousCheckpointState?.generation) ?? 0;
  const previousHistoryBackfilledAt = typeof previousCheckpointState?.historyBackfilledAt === "string"
    ? previousCheckpointState.historyBackfilledAt
    : null;
  let state: SubscribersCursorState;
  if (existingState) {
    state = existingState.mode === "active" && existingState.walkStartedAt === null
      ? await fenceLegacySubscribersWalk(app.db, input.pageContext.page.id, existingState)
      : existingState;
  } else {
    const walkStartedAt = new Date().toISOString();
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
      distinctObservedCount: 0,
      pageCount: 0,
      providerReportedTotal: null,
      restartCount: 0,
      walkStartedAt,
    };
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "subscribers",
      state,
    });
  }

  let processedThisChunk = 0;
  const restartWalk = async (
    walk: SubscribersCursorState,
    reason: SubscribersWalkRestartReason,
    restartState: SubscribersCursorState,
    checkpoint: Awaited<ReturnType<typeof upsertCheckpointProgress>>,
  ) => {
    await input.telemetry.recordCheckpointAdvanced("subscribers", summarizeCheckpoint(checkpoint));
    return {
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: spreadFanslyContinuation(new Date(), SUBSCRIBERS_WALK_RESTART_DELAY_MS),
      continuationRequestSource: "scheduled",
      stats: {
        generation: restartState.generation,
        mode: walk.mode,
        pageCount: walk.pageCount,
        processedThisChunk,
        restartCount: restartState.restartCount,
        restartReason: reason,
        destructiveFinalization: false,
      },
    } satisfies StreamChunkResult;
  };

  // A non-empty subscribers page is followed by one batched account lookup.
  // Reserve both calls so a chunk never starts a page it cannot hydrate.
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    state = refreshUnreadSubscribersWalkStart(state);
    const status = state.mode === "active" ? "3,4" : "5";
    const page = await app.adapter.getSubscribersPage(
      requestContext,
      { limit: 100, offset: state.offset, status },
    );
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "subscribers",
      requestParams: { offset: state.offset, limit: 100, status },
      responsePayload: page.contractAccepted === false
        ? { contractAccepted: false, raw: page.raw }
        : page.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting subscribers raw payload",
      platform: "fansly",
    });

    if (page.contractAccepted === false) {
      throw new Error("Fansly subscribers response contract rejected; captured before refusal");
    }
    // Offsets index one provider snapshot. A shifted total moves rows between
    // pages already read and pages still ahead, so this walk can no longer be
    // certified; resuming at the same offset against the first total never
    // converges. Restart it, bounded, before spending the account lookup.
    const pageTotal = page.total ?? null;
    const totalChanged = state.providerReportedTotal !== null && pageTotal !== state.providerReportedTotal;
    if (totalChanged) {
      await input.telemetry.addAnomaly({
        code: "subscribers_total_changed",
        severity: "warn",
        message: "Subscriber total changed during an offset walk; the walk cannot certify membership",
        details: {
          mode: state.mode,
          previousTotal: state.providerReportedTotal,
          currentTotal: pageTotal,
          offset: state.offset,
          pageCount: state.pageCount,
          restartCount: state.restartCount,
        },
      });
      if (state.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
        const restartState = await subscribersWalkRestartState(app.db, input.pageContext.page.id, state);
        return restartWalk(state, "total_changed", restartState, await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: restartState,
        }));
      }
    }
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      providerReportedTotal: totalChanged ? pageTotal : state.providerReportedTotal ?? pageTotal,
    };

    // An empty first page vouches for nothing unless the provider states the
    // zero outright; even then the finalization transaction retires only the
    // small, already-lapsed membership it can explain or a membership a fresh
    // zero account counter confirms, or refuses.
    const statedEmptySnapshot = isStatedEmptyActiveSnapshot(state, page, totalChanged);
    if (!statedEmptySnapshot && state.mode === "active" && state.offset === 0 && page.items.length === 0) {
      const currentSubscribers = await getCurrentSubscribers(app.db, input.pageContext.page.id);
      if (currentSubscribers.rows.length > 0) {
        await input.telemetry.addAnomaly({
          code: "subscribers_empty_first_page_guard",
          severity: "warn",
          message: "Subscriber sync returned zero rows on the first page while current subscriptions already exist",
          details: {
            existingCurrentSubscribers: currentSubscribers.rows.length,
            reason: "zero_not_stated",
          },
        });
        throw new Error("Subscriber sync returned zero rows; refusing destructive finalization");
      }
    }

    const finalObservedCount = state.observedCount + page.items.length;
    const partialResult = !totalChanged && page.done && state.providerReportedTotal !== null &&
      finalObservedCount !== state.providerReportedTotal;
    if (partialResult) {
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
      // One response is one snapshot, and its retry re-reads it from offset
      // zero. A multi-page walk would resume at this offset forever instead.
      if (state.pageCount === 1) {
        throw new Error("Subscriber sync returned a partial result; refusing destructive finalization");
      }
      if (state.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
        const restartState = await subscribersWalkRestartState(app.db, input.pageContext.page.id, state);
        return restartWalk(state, "partial_result", restartState, await upsertCheckpointProgress(app.db, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: restartState,
        }));
      }
    }
    // Past the restart bound, keep what this walk saw and retire nothing.
    const withheldReason: SubscribersWalkRestartReason | null = totalChanged
      ? "total_changed"
      : partialResult ? "partial_result" : null;
    if (state.mode === "expired" && withheldReason !== null) {
      // The archive is walked only once and its writes retire nothing, so
      // stopping here would leave the rest of it unread for good. Adopt the
      // new total and read on to the end; the completion stays uncertified.
      state = { ...state, historyWithheldReason: state.historyWithheldReason ?? withheldReason };
    }
    // An active walk stops at the page it cannot certify; the next revision
    // walks the current list again.
    const lastPage = page.done || (state.mode === "active" && withheldReason !== null);

    const hydratedFans = await lookupHydratedFans(app, {
      requestContext,
      platformAccountId: input.pageContext.page.id,
      platformUserIds: page.items.map((item) => item.subscriberId),
      telemetry: input.telemetry,
      capture: { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
    });
    const pageDistinctCount = new Set(page.items.map((item) => item.id)).size;
    const nextPageState = lastPage
      ? state
      : {
        ...state,
        offset: state.offset + 100,
        observedCount: state.observedCount + page.items.length,
        distinctObservedCount: state.distinctObservedCount + pageDistinctCount,
      };

    const shouldBackfillHistory =
      state.mode === "active" &&
      lastPage &&
      state.historyBackfilledAt === null;
    const historyState: SubscribersCursorState = {
      ...state,
      mode: "expired",
      offset: 0,
      observedCount: 0,
      distinctObservedCount: 0,
      pageCount: 0,
      providerReportedTotal: null,
      restartCount: 0,
    };

    // Asserted, not annotated: assigned inside the transaction callback, which
    // an annotated `null` initializer would narrow away.
    let emptySnapshotRetirement = null as Extract<EmptySnapshotSubscriptionRetirement, { certified: true }> | null;
    const pageWrite = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
      emptySnapshotRetirement = null;
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: input.pageContext.page.id,
        accounts: hydratedFans.accounts,
        fallbackIds: hydratedFans.fallbackIds,
        reusedIds: hydratedFans.reusedIds,
        lookup: hydratedFans.lookup,
      });

      const { subscriptions: subscriptionInputs, fanPages: fanPageInputs } = buildFanslySubscriptionRows({
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
        mode: state.mode,
        items: page.items,
        fanMap,
      });

      if (state.mode === "active") {
        await upsertPageSubscriptions(dbTx, subscriptionInputs);
        await upsertFanPages(dbTx, fanPageInputs);
      } else {
        await upsertArchivedPageSubscriptions(dbTx, subscriptionInputs);
      }

      if (state.mode === "active" && lastPage) {
        let finalWithheldReason: SubscribersWalkRestartReason | null = withheldReason;
        let membership: { generationCurrentCount: number; expectedCount: number } | null = null;
        if (finalWithheldReason === null && state.pageCount > 1) {
          // Summed page lengths cannot tell a row served on two pages from two
          // rows, and such an overlap leaves a current row unseen. Rows stamped
          // with this generation are the distinct subscriptions the walk saw.
          const generationCurrentCount = await countCurrentPageSubscriptionsByGeneration(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
          });
          const expectedCount = state.distinctObservedCount + pageDistinctCount;
          if (generationCurrentCount < expectedCount) {
            membership = { generationCurrentCount, expectedCount };
            if (state.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
              const restartState = await subscribersWalkRestartState(dbTx, input.pageContext.page.id, state);
              return {
                kind: "restart" as const,
                restartState,
                membership,
                checkpoint: await upsertCheckpointProgress(dbTx, {
                  platformAccountId: input.pageContext.page.id,
                  stream: "subscribers",
                  state: restartState,
                }),
                processedThisPage: subscriptionInputs.length,
              };
            }
            finalWithheldReason = "offset_duplicates";
          }
        }
        if (finalWithheldReason === null && statedEmptySnapshot) {
          // The assessment and the retirement act on one locked set.
          const walkStartedAt = subscribersWalkFence(state);
          const retirement = await retireLapsedPageSubscriptionsForEmptySnapshot(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
            walkStartedAt,
            maxRetirements: SUBSCRIBERS_EMPTY_SNAPSHOT_MAX_RETIREMENTS,
            counterVerifiedSince: new Date(walkStartedAt.getTime() - SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS),
          });
          if (!retirement.certified) {
            return { kind: "empty_refused" as const, retirement };
          }
          emptySnapshotRetirement = retirement;
        } else if (finalWithheldReason === null) {
          await deactivatePageSubscriptionsByGeneration(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
            lastSeenBefore: subscribersWalkFence(state),
          });
        }
        await refreshFanPageSubscriberState(dbTx, input.pageContext.page.id);
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        const withheldState = finalWithheldReason === null ? {} : { activeWithheldReason: finalWithheldReason };
        if (shouldBackfillHistory) {
          const nextState: SubscribersCursorState = { ...historyState, ...withheldState };
          return {
            kind: "progress" as const,
            nextState,
            membership,
            checkpoint: await upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "subscribers",
              state: nextState,
            }),
            processedThisPage: subscriptionInputs.length,
          };
        }
        return {
          kind: "complete" as const,
          withheld: withheldState,
          membership,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "subscribers",
            state: {
              ...state,
              observedCount: finalObservedCount,
              ...withheldState,
              ...(finalWithheldReason === null ? {} : { destructiveFinalization: false }),
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: subscriptionInputs.length,
        };
      }

      if (state.mode === "expired" && lastPage) {
        const historyBackfilledAt = new Date().toISOString();
        await rebuildSubscriberRollups(dbTx, input.pageContext.page.id);
        return {
          kind: "complete" as const,
          withheld: state,
          membership: null,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "subscribers",
            state: {
              ...state,
              observedCount: finalObservedCount,
              historyBackfilledAt,
              // This revision's active walk retired nothing.
              ...(state.activeWithheldReason === undefined ? {} : { destructiveFinalization: false }),
              // Archive writes are non-destructive, so an uncertified history
              // walk still closes instead of re-walking the archive every hour.
              ...(state.historyWithheldReason === undefined ? {} : { historyCertified: false }),
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          processedThisPage: subscriptionInputs.length,
        };
      }

      return {
        kind: "progress" as const,
        nextState: nextPageState,
        membership: null,
        checkpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "subscribers",
          state: nextPageState,
        }),
        processedThisPage: subscriptionInputs.length,
      };
    });
    if (pageWrite.kind === "empty_refused") {
      await input.telemetry.addAnomaly({
        code: "subscribers_empty_first_page_guard",
        severity: "warn",
        message: "Subscriber sync returned zero rows on the first page while current subscriptions already exist",
        details: {
          existingCurrentSubscribers: pageWrite.retirement.currentCount,
          reason: pageWrite.retirement.reason,
          ...(pageWrite.retirement.counter === undefined ? {} : {
            subscriberCount: pageWrite.retirement.counter.subscriberCount,
            lastVerifiedAt: pageWrite.retirement.counter.lastVerifiedAt?.toISOString() ?? null,
          }),
        },
      });
      throw new Error("Subscriber sync returned zero rows; refusing destructive finalization");
    }
    if (emptySnapshotRetirement !== null) {
      const { counter, retiredCount } = emptySnapshotRetirement;
      if (counter === undefined) {
        await input.telemetry.addNote("Fansly subscribers stated-empty snapshot certified", {
          code: "subscribers_empty_snapshot_certified",
          generation: state.generation,
          walkStartedAt: state.walkStartedAt,
          retiredCount,
        });
      } else {
        await input.telemetry.addNote("Fansly subscribers stated-empty snapshot confirmed by the account counter", {
          code: "subscribers_empty_snapshot_confirmed_by_counter",
          generation: state.generation,
          walkStartedAt: state.walkStartedAt,
          retiredCount,
          subscriberCount: counter.subscriberCount,
          lastVerifiedAt: counter.lastVerifiedAt?.toISOString() ?? null,
        });
      }
    }
    processedThisChunk += pageWrite.processedThisPage;

    if (pageWrite.membership) {
      await input.telemetry.addAnomaly({
        code: "subscribers_offset_duplicates",
        severity: "warn",
        message: "Subscriber offset walk saw fewer distinct subscriptions than rows served; refusing destructive finalization",
        details: {
          generation: state.generation,
          generationCurrentCount: pageWrite.membership.generationCurrentCount,
          expectedCount: pageWrite.membership.expectedCount,
          pageCount: state.pageCount,
          restartCount: state.restartCount,
        },
      });
    }
    if (pageWrite.kind === "restart") {
      return restartWalk(state, "offset_duplicates", pageWrite.restartState, pageWrite.checkpoint);
    }
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
          ...subscribersWithheldStats(pageWrite.withheld),
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
          ...subscribersWithheldStats(state),
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
      ...subscribersWithheldStats(state),
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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
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
  let crossedKnownBoundary = false;

  while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const page = await app.adapter.getFollowersPage(
      requestContext,
      resolveFanslyPlatformAccountId(input.pageContext.page),
      {
        offset: state.offset,
        limit: 100,
      },
    );
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: { offset: state.offset, limit: 100, mode: "incremental" },
      responsePayload: captureFanslyFollowerPayload(page.raw, page.contractAccepted),
      mapperVersion: FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
      platform: "fansly",
    });

    if (page.contractAccepted === false) {
      throw new Error("Fansly followers response contract rejected; captured before refusal");
    }
    state = {
      ...state,
      pageCount: state.pageCount + 1,
      newestFollowId: state.newestFollowId ?? page.items[0]?.id ?? null,
    };

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
        reusedIds: hydratedFollowers.reusedIds,
        lookup: hydratedFollowers.lookup,
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
      let pageCrossedKnownBoundary = false;
      let pageReachedBoundary = false;

      for (const follower of page.items) {
        if (state.knownFollowId && follower.id === state.knownFollowId) {
          pageSawKnownCheckpoint = true;
          pageReachedBoundary = true;
          break;
        }
        // Rows descend by follow id and every follow, a re-follow too, gets a
        // new larger id. A row older than the known one means that row is gone
        // and the rest of the list predates the last walk; the reconcile owns
        // it. Skip rather than stop, so a newer row out of order still lands.
        if (state.knownFollowId && compareFanslyFollowIds(follower.id, state.knownFollowId) === -1) {
          pageCrossedKnownBoundary = true;
          pageReachedBoundary = true;
          continue;
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
          crossedKnownBoundary: pageCrossedKnownBoundary,
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
        crossedKnownBoundary: pageCrossedKnownBoundary,
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
    crossedKnownBoundary ||= pageWrite.crossedKnownBoundary;

    if (pageWrite.kind === "complete") {
      await input.telemetry.recordCheckpointAdvanced("followers", summarizeCheckpoint(pageWrite.checkpoint));

      const activeFollowerCount = await countActivePageFollows(app.db, input.pageContext.page.id);
      const decision = followersReconcileDecision({
        activeFollowerCount, sourceFollowerCount: state.sourceFollowerCount,
        knownFollowId: state.knownFollowId, newestFollowId,
        pageDone: page.done, crossedKnownBoundary, sawKnownCheckpoint, processedThisChunk,
      });
      const receipt = decision.requested
        ? await triggerFollowersReconcileAnomaly(app, input.pageContext.page.id)
        : null;
      // This receipt describes a settled decision, including the no-request case.
      // Telemetry persistence is fail-open; it cannot change the follower walk.
      await input.telemetry.addNote("Fansly followers reconcile decision", {
        followersReconcile: {
          schemaVersion: 1, ...decision,
          counts: { activeFollowerCount, sourceFollowerCount: state.sourceFollowerCount,
            pageCount: state.pageCount, processedThisChunk },
          knownCheckpoint: Boolean(state.knownFollowId), pageDone: page.done,
          requestedSeq: receipt?.requestedSeq ?? null, queueBefore: receipt?.queueBefore ?? null,
          coalesced: receipt?.coalesced === true,
        },
      });

      return {
        satisfied: true,
        yieldReason: null,
        stats: {
          pageCount: state.pageCount,
          processedThisChunk,
          sourceFollowerCount: state.sourceFollowerCount,
          sawKnownCheckpoint,
          crossedKnownBoundary,
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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "followers_reconcile");
  await input.telemetry.recordCheckpointLoaded("followers_reconcile", summarizeCheckpoint(checkpoint));
  const effective = await loadEffectiveConfig(app.db, app.config);
  const execution = getPageSyncExecutionContext();
  const settlementReuseEnabled = effective.fanslyFollowersSettlementReuseEnabled === true &&
    isPageAllowlisted(effective.fanslyFollowersSettlementReusePageAllowlist, pageContext.page.label) &&
    execution?.pageId === pageContext.page.id && execution.stream === "followers_reconcile";
  const completion = settlementReuseEnabled && execution
    ? readFollowersReconcileCompletion(checkpoint, execution.requestSeq, new Date()) : null;
  if (completion) {
    await assertOwnedPageSyncLease(app.db);
    return { satisfied: true, yieldReason: null, ...completion } satisfies StreamChunkResult;
  }

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
    // A fresh walk waits out the daily floor with no request and no checkpoint
    // write. The request stays outstanding behind retry_at, where hourly
    // mismatches fold into it, and is served when the floor ends.
    const floor = followersReconcileFloor({
      checkpointState: checkpoint?.state,
      requestSeq: input.streamState.requestSeq,
      requestSource: input.streamState.requestSource ?? null,
      succeededAt: input.streamState.succeededAt ?? null,
      now: new Date(),
    });
    if (floor) {
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: floor.until,
        continuationRequestSource: "scheduled",
        deferral: FOLLOWERS_RECONCILE_FLOOR_DEFERRAL,
        stats: {
          followersReconcileFloorUntil: floor.until.toISOString(),
          followersReconcileFloorAnchor: floor.anchor.toISOString(),
        },
      } satisfies StreamChunkResult;
    }

    const fullSweepStartedAt = new Date().toISOString();
    const accountMe = await refreshPageMetadata(app, input.pageContext, undefined, input.telemetry);
    const storedGeneration = await maxPageFollowGeneration(app.db, input.pageContext.page.id);
    state = {
      revision: input.streamState.requestSeq,
      generation: Math.max(previousGeneration, storedGeneration) + 1,
      fullSweepStartedAt,
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
      const fullSweepStartedAt = new Date(state.fullSweepStartedAt);
      const activity = await readPageFollowReconcileActivity(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
        fullSweepStartedAt,
      });
      const expectedTerminalPageCount = expectedFollowersReconcileTerminalPageCount(
        state.observedCount,
      );
      const terminalPageShapeComplete = state.pageCount === expectedTerminalPageCount;
      const terminalDelta = finalizationFollowerCount - generationObservedCount;
      const explainedByNewFollowers = terminalDelta > 0
        && terminalPageShapeComplete
        && state.observedCount >= generationObservedCount
        && terminalDelta === activity.firstSeenDuringSweepOutsideGeneration;
      const membershipProof = generationObservedCount === finalizationFollowerCount
        ? "exact_generation" as const
        : explainedByNewFollowers
          ? "new_followers_seen_during_sweep" as const
          : null;

      if (membershipProof === null) {
        if (state.snapshotRestartCount < FOLLOWERS_RECONCILE_MAX_SNAPSHOT_RESTARTS) {
          return {
            kind: "restart" as const,
            checkpoint: await upsertCheckpointProgress(dbTx, {
              platformAccountId: input.pageContext.page.id,
              stream: "followers_reconcile",
              state: {
                revision: state.revision,
                generation: state.generation,
                snapshotRestartCount: state.snapshotRestartCount + 1,
                restartReason: "snapshot_mismatch",
                verificationPending: false,
              },
            }),
            generationObservedCount,
            finalizationFollowerCount,
            expectedTerminalPageCount,
            terminalPageShapeComplete,
            terminalDelta,
            ...activity,
          };
        }

        await rebuildFollowerRollups(
          dbTx,
          input.pageContext.page.id,
          finalizationFollowerCount,
        );
        return {
          kind: "non_destructive_complete" as const,
          checkpoint: await upsertCheckpoint(dbTx, {
            platformAccountId: input.pageContext.page.id,
            stream: "followers_reconcile",
            state: {
              revision: state.revision,
              generation: state.generation,
              fullSweepStartedAt: state.fullSweepStartedAt,
              observedCount: state.observedCount,
              pageCount: state.pageCount,
              sourceFollowerCount: finalizationFollowerCount,
              generationObservedCount,
              snapshotRestartCount: 0,
              verificationPending: false,
              destructiveFinalization: false,
              membershipCertified: false,
            },
            lastSuccessfulRunId: input.syncRunId,
          }),
          generationObservedCount,
          finalizationFollowerCount,
          expectedTerminalPageCount,
          terminalPageShapeComplete,
          terminalDelta,
          ...activity,
        };
      }

      const deactivationLimit = followersReconcileDeactivationLimit(
        activity.activeFollowerCount,
      );
      if (activity.deactivationCandidateCount > deactivationLimit) {
        const candidateGenerationBuckets =
          await readPageFollowDeactivationGenerationBuckets(dbTx, {
            platformAccountId: input.pageContext.page.id,
            generation: state.generation,
            fullSweepStartedAt,
          });
        return {
          kind: "blast_radius_blocked" as const,
          generationObservedCount,
          finalizationFollowerCount,
          membershipProof,
          expectedTerminalPageCount,
          terminalPageShapeComplete,
          terminalDelta,
          deactivationLimit,
          candidateGenerationBuckets,
          ...activity,
        };
      }

      const deactivatedIds = await deactivatePageFollowsByGeneration(dbTx, {
        platformAccountId: input.pageContext.page.id,
        generation: state.generation,
        lastSeenBefore: fullSweepStartedAt,
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
      const completedAt = new Date();
      return {
        kind: "complete" as const,
        checkpoint: await upsertCheckpoint(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "followers_reconcile",
          ...(settlementReuseEnabled ? { now: completedAt } : {}),
          state: {
            revision: state.revision,
            generation: state.generation,
            fullSweepStartedAt: state.fullSweepStartedAt,
            offset: state.offset,
            observedCount: state.observedCount,
            pageCount: state.pageCount,
            sourceFollowerCount: finalizationFollowerCount,
            snapshotRestartCount: 0,
            verificationPending: false,
            ...(settlementReuseEnabled ? { completion: {
              version: 1, runId: input.syncRunId, completedAt: completedAt.toISOString(),
              membershipProof, generationObservedCount,
            } } : {}),
          },
          lastSuccessfulRunId: input.syncRunId,
        }),
        generationObservedCount,
        finalizationFollowerCount,
        membershipProof,
        expectedTerminalPageCount,
        terminalPageShapeComplete,
        terminalDelta,
        deactivationLimit,
        deactivatedCount: deactivatedIds.length,
        ...activity,
      };
    });

    // A separate note avoids the run-statistics key limit. The SELECT witnesses
    // and the guarded UPDATE result are separate observations, not an active-after count.
    await input.telemetry.addNote("Fansly followers membership verification", {
      followersMembership: {
        schemaVersion: 1,
        outcome: verification.kind,
        generation: state.generation,
        fullSweepStartedAt: state.fullSweepStartedAt,
        sourceFollowerCount: verification.finalizationFollowerCount,
        generationObservedCount: verification.generationObservedCount,
        activeFollowerCount: verification.activeFollowerCount,
        activeInGenerationCount: verification.activeInGenerationCount,
        activeOutsideGenerationCount: verification.activeOutsideGenerationCount,
        deactivationCandidateCount: verification.deactivationCandidateCount,
        generationGraceOnlyCount: verification.generationGraceOnlyCount,
        touchedSinceStartOnlyCount: verification.touchedSinceStartOnlyCount,
        generationGraceAndTouchCount: verification.generationGraceAndTouchCount,
        futureGenerationCount: verification.futureGenerationCount,
        deactivatedCount: verification.kind === "complete" ? verification.deactivatedCount : null,
      },
    });

    if (
      verification.kind === "restart"
      || verification.kind === "non_destructive_complete"
    ) {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_generation_guard",
        severity: "warn",
        message:
          "Follower reconcile generation did not reproduce a complete terminal membership; destructive finalization withheld",
        details: {
          sourceFollowerCount: verification.finalizationFollowerCount,
          ...(state.sourceFollowerCount !== verification.finalizationFollowerCount
            ? { startingSourceFollowerCount: state.sourceFollowerCount }
            : {}),
          observedCount: state.observedCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
          expectedTerminalPageCount: verification.expectedTerminalPageCount,
          terminalPageShapeComplete: verification.terminalPageShapeComplete,
          terminalDelta: verification.terminalDelta,
          firstSeenDuringSweepOutsideGeneration:
            verification.firstSeenDuringSweepOutsideGeneration,
          snapshotRestartCount: state.snapshotRestartCount,
          destructiveFinalization: false,
        },
      });
      await input.telemetry.recordCheckpointAdvanced(
        "followers_reconcile",
        summarizeCheckpoint(verification.checkpoint),
      );
      if (verification.kind === "restart") {
        return {
          satisfied: false,
          yieldReason: null,
          continuationRetryAt: spreadFanslyContinuation(
            new Date(),
            FOLLOWERS_RECONCILE_RETRY_DELAY_MS,
          ),
          continuationRequestSource: "scheduled",
          stats: {
            generation: state.generation,
            pageCount: state.pageCount,
            processedThisChunk,
            sourceFollowerCount: verification.finalizationFollowerCount,
            startingSourceFollowerCount: state.sourceFollowerCount,
            generationObservedCount: verification.generationObservedCount,
            snapshotRestartCount: state.snapshotRestartCount + 1,
            destructiveFinalization: false,
            finalizationWithheld: true,
          },
        } satisfies StreamChunkResult;
      }
      await input.telemetry.addNote(
        "Follower reconcile completed non-destructively after two fresh generations could not certify terminal membership",
        {
          code: "followers_reconcile_nondestructive_close",
          generation: state.generation,
          sourceFollowerCount: verification.finalizationFollowerCount,
          generationObservedCount: verification.generationObservedCount,
          snapshotRestartCount: state.snapshotRestartCount,
        },
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
          destructiveFinalization: false,
          finalizationWithheld: true,
          nonDestructiveClose: true,
        },
      } satisfies StreamChunkResult;
    }

    if (verification.kind === "blast_radius_blocked") {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_deactivation_blast_radius",
        severity: "error",
        message:
          "Follower reconcile certified membership but would deactivate more rows than the safety ceiling",
        details: {
          sourceFollowerCount: verification.finalizationFollowerCount,
          generationObservedCount: verification.generationObservedCount,
          membershipProof: verification.membershipProof,
          activeFollowerCount: verification.activeFollowerCount,
          deactivationCandidateCount: verification.deactivationCandidateCount,
          deactivationLimit: verification.deactivationLimit,
          candidateGenerationBuckets: verification.candidateGenerationBuckets,
          fullSweepStartedAt: state.fullSweepStartedAt,
        },
      });
      throw new FollowersReconcileConsistencyError({
        code: "followers_reconcile_deactivation_blast_radius",
        message:
          `Follower reconcile would deactivate ${verification.deactivationCandidateCount} active rows ` +
          `(limit ${verification.deactivationLimit}); refusing destructive finalization`,
      });
    }

    if (state.sourceFollowerCount !== verification.finalizationFollowerCount) {
      await input.telemetry.addNote(
        "Follower headline changed during reconcile; terminal membership proof passed",
        {
          code: "followers_reconcile_terminal_headline_changed",
          startingSourceFollowerCount: state.sourceFollowerCount,
          terminalSourceFollowerCount: verification.finalizationFollowerCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
          membershipProof: verification.membershipProof,
        },
      );
    }
    if (state.observedCount !== verification.finalizationFollowerCount) {
      await input.telemetry.addAnomaly({
        code: "followers_reconcile_offset_drift_tolerated",
        severity: "warn",
        message: "Follower reconcile raw row count drifted while terminal membership remained certified",
        details: {
          sourceFollowerCount: verification.finalizationFollowerCount,
          ...(state.sourceFollowerCount !== verification.finalizationFollowerCount
            ? { startingSourceFollowerCount: state.sourceFollowerCount }
            : {}),
          observedCount: state.observedCount,
          generationObservedCount: verification.generationObservedCount,
          pageCount: state.pageCount,
          membershipProof: verification.membershipProof,
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
        membershipProof: verification.membershipProof,
        deactivationCandidateCount: verification.deactivationCandidateCount,
        deactivationLimit: verification.deactivationLimit,
        destructiveFinalization: true,
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
        limit: FOLLOWERS_RECONCILE_PAGE_SIZE,
      },
    );
    await persistRawPayload(app.db, {
      platformAccountId: input.pageContext.page.id,
      syncRunId: input.syncRunId,
      endpoint: "followers",
      requestParams: {
        offset: state.offset,
        limit: FOLLOWERS_RECONCILE_PAGE_SIZE,
        mode: "reconcile",
        generation: state.generation,
        fullSweepStartedAt: state.fullSweepStartedAt,
      },
      responsePayload: captureFanslyFollowerPayload(page.raw, page.contractAccepted),
      mapperVersion: FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting followers raw payload",
      platform: "fansly",
    });

    if (page.contractAccepted === false) {
      throw new Error("Fansly followers response contract rejected; captured before refusal");
    }
    state = {
      ...state,
      pageCount: state.pageCount + 1,
    };

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
        offset: state.offset + FOLLOWERS_RECONCILE_PAGE_SIZE,
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
        reusedIds: hydratedFollowers.reusedIds,
        lookup: hydratedFollowers.lookup,
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
  const hintOnly = input.streamState.dispatchSource === "event" && input.streamState.requestPayload.fanslyWsHintOnly === true;
  // A spent budget's wake settles already stored targets and makes no request.
  const settleOnly = hintOnly && input.streamState.requestPayload.fanslyWsHintSettleOnly === true;
  await runFanslyWsHintStep(app, input, { settleOnly });
  // AI media describer accelerator (default off): at most one addressed head
  // read per chunk under the same lease; journal-only.
  if (!settleOnly) await runAiMediaAcceleratorStep(app, { ...input, pageContext: input.pageContext });
  if (hintOnly) {
    // Addressed hint custody cannot certify the ordinary DM stream's
    // freshness or recovery, even when this step applied its target.
    return { satisfied: true, yieldReason: null, qualityHold: "fansly_ws_hint_only", stats: { fanslyWsHintOnly: true } };
  }
  const effective = await loadEffectiveConfig(app.db, app.config);
  const headCatchupEnabled = isPageAllowlisted(
    effective.fanslyDmHeadCatchupPageAllowlist, input.pageContext.page.label,
  );

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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  };
  // For a failing thread's retry: the adapter clamps its in-process retries
  // to this allowance, so the page costs one physical attempt.
  const singleAttemptRequestContext = { ...requestContext, remainingAttempts: () => 1 };
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "dm_messages");
  await input.telemetry.recordCheckpointLoaded("dm_messages", summarizeCheckpoint(checkpoint));

  let state = parseDmMessagesCursorState(checkpoint?.state) ?? emptyDmMessagesCursorState();
  if (!headCatchupEnabled && state.headCatchup) {
    if (state.headCatchup.overlapReached || state.headCatchup.pagesRead === 0) {
      state = emptyDmMessagesCursorState();
    } else {
      delete state.headCatchup;
    }
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id, stream: "dm_messages", state,
    });
  }

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
  // Read at most once per chunk, and only when a first read fills its start
  // window: the one question the new-thread history walk asks the database.
  let dmOnboardedAt: Date | null | undefined;
  // Settlement evidence. A message page the provider answered and the contract
  // accepted is progress; a thread failure the breaker deferred is not.
  let acceptedMessagePages = 0;
  let deferredThreads = 0;
  // A thread still carrying breaker failures whose window has lapsed is a
  // retry, not ordinary work: at most one per chunk, its first page on a
  // single physical attempt, so a poison thread costs the chunk one request.
  // Once the retry is spent, the pickers skip failing threads.
  let failingThreadRetrySpent = false;

  const emitDmMessagesChunkSummary = async () => {
    if (emittedDmMessagesChunkSummary) {
      return emittedDmMessagesChunkSummary;
    }

    emittedDmMessagesChunkSummary = dmMessagesRequestObserver.buildSummary(Date.now() - chunkStartedAt);
    await input.telemetry.recordDmMessagesChunkSummary(emittedDmMessagesChunkSummary);
    return emittedDmMessagesChunkSummary;
  };

  /** The pinned walk has not written a page yet. */
  const isAtWalkStart = (
    conversation: PageDmConversationRow,
    currentMode: "backfill" | "deep_backfill" | "incremental",
  ) => state.currentBeforeMessageId === (state.headCatchup || currentMode === "incremental"
    ? null
    : conversation.oldestStoredMessageId);

  /**
   * Per-thread circuit breaker (0086). The pin is checkpointed before the
   * fetch and the next chunk resumes it without reselecting, so one thread
   * the provider refuses deterministically would otherwise stop the page's
   * whole lane. When the walk's FIRST page fails with a thread-attributable
   * answer, the failure is recorded (backoff, quarantine from the 4th) and the
   * pin is cleared in one owned transaction: the thread is deferred, and the
   * chunk goes on with other threads under its normal budgets. Everything
   * else fails the stream with its ordinary classification and backoff: a
   * failure that is not the thread's, several groups failing since the page's
   * last successful read (an outage, which never opens a breaker), a failed
   * breaker write, and lease loss. A walk with pages already written keeps
   * its pin and fails the stream too: a later head walk would stop on those
   * pages and hide the gap below them.
   */
  const recordFirstPageThreadFailure = async (
    error: unknown,
    conversation: PageDmConversationRow,
    currentMode: "backfill" | "deep_backfill" | "incremental",
  ): Promise<{ deferred: true } | { deferred: false; streamError: unknown }> => {
    if (!isThreadAttributableFanslyFailure(error)) {
      return { deferred: false, streamError: error };
    }
    if (!isAtWalkStart(conversation, currentMode)) {
      return { deferred: false, streamError: error };
    }

    const nextState = setDmMessagesLiveRequestsSinceDeepBackfill(
      emptyDmMessagesCursorState(),
      getDmMessagesLiveRequestsSinceDeepBackfill(state),
    );
    let otherFailingGroups: number;
    let recorded: {
      health: Awaited<ReturnType<typeof recordConversationSyncFailure>>;
      progressCheckpoint: Awaited<ReturnType<typeof upsertCheckpointProgress>>;
    };
    try {
      otherFailingGroups = await countOtherDmMessageGroupsFailingSinceLastSuccess(app.db, {
        platformAccountId: input.pageContext.page.id,
        platformConversationId: conversation.platformConversationId,
        since: new Date(Date.now() - DM_MESSAGES_BREAKER_OUTAGE_LOOKBACK_MS),
      });
      if (otherFailingGroups >= DM_MESSAGES_BREAKER_OUTAGE_OTHER_FAILING_GROUPS) {
        await input.telemetry.addNote(
          "DM message failures span several conversations; treated as a page-wide outage, no breaker",
          {
            conversationId: conversation.id,
            groupId: conversation.platformConversationId,
            httpStatus: error.status,
            otherFailingGroups,
          },
        );
        return { deferred: false, streamError: error };
      }

      recorded = await withOwnedPageSyncTransaction(app.db, async (dbTx) => ({
        health: await recordConversationSyncFailure(dbTx, {
          conversationId: conversation.id,
          platformAccountId: input.pageContext.page.id,
          errorClass: `fansly_${error.status}`,
          errorMessage: error.message,
        }),
        progressCheckpoint: await upsertCheckpointProgress(dbTx, {
          platformAccountId: input.pageContext.page.id,
          stream: "dm_messages",
          state: nextState,
        }),
      }));
    } catch (breakerError) {
      if (breakerError instanceof PageSyncLeaseLostError) {
        // Fencing stays fatal: another owner may already be running.
        return { deferred: false, streamError: breakerError };
      }
      app.logger.warn({
        err: breakerError,
        conversationId: conversation.id,
        platformAccountId: input.pageContext.page.id,
      }, "DM conversation breaker write failed; the stream keeps its pin");
      return { deferred: false, streamError: error };
    }

    state = nextState;
    await input.telemetry.recordCheckpointAdvanced(
      "dm_messages",
      summarizeCheckpoint(recorded.progressCheckpoint),
    );
    await input.telemetry.addNote(
      recorded.health.quarantineUntil !== null
        ? "DM conversation quarantined after repeated first-page failures"
        : "DM conversation first-page failure recorded, backing off",
      {
        conversationId: conversation.id,
        groupId: conversation.platformConversationId,
        currentMode,
        httpStatus: error.status,
        failureCount: recorded.health.failureCount,
        nextRetryAt: recorded.health.nextRetryAt?.toISOString() ?? null,
        quarantineUntil: recorded.health.quarantineUntil?.toISOString() ?? null,
        otherFailingGroups,
      },
    );
    return { deferred: true };
  };

  /** Defers a thread's failed first page, or throws what fails the stream.
   * On return the chunk continues with another thread. */
  const deferThreadOrFailStream = async (
    error: unknown,
    conversation: PageDmConversationRow,
    currentMode: "backfill" | "deep_backfill" | "incremental",
  ) => {
    const outcome = await recordFirstPageThreadFailure(error, conversation, currentMode);
    if (!outcome.deferred) {
      throw outcome.streamError;
    }
    deferredThreads += 1;
  };

  /** A failing thread whose window has lapsed, which the pickers would offer
   * now had the chunk not spent its retry. */
  const hasDueFailingThread = async () => {
    const candidate = await selectNextPageDmMessageSyncCandidate(app.db, {
      ...(headCatchupEnabled ? { includeHeadDebt: true } : {}),
      platformAccountId: input.pageContext.page.id,
    });
    if (candidate !== null || deepBackfillRequests >= deepBackfillMaxRequests) {
      return candidate !== null;
    }
    const effective = await loadEffectiveConfig(app.db, app.config);
    return await selectNextPageDmMessageDeepBackfillCandidate(app.db, {
      platformAccountId: input.pageContext.page.id,
      ignoreRetentionLimit: effective.fanslyDeepBackfillIgnoreRetentionLimit === true,
    }) !== null;
  };

  /**
   * A pinned walk dropped after it wrote pages (the thread became excluded,
   * invisible or unbound) leaves rows its thread summary does not cover yet.
   * A later incremental walk reads through them (overlap counts only rows at
   * or before the recorded newest message), unless a writer recomputes the
   * summary first and moves that boundary onto them. A backfill or deep
   * backfill walk re-picked from the stale oldest message meets its own pages
   * as ordinary overlap and can certify the unread history below them
   * complete. Record the dropped cursor so such a gap stays findable for the
   * targeted backfill; this anomaly is its only record.
   */
  const recordDroppedWalk = async (conversation: PageDmConversationRow, reason: string) => {
    if (!state.currentMode) {
      return;
    }
    const walkStartBeforeMessageId = state.headCatchup || state.currentMode === "incremental"
      ? null
      : conversation.oldestStoredMessageId;
    if (state.currentBeforeMessageId === walkStartBeforeMessageId) {
      return;
    }
    await input.telemetry.addAnomaly({
      code: "dm_messages_walk_dropped",
      severity: "warn",
      message: "DM walk dropped after writing pages; history below its cursor may be unread",
      details: {
        reason,
        conversationId: state.currentConversationId,
        groupId: state.currentPlatformConversationId,
        currentMode: state.currentMode,
        droppedBeforeMessageId: state.currentBeforeMessageId,
        newestStoredMessageId: conversation.newestStoredMessageId,
      },
    });
  };

  try {
    conversationLoop: while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
      await assertOwnedPageSyncLease(app.db);
      let conversation = state.currentConversationId
        ? await getPageDmConversationById(app.db, state.currentConversationId)
        : null;

      // A crash can occur after the attempt receipt commits but before the
      // summary/checkpoint transaction. Do not spend another bounded walk.
      if (conversation && state.headCatchup) {
        const target = await getFanslyDmHeadTarget(app.db, {
          conversationId: conversation.id, messageId: state.headCatchup.messageId,
        });
        if (!target || target.captured || target.attempts >= 5 ||
          (target.lastAttemptAt !== null && target.lastAttemptAt >= new Date(state.headCatchup.startedAt))) {
          if (state.headCatchup.overlapReached) {
            state = emptyDmMessagesCursorState();
            conversation = null;
          } else {
            // Another writer may confirm the target between chunks without
            // covering our intervening history. Keep that ordinary cursor.
            delete state.headCatchup;
          }
          await upsertCheckpointProgress(app.db, {
            platformAccountId: input.pageContext.page.id, stream: "dm_messages", state,
          });
        }
      }

      if (conversation && isFanslyDmMessageSyncExcluded(conversation.metadata)) {
        await recordDroppedWalk(conversation, "excluded");
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
        if (conversation) {
          await recordDroppedWalk(conversation, conversation.isVisible ? "unbound" : "invisible");
        }
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
            ...(failingThreadRetrySpent ? { excludeFailingThreads: true } : {}),
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
            ...(headCatchupEnabled ? { includeHeadDebt: true } : {}),
            platformAccountId: input.pageContext.page.id,
            ...(failingThreadRetrySpent ? { excludeFailingThreads: true } : {}),
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
              ...(failingThreadRetrySpent ? { excludeFailingThreads: true } : {}),
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

        const headTarget = headCatchupEnabled && currentMode !== "deep_backfill"
          ? await getFanslyDmHeadTarget(app.db, { conversationId: conversation.id }) : null;
        if (headTarget === null && currentMode === "incremental" &&
          conversation.messageCoverageStatus === "pending_backfill" &&
          (headCatchupEnabled || !isDmHeadStaleByTime(conversation))) {
          // A head can keep differing from the newest stored message after it
          // was read (list lag, or an id /message never returns). Pending
          // history without a due head read resumes from its oldest cursor
          // instead of rereading that head forever. Off the catch-up allowlist
          // a time-stale head is still read once first.
          currentMode = "backfill";
        }
        const nextState: DmMessagesCursorState = {
          ...(headTarget ? { headCatchup: {
            messageId: headTarget.messageId, startedAt: new Date().toISOString(), pagesRead: 0,
          } } : {}),
          ...emptyDmMessagesCursorState(),
          currentConversationId: conversation.id,
          currentPlatformConversationId: conversation.platformConversationId,
          currentBeforeMessageId: headTarget ? null : currentMode === "backfill" || currentMode === "deep_backfill"
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
      const headAttemptStartedAt = new Date(state.headCatchup?.startedAt ?? Date.now());
      let collectedThisConversation = 0;
      // The chunk's one failing-thread retry (see failingThreadRetrySpent).
      // Only the chunk's first walk can come from a restored pin; every later
      // walk is a pick, and the pickers skip failing threads once it is spent.
      let pageRequestContext = requestContext;
      if (isAtWalkStart(conversation, currentMode) &&
        ((await getConversationSyncHealth(app.db, conversation.id))?.failureCount ?? 0) > 0) {
        failingThreadRetrySpent = true;
        pageRequestContext = singleAttemptRequestContext;
      }
      while (input.budget.hasRequestCapacity() && input.budget.hasWallClockCapacity()) {
        const currentConversation = conversation;
        await assertOwnedPageSyncLease(app.db);
        dmMessagesRequestObserver.recordConversationTouched(currentConversation.id);

        // The fetch + verbatim journal + normalization is the unit shared with
        // the targeted thread backfill (slice C′). It stays inside this
        // try/catch exactly as the bare adapter call did: only a terminal
        // Fansly 5xx reaches the partner-unresolvable recovery below; every
        // other failure (including a capture failure) goes to the per-thread
        // breaker, which defers the thread or fails the stream.
        if (state.currentBeforeMessageId === null) {
          // This page reads the head (incremental, head catch-up, or a first
          // backfill of an empty thread). Overwritten on every head fetch and
          // carried by the in-walk checkpoint, so a walk finishing chunks
          // later certifies the head only as of this read.
          state.headReadAt = new Date().toISOString();
        }
        let messagePage;
        try {
          messagePage = await fetchAndJournalFanslyDmMessagePage(app, {
            requestContext: pageRequestContext,
            telemetry: input.telemetry,
            syncRunId: input.syncRunId,
            platformAccountId: input.pageContext.page.id,
            platform: input.pageContext.platform,
            pageAccountId,
            conversation: currentConversation,
            before: state.currentBeforeMessageId,
            limit: FANSLY_DM_MESSAGE_PAGE_LIMIT,
            // The summary moves only at finalize, so an incremental walk that
            // was dropped mid-way and picked again must not stop on its own
            // earlier pages above the recorded newest message.
            overlapBoundaryMessageId: currentMode === "incremental"
              ? currentConversation.newestStoredMessageId
              : null,
          });
        } catch (error) {
          const partnerPlatformUserId = currentConversation.partnerPlatformUserId;
          if (
            !isTerminalFanslyServerError(error) ||
            !partnerPlatformUserId
          ) {
            await deferThreadOrFailStream(error, currentConversation, currentMode);
            continue conversationLoop;
          }

          const failureStreak = await countRecentTerminalDmMessageConversationFailureStreak(
            app.db,
            {
              platformAccountId: input.pageContext.page.id,
              platformConversationId: currentConversation.platformConversationId,
            },
          );
          if (failureStreak < DM_MESSAGES_PARTNER_UNRESOLVABLE_FAILURE_STREAK_THRESHOLD) {
            await deferThreadOrFailStream(error, currentConversation, currentMode);
            continue conversationLoop;
          }

          if (!input.budget.hasRequestCapacity() || !input.budget.hasWallClockCapacity()) {
            await deferThreadOrFailStream(error, currentConversation, currentMode);
            continue conversationLoop;
          }

          const resolution = await probeFanslyAccountResolution(
            app,
            requestContext,
            partnerPlatformUserId,
            { platformAccountId: input.pageContext.page.id, syncRunId: input.syncRunId },
            // Thrown from here, it fails the stream with the pin kept.
            { rethrow: isPageLevelFanslyProbeFailure },
          );
          if (resolution !== "unresolved") {
            await deferThreadOrFailStream(error, currentConversation, currentMode);
            continue conversationLoop;
          }

          const progressCheckpoint = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
            const excluded = await excludePageDmConversationMessageSync(dbTx, {
              conversationId: currentConversation.id,
              platformAccountId: input.pageContext.page.id,
              partnerPlatformUserId,
              reason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
            });
            // The lookup concerned the old binding. A changed or removed row
            // must not inherit that exclusion or advance this checkpoint.
            if (!excluded) throw error;
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
          await recordDroppedWalk(currentConversation, "partner_unresolvable");

          state = emptyDmMessagesCursorState();
          await input.telemetry.recordCheckpointAdvanced(
            "dm_messages",
            summarizeCheckpoint(progressCheckpoint),
          );
          continue conversationLoop;
        }
        acceptedMessagePages += 1;
        // A thread that answered is walked on with the ordinary retries.
        pageRequestContext = requestContext;
        const { normalizedMessages, insertedMessageCount, overlapFound } = messagePage;
        // Debt from an earlier page of this walk rides the checkpoint, so a
        // multi-chunk walk cannot finish 'complete' over a skipped message.
        const normalizationDebt = state.normalizationDebt === true || messagePage.normalizationDebt;
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
        const windowFilled =
          currentMode === "backfill" &&
          (currentConversation.storedMessageCount + collectedThisConversation) >= PAGE_DM_LIVE_BACKFILL_CAP;
        // The first read of a thread (still pending_backfill) whose history
        // began after the page's DM onboarding walks on past the start window
        // toward the provider's end, so a new dialog that grew past 25
        // messages before its first read keeps its beginning. Old threads
        // stop at the window as before: the page's first message older than
        // onboarding ends the walk, deep backfill stays off, and the extra
        // pages are capped across chunks inside the chunk's own budget.
        const newThreadHistoryPages = state.newThreadHistoryPages ?? 0;
        let readsNewThreadHistory = false;
        if (
          windowFilled && !overlapFound && !providerHistoryExhausted &&
          currentConversation.messageCoverageStatus === "pending_backfill" &&
          newThreadHistoryPages < PAGE_DM_NEW_THREAD_EXTRA_HISTORY_PAGES
        ) {
          if (dmOnboardedAt === undefined) {
            dmOnboardedAt = await getPageDmOnboardedAt(app.db, input.pageContext.page.id);
          }
          readsNewThreadHistory = isDmMessagePageAfterOnboarding(messagePage, dmOnboardedAt);
        }
        const hitWindowCap = windowFilled && !readsNewThreadHistory;
        const headCatchup = state.headCatchup;
        const targetFound = headCatchup && normalizedMessages.some(
          (message) => message.platformMessageId === headCatchup.messageId,
        );
        const targetAttemptFinished = headCatchup !== undefined &&
          (targetFound || providerHistoryExhausted || hitWindowCap || headCatchup.pagesRead + 1 >= 5);
        // A target receipt cannot replace the normal walk back to known ground.
        // On success/cap without overlap, drop only the recovery rider and keep
        // the ordinary incremental cursor, including across dispatches.
        const shouldComplete = headCatchup
          ? targetAttemptFinished && (overlapFound || headCatchup.overlapReached || providerHistoryExhausted || hitWindowCap)
          : currentMode === "deep_backfill"
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
            // A deep walk's one page below the oldest stored message reached
            // the provider's end: its unparseable tail can never be stored, so
            // partial_window would hand the unchanged thread straight back to
            // the deep picker. The anomaly stays the record of the skip.
            normalizationDebt: normalizationDebt &&
              !(currentMode === "deep_backfill" && providerHistoryExhausted),
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
            if (headCatchup) await recordFanslyDmHeadAttempt(dbTx, {
              conversationId: currentConversation.id, messageId: headCatchup.messageId,
              startedAt: headAttemptStartedAt,
            });
            // A completed walk resets the thread's breaker (no-op when it never
            // failed). Here, not in the finalize below: that one can be
            // deferred into projection_debt although the thread synced.
            await clearConversationSyncHealth(dbTx, currentConversation.id);
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
                // A walk from a stored cursor never read the head.
                headReadAt: state.headReadAt ? new Date(state.headReadAt) : null,
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
          ...(headCatchup ? { headCatchup: {
            ...headCatchup, pagesRead: headCatchup.pagesRead + 1,
            overlapReached: headCatchup.overlapReached === true || overlapFound,
          } } : {}),
          currentBeforeMessageId: oldestMessageId,
          ...(normalizationDebt ? { normalizationDebt: true as const } : {}),
          ...(readsNewThreadHistory ? { newThreadHistoryPages: newThreadHistoryPages + 1 } : {}),
        };
        if (targetAttemptFinished) delete state.headCatchup;
        const progressCheckpoint = await withOwnedPageSyncTransaction(app.db, async (dbTx) => {
          await upsertPageDmMessages(dbTx, normalizedMessages);
          if (headCatchup && targetAttemptFinished) await recordFanslyDmHeadAttempt(dbTx, {
            conversationId: currentConversation.id, messageId: headCatchup.messageId,
            startedAt: headAttemptStartedAt,
          });
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
    // Threads deferred behind their breaker windows are scheduling, not
    // progress. A chunk that got no message page accepted must not reset the
    // stream's failure streak, resolve its incidents or claim completion
    // (StreamChunkResult.deferral) while breaker failures are outstanding:
    // threads it deferred itself, or ones an earlier chunk deferred that now
    // back off or sit out a quarantine. Otherwise the continuation after a
    // deferral, or any request during a quarantine, would find nothing to
    // read and certify recovery.
    const deferredOnly = acceptedMessagePages === 0 && (
      deferredThreads > 0 ||
      (await countConversationSyncFailuresByAccount(app.db, {
        platformAccountIds: [input.pageContext.page.id],
      })).length > 0
    );
    const deferral = deferredOnly ? { deferral: FANSLY_DM_THREADS_DEFERRED } : {};
    const deferredStats = deferredThreads > 0 ? { deferredThreads } : {};

    if (!exhaustedEligibleConversations && !deepBackfillPaused) {
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(),
        ...deferral,
        stats: {
          currentConversationId: state.currentConversationId,
          currentBeforeMessageId: state.currentBeforeMessageId,
          currentMode: state.currentMode,
          processedMessages,
          completedConversations,
          overlapHits,
          projectionDebtRecorded,
          deepBackfillRequests,
          ...deferredStats,
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

    // The pickers skipped failing threads once this chunk spent its retry;
    // another one may be due now. It runs in the next chunk, not after the
    // next window or the daily cadence.
    if (failingThreadRetrySpent && await hasDueFailingThread()) {
      return {
        satisfied: false, yieldReason: null, continuationRetryAt: null, ...deferral,
        stats: { processedMessages, completedConversations, ...deferredStats, dmMessagesChunk, failingThreadRetryDue: true },
      } satisfies StreamChunkResult;
    }

    // Only threads waiting out a short backoff window remain: sleep until the
    // first one ends instead of completing, which would leave them to the next
    // request (dm_messages runs on a daily cadence). A chunk that read nothing
    // before going back to that wait made no progress either, so it cannot
    // turn a deferral into recovery. A quarantine holds nothing open, not even
    // through a quarantined thread's head debt: the breaker re-arms it on
    // every later failure, so waiting on it would keep the request outstanding
    // for good, and B1 cannot wake a stream with ordinary work outstanding
    // (requestPageSync).
    const headRetryAt = headCatchupEnabled
      ? await nextFanslyDmHeadRetryAt(app.db, {
        platformAccountId: input.pageContext.page.id,
        excludeQuarantined: true,
      })
      : null;
    const deferredRetryAt = await nextConversationSyncBackoffRetryAt(app.db, {
      platformAccountId: input.pageContext.page.id,
    });
    const wakeAt = headRetryAt === null ||
      (deferredRetryAt !== null && deferredRetryAt.getTime() < headRetryAt.getTime())
      ? deferredRetryAt
      : headRetryAt;
    if (wakeAt) return {
      satisfied: false, yieldReason: null,
      continuationRetryAt: new Date(Math.max(wakeAt.getTime(), Date.now() + 60_000)),
      ...(deferredOnly || (acceptedMessagePages === 0 && deferredRetryAt !== null)
        ? { deferral: FANSLY_DM_THREADS_DEFERRED } : {}),
      stats: {
        processedMessages, completedConversations, ...deferredStats, dmMessagesChunk,
        ...(headRetryAt ? { headDebtPending: true } : {}),
        ...(deferredRetryAt ? { deferredThreadsRetryAt: deferredRetryAt.toISOString() } : {}),
      },
    } satisfies StreamChunkResult;

    if (deferredOnly) {
      // Nothing was read, and nothing is left to wait for: the failing
      // threads sit out a quarantine, left the lane (hidden, unbound,
      // excluded) or have nothing to read. Settle the request without
      // success, the stream going idle; the next ordinary request retries a
      // quarantined thread once its window ends.
      return {
        satisfied: true, yieldReason: null, qualityHold: FANSLY_DM_THREADS_DEFERRED,
        stats: { processedMessages, completedConversations, ...deferredStats, dmMessagesChunk },
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
