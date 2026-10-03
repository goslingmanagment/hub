import {
  assertOwnedPageSyncLease, findDurableFanEarningsRejection, getCheckpoint,
  getPageSyncExecutionContext, isFanEarningsFresh, listPageFanNativeIds, upsertCheckpoint,
  upsertCheckpointProgress, type FanEarningsRefreshWindow,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";
import { isPageAllowlisted } from "@agency_hub_core/shared";
import { evaluateFanslyStreamGate } from "./fansly-stream-gate.ts";
import { captureFanEarningsEndpoint } from "./fan-earnings-capture.ts";
import {
  executeFanEarningsRecovery, FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD,
} from "./fan-earnings-recovery.ts";
import {
  fanEarningsRecoveryEnabled, fanEarningsRosterMaxAgeMs, runFanEarningsTargetStep,
} from "./fan-earnings-targets.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

/** Deterministic rejections the legacy walk may cross in a row, with no fan
 * read successfully between them. The next one stops the walk as before: a
 * burst is a provider problem, not one fan. The run is kept in the checkpoint
 * across the walk's chunks, because a chunk (five requests by default) holds
 * only two or three fans. */
const FAN_EARNINGS_MAX_CONSECUTIVE_CROSSINGS = 3;
/** A 404 is deterministic on its endpoint's third rejected receipt in a row,
 * normally the first attempt plus the executor's two provider_404 retries of
 * the same fan. Any other receipt, such as a 5xx or timeout, resets the run. */
const REJECTED_404_RECEIPTS = 3;

function fanslyNewStreamSkip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
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
  const gate = evaluateFanslyStreamGate(effective, "fan_earnings", input.pageContext.page.label);
  if (gate.state !== "ramped") {
    return fanslyNewStreamSkip(gate.state);
  }

  if (fanEarningsRecoveryEnabled(effective, input.pageContext.page.label)) {
    return executeFanEarningsRecovery(app, { ...input, pageContext: input.pageContext });
  }

  const shadow = isPageAllowlisted(
    effective.fanslyFanEarningsShadowPageAllowlist, input.pageContext.page.label,
  );
  // Decision 368: null keeps the every-spender daily roster byte-identical.
  // Only a shadow page marks its fans dirty on a new transaction
  // (`upsertFanslyTransactionWithEarningsDirty`), so only a shadow page may
  // trust a receipt and skip — receipts alone also exist on recovery/target
  // pages, where nothing would re-read a skipped fan before the window ends.
  const rosterMaxAgeMs = shadow ? fanEarningsRosterMaxAgeMs(effective) : null;
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
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
  const state = checkpoint?.state as {
    cursorFanId?: number; completedAt?: string; crossedFans?: number;
    consecutiveCrossings?: number; qualityHold?: string;
  } | null;
  const execution = getPageSyncExecutionContext();
  const sameCompletedGeneration = execution?.pageId === input.pageContext.page.id &&
    execution.stream === "fan_earnings" && checkpoint?.cursorSeq === execution.requestSeq &&
    state?.cursorFanId === 0;
  if (sameCompletedGeneration && state.qualityHold === FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD) {
    // A walk that crossed a rejected fan committed its held completion before
    // the generation could settle. Settle it held again, without refetching.
    await assertOwnedPageSyncLease(app.db);
    return {
      satisfied: true,
      yieldReason: null,
      qualityHold: FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD,
      stats: { fansFetched: 0, walkCompleted: true, reusedCompletedWalk: true },
    };
  }
  if (sameCompletedGeneration && state.qualityHold === undefined &&
    typeof state.completedAt === "string" && Number.isFinite(Date.parse(state.completedAt))) {
    // The walk committed before its generation could settle. Keep that read's
    // timestamps and finish only this generation, without fetching it again.
    await assertOwnedPageSyncLease(app.db);
    return {
      satisfied: true,
      yieldReason: null,
      stats: { fansFetched: 0, walkCompleted: true, reusedCompletedWalk: true },
    };
  }
  await runFanEarningsTargetStep(app, { ...input, pageContext: input.pageContext });
  let cursorFanId = typeof state?.cursorFanId === "number" ? state.cursorFanId : 0;
  // A43 (W8.2): the PERSISTED cursor advances only through one contiguous
  // prefix of settled fans. A fan-scoped rejection stops the walk unless it is
  // a deterministic rejection with a durable receipt on a shadow page, which
  // the walk may cross; the crossing is counted for the whole generation.
  let persistableCursorFanId = cursorFanId;
  let crossedFans = cursorFanId > 0 && Number.isSafeInteger(state?.crossedFans)
    ? Number(state?.crossedFans) : 0;
  // Crossings in this walk since a fan was last read successfully; a retry
  // after the stop resumes the same run, so a burst stays stopped.
  let consecutiveCrossings = cursorFanId > 0 && Number.isSafeInteger(state?.consecutiveCrossings)
    ? Number(state?.consecutiveCrossings) : 0;
  let fansFetched = 0;
  let fansSkipped = 0;
  let fansFresh = 0;
  let fansCrossed = 0;
  let walkCompleted = false;
  let rejectedFanError: FanslyApiError | null = null;

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

    // A skip requests nothing, so it is a success: it belongs to the same
    // contiguous prefix and keeps the walk's keyset progress intact.
    if (rosterMaxAgeMs !== null && await isFanEarningsFresh(app.db, {
      pageId: input.pageContext.page.id,
      fanRef: fan.platformUserId,
      maxAgeMs: rosterMaxAgeMs,
      now: new Date(),
    })) {
      cursorFanId = fan.fanId;
      persistableCursorFanId = fan.fanId;
      fansFresh += 1;
      continue;
    }

    let fetchedWindow: FanEarningsRefreshWindow = "lifetime";
    const attemptStartedAt = new Date();
    try {
      const captureInput = {
        pageId: input.pageContext.page.id, syncRunId: input.syncRunId,
        fan, after: window.after, before: window.before, shadow,
      };
      await captureFanEarningsEndpoint(app, {
        ...captureInput, window: "lifetime",
        fetch: () => app.adapter.getEarningsStatsAccountsPage(requestContext, {
          correlationAccountId: fan.platformUserId, ...window,
        }),
      });
      await assertOwnedPageSyncLease(app.db);
      fetchedWindow = "monthly";
      await captureFanEarningsEndpoint(app, {
        ...captureInput, window: "monthly",
        fetch: () => app.adapter.getEarningsMonthlyStatsAccountsPage(requestContext, {
          correlationAccountId: fan.platformUserId, ...window,
        }),
      });
    } catch (error) {
      // Skipping a rejected fan would let a later success jump the durable
      // cursor over it. Only a deterministic rejection (400/410, or a 404 on
      // its endpoint's third rejected receipt in a row) whose own receipt is
      // durable, outside a provider cooldown and within the run of consecutive
      // crossings, may be crossed: the receipt keeps that endpoint as debt and
      // the generation finishes held. The crossed fan is not retried here; its
      // other endpoint is not requested. Any other rejection stops at the
      // contiguous prefix and surfaces the error.
      const fanScoped = error instanceof FanslyApiError &&
        typeof error.status === "number" &&
        [400, 404, 410].includes(error.status);
      if (!fanScoped) {
        throw error;
      }
      const rejection = shadow && error.retryAfterAt === null &&
        consecutiveCrossings < FAN_EARNINGS_MAX_CONSECUTIVE_CROSSINGS
        ? await findDurableFanEarningsRejection(app.db, {
          pageId: input.pageContext.page.id, fanRef: fan.platformUserId,
          window: fetchedWindow, since: attemptStartedAt,
        })
        : null;
      const crossed = rejection !== null &&
        (error.status !== 404 || rejection.consecutiveRejections >= REJECTED_404_RECEIPTS);
      await input.telemetry.addAnomaly({
        code: "fan_earnings_fan_rejected",
        severity: "warn",
        message: crossed
          ? `Crossed one fan after HTTP ${error.status}; its endpoint stays unconfirmed`
          : `Stopped fan-earnings walk after HTTP ${error.status} for one fan`,
        details: {
          fanId: fan.fanId,
          platformUserId: fan.platformUserId,
          status: error.status,
          fanslyCode: error.code ?? null,
          window: fetchedWindow,
          crossed,
          rejectedInRow: rejection?.consecutiveRejections ?? null,
          consecutiveCrossings: consecutiveCrossings + (crossed ? 1 : 0),
        },
      });
      fansSkipped += 1;
      if (crossed) {
        cursorFanId = fan.fanId;
        persistableCursorFanId = fan.fanId;
        fansCrossed += 1;
        crossedFans += 1;
        consecutiveCrossings += 1;
        continue;
      }
      rejectedFanError = error;
      break;
    }

    cursorFanId = fan.fanId;
    persistableCursorFanId = fan.fanId;
    fansFetched += 1;
    consecutiveCrossings = 0;
  }

  // Persist only completion or the contiguous settled prefix. If the first
  // fan rejects, leave the checkpoint untouched so retry targets that fan.
  const held = crossedFans > 0;
  if (walkCompleted && held) {
    // The roster was traversed, but crossed endpoints remain unconfirmed. Keep
    // the last certified completedAt and stamp no success or freshness.
    await upsertCheckpointProgress(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "fan_earnings",
      state: {
        cursorFanId: 0,
        ...(state?.completedAt ? { completedAt: state.completedAt } : {}),
        qualityHold: FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD,
        walkCompletedAt: new Date().toISOString(),
        crossedFans,
      },
    });
  } else if (walkCompleted) {
    await upsertCheckpoint(app.db, {
      platformAccountId: input.pageContext.page.id,
      stream: "fan_earnings",
      cursorTimestamp: new Date(),
      // A completed walk resets the cursor so the next cadence refreshes.
      state: { cursorFanId: 0, completedAt: new Date().toISOString() },
      lastSuccessfulRunId: input.syncRunId,
    });
  } else if (fansFetched > 0 || fansFresh > 0 || fansCrossed > 0) {
    const progressState = {
      cursorFanId: persistableCursorFanId,
      ...(state?.completedAt ? { completedAt: state.completedAt } : {}),
      ...(held ? { crossedFans } : {}),
      ...(consecutiveCrossings > 0 ? { consecutiveCrossings } : {}),
    };
    if (rejectedFanError || held) {
      // The prefix is durable progress, but this run is about to fail or its
      // generation will finish held. Do not stamp it as the stream's last
      // successful run/freshness marker.
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
      ...(held ? { qualityHold: FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD } : {}),
      stats: { fansFetched, fansSkipped, fansFresh, fansCrossed, walkCompleted: true },
    };
  }
  return {
    satisfied: false,
    // The walk exits on hasRequestCapacity(2) — resolve the reason against
    // the same two-call unit cost or every non-final chunk yields reasonless.
    yieldReason: input.budget.resolveYieldReason(2),
    stats: { fansFetched, fansSkipped, fansFresh, fansCrossed, cursorFanId },
  };
}
