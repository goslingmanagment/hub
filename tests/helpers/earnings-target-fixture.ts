import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { acquireTargetedPageSyncLease, markFanEarningsDirty, runWithPageSyncExecutionContext } from "@agency_hub_core/db";
import type { FanslyRequestContext } from "@agency_hub_core/fansly";
import type { StartedTestDatabase } from "./db.ts";
import { earningsShadowFixture } from "./earnings-shadow-fixture.ts";
import { executeFanEarningsChunk } from "../../apps/runtime/src/services/sync/fan-earnings.ts";
import { runFanEarningsTargetStep } from "../../apps/runtime/src/services/sync/fan-earnings-targets.ts";

export async function earningsTargetFixture(db: StartedTestDatabase) {
  const f = await earningsShadowFixture(db);
  Object.assign(f.app.config, {
    fanslyFanEarningsTargetsEnabled: true, fanslyFanEarningsTargetsPageAllowlist: f.page.label,
    fanslyFanEarningsTargetsDailyAttemptLimit: 10,
  });
  const lease = await acquireTargetedPageSyncLease(db.db, {
    pageId: f.page.id, stream: "fan_earnings", workerId: "c2c-test", leaseToken: randomUUID(), leaseTtlMs: 120_000,
  });
  if (!lease) throw new Error("lease missing");
  const execution = { ...lease, fetchSeq: 0 };
  const owned = <T>(run: () => Promise<T>) => runWithPageSyncExecutionContext(execution, run);
  const visits: { fanRef: string; window: string }[] = [];
  const beforeDispatch = vi.fn(async () => {});
  const beforeResponse = vi.fn(async (_fanRef: string, _window: string) => {});
  const call = (window: "lifetime" | "monthly") => async (context: FanslyRequestContext, params: { correlationAccountId: string }) => {
    await beforeDispatch();
    await context.requestObserver?.onRequestEvent({ state: "started", requestId: randomUUID(), attemptNumber: 1,
      operation: window, method: "GET", endpointTemplate: "/earnings", timestamp: new Date(), pagination: null, rateLimitWaitMs: null });
    visits.push({ fanRef: params.correlationAccountId, window });
    await beforeResponse(params.correlationAccountId, window);
    const items = [{ correlationAccountId: params.correlationAccountId, type: 2110, totalGross: 100, totalNet: 80, year: 2026, month: 9 }];
    return { items, raw: items };
  };
  f.app.adapter.getEarningsStatsAccountsPage = vi.fn(call("lifetime"));
  f.app.adapter.getEarningsMonthlyStatsAccountsPage = vi.fn(call("monthly"));
  const dirty = (fanRefs = ["absent-fan"]) => markFanEarningsDirty(db.db, { pageId: f.page.id, fanRefs, now: new Date() });
  const step = async () => owned(async () => runFanEarningsTargetStep(f.app, await f.chunkInput(5)));
  const chunk = async (maxRequests = 5) => owned(async () => executeFanEarningsChunk(f.app, await f.chunkInput(maxRequests)));
  const attempts = async () => Number((await db.pool.query("select count(*) n from fan_earnings_target_attempts")).rows[0].n);
  return { ...f, execution, owned, visits, beforeDispatch, beforeResponse, dirty, step, chunk, attempts };
}
