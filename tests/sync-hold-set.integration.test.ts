import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  addSyncPageLiftedDmExclusion,
  adjustPausedResources,
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
  LiveSyncPageRefusedError,
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
import {
  acquireAsHoldSetImage,
  acquireAsPreviousImage,
  reconcileAsHoldSetImage,
  SyncLegacyHoldsUnreadableError,
} from "./helpers/sync-holds-hold-set-image.ts";
import { mirrorHoldsAsPreviousImage, previousImageHoldColumnsOf } from "./helpers/sync-holds-previous-image.ts";
import { syncPageRowWriters } from "./helpers/sync-page-row-writers.ts";

// The hold set (0240, step 4 owner decision №26) on a real Postgres: the
// table's own rules, and the old hold columns of the page row beside it in
// the second of the three releases that take them away (S4-32).
//
// The hold writers write the rows and nothing of the page row. The old
// columns (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`,
// `resource_holds`) stay in the database with their two CHECKs, stale: no
// statement of this build reads them, and one writes them — an acquisition
// marks the page's row as one whose old columns are stale
// (`resource_holds['route:state']` at a version no build read;
// tests/sync-old-hold-columns.test.ts pins that nothing else names them). So
// every insert and every other update of the page row leaves them as they
// are, the marker included — proved here statement by statement. The release
// before this one, which reads none of them and rewrites them from the rows
// at every hold write, runs on what this one leaves; the hold-set release,
// which lets the columns win over the rows, is no rollback target any more,
// and refuses every page that carries the marker instead of opening it.

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

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

/** The page's hold set as every reader gets it: with the page row. */
async function holdRows(pageId: number): Promise<SyncHoldRow[]> {
  return (await getSyncPage(db(), pageId))!.holds;
}

/** A Fansly page without an engine row. */
async function seedFanslyPage(label = `holds-${randomUUID().slice(0, 8)}`): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  return (await createFanslyPage(db(), { modelId: model!.id, label }))!.id;
}

/** A page with its engine row in mode `off` (`ensureSyncPage`). */
async function seedPage(): Promise<number> {
  const pageId = await seedFanslyPage();
  await ensureSyncPage(db(), { pageId });
  return pageId;
}

