import {
  assertOwnedPageSyncLease, countFanEarningsRecoveryDebt, getCheckpoint,
  getPageSyncExecutionContext, isFanEarningsFresh, listPageFanNativeIds,
  upsertCheckpoint, upsertCheckpointProgress,
} from "@agency_hub_core/db";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { captureFanEarningsEndpoint } from "./fan-earnings-capture.ts";
import {
  fanEarningsEffectiveMaxAgeMs, fanEarningsRosterMaxAgeMs, runFanEarningsTargetStep,
} from "./fan-earnings-targets.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import { isPageAllowlisted } from "./fansly-stream-gate.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-types.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

/** A traversed roster whose coverage is not certified: recovery debt, or a
 * legacy walk that crossed a deterministically rejected fan. */
export const FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD = "fan_earnings_unconfirmed_coverage";
const DEBT_HOLD = FAN_EARNINGS_UNCONFIRMED_COVERAGE_HOLD;

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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  };
  const config = await loadEffectiveConfig(app.db, app.config);
  // Decision 368: null keeps the every-spender recovery roster unchanged. Only a
  // shadow page marks its fans dirty on a new transaction, so only a shadow page
  // may trust a receipt and skip; recovery writes receipts without that signal.
  const rosterMaxAgeMs = isPageAllowlisted(
    config.fanslyFanEarningsShadowPageAllowlist, input.pageContext.page.label,
  ) ? fanEarningsRosterMaxAgeMs(config) : null;
  // The walk judges freshness per fan as it goes but certifies coverage once, at
  // the end. A multi-chunk walk can outlive the window it skipped under, so the
  // debt count is anchored to the walk's START: every fan read during the walk
  // was checked at or after it, and every skipped fan was inside the window at
  // that moment. Dirty, failed and claimed rows stay debt either way.
  const walkStartedAt = sameWalk && typeof state.walkStartedAt === "string"
    && Number.isFinite(Date.parse(state.walkStartedAt))
    ? state.walkStartedAt : new Date().toISOString();
  // Separate cursor field makes a disabled gate or an old binary start the
  // legacy roster from zero instead of crossing recovery's deferred fans.
  const recordCursor = (recoveryCursorFanId: number) => upsertCheckpointProgress(app.db, {
    platformAccountId: pageId, stream: "fan_earnings",
    state: { mode: "recovery", revision: execution.requestSeq, recoveryCursorFanId, walkStartedAt,
      ...(previousCompletedAt ? { completedAt: previousCompletedAt } : {}) },
  });
  let fansFetched = 0;
  let fansFresh = 0;
  let rejectedEndpoints = 0;
  let exhausted = false;
  while (input.budget.hasRequestCapacity(2) && input.budget.hasWallClockCapacity()) {
    await assertOwnedPageSyncLease(app.db);
    const [fan] = await listPageFanNativeIds(app.db, {
      platformAccountId: pageId, afterFanId: cursor, limit: 1, spendersOnly: true,
    });
    if (!fan) { exhausted = true; break; }
    // A skip requests nothing: it is durable progress, not crossed debt.
    if (rosterMaxAgeMs !== null && await isFanEarningsFresh(app.db, {
      pageId, fanRef: fan.platformUserId, maxAgeMs: rosterMaxAgeMs, now: new Date(),
    })) {
      cursor = fan.fanId;
      fansFresh++;
      await recordCursor(cursor);
      continue;
    }
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
    await recordCursor(cursor);
  }
  if (!exhausted) return {
    satisfied: false, yieldReason: input.budget.resolveYieldReason(2),
    stats: { fansFetched, fansFresh, rejectedEndpoints, recoveryCursorFanId: cursor },
  };
  const completedAt = new Date();
  // The debt window follows the roster: a spender the roster may legitimately
  // skip is covered, not unconfirmed.
  const debt = await countFanEarningsRecoveryDebt(
    app.db, pageId, new Date(walkStartedAt), fanEarningsEffectiveMaxAgeMs(config),
  );
  const completion = {
    mode: "recovery", revision: execution.requestSeq, recoveryCursorFanId: 0, walkStartedAt,
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
    stats: { fansFetched, fansFresh, rejectedEndpoints, walkCompleted: true, unconfirmedEndpoints: debt },
  };
}
