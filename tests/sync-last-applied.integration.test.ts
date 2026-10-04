import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SYNC_LAST_APPLIED_ACTIVE_ROWS,
  SYNC_LAST_APPLIED_RECENT_ROWS,
  lastLiveAppliedAtByResource,
  lastLiveAppliedAtOverSubjects,
  type Database,
} from "@agency_hub_core/db";

import {
  SUBJECT_LEVEL_LEVER_KEYS,
  engineStreamState,
  readEngineStatusFacts,
} from "../apps/runtime/src/services/sync-status-engine.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * "Last read" of a stream whose work is per subject (step 4, S4-34a).
 *
 * `dm_messages` is read chat by chat and `purchase_history` target by target:
 * their keys have a row per subject and none for the page, so the status
 * reader — which knew only page-level keys — said "never read" of a stream
 * read a minute ago. A key's last read is now its newest applied attempt over
 * all its subjects, and the read stays bounded: a few of the key's rows, a
 * read along `sync_attempts_work` for each, whatever the number of subjects.
 */

const HEAD = "dm-messages.head";
const HISTORY = "dm-messages.history";
const TARGETS = "purchases.targets";
const T0 = Date.parse("2026-10-04T08:00:00.000Z");
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

let testDb: StartedTestDatabase | null = null;
let pageId = 0;
let otherPageId = 0;

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
  const handles = { db: db(), pool: testDb.pool };
  pageId = (await seedSyncPage(handles, { label: "lora-1", mode: "live" })).pageId;
  otherPageId = (await seedSyncPage(handles, { label: "lora-2", mode: "live" })).pageId;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

type WorkState = "open" | "running" | "quarantined" | "done";