/** A page born live, as onboarding creates it (`createLiveSyncPage`). */
async function seedLivePage(): Promise<number> {
  const pageId = await seedFanslyPage();
  await testDb!.db.transaction(async (tx) => createLiveSyncPage(tx as unknown as Database, {
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
async function own(pageId: number): Promise<{ generation: bigint }> {
  const acquired = await acquireSyncPageOwnership(db(), { pageId, owner: owner() });
  if (acquired.kind !== "acquired") throw new Error(`expected to acquire page ${pageId}: ${acquired.kind}`);
  return acquired;
}

/** The old hold columns as a writer that knows only them sets them. */
interface OldColumns {
  kind: string | null;
  until?: string | null;
  since?: string | null;
  detail?: unknown;
  resourceHolds?: unknown;
}

/** Write a page's old hold columns: a release that still wrote them, or a hand. */
async function writeOldColumns(pageId: number, columns: OldColumns): Promise<void> {
  await testDb!.pool.query(
    `update sync_pages set hold_kind = $2, hold_until = $3::timestamptz, hold_since = $4::timestamptz,
            hold_detail = $5::jsonb, resource_holds = $6::jsonb where page_id = $1`,
    [pageId, columns.kind, columns.until ?? null, columns.since ?? null, JSON.stringify(columns.detail ?? {}), JSON.stringify(columns.resourceHolds ?? {})],
  );
}

/** The old hold columns of the page's row, exactly as stored. */
async function oldColumns(pageId: number) {
  const [row] = await query<{
    hold_kind: string | null;
    hold_until: string | null;
    hold_since: string | null;
    hold_detail: Record<string, unknown>;
    resource_holds: Record<string, unknown>;
  }>(
    `select hold_kind, hold_until::text as hold_until, hold_since::text as hold_since, hold_detail, resource_holds
       from sync_pages where page_id = $1`,
    [pageId],
  );
  return row!;
}

/** What a row is born with, and what the two CHECKs admit of it. */
const DEFAULTS = { hold_kind: null, hold_until: null, hold_since: null, hold_detail: {}, resource_holds: {} };

/** What an acquisition by this build leaves in the old resource-hold map: the
 *  route-state entry at a version no build ever read, with no route. */
const MARKER = { "route:state": { version: 2, routes: {} } };

/** The old columns once this build has taken the page: the hold slot as it
 *  was, the map with the marker in it (alone, where it was no JSON object). */
function marked(columns: Awaited<ReturnType<typeof oldColumns>>) {
  const map: unknown = columns.resource_holds;
  const kept = typeof map === "object" && map !== null && !Array.isArray(map) ? map : {};
  return { ...columns, resource_holds: { ...kept, ...MARKER } };
}

/** What a refused statement was refused for: the driver error under a drizzle
 *  error — its SQLSTATE and, for a CHECK, the constraint. */
function refusalOf(error: unknown): { code: string | null; constraint: string | null } {
  for (let current = error; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") return { code, constraint: typeof constraint === "string" ? constraint : null };
  }
  return { code: null, constraint: null };
}

/** The page's owner generation, as stored. */
async function generationOf(pageId: number): Promise<number> {
  const [row] = await query<{ generation: number }>("select owner_generation::int as generation from sync_pages where page_id = $1", [pageId]);
  return row!.generation;
}

/** The old hold columns as the previous images read them (typed). */
async function oldColumnsRead(pageId: number) {
  const [stored] = await query<{
    hold_kind: string | null;
    indefinite: boolean | null;
    hold_until: Date | null;
    hold_since: Date | null;
    hold_detail: Record<string, unknown>;
    resource_holds: Record<string, unknown>;
  }>(
    `select hold_kind, hold_until = 'infinity'::timestamptz as indefinite,
            case when hold_until = 'infinity'::timestamptz then null else hold_until end as hold_until,
            hold_since, hold_detail, resource_holds
       from sync_pages where page_id = $1`,
    [pageId],
  );
  return {
    holdKind: stored!.hold_kind,
    holdUntil: stored!.indefinite === true ? INDEFINITE_UNTIL : stored!.hold_until,
    holdSince: stored!.hold_since,
    holdDetail: stored!.hold_detail,
    resourceHolds: stored!.resource_holds,
  };
}

/** The physical version of the page's row: another one after every write of
 *  it, the same after a lock. */
async function rowVersion(pageId: number) {
  const [row] = await query<{ xmin: string; ctid: string }>(
    "select xmin::text as xmin, ctid::text as ctid from sync_pages where page_id = $1", [pageId],
  );
  return row!;
}

/** Rows without the instants a test does not name. */
function shape(rows: readonly SyncHoldRow[]) {
  return rows.map((row) => ({ scope: row.scope, key: row.key, kind: row.kind, ladderStep: row.ladderStep, detail: row.detail, revision: row.revision }));
}

/** What the old columns of a page may say when this release takes it over
 *  (each shape one the two CHECKs admitted when it was written). */
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

describe("the hold set table (0240)", () => {
  it("the migration: an empty table beside the page rows it leaves alone, granted to the read role", async (context) => {
    if (!testDb) return context.skip();
    const migrations = readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql")).sort();
    const migration = migrations.find((file) => file.endsWith("_sync_holds.sql"))!;
    const partial = await startIntegrationTestDatabase({ through: migrations[migrations.indexOf(migration) - 1]! });
    if (!partial) return context.skip();
    try {
      // A page as the previous image left it: holds in the old columns.
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label) select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(
        `insert into sync_pages (page_id, mode, mode_changed_by, hold_kind, hold_until, hold_since, hold_detail, resource_holds)
         select id, 'live', 'test', 'auth', 'infinity', clock_timestamp(), '{"credentialsGeneration":"gen-a"}'::jsonb,
                '{"probe":{"until":"2099-01-01T00:00:00Z","step":7,"since":"2026-10-02T21:54:26.507558+00:00"}}'::jsonb
           from pages where label = 'seed-fansly'`,
      );
      const before = await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp");
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({ db: client, migrationsDir: path.resolve("packages/db/migrations"), through: migration });
      } finally {
        client.release();
      }
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
    const pageId = await seedPage();
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
    expect((await getSyncPage(db(), pageId))!.holds.map((row) => `${row.scope}/${row.key}/${row.kind}`)).toEqual([
      "page//auth", "page//network", "resource/transactions/resource_breaker", "route/messages.page/route_budget", "route/messages.page/route_hold",
    ]);
    expect((await getSyncPage(db(), pageId))!.holds[0]!.until).toEqual(INDEFINITE_UNTIL);
  });
});

describe("the first old hold column goes (0243)", () => {
  it("the migration drops `hold_step` alone; the hold writes and an acquisition of the image before it run on what is left", async (context) => {
    if (!testDb) return context.skip();
    const migrations = readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql")).sort();
    const migration = migrations.find((file) => file.endsWith("_sync_pages_drop_hold_step.sql"))!;
    const partial = await startIntegrationTestDatabase({ through: migrations[migrations.indexOf(migration) - 1]! });
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
      const pageId = Number((await partial.pool.query("select page_id from sync_pages")).rows[0].page_id);
      const before = await partial.pool.query("select to_jsonb(sp) - 'hold_step' as row from sync_pages sp");
      const holds = await partial.pool.query("select to_jsonb(h) as row from sync_holds h order by h.scope");
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({ db: client, migrationsDir: path.resolve("packages/db/migrations"), through: migration });
        // The bound on its lock wait is the migration's own: gone with its transaction.
        expect((await client.query("show lock_timeout")).rows).toEqual([{ lock_timeout: "0" }]);
      } finally {
        client.release();
      }
      const columns = await partial.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'sync_pages' and (column_name like 'hold%' or column_name in ('resource_holds', 'network_failure_streak'))
          order by 1`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(["hold_detail", "hold_kind", "hold_since", "hold_until", "network_failure_streak", "resource_holds"]);
      // Nothing else of the row changed, and no hold row.
      expect((await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp")).rows).toEqual(before.rows);
      expect((await partial.pool.query("select to_jsonb(h) as row from sync_holds h order by h.scope")).rows).toEqual(holds.rows);

      // What the image before this migration runs over the table after a
      // rollback — its read of the old columns at an acquisition, its hold
      // writes and the rewrite of the columns that ends each of them — names
      // none but these columns: it runs unchanged. (Its acquisition is kept
      // in tests/helpers/sync-holds-hold-set-image.ts; its hold writes are
      // the rows this build writes, then its rewrite as
      // tests/helpers/sync-holds-previous-image.ts keeps it.)
      const read = await partial.pool.query(
        "select hold_kind, hold_until = 'infinity'::timestamptz as indefinite, hold_since, hold_detail, resource_holds from sync_pages where page_id = $1", [pageId],
      );
      expect(read.rows).toEqual([{
        hold_kind: "auth",
        indefinite: true,
        hold_since: new Date("2026-10-04T08:00:00.000Z"),
        hold_detail: { credentialsGeneration: "gen-a" },
        resource_holds: { probe: { until: "2099-01-01T00:00:00.000Z", step: 7, since: "2026-10-02T21:54:26.507Z" } },
      }]);
      const partialDb = partial.db as unknown as Database;
      const acquired = await acquireAsHoldSetImage(partial, { pageId, owner: owner() });
      if (acquired.kind !== "acquired") throw new Error(`expected to acquire the page: ${acquired.kind}`);
      // The two sides were in step: it read the columns and replaced nothing.
      expect(acquired.holdsImported).toBe(false);
      expect((await partial.pool.query("select to_jsonb(h) as row from sync_holds h order by h.scope")).rows).toEqual(holds.rows);
      await setResourceHold(partialDb, { pageId, generation: acquired.generation, file: "probe", hold: null });
      await mirrorHoldsAsPreviousImage(partial, pageId);
      await clearPageHold(partialDb, { pageId, generation: acquired.generation, kinds: ["auth"] });
      await mirrorHoldsAsPreviousImage(partial, pageId);
      await setPageHold(partialDb, { pageId, generation: acquired.generation, kind: "network", until: new Date("2099-01-01T00:00:00.000Z"), detail: { streak: 3 } });
      await mirrorHoldsAsPreviousImage(partial, pageId);
      expect((await partial.pool.query("select hold_kind, hold_until, hold_detail, resource_holds from sync_pages where page_id = $1", [pageId])).rows).toEqual([
        { hold_kind: "network", hold_until: new Date("2099-01-01T00:00:00.000Z"), hold_detail: { streak: 3 }, resource_holds: {} },
      ]);
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

describe("a hold write writes the rows and nothing of the page row", () => {
  it("every kind of hold write, fenced or under no generation: the rows change, the page row is locked and not written, its old columns stay", async (context) => {
    if (!testDb) return context.skip();
    for (const [what, columns] of Object.entries(STALE)) {
      const pageId = await seedPage();
      await writeOldColumns(pageId, columns);
      const left = await oldColumns(pageId);
      // This build takes the page: its columns are marked stale, and stay so.
      const { generation } = await own(pageId);
      const stale = await oldColumns(pageId);
      expect(stale, what).toEqual(marked(left));
      const version = await rowVersion(pageId);
      const fenced = { pageId, generation };
      const networkUntil = new Date(Date.now() + 120_000);
      const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: "2026-10-04T09:00:00.000Z" };
      const slowed = { ladderStep: 1, effectivePerMin: 7.5, policyVersion: "v1", last429AttemptId: 42, last429At: new Date("2026-10-04T10:00:00.000Z") };

      await setPageHold(db(), { ...fenced, kind: "network", until: networkUntil, detail: { streak: 3 } });
      await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: refusal });
      await setResourceHold(db(), { ...fenced, file: "transactions", hold: { until: new Date(Date.now() + 1_800_000), step: 1 } });
      expect(await writeSyncRouteState(db(), {
        ...fenced, route: "messages.page", expectRevision: 0, entry: { ...slowed, holdUntil: new Date(Date.now() + 5_000) },
      })).toEqual({ kind: "written", revision: 1 });
      // Under no generation: the owner's `sync route raise`.
      expect(await writeSyncRouteState(db(), {
        pageId, route: "messages.page", expectRevision: 1, entry: { ...slowed, holdUntil: null, effectivePerMin: 8.5 },
      })).toEqual({ kind: "written", revision: 2 });
      expect(shape(await holdRows(pageId)), what).toEqual([
        { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: refusal, revision: 1 },
        { scope: "page", key: "", kind: "network", ladderStep: 0, detail: { streak: 3 }, revision: 1 },
        { scope: "resource", key: "transactions", kind: "resource_breaker", ladderStep: 1, detail: {}, revision: 1 },
        {
          scope: "route", key: "messages.page", kind: "route_budget", ladderStep: 1,
          detail: { effectivePerMin: 8.5, policyVersion: "v1", last429AttemptId: 42, last429At: "2026-10-04T10:00:00.000Z" }, revision: 2,
        },
      ]);
      await clearPageHold(db(), { ...fenced, kinds: ["auth"] });
      await setResourceHold(db(), { ...fenced, file: "transactions", hold: null });
      expect((await holdRows(pageId)).map((row) => `${row.scope}/${row.key}/${row.kind}`), what)
        .toEqual(["page//network", "route/messages.page/route_budget"]);

      // Seven hold writes: the page row was locked each time and never written
      // — its old columns, the marker among them, are what they were.
      expect(await rowVersion(pageId), what).toEqual(version);
      expect(await oldColumns(pageId), what).toEqual(stale);
      // What holds the page is what its rows say, whatever the columns do.
      const page = (await getSyncPage(db(), pageId))!;
      expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow), what).toMatchObject({ scope: "page", kind: "network", until: networkUntil });
    }
  });

  it("a write that fails writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const { generation } = await own(pageId);
    await setPageHold(db(), { pageId, generation, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    const before = { rows: await holdRows(pageId), columns: await oldColumns(pageId), version: await rowVersion(pageId) };
    // A foreign generation; a stale revision; a transaction that rolls back.
    await expect(setPageHold(db(), { pageId, generation: generation + 1n, kind: "network", until: new Date(Date.now() + 60_000) })).rejects.toThrow();
    expect(await writeSyncRouteState(db(), {
      pageId, generation, route: "polls", expectRevision: 3,
      entry: { holdUntil: new Date(Date.now() + 60_000), ladderStep: 1, effectivePerMin: 7.5, policyVersion: null, last429AttemptId: 1, last429At: new Date() },
    })).toEqual({ kind: "stale" });
    await expect(testDb.db.transaction(async (tx) => {
      await setResourceHold(tx as unknown as Database, { pageId, generation, file: "posts", hold: { until: new Date(Date.now() + 60_000), step: 1 } });
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");
    expect({ rows: await holdRows(pageId), columns: await oldColumns(pageId), version: await rowVersion(pageId) }).toEqual(before);
  });
});

describe("the old hold columns stay in the database: every write of the page row but an acquisition's marker leaves them as they are", () => {
  /** The functions with a statement that inserts a page row. */
  const INSERTS = ["ensureSyncPage", "ensureFanslySyncPages", "createLiveSyncPage"];
  /** The functions with a statement that updates one. */
  const UPDATES = [
    "acquireSyncPageOwnership", "heartbeatSyncPageOwner", "trustSyncPageCredentials", "recordSyncPageIdentityProof",
    "setNetworkFailureStreak", "addSyncPageLiftedDmExclusion", "removeSyncPageLiftedDmExclusion", "setPagePause",
    "adjustPausedResources", "setRegistryOverride", "insertAdmission", "captureAttempt",
    "writeSafeRelease", "confirmSyncOwnersStopped", "setSyncPageMode",
  ];

  it("these are every statement of the sources that writes a page row", () => {
    expect(syncPageRowWriters().map((writer) => `${writer.statement} ${writer.name}`).sort()).toEqual([
      ...INSERTS.map((name) => `insert ${name}`),
      ...UPDATES.map((name) => `update ${name}`),
      // An acquisition has two: the owner generation, and the marker — the
      // one statement of the build that names an old column.
      "update acquireSyncPageOwnership",
    ].sort());
  });

  it("the slot's two CHECKs are in force; a page born under this build — ensured, or onboarded live — has the columns at their defaults", async (context) => {
    if (!testDb) return context.skip();
    expect(await query(
      `select conname, convalidated, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'sync_pages'::regclass and conname like 'sync_pages_hold_%'
        order by conname`,
    )).toEqual([
      {
        conname: "sync_pages_hold_kind_check",
        convalidated: true,
        definition: "CHECK (((hold_kind IS NULL) OR (hold_kind = ANY (ARRAY['rate_limit'::text, 'auth'::text, 'identity_mismatch'::text, 'network'::text]))))",
      },
      { conname: "sync_pages_hold_pair_check", convalidated: true, definition: "CHECK (((hold_kind IS NULL) = (hold_until IS NULL)))" },
    ]);
    expect((await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'sync_pages' and (column_name like 'hold%' or column_name = 'resource_holds')
        order by 1`,
    )).map((row) => row.column_name)).toEqual(["hold_detail", "hold_kind", "hold_since", "hold_until", "resource_holds"]);

    // `ensureSyncPage`: a page's row in mode `off`.
    const ensured = await seedFanslyPage();
    expect(await ensureSyncPage(db(), { pageId: ensured })).toEqual({ created: true });
    // `ensureFanslySyncPages`: the host at start, for every page without one.
    const first = await seedFanslyPage();
    const second = await seedFanslyPage();
    expect(await ensureFanslySyncPages(db())).toBe(2);
    // `createLiveSyncPage`: onboarding's insert, the page born live.
    const onboarded = await seedLivePage();
    expect((await getSyncPage(db(), onboarded))!.mode).toBe("live");
    for (const pageId of [ensured, first, second, onboarded]) {
      expect(await oldColumns(pageId)).toEqual(DEFAULTS);
      expect(await holdRows(pageId)).toEqual([]);
    }

    // The CHECKs judge what a statement would store: one that named the
    // columns wrongly is refused, one that leaves them alone never is.
    await expect(testDb.pool.query("update sync_pages set hold_kind = 'auth' where page_id = $1", [onboarded])).rejects.toThrow(/sync_pages_hold_pair_check/);
    await expect(testDb.pool.query("update sync_pages set hold_kind = 'route_hold', hold_until = 'infinity' where page_id = $1", [onboarded]))
      .rejects.toThrow(/sync_pages_hold_kind_check/);
  });

  it("every statement that updates a page row runs over stale columns, whatever they say: an acquisition marks them, every other leaves them as they were — the marker too", async (context) => {
    if (!testDb) return context.skip();
    for (const [what, columns] of Object.entries(STALE)) {
      // A live page (the engine's writes) and a page left in mode `shadow`,
      // which nothing reaches any more (the owner's mode lever takes it `off`,
      // the one transition there is since step 4 S4-23).
      const pageId = await seedLivePage();
      const offPage = await seedPage();
      await testDb.pool.query("update sync_pages set mode = 'shadow' where page_id = $1", [offPage]);
      await writeOldColumns(pageId, columns);
      await writeOldColumns(offPage, columns);
      const stale = await oldColumns(pageId);
      expect(await oldColumns(offPage)).toEqual(stale);

      let generation = 0n;
      let attemptId = 0;
      const admit = () => testDb!.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        const work = await upsertDemand(tx, { pageId, resource: "dm-messages.head", subject: "group-1", kind: "trigger", class: "urgent" });
        await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update", live: true });
        const running = await markWorkRunning(tx, { workId: work.id, generation });
        const admitted = await insertAdmission(tx, {
          pageId, workId: work.id, resource: "dm-messages.head", subject: "group-1", class: "urgent", slot: 0, nextCyclePos: 1,
          generation, demandRevision: running!.demandRevision, settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200, operation: "messages.page",
          request: { path: "/api/v1/message", query: { groupId: "group-1" } }, evidence: true,
        });
        return admitted.attemptId;
      });
      const steps: Array<[name: string, page: number, run: () => Promise<unknown>]> = [
        ["acquireSyncPageOwnership", pageId, async () => { generation = (await own(pageId)).generation; }],
        ["heartbeatSyncPageOwner", pageId, async () => expect(await heartbeatSyncPageOwner(db(), { pageId, generation })).toBe(true)],
        ["trustSyncPageCredentials", pageId, async () => expect(await trustSyncPageCredentials(db(), {
          pageId, generation: "b".repeat(64), accountId: "acct", verifiedAt: new Date(),
        })).toBe(true)],
        ["recordSyncPageIdentityProof", pageId, async () => expect(await recordSyncPageIdentityProof(db(), {
          pageId, generation, accountId: "acct", credentialsGeneration: "c".repeat(64), sentAt: new Date(Date.now() + 1_000),
        })).toBe(true)],
        ["setNetworkFailureStreak", pageId, () => setNetworkFailureStreak(db(), { pageId, generation, streak: 2 })],
        ["addSyncPageLiftedDmExclusion", pageId, async () => expect(await addSyncPageLiftedDmExclusion(db(), {
          pageId, reason: SYNC_LIFTABLE_DM_EXCLUSIONS[0],
        })).toMatchObject({ added: true })],
        ["removeSyncPageLiftedDmExclusion", pageId, async () => expect(await removeSyncPageLiftedDmExclusion(db(), {
          pageId, reason: SYNC_LIFTABLE_DM_EXCLUSIONS[0],
        })).toMatchObject({ removed: true })],
        ["setPagePause", pageId, async () => expect(await setPagePause(db(), {
          pageId, requests: true, resources: ["posts.refresh"], note: "test",
        })).toMatchObject({ pausedRequests: true, pausedResources: ["posts.refresh"] })],
        ["adjustPausedResources", pageId, async () => expect(await adjustPausedResources(db(), {
          pageId, add: ["media-stats.walk"], remove: ["posts.refresh"],
        })).toMatchObject({ pausedResources: ["media-stats.walk"] })],
        ["setRegistryOverride", pageId, async () => expect(await setRegistryOverride(db(), {
          pageId, key: "media-stats.walk", override: { everyMs: 86_400_000 },
        })).toBe(true)],
        ["insertAdmission", pageId, async () => { attemptId = await admit(); }],
        ["captureAttempt", pageId, async () => expect(await captureAttempt(db(), {
          attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(), sendMark: "request_start", httpStatus: 200, applyState: "none",
        })).toMatchObject({ captured: true })],
        ["writeSafeRelease", pageId, async () => expect(await writeSafeRelease(db(), { pageId, generation })).toBe(true)],
        // A second owner, gone with its container: the deploy confirms it stopped.
        ["acquireSyncPageOwnership", pageId, async () => { generation = (await own(pageId)).generation; }],
        ["confirmSyncOwnersStopped", pageId, async () => expect(await confirmSyncOwnersStopped(db(), {
          runningHosts: ["sync-host-b"], ownHost: "cli", confirmedBy: "deploy", dryRun: false, pageIds: [pageId],
        })).toMatchObject([{ pageId, confirmed: true }])],
        ["setSyncPageMode", offPage, async () => expect(await setSyncPageMode(db(), { pageId: offPage, to: "off", changedBy: "test" }))
          .toMatchObject({ kind: "changed", from: "shadow", to: "off" })],
      ];
      expect([...new Set(steps.map(([name]) => name))].sort()).toEqual([...UPDATES].sort());

      // What the old columns of each page must say: as they were, until an
      // acquisition marks them; then that, through every statement after it.
      const expected = new Map([[pageId, stale], [offPage, stale]]);
      for (const [name, page, run] of steps) {
        const version = await rowVersion(page);
        await run();
        // The statement wrote the row (a new version of it), and the CHECKs
        // admitted the new version: with the marker for an acquisition, with
        // the old columns as they were for every other statement.
        expect(await rowVersion(page), `${what}: ${name} writes the page row`).not.toEqual(version);
        if (name === "acquireSyncPageOwnership") expected.set(page, marked(stale));
        expect(await oldColumns(page), `${what}: ${name}`).toEqual(expected.get(page));
      }
      // Fourteen statements after the first acquisition, a second acquisition
      // among them: the marker is there, beside what the columns said. The
      // page never acquired has none.
      expect((await oldColumns(pageId)).resource_holds, what).toEqual({ ...stale.resource_holds, ...MARKER });
      expect(await oldColumns(offPage), what).toEqual(stale);

      // Nor does an insert over a row that is there touch it.
      expect(await ensureSyncPage(db(), { pageId })).toEqual({ created: false });
      expect(await ensureFanslySyncPages(db())).toBe(0);
      await expect(testDb.db.transaction(async (tx) => createLiveSyncPage(tx as unknown as Database, {
        pageId, by: "onboarding:test", identityAccountId: "acct", identityCheckedAt: new Date(), credentialsGeneration: "a".repeat(64),
      }))).rejects.toBeInstanceOf(LiveSyncPageRefusedError);
      expect(await oldColumns(pageId), what).toEqual(expected.get(pageId));
    }
  });

  it("nothing reads them: an acquisition, the page's status and a hold write under no generation take the rows as they stand", async (context) => {
    if (!testDb) return context.skip();
    for (const [what, columns] of [
      ...Object.entries(STALE),
      // A route state no build ever wrote; a value that is no object at all.
      ["an unknown route state", { kind: null, resourceHolds: { "route:state": { version: 9, routes: {} } } }],
      ["a route state of another type", { kind: null, resourceHolds: { "route:state": "v1" } }],
    ] as Array<[string, OldColumns]>) {
      // A page held by its rows, the columns saying something else.
      const held = await seedPage();
      const first = await own(held);
      await setPageHold(db(), { pageId: held, generation: first.generation, kind: "identity_mismatch", until: "infinity", detail: { credentialsGeneration: "gen-x" } });
      await writeSafeRelease(db(), { pageId: held, generation: first.generation });
      // A page its rows do not hold, the columns saying it is held.
      const free = await seedPage();
      await writeOldColumns(held, columns);
      await writeOldColumns(free, columns);
      const stale = await oldColumns(held);

      await own(held);
      await own(free);
      expect(shape(await holdRows(held)), what).toEqual([
        { scope: "page", key: "", kind: "identity_mismatch", ladderStep: 0, detail: { credentialsGeneration: "gen-x" }, revision: 1 },
      ]);
      expect(await holdRows(free), what).toEqual([]);
      const heldPage = (await getSyncPage(db(), held))!;
      expect(whyHeld(holdSetOf(heldPage.holds), null, {}, heldPage.dbNow), what).toMatchObject({ scope: "credentials", kind: "identity_mismatch" });
      const freePage = (await getSyncPage(db(), free))!;
      expect(whyHeld(holdSetOf(freePage.holds), null, {}, freePage.dbNow), what).toBeNull();

      // A hold write under no generation is not refused by columns it could
      // not make sense of: it reads none.
      await setResourceHold(db(), { pageId: free, file: "posts", hold: { until: new Date(Date.now() + 60_000), step: 1 } });
      expect((await holdRows(free)).map((row) => `${row.scope}/${row.key}/${row.kind}`), what).toEqual(["resource/posts/resource_breaker"]);
      // Of the columns the acquisition changed its marker alone — over the
      // route state that was there, readable or not.
      expect(await oldColumns(held), what).toEqual(marked(stale));
      expect(await oldColumns(free), what).toEqual(marked(stale));
    }
  });

  it("the page status (the status routes, `sync page status`) and the alerts say what the rows say, never what the columns do", async (context) => {
    if (!testDb) return context.skip();
    const registry = createFanslyRegistry();
    const read = async (pageId: number) => {
      const page = (await getSyncPage(db(), pageId))!;
      const status = await readSyncPageStatus(db(), testConfig(testDb!.connectionString), page);
      return {
        holds: status.holds,
        heldRoutes: status.routes!.routes.filter((route) => route.holdUntil !== null).map((route) => route.name),
        stopped: (await collectPageAlerts(db(), { page, registry }))
          .filter((condition) => condition.subKey === "page_stopped").flatMap((condition) => condition.reasons.map((reason) => reason.detail)),
        routeAlerts: evaluateRouteAlerts(page, page.dbNow).map((condition) => condition.route),
      };
    };

    // The columns say: a credentials hold, a network hold, a breaker, a held
    // and slowed route. The rows say nothing: nothing is held.
    const free = await seedLivePage();
    await writeOldColumns(free, Object.values(STALE)[0]!);
    await own(free);
    expect((await oldColumns(free)).hold_kind).toBe("auth");
    expect(await read(free)).toEqual({ holds: { page: null, resources: [] }, heldRoutes: [], stopped: [], routeAlerts: [] });

    // The rows say all of that, the columns nothing but the marker (a page onboarded here).
    const held = await seedLivePage();
    const fenced = { pageId: held, generation: (await own(held)).generation };
    await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: { status: 401, credentialsGeneration: "gen-b" } });
    await setResourceHold(db(), { ...fenced, file: "transactions", hold: { until: new Date(Date.now() + 1_800_000), step: 1 } });
    await writeSyncRouteState(db(), {
      ...fenced, route: "messaging.groups", expectRevision: 0,
      entry: { holdUntil: new Date(Date.now() + 300_000), ladderStep: 1, effectivePerMin: 6, policyVersion: null, last429AttemptId: null, last429At: new Date() },
    });
    expect(await oldColumns(held)).toEqual(marked(DEFAULTS));
    expect(await read(held)).toMatchObject({
      holds: { page: { kind: "auth", until: "infinity" }, resources: [{ file: "transactions", step: 1 }] },
      heldRoutes: ["messaging.groups"],
      stopped: ["auth"],
      routeAlerts: ["messaging.groups"],
    });
  });
});

