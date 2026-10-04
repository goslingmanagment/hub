import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  lockOwnedPage,
  lockWorkRows,
  pickRequests,
  settleWork,
  upsertDemands,
  upsertFans,
  writeThreadChain,
  type Database,
  type ThreadChainState,
} from "@agency_hub_core/db";

import { admit, type CommitDeps } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  cancelHistoryRequest,
  onHistoryThreadChainChanged,
  submitHistoryRequest,
  type HistoryServiceContext,
} from "../apps/runtime/src/sync/requests/history.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { makeTestActor, seedSyncPage, testConfig } from "./helpers/sync-engine-host.ts";

// Lock order of the history requests (design §3.7, §7.1.5, SK11): intake
// takes the chats its fans reference, then its sync_work rows (id order, then
// new rows by key), then history_requests, then history_request_items; cancel
// takes its sync_work rows, then the request, then its fans — the order of
// the actor's admission (sync_pages → sync_work → requests → items) and of
// its apply (sync_pages → the chat → its own work → the hook: the chat's
// history work → requests → items), whichever DM read the apply is. Races of
// intake, cancel, admission and apply on the same chats: never a deadlock
// (40P01).

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
const FAN = "510000000000000001";
const BASE_MS = Date.now() - 6 * 3_600_000;
const msg = (k: number) => ((BigInt(BASE_MS + k * 1000 - EPOCH_MS) << 22n)).toString();
const GROUP_A = "710000000000000001";
const GROUP_B = "710000000000000002";

async function seedLivePage(): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  await testDb!.pool.query(
    `update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute',
            legacy_imported_at = clock_timestamp(), mode_changed_at = clock_timestamp() - interval '1 day'
      where page_id = $1`,
    [pageId],
  );
  return pageId;
}

/** The seeded chain grown by `k` messages above its head, confirmed now. */
function grownChain(k: number): ThreadChainState {
  return {
    epoch: 0, state: "partial", headId: msg(40 + k), headAt: new Date(), oldestId: msg(31),
    oldestCreatedAtMs: BASE_MS + 31_000, count: 10 + k, upwardCount: k, proof: null, proofWitness: null, provenAt: null,
  };
}

/** Backends of this database waiting on a lock. */
async function lockWaiters(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0]!.n;
}

async function waitForLockWaiters(n: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await lockWaiters() >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${n} backends wait on a lock`);
}

async function seedThread(pageId: number, groupId: string): Promise<number> {
  const [fan] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: `${FAN}${groupId.slice(-1)}` }]);
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            stored_message_count, message_coverage_status, is_visible, last_message_at)
     values ($1, $2, $3, $4, 10, 'partial_window', true, now()) returning id::text as id`,
    [pageId, groupId, fan!.id, fan!.platformUserId],
  );
  const threadId = Number(inserted.rows[0]!.id);
  await db().transaction(async (tx) => {
    await writeThreadChain(tx as unknown as Database, threadId, {
      source: "journal_rebuild",
      chain: {
        epoch: 0, state: "partial", headId: msg(40), headAt: new Date(Date.now() - 3_600_000), oldestId: msg(31),
        oldestCreatedAtMs: BASE_MS + 31_000, count: 10, upwardCount: 0, proof: null, proofWitness: null, provenAt: null,
      },
    });
  });
  return threadId;
}

/** A `.head` (or `.catchup`) read's apply on a chat (tx 3): the page FOR
 *  SHARE, the chain write on the chat row (the head grown by `grownBy`,
 *  confirmed at `headAt`), its own work row, then the history hook — which
 *  starts holding no `.history` row of the chat. */
async function applyHeadRead(input: {
  pageId: number;
  generation: bigint;
  threadId: number;
  headWorkId: number;
  grownBy: number;
  headAt: Date;
}): Promise<void> {
  await db().transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockOwnedPage(tx, { pageId: input.pageId, generation: input.generation, lock: "share" });
    await writeThreadChain(tx, input.threadId, { source: "engine", chain: { ...grownChain(input.grownBy), headAt: input.headAt } });
    await lockWorkRows(tx, [input.headWorkId]);
    await onHistoryThreadChainChanged(tx, { pageId: input.pageId, threadId: input.threadId });
  });
}

async function dbNow(): Promise<Date> {
  const { rows } = await testDb!.pool.query<{ now: Date }>("select clock_timestamp() as now");
  return rows[0]!.now;
}

async function headWork(pageId: number, groupId: string): Promise<number> {
  const [row] = await upsertDemands(db(), [{
    pageId, resource: "dm-messages.head", subject: groupId, kind: "trigger", class: "urgent",
  }]);
  return row!.id;
}

