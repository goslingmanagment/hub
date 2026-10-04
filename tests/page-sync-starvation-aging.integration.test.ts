import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  completePageSync,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getPageSyncState,
  requestPageSync,
  scheduleDuePageSync,
  yieldPageSync,
  type Database,
  type SyncRequestSource,
  type SyncStream,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";

// Ages are relative to the database clock and far from every threshold, so
// the tests hold whichever clock stamps started_at on acquisition.
interface QueueOptions {
  source?: SyncRequestSource;
  requestedAgo: string;
  startedAgo?: string;
  retryAgo?: string;
  /** A pacing deadline (a yielded continuation) rather than a failure backoff. */
  paced?: boolean;
}

describe("Fansly page stream starvation aging", () => {
  let testDb: Awaited<ReturnType<typeof startIntegrationTestDatabase>>;
  let db: Database;
  let pageId: number;
  let turn: number;

  async function createPage(create: typeof createFanslyPage, label: string) {
    const model = await createModel(db, { slug: `aging-${label}`, name: `Aging ${label}` });
    if (!model) throw new Error("Expected model fixture");
    const page = await create(db, { modelId: model.id, label });
    if (!page) throw new Error("Expected page fixture");
    await ensurePageSyncStates(db, { pageId: page.id });
    // A settled baseline: nothing runnable until a test queues it, and no
    // slot due, so a planner tick adds no work of its own.
    await testDb!.pool.query(`
      update page_sync_states set status = 'idle', applied_seq = request_seq,
        succeeded_at = clock_timestamp(), started_at = null, retry_at = null, retry_kind = null,
        blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null,
        last_scheduled_slot = 999999999999
      where page_id = $1
    `, [page.id]);
    return page.id;
  }

  beforeEach(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) throw new Error("Starvation aging acceptance requires PostgreSQL");
    db = testDb.db;
    turn = 0;
    pageId = await createPage(createFanslyPage, "fansly");
  });

  afterEach(async () => { await testDb?.stop(); });

  async function queue(stream: SyncStream, options: QueueOptions, targetPageId = pageId) {
    const updated = await testDb!.pool.query(`
      update page_sync_states
      set request_seq = applied_seq + 1,
          status = case when $6::interval is null or $7 then 'pending' else 'retrying' end::page_sync_status,
          request_source = $3::sync_request_source,
          dispatch_source = $3::sync_request_source,
          requested_at = now() - $4::interval,
          started_at = now() - $5::interval,
          retry_at = now() - $6::interval,
          retry_kind = case when $6::interval is null or $7 then null else 'transient_network' end
      where page_id = $1 and stream = $2::sync_stream
    `, [
      targetPageId,
      stream,
      options.source ?? "scheduled",
      options.requestedAgo,
      options.startedAgo ?? null,
      options.retryAgo ?? null,
      options.paced ?? false,
    ]);
    expect(updated.rowCount).toBe(1);
  }

  /** The DM history drain: runnable again right after every chunk it takes. */
  async function queueDmDrain(targetPageId = pageId) {
    await queue("dm_messages", { requestedAgo: "5 hours", startedAgo: "10 seconds" }, targetPageId);
  }

  /** One page chunk. A partial chunk leaves its stream runnable, like a long
   * walk; the DM drain is always partial. */
  async function runTurn(targetPageId = pageId, finish: "yield" | "complete" = "yield") {
    turn++;
    const lease = await acquirePageSyncLease(db, {
      platforms: EVERY_PLATFORM,
      pageId: targetPageId, workerId: `worker-${turn}`, leaseToken: `turn-${turn}`, leaseTtlMs: 60_000,
    });
    if (!lease) throw new Error("Expected runnable work");
    const settle = { pageId: targetPageId, stream: lease.stream, requestSeq: lease.leasedSeq!, leaseToken: lease.leaseToken! };
    if (finish === "complete" && lease.stream !== "dm_messages") {
      expect(await completePageSync(db, settle)).toBe(true);
    } else {
      expect(await yieldPageSync(db, { ...settle, dispatchSource: "scheduled" }))
        .toEqual({ updated: true, superseded: false });
    }
    return lease.stream;
  }

  /** The order in which queued work gets the page when every lane except the
   * DM drain finishes in one chunk. */
  async function runOrder(turns: number) {
    const order: SyncStream[] = [];
    for (let i = 0; i < turns; i++) order.push(await runTurn(pageId, "complete"));
    return order;
  }

  it("gives a starved lane one chunk during a DM drain, then resumes the drain", async () => {
    await queueDmDrain();
    await queue("notifications", { requestedAgo: "31 minutes" });

    expect(await runTurn()).toBe("notifications");
    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("dm_messages");

    // The next starvation window earns the next chunk.
    await testDb!.pool.query(`update page_sync_states set started_at = now() - interval '31 minutes'
      where page_id = $1 and stream = 'notifications'`, [pageId]);
    expect(await runTurn()).toBe("notifications");
    expect(await runTurn()).toBe("dm_messages");
  });

  it("keeps strict priority until a lane has waited out its own threshold", async () => {
    await queueDmDrain();
    await queue("notifications", { requestedAgo: "29 minutes" });
    await queue("posts", { requestedAgo: "89 minutes" });
    await queue("media_stats", { requestedAgo: "5 hours 59 minutes" });

    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("dm_messages");
  });

  it("serves the longest-starved lane first", async () => {
    await queueDmDrain();
    await queue("notifications", { requestedAgo: "31 minutes" });
    await queue("posts", { requestedAgo: "2 hours" });
    await queue("stats_snapshot", { requestedAgo: "3 hours", startedAgo: "100 minutes" });

    expect(await runOrder(4)).toEqual(["posts", "stats_snapshot", "notifications", "dm_messages"]);
  });

  it("keeps light and operator requests ahead of a starved lane", async () => {
    await queueDmDrain();
    await queue("notifications", { requestedAgo: "31 minutes" });
    await queue("transactions", { requestedAgo: "1 minute" });
    await queue("light", { requestedAgo: "1 minute" });
    // The lowest operator priority on the page.
    await requestPageSync(db, { pageId, streams: ["media_stats"], source: "manual" });

    expect(await runOrder(5)).toEqual(["light", "media_stats", "notifications", "transactions", "dm_messages"]);
  });

  it("serves a starved lane during a followers reconciliation walk too", async () => {
    await queueDmDrain();
    await queue("followers_reconcile", { requestedAgo: "2 hours", startedAgo: "20 seconds" });
    await queue("notifications", { requestedAgo: "31 minutes" });

    expect(await runTurn()).toBe("notifications");
    expect(["followers_reconcile", "dm_messages"]).toContain(await runTurn());
  });

  it("never lets a starved bulk lane pass transactions or dm_conversations", async () => {
    await queueDmDrain();
    await queue("media_stats", { requestedAgo: "7 hours" });
    await queue("catalog", { requestedAgo: "6 hours 30 minutes" });
    await queue("transactions", { requestedAgo: "1 minute" });
    await queue("dm_conversations", { requestedAgo: "1 minute" });

    expect(await runOrder(5)).toEqual(["transactions", "dm_conversations", "media_stats", "catalog", "dm_messages"]);
  });

  it("restarts the wait after a retry or pacing deadline, across planner ticks", async () => {
    await queueDmDrain();
    // Lanes last served hours ago that have just waited out a failure backoff
    // and a daily-cap pacing deadline (00:05 UTC).
    await queue("notifications", { requestedAgo: "3 hours", startedAgo: "3 hours", retryAgo: "1 minute" });
    await queue("media_stats", { requestedAgo: "11 hours", startedAgo: "11 hours", retryAgo: "1 minute", paced: true });

    // The minute planner makes them runnable but keeps the deadline they waited out.
    await scheduleDuePageSync(db, { pageId });
    expect(await getPageSyncState(db, pageId, "notifications")).toMatchObject({
      status: "pending", retryKind: null, retryAt: expect.any(Date),
    });
    expect(await getPageSyncState(db, pageId, "media_stats")).toMatchObject({
      status: "pending", retryAt: expect.any(Date),
    });
    expect(await runTurn()).toBe("dm_messages");
    await scheduleDuePageSync(db, { pageId });
    expect(await runTurn()).toBe("dm_messages");

    // A full threshold after its deadline, each lane is starved again.
    await testDb!.pool.query(`
      update page_sync_states
      set retry_at = now() - case stream when 'notifications' then interval '31 minutes'
                                          else interval '6 hours 1 minute' end
      where page_id = $1 and stream in ('notifications', 'media_stats')
    `, [pageId]);
    await scheduleDuePageSync(db, { pageId });
    expect(await runTurn()).toBe("notifications");
    expect(await runTurn()).toBe("media_stats");
    expect(await runTurn()).toBe("dm_messages");
    expect(await getPageSyncState(db, pageId, "notifications")).toMatchObject({
      status: "pending", retryAt: null, retryKind: null,
    });
  });

  it("never promotes a paused, blocked, leased or deferred lane", async () => {
    await queueDmDrain();
    await queue("notifications", { requestedAgo: "2 hours" });
    await queue("posts", { requestedAgo: "3 hours" });
    await queue("stats_snapshot", { requestedAgo: "3 hours" });
    await queue("fan_earnings", { requestedAgo: "3 hours" });
    await testDb!.pool.query(`
      update page_sync_states
      set status = case stream when 'notifications' then 'paused' else status end::page_sync_status,
          blocker_kind = case stream when 'posts' then 'manual_action_required' end,
          retry_at = case stream when 'stats_snapshot' then now() + interval '5 minutes' else retry_at end,
          leased_seq = case stream when 'fan_earnings' then request_seq end
      where page_id = $1 and stream in ('notifications', 'posts', 'stats_snapshot', 'fan_earnings')
    `, [pageId]);

    expect(await runTurn()).toBe("dm_messages");
    expect(await runTurn()).toBe("dm_messages");
  });

  it("leaves OnlyFans pages on strict priority", async () => {
    const onlyFansPageId = await createPage(createOnlyFansPage, "onlyfans");
    await queue("dm_conversations", { requestedAgo: "5 hours", startedAgo: "10 seconds" }, onlyFansPageId);
    await queue("posts", { requestedAgo: "3 hours" }, onlyFansPageId);
    expect(await runTurn(onlyFansPageId)).toBe("dm_conversations");
    expect(await runTurn(onlyFansPageId)).toBe("dm_conversations");

    // The same rows on the Fansly page: the starved lane takes its chunk.
    await queue("dm_conversations", { requestedAgo: "5 hours", startedAgo: "10 seconds" });
    await queue("posts", { requestedAgo: "3 hours" });
    expect(await runTurn()).toBe("posts");
    expect(await runTurn()).toBe("dm_conversations");
  });
});
