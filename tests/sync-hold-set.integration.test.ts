import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  addSyncPageLiftedDmExclusion,
  adjustPausedResources,
  advanceWsRouterCursor,
  captureAttempt,
  clearPageHold,
  confirmSyncOwnersStopped,
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  ensureFanslySyncPages,
  ensureSyncPage,
  getSyncPage,
  heartbeatSyncPageOwner,
  insertAdmission,
  lockOwnedPage,
  markWorkRunning,
  recordSyncPageIdentityProof,
  removeSyncPageLiftedDmExclusion,
  setNetworkFailureStreak,
  setPageHold,
  setPagePause,
  setRegistryOverride,
  setResourceHold,
  setSyncPageMode,
  SYNC_LIFTABLE_DM_EXCLUSIONS,
  syncPages,
  trustSyncPageCredentials,
  upsertDemand,
  writeSafeRelease,
  writeSyncRouteState,
  type Database,
  type FanslySendHolderIdentity,
  type SyncHoldRow,
} from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { holdSetOf, whyHeld } from "../apps/runtime/src/sync/engine/admission.ts";
import { collectPageAlerts, evaluateRouteAlerts } from "../apps/runtime/src/sync/engine/alerts.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { readSyncPageStatus } from "../apps/runtime/src/sync/inspect.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { testConfig } from "./helpers/sync-engine-host.ts";
import { syncPageRowWriters } from "./helpers/sync-page-row-writers.ts";

// The hold set (0240, step 4 owner decision №26) on a real Postgres: the
// table's own rules, the hold writers, and the three migrations of it — the
// table, the ladder step of the old hold slot dropped, and the rest of the
// old hold columns of the page row dropped (S4-33, the last of the three
// releases that took them away).
//
// The old columns (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`,
// `resource_holds`) and the slot's two CHECKs are gone. The release before
// the drop read none of them, and wrote one in one statement: the marker its
// acquisition leaves in `resource_holds`, a statement of its own in a
// savepoint, which goes on where the column is gone. That is what makes it
// the drop's rollback target — proved here on a database that went through
// the drop with holds still written in those columns and that marker in its
// pages: that image's acquisition as it has it, every statement of the
// sources that writes a page row, the hold writes and the readers run on what
// is left. This file and the two pins beside it
// (tests/sync-engine-migrations.test.ts, tests/sync-old-hold-columns.test.ts)
// are the tests of the migrations that made and dropped the columns; with
// the test of the deploy gate that searches the running images for them
// (tests/deploy-old-hold-columns-gate.test.ts) they are the only tests that
// still name them.

const OLD_HOLD_COLUMNS = ["hold_kind", "hold_until", "hold_since", "hold_detail", "resource_holds"];
const OLD_HOLD_CHECKS = ["sync_pages_hold_kind_check", "sync_pages_hold_pair_check"];
const MIGRATIONS_DIR = path.resolve("packages/db/migrations");
const MIGRATIONS = readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql")).sort();

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

function dbOf(target: StartedTestDatabase): Database {
  return target.db as unknown as Database;
}

async function query<T extends Record<string, unknown>>(target: StartedTestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  return (await target.pool.query<T>(text, values)).rows;
}

/** Apply the migrations of the tree to `target`, up to `through` (all of them without one). */
async function migrate(target: StartedTestDatabase, through?: string): Promise<void> {
  const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
  const client = await target.pool.connect();
  try {
    await runMigrations({ db: client, migrationsDir: MIGRATIONS_DIR, ...(through === undefined ? {} : { through }) });
    // A bound on a migration's lock wait is its own: gone with its transaction.
    expect((await client.query("show lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
  } finally {
    client.release();
  }
}

/** The page's hold set as every reader gets it: with the page row. */
async function holdRows(target: StartedTestDatabase, pageId: number): Promise<SyncHoldRow[]> {
  return (await getSyncPage(dbOf(target), pageId))!.holds;
}

function holdNames(rows: readonly SyncHoldRow[]): string[] {
  return rows.map((row) => `${row.scope}/${row.key}/${row.kind}`);
}

/** A Fansly page without an engine row. */
async function seedFanslyPage(target: StartedTestDatabase, label = `holds-${randomUUID().slice(0, 8)}`): Promise<number> {
  const model = await createModel(dbOf(target), { slug: `model-${label}`, name: label });
  return (await createFanslyPage(dbOf(target), { modelId: model!.id, label }))!.id;
}

/** A page with its engine row in mode `off` (`ensureSyncPage`). */
async function seedPage(target: StartedTestDatabase): Promise<number> {
  const pageId = await seedFanslyPage(target);
  await ensureSyncPage(dbOf(target), { pageId });
  return pageId;
}

/** A page born live, as onboarding creates it (`createLiveSyncPage`). */
async function seedLivePage(target: StartedTestDatabase): Promise<number> {
  const pageId = await seedFanslyPage(target);
  await target.db.transaction(async (tx) => createLiveSyncPage(tx as unknown as Database, {
    pageId,
    by: "onboarding:test",
    identityAccountId: "acct",
    identityCheckedAt: new Date(Date.now() - 60_000),
    credentialsGeneration: "a".repeat(64),
  }));
  return pageId;
}

function owner(host = "sync-host-a"): FanslySendHolderIdentity {
  return { host, pid: 1, pidStart: "start-a", pidNs: "pid:[4026531836]", bootId: "boot-1", instance: randomUUID(), role: "sync" };
}

/** Acquire the page's ownership (a new generation), as the host does. */
async function own(target: StartedTestDatabase, pageId: number): Promise<{ generation: bigint }> {
  const acquired = await acquireSyncPageOwnership(dbOf(target), { pageId, owner: owner() });
  if (acquired.kind !== "acquired") throw new Error(`expected to acquire page ${pageId}: ${acquired.kind}`);
  return acquired;
}

/** The physical version of the page's row: another one after every write of
 *  it, the same after a lock. */
async function rowVersion(target: StartedTestDatabase, pageId: number) {
  const [row] = await query<{ xmin: string; ctid: string }>(
    target, "select xmin::text as xmin, ctid::text as ctid from sync_pages where page_id = $1", [pageId],
  );
  return row!;
}

/** Rows without the instants a test does not name. */
function shape(rows: readonly SyncHoldRow[]) {
  return rows.map((row) => ({ scope: row.scope, key: row.key, kind: row.kind, ladderStep: row.ladderStep, detail: row.detail, revision: row.revision }));
}

/** The columns of the page table, in the table's order. */
async function pageTableColumns(target: StartedTestDatabase): Promise<string[]> {
  return (await query<{ column_name: string }>(
    target,
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sync_pages' order by ordinal_position",
  )).map((row) => row.column_name);
}

/** The constraints of the page table, by name. */
async function pageTableConstraints(target: StartedTestDatabase) {
  return query<{ conname: string; convalidated: boolean; definition: string }>(
    target,
    `select conname, convalidated, pg_get_constraintdef(oid) as definition
       from pg_constraint where conrelid = 'sync_pages'::regclass order by conname`,
  );
}

/** The seven hold writes of a page — every writer, fenced and under no
 *  generation, a hold taken and a hold lifted. Each locks the page row and
 *  writes the rows; none writes the page row. */
async function writeEveryKindOfHold(target: StartedTestDatabase, pageId: number, generation: bigint, what: string): Promise<void> {
  const db = dbOf(target);
  const kept = shape((await holdRows(target, pageId)).filter((row) => row.kind === "identity_mismatch"));
  const version = await rowVersion(target, pageId);
  const fenced = { pageId, generation };
  const networkUntil = new Date(Date.now() + 120_000);
  const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: "2026-10-04T09:00:00.000Z" };
  const slowed = { ladderStep: 1, effectivePerMin: 7.5, policyVersion: "v1", last429AttemptId: 42, last429At: new Date("2026-10-04T10:00:00.000Z") };

  await setPageHold(db, { ...fenced, kind: "network", until: networkUntil, detail: { streak: 3 } });
  // A refusal of the other kind replaces a credentials hold the page has.
  await setPageHold(db, { ...fenced, kind: "auth", until: "infinity", detail: refusal });
  await setResourceHold(db, { ...fenced, file: "transactions", hold: { until: new Date(Date.now() + 1_800_000), step: 1 } });
  expect(await writeSyncRouteState(db, {
    ...fenced, route: "messages.page", expectRevision: 0, entry: { ...slowed, holdUntil: new Date(Date.now() + 5_000) },
  }), what).toEqual({ kind: "written", revision: 1 });
  // Under no generation: the owner's `sync route raise`.
  expect(await writeSyncRouteState(db, {
    pageId, route: "messages.page", expectRevision: 1, entry: { ...slowed, holdUntil: null, effectivePerMin: 8.5 },
  }), what).toEqual({ kind: "written", revision: 2 });
  expect(shape(await holdRows(target, pageId)), what).toEqual([
    { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: refusal, revision: kept.length === 0 ? 1 : 2 },
    { scope: "page", key: "", kind: "network", ladderStep: 0, detail: { streak: 3 }, revision: 1 },
    { scope: "resource", key: "transactions", kind: "resource_breaker", ladderStep: 1, detail: {}, revision: 1 },
    {
      scope: "route", key: "messages.page", kind: "route_budget", ladderStep: 1,
      detail: { effectivePerMin: 8.5, policyVersion: "v1", last429AttemptId: 42, last429At: "2026-10-04T10:00:00.000Z" }, revision: 2,
    },
  ]);
  await clearPageHold(db, { ...fenced, kinds: ["auth"] });
  await setResourceHold(db, { ...fenced, file: "transactions", hold: null });
  expect(holdNames(await holdRows(target, pageId)), what).toEqual(["page//network", "route/messages.page/route_budget"]);

  // Seven hold writes: the page row was locked each time and never written.
  expect(await rowVersion(target, pageId), what).toEqual(version);
  // What holds the page is what its rows say.
  const page = (await getSyncPage(db, pageId))!;
  expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow), what).toMatchObject({ scope: "page", kind: "network", until: networkUntil });
}

