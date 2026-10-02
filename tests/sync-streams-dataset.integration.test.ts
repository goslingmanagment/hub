import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AGENT_DATASET_SQL, queryAgentDataset, setPagePause, upsertDemand, type Database } from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * The agent dataset `sync_streams` (design step 3 §3.2 item 6) against a real
 * database: a page the Fansly Sync Engine owns (`handover`/`live`) reports
 * its streams from the engine's live work — each registry key counted under
 * the legacy stream it took over — instead of its frozen `page_sync_states`;
 * every other page reads exactly as before. The engine rows are read through
 * bounded per-key lookups, never by the length of the page's journal.
 */

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function streams(pageId: number) {
  const result = await queryAgentDataset(db(), {
    dataset: "sync_streams",
    pageId,
    from: new Date("2000-01-01T00:00:00Z"),
    to: new Date("2100-01-01T00:00:00Z"),
    filters: [],
    sort: null,
    limit: 100,
  });
  return new Map(result.rows.map((row) => [String(row.fields.stream), row.fields]));
}

function agoMs(value: unknown): number {
  return Date.now() - new Date(String(value)).getTime();
}

async function legacyRows(pageId: number): Promise<void> {
  for (const [stream, status, failures] of [["light", "idle", 0], ["transactions", "retrying", 4]] as const) {
    await testDb!.pool.query(
      `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds, succeeded_at,
              failed_at, consecutive_failures, updated_at)
       values ($1, $2, $3, 3600, 0, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', $4, '2026-09-01T11:00:00Z')`,
      [pageId, stream, status, failures],
    );
  }
}

/** One live attempt of a key's open row, settled onto the row the way the
 *  engine does: admission points `last_attempt_id` at it, the settle writes
 *  its error class (null once applied) into `last_error_class`. */
