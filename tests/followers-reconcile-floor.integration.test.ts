import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquirePageSyncLease, ensurePageSyncStates, getCheckpoint, getFanslySyncLiveness, getPageSyncState,
  listRunnablePageSync, requestPageSync, upsertCheckpointProgress, upsertFans, upsertPageFollow,
} from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { getSyncMonitorSnapshot } from "../apps/runtime/src/services/sync-monitor.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FLOOR = "followers_reconcile_min_interval";
// Walk 40 finished five hours ago. "gone" unfollowed before it began and
// survived it on the two-walk grace; "stay" still follows.
const LAST_REVISION = 7;
const LAST_GENERATION = 40;
const FANS = { stay: "700000000000000002", gone: "700000000000000001" } as const;
const FOLLOWS = { stay: "800000000000000002", gone: "800000000000000001" } as const;

describe("followers_reconcile daily floor", () => {
  let db: StartedTestDatabase;
  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

  async function fixture() {
    const walkStartedAt = new Date(Date.now() - 5 * HOUR_MS);
    const account = {
      id: "account-1", username: "lora", displayName: "Lora", createdAt: 1_700_000_000_000,
      followCount: 1, subscriberCount: 0,
    };
    const getAccountMe = vi.fn(async () => ({ parsed: { account }, raw: { account } }));
    const follower = { id: FOLLOWS.stay, followerId: FANS.stay, lastSeenAt: Date.now() };
    const accounts = [{
      id: FANS.stay, username: "stay", displayName: "Stay", createdAt: 1_770_000_000_000, lastSeenAt: Date.now(),
    }];
    const getFollowersPage = vi.fn(async () => ({
      items: [follower], accounts, offset: 0, done: true,
      raw: { data: [follower], aggregationData: { accounts } },
    }));
    const getAccountsByIdsPage = vi.fn(async (_context: unknown, ids: string[]) => ({
      parsed: ids.map((id) => ({ id, username: id, displayName: null, createdAt: 1_770_000_000_000 })),
      raw: {},
    }));
    const app = createTestAppContext(db, {
      adapter: { getAccountMe, getFollowersPage, getAccountsByIdsPage } as unknown as AppContext["adapter"],
      fanslyDefaultDelayMs: 0,
      followerPageDelayMs: 0,
    });
    const { page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, "lora-1");
    if (!page) throw new Error("test setup: page missing");
    await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    await db.pool.query("update pages set external_page_id='account-1' where id=$1", [page.id]);
    await ensurePageSyncStates(app.db, { pageId: page.id });
    await db.pool.query(`update page_sync_states set status='paused', succeeded_at=now()
      where page_id=$1 and stream <> 'followers_reconcile'`, [page.id]);
    await db.pool.query(`update page_sync_states
      set status='idle', request_seq=$2, applied_seq=$2, request_source='anomaly', dispatch_source='anomaly',
          requested_at=$3, retry_at=null, retry_kind=null, succeeded_at=$4
      where page_id=$1 and stream='followers_reconcile'`,
    [page.id, LAST_REVISION, walkStartedAt, new Date(walkStartedAt.getTime() + 10 * 60_000)]);
    await upsertCheckpointProgress(app.db, {
      platformAccountId: page.id, stream: "followers_reconcile",
      state: {
        revision: LAST_REVISION, generation: LAST_GENERATION, fullSweepStartedAt: walkStartedAt.toISOString(),
        offset: 0, observedCount: 1, pageCount: 1, sourceFollowerCount: 1, snapshotRestartCount: 0,
        verificationPending: false,
      },
    });
    for (const [who, generation] of [["stay", LAST_GENERATION], ["gone", LAST_GENERATION - 1]] as const) {
      const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: FANS[who] }]);
      if (!fan) throw new Error("test setup: fan missing");
      await upsertPageFollow(app.db, {
        platformAccountId: page.id, fanId: fan.id, platformFollowId: FOLLOWS[who],
        followedAt: new Date("2026-08-01T00:00:00.000Z"), lastSeenGeneration: generation,
      });
    }
    await db.pool.query("update page_follows set last_seen_at=$2 where platform_account_id=$1",
      [page.id, new Date(walkStartedAt.getTime() - HOUR_MS)]);
    return { app, page, walkStartedAt, getAccountMe, getFollowersPage };
  }

  const reconcileState = (pageId: number) => getPageSyncState(db.db, pageId, "followers_reconcile");
  const anomaly = (pageId: number) => requestPageSync(db.db, {
    pageId, streams: ["followers_reconcile"], source: "anomaly", includeQueueState: true, coalesceOutstanding: true,
  });
  const follows = async (pageId: number) => (await db.pool.query<{ id: string; active: boolean; generation: number }>(
    `select platform_follow_id as id, is_active as active, last_seen_generation::int as generation
     from page_follows where platform_account_id=$1 order by platform_follow_id`, [pageId])).rows;

  async function lastRun(pageId: number) {
    const run = (await db.pool.query<{ id: number; outcome: string; stats: Record<string, unknown> }>(
      `select id, outcome, stats from sync_runs where page_id=$1 and stream='followers_reconcile'
       order by id desc limit 1`, [pageId])).rows[0];
    if (!run) throw new Error("no followers_reconcile run");
    const attempts = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from sync_http_attempts where sync_run_id=$1", [run.id]);
    return { ...run, httpAttempts: attempts.rows[0]?.n };
  }

  async function runUntilSettled(app: AppContext, pageId: number) {
    for (let chunk = 0; chunk < 10; chunk += 1) {
      const state = await reconcileState(pageId);
      if (state && state.requestSeq === state.appliedSeq) return;
      await executeNextSyncPageChunk(app, pageId);
    }
    throw new Error("followers_reconcile did not settle in ten chunks");
  }

  it("holds the next walk a day from the last one's start, keeps it through repeats, then retires the unfollower", async () => {
    const f = await fixture();
    const until = new Date(f.walkStartedAt.getTime() + DAY_MS);
    const [requested] = await anomaly(f.page.id);
    expect(requested).toMatchObject({ requestedSeq: LAST_REVISION + 1 });

    const deferred = await executeNextSyncPageChunk(f.app, f.page.id);

    expect(deferred).toMatchObject({ kind: "yielded", stream: "followers_reconcile" });
    expect(f.getAccountMe).not.toHaveBeenCalled();
    expect(f.getFollowersPage).not.toHaveBeenCalled();
    expect(await lastRun(f.page.id)).toMatchObject({
      outcome: "partial", httpAttempts: 0,
      stats: { deferral: FLOOR, followersReconcileFloorUntil: until.toISOString() },
    });
    expect(await reconcileState(f.page.id)).toMatchObject({
      status: "pending", requestSeq: LAST_REVISION + 1, appliedSeq: LAST_REVISION, retryAt: until,
      requestSource: "anomaly", consecutiveFailures: 0, lastErrorCode: null,
    });
    expect((await getCheckpoint(db.db, f.page.id, "followers_reconcile"))?.state)
      .toMatchObject({ revision: LAST_REVISION, generation: LAST_GENERATION });

    // The next hourly mismatch folds into the held request; nothing is lost or re-dated.
    expect(await anomaly(f.page.id)).toEqual([expect.objectContaining({
      requestedSeq: LAST_REVISION + 1, coalesced: true,
    })]);
    expect(await reconcileState(f.page.id)).toMatchObject({ requestSeq: LAST_REVISION + 1, retryAt: until });

    // Nothing may lease, list or count it as due before the floor ends.
    const now = new Date();
    expect((await listRunnablePageSync(db.db, now)).filter((row) => row.pageId === f.page.id)).toEqual([]);
    expect(await acquirePageSyncLease(db.db, {
      pageId: f.page.id, workerId: "floor-test", leaseToken: "floor-test", leaseTtlMs: 60_000,
    })).toBeNull();
    expect((await getFanslySyncLiveness(db.db, { since: new Date(now.getTime() - HOUR_MS), dueBefore: now }))
      .hasDueStream).toBe(false);
    expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "idle" });

    // The readers find the marker where the executor wrote it.
    const monitored = (await getSyncMonitorSnapshot(f.app, { pageIds: [f.page.id] })).pages[0]?.streams
      .find((row) => row.stream === "followers_reconcile");
    expect(monitored).toMatchObject({ pending: false, syncUx: { state: "healthy" } });
    const audience = (await getSyncStatusSnapshot(f.app, { pageIds: [f.page.id] })).pages[0]?.blocks.audience;
    expect(audience?.substreams.find((row) => row.stream === "followers_reconcile")).toMatchObject({
      state: "scheduled", needsAttention: false, nextRetryAt: null, statusReason: { code: FLOOR },
    });

    // A day after walk 40 began: move its start back and let the held deadline pass.
    await db.pool.query(`update page_sync_cursors
      set state = jsonb_set(state, '{fullSweepStartedAt}', to_jsonb($2::text))
      where page_id=$1 and stream='followers_reconcile'`,
    [f.page.id, new Date(Date.now() - DAY_MS - HOUR_MS).toISOString()]);
    await db.pool.query(`update page_sync_states set retry_at=now() - interval '1 second'
      where page_id=$1 and stream='followers_reconcile'`, [f.page.id]);

    await runUntilSettled(f.app, f.page.id);

    expect((await getCheckpoint(db.db, f.page.id, "followers_reconcile"))?.state)
      .toMatchObject({ revision: LAST_REVISION + 1, generation: LAST_GENERATION + 1 });
    expect(await follows(f.page.id)).toEqual([
      { id: FOLLOWS.gone, active: false, generation: LAST_GENERATION - 1 },
      { id: FOLLOWS.stay, active: true, generation: LAST_GENERATION + 1 },
    ]);
    expect(await reconcileState(f.page.id)).toMatchObject({
      status: "idle", appliedSeq: LAST_REVISION + 1, retryAt: null,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("walks at once when a manual request arrives during the hold", async () => {
    const f = await fixture();
    await anomaly(f.page.id);
    await executeNextSyncPageChunk(f.app, f.page.id);
    expect(await reconcileState(f.page.id)).toMatchObject({ status: "pending", requestSeq: LAST_REVISION + 1 });

    await requestPageSync(db.db, { pageId: f.page.id, streams: ["followers_reconcile"], source: "manual" });
    expect(await reconcileState(f.page.id)).toMatchObject({
      status: "pending", requestSeq: LAST_REVISION + 2, retryAt: null,
    });
    await runUntilSettled(f.app, f.page.id);

    expect(f.getAccountMe).toHaveBeenCalled();
    expect(f.getFollowersPage).toHaveBeenCalledTimes(1);
    expect((await getCheckpoint(db.db, f.page.id, "followers_reconcile"))?.state)
      .toMatchObject({ revision: LAST_REVISION + 2, generation: LAST_GENERATION + 1 });
    expect(await follows(f.page.id)).toEqual([
      { id: FOLLOWS.gone, active: false, generation: LAST_GENERATION - 1 },
      { id: FOLLOWS.stay, active: true, generation: LAST_GENERATION + 1 },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
