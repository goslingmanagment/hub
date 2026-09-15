import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquirePageSyncLease, completePageSync, findPageById, getCheckpoint, getPageSyncState,
  PageSyncLeaseLostError, requestPageSync, retryPageSync, runWithPageSyncExecutionContext,
  startSyncRun, upsertCheckpoint,
} from "@agency_hub_core/db";
import { executeFollowersReconcileChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { followersMembershipFixture } from "./helpers/followers-membership-fixture.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
let f: Awaited<ReturnType<typeof followersMembershipFixture>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  f = await followersMembershipFixture(db);
  Object.assign(f.app.config, { fanslyFollowersSettlementReuseEnabled: true,
    fanslyFollowersSettlementReusePageAllowlist: f.page.label });
  await db.pool.query(`update page_sync_states set status = case when stream = 'followers_reconcile'
    then 'pending'::page_sync_status else 'paused'::page_sync_status end,
    succeeded_at=case when stream='followers_reconcile' then null else now() end where page_id=$1`, [f.page.id]);
});
async function acquire(token: string) {
  const lease = await acquirePageSyncLease(db.db, {
    pageId: f.page.id, workerId: "settlement-test", leaseToken: token, leaseTtlMs: 3_600_000,
  });
  if (!lease || lease.stream !== "followers_reconcile" || lease.leasedSeq === null || !lease.leaseToken) {
    throw new Error("Expected follower reconcile lease");
  }
  return { ...lease, leasedSeq: lease.leasedSeq, leaseToken: lease.leaseToken };
}
type Lease = Awaited<ReturnType<typeof acquire>>;
const owned = (lease: Lease) => ({ pageId: f.page.id, stream: lease.stream,
  requestSeq: lease.leasedSeq, leaseToken: lease.leaseToken });