/** A work row of a key for one subject. */
async function work(
  resource: string,
  subject: string,
  options: { state?: WorkState; shadow?: boolean; page?: number } = {},
): Promise<number> {
  const state = options.state ?? "done";
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, closed_at, close_reason)
     values ($1, $2, $3, $4, 'trigger', 'urgent', $5,
             case when $5 = 'done' then clock_timestamp() end, case when $5 = 'done' then 'served' end)
     returning id::text`,
    [options.page ?? pageId, options.shadow ?? false, resource, subject, state],
  );
  return Number(result.rows[0]!.id);
}

/** An attempt of a work row, the row's newest: applied at `appliedAt`, or
 *  (null) a request that failed. */
async function attempt(
  workId: number,
  appliedAt: Date | null,
  options: { shadow?: boolean } = {},
): Promise<void> {
  await testDb!.pool.query(
    `with a as (
       insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
                                  jitter_u, pause_ms, operation, request, outcome, http_status, apply_state, applied_at)
       select w.page_id, $3, w.id, w.resource, w.subject, w.class, 1, 2500, 0.1, 2750, w.resource, '{}'::jsonb,
              'response', case when $2::timestamptz is null then 500 else 200 end,
              case when $2::timestamptz is null then 'none' else 'applied' end, $2::timestamptz
         from sync_work w where w.id = $1
       returning id, work_id)
     update sync_work w set last_attempt_id = a.id, attempts_count = w.attempts_count + 1 from a where w.id = a.work_id`,
    [workId, appliedAt, options.shadow ?? false],
  );
}

async function served(resource: string, subject: string, appliedAt: Date | null, state: WorkState = "done"): Promise<number> {
  const id = await work(resource, subject, { state });
  await attempt(id, appliedAt);
  return id;
}

async function lastRead(resources: readonly string[] = [HEAD, HISTORY, TARGETS], page = pageId) {
  return Object.fromEntries(
    [...(await lastLiveAppliedAtOverSubjects(db(), { pageId: page, resources }))]
      .map(([resource, appliedAt]) => [resource, appliedAt.toISOString()]),
  );
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/** The plan the reader's own statement runs by, with sequential scans priced
 *  out (the fixture tables are a few pages; production's are not). */
async function planOf(resources: readonly string[]): Promise<PlanNode[]> {
  const pool = testDb!.pool as unknown as { query: (config: unknown, values?: unknown) => Promise<unknown> };
  const original = pool.query.bind(pool);
  const statements: Array<{ text: string; values: unknown[] }> = [];
  pool.query = (config, values) => {
    const query = typeof config === "string" ? { text: config, values: [] } : config as { text: string; values?: unknown[] };
    statements.push({ text: query.text, values: (values as unknown[] | undefined) ?? query.values ?? [] });
    return original(config, values);
  };
  try {
    await lastLiveAppliedAtOverSubjects(db(), { pageId, resources });
  } finally {
    pool.query = original;
  }
  expect(statements).toHaveLength(1);
  const client = await testDb!.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `explain (analyze, format json) ${statements[0]!.text}`,
      statements[0]!.values,
    );
    return flatten(result.rows[0]!["QUERY PLAN"][0]!.Plan);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

function attemptReads(plan: readonly PlanNode[]): number {
  return plan
    .filter((node) => node["Relation Name"] === "sync_attempts")
    .reduce((sum, node) => sum + (node["Actual Loops"] ?? 0), 0);
}

describe("when a per-subject key was last applied", () => {
  it("is the newest applied attempt over all its subjects, each key by itself", async () => {
    await served(HEAD, "chat-1", at(1));
    await served(HEAD, "chat-2", at(9));
    await served(HEAD, "chat-3", at(4));
    await served(TARGETS, "target-1", at(2));

    expect(await lastRead()).toEqual({ [HEAD]: at(9).toISOString(), [TARGETS]: at(2).toISOString() });
    // A key the page has no row of is absent, not "never" under another name.
    expect(await lastRead([HISTORY])).toEqual({});
    expect(await lastRead([])).toEqual({});
  });

  it("looks past requests that failed: a chat Fansly refuses does not hide the chats it answers", async () => {
    await served(HEAD, "chat-1", at(3));
    // Newer rows of other chats: one whose only request failed, and one read
    // earlier whose last request failed.
    await served(HEAD, "chat-refused", null);
    const flaky = await served(HEAD, "chat-flaky", at(2));
    await attempt(flaky, null);

    expect(await lastRead([HEAD])).toEqual({ [HEAD]: at(3).toISOString() });

    // Even when every one of the key's newest rows failed after the last read.
    for (let n = 0; n < SYNC_LAST_APPLIED_RECENT_ROWS - 3; n += 1) await served(HEAD, `chat-down-${n}`, null);
    expect(await lastRead([HEAD])).toEqual({ [HEAD]: at(3).toISOString() });
  });

  it("counts an old row that is still being read: a request's chats take turns for hours", async () => {
    // A history request's rows are filed together and stay open; the chats
    // filed last finished first, and more chats than are read here stay open.
    for (let n = 0; n <= SYNC_LAST_APPLIED_ACTIVE_ROWS; n += 1) await served(HISTORY, `thread-open-${n}`, at(1 + n), "open");
    const long = await work(HISTORY, "thread-long", { state: "open" });
    for (let n = 0; n < SYNC_LAST_APPLIED_RECENT_ROWS + 5; n += 1) await served(HISTORY, `thread-${n}`, at(10 + n));
    expect(await lastRead([HISTORY])).toEqual({
      [HISTORY]: at(10 + SYNC_LAST_APPLIED_RECENT_ROWS + 4).toISOString(),
    });

    // The first chat is read again, long after the others closed.
    await attempt(long, at(300));
    expect(await lastRead([HISTORY])).toEqual({ [HISTORY]: at(300).toISOString() });

    // Its request in flight is not a read yet: the last applied one stands.
    await attempt(long, null);
    expect(await lastRead([HISTORY])).toEqual({ [HISTORY]: at(300).toISOString() });
  });

  it("is exact for a finished request of a few chats, whatever the order they closed in", async () => {
    // Production, lilly-1, 2026-10-02: twenty chats of one request; the one
    // read last was filed among the first.
    for (let n = 0; n < 20; n += 1) await served(HISTORY, `thread-${n}`, at(n === 1 ? 500 : 100 + n));
    expect(await lastRead([HISTORY])).toEqual({ [HISTORY]: at(500).toISOString() });
    // The window that covers it, and the few active rows read beside it.
    expect(SYNC_LAST_APPLIED_RECENT_ROWS).toBe(20);
    expect(SYNC_LAST_APPLIED_ACTIVE_ROWS).toBe(3);
  });

  it("never reads the shadow journal or another page", async () => {
    await served(HEAD, "chat-1", at(5));
    const shadow = await work(HEAD, "chat-shadow", { shadow: true });
    await attempt(shadow, at(50), { shadow: true });
    const elsewhere = await work(HEAD, "chat-1", { page: otherPageId });
    await attempt(elsewhere, at(60));

    expect(await lastRead([HEAD])).toEqual({ [HEAD]: at(5).toISOString() });
    expect(await lastRead([HEAD], otherPageId)).toEqual({ [HEAD]: at(60).toISOString() });
  });

  it("reads a bounded number of rows however many subjects the key has, along the indexes", async () => {
    const subjects = 60;
    for (let n = 0; n < subjects; n += 1) await served(HEAD, `chat-${n}`, at(n));
    for (let n = 0; n < subjects; n += 1) await served(TARGETS, `target-${n}`, null);
    for (let n = 0; n < subjects; n += 1) await served(HISTORY, `thread-${n}`, at(n), "open");
    await testDb!.pool.query("analyze sync_work");
    await testDb!.pool.query("analyze sync_attempts");
    expect(await lastRead([HEAD, TARGETS])).toEqual({ [HEAD]: at(subjects - 1).toISOString() });

    // Sixty chats, each read once; sixty targets never read; sixty chats of a
    // request, all open: whichever, a key costs the reads of its few newest and
    // its few active rows, never one a subject.
    expect(await lastRead([HISTORY])).toEqual({ [HISTORY]: at(subjects - 1).toISOString() });
    const read = await planOf([HEAD]);
    const unread = await planOf([TARGETS]);
    const open = await planOf([HISTORY]);
    const bound = SYNC_LAST_APPLIED_RECENT_ROWS + SYNC_LAST_APPLIED_ACTIVE_ROWS;
    expect(bound).toBeLessThan(subjects);
    expect(attemptReads(read)).toBe(SYNC_LAST_APPLIED_RECENT_ROWS);
    expect(attemptReads(unread)).toBe(SYNC_LAST_APPLIED_RECENT_ROWS);
    expect(attemptReads(open)).toBe(bound);
    expect(attemptReads(await planOf([HEAD, TARGETS, HISTORY]))).toBe(3 * SYNC_LAST_APPLIED_RECENT_ROWS + SYNC_LAST_APPLIED_ACTIVE_ROWS);

    for (const plan of [read, unread, open]) {
      expect(plan.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
      const indexes = new Set(plan.map((node) => node["Index Name"]).filter((name) => name !== undefined));
      // The key's rows by its own index range (never the table backwards along
      // its primary key), its active rows by the open-row index, a row's
      // attempts by its work id — never the page's attempt journal.
      expect([...indexes].sort()).toEqual(["sync_attempts_work", "sync_work_key_recent", "sync_work_open_uniq"]);
    }
  });
});

describe("the status reader over per-subject keys", () => {
  it("covers exactly the lever keys that are not page-level", () => {
    const perSubject = new Set(FANSLY_RESOURCE_SPECS.filter((spec) => spec.subject !== "page").map((spec) => spec.key));
    expect([...SUBJECT_LEVEL_LEVER_KEYS]).toEqual([
      "dm-conversations.find", "dm-conversations.detail", "dm-messages.head", "dm-messages.catchup",
      "dm-messages.history", "purchases.targets", "fan-profiles.probe",
    ]);
    for (const key of SUBJECT_LEVEL_LEVER_KEYS) expect(perSubject.has(key), key).toBe(true);
  });

  it("a stream of per-subject keys alone has a last read; a page-level stream keeps its own", async () => {
    await served(HEAD, "chat-1", at(7));
    await served(HEAD, "chat-2", at(3));
    await served(TARGETS, "target-1", at(2));
    const poll = await work("account.poll", "", { state: "open" });
    await attempt(poll, at(5));

    // The page-level reader never saw them: this is what the card showed.
    expect([...(await lastLiveAppliedAtByResource(db(), { pageId, resources: [HEAD, TARGETS] }))]).toEqual([]);

    const facts = (await readEngineStatusFacts(db(), { pageIds: [pageId], settingMs: 2500 })).get(pageId)!;
    expect(engineStreamState("dm_messages", facts).succeededAt).toEqual(at(7));
    expect(engineStreamState("purchase_history", facts).succeededAt).toEqual(at(2));
    expect(engineStreamState("light", facts).succeededAt).toEqual(at(5));
    // Nothing of the stream was ever read.
    expect(engineStreamState("followers_reconcile", facts).succeededAt).toBeNull();
  });
});