describe("an acquisition marks the page's old hold columns stale", () => {
  it("in the transaction of the ownership change, whatever the columns said; a second acquisition changes nothing; a page onboarded here gets it at its first", async (context) => {
    if (!testDb) return context.skip();
    for (const [what, columns] of [
      ...Object.entries(STALE),
      // A route state no build ever wrote; values that are no JSON object.
      ["an unknown route state", { kind: null, resourceHolds: { probe: { until: "2099-01-01T00:00:00.000Z", step: 1 }, "route:state": { version: 9, routes: {} } } }],
      ["a route state of another type", { kind: null, resourceHolds: { "route:state": "v1" } }],
      ["a map that is a JSON array", { kind: null, resourceHolds: ["probe"] }],
      ["a map that is a JSON string", { kind: null, resourceHolds: "none" }],
    ] as Array<[string, OldColumns]>) {
      const pageId = await seedPage();
      await writeOldColumns(pageId, columns);
      const left = await oldColumns(pageId);

      // An acquisition that does not commit leaves neither the owner
      // generation nor the marker: they are one transaction.
      await expect(testDb.db.transaction(async (tx) => {
        const acquired = await acquireSyncPageOwnership(tx as unknown as Database, { pageId, owner: owner() });
        expect(acquired, what).toMatchObject({ kind: "acquired", generation: 1n });
        throw new Error("rolled back");
      })).rejects.toThrow("rolled back");
      expect({ generation: await generationOf(pageId), columns: await oldColumns(pageId) }, what).toEqual({ generation: 0, columns: left });

      // One that commits leaves both. Of the old columns the map alone
      // changed: the marker in it, the hold slot and the other entries as
      // they were.
      const first = await own(pageId);
      const taken = await oldColumns(pageId);
      expect(first.generation, what).toBe(1n);
      expect(taken, what).toEqual(marked(left));
      expect(taken.resource_holds, what).toMatchObject(MARKER);
      expect({ ...taken, resource_holds: null }, what).toEqual({ ...left, resource_holds: null });

      // Idempotent: the next acquisition finds the marker and leaves the same.
      await writeSafeRelease(db(), { pageId, generation: first.generation });
      expect((await own(pageId)).generation, what).toBe(2n);
      expect(await oldColumns(pageId), what).toEqual(taken);

      // An acquisition refused (the owner is not confirmed stopped) writes nothing.
      const version = await rowVersion(pageId);
      expect(await acquireSyncPageOwnership(db(), { pageId, owner: owner("sync-host-b") }), what).toMatchObject({ kind: "unconfirmed" });
      expect(await rowVersion(pageId), what).toEqual(version);
    }

    // A page onboarded by this build is born with the defaults, and carries
    // the marker from its first acquisition — before any hold is taken on it.
    const born = await seedLivePage();
    expect(await oldColumns(born)).toEqual(DEFAULTS);
    await own(born);
    expect(await oldColumns(born)).toEqual({ ...DEFAULTS, resource_holds: MARKER });
    expect(await holdRows(born)).toEqual([]);
  });

  it("no acquisition without it: a marker that cannot be written fails the acquisition, the owner generation with it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // Something that refuses the marker and nothing else of the row.
    await testDb.pool.query(`alter table sync_pages add constraint test_refuses_the_marker check (not (resource_holds ? 'route:state'))`);
    try {
      const failure: unknown = await acquireSyncPageOwnership(db(), { pageId, owner: owner() }).then(() => null, (error: unknown) => error);
      expect(refusalOf(failure)).toEqual({ code: "23514", constraint: "test_refuses_the_marker" });
      expect({ generation: await generationOf(pageId), columns: await oldColumns(pageId) }).toEqual({ generation: 0, columns: DEFAULTS });
    } finally {
      await testDb.pool.query("alter table sync_pages drop constraint test_refuses_the_marker");
    }
    expect((await own(pageId)).generation).toBe(1n);
    expect(await oldColumns(pageId)).toEqual(marked(DEFAULTS));
  });

  it("once the old columns are dropped — the next release's migration, under this image — an acquisition takes the page all the same", async (context) => {
    if (!testDb) return context.skip();
    const dropped = await startIntegrationTestDatabase();
    if (!dropped) return context.skip();
    try {
      const droppedDb = dropped.db as unknown as Database;
      const model = await createModel(droppedDb, { slug: "model-dropped", name: "dropped" });
      const pageId = (await createFanslyPage(droppedDb, { modelId: model!.id, label: "dropped" }))!.id;
      await ensureSyncPage(droppedDb, { pageId });
      // Taken once while the columns are there: the marker is written.
      const before = await acquireSyncPageOwnership(droppedDb, { pageId, owner: owner() });
      if (before.kind !== "acquired") throw new Error(`expected to acquire the page: ${before.kind}`);
      expect((await dropped.pool.query("select resource_holds from sync_pages where page_id = $1", [pageId])).rows).toEqual([{ resource_holds: MARKER }]);
      await writeSafeRelease(droppedDb, { pageId, generation: before.generation });

      await dropped.pool.query(
        `alter table sync_pages
           drop constraint if exists sync_pages_hold_pair_check,
           drop constraint if exists sync_pages_hold_kind_check,
           drop column if exists hold_kind,
           drop column if exists hold_until,
           drop column if exists hold_since,
           drop column if exists hold_detail,
           drop column if exists resource_holds`,
      );

      // There is nothing to mark, and nothing that could read a mark: the
      // acquisition is the ownership change alone, and the page runs.
      const after = await acquireSyncPageOwnership(droppedDb, { pageId, owner: owner() });
      expect(after).toMatchObject({ kind: "acquired", generation: 2n, evidence: "safe_release" });
      if (after.kind !== "acquired") return;
      expect(await heartbeatSyncPageOwner(droppedDb, { pageId, generation: after.generation })).toBe(true);
      await setPageHold(droppedDb, { pageId, generation: after.generation, kind: "network", until: new Date(Date.now() + 60_000), detail: { streak: 3 } });
      expect((await getSyncPage(droppedDb, pageId))!.holds.map((row) => `${row.scope}/${row.key}/${row.kind}`)).toEqual(["page//network"]);
      // Inside a caller's transaction too: the refused statement costs its
      // savepoint, not the transaction around it.
      await writeSafeRelease(droppedDb, { pageId, generation: after.generation });
      const third = await dropped.db.transaction(async (tx) => {
        const acquired = await acquireSyncPageOwnership(tx as unknown as Database, { pageId, owner: owner() });
        // A transaction a failed statement had aborted would refuse this one.
        await setNetworkFailureStreak(tx as unknown as Database, { pageId, generation: 3n, streak: 1 });
        return acquired;
      });
      expect(third).toMatchObject({ kind: "acquired", generation: 3n });
      expect((await dropped.pool.query("select owner_generation::int as generation, network_failure_streak as streak from sync_pages where page_id = $1", [pageId])).rows)
        .toEqual([{ generation: 3, streak: 1 }]);
    } finally {
      await dropped.stop();
    }
  }, 120_000);
});