const checkpoint = () => getCheckpoint(db.db, f.page.id, "followers_reconcile");
async function walk(lease: Lease) {
  const stored = await findPageById(db.db, f.page.id);
  const run = await startSyncRun(db.db, {
    platformAccountId: f.page.id, stream: "followers_reconcile", trigger: "worker",
  });
  if (!stored || !run) throw new Error("Missing run or page");
  const telemetry = new SyncRunTelemetry(f.app, { runId: run.id, platformAccountId: f.page.id,
    pageLabel: f.page.label, provider: "fansly", stream: "followers_reconcile",
    trigger: "worker", egressKey: lease.egressKey });
  return runWithPageSyncExecutionContext(owned(lease), () => executeFollowersReconcileChunk(f.app, {
    pageContext: { platform: "fansly", page: { ...stored.page, platformAccountId: "account-1" },
      session: { authorization: "test-token" }, proxy: null, egressKey: lease.egressKey },
    streamState: lease, syncRunId: run.id, telemetry, budget: new SyncChunkBudget(1),
  }));
}
async function rejectSettlement(lease: Lease) {
  await db.pool.query(`create function reject_follower_settlement() returns trigger language plpgsql
    as $$ begin if new.stream='followers_reconcile' and new.applied_seq > old.applied_seq then
      raise exception 'injected settlement failure'; end if; return new; end $$;
    create trigger reject_follower_settlement before update on page_sync_states
      for each row execute function reject_follower_settlement()`);
  try {
    await expect(completePageSync(db.db, owned(lease))).rejects.toMatchObject({
      cause: { message: "injected settlement failure" },
    });
  } finally {
    await db.pool.query(`drop trigger reject_follower_settlement on page_sync_states;
      drop function reject_follower_settlement()`);
  }
}
describe("C1 completed reconcile settlement", () => {
  it("retries a failed settlement with a new lease, preserves read time, and leaves R+1 pending", async () => {
    const first = await acquire("before-failure");
    expect(await walk(first)).toMatchObject({ satisfied: true, stats: { destructiveFinalization: true } });
    const completed = await checkpoint();
    const rows = (await db.pool.query("select * from page_follows order by id")).rows;
    await rejectSettlement(first);
    await retryPageSync(db.db, { ...owned(first), retryKind: "transport", retryAt: new Date(),
      errorCode: "injected", errorSummary: "injected settlement failure" });
    const retry = await acquire("after-failure");
    await requestPageSync(db.db, { pageId: f.page.id, streams: ["followers_reconcile"], source: "manual" });
    // A newer queue revision must not change which request the active lease owns.
    const result = await walk({ ...retry, requestSeq: retry.requestSeq + 1 });
    expect(result).toMatchObject({ satisfied: true, succeededAt: completed?.cursorLastSucceededAt,
      stats: { reusedCompletedWalk: true } });
    if (!("succeededAt" in result) || !result.succeededAt) throw new Error("Missing certified time");
    const settledAt = new Date(Date.now() + 60_000);
    expect(await completePageSync(db.db, {
      ...owned(retry), succeededAt: result.succeededAt, now: settledAt,
    })).toBe(true);
    expect(await getPageSyncState(db.db, f.page.id, "followers_reconcile")).toMatchObject({
      status: "pending", appliedSeq: retry.leasedSeq, requestSeq: retry.leasedSeq + 1,
      succeededAt: completed?.cursorLastSucceededAt, finishedAt: settledAt,
    });
    expect(f.app.adapter.getFollowersPage).not.toHaveBeenCalled();
    expect(f.app.adapter.getAccountMe).toHaveBeenCalledTimes(1);
    expect(await checkpoint()).toEqual(completed);
    expect((await db.pool.query("select * from page_follows order by id")).rows).toEqual(rows);
  });

  it("stores one explicit certification time even if the repository write happens later", async () => {
    const lease = await acquire("explicit-time");
    await walk(lease);
    const completed = await checkpoint();
    if (!completed?.state || !completed.cursorLastSucceededRunId) throw new Error("Missing completion");
    const certifiedAt = new Date(Date.now() - 60_000);
    const completion = completed.state.completion as Record<string, unknown>;
    await runWithPageSyncExecutionContext(owned(lease), () => upsertCheckpoint(db.db, {
      platformAccountId: f.page.id, stream: "followers_reconcile", now: certifiedAt,
      lastSuccessfulRunId: completed.cursorLastSucceededRunId,
      state: { ...completed.state, completion: { ...completion, completedAt: certifiedAt.toISOString() } },
    }));
    expect((await checkpoint())?.cursorLastSucceededAt).toEqual(certifiedAt);
    expect(await walk(lease)).toMatchObject({ succeededAt: certifiedAt, stats: { reusedCompletedWalk: true } });
  });

  it.each(["disabled", "unlisted", "missing-receipt"])("keeps the original path when %s", async mode => {
    const lease = await acquire("legacy");
    await walk(lease);
    if (mode === "disabled") f.app.config.fanslyFollowersSettlementReuseEnabled = false;
    if (mode === "unlisted") f.app.config.fanslyFollowersSettlementReusePageAllowlist = "different-page";
    if (mode === "missing-receipt") await db.pool.query(`update page_sync_cursors
      set state=state-'completion' where page_id=$1 and stream='followers_reconcile'`, [f.page.id]);
    expect((await walk(lease)).stats).not.toHaveProperty("reusedCompletedWalk");
    expect(f.app.adapter.getFollowersPage).toHaveBeenCalledTimes(1);
  });

  it("cannot reuse a certified result after losing its lease", async () => {
    const lease = await acquire("lost");
    await walk(lease);
    const completed = await checkpoint();
    await db.pool.query(`update page_sync_states set lease_token='replacement'
      where page_id=$1 and stream='followers_reconcile'`, [f.page.id]);
    await expect(walk(lease)).rejects.toBeInstanceOf(PageSyncLeaseLostError);
    expect(await checkpoint()).toEqual(completed);
    expect(f.app.adapter.getFollowersPage).not.toHaveBeenCalled();
  });
});
