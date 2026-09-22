import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getPageSyncState,
  reclaimExpiredPageSync,
  requestPageSync,
  yieldPageSync,
  type Database,
  type SyncStream,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";

const peers = ["followers_reconcile", "dm_conversations", "dm_messages"] as const;

describe("Fansly bounded DM and reconciliation fairness", () => {
  let testDb: Awaited<ReturnType<typeof startIntegrationTestDatabase>>;
  let db: Database;
  let pageId: number;
  let turn: number;

  beforeEach(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) throw new Error("Fairness acceptance requires PostgreSQL");
    db = testDb.db;
    turn = 0;
    const model = await createModel(db, { slug: "fairness", name: "Fairness" });
    if (!model) throw new Error("Expected model fixture");
    const page = await createFanslyPage(db, { modelId: model.id, label: "fairness" });
    if (!page) throw new Error("Expected page fixture");
    pageId = page.id;
    await ensurePageSyncStates(db, { pageId });
    // A settled baseline: dependency certification must survive while each
    // stream's next generation remains pending across bounded yields.
    await testDb.pool.query(`
      update page_sync_states set status='idle', applied_seq=request_seq,
        succeeded_at=clock_timestamp(), blocker_kind=null, blocker_code=null,
        blocker_message=null, blocked_at=null
      where page_id=$1
    `, [pageId]);
    await requestPageSync(db, { pageId, streams: [...peers], source: "scheduled" });
  });

  afterEach(async () => { await testDb?.stop(); });

  async function acquire(now?: Date) {
    turn++;
    const lease = await acquirePageSyncLease(db, {
      pageId, workerId: `worker-${turn}`, leaseToken: `turn-${turn}`, leaseTtlMs: 60_000,
      ...(now ? { now } : {}),
    });
    if (!lease) throw new Error("Expected runnable work");
    return lease;
  }

  async function runTurn(now?: Date) {
    const lease = await acquire(now);
    const requestSeq = lease.leasedSeq ?? lease.requestSeq;
    expect(await yieldPageSync(db, {
      pageId, stream: lease.stream, requestSeq, leaseToken: lease.leaseToken!,
      progress: { cursor: `${lease.stream}-${turn}` }, dispatchSource: "scheduled",
    })).toEqual({ updated: true, superseded: false });
    const state = await getPageSyncState(db, pageId, lease.stream);
    expect(state).toMatchObject({
      requestSeq, appliedSeq: lease.appliedSeq, leasedSeq: null,
      progress: { cursor: `${lease.stream}-${turn}` }, status: "pending",
    });
    return lease.stream;
  }

  it("rotates all three pending streams across yields and worker restarts", async () => {
    const order: SyncStream[] = [];
    for (let i = 0; i < 9; i++) order.push(await runTurn());
    expect(order).toEqual([...peers, ...peers, ...peers]);
  });

  it("gives the event-sourced B1 lane a turn during anomaly reconciliation", async () => {
    await requestPageSync(db, { pageId, streams: ["followers_reconcile"], source: "anomaly" });
    await testDb!.pool.query(`update page_sync_states set status='idle', applied_seq=request_seq
      where page_id=$1 and stream='dm_messages'`, [pageId]);
    await requestPageSync(db, { pageId, streams: ["dm_messages"], source: "event" });
    expect(await runTurn()).toBe("followers_reconcile");
    expect(await runTurn()).toBe("dm_conversations");
    const eventLease = await acquire();
    expect(eventLease).toMatchObject({
      stream: "dm_messages", dispatchSource: "event", requestPayload: { fanslyWsHintOnly: true },
    });
    await yieldPageSync(db, {
      pageId, stream: eventLease.stream, requestSeq: eventLease.leasedSeq!,
      leaseToken: eventLease.leaseToken!, dispatchSource: "scheduled",
    });
    expect(await runTurn()).toBe("followers_reconcile");
  });

  it("does not lend a manual boost to background peers", async () => {
    await requestPageSync(db, { pageId, streams: ["dm_messages"], source: "manual" });
    await requestPageSync(db, { pageId, streams: ["subscribers"], source: "scheduled" });
    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("subscribers");
    // Leave the unrelated higher-priority work settled for the next turn.
    await testDb!.pool.query(`update page_sync_states set applied_seq=request_seq, status='idle'
      where page_id=$1 and stream='subscribers'`, [pageId]);
    expect(await runTurn()).toBe("followers_reconcile");
  });

  it("lends a recovery priority to the waiting DM peer, below explicit operator work", async () => {
    await requestPageSync(db, { pageId, streams: ["followers_reconcile"], source: "recovery" });
    await requestPageSync(db, { pageId, streams: ["followers"], source: "scheduled" });
    await testDb!.pool.query(`update page_sync_states set started_at=clock_timestamp()
      where page_id=$1 and stream='followers_reconcile'`, [pageId]);
    expect(await runTurn()).toBe("dm_conversations");
  });

  it("lets unrelated work win a mixed-source equal-priority tie", async () => {
    await requestPageSync(db, { pageId, streams: ["dm_conversations"], source: "recovery" });
    await testDb!.pool.query(`update page_sync_states set started_at=clock_timestamp()
      where page_id=$1 and stream=any($2::sync_stream[])`, [pageId, peers]);
    await requestPageSync(db, { pageId, streams: ["subscribers"], source: "scheduled" });
    expect(await runTurn()).toBe("subscribers");
  });

  it("uses database service time when worker clocks disagree", async () => {
    expect(await runTurn(new Date("2099-01-01"))).toBe("followers_reconcile");
    const state = await getPageSyncState(db, pageId, "followers_reconcile");
    expect(state!.startedAt!.getTime()).toBeLessThan(new Date("2099-01-01").getTime());
    expect(await runTurn(new Date("2000-01-01"))).toBe("dm_conversations");
    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("followers_reconcile");
  });

  it("keeps a new manual generation boosted and does not let an older yield consume it", async () => {
    const lease = await acquire();
    expect(lease.stream).toBe("followers_reconcile");
    await requestPageSync(db, { pageId, streams: [lease.stream], source: "manual" });
    expect(await yieldPageSync(db, {
      pageId, stream: lease.stream, requestSeq: lease.leasedSeq!,
      leaseToken: lease.leaseToken!, dispatchSource: "scheduled",
    })).toEqual({ updated: true, superseded: true });
    expect(await runTurn()).toBe("followers_reconcile");
    expect(await runTurn()).toBe("dm_conversations");
    expect(await runTurn()).toBe("dm_messages");
  });

  it.each(["paused", "blocked", "retry", "leased", "settled"])(
    "ignores an unavailable %s peer and alternates the others", async (condition) => {
      const updates: Record<string, string> = {
        paused: "status='paused'",
        blocked: "status='blocked', blocker_kind='dependency'",
        retry: "retry_at=clock_timestamp()+interval '1 hour'",
        leased: "status='running', leased_seq=request_seq, lease_owner='peer-worker', lease_token='peer', lease_heartbeat_at=clock_timestamp(), lease_expires_at=clock_timestamp()+interval '1 hour'",
        settled: "status='idle', applied_seq=request_seq",
      };
      await testDb!.pool.query(`update page_sync_states set ${updates[condition]} where page_id=$1 and stream='followers_reconcile'`, [pageId]);
      expect(await runTurn()).toBe("dm_conversations");
      expect(await runTurn()).toBe("dm_messages");
      expect(await runTurn()).toBe("dm_conversations");
    },
  );

  it("retains unrelated higher priorities and a lone peer's original priority", async () => {
    await requestPageSync(db, { pageId, streams: ["transactions"], source: "scheduled" });
    expect(await runTurn()).toBe("transactions");
    await testDb!.pool.query(`update page_sync_states set status='idle', applied_seq=request_seq
      where page_id=$1 and stream <> 'dm_messages'`, [pageId]);
    await requestPageSync(db, { pageId, streams: ["fan_earnings"], source: "recovery" });
    expect(await runTurn()).toBe("fan_earnings");
    expect(await runTurn()).toBe("dm_messages");
  });

  it("counts an expired attempt as a turn and preserves fencing", async () => {
    const oldLease = await acquire();
    await testDb!.pool.query(`update page_sync_states set lease_expires_at=clock_timestamp()-interval '1 second'
      where page_id=$1 and stream=$2`, [pageId, oldLease.stream]);
    await reclaimExpiredPageSync(db);
    expect(await yieldPageSync(db, {
      pageId, stream: oldLease.stream, requestSeq: oldLease.leasedSeq!,
      leaseToken: oldLease.leaseToken!,
    })).toEqual({ updated: false, superseded: false });
    expect(await runTurn()).toBe("dm_conversations");
    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("followers_reconcile");
  });

  it("does not borrow priorities on OnlyFans or inactive pages", async () => {
    await testDb!.pool.query("update pages set platform='onlyfans' where id=$1", [pageId]);
    expect(await runTurn()).toBe("followers_reconcile");
    expect(await runTurn()).toBe("followers_reconcile");
    await testDb!.pool.query("update pages set status='deleted' where id=$1", [pageId]);
    expect(await acquirePageSyncLease(db, {
      pageId, workerId: "inactive", leaseToken: "inactive", leaseTtlMs: 60_000,
    })).toBeNull();
  });
});