async function liveAttempt(
  pageId: number,
  resource: string,
  outcome: {
    subject?: string;
    appliedAgoS?: number;
    errorClass?: string;
    completedAgoS: number;
    applyState?: string;
  },
): Promise<{ workId: number; attemptId: number }> {
  const work = await upsertDemand(db(), {
    pageId,
    shadow: false,
    resource,
    subject: outcome.subject ?? "",
    kind: "poll",
    class: "planned",
  });
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, admitted_at, operation, request, outcome, http_status, error_class, sent_at,
            completed_at, apply_state, applied_at)
     values ($1, false, $2, $3, $4, 'planned', 1, 2500, 0.1, 2750,
             clock_timestamp() - $6::double precision * interval '1 second', 'polls', '{}'::jsonb, 'response', 200,
             $5, clock_timestamp() - $6::double precision * interval '1 second',
             clock_timestamp() - $6::double precision * interval '1 second', $7,
             case when $8::double precision is null then null
                  else clock_timestamp() - $8::double precision * interval '1 second' end)
     returning id`,
    [pageId, work.id, resource, outcome.subject ?? "", outcome.errorClass ?? null, outcome.completedAgoS,
      outcome.applyState ?? (outcome.appliedAgoS === undefined ? "none" : "applied"), outcome.appliedAgoS ?? null],
  );
  const attemptId = Number(inserted.rows[0]!.id);
  await testDb!.pool.query(
    "update sync_work set last_attempt_id = $2, last_error_class = $3 where id = $1",
    [work.id, attemptId, outcome.errorClass ?? null],
  );
  return { workId: work.id, attemptId };
}

async function closeWork(workId: number): Promise<void> {
  await testDb!.pool.query(
    "update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'test' where id = $1",
    [workId],
  );
}

describe("the sync_streams dataset", () => {
  it("an engine page reads its streams from the live journal; a legacy page as before", async () => {
    const handles = { db: db(), pool: testDb!.pool };
    const engine = (await seedSyncPage(handles, { label: "lilly-1" })).pageId;
    const legacy = (await seedSyncPage(handles, { label: "ari-1", mode: "shadow" })).pageId;
    await legacyRows(engine);
    await legacyRows(legacy);
    const legacyBefore = await streams(legacy);
    expect([...legacyBefore.keys()].sort()).toEqual(["light", "transactions"]);
    // While the engine does not own it, the page reads its legacy rows.
    expect([...(await streams(engine)).keys()].sort()).toEqual(["light", "transactions"]);

    await testDb!.pool.query("update sync_pages set mode = 'live' where page_id = $1", [engine]);
    // transactions: an applied insurance read, a head read refused by a 429
    // and not answered since, a rescan quarantined on its answer.
    await liveAttempt(engine, "transactions.insurance", { appliedAgoS: 300, completedAgoS: 300 });
    await liveAttempt(engine, "transactions.head", { errorClass: "rate_limit", completedAgoS: 120 });
    const rescan = await liveAttempt(engine, "transactions.rescan", { completedAgoS: 60, applyState: "quarantined" });
    await testDb!.pool.query(
      `update sync_work set state = 'quarantined', waiting_reason = 'quarantined', failure_count = 2,
              last_error_class = 'contract'
        where id = $1`,
      [rescan.workId],
    );
    // payouts: a failure the next read answered is no standing failure.
    await liveAttempt(engine, "payouts.daily", { errorClass: "server_error", completedAgoS: 900 });
    await liveAttempt(engine, "payouts.daily", { appliedAgoS: 600, completedAgoS: 600 });
    // top_spenders: applied an hour ago, nothing wrong.
    await liveAttempt(engine, "top-spenders.window", { appliedAgoS: 3_600, completedAgoS: 3_600 });
    // A subject's final 404 is an answer, not a failure.
    await liveAttempt(engine, "top-spenders.bootstrap", { errorClass: "subject_terminal", completedAgoS: 60 });
    // subscribers: a read in flight.
    await upsertDemand(db(), { pageId: engine, shadow: false, resource: "subscribers.poll", kind: "poll", class: "planned" });
    await testDb!.pool.query("update sync_work set state = 'running' where page_id = $1 and resource = 'subscribers.poll'", [engine]);
    // followers: every key of the stream paused by the owner.
    await upsertDemand(db(), { pageId: engine, shadow: false, resource: "followers.head", kind: "poll", class: "planned" });
    await setPagePause(db(), { pageId: engine, resources: ["fan-profiles.lookup", "followers.head"] });
    // dm_messages (thread keys only): a thread read applied an hour ago and
    // closed; an older one from three days ago is outside the lookup window.
    await closeWork((await liveAttempt(engine, "dm-messages.head", {
      subject: "thread-recent", appliedAgoS: 3_600, completedAgoS: 3_600,
    })).workId);
    await closeWork((await liveAttempt(engine, "dm-messages.history", {
      subject: "thread-old", appliedAgoS: 3 * 86_400, completedAgoS: 3 * 86_400,
    })).workId);
    // purchase_history (a target key only): nothing applied in the last 24 h,
    // nothing open — the engine has nothing to say about it.
    await closeWork((await liveAttempt(engine, "purchases.targets", {
      subject: "target-1", appliedAgoS: 2 * 86_400, completedAgoS: 2 * 86_400,
    })).workId);
    // The shadow journal is not the page's any more.
    await upsertDemand(db(), { pageId: engine, shadow: true, resource: "notifications.forward", kind: "poll", class: "planned" });

    const rows = await streams(engine);
    expect([...rows.keys()].sort()).toEqual(["dm_messages", "followers", "payouts", "subscribers", "top_spenders", "transactions"]);
    const transactions = rows.get("transactions")!;
    expect(transactions).toMatchObject({ syncStatus: "failed", consecutiveFailures: 2 });
    expect(transactions.succeededAt).toEqual(transactions.cursorAt);
    expect(agoMs(transactions.succeededAt)).toBeGreaterThan(290_000);
    // The newest standing failure: the quarantined rescan's answer (60 s),
    // not the head's 429 (120 s).
    expect(agoMs(transactions.failedAt)).toBeGreaterThan(55_000);
    expect(agoMs(transactions.failedAt)).toBeLessThan(110_000);
    const payouts = rows.get("payouts")!;
    expect(payouts).toMatchObject({ syncStatus: "ok", failedAt: null, consecutiveFailures: 0 });
    expect(agoMs(payouts.succeededAt)).toBeGreaterThan(590_000);
    expect(agoMs(payouts.succeededAt)).toBeLessThan(700_000);
    const topSpenders = rows.get("top_spenders")!;
    expect(topSpenders).toMatchObject({ syncStatus: "ok", failedAt: null, consecutiveFailures: 0 });
    expect(topSpenders.succeededAt).not.toBeNull();
    const dmMessages = rows.get("dm_messages")!;
    expect(dmMessages).toMatchObject({ syncStatus: "ok", failedAt: null });
    expect(agoMs(dmMessages.succeededAt)).toBeGreaterThan(3_590_000);
    expect(agoMs(dmMessages.succeededAt)).toBeLessThan(3_700_000);
    expect(rows.get("subscribers")).toMatchObject({ syncStatus: "running", succeededAt: null });
    expect(rows.get("followers")).toMatchObject({ syncStatus: "paused" });

    // The legacy page is untouched by the engine page's switch.
    expect(await streams(legacy)).toEqual(legacyBefore);
  });

  it("reads a bounded slice of the journal however long it has grown", async () => {
    const handles = { db: db(), pool: testDb!.pool };
    const small = (await seedSyncPage(handles, { label: "lilly-small", mode: "live" })).pageId;
    const large = (await seedSyncPage(handles, { label: "lilly-large", mode: "live" })).pageId;
    // The same history on both pages, twenty times longer on one: closed
    // thread reads with their (evidence, never pruned) attempts, a poll's
    // long run of applied reads, the shadow period's attempts — all older
    // than a day.
    await oldJournal(small, 150);
    await oldJournal(large, 3_000);
    // Then the same recent facts on both, and the same large active set: a
    // DM history backfill with a goal open per thread.
    const openGoals = 2_000;
    for (const pageId of [small, large]) {
      await liveAttempt(pageId, "notifications.forward", { appliedAgoS: 60, completedAgoS: 60 });
      await liveAttempt(pageId, "transactions.head", { errorClass: "rate_limit", completedAgoS: 30 });
      await closeWork((await liveAttempt(pageId, "dm-messages.head", {
        subject: "thread-recent", appliedAgoS: 1_800, completedAgoS: 1_800,
      })).workId);
      await testDb!.pool.query(
        `insert into sync_work (page_id, shadow, resource, subject, kind, class)
         select $1, false, 'dm-messages.history', 'history-' || g, 'goal', 'requests'
           from generate_series(1, $2::int) g`,
        [pageId, openGoals],
      );
    }
    await testDb!.pool.query("analyze sync_work");
    await testDb!.pool.query("analyze sync_attempts");
    const journal = await testDb!.pool.query<{ pageId: string; attempts: string }>(
      "select page_id::text as \"pageId\", count(*)::text as attempts from sync_attempts group by page_id",
    );
    const attemptsOf = new Map(journal.rows.map((row) => [Number(row.pageId), Number(row.attempts)]));
    expect(attemptsOf.get(large)!).toBeGreaterThan(9_000);

    const smallRead = await journalRowsRead(small);
    const largeRead = await journalRowsRead(large);
    // Twenty times the journal, the same rows read: a few per key, plus the
    // open goals once (the one stream their key feeds) through the open-row
    // index — never another page's rows, a closed row or an old attempt.
    expect(largeRead).toBe(smallRead);
    expect(largeRead).toBeLessThan(openGoals + 200);

    for (const pageId of [small, large]) {
      const rows = await streams(pageId);
      expect(agoMs(rows.get("notifications")!.succeededAt)).toBeLessThan(120_000);
      expect(rows.get("dm_messages")).toMatchObject({ syncStatus: "ok", consecutiveFailures: 0, failedAt: null });
      expect(agoMs(rows.get("dm_messages")!.succeededAt)).toBeLessThan(1_900_000);
      expect(agoMs(rows.get("transactions")!.failedAt)).toBeLessThan(90_000);
    }
  });
});

/** `n` closed `dm-messages.head` reads of `n` threads, each with one applied
 *  evidence attempt, `n` applied attempts of an old `notifications.forward`
 *  run, and `n` shadow attempts — every one 2–20 days old. */
async function oldJournal(pageId: number, n: number): Promise<void> {
  const pool = testDb!.pool;
  const age = "(interval '2 days' + (g % 18) * interval '1 day' + g * interval '1 second')";
  await pool.query(
    `with work as (
       insert into sync_work (page_id, shadow, resource, subject, kind, class, state, closed_at, close_reason,
                              created_at, updated_at)
       select $1, false, 'dm-messages.head', 'thread-' || g, 'trigger', 'urgent', 'done',
              now() - ${age}, 'test', now() - ${age}, now() - ${age}
         from generate_series(1, $2::int) g
       returning id, subject, closed_at
     )
     insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, admitted_at, operation, request, outcome, http_status, sent_at, completed_at,
            apply_state, applied_at, evidence)
     select $1, false, w.id, 'dm-messages.head', w.subject, 'urgent', 1, 2500, 0.1, 2750, w.closed_at,
            'messages', '{}'::jsonb, 'response', 200, w.closed_at, w.closed_at, 'applied', w.closed_at, true
       from work w`,
    [pageId, n],
  );
  const poll = await upsertDemand(db(), {
    pageId, shadow: false, resource: "notifications.forward", kind: "poll", class: "planned",
  });
  await pool.query(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, admitted_at, operation, request, outcome, http_status, sent_at, completed_at,
            apply_state, applied_at, evidence)
     select $1, false, $3, 'notifications.forward', '', 'planned', 1, 2500, 0.1, 2750, t, 'notifications',
            '{}'::jsonb, 'response', 200, t, t, 'applied', t, true
       from (select now() - ${age} as t from generate_series(1, $2::int) g) s
      order by t`,
    [pageId, n, poll.id],
  );
  await pool.query(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, admitted_at, operation, request, outcome, send_mark, sent_at, completed_at,
            apply_state)
     select $1, true, null, 'dm-messages.head', 'thread-' || g, 'urgent', 1, 2500, 0.1, 2750, now() - ${age},
            'messages', '{}'::jsonb, 'shadow', 'shadow', now() - ${age}, now() - ${age}, 'skipped'
       from generate_series(1, $2::int) g`,
    [pageId, n],
  );
}

interface PlanNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** The rows the dataset's source visits in `sync_work` and `sync_attempts`
 *  for one page — returned or filtered away — from its executed plan, under
 *  the page predicate every dataset read puts on it. */
async function journalRowsRead(pageId: number): Promise<number> {
  const source = AGENT_DATASET_SQL.sync_streams!.source;
  const result = await testDb!.pool.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (analyze, format json) with src as (${source}) select * from src where src.k_page_id = $1`,
    [pageId],
  );
  let read = 0;
  const visit = (node: PlanNode): void => {
    if (node["Relation Name"] === "sync_work" || node["Relation Name"] === "sync_attempts") {
      const perLoop = (node["Actual Rows"] ?? 0)
        + (node["Rows Removed by Filter"] ?? 0)
        + (node["Rows Removed by Index Recheck"] ?? 0);
      read += perLoop * (node["Actual Loops"] ?? 1);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
  return read;
}
