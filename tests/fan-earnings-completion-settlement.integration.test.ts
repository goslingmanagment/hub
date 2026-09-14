import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquirePageSyncLease, completePageSync, deleteCheckpoints, getCheckpoint, getPageSyncState,
  PageSyncLeaseLostError, requestPageSync, retryPageSync, runWithPageSyncExecutionContext,
  scheduleDuePageSync, yieldPageSync,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { executeFanEarningsChunk } from "../apps/runtime/src/services/sync/fan-earnings.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { earningsShadowAdapter, type EarningsVisit } from "./helpers/earnings-shadow-adapter.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

let db: StartedTestDatabase;
let f: Awaited<ReturnType<typeof earningsShadowFixture>>;
let visits: EarningsVisit[];
let now: Date;
let retryAt: Date;
const oneWalk: EarningsVisit[] = ["fan-a", "fan-b"].flatMap((fanRef) => [
  { fanRef, window: "lifetime" }, { fanRef, window: "monthly" },
]);

beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await earningsShadowFixture(db, false);
  visits = [];
  f.app.adapter = earningsShadowAdapter(visits);
  now = new Date();
  retryAt = new Date(now.getTime() + 60_000);
  // Seed a quiescent page; the real scheduler admits the earnings generation.
  await db.pool.query(`update page_sync_states
    set applied_seq = request_seq, status = 'paused' where page_id = $1`, [f.page.id]);
  await db.pool.query(`update page_sync_states set status = 'idle', last_scheduled_slot = -1
    where page_id = $1 and stream = 'fan_earnings'`, [f.page.id]);
  await scheduleDuePageSync(db.db, { pageId: f.page.id, now });
});

async function acquire(token: string, at = now) {
  const lease = await acquirePageSyncLease(db.db, {
    pageId: f.page.id, workerId: "earnings-settlement-test",
    leaseToken: token, leaseTtlMs: 120_000, now: at,
  });
  if (!lease || lease.stream !== "fan_earnings" || lease.leasedSeq === null || !lease.leaseToken) {
    throw new Error("Expected the scheduled earnings lease");
  }
  return { ...lease, leasedSeq: lease.leasedSeq, leaseToken: lease.leaseToken };
}
type Lease = Awaited<ReturnType<typeof acquire>>;
const checkpoint = () => getCheckpoint(db.db, f.page.id, "fan_earnings");
const state = () => getPageSyncState(db.db, f.page.id, "fan_earnings");
const owned = (lease: Lease) => ({
  pageId: f.page.id, stream: lease.stream, requestSeq: lease.leasedSeq, leaseToken: lease.leaseToken,
});
const walk = (lease: Lease, maxRequests = 10) => runWithPageSyncExecutionContext(owned(lease),
  async () => executeFanEarningsChunk(f.app, await f.chunkInput(maxRequests)));
const settle = (lease: Lease) => completePageSync(db.db, { ...owned(lease), now });
const retry = (lease: Lease) => retryPageSync(db.db, {
  ...owned(lease), retryKind: "transport", retryAt, now,
  errorCode: "injected_settlement_failure", errorSummary: "test database settlement failed",
});
const requestNew = () => requestPageSync(db.db, {
  pageId: f.page.id, streams: ["fan_earnings"], source: "manual", now,
});

async function rejectSettlement(lease: Lease) {
  // The handler's checkpoint has committed; fail only the later settlement.
  await db.pool.query(`create function reject_earnings_settlement() returns trigger
    language plpgsql as $$ begin
      if new.stream = 'fan_earnings' and new.applied_seq > old.applied_seq then
        raise exception 'injected earnings settlement failure';
      end if;
      return new;
    end $$;
    create trigger reject_earnings_settlement before update on page_sync_states
    for each row execute function reject_earnings_settlement()`);
  try {
    await expect(settle(lease)).rejects.toMatchObject({
      cause: { message: "injected earnings settlement failure", code: "P0001" },
    });
  } finally {
    await db.pool.query(`drop trigger reject_earnings_settlement on page_sync_states;
      drop function reject_earnings_settlement()`);
  }
}

