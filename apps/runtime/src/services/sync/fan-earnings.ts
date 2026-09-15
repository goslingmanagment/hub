import {
  assertOwnedPageSyncLease, getCheckpoint, getPageSyncExecutionContext, listPageFanNativeIds,
  upsertCheckpoint, upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";
import { fanslyNewStreamAllowed, isPageAllowlisted } from "./fansly-stream-gate.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";
import { captureFanEarningsEndpoint } from "./fan-earnings-capture.ts";
import { executeFanEarningsRecovery } from "./fan-earnings-recovery.ts";
import { fanEarningsRecoveryEnabled, runFanEarningsTargetStep } from "./fan-earnings-targets.ts";

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
  if (effective.fanslyFanEarningsSyncEnabled !== true) {
    return fanslyNewStreamSkip("flag_off");
  }
  if (!fanslyNewStreamAllowed(effective.fanslyNewStreamPageAllowlist, input.pageContext.page.label)) {
    return fanslyNewStreamSkip("not_allowlisted");
  }

  if (fanEarningsRecoveryEnabled(effective, input.pageContext.page.label)) {
    return executeFanEarningsRecovery(app, { ...input, pageContext: input.pageContext });
  }

  const shadow = isPageAllowlisted(
    effective.fanslyFanEarningsShadowPageAllowlist, input.pageContext.page.label,
  );
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
  const state = checkpoint?.state as { cursorFanId?: number; completedAt?: string } | null;
  const execution = getPageSyncExecutionContext();
  if (execution?.pageId === input.pageContext.page.id && execution.stream === "fan_earnings" &&
    checkpoint?.cursorSeq === execution.requestSeq && state?.cursorFanId === 0 &&
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
  // prefix of successful fans. A fan-scoped rejection stops the walk; it may
  // never be crossed by a later success in the same keyset generation.
  let persistableCursorFanId = cursorFanId;
  let fansFetched = 0;
  let fansSkipped = 0;
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
      await captureFanEarningsEndpoint(app, {
        ...captureInput, window: "monthly",
        fetch: () => app.adapter.getEarningsMonthlyStatsAccountsPage(requestContext, {
          correlationAccountId: fan.platformUserId, ...window,
        }),
      });
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
    const progressState = {
      cursorFanId: persistableCursorFanId,
      ...(state?.completedAt ? { completedAt: state.completedAt } : {}),
    };
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