/** The functions with a statement that inserts a page row. */
const INSERTS = ["ensureSyncPage", "ensureFanslySyncPages", "createLiveSyncPage"];
/** The functions with a statement that updates one. */
const UPDATES = [
  "acquireSyncPageOwnership", "heartbeatSyncPageOwner", "trustSyncPageCredentials", "recordSyncPageIdentityProof",
  "setNetworkFailureStreak", "addSyncPageLiftedDmExclusion", "removeSyncPageLiftedDmExclusion", "setPagePause",
  "adjustPausedResources", "setRegistryOverride", "advanceWsRouterCursor", "insertAdmission", "captureAttempt",
  "writeSafeRelease", "confirmSyncOwnersStopped", "setSyncPageMode",
];

/** Run every function that updates a page row over a live page (the engine's
 *  writes) and a page in mode `off` (the owner's mode lever): each writes a
 *  new version of the row. `acquire` is the acquisition of the image that
 *  runs them: this build's, or the one of the release before it. */
async function runEveryPageRowUpdate(
  target: StartedTestDatabase,
  pageId: number,
  offPage: number,
  what: string,
  acquire: (target: StartedTestDatabase, pageId: number) => Promise<{ generation: bigint }> = own,
): Promise<void> {
  const db = dbOf(target);
  let generation = 0n;
  let attemptId = 0;
  const admit = () => target.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const work = await upsertDemand(tx, { pageId, shadow: false, resource: "dm-messages.head", subject: "group-1", kind: "trigger", class: "urgent" });
    await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update", live: true });
    const running = await markWorkRunning(tx, { workId: work.id, generation });
    const admitted = await insertAdmission(tx, {
      pageId, shadow: false, workId: work.id, resource: "dm-messages.head", subject: "group-1", class: "urgent", slot: 0, nextCyclePos: 1,
      generation, demandRevision: running!.demandRevision, settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200, operation: "messages.page",
      request: { path: "/api/v1/message", query: { groupId: "group-1" } }, evidence: true,
    });
    return admitted.attemptId;
  });
  const steps: Array<[name: string, page: number, run: () => Promise<unknown>]> = [
    ["acquireSyncPageOwnership", pageId, async () => { generation = (await acquire(target, pageId)).generation; }],
    ["heartbeatSyncPageOwner", pageId, async () => expect(await heartbeatSyncPageOwner(db, { pageId, generation })).toBe(true)],
    ["trustSyncPageCredentials", pageId, async () => expect(await trustSyncPageCredentials(db, {
      pageId, generation: "b".repeat(64), accountId: "acct", verifiedAt: new Date(),
    })).toBe(true)],
    ["recordSyncPageIdentityProof", pageId, async () => expect(await recordSyncPageIdentityProof(db, {
      pageId, generation, accountId: "acct", credentialsGeneration: "c".repeat(64), sentAt: new Date(Date.now() + 1_000),
    })).toBe(true)],
    ["setNetworkFailureStreak", pageId, () => setNetworkFailureStreak(db, { pageId, generation, streak: 2 })],
    ["addSyncPageLiftedDmExclusion", pageId, async () => expect(await addSyncPageLiftedDmExclusion(db, {
      pageId, reason: SYNC_LIFTABLE_DM_EXCLUSIONS[0],
    })).toMatchObject({ added: true })],
    ["removeSyncPageLiftedDmExclusion", pageId, async () => expect(await removeSyncPageLiftedDmExclusion(db, {
      pageId, reason: SYNC_LIFTABLE_DM_EXCLUSIONS[0],
    })).toMatchObject({ removed: true })],
    ["setPagePause", pageId, async () => expect(await setPagePause(db, {
      pageId, requests: true, resources: ["posts.refresh"], note: "test",
    })).toMatchObject({ pausedRequests: true, pausedResources: ["posts.refresh"] })],
    ["adjustPausedResources", pageId, async () => expect(await adjustPausedResources(db, {
      pageId, add: ["media-stats.walk"], remove: ["posts.refresh"],
    })).toMatchObject({ pausedResources: ["media-stats.walk"] })],
    ["setRegistryOverride", pageId, async () => expect(await setRegistryOverride(db, {
      pageId, key: "media-stats.walk", override: { everyMs: 86_400_000 },
    })).toBe(true)],
    ["advanceWsRouterCursor", pageId, () => advanceWsRouterCursor(db, { pageId, generation, cursor: 5 })],
    ["insertAdmission", pageId, async () => { attemptId = await admit(); }],
    ["captureAttempt", pageId, async () => expect(await captureAttempt(db, {
      attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(), sendMark: "request_start", httpStatus: 200, applyState: "none",
    })).toMatchObject({ captured: true })],
    ["writeSafeRelease", pageId, async () => expect(await writeSafeRelease(db, { pageId, generation })).toBe(true)],
    // A second owner, gone with its container: the deploy confirms it stopped.
    ["acquireSyncPageOwnership", pageId, async () => { generation = (await acquire(target, pageId)).generation; }],
    ["confirmSyncOwnersStopped", pageId, async () => expect(await confirmSyncOwnersStopped(db, {
      runningHosts: ["sync-host-b"], ownHost: "cli", confirmedBy: "deploy", dryRun: false, pageIds: [pageId],
    })).toMatchObject([{ pageId, confirmed: true }])],
    ["setSyncPageMode", offPage, async () => expect(await setSyncPageMode(db, { pageId: offPage, to: "shadow", changedBy: "test" })).toMatchObject({ kind: "changed" })],
    ["setSyncPageMode", offPage, async () => expect(await setSyncPageMode(db, { pageId: offPage, to: "off", changedBy: "test" })).toMatchObject({ kind: "changed" })],
  ];
  expect([...new Set(steps.map(([name]) => name))].sort()).toEqual([...UPDATES].sort());

  for (const [name, page, run] of steps) {
    const version = await rowVersion(target, page);
    await run();
    expect(await rowVersion(target, page), `${what}: ${name} writes the page row`).not.toEqual(version);
  }
}

