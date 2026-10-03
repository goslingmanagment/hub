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
  countActivePageFollows,
  countCurrentPageSubscriptionsByGeneration,
  countPageFollowsByGeneration,
  deactivatePageFollowsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  retireLapsedPageSubscriptionsForEmptySnapshot,
  getEarliestSpenderTransactionAt,
  getCheckpoint,
  getPageSyncExecutionContext,
  getCurrentSubscribers,
  maxPageFollowGeneration,
  maxPageSubscriptionGeneration,
  requestPageSync,
  readPageFollowReconcileActivity,
  readPageFollowDeactivationGenerationBuckets,
  rebuildFollowerRollups,
  rebuildSubscriberRollups,
  updatePageSyncTimestampCache,
  upsertArchivedPageSubscriptions,
  upsertPageTopSpenders,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFanPages,
  upsertFanPageExternalPresences,
  upsertFans,
  upsertPageFollows,
  upsertPageSubscriptions,
  withOwnedPageSyncTransaction,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  type EmptySnapshotSubscriptionRetirement,
  type PageSyncLease,
  type SyncStream,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  type FanslyAccount,
  type FanslyFollower,
} from "@agency_hub_core/fansly";
import {
  compareFanslyFollowIds,
  fanslyFollowIdToDate,
} from "@agency_hub_core/shared";

import type { CanonicalStream } from "@agency_hub_core/platform-core";

import { appPlatformRegistry } from "../../platforms/registry.ts";
import type { AppContext } from "../../bootstrap.ts";
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
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  asNumber,
  asRecord,
  parseFollowersCursorState,
  parseFollowersReconcileCursorState,
  parseSubscribersCursorState,
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
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";
export type { ExecutorRequestContext, StreamChunkResult };


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
