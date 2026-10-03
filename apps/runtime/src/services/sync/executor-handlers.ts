import {
  buildTopSpendersBootstrapState,
  computeCompletedTopSpenderMonths,
  parseTopSpendersCursorState,
  partitionTopSpenderItems,
  TOP_SPENDERS_STEADY_STATE_WINDOW_MS,
  type TopSpendersCursorState,
} from "../../sync/fansly/lib/money-rules.ts";
import {
  aggregateTransactionTopSpenders,
  assertOwnedPageSyncLease,
  getEarliestSpenderTransactionAt,
  getCheckpoint,
  updatePageSyncTimestampCache,
  upsertPageTopSpenders,
  upsertCheckpoint,
  upsertCheckpointProgress,
  upsertFans,
  withOwnedPageSyncTransaction,
  type PageSyncLease,
  type SyncStream,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
} from "@agency_hub_core/fansly";
import {
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
import {
  summarizeCheckpoint,
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
} from "./cursor-state.ts";
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
import { isOnlyFansTopSpendersEnabled } from "./onlyfans-top-spenders.ts";
import {
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
} from "./shared.ts";

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