describe("rollback targets of this release", () => {
  const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: "2026-10-04T09:00:00.000Z" };
  const slowed = { ladderStep: 1, effectivePerMin: 7.5, policyVersion: "v1", last429AttemptId: 42, last429At: new Date("2026-10-04T10:00:00.000Z") };

  /**
   * What this release leaves behind on three pages, each taken by it (so
   * marked) and safely released when `sync` stops for the deploy:
   * - `lifted`: the old columns say what the page's rows held when this
   *   release took it over (a credentials hold carrying a network hold, a
   *   breaker, a slowed and held route); this release lifted all of it;
   * - `taken`: the columns say nothing; this release took a credentials hold,
   *   a network hold, a breaker and a route's state;
   * - `born`: a page onboarded by this release (columns at their defaults),
   *   with a hold taken since.
   */
  async function leftByThisRelease() {
    const lifted = await seedPage();
    await writeOldColumns(lifted, Object.values(STALE)[0]!);
    const taken = await seedPage();
    const born = await seedLivePage();
    for (const pageId of [lifted, taken, born]) {
      const fenced = { pageId, generation: (await own(pageId)).generation };
      if (pageId !== lifted) await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: refusal });
      if (pageId === taken) {
        await setPageHold(db(), { ...fenced, kind: "network", until: new Date("2099-01-01T00:00:00.000Z"), detail: { streak: 3 } });
        await setResourceHold(db(), { ...fenced, file: "transactions", hold: { until: new Date("2099-01-01T00:00:00.000Z"), step: 2 } });
        expect(await writeSyncRouteState(db(), {
          ...fenced, route: "messages.page", expectRevision: 0, entry: { ...slowed, holdUntil: new Date("2099-01-01T00:00:00.000Z") },
        })).toEqual({ kind: "written", revision: 1 });
      }
      // `sync` stops for the deploy: a safe release.
      await writeSafeRelease(db(), fenced);
    }
    return { lifted, taken, born };
  }

  /** The three pages' rows, columns and owner generation. */
  async function stateOf(pages: Awaited<ReturnType<typeof leftByThisRelease>>) {
    const read = async (pageId: number) => ({ rows: await holdRows(pageId), columns: await oldColumns(pageId), generation: await generationOf(pageId) });
    return { lifted: await read(pages.lifted), taken: await read(pages.taken), born: await read(pages.born) };
  }

  it("the release before this one (rows only, the columns rewritten at every hold write) runs on what this release leaves", async (context) => {
    if (!testDb) return context.skip();
    const pages = await leftByThisRelease();
    const left = await stateOf(pages);
    expect(left.lifted.rows).toEqual([]);
    expect(left.lifted.columns).toEqual(marked({ ...left.lifted.columns, resource_holds: Object.values(STALE)[0]!.resourceHolds as Record<string, unknown> }));
    expect(left.lifted.columns.hold_kind).toBe("auth");
    expect(left.taken.rows.map((row) => `${row.scope}/${row.key}/${row.kind}`)).toEqual([
      "page//auth", "page//network", "resource/transactions/resource_breaker", "route/messages.page/route_budget", "route/messages.page/route_hold",
    ]);
    expect(left.taken.columns).toEqual(marked(DEFAULTS));
    expect(left.born.columns).toEqual(marked(DEFAULTS));

    // The rollback. That image acquires each page — its own acquisition: no
    // old column is read, none written, so the marker stays where it is — and
    // holds what the rows hold: the page whose holds were lifted is free, the
    // two others held.
    const generations = new Map<number, bigint>();
    for (const [name, pageId] of Object.entries(pages) as Array<[keyof typeof pages, number]>) {
      const acquired = await acquireAsPreviousImage(testDb, { pageId, owner: owner() });
      if (acquired.kind !== "acquired") throw new Error(`expected that image to acquire ${name}: ${acquired.kind}`);
      generations.set(pageId, acquired.generation);
      expect(await holdRows(pageId), name).toEqual(left[name].rows);
      expect(await oldColumns(pageId), name).toEqual(left[name].columns);
      const page = (await getSyncPage(db(), pageId))!;
      const held = whyHeld(holdSetOf(page.holds), null, {}, page.dbNow);
      if (name === "lifted") expect(held, name).toBeNull();
      // The network hold stops everything first; the credentials hold alone on the page born here.
      else expect(held, name).toMatchObject(name === "taken" ? { scope: "page", kind: "network" } : { scope: "credentials", kind: "auth" });
    }

    // Its hold writes: the rows, as this build writes them, then its rewrite
    // of the old columns from the rows. Whatever the columns said — the
    // marker with the rest — they are what the rows make them afterwards, and
    // the two CHECKs admit each rewrite.
    for (const [name, pageId] of Object.entries(pages) as Array<[keyof typeof pages, number]>) {
      const fenced = { pageId, generation: generations.get(pageId)! };
      await setResourceHold(db(), { ...fenced, file: "posts", hold: { until: new Date("2099-06-01T00:00:00.000Z"), step: 1 } });
      await mirrorHoldsAsPreviousImage(testDb, pageId);
      const rows = await holdRows(pageId);
      expect(rows.map((row) => `${row.scope}/${row.key}/${row.kind}`), name).toEqual([
        ...left[name].rows.filter((row) => row.scope === "page").map((row) => `page//${row.kind}`),
        "resource/posts/resource_breaker",
        ...left[name].rows.filter((row) => row.scope !== "page").map((row) => `${row.scope}/${row.key}/${row.kind}`),
      ]);
      expect(await oldColumnsRead(pageId), name).toEqual(previousImageHoldColumnsOf(rows));
    }
    // The page whose columns said "held" says what its rows say now, and no marker.
    expect(await oldColumnsRead(pages.lifted)).toEqual({
      holdKind: null, holdUntil: null, holdSince: null, holdDetail: {},
      resourceHolds: { posts: { until: "2099-06-01T00:00:00.000Z", step: 1, since: expect.any(String) } },
    });
    expect(await oldColumnsRead(pages.taken)).toMatchObject({
      holdKind: "auth",
      holdUntil: INDEFINITE_UNTIL,
      holdDetail: { ...refusal, timedHold: { kind: "network", until: "2099-01-01T00:00:00.000Z", detail: { streak: 3 } } },
      resourceHolds: {
        posts: { step: 1 },
        transactions: { until: "2099-01-01T00:00:00.000Z", step: 2 },
        "route:state": { version: 1, routes: { "messages.page": { holdUntil: "2099-01-01T00:00:00.000Z", effectivePerMin: 7.5, revision: 1 } } },
      },
    });
    // A hold that image lifts is lifted on both sides.
    const born = { pageId: pages.born, generation: generations.get(pages.born)! };
    await clearPageHold(db(), { ...born, kinds: ["auth"] });
    await mirrorHoldsAsPreviousImage(testDb, pages.born);
    expect(await oldColumnsRead(pages.born)).toMatchObject({ holdKind: null, holdUntil: null, holdDetail: {} });

    // The way forward again: this release takes the pages back and reads the
    // rows that image kept current; the columns stay where it left them, the
    // marker in them once more.
    for (const pageId of Object.values(pages)) {
      await writeSafeRelease(db(), { pageId, generation: generations.get(pageId)! });
      const before = { rows: await holdRows(pageId), columns: await oldColumns(pageId) };
      await own(pageId);
      expect({ rows: await holdRows(pageId), columns: await oldColumns(pageId) }).toEqual({ rows: before.rows, columns: marked(before.columns) });
    }
  });

  it("the hold-set release, were it to come back: without the marker it lets the stale columns win — fail open; with it, it refuses the page, nothing written", async (context) => {
    if (!testDb) return context.skip();

    // What the marker is for, by that image's own acquisition over pages as
    // this release would leave them had it not marked them.
    const unmarked = await leftByThisRelease();
    for (const pageId of Object.values(unmarked)) {
      await testDb.pool.query("update sync_pages set resource_holds = resource_holds - 'route:state' where page_id = $1", [pageId]);
    }
    // (The page whose columns carried a route state gets it back: what the
    // release before this one left there.)
    await writeOldColumns(unmarked.lifted, Object.values(STALE)[0]!);
    for (const [name, pageId] of Object.entries(unmarked) as Array<[keyof typeof unmarked, number]>) {
      expect(await acquireAsHoldSetImage(testDb, { pageId, owner: owner() }), name).toMatchObject({ kind: "acquired", holdsImported: true });
    }
    // Every hold this release lifted is back …
    expect((await holdRows(unmarked.lifted)).map((row) => `${row.scope}/${row.key}/${row.kind}`)).toEqual([
      "page//auth", "page//network", "resource/probe/resource_breaker", "route/messaging.groups/route_budget", "route/messaging.groups/route_hold",
    ]);
    // … and every hold it took is gone: the credentials hold, the network
    // hold, the breaker, the route's hold and its slowdown.
    expect(await holdRows(unmarked.taken)).toEqual([]);
    expect(await holdRows(unmarked.born)).toEqual([]);
    for (const pageId of [unmarked.taken, unmarked.born]) {
      const page = (await getSyncPage(db(), pageId))!;
      expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow)).toBeNull();
    }

    // The same three pages as this release does leave them: marked.
    const pages = await leftByThisRelease();
    const left = await stateOf(pages);
    for (const [name, pageId] of Object.entries(pages) as Array<[keyof typeof pages, number]>) {
      expect(left[name].columns.resource_holds, name).toMatchObject(MARKER);
      // Its acquisition: the columns are not what the rows make them, it
      // reads them, and cannot read the route state's version.
      const refused = acquireAsHoldSetImage(testDb, { pageId, owner: owner() });
      await expect(refused, name).rejects.toBeInstanceOf(SyncLegacyHoldsUnreadableError);
      await expect(refused, name).rejects.toThrow(/the old hold columns are not readable \(route_state_version:2\)/);
      // Its read before a hold write under no generation (`sync route raise`).
      await expect(reconcileAsHoldSetImage(testDb, pageId), name).rejects.toThrow(/route_state_version:2/);
    }
    // Nothing was written: no page changed its owner generation, its rows or
    // its columns. The holds this release took stand, those it lifted stay lifted.
    expect(await stateOf(pages)).toEqual(left);
    // And it refuses again at every retry: the page stays closed until a
    // build that reads the rows is back — which takes it as ever.
    await expect(acquireAsHoldSetImage(testDb, { pageId: pages.taken, owner: owner() })).rejects.toBeInstanceOf(SyncLegacyHoldsUnreadableError);
    for (const pageId of Object.values(pages)) await own(pageId);
    expect((await stateOf(pages)).taken.rows).toEqual(left.taken.rows);
  });

  it("after a rollback to the release before this one, the hold-set release takes a page only where that release has rewritten the columns from the rows", async (context) => {
    if (!testDb) return context.skip();
    const pages = await leftByThisRelease();
    // The release before this one takes the three pages and makes a hold
    // write on two of them; `born` it only owns.
    for (const pageId of Object.values(pages)) {
      const acquired = await acquireAsPreviousImage(testDb, { pageId, owner: owner() });
      if (acquired.kind !== "acquired") throw new Error(`expected that image to acquire page ${pageId}: ${acquired.kind}`);
      if (pageId !== pages.born) {
        await setResourceHold(db(), { pageId, generation: acquired.generation, file: "posts", hold: { until: new Date("2099-06-01T00:00:00.000Z"), step: 1 } });
        await mirrorHoldsAsPreviousImage(testDb, pageId);
      }
      await writeSafeRelease(db(), { pageId, generation: acquired.generation });
    }
    const left = await stateOf(pages);

    // Where the columns were rewritten they are what the rows make them: the
    // hold-set release takes the page and changes no hold.
    for (const name of ["lifted", "taken"] as const) {
      expect(left[name].columns.resource_holds, name).not.toHaveProperty(["route:state", "version"], 2);
      expect(await acquireAsHoldSetImage(testDb, { pageId: pages[name], owner: owner() }), name)
        .toMatchObject({ kind: "acquired", holdsImported: false });
      expect(await holdRows(pages[name]), name).toEqual(left[name].rows);
      expect(await oldColumns(pages[name]), name).toEqual(left[name].columns);
    }
    // Where they were not, the marker is still there: refused, nothing written.
    expect(left.born.columns).toEqual(marked(DEFAULTS));
    await expect(acquireAsHoldSetImage(testDb, { pageId: pages.born, owner: owner() })).rejects.toBeInstanceOf(SyncLegacyHoldsUnreadableError);
    expect((await stateOf(pages)).born).toEqual(left.born);
  });
});