describe("the hold set table (0240)", () => {
  it("the migration: an empty table beside the page rows it leaves alone, granted to the read role", async (context) => {
    if (!testDb) return context.skip();
    const migration = MIGRATIONS.find((file) => file.endsWith("_sync_holds.sql"))!;
    const partial = await startIntegrationTestDatabase({ through: MIGRATIONS[MIGRATIONS.indexOf(migration) - 1]! });
    if (!partial) return context.skip();
    try {
      // A page as the image before it left it: holds in the old columns.
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label) select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(
        `insert into sync_pages (page_id, mode, mode_changed_by, hold_kind, hold_until, hold_since, hold_detail, resource_holds)
         select id, 'live', 'test', 'auth', 'infinity', clock_timestamp(), '{"credentialsGeneration":"gen-a"}'::jsonb,
                '{"probe":{"until":"2099-01-01T00:00:00Z","step":7,"since":"2026-10-02T21:54:26.507558+00:00"}}'::jsonb
           from pages where label = 'seed-fansly'`,
      );
      const before = await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp");
      await migrate(partial, migration);
      // The migration copies nothing: the hold-set release read a page's
      // state from the old columns when it acquired the page.
      expect((await partial.pool.query("select count(*)::int as n from sync_holds")).rows).toEqual([{ n: 0 }]);
      expect((await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp")).rows).toEqual(before.rows);
      expect((await partial.pool.query("select has_table_privilege('read_only', 'sync_holds', 'select') as granted")).rows).toEqual([{ granted: true }]);
    } finally {
      await partial.stop();
    }
  }, 120_000);

  it("admits each scope's kinds only, and one credentials hold a page", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage(testDb);
    const insert = (scope: string, key: string, kind: string, until: string | null) =>
      testDb!.pool.query("insert into sync_holds (page_id, scope, key, kind, until) values ($1, $2, $3, $4, $5::timestamptz)", [pageId, scope, key, kind, until]);
    const soon = new Date(Date.now() + 60_000).toISOString();
    await insert("page", "", "auth", "infinity");
    await insert("page", "", "network", soon);
    await insert("route", "messages.page", "route_hold", soon);
    await insert("route", "messages.page", "route_budget", null);
    await insert("resource", "transactions", "resource_breaker", soon);
    // A page holds one credentials hold: the other kind never stands beside it.
    await expect(insert("page", "", "identity_mismatch", "infinity")).rejects.toThrow(/sync_holds_page_credentials/);
    await expect(insert("page", "", "auth", "infinity")).rejects.toThrow(/sync_holds_pkey|sync_holds_page_credentials/);
    for (const [scope, key, kind, until, constraint] of [
      ["page", "", "rate_limit", soon, "sync_holds_kind_check"],
      ["fan", "", "network", soon, "sync_holds_scope_check"],
      ["page", "messages.page", "network", soon, "sync_holds_scope_kind_check"],
      ["page", "", "route_hold", soon, "sync_holds_scope_kind_check"],
      ["route", "", "route_hold", soon, "sync_holds_scope_kind_check"],
      ["route", "polls", "resource_breaker", soon, "sync_holds_scope_kind_check"],
      ["resource", "posts", "route_budget", null, "sync_holds_scope_kind_check"],
      ["route", "polls", "route_budget", soon, "sync_holds_until_check"],
      ["route", "polls", "route_hold", null, "sync_holds_until_check"],
      ["resource", "posts", "resource_breaker", null, "sync_holds_until_check"],
    ] as const) {
      await expect(insert(scope, key, kind, until), `${scope}/${key}/${kind}`).rejects.toThrow(new RegExp(constraint));
    }
    await expect(testDb.pool.query("update sync_holds set revision = 0 where page_id = $1", [pageId])).rejects.toThrow(/sync_holds_revision_check/);
    await expect(testDb.pool.query("update sync_holds set ladder_step = -1 where page_id = $1", [pageId])).rejects.toThrow(/sync_holds_ladder_step_check/);
    // Page-owned: the page cannot go while it holds rows.
    await expect(testDb.pool.query("delete from pages where id = $1", [pageId])).rejects.toThrow(/sync_holds|sync_pages/);
    // The page row hands the rows out in scope, key and kind order.
    expect(holdNames((await getSyncPage(dbOf(testDb), pageId))!.holds)).toEqual([
      "page//auth", "page//network", "resource/transactions/resource_breaker", "route/messages.page/route_budget", "route/messages.page/route_hold",
    ]);
    expect((await getSyncPage(dbOf(testDb), pageId))!.holds[0]!.until).toEqual(INDEFINITE_UNTIL);
  });
});