function isDeadlock(error: unknown): boolean {
  for (let link: unknown = error, depth = 0; link !== null && link !== undefined && depth < 6; depth += 1) {
    if ((link as { code?: unknown }).code === "40P01") return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

describe("history requests vs the actor: lock order", () => {
  it("200 rounds of intake, cancel, admission and apply on the same chats never deadlock", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const threadA = await seedThread(pageId, GROUP_A);
    const threadB = await seedThread(pageId, GROUP_B);
    const ctx: HistoryServiceContext = { db: db(), rawConfig: testConfig(testDb.connectionString) };
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const { deps } = await makeTestActor({ db: db(), pageId, registry });
    const commit: CommitDeps = deps;
    const module = await registry.module("dm-messages.history");
    const grant = { settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200, earliestMono: 0 };

    const file = (groups: readonly string[]) => submitHistoryRequest(ctx, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      // Both chats, in either order: the work rows are locked in id order
      // whatever the request's order.
      fans: groups.map((conversationRef) => ({ kind: "conversation" as const, conversationRef })),
      depth: { kind: "latest", count: 1_000 },
      reason: "lock order",
      idempotencyKey: randomUUID(),
    });

    /** One admission (tx 1) of the next requests turn, then its apply-like
     *  tx 3: page FOR SHARE → the work row → the history hook. */
    const admitAndApply = async (): Promise<string> => {
      const picked = await pickRequests(db(), { pageId });
      if (picked === null) return "idle";
      const groupId = picked.work.subject;
      const admitted = await admit(commit, {
        work: picked.work,
        workClass: "requests",
        slot: 1,
        nextCyclePos: 2,
        requestTurn: { requestId: picked.requestId, itemId: picked.itemId },
      }, { spec: "messages.page", params: { groupId, before: null } }, grant, { routeIntervalMs: 4_000, familyIntervalMs: 4_000 }, module);
      if (admitted === null) return "lost_race";
      await db().transaction(async (raw) => {
        const tx = raw as unknown as Database;
        await lockOwnedPage(tx, { pageId, generation: commit.generation, lock: "share" });
        // The read's chain write (the chat row) comes before its work row.
        const threadId = groupId === GROUP_A ? threadA : threadB;
        await writeThreadChain(tx, threadId, { source: "engine", chain: grownChain(0) });
        await lockWorkRows(tx, [picked.work.id]);
        await settleWork(tx, {
          workId: picked.work.id,
          generation: commit.generation,
          servedRevision: admitted.demandRevision,
          satisfiesRevision: false,
          nextDueAt: new Date(Date.now() - 1_000),
        });
        await onHistoryThreadChainChanged(tx, { pageId, threadId });
      });
      return "admitted";
    };

    // Each round cancels the request before the previous one: the previous
    // one keeps the chats' work rows open for the admission (a cancel that
    // closed them would leave the admission nothing to admit). A cancel that
    // closes a chat's work races in the .head tests below.
    const refs = [(await file([GROUP_A, GROUP_B])).request.ref, (await file([GROUP_B, GROUP_A])).request.ref];
    const outcomes = { deadlocks: 0, admitted: 0, cancelled: 0, filed: 0, otherErrors: [] as string[] };
    for (let round = 0; round < 200; round += 1) {
      const toCancel = refs[refs.length - 2]!;
      const results = await Promise.allSettled([
        file(round % 2 === 0 ? [GROUP_A, GROUP_B] : [GROUP_B, GROUP_A]),
        cancelHistoryRequest(ctx, toCancel, { reason: "round" }),
        admitAndApply(),
      ]);
      for (const result of results) {
        if (result.status === "fulfilled") continue;
        if (isDeadlock(result.reason)) outcomes.deadlocks += 1;
        else outcomes.otherErrors.push(String((result.reason as Error)?.message ?? result.reason));
      }
      if (results[0].status === "fulfilled") {
        outcomes.filed += 1;
        refs.push(results[0].value.request.ref);
      }
      if (results[1].status === "fulfilled" && results[1].value.disposition === "cancelled") outcomes.cancelled += 1;
      if (results[2].status === "fulfilled" && results[2].value === "admitted") outcomes.admitted += 1;
    }

    expect(outcomes.deadlocks).toBe(0);
    expect(outcomes.otherErrors).toEqual([]);
    expect(outcomes.filed).toBe(200);
    expect(outcomes.cancelled).toBe(200);
    expect(outcomes.admitted).toBeGreaterThan(0);
    // Consistency: every open fan rides on an open (or running) work row of
    // its chat, and only the last two requests are still open.
    const orphans = await testDb.pool.query(
      `select i.id from history_request_items i left join sync_work w on w.id = i.work_id
        where i.state in ('queued', 'loading', 'blocked') and (w.id is null or w.state not in ('open', 'running'))`,
    );
    expect(orphans.rows).toEqual([]);
    const open = await testDb.pool.query<{ n: number }>("select count(*)::int as n from history_requests where state = 'open'");
    expect(open.rows[0]!.n).toBe(2);
    expect((await getSyncPage(db(), pageId))!.mode).toBe("live");
  }, 300_000);

  /** Settles a promise into its value or its error, never throwing. */
  const settle = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
    promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  const failure = (outcome: { ok: boolean; error?: unknown }): string | null =>
    outcome.ok ? null : isDeadlock(outcome.error) ? "40P01" : String((outcome.error as Error)?.message ?? outcome.error);

  const fileLatest = (ctx: HistoryServiceContext, pageId: number, groups: readonly string[], count: number) =>
    submitHistoryRequest(ctx, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      fans: groups.map((conversationRef) => ({ kind: "conversation" as const, conversationRef })),
      depth: { kind: "latest", count },
      reason: "lock order",
      idempotencyKey: randomUUID(),
    });

  it("a .head read whose hook satisfies the last fan takes the chat's history work before the request: a cancel holding that work goes first", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const threadId = await seedThread(pageId, GROUP_A);
    const ctx: HistoryServiceContext = { db: db(), rawConfig: testConfig(testDb.connectionString) };
    const { generation } = await makeTestActor({ db: db(), pageId, registry: createEngineRegistry(FANSLY_RESOURCE_SPECS) });
    const headWorkId = await headWork(pageId, GROUP_A);
    // No socket: the fan has no anchor at intake; the next accepted head
    // anchors it, and 11 messages below it satisfy `latest 5`.
    const filed = await fileLatest(ctx, pageId, [GROUP_A], 5);
    expect(filed.items[0]!.state).toBe("queued");
    const { rows: [item] } = await testDb.pool.query<{ work_id: string }>("select work_id::text from history_request_items");
    const historyWorkId = Number(item!.work_id);

    // A blocker holds the chat's history work; the cancel queues on it
    // first (it then wants the request), the `.head` apply's hook second.
    const blocker = await testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from sync_work where id = $1 for update", [historyWorkId]);
      const cancel = settle(cancelHistoryRequest(ctx, filed.request.ref, { reason: "race" }));
      await waitForLockWaiters(1);
      const headAt = await dbNow();
      const apply = settle(applyHeadRead({ pageId, generation, threadId, headWorkId, grownBy: 1, headAt }));
      await waitForLockWaiters(2);
      await blocker.query("commit");
      const [cancelled, applied] = await Promise.all([cancel, apply]);
      expect([failure(cancelled), failure(applied)]).toEqual([null, null]);
      expect(cancelled.ok && cancelled.value.disposition).toBe("cancelled");
    } finally {
      blocker.release();
    }
    const { rows: works } = await testDb.pool.query<{ state: string; close_reason: string }>(
      "select state, close_reason from sync_work where id = $1", [historyWorkId]);
    expect(works).toEqual([{ state: "cancelled", close_reason: "request_cancelled" }]);
    expect((await testDb.pool.query("select state from history_request_items")).rows).toEqual([{ state: "cancelled" }]);
  }, 120_000);

  it("an intake takes the chat before the chat's work: a .head read applying on that chat meanwhile is not deadlocked", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const threadId = await seedThread(pageId, GROUP_A);
    const ctx: HistoryServiceContext = { db: db(), rawConfig: testConfig(testDb.connectionString) };
    const { generation } = await makeTestActor({ db: db(), pageId, registry: createEngineRegistry(FANSLY_RESOURCE_SPECS) });
    const headWorkId = await headWork(pageId, GROUP_A);
    const first = await fileLatest(ctx, pageId, [GROUP_A], 5);
    const { rows: [item] } = await testDb.pool.query<{ work_id: string }>("select work_id::text from history_request_items");
    const historyWorkId = Number(item!.work_id);

    // A blocker holds the chat's history work: the second intake queues on
    // it (holding the chat), then the `.head` apply on the chat row. Were the
    // chat taken only by the fans' foreign key — after the work — the intake
    // would wait for the apply's chat while the apply waits for its work.
    const blocker = await testDb.pool.connect();
    let second: Awaited<ReturnType<typeof fileLatest>> | null = null;
    try {
      await blocker.query("begin");
      await blocker.query("select id from sync_work where id = $1 for update", [historyWorkId]);
      const intake = settle(fileLatest(ctx, pageId, [GROUP_A], 5));
      await waitForLockWaiters(1);
      const headAt = await dbNow();
      const apply = settle(applyHeadRead({ pageId, generation, threadId, headWorkId, grownBy: 1, headAt }));
      await waitForLockWaiters(2);
      await blocker.query("commit");
      const [filed, applied] = await Promise.all([intake, apply]);
      expect([failure(filed), failure(applied)]).toEqual([null, null]);
      if (filed.ok) second = filed.value;
    } finally {
      blocker.release();
    }
    // The head confirmed after the first request anchors and satisfies its
    // fan; the second was filed after that head, so its fan still waits on
    // the open work.
    const { rows: requests } = await testDb.pool.query<{ ref: string; state: string }>(
      "select request_ref::text as ref, state from history_requests order by id");
    expect(requests).toEqual([{ ref: first.request.ref, state: "done" }, { ref: second!.request.ref, state: "open" }]);
    const { rows: items } = await testDb.pool.query<{ state: string; satisfied_by: string | null; work_id: string }>(
      "select state, satisfied_by, work_id::text from history_request_items order by id");
    expect(items).toEqual([
      { state: "ready", satisfied_by: "latest_n", work_id: String(historyWorkId) },
      { state: "queued", satisfied_by: null, work_id: String(historyWorkId) },
    ]);
    const { rows: works } = await testDb.pool.query<{ state: string }>("select state from sync_work where id = $1", [historyWorkId]);
    expect(works).toEqual([{ state: "open" }]);
  }, 120_000);

  it("200 rounds of intake, cancel and a .head read whose hook anchors and satisfies fans never deadlock", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const threads = new Map([[GROUP_A, await seedThread(pageId, GROUP_A)], [GROUP_B, await seedThread(pageId, GROUP_B)]]);
    const ctx: HistoryServiceContext = { db: db(), rawConfig: testConfig(testDb.connectionString) };
    const { generation } = await makeTestActor({ db: db(), pageId, registry: createEngineRegistry(FANSLY_RESOURCE_SPECS) });
    const headWorks = new Map([[GROUP_A, await headWork(pageId, GROUP_A)], [GROUP_B, await headWork(pageId, GROUP_B)]]);

    // Each round: a head read on one chat (it anchors and satisfies the fans
    // filed before it; with no newer fan on the chat its hook closes the
    // chat's work), the cancel of the request before the previous one, and
    // — two rounds in three — a new request on both chats.
    const refs = [(await fileLatest(ctx, pageId, [GROUP_A, GROUP_B], 5)).request.ref];
    const outcomes = { deadlocks: 0, filed: 0, intakes: 0, otherErrors: [] as string[] };
    for (let round = 0; round < 200; round += 1) {
      const groupId = round % 2 === 0 ? GROUP_A : GROUP_B;
      const headAt = await dbNow();
      const intake = round % 3 !== 2;
      const results = await Promise.all([
        intake
          ? settle(fileLatest(ctx, pageId, round % 2 === 0 ? [GROUP_A, GROUP_B] : [GROUP_B, GROUP_A], 5))
          : Promise.resolve(null),
        refs.length >= 2 ? settle(cancelHistoryRequest(ctx, refs[refs.length - 2]!, { reason: "round" })) : Promise.resolve(null),
        settle(applyHeadRead({
          pageId, generation, threadId: threads.get(groupId)!, headWorkId: headWorks.get(groupId)!, grownBy: round + 1, headAt,
        })),
      ]);
      for (const result of results) {
        if (result === null) continue;
        const problem = failure(result);
        if (problem === "40P01") outcomes.deadlocks += 1;
        else if (problem !== null) outcomes.otherErrors.push(problem);
      }
      if (intake) outcomes.intakes += 1;
      const filed = results[0];
      if (filed !== null && filed.ok) {
        outcomes.filed += 1;
        refs.push(filed.value.request.ref);
      }
    }

    expect(outcomes.deadlocks).toBe(0);
    expect(outcomes.otherErrors).toEqual([]);
    expect(outcomes.filed).toBe(outcomes.intakes);
    // The hook did anchor and satisfy fans, and closed chats' works, in the race.
    const satisfied = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from history_request_items where satisfied_by = 'latest_n'");
    expect(satisfied.rows[0]!.n).toBeGreaterThan(0);
    const closed = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from sync_work where resource = 'dm-messages.history' and close_reason = 'goal_satisfied'");
    expect(closed.rows[0]!.n).toBeGreaterThan(0);
    // Consistency: every open fan rides on an open work row of its chat, and
    // every open request has an open fan.
    const orphans = await testDb.pool.query(
      `select i.id from history_request_items i left join sync_work w on w.id = i.work_id
        where i.state in ('queued', 'loading', 'blocked') and (w.id is null or w.state not in ('open', 'running'))`,
    );
    expect(orphans.rows).toEqual([]);
    const stuck = await testDb.pool.query(
      `select r.id from history_requests r
        where r.state = 'open'
          and not exists (select 1 from history_request_items i
                           where i.request_id = r.id and i.state in ('queued', 'loading', 'blocked'))`,
    );
    expect(stuck.rows).toEqual([]);
  }, 300_000);
});