describe("earnings completion before scheduled-generation settlement", () => {
  it("admits no new generation after healthy settlement in the same slot", async () => {
    const lease = await acquire("healthy");
    expect(lease.requestSource).toBe("scheduled");
    expect(await walk(lease)).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(await settle(lease)).toBe(true);
    await scheduleDuePageSync(db.db, { pageId: f.page.id, now });
    expect(await state()).toMatchObject({
      requestSeq: lease.requestSeq, appliedSeq: lease.requestSeq,
      lastScheduledSlot: lease.lastScheduledSlot, status: "idle",
    });
    expect(visits).toEqual(oneWalk);
  });

  it("settles a failed completion without repeating requests or changing read timestamps", async () => {
    const first = await acquire("before-settlement-failure");
    await walk(first);
    const completed = await checkpoint();
    expect(completed).toMatchObject({
      cursorSeq: first.leasedSeq, state: { cursorFanId: 0, completedAt: expect.any(String) },
    });
    await rejectSettlement(first);
    expect(await state()).toMatchObject({ requestSeq: first.requestSeq, appliedSeq: first.appliedSeq });
    expect(await retry(first)).toMatchObject({ updated: true, retried: true });
    const resumed = await acquire("after-settlement-failure", retryAt);
    expect(resumed).toMatchObject({
      requestSeq: first.requestSeq, leasedSeq: first.leasedSeq, lastScheduledSlot: first.lastScheduledSlot,
    });
    expect(await walk(resumed)).toMatchObject({
      satisfied: true, stats: { fansFetched: 0, walkCompleted: true, reusedCompletedWalk: true },
    });
    expect(await checkpoint()).toEqual(completed);
    expect(await settle(resumed)).toBe(true);
    expect(visits).toEqual(oneWalk);
    const captured = await db.pool.query(`select o.kind, count(*)::int n from observations o
      where o.account_id = $1 group by o.kind order by o.kind`, [f.page.id]);
    expect(captured.rows).toEqual([
      { kind: "fan_earnings_monthly", n: 2 }, { kind: "fan_earnings_stats", n: 2 },
    ]);
  });

  it("still walks a newer request queued before the failed generation retries", async () => {
    const first = await acquire("older-request");
    await walk(first);
    await rejectSettlement(first);
    await requestNew();
    await retry(first);
    const newer = await acquire("newer-request", retryAt);
    expect(newer.leasedSeq).toBe(first.leasedSeq + 1);
    expect(await walk(newer)).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(visits).toEqual([...oneWalk, ...oneWalk]);
  });

  it("continues a positive cursor carrying the prior walk's completedAt", async () => {
    const first = await acquire("previous-walk");
    await walk(first);
    const completed = await checkpoint();
    await settle(first);
    await requestNew();
    const next = await acquire("partial-walk");
    expect(await walk(next, 2)).toMatchObject({ satisfied: false, stats: { fansFetched: 1 } });
    expect(await checkpoint()).toMatchObject({
      cursorSeq: next.leasedSeq,
      state: { cursorFanId: f.fans[0]!.id, completedAt: completed?.state?.completedAt },
    });
    await yieldPageSync(db.db, { ...owned(next), dispatchSource: "scheduled", now });
    const continuation = await acquire("continue-partial");
    expect(continuation.dispatchSource).toBe("scheduled");
    expect(await walk(continuation)).toMatchObject({ satisfied: true, stats: { fansFetched: 1 } });
    expect(visits).toEqual([...oneWalk, ...oneWalk]);
  });

  it("retries a rejected first fan without treating the prior generation as complete", async () => {
    const first = await acquire("completed-before-rejection");
    await walk(first);
    const completed = await checkpoint();
    await settle(first);
    await requestNew();
    const next = await acquire("first-fan-rejected");
    const failure = new FanslyApiError("fan rejected", 404);
    f.app.adapter = earningsShadowAdapter(visits, async () => { throw failure; });
    await expect(walk(next)).rejects.toBe(failure);
    expect(await checkpoint()).toEqual(completed);
    await retry(next);
    f.app.adapter = earningsShadowAdapter(visits);
    expect(await walk(await acquire("retry-first-fan", retryAt)))
      .toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(visits).toEqual([...oneWalk, oneWalk[0], ...oneWalk]);
  });

  it("does not reuse the checkpoint without an execution context", async () => {
    await walk(await acquire("owned-walk"));
    expect(await executeFanEarningsChunk(f.app, await f.chunkInput()))
      .toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(visits).toEqual([...oneWalk, ...oneWalk]);
  });

  it("refuses reused completion after losing the page lease", async () => {
    const lease = await acquire("lost-lease");
    await walk(lease);
    const completed = await checkpoint();
    await db.pool.query(`update page_sync_states set lease_expires_at = '2000-01-01'
      where page_id = $1 and stream = 'fan_earnings'`, [f.page.id]);
    await expect(walk(lease)).rejects.toBeInstanceOf(PageSyncLeaseLostError);
    expect(await checkpoint()).toEqual(completed);
    expect(visits).toEqual(oneWalk);
  });

  it("starts again when the completed checkpoint was removed", async () => {
    const lease = await acquire("removed-checkpoint");
    await walk(lease);
    await deleteCheckpoints(db.db, { platformAccountId: f.page.id, streams: ["fan_earnings"] });
    expect(await walk(lease)).toMatchObject({ satisfied: true, stats: { fansFetched: 2 } });
    expect(visits).toEqual([...oneWalk, ...oneWalk]);
  });
});