describe("a hold write writes the rows and nothing of the page row", () => {
  it("every kind of hold write, fenced or under no generation: the rows change, the page row is locked and not written", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage(testDb);
    const { generation } = await own(testDb, pageId);
    await writeEveryKindOfHold(testDb, pageId, generation, "a page of this build");
  });

  it("a write that fails writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const db = dbOf(testDb);
    const pageId = await seedPage(testDb);
    const { generation } = await own(testDb, pageId);
    await setPageHold(db, { pageId, generation, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    const before = { rows: await holdRows(testDb, pageId), version: await rowVersion(testDb, pageId) };
    // A foreign generation; a stale revision; a transaction that rolls back.
    await expect(setPageHold(db, { pageId, generation: generation + 1n, kind: "network", until: new Date(Date.now() + 60_000) })).rejects.toThrow();
    expect(await writeSyncRouteState(db, {
      pageId, generation, route: "polls", expectRevision: 3,
      entry: { holdUntil: new Date(Date.now() + 60_000), ladderStep: 1, effectivePerMin: 7.5, policyVersion: null, last429AttemptId: 1, last429At: new Date() },
    })).toEqual({ kind: "stale" });
    await expect(testDb.db.transaction(async (tx) => {
      await setResourceHold(tx as unknown as Database, { pageId, generation, file: "posts", hold: { until: new Date(Date.now() + 60_000), step: 1 } });
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect({ rows: await holdRows(testDb, pageId), version: await rowVersion(testDb, pageId) }).toEqual(before);
  });
});

describe("the first old hold column goes (0241)", () => {
  it("the migration drops `hold_step` alone", async (context) => {
    if (!testDb) return context.skip();
    const migration = MIGRATIONS.find((file) => file.endsWith("_sync_pages_drop_hold_step.sql"))!;
    const partial = await startIntegrationTestDatabase({ through: MIGRATIONS[MIGRATIONS.indexOf(migration) - 1]! });
    if (!partial) return context.skip();
    try {
      // A page as the hold-set release left it: its rows, the old columns in
      // step with them, and a ladder step an older build once took.
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label) select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(
        `insert into sync_pages (page_id, mode, mode_changed_by, hold_kind, hold_until, hold_since, hold_step, hold_detail, resource_holds)
         select id, 'live', 'test', 'auth', 'infinity', '2026-10-04T08:00:00Z', 3, '{"credentialsGeneration":"gen-a"}'::jsonb,
                '{"probe":{"until":"2099-01-01T00:00:00.000Z","step":7,"since":"2026-10-02T21:54:26.507Z"}}'::jsonb
           from pages where label = 'seed-fansly'`,
      );
      await partial.pool.query(
        `insert into sync_holds (page_id, scope, key, kind, until, since, ladder_step, detail)
         select page_id, 'page', '', 'auth', 'infinity'::timestamptz, '2026-10-04T08:00:00Z'::timestamptz, 0, '{"credentialsGeneration":"gen-a"}'::jsonb from sync_pages
         union all
         select page_id, 'resource', 'probe', 'resource_breaker', '2099-01-01T00:00:00Z', '2026-10-02T21:54:26.507Z', 7, '{}'::jsonb from sync_pages`,
      );
      const before = await partial.pool.query("select to_jsonb(sp) - 'hold_step' as row from sync_pages sp");
      const holds = await partial.pool.query("select to_jsonb(h) as row from sync_holds h order by h.scope");
      await migrate(partial, migration);
      // The rest of the old hold slot stayed two more releases: until the
      // last migration of the three (below).
      expect((await pageTableColumns(partial)).filter((column) => column.startsWith("hold") || column === "resource_holds" || column === "network_failure_streak").sort())
        .toEqual(["hold_detail", "hold_kind", "hold_since", "hold_until", "network_failure_streak", "resource_holds"]);
      // Nothing else of the row changed, and no hold row.
      expect((await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp")).rows).toEqual(before.rows);
      expect((await partial.pool.query("select to_jsonb(h) as row from sync_holds h order by h.scope")).rows).toEqual(holds.rows);
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

/** The old hold columns as a release that still wrote them left them. */
interface OldColumns {
  kind: string | null;
  until?: string | null;
  since?: string | null;
  detail?: unknown;
  resourceHolds?: unknown;
}

/** What the old columns of a page said when the last release that wrote them
 *  handed it over (each shape one the two CHECKs admitted). */
const STALE: Readonly<Record<string, OldColumns>> = {
  "a credentials hold carrying a network hold, a breaker and a route's state": {
    kind: "auth",
    until: "infinity",
    since: "2026-10-04T08:00:00.000Z",
    detail: {
      status: 401,
      credentialsGeneration: "gen-a",
      timedHold: { kind: "network", until: "2099-01-01T00:00:00.000Z", detail: { streak: 4 } },
    },
    resourceHolds: {
      probe: { until: "2099-01-01T00:00:00.000Z", step: 7, since: "2026-10-02T21:54:26.507Z" },
      "route:state": {
        version: 1,
        routes: {
          "messaging.groups": {
            holdUntil: "2099-01-01T00:00:00.000Z", ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 99,
            last429At: "2026-10-04T08:30:00.000Z", revision: 4,
          },
        },
      },
    },
  },
  "a network hold": { kind: "network", until: "2099-01-01T00:00:00.000Z", since: "2026-10-04T08:00:00.000Z", detail: { streak: 3 } },
  "the page-wide 429 hold no build takes any more": { kind: "rate_limit", until: "2099-01-01T00:00:00.000Z", since: "2026-10-04T08:00:00.000Z" },
  "nothing": { kind: null },
};

/**
 * The statement the release two before the drop (S4-31) ended every hold
 * write with, in the write's transaction: the page's old hold columns
 * rewritten from its rows (`mirrorSyncHoldsToLegacyColumns`, column for
 * column as it was at 25a07294).
 */
const REWRITE_OF_THE_IMAGE_TWO_BEFORE = `
  update sync_pages
     set hold_kind = $2::text,
         hold_until = $3::timestamptz,
         hold_since = $4::timestamptz,
         hold_detail = $5::jsonb,
         resource_holds = $6::jsonb,
         updated_at = clock_timestamp()
   where page_id = $1`;

/** The read of the old columns the hold-set release (S4-30) makes when it
 *  acquires a page. */
const READ_OF_THE_HOLD_SET_IMAGE =
  "select hold_kind, hold_until = 'infinity'::timestamptz as indefinite, hold_since, hold_detail, resource_holds from sync_pages where page_id = $1";

/** What the marker of the release before the drop leaves in the old
 *  resource-hold map: the route-state entry at a version no build ever read,
 *  with no route. */
const MARKER = { "route:state": { version: 2, routes: {} } };

/**
 * The one statement of the release before the drop (S4-32) that names an old
 * hold column: whenever it acquires a page it marks the page's row as one
 * whose old hold columns are stale, so that the hold-set release (S4-30),
 * which lets those columns win over the rows, refuses the page instead of
 * opening it by them (`STALE_HOLD_COLUMNS_MARKER` in that image's
 * `acquireSyncPageOwnership`). The rest of the map is kept; a value that is
 * no JSON object is replaced by the marker alone.
 */
const markerOfTheImageBefore = (pageId: number) => `
  update sync_pages
     set resource_holds = case when jsonb_typeof(resource_holds) = 'object' then resource_holds else '{}'::jsonb end
                          || '{"route:state": {"version": 2, "routes": {}}}'::jsonb
   where page_id = ${pageId}`;

/** The SQLSTATE of the driver error under a drizzle error. */
function sqlStateOf(error: unknown): string | null {
  for (let current = error; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * A page acquired as the release before the drop acquires it: this build's
 * acquisition — the statements are that image's — and then, in the same
 * transaction, that image's marker, as it makes it: a statement of its own in
 * a savepoint, an undefined column (42703) swallowed and nothing else. The
 * columns are dropped under that image, and where they are gone there is
 * nothing to mark. `marked` says whether the marker was written.
 */
async function ownAsTheImageBefore(target: StartedTestDatabase, pageId: number): Promise<{ generation: bigint; marked: boolean }> {
  return target.db.transaction(async (tx) => {
    const acquired = await acquireSyncPageOwnership(tx as unknown as Database, { pageId, owner: owner() });
    if (acquired.kind !== "acquired") throw new Error(`expected the image before to acquire page ${pageId}: ${acquired.kind}`);
    let marked = true;
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint.execute(markerOfTheImageBefore(pageId));
      });
    } catch (error) {
      if (sqlStateOf(error) !== "42703") throw error;
      marked = false;
    }
    return { generation: acquired.generation, marked };
  });
}

describe("the old hold columns go: the last migration of the three", () => {
  const migration = MIGRATIONS.find((file) => file.endsWith("_sync_pages_drop_old_hold_columns.sql"))!;

  /** Pages seeded before the drop, per shape of `STALE`: each test its own. */
  interface StalePages {
    /** Born live (onboarding); no hold row. For the engine's writes of the row. */
    live: number;
    /** In mode `off`; no hold row. For the owner's mode lever. */
    off: number;
    /** Taken by the release before the drop, so marked; held by its rows (an
     *  identity refusal), whatever the columns say. */
    held: number;
    /** In mode `off`; no hold row: free, whatever the columns say. */
    free: number;
    /** Born live; no hold row. For the readers. */
    reader: number;
  }

  /**
   * A database as the release before the drop leaves it, and the deploy of
   * the drop over it: the pages (their old columns stale, saying what the
   * last release that wrote them left, beside rows that say something else;
   * the pages that release took marked so), the migration tried while a
   * transaction held a page row, then applied.
   */
  interface Stand {
    db: StartedTestDatabase;
    pages: Record<string, StalePages>;
    /** Born live under the release before the drop: the slot at its
     *  defaults, that release's marker in the map, held by rows it took since. */
    born: number;
    /** A page with three consecutive network failures counted, taken by that
     *  release too. */
    counted: number;
    before: {
      columns: string[];
      constraints: Awaited<ReturnType<typeof pageTableConstraints>>;
      defaults: Array<Record<string, unknown>>;
      /** What the old columns say, page by page: the kind in the slot, and
       *  what the resource-hold map carries — a route state as the last
       *  release that wrote one left it, or the marker of the release before
       *  the drop. */
      stale: Array<Record<string, unknown>>;
      /** The resource-hold map of the page of each shape that the release
       *  before the drop took. */
      takenMaps: unknown[];
      /** Every page row without its five old columns. */
      pageRows: Array<Record<string, unknown>>;
      holdRows: Array<Record<string, unknown>>;
      grants: Array<Record<string, unknown>>;
    };
    /** The migration run behind a transaction that holds a page row. */
    refused: { code: string | null; message: string; waitedMs: number; lockTimeoutAfter: string; applied: number; columns: string[] };
    /** Right after the migration ran, before any statement of the tests. */
    after: {
      applied: number;
      columns: string[];
      constraints: Awaited<ReturnType<typeof pageTableConstraints>>;
      /** Every page row, whole. */
      pageRows: Array<Record<string, unknown>>;
      holdRows: Array<Record<string, unknown>>;
      grants: Array<Record<string, unknown>>;
      streak: Array<Record<string, unknown>>;
    };
  }

  let stand: Stand | null = null;

  const PAGE_ROWS_WITHOUT_OLD_COLUMNS =
    "select to_jsonb(sp) - $1::text[] as row from sync_pages sp order by sp.page_id";
  const HOLD_ROWS = "select to_jsonb(h) as row from sync_holds h order by h.page_id, h.scope, h.key, h.kind";
  const GRANTS = `
    select has_table_privilege('read_only', 'sync_pages', 'select') as pages,
           has_table_privilege('read_only', 'sync_holds', 'select') as holds,
           has_table_privilege('read_only', 'sync_pages', 'insert, update, delete') as writes`;

  beforeAll(async () => {
    expect(migration).toBeDefined();
    const previous = MIGRATIONS[MIGRATIONS.indexOf(migration) - 1]!;
    const db = await startIntegrationTestDatabase({ through: previous });
    if (!db) return;
    try {
      const writeOldColumns = (pageId: number, columns: OldColumns) => db.pool.query(
        `update sync_pages set hold_kind = $2, hold_until = $3::timestamptz, hold_since = $4::timestamptz,
                hold_detail = $5::jsonb, resource_holds = $6::jsonb where page_id = $1`,
        [pageId, columns.kind, columns.until ?? null, columns.since ?? null, JSON.stringify(columns.detail ?? {}), JSON.stringify(columns.resourceHolds ?? {})],
      );

      // The pages, by the statements of the release before the drop: this
      // build's (its inserts name no old column and leave them at their
      // defaults) and, at an acquisition, that release's marker.
      const takenByTheImageBefore = async (pageId: number) => {
        const taken = await ownAsTheImageBefore(db, pageId);
        expect(taken.marked, `page ${pageId}`).toBe(true);
        return taken.generation;
      };
      const pages: Record<string, StalePages> = {};
      for (const [what, columns] of Object.entries(STALE)) {
        const live = await seedLivePage(db);
        const off = await seedPage(db);
        const held = await seedPage(db);
        const free = await seedPage(db);
        const reader = await seedLivePage(db);
        // What the last release that wrote the columns left in them.
        for (const pageId of [live, off, held, free, reader]) await writeOldColumns(pageId, columns);
        // The release before the drop took one of them: its marker in the
        // map, beside what was there, and a hold in the rows alone.
        const generation = await takenByTheImageBefore(held);
        await setPageHold(dbOf(db), { pageId: held, generation, kind: "identity_mismatch", until: "infinity", detail: { credentialsGeneration: "gen-x" } });
        // `sync` stops for the deploy: a safe release.
        await writeSafeRelease(dbOf(db), { pageId: held, generation });
        pages[what] = { live, off, held, free, reader };
      }
      const born = await seedLivePage(db);
      const fenced = { pageId: born, generation: await takenByTheImageBefore(born) };
      await setPageHold(dbOf(db), { ...fenced, kind: "auth", until: "infinity", detail: { status: 401, credentialsGeneration: "gen-b" } });
      await setResourceHold(dbOf(db), { ...fenced, file: "transactions", hold: { until: new Date("2099-01-01T00:00:00.000Z"), step: 1 } });
      await writeSyncRouteState(dbOf(db), {
        ...fenced, route: "messaging.groups", expectRevision: 0,
        entry: { holdUntil: new Date("2099-01-01T00:00:00.000Z"), ladderStep: 1, effectivePerMin: 6, policyVersion: null, last429AttemptId: null, last429At: new Date() },
      });
      await writeSafeRelease(dbOf(db), fenced);
      const counted = await seedPage(db);
      const counting = { pageId: counted, generation: await takenByTheImageBefore(counted) };
      await setNetworkFailureStreak(dbOf(db), { ...counting, streak: 3 });
      await writeSafeRelease(dbOf(db), counting);

      const before = {
        columns: await pageTableColumns(db),
        constraints: await pageTableConstraints(db),
        defaults: await query(
          db,
          "select hold_kind, hold_until, hold_since, hold_detail, resource_holds from sync_pages where page_id = any($1::bigint[])",
          [[born, counted]],
        ),
        stale: await query(
          db,
          `select coalesce(sp.hold_kind, 'none') as slot, count(*)::int as pages,
                  count(*) filter (where sp.resource_holds #>> '{route:state,version}' = '1')::int as with_route_state,
                  count(*) filter (where sp.resource_holds -> 'route:state' = $1::jsonb)::int as marked,
                  count(*) filter (where exists (select 1 from sync_holds h where h.page_id = sp.page_id))::int as held_by_rows
             from sync_pages sp group by 1 order by 1`,
          [JSON.stringify(MARKER["route:state"])],
        ),
        takenMaps: (await query<{ map: unknown }>(
          db,
          "select resource_holds as map from sync_pages where page_id = any($1::bigint[]) order by page_id",
          [Object.values(pages).map((shape) => shape.held)],
        )).map((row) => row.map),
        pageRows: await query(db, PAGE_ROWS_WITHOUT_OLD_COLUMNS, [OLD_HOLD_COLUMNS]),
        holdRows: await query(db, HOLD_ROWS),
        grants: await query(db, GRANTS),
      };

      // The deploy starts while the image before it still runs: one of its
      // actor transactions holds a page row, as each of them does from its
      // first statement (`lockOwnedPage`), and does not end.
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const actor = await db.pool.connect();
      const runner = await db.pool.connect();
      let refused: Stand["refused"];
      try {
        await actor.query("begin");
        await actor.query("select owner_generation from sync_pages where page_id = $1 for no key update", [born]);
        const started = performance.now();
        const error = await runMigrations({ db: runner, migrationsDir: MIGRATIONS_DIR, through: migration })
          .then(() => null, (reason: unknown) => reason as { code?: unknown; message?: unknown });
        refused = {
          code: error === null ? null : String(error.code),
          message: error === null ? "" : String(error.message),
          waitedMs: performance.now() - started,
          lockTimeoutAfter: String((await runner.query("show lock_timeout")).rows[0].lock_timeout),
          applied: Number((await runner.query("select count(*)::int as n from schema_migrations where id = $1", [migration])).rows[0].n),
          columns: await pageTableColumns(db),
        };
        await actor.query("rollback");
      } finally {
        runner.release();
        actor.release();
      }

      // The deploy is retried: nothing holds the table now.
      await migrate(db, migration);
      const after = {
        applied: Number((await query<{ n: number }>(db, "select count(*)::int as n from schema_migrations where id = $1", [migration]))[0]!.n),
        columns: await pageTableColumns(db),
        constraints: await pageTableConstraints(db),
        pageRows: await query(db, "select to_jsonb(sp) as row from sync_pages sp order by sp.page_id"),
        holdRows: await query(db, HOLD_ROWS),
        grants: await query(db, GRANTS),
        streak: await query(db, "select network_failure_streak::int as streak from sync_pages where page_id = $1", [counted]),
      };
      // A migration added after the drop: the statements run below are this
      // build's, over its whole schema.
      await migrate(db);
      stand = { db, pages, born, counted, before, refused, after };
    } catch (error) {
      await db.stop();
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    await stand?.db.stop();
  });

  it("comes after the hold set's table and the drop of the slot's ladder step", () => {
    const holdSet = MIGRATIONS.find((file) => file.endsWith("_sync_holds.sql"))!;
    const dropHoldStep = MIGRATIONS.find((file) => file.endsWith("_sync_pages_drop_hold_step.sql"))!;
    expect(holdSet < dropHoldStep && dropHoldStep < migration).toBe(true);
  });

  it("the database it runs on: holds in the old columns under their two CHECKs, beside rows that say something else", (context) => {
    if (!stand) return context.skip();
    for (const column of OLD_HOLD_COLUMNS) expect(stand.before.columns, column).toContain(column);
    expect(stand.before.constraints.filter((constraint) => OLD_HOLD_CHECKS.includes(constraint.conname))).toEqual([
      {
        conname: "sync_pages_hold_kind_check",
        convalidated: true,
        definition: "CHECK (((hold_kind IS NULL) OR (hold_kind = ANY (ARRAY['rate_limit'::text, 'auth'::text, 'identity_mismatch'::text, 'network'::text]))))",
      },
      { conname: "sync_pages_hold_pair_check", convalidated: true, definition: "CHECK (((hold_kind IS NULL) = (hold_until IS NULL)))" },
    ]);
    // A page born under the release before the drop: defaults in the slot,
    // that release's marker alone in the map, its holds in its rows.
    const defaults = { hold_kind: null, hold_until: null, hold_since: null, hold_detail: {}, resource_holds: MARKER };
    expect(stand.before.defaults).toEqual([defaults, defaults]);
    // Five pages for each of the four shapes. That release took one of the
    // five: it is held by its rows — by an identity refusal, which none of
    // the slots says — and marked, the marker over the route state that was
    // there and beside the rest of the map. The page born live (held by its
    // rows, its slot empty) and the page that counted failures are marked too.
    expect(stand.before.stale).toEqual([
      { slot: "auth", pages: 5, with_route_state: 4, marked: 1, held_by_rows: 1 },
      { slot: "network", pages: 5, with_route_state: 0, marked: 1, held_by_rows: 1 },
      { slot: "none", pages: 7, with_route_state: 0, marked: 3, held_by_rows: 2 },
      { slot: "rate_limit", pages: 5, with_route_state: 0, marked: 1, held_by_rows: 1 },
    ]);
    expect(stand.before.takenMaps).toEqual([
      { probe: { until: "2099-01-01T00:00:00.000Z", step: 7, since: "2026-10-02T21:54:26.507Z" }, ...MARKER },
      MARKER, MARKER, MARKER,
    ]);
    expect(stand.before.pageRows).toHaveLength(22);
    // Four identity refusals; the page born live: a credentials hold, a breaker, a route's state and hold.
    expect(stand.before.holdRows).toHaveLength(8);
  });

  it("waits no longer than its lock timeout behind a transaction that holds a page row, and then fails whole: nothing dropped, nothing recorded", (context) => {
    if (!stand) return context.skip();
    // 55P03 lock_not_available: `set local lock_timeout = '5s'`.
    expect(stand.refused).toMatchObject({ code: "55P03", message: "canceling statement due to lock timeout", lockTimeoutAfter: "0", applied: 0 });
    expect(stand.refused.waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(stand.refused.waitedMs).toBeLessThan(15_000);
    expect(stand.refused.columns).toEqual(stand.before.columns);
  });

  it("drops the five columns and the two CHECKs and nothing else: the rest of every page row, every hold row and the grants are as they were", (context) => {
    if (!stand) return context.skip();
    const { before, after } = stand;
    expect(after.applied).toBe(1);

    expect(after.columns).toEqual(before.columns.filter((column) => !OLD_HOLD_COLUMNS.includes(column)));
    expect(before.columns).toHaveLength(after.columns.length + OLD_HOLD_COLUMNS.length);
    expect(after.columns.filter((column) => column.includes("hold"))).toEqual([]);
    // The counter of consecutive network failures is no hold: it stays, with what it counted.
    expect(after.columns).toContain("network_failure_streak");
    expect(after.streak).toEqual([{ streak: 3 }]);

    expect(after.constraints).toEqual(before.constraints.filter((constraint) => !OLD_HOLD_CHECKS.includes(constraint.conname)));
    expect(after.constraints.map((constraint) => constraint.conname)).toEqual([
      "sync_pages_cycle_pos_check", "sync_pages_lifted_dm_exclusions_check", "sync_pages_mode_check",
      "sync_pages_owner_generation_check", "sync_pages_page_id_fkey", "sync_pages_pkey",
    ]);

    // Every page row is what it was without the five columns (`to_jsonb` of
    // the whole row afterwards), and no hold row changed.
    expect(after.pageRows).toHaveLength(22);
    expect(after.pageRows).toEqual(before.pageRows);
    expect(after.holdRows).toEqual(before.holdRows);
    // The read role reads both tables and writes neither, as before.
    expect(before.grants).toEqual([{ pages: true, holds: true, writes: false }]);
    expect(after.grants).toEqual(before.grants);
  });

  it("the table is the one a database migrated from nothing has, and the one drizzle maps", async (context) => {
    if (!stand || !testDb) return context.skip();
    expect(await pageTableColumns(testDb)).toEqual(await pageTableColumns(stand.db));
    expect(await pageTableConstraints(testDb)).toEqual(await pageTableConstraints(stand.db));
    // (A drizzle table's own values are its columns and one method.)
    const mapped = Object.values(syncPages as unknown as Record<string, { name?: unknown }>)
      .filter((column) => typeof column === "object").map((column) => column.name);
    expect([...mapped].sort()).toEqual([...(await pageTableColumns(stand.db))].sort());
  });

  it("applied again by hand it changes nothing: every drop is IF EXISTS", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    const columns = await pageTableColumns(db);
    const constraints = await pageTableConstraints(db);
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
      await client.query("commit");
    } finally {
      client.release();
    }
    expect(await pageTableColumns(db)).toEqual(columns);
    expect(await pageTableConstraints(db)).toEqual(constraints);
  });

  it("these are every statement of the sources that writes a page row", () => {
    expect(syncPageRowWriters().map((writer) => `${writer.statement} ${writer.name}`).sort()).toEqual([
      ...INSERTS.map((name) => `insert ${name}`),
      ...UPDATES.map((name) => `update ${name}`),
    ].sort());
  });

  it("the image before it runs on what is left: every statement that updates a page row, over the pages that went through the drop", async (context) => {
    if (!stand) return context.skip();
    for (const [what, pages] of Object.entries(stand.pages)) {
      await runEveryPageRowUpdate(stand.db, pages.live, pages.off, what, ownAsTheImageBefore);
    }
  });

  it("…every statement that inserts one: a page ensured, or onboarded live, after the drop", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    // `ensureSyncPage`: a page's row in mode `off`.
    const ensured = await seedFanslyPage(db);
    expect(await ensureSyncPage(dbOf(db), { pageId: ensured })).toEqual({ created: true });
    // `ensureFanslySyncPages`: the host at start, for every page without one.
    const first = await seedFanslyPage(db);
    const second = await seedFanslyPage(db);
    expect(await ensureFanslySyncPages(dbOf(db))).toBe(2);
    // `createLiveSyncPage`: onboarding's insert, the page born live.
    const onboarded = await seedLivePage(db);
    expect((await getSyncPage(dbOf(db), onboarded))!.mode).toBe("live");
    for (const pageId of [ensured, first, second, onboarded]) expect(await holdRows(db, pageId)).toEqual([]);
    // And it runs like any other: its updates, its hold writes.
    await runEveryPageRowUpdate(db, onboarded, ensured, "a page onboarded after the drop", ownAsTheImageBefore);
    await writeEveryKindOfHold(db, first, (await ownAsTheImageBefore(db, first)).generation, "a page ensured after the drop");
  });

  it("…its acquisition, the marker's statement in it: the page is taken, and there is nothing left to mark", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    const generationOf = async (pageId: number) => Number((await query<{ generation: number }>(
      db, "select owner_generation::int as generation from sync_pages where page_id = $1", [pageId],
    ))[0]!.generation);

    // A page that image took and marked before the drop, and one it takes
    // for the first time after it.
    const fresh = await seedPage(db);
    for (const pageId of [stand.counted, fresh]) {
      const before = await generationOf(pageId);
      const taken = await ownAsTheImageBefore(db, pageId);
      // The marker's statement names a column that is gone (42703): it costs
      // its savepoint and nothing else. The owner generation is written, and
      // the page runs.
      expect(taken).toEqual({ generation: BigInt(before + 1), marked: false });
      expect(await generationOf(pageId)).toBe(before + 1);
      expect(await heartbeatSyncPageOwner(dbOf(db), { pageId, generation: taken.generation })).toBe(true);
      expect(await writeSafeRelease(dbOf(db), { pageId, generation: taken.generation })).toBe(true);
    }

    // Why that image makes the marker in a savepoint: the same statement in
    // the acquisition's own transaction would lose the acquisition with it,
    // and no page of the database could be taken — by the `sync` that works
    // while the migration is applied, or after a rollback.
    const before = await generationOf(fresh);
    const lost: unknown = await db.db.transaction(async (tx) => {
      await acquireSyncPageOwnership(tx as unknown as Database, { pageId: fresh, owner: owner() });
      await tx.execute(markerOfTheImageBefore(fresh));
    }).then(() => null, (error: unknown) => error);
    expect(sqlStateOf(lost)).toBe("42703");
    expect(await generationOf(fresh)).toBe(before);
  });

  it("…its hold writes: a page holds what its rows say, whatever its old columns said", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    for (const [what, pages] of Object.entries(stand.pages)) {
      // The page its rows hold (an identity refusal): acquired, it is held by them.
      const { generation } = await ownAsTheImageBefore(db, pages.held);
      expect(shape(await holdRows(db, pages.held)), what).toEqual([
        { scope: "page", key: "", kind: "identity_mismatch", ladderStep: 0, detail: { credentialsGeneration: "gen-x" }, revision: 1 },
      ]);
      const held = (await getSyncPage(dbOf(db), pages.held))!;
      expect(whyHeld(holdSetOf(held.holds), null, {}, held.dbNow), what).toMatchObject({ scope: "credentials", kind: "identity_mismatch" });
      // A page whose columns said "held" and whose rows say nothing is free.
      await ownAsTheImageBefore(db, pages.free);
      expect(await holdRows(db, pages.free), what).toEqual([]);
      const free = (await getSyncPage(dbOf(db), pages.free))!;
      expect(whyHeld(holdSetOf(free.holds), null, {}, free.dbNow), what).toBeNull();
      // A hold write under no generation (the owner's lever) on it.
      await setResourceHold(dbOf(db), { pageId: pages.free, file: "posts", hold: { until: new Date(Date.now() + 60_000), step: 1 } });
      expect(holdNames(await holdRows(db, pages.free)), what).toEqual(["resource/posts/resource_breaker"]);
      // Every writer, on the held page: a hold taken, replaced, lifted.
      await writeEveryKindOfHold(db, pages.held, generation, what);
    }
  });

  it("…its readers: the page status (the status routes, `sync page status`) and the alerts say what the rows say", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    const registry = createFanslyRegistry();
    const read = async (pageId: number) => {
      const page = (await getSyncPage(dbOf(db), pageId))!;
      const status = await readSyncPageStatus(dbOf(db), testConfig(db.connectionString), page);
      return {
        holds: status.holds,
        heldRoutes: status.routes!.routes.filter((route) => route.holdUntil !== null).map((route) => route.name),
        stopped: (await collectPageAlerts(dbOf(db), { page, registry }))
          .filter((condition) => condition.subKey === "page_stopped").flatMap((condition) => condition.reasons.map((reason) => reason.detail)),
        routeAlerts: evaluateRouteAlerts(page, page.dbNow).map((condition) => condition.route),
      };
    };

    // Their columns said: a credentials hold with a network hold, a breaker
    // and a held, slowed route; a network hold; the page-wide 429 hold;
    // nothing. Their rows say nothing: nothing is held.
    for (const [what, pages] of Object.entries(stand.pages)) {
      await ownAsTheImageBefore(db, pages.reader);
      expect(await read(pages.reader), what).toEqual({ holds: { page: null, resources: [] }, heldRoutes: [], stopped: [], routeAlerts: [] });
    }

    // Its columns said nothing but the marker; its rows say all of that.
    await ownAsTheImageBefore(db, stand.born);
    expect(await read(stand.born)).toMatchObject({
      holds: { page: { kind: "auth", until: "infinity" }, resources: [{ file: "transactions", step: 1 }] },
      heldRoutes: ["messaging.groups"],
      stopped: ["auth"],
      routeAlerts: ["messaging.groups"],
    });
  });

  it("no image older than that runs on it: one fails every hold write at its rewrite of the columns, the one before fails every acquisition at its read", async (context) => {
    if (!stand) return context.skip();
    const { db } = stand;
    const pageId = await seedPage(db);
    const { generation } = await own(db, pageId);
    await setPageHold(dbOf(db), { pageId, generation, kind: "network", until: new Date("2099-01-01T00:00:00.000Z"), detail: { streak: 1 } });
    const before = await holdRows(db, pageId);

    // S4-31: a hold write is the fence, the rows, then the rewrite of the old
    // columns, in one transaction. The rewrite names columns that are gone
    // (42703 undefined_column), so the write fails whole: a hold it takes is
    // not taken, a hold it lifts stays.
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select owner_generation from sync_pages where page_id = $1 for no key update", [pageId]);
      await client.query(
        "insert into sync_holds (page_id, scope, key, kind, until, detail) values ($1, 'page', '', 'auth', 'infinity', '{\"status\":401}'::jsonb)", [pageId],
      );
      await client.query("delete from sync_holds where page_id = $1 and kind = 'network'", [pageId]);
      await expect(client.query(REWRITE_OF_THE_IMAGE_TWO_BEFORE, [pageId, "auth", "infinity", new Date().toISOString(), "{}", "{}"]))
        .rejects.toMatchObject({ code: "42703", message: 'column "hold_kind" of relation "sync_pages" does not exist' });
      // The transaction is lost: its commit is a rollback.
      expect((await client.query("commit")).command).toBe("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await holdRows(db, pageId)).toEqual(before);

    // S4-30 reads the old columns whenever it acquires a page; an older image
    // knows a page's holds from them alone.
    await expect(db.pool.query(READ_OF_THE_HOLD_SET_IMAGE, [pageId]))
      .rejects.toMatchObject({ code: "42703", message: 'column "hold_kind" does not exist' });
  });
});
