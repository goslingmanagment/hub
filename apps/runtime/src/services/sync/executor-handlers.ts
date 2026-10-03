import {
  buildTopSpendersBootstrapState,
  buildUtcMonthKey,
  computeCompletedTopSpenderMonths,
  parseTopSpendersCursorState,
  partitionTopSpenderItems,
  splitTopSpendersWindow,
  TOP_SPENDERS_STEADY_STATE_WINDOW_MS,
  type TopSpendersCursorState,
  type TopSpendersCursorWindow,
} from "../../sync/fansly/lib/money-rules.ts";
import {
  aggregateTransactionTopSpenders,
  assertOwnedPageSyncLease,
  clearConversationSyncHealth,
  countOtherDmMessageGroupsFailingSinceLastSuccess,
  countRecentTerminalDmMessageConversationFailureStreak,
  finalizePageDmConversationMessageSync,
  recordFanslyDmHeadAttempt,
  getFanslyDmHeadTarget,
  nextFanslyDmHeadRetryAt,
  getEarliestSpenderTransactionAt,
  getPageDmConversationById,
  getCheckpoint,
  getConversationSyncHealth,
  countConversationSyncFailuresByAccount,
  getPageDmOnboardedAt,
  getSyncRun,
  listFanslyPurchaseHistoryCaptures,
  listFanslyPurchaseHistoryStormVerdicts,
  listFanslyDmRawPayloadsAfterId,
  listFanslyMessagePurchaseTargetsAfterId,
  nextConversationSyncBackoffRetryAt,
  PAGE_DM_LIVE_BACKFILL_CAP,
  PAGE_DM_NEW_THREAD_EXTRA_HISTORY_PAGES,
  PageSyncLeaseLostError,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordConversationSyncFailure,
  recordProjectionDebt,
  selectNextPageDmMessageDeepBackfillCandidate,
  selectNextPageDmMessageSyncCandidate,
  updatePageSyncTimestampCache,
  upsertPageTopSpenders,
  upsertCheckpoint,
  upsertCheckpointProgress,
  excludePageDmConversationMessageSync,
  upsertPageDmMessages,
  upsertFans,
  withOwnedPageSyncTransaction,
  type PageDmConversationRow,
  type PageSyncLease,
  type SyncStream,
} from "@agency_hub_core/db";
import {
  FANSLY_MAPPER_VERSION,
  FanslyApiError,
} from "@agency_hub_core/fansly";
import {
  isFanslyDmMessageSyncExcluded,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

import type { CanonicalStream } from "@agency_hub_core/platform-core";

import { appPlatformRegistry } from "../../platforms/registry.ts";
import type { AppContext } from "../../bootstrap.ts";
import { resolveRawCapturePayloadRow } from "../payload-reader.ts";
import { isPageDmPruneAllowed } from "../page-dm-retention.ts";
import { evaluateFanslyStreamGate, isPageAllowlisted } from "./fansly-stream-gate.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import {
  resolvePageContextById,
  type ResolvedPageContext,
} from "../page-context.ts";
import {
  parseFanslyMetadataAccountCreatedAt,
  resolveFanslyPlatformAccountId,
} from "../fansly.ts";
import {
  summarizeCheckpoint,
  type DmMessagesChunkSummary,
  type SyncRunTelemetry,
} from "./observability.ts";
import { composeRequestObservers, type SyncChunkBudget } from "./chunk-budget.ts";
import {
  emptyDmMessagesCursorState,
  parseDmMessagesCursorState,
  type DmMessagesCursorState,
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
import {
  createFanslyLaneRuntime,
  createFanslyLaneJournal,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
} from "./fansly-lane.ts";
import {
  classifyFanslyPurchaseHistoryCapture,
  extractFanslyPurchaseHistoryTargets,
  fanslyPurchaseHistoryTargetKey,
  parseFanslyPurchaseHistoryCursorState,
  type FanslyPurchaseHistoryCaptureClassification,
  type FanslyPurchaseHistoryCursorStateV5,
  type FanslyPurchaseHistoryPendingTarget,
  type FanslyPurchaseHistoryTarget,
} from "../../sync/fansly/lib/purchase-history.ts";
import {
  assertFanslyPurchaseHistoryTargetKindsConsistent,
  classifyFanslyPurchaseHistoryCaptures,
  classifyFanslyPurchaseHistoryProbe,
  deriveFanslyPurchaseHistoryRejectionStreaks,
  extractFanslyPurchaseHistoryTargetsFromTransactions,
  FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
  FANSLY_PURCHASE_HISTORY_CONTRACT_STORM_ENDPOINT,
  FANSLY_PURCHASE_HISTORY_DAILY_ATTEMPT_CAP,
  FANSLY_PURCHASE_HISTORY_PROOF_WITNESS_LIMIT,
  FANSLY_PURCHASE_HISTORY_REJECTION_PROOF_THRESHOLD,
  FANSLY_PURCHASE_HISTORY_RESULT_LIMIT,
  fanslyPurchaseHistoryTargetRejection,
  isServedStatus,
  rejectedFanslyPurchaseHistoryPayload,
} from "./fansly-purchase-history.ts";
import { isOnlyFansTopSpendersEnabled } from "./onlyfans-top-spenders.ts";
import {
  persistRawPayload,
  refreshPageMetadata,
  retentionDate,
} from "./shared.ts";
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
import { syncTransactions } from "./transactions.ts";
import {
  FanslyPurchaseHistoryContractError,
} from "./errors.ts";

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
const PURCHASE_HISTORY_RAW_BATCH_SIZE = 500;
const PURCHASE_HISTORY_MAX_SCAN_BATCHES_PER_CHUNK = 4;
const PURCHASE_HISTORY_TRANSACTION_BATCH_SIZE = 500;
const PURCHASE_HISTORY_MAX_TRANSACTION_SCAN_BATCHES_PER_CHUNK = 4;

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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
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
        sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
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

function fanslyNewStreamSkip(reason: string): StreamChunkResult {
  return {
    satisfied: true,
    yieldReason: null,
    stats: { skipped: reason },
    gatedSkip: reason,
  };
}

export { executeFanEarningsChunk } from "./fan-earnings.ts";

export async function executePurchaseHistoryChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return fanslyNewStreamSkip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted("purchase_history");
  const effective = await loadEffectiveConfig(app.db, app.config);
  const gate = evaluateFanslyStreamGate(effective, "purchase_history", input.pageContext.page.label);
  if (gate.state !== "ramped") {
    return fanslyNewStreamSkip(gate.state);
  }

  // Fansly requires a concrete accountMediaId/accountMediaBundleId. accountIds
  // is only an optional buyer filter, so the old per-fan walk could never be
  // valid. Captured message-purchase transactions are the primary durable
  // discovery source; captured /message pages remain a complementary source
  // for PPV media observed before the matching transaction projection. Both
  // use local keysets, while target-specific purchase_history captures are the
  // durable dedupe set.
  const checkpoint = await getCheckpoint(app.db, input.pageContext.page.id, "purchase_history");
  const now = new Date();
  let state: FanslyPurchaseHistoryCursorStateV5 = rollFanslyUtcDay(
    parseFanslyPurchaseHistoryCursorState(checkpoint?.state, now) ?? {
      version: 5,
      transactionCursorId: 0,
      rawPayloadCursorId: 0,
      pendingTargets: [],
      utcDay: now.toISOString().slice(0, 10),
      callsToday: 0,
    },
    now,
  );
  const lane = createFanslyLaneRuntime({
    db: app.db,
    pageId: input.pageContext.page.id,
    stream: "purchase_history",
    cursorText: () => null,
    dailyCap: FANSLY_PURCHASE_HISTORY_DAILY_ATTEMPT_CAP,
    telemetry: input.telemetry,
    downstreamObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
    ),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  });
  const {
    attemptBudget,
    complete,
    requestContext,
    saveProgress: savePurchaseHistoryProgress,
  } = lane;
  const journalPurchaseHistory = createFanslyLaneJournal({
    db: app.db,
    pageId: input.pageContext.page.id,
    syncRunId: input.syncRunId,
    mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
  });
  // G5 slice 2: every captured body is routed through the read seam before it
  // is classified. Unbounded list read by design (every purchase_history
  // capture for the page), so in shadow/serve it costs one catalog query per
  // row that CARRIES a reference — i.e. nothing at all outside the slice-1
  // dual-write canary.
  const captureIndex = classifyFanslyPurchaseHistoryCaptures(
    await Promise.all(
      (await listFanslyPurchaseHistoryCaptures(app.db, input.pageContext.page.id)).map((row) =>
        resolveRawCapturePayloadRow(app, row)
      ),
    ),
  );
  type PurchaseHistoryKind = FanslyPurchaseHistoryTarget["kind"];
  // Every namespace's epoch — streak, proof attempt, storm record, owed
  // retries — read off the captures and the journaled witness pages.
  const streaks = deriveFanslyPurchaseHistoryRejectionStreaks(
    captureIndex,
    (await Promise.all(
      (await listFanslyPurchaseHistoryCaptures(
        app.db,
        input.pageContext.page.id,
        FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
      )).map((row) => resolveRawCapturePayloadRow(app, row)),
    )).flatMap((row) => {
      const probe = classifyFanslyPurchaseHistoryProbe(row);
      return probe ? [probe] : [];
    }),
    (await listFanslyPurchaseHistoryStormVerdicts(app.db, input.pageContext.page.id))
      .flatMap((verdict) =>
        verdict.kind === "single" || verdict.kind === "bundle"
          ? [{ id: verdict.id, kind: verdict.kind, syncRunId: verdict.syncRunId }]
          : []
      ),
  );
  // A verdict says the lane RAISED a storm; only the executor knows it
  // BLOCKED on it, and it says so on the record of the run that declared the
  // verdict — that run, not the newest finished one, so an older block cannot
  // vouch for a newer verdict and a run in between (a day-cap yield, a
  // transport retry) cannot erase an unblock. A run that died between verdict
  // and block is retried with no owner in the loop and must not be handed the
  // evidence target an unblock buys.
  const stormBlockRecorded: Record<PurchaseHistoryKind, boolean> = { single: false, bundle: false };
  for (const kind of ["single", "bundle"] as const) {
    const verdictRunId = streaks[kind].stormDeclared ? streaks[kind].stormVerdictRunId : null;
    if (verdictRunId === null) {
      continue;
    }
    const verdictRun = await getSyncRun(app.db, verdictRunId);
    const runError = verdictRun?.stats.error;
    stormBlockRecorded[kind] = verdictRun !== null
      && verdictRun.status === "failed"
      && verdictRun.stats.chunkStatus === "failed"
      && typeof runError === "object"
      && runError !== null
      && (runError as { code?: unknown }).code === "purchase_history_rejection_storm";
  }
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
  const chainByTargetKey = new Map(captureIndex.chains.map((chain) => [chain.targetKey, chain]));
  const keptPendingTargets = state.pendingTargets.flatMap((target) => {
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    if (target.retry) {
      // A retry (Decision 358) is owed exactly one more answer, chain or no
      // chain: served, or rejected a second time at its cursor, it is settled.
      // A chain that is resumable elsewhere re-asks its own cursor below; the
      // retry would only duplicate the pending key.
      const chain = chainByTargetKey.get(targetKey);
      if (
        chain
        && (chain.status === "resumable"
          || isServedStatus(chain.lastStatusCode)
          || chain.rejectionsAtLastCursor >= 2)
      ) {
        return [];
      }
      consumedResumableTargetKeys.add(targetKey);
      return [target];
    }
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
  const resumedContinuations = captureIndex.resumableTargets.filter((resumable) =>
    !consumedResumableTargetKeys.has(fanslyPurchaseHistoryTargetKey(resumable))
  );
  // Retries a repaired storm owes (Decision 358), read off the captures so a
  // crash between the repairing page and the checkpoint cannot lose them.
  // The queue is continuations first (the page that repaired the contract
  // finishes and becomes the witness the retries may need), then the
  // retries — a retry asked at a cursor is a re-asked rejection, not a walk in
  // progress, whatever its `before` — then fresh work: the order a run
  // without the crash produces.
  const pendingKeys = new Set(keptPendingTargets.map(fanslyPurchaseHistoryTargetKey));
  const owedRetries = [...streaks.single.owedRetries, ...streaks.bundle.owedRetries]
    .filter((retry) => !pendingKeys.has(retry.targetKey))
    .map((retry) => ({ ...retry.target, before: retry.before, retry: true as const }));
  const reconciledPendingTargets: FanslyPurchaseHistoryPendingTarget[] = [];
  // One entry per target key, first wins: the cursor parser refuses
  // duplicates, and a refused cursor would restart discovery from zero.
  {
    const seenKeys = new Set<string>();
    for (const target of [
      ...keptPendingTargets.filter((target) => target.before !== null && target.retry !== true),
      ...resumedContinuations,
      ...keptPendingTargets.filter((target) => target.retry === true),
      ...owedRetries,
      ...keptPendingTargets.filter((target) => target.before === null && target.retry !== true),
    ]) {
      const targetKey = fanslyPurchaseHistoryTargetKey(target);
      if (!seenKeys.has(targetKey)) {
        seenKeys.add(targetKey);
        reconciledPendingTargets.push(target);
      }
    }
  }
  if (JSON.stringify(reconciledPendingTargets) !== JSON.stringify(state.pendingTargets)) {
    state = { ...state, version: 5, pendingTargets: reconciledPendingTargets };
    await savePurchaseHistoryProgress();
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

  const orderHistoryRequestParams = (target: FanslyPurchaseHistoryPendingTarget) =>
    target.kind === "single"
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

  // THE REJECTION STREAK AND ITS PROOF (Decision 358). A target-local
  // rejection (404/410/422) is consumed on the provider's word: journaled,
  // marked terminal, next target. That is right for a media the creator
  // deleted and wrong for a request-shape break — the 400/code-99 drift
  // family, or a 422 Fansly started answering to everything — which looks
  // exactly the same one target at a time and would walk the whole queue
  // marking every target terminal, quietly, at the daily cap's pace. So a
  // streak of rejections in one request namespace (single media and bundles
  // are different query parameters; a break in one says nothing about the
  // other) must be PROVEN target-local before that namespace spends another
  // target: re-ask page one of a witness — a target this page already walked
  // to completion and the provider actually served. Served → the contract
  // works, the rejected media really were unservable. Rejected with a
  // member's status, or answering a malformed body → a storm vote. Rejected
  // with a DIFFERENT status → the provider tells entities apart, which is
  // evidence the contract works; no vote. Every witness voted → a storm:
  // block, fail closed, name it. The chunk budget is five requests, so a
  // proof rarely fits one run: it RESUMES — witnesses already probed since
  // the newest rejection are not asked again.
  //
  // All of it is read off the captures (`streaks`), never stored. Witness
  // pages are journaled under their own endpoint — as `purchase_history`
  // captures a newer page one would fork the witness's completed chain into
  // `cursor_conflict` — and read back into the same timeline, so a served
  // witness closes the epoch durably and a voted one is the storm's record.
  // After a storm the owner's unblock buys exactly ONE target of fresh
  // evidence: its rejection restarts the proof attempt, its served page is a
  // repair — and a repair owes the storm's members one retry each, at the
  // cursor they were rejected at.
  const servedThisRun: Record<PurchaseHistoryKind, FanslyPurchaseHistoryTarget[]> = {
    single: [],
    bundle: [],
  };
  const evidenceSpent: Record<PurchaseHistoryKind, boolean> = { single: false, bundle: false };
  const dayGated = new Set<PurchaseHistoryKind>();
  const rejectionsThisRun = new Map<string, number>();
  let probeRequests = 0;
  let probesServed = 0;
  let probesRejected = 0;
  let retriesQueued = 0;
  let deferredToNextDay = false;

  const rejectionsAtCursor = (target: FanslyPurchaseHistoryPendingTarget) => {
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    const chain = chainByTargetKey.get(targetKey);
    const durable = chain && (chain.lastRequestBefore ?? "") === (target.before ?? "")
      ? chain.rejectionsAtLastCursor
      : 0;
    return durable + (rejectionsThisRun.get(targetKey) ?? 0);
  };

  const budgetsAllowOneMore = () =>
    attemptBudget.hasCapacity()
    && input.budget.hasRequestCapacity()
    && input.budget.hasWallClockCapacity();

  const noteRejection = (target: FanslyPurchaseHistoryPendingTarget, status: number) => {
    const streak = streaks[target.kind];
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    rejectionsThisRun.set(targetKey, (rejectionsThisRun.get(targetKey) ?? 0) + 1);
    streak.members = [
      ...streak.members.filter((member) => member.targetKey !== targetKey),
      {
        target: { kind: target.kind, contentId: target.contentId },
        targetKey,
        before: target.before,
        status,
        lastCaptureId: null,
      },
    ];
    streak.count = streak.members.length;
    streak.statuses = [...new Set(streak.members.map((member) => member.status))];
    // A new rejection restarts the proof attempt; the storm record survives,
    // the verdict does not (the next storm needs its own).
    streak.probedWitnessKeys = [];
    streak.votes = 0;
    streak.votedWitnessKeys = [];
    streak.stormDeclared = false;
    // A target served earlier in this run and rejected now is no witness:
    // its newest answer is the rejection.
    servedThisRun[target.kind] = servedThisRun[target.kind].filter((served) =>
      served.contentId !== target.contentId
    );
  };

  /** A served answer closes the namespace's epoch. If a storm was voted in
   *  it, the contract is REPAIRED: the members still rejected once at their
   *  cursor are owed one retry each, returned for the caller to queue. */
  const noteServed = async (
    target: FanslyPurchaseHistoryTarget,
  ): Promise<FanslyPurchaseHistoryPendingTarget[]> => {
    const streak = streaks[target.kind];
    const pendingKeys = new Set(state.pendingTargets.map(fanslyPurchaseHistoryTargetKey));
    const retries: FanslyPurchaseHistoryPendingTarget[] = streak.stormVoted
      ? streak.members
        .filter((member) =>
          !pendingKeys.has(member.targetKey)
          && rejectionsAtCursor({ ...member.target, before: member.before }) === 1
        )
        .map((member) => ({ ...member.target, before: member.before, retry: true as const }))
      : [];
    if (retries.length > 0) {
      retriesQueued += retries.length;
      await input.telemetry.addAnomaly({
        code: "purchase_history_rejection_retry_queued",
        severity: "info",
        message:
          `Fansly served a ${target.kind} target after a rejection storm; retrying ${retries.length} target(s) rejected while the contract was broken`,
        details: {
          mediaKind: target.kind,
          contentIds: retries.map((retry) => retry.contentId),
        },
      });
    }
    streak.count = 0;
    streak.statuses = [];
    streak.members = [];
    streak.probedWitnessKeys = [];
    streak.votes = 0;
    streak.votedWitnessKeys = [];
    streak.stormVoted = false;
    streak.stormDeclared = false;
    streak.owedRetries = streak.owedRetries.filter((owed) =>
      owed.targetKey !== fanslyPurchaseHistoryTargetKey(target)
    );
    servedThisRun[target.kind].push({ kind: target.kind, contentId: target.contentId });
    return retries;
  };

  const gateRejectionStreak = async (
    kind: PurchaseHistoryKind,
  ): Promise<"proven" | "evidence" | "deferred_budget" | "deferred_day"> => {
    const streak = streaks[kind];
    // Read before any probe spends an attempt: "first call of the UTC day" is
    // the allowance for spending a target with no witness to prove against.
    const freshDay = state.callsToday === 0;
    const unproven = async (reason: string) => {
      if (freshDay && !evidenceSpent[kind]) {
        if (!budgetsAllowOneMore()) {
          return "deferred_budget" as const;
        }
        evidenceSpent[kind] = true;
        await input.telemetry.addAnomaly({
          code: "purchase_history_contract_unproven",
          severity: "warn",
          message:
            `${streak.count} consecutive ${kind} purchase-history rejections (HTTP ${streak.statuses.join("/")}) with no usable witness; spending one target as evidence`,
          details: { mediaKind: kind, reason, rejectionStreak: streak.count, statuses: streak.statuses },
        });
        return "evidence" as const;
      }
      await input.telemetry.addAnomaly({
        code: "purchase_history_contract_unproven",
        severity: "warn",
        message:
          `${streak.count} consecutive ${kind} purchase-history rejections (HTTP ${streak.statuses.join("/")}) with no usable witness; deferring the walk to the next UTC day`,
        details: { mediaKind: kind, reason, rejectionStreak: streak.count, statuses: streak.statuses },
      });
      return "deferred_day" as const;
    };

    const seen = new Set<string>();
    const pool = [
      // Served in this run first — the freshest proof there is — then the
      // durable chains, newest served page first.
      ...[...servedThisRun[kind]].reverse(),
      ...captureIndex.chains
        .filter((chain) =>
          chain.status === "complete"
          && chain.target.kind === kind
          && chain.lastServedCaptureId !== null
          && isServedStatus(chain.lastStatusCode)
        )
        .sort((left, right) => (right.lastServedCaptureId ?? 0) - (left.lastServedCaptureId ?? 0))
        .map((chain) => chain.target),
    ].filter((witness) => {
      const witnessKey = fanslyPurchaseHistoryTargetKey(witness);
      if (seen.has(witnessKey)) {
        return false;
      }
      seen.add(witnessKey);
      return true;
    }).slice(0, FANSLY_PURCHASE_HISTORY_PROOF_WITNESS_LIMIT);
    const probed = new Set(streak.probedWitnessKeys);
    const remaining = pool.filter((witness) => !probed.has(fanslyPurchaseHistoryTargetKey(witness)));

    const declareStorm = async (voted: string[]): Promise<never> => {
      // The verdict goes to the journal BEFORE the block: it is the only
      // evidence the next run has that a storm was raised and then lifted by
      // the owner (an executor retry after a crash has no such record).
      await journalPurchaseHistory(
        FANSLY_PURCHASE_HISTORY_CONTRACT_STORM_ENDPOINT,
        { mediaKind: kind },
        {
          verdict: "storm",
          mediaKind: kind,
          rejectionStreak: streak.count,
          statuses: streak.statuses,
          witnesses: voted,
        },
        { action: "journaling purchase_history rejection storm verdict" },
      );
      streak.stormDeclared = true;
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_rejection_storm",
        message:
          `Fansly rejected ${streak.count} consecutive ${kind} purchase-history targets with HTTP ${streak.statuses.join("/")} and then the served witness${voted.length === 1 ? "" : "es"} ${voted.join(", ")}; the ${kind} request contract is broken. Unblocking the stream spends one more ${kind} target as fresh evidence.`,
      });
    };

    if (streak.stormDeclared && stormBlockRecorded[kind] && !evidenceSpent[kind]) {
      // The storm was declared, the executor blocked on it, and the stream is
      // running again: the owner's unblock buys exactly one target's worth of
      // fresh evidence. Its rejection restarts the proof attempt; its served
      // page is a repair. Declared but never blocked (the run died first) is
      // no unblock: the proof below re-declares, spending nothing.
      if (!budgetsAllowOneMore()) {
        return "deferred_budget";
      }
      evidenceSpent[kind] = true;
      await input.telemetry.addAnomaly({
        code: "purchase_history_storm_evidence",
        severity: "info",
        message:
          `Resuming after a ${kind} rejection storm: spending one target as fresh evidence before re-proving the contract`,
        details: { mediaKind: kind, rejectionStreak: streak.count, statuses: streak.statuses },
      });
      return "evidence";
    }
    if (streak.votes > 0 && remaining.length === 0) {
      // Every witness answered and at least one voted, but the block never
      // landed (no verdict, or a verdict the executor never acted on): declare
      // it now, spending nothing.
      return declareStorm(streak.votedWitnessKeys);
    }
    if (pool.length === 0) {
      // No evidence is not evidence of a break. Never block on it: one target
      // per UTC day is the pace at which a page with nothing served yet may
      // find out.
      return unproven("no_witness");
    }

    const votes: string[] = [];
    const skipped: string[] = [];
    for (const witness of remaining) {
      if (!budgetsAllowOneMore()) {
        // The probes so far are journaled; the proof resumes from them.
        return "deferred_budget";
      }
      const witnessKey = fanslyPurchaseHistoryTargetKey(witness);
      const probeParams = orderHistoryRequestParams({ ...witness, before: null });
      probeRequests += 1;
      let probe: Awaited<ReturnType<AppContext["adapter"]["getMediaOrderHistoryPage"]>>;
      try {
        probe = await app.adapter.getMediaOrderHistoryPage(requestContext, probeParams);
      } catch (error) {
        const rejection = fanslyPurchaseHistoryTargetRejection(error);
        if (rejection === null) {
          throw error;
        }
        const rejectedPayload = rejectedFanslyPurchaseHistoryPayload(rejection);
        const classified = classifyFanslyPurchaseHistoryCapture({
          id: null,
          targetKey: witnessKey,
          requestBefore: null,
          statusCode: rejection.status,
          responsePayload: rejectedPayload,
        });
        if (!classified.terminal || classified.blocked) {
          // Auth, rate limit, 5xx, 400/code-99 drift: the executor's, unchanged.
          throw error;
        }
        await journalPurchaseHistory(
          FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
          probeParams,
          rejectedPayload,
          {
            action: "capturing rejected purchase_history contract probe",
            row: {
              statusCode: rejection.status,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
          },
        );
        probesRejected += 1;
        streak.probedWitnessKeys = [...streak.probedWitnessKeys, witnessKey];
        const label =
          `${witnessKey} (HTTP ${rejection.status}${rejection.details === null ? "" : `: ${rejection.details}`})`;
        if (streak.statuses.includes(rejection.status)) {
          streak.votes += 1;
          streak.votedWitnessKeys = [...streak.votedWitnessKeys, witnessKey];
          streak.stormVoted = true;
          votes.push(label);
        } else {
          // A different answer for a different entity: the provider is
          // discriminating, not broken. No vote; try the next witness.
          skipped.push(label);
        }
        continue;
      }
      await journalPurchaseHistory(
        FANSLY_PURCHASE_HISTORY_CONTRACT_PROBE_ENDPOINT,
        probeParams,
        probe.raw,
        { action: "capturing purchase_history contract probe" },
      );
      const page = classifyFanslyPurchaseHistoryCapture({
        id: null,
        targetKey: witnessKey,
        requestBefore: null,
        statusCode: null,
        responsePayload: probe.raw,
      });
      if (page.blocked) {
        // A "success" whose body is not an order-history page proves nothing,
        // exactly as it would block an ordinary target.
        probesRejected += 1;
        streak.probedWitnessKeys = [...streak.probedWitnessKeys, witnessKey];
        streak.votes += 1;
        streak.votedWitnessKeys = [...streak.votedWitnessKeys, witnessKey];
        streak.stormVoted = true;
        votes.push(`${witnessKey} (malformed body: ${page.outcome})`);
        continue;
      }
      probesServed += 1;
      const provenStreak = streak.count;
      const provenStatuses = streak.statuses;
      const repaired = streak.stormVoted;
      const retries = await noteServed(witness);
      if (retries.length > 0) {
        state = { ...state, pendingTargets: [...retries, ...state.pendingTargets] };
        await savePurchaseHistoryProgress();
      }
      await input.telemetry.addAnomaly({
        code: "purchase_history_rejection_streak_proven",
        severity: "info",
        message:
          `Fansly served completed ${kind} target ${witness.contentId}; ${provenStreak} consecutive rejections (HTTP ${provenStatuses.join("/")}) were target-local`,
        details: {
          mediaKind: kind,
          witnessContentId: witness.contentId,
          rejectionStreak: provenStreak,
          statuses: provenStatuses,
          repaired,
          retriesQueued: retries.length,
          skippedWitnesses: skipped,
        },
      });
      return "proven";
    }

    if (streak.votes > 0) {
      // Every witness of the pool has answered and at least one voted.
      return declareStorm(votes.length > 0 ? votes : streak.votedWitnessKeys);
    }
    // Every witness answered with a status other than the members': the
    // provider tells entities apart. No vote either way — same footing as no
    // witness at all.
    return unproven("witnesses_discriminated");
  };

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
  const proofStats = () => ({
    probeRequests,
    probesServed,
    probesRejected,
    retriesQueued,
    rejectionStreaks: { single: streaks.single.count, bundle: streaks.bundle.count },
  });

  while (
    attemptBudget.hasCapacity()
    && input.budget.hasRequestCapacity()
    && input.budget.hasWallClockCapacity()
  ) {
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
              ...proofStats(),
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
            version: 5,
            transactionCursorId: transactionRows.at(-1)!.id,
            pendingTargets: discovered.map((target) => ({ ...target, before: null })),
          };
          // Persist discovery BEFORE egress: a crash can only replay the safe
          // target GET, never advance the transaction cursor past lost work.
          await savePurchaseHistoryProgress();
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
              ...proofStats(),
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
          const completedAt = now;
          state = {
            ...state,
            pendingTargets: [],
            completedAt: completedAt.toISOString(),
          } as FanslyPurchaseHistoryCursorStateV5;
          await complete(input.syncRunId, completedAt);
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
              ...proofStats(),
              walkCompleted: true,
            },
          };
        }

        const rawTargets = extractFanslyPurchaseHistoryTargets(
          await Promise.all(
            rawPages.map(async (row) =>
              (await resolveRawCapturePayloadRow(app, row)).responsePayload
            ),
          ),
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
          version: 5,
          rawPayloadCursorId: rawPages.at(-1)!.id,
          pendingTargets: discovered.map((target) => ({ ...target, before: null })),
        };
        // Advance discovery and persist the whole pending batch BEFORE egress.
        // A worker crash can therefore only replay a safe GET, never lose a
        // discovered media target.
        await savePurchaseHistoryProgress();
        if (state.pendingTargets.length === 0) {
          continue;
        }
      }
    }

    const target = state.pendingTargets[0]!;
    if (streaks[target.kind].count >= FANSLY_PURCHASE_HISTORY_REJECTION_PROOF_THRESHOLD) {
      const gate = await gateRejectionStreak(target.kind);
      if (gate === "deferred_budget") {
        break;
      }
      if (gate === "deferred_day") {
        // One namespace waiting for tomorrow must not hold the other: bring
        // the first servable target of a namespace that is not gated forward.
        // Only when nothing ungated is left does the whole lane sleep.
        dayGated.add(target.kind);
        // Any namespace not yet deferred today — a gated one gets its own
        // gate (a proof, or its own deferral), so the run always either
        // spends a request or sleeps; never "runnable" with nothing to do.
        const otherIndex = state.pendingTargets.findIndex((candidate) =>
          candidate.kind !== target.kind && !dayGated.has(candidate.kind)
        );
        if (otherIndex > 0) {
          const other = state.pendingTargets[otherIndex]!;
          state = {
            ...state,
            pendingTargets: [
              other,
              ...state.pendingTargets.filter((_candidate, index) => index !== otherIndex),
            ],
          };
          await savePurchaseHistoryProgress();
          continue;
        }
        deferredToNextDay = true;
        break;
      }
      if (gate === "proven") {
        // The proof spent this iteration's attempt; re-check the budgets.
        continue;
      }
      // "evidence": the target itself is the next proof — request it. The
      // gate checked the budgets before saying so.
    }
    const targetKey = fanslyPurchaseHistoryTargetKey(target);
    const requestParams = orderHistoryRequestParams(target);
    let page: Awaited<ReturnType<AppContext["adapter"]["getMediaOrderHistoryPage"]>>;
    try {
      page = await app.adapter.getMediaOrderHistoryPage(requestContext, requestParams);
    } catch (error) {
      // A provider answer that names THIS media as the thing it cannot serve
      // is a fact about the target, not about the request contract: capture it
      // verbatim, consume the target, move on. WHICH answers count is the
      // classifier's decision on the durable payload (404/410 gone, 422 "error
      // getting account media"), so the live rejection and every replay of it
      // read the same way. Auth, rate limit, 5xx and the 400/code-99 drift
      // shape keep their stream-level classification in the executor. They are
      // not journaled here: the transport ledger already holds their bodies,
      // and a journaled non-terminal 4xx would block this stream before egress
      // until a code repair — a block no operator could lift.
      const rejection = fanslyPurchaseHistoryTargetRejection(error);
      if (rejection === null) {
        throw error;
      }
      const rejectedPayload = rejectedFanslyPurchaseHistoryPayload(rejection);
      const capture = classifyFanslyPurchaseHistoryCapture({
        id: null,
        targetKey,
        requestBefore: target.before,
        statusCode: rejection.status,
        responsePayload: rejectedPayload,
      });
      if (!capture.terminal || capture.blocked) {
        throw error;
      }
      await journalPurchaseHistory("purchase_history", requestParams, rejectedPayload, {
        action: "capturing rejected purchase_history target",
        row: {
          statusCode: rejection.status,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      noteRejection(target, rejection.status);
      await input.telemetry.addAnomaly({
        code: "purchase_history_media_rejected",
        severity: "warn",
        message: `Skipped purchase-history media after HTTP ${rejection.status}`,
        details: {
          mediaKind: target.kind,
          contentId: target.contentId,
          retry: target.retry === true,
          status: rejection.status,
          fanslyCode: rejection.code,
          fanslyDetails: rejection.details,
          outcome: capture.outcome,
          rejectionStreak: streaks[target.kind].count,
        },
      });
      pagesFetched += 1;
      targetsSkipped += 1;
      capturedTargetKeys.add(targetKey);
      capturedContentIds.add(target.contentId);
      state = { ...state, pendingTargets: state.pendingTargets.slice(1) };
      await savePurchaseHistoryProgress();
      continue;
    }
    await journalPurchaseHistory("purchase_history", requestParams, page.raw, {
      action: "inserting purchase_history raw payload",
    });

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
    // A served page is the provider's own proof that the contract works — and,
    // after a storm, that it has been repaired: the streak's members get their
    // one retry, queued right behind whatever this target still owes.
    const retries = await noteServed(target);
    state = capture.terminal
      ? { ...state, pendingTargets: [...retries, ...state.pendingTargets.slice(1)] }
      : {
        ...state,
        pendingTargets: [
          // The retry was owed at ONE cursor; the pages behind it are
          // ordinary pagination.
          { kind: target.kind, contentId: target.contentId, before: capture.nextBefore! },
          ...retries,
          ...state.pendingTargets.slice(1),
        ],
      };
    await savePurchaseHistoryProgress();
    pagesFetched += 1;
    if (capture.terminal) {
      targetsFetched += 1;
    }
    orderRowsCaptured += orderRows;
  }

  const ungatedWorkRemains = state.pendingTargets.some((candidate) => !dayGated.has(candidate.kind));
  const deferToNextDay = !attemptBudget.hasCapacity() || (deferredToNextDay && !ungatedWorkRemains);
  return {
    satisfied: false,
    yieldReason: deferToNextDay ? null : input.budget.resolveYieldReason(),
    ...(deferToNextDay
      ? {
        continuationRetryAt: nextFanslyUtcDayStart(now),
        continuationRequestSource: "scheduled" as const,
      }
      : {}),
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
      ...proofStats(),
      ...(dayGated.size > 0 ? { deferred: "contract_unproven" } : {}),
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
