import {
  assertOwnedPageSyncLease, countFanEarningsRecoveryDebt, getCheckpoint,
  getPageSyncExecutionContext, listPageFanNativeIds, upsertCheckpoint, upsertCheckpointProgress,
} from "@agency_hub_core/db";
import type { AppContext } from "../../bootstrap.ts";
import { captureFanEarningsEndpoint } from "./fan-earnings-capture.ts";
import { FAN_EARNINGS_RECOVERY_MAX_AGE_MS, runFanEarningsTargetStep } from "./fan-earnings-targets.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";

const DEBT_HOLD = "fan_earnings_unconfirmed_coverage";

/** The independent daily roster still runs. A failed endpoint can be crossed
 * only after its own durable receipt; crossing never certifies that endpoint. */
export async function executeFanEarningsRecovery(app: AppContext, input: ExecutorRequestContext & {
  syncRunId: number;
  pageContext: Extract<ExecutorRequestContext["pageContext"], { platform: "fansly" }>;
}): Promise<StreamChunkResult> {
  const pageId = input.pageContext.page.id;
  const execution = getPageSyncExecutionContext();
  if (!execution || execution.pageId !== pageId || execution.stream !== "fan_earnings") {
    throw new Error("fan_earnings_recovery_page_lease_required");
  }
  await assertOwnedPageSyncLease(app.db);
  const checkpoint = await getCheckpoint(app.db, pageId, "fan_earnings");
  const state = checkpoint?.state;
  const sameWalk = state?.mode === "recovery" && state.revision === execution.requestSeq
    && checkpoint?.cursorSeq === execution.requestSeq;
  const finishedAt = sameWalk && typeof state.walkCompletedAt === "string"
    ? new Date(state.walkCompletedAt) : null;
  if (finishedAt && Number.isFinite(finishedAt.getTime()) && finishedAt.getTime() <= Date.now()
    && (state?.qualityHold === DEBT_HOLD || (state?.completionRunId === checkpoint?.cursorLastSucceededRunId
      && finishedAt.getTime() === checkpoint?.cursorLastSucceededAt?.getTime()))) {
    await assertOwnedPageSyncLease(app.db);
    return {
      satisfied: true, yieldReason: null,
      ...(state?.qualityHold === DEBT_HOLD ? { qualityHold: DEBT_HOLD } : { succeededAt: finishedAt }),
      stats: { fansFetched: 0, reusedCompletedWalk: true, walkCompleted: true },
    };
  }
  await runFanEarningsTargetStep(app, input);
  let cursor = sameWalk && Number.isSafeInteger(state.recoveryCursorFanId)
    && Number(state.recoveryCursorFanId) >= 0 ? Number(state.recoveryCursorFanId) : 0;
  const previousCompletedAt = typeof state?.completedAt === "string" ? state.completedAt : undefined;
  const context = {
    session: input.pageContext.session, proxy: input.pageContext.proxy, egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(input.telemetry.getRequestObserver(), input.budget),
    rateLimitWaiter: createPageRateLimitWaiter(app, input.pageContext),
  };
  let fansFetched = 0;
  let rejectedEndpoints = 0;
  let exhausted = false;
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const [fan] = await listPageFanNativeIds(app.db, {
      platformAccountId: pageId, afterFanId: cursor, limit: 1, spendersOnly: true,
    });
    if (!fan) { exhausted = true; break; }
    const window = { after: new Date(0), before: new Date() };
    for (const endpoint of ["lifetime", "monthly"] as const) {
      await assertOwnedPageSyncLease(app.db);
      const result = await captureFanEarningsEndpoint(app, {
        pageId, syncRunId: input.syncRunId, fan, ...window, window: endpoint,
        shadow: false, isolateRejection: true,
        fetch: () => endpoint === "lifetime"
          ? app.adapter.getEarningsStatsAccountsPage(context, { correlationAccountId: fan.platformUserId, ...window })
          : app.adapter.getEarningsMonthlyStatsAccountsPage(context, { correlationAccountId: fan.platformUserId, ...window }),
      });
      if (result.outcome === "rejected") rejectedEndpoints++;
    }
    cursor = fan.fanId;
    fansFetched++;
    // Separate cursor field makes a disabled gate or an old binary start the
    // legacy roster from zero instead of crossing recovery's deferred fans.
    await upsertCheckpointProgress(app.db, {
      platformAccountId: pageId, stream: "fan_earnings",
      state: { mode: "recovery", revision: execution.requestSeq, recoveryCursorFanId: cursor,
        ...(previousCompletedAt ? { completedAt: previousCompletedAt } : {}) },
    });
  }
  if (!exhausted) return {
    satisfied: false, yieldReason: input.budget.resolveYieldReason(2),
    stats: { fansFetched, rejectedEndpoints, recoveryCursorFanId: cursor },
  };
  const completedAt = new Date();
  const debt = await countFanEarningsRecoveryDebt(app.db, pageId, completedAt, FAN_EARNINGS_RECOVERY_MAX_AGE_MS);
  const completion = {
    mode: "recovery", revision: execution.requestSeq, recoveryCursorFanId: 0,
    walkCompletedAt: completedAt.toISOString(), completionRunId: input.syncRunId,
    ...(debt ? { qualityHold: DEBT_HOLD, ...(previousCompletedAt ? { completedAt: previousCompletedAt } : {}) }
      : { completedAt: completedAt.toISOString() }),
  };
  if (debt) await upsertCheckpointProgress(app.db, {
    platformAccountId: pageId, stream: "fan_earnings", state: completion,
  });
  else await upsertCheckpoint(app.db, {
    platformAccountId: pageId, stream: "fan_earnings", state: completion,
    now: completedAt, cursorTimestamp: completedAt, lastSuccessfulRunId: input.syncRunId,
  });
  return {
    satisfied: true, yieldReason: null,
    ...(debt ? { qualityHold: DEBT_HOLD } : { succeededAt: completedAt }),
    stats: { fansFetched, rejectedEndpoints, walkCompleted: true, unconfirmedEndpoints: debt },
  };
}
