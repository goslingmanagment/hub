import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  clearPageHold,
  createFanslyPage,
  createModel,
  ensureSyncPage,
  getSyncPage,
  legacyHoldColumnsOf,
  listSyncHolds,
  setPageHold,
  setResourceHold,
  writeSafeRelease,
  writeSyncRouteState,
  type Database,
  type FanslySendHolderIdentity,
  type SyncHoldRow,
} from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { holdSetOf, whyHeld } from "../apps/runtime/src/sync/engine/admission.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The hold set (0240, step 4 owner decision №26) on a real Postgres: the
// table's own rules, and the old hold columns of the page row beside it in
// the first of the three releases that take them away (S4-31). Every hold
// write still rewrites them in its transaction — the image before this one
// compares them with the rows when it acquires a page and lets the columns
// win, so a rollback to it must find the two equal — and nothing reads them:
// an acquisition, and a hold write under no generation, take the rows as
// they stand. `hold_step`, which that image never names, is gone (0243).

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

async function seedPage(label = `holds-${randomUUID().slice(0, 8)}`): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

function owner(): FanslySendHolderIdentity {
  return { host: "sync-host-a", pid: 1, pidStart: "start-a", pidNs: "pid:[4026531836]", bootId: "boot-1", instance: randomUUID(), role: "sync" };
}

/** Acquire the page's ownership (a new generation), as the host does. */
async function own(pageId: number): Promise<{ generation: bigint }> {
  const acquired = await acquireSyncPageOwnership(db(), { pageId, owner: owner() });
  if (acquired.kind !== "acquired") throw new Error(`expected to acquire page ${pageId}: ${acquired.kind}`);
  return acquired;
}

/** The old hold columns of the page's row, as the previous image reads them. */
async function oldColumns(pageId: number) {
  const [row] = await query<{
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
  return row!;
}

/**
 * The previous image's check when it acquires the page — after a rollback to
 * it: are the old columns what the page's rows make them? Where they are not
 * its columns win and the rows are replaced, so this build leaves them equal
 * after every hold write.
 */
async function expectColumnsInStep(pageId: number): Promise<void> {
  const stored = await oldColumns(pageId);
  expect({
    holdKind: stored.hold_kind,
    holdUntil: stored.indefinite === true ? INDEFINITE_UNTIL : stored.hold_until,
    holdSince: stored.hold_since,
    holdDetail: stored.hold_detail,
    resourceHolds: stored.resource_holds,
  }).toEqual(legacyHoldColumnsOf(await listSyncHolds(db(), pageId)));
}

/** A writer that knows only the old columns (a hand; the image before the
 *  hold set): the slot and `resource_holds`. */
async function writeOldColumns(pageId: number, columns: { kind: string | null; until?: string | null; since?: string | null; detail?: unknown; resourceHolds?: unknown }) {
  await testDb!.pool.query(
    `update sync_pages set hold_kind = $2, hold_until = $3::timestamptz, hold_since = $4::timestamptz,
            hold_detail = $5::jsonb, resource_holds = $6::jsonb where page_id = $1`,
    [pageId, columns.kind, columns.until ?? null, columns.since ?? null, JSON.stringify(columns.detail ?? {}), JSON.stringify(columns.resourceHolds ?? {})],
  );
}

/** Rows without the instants a test does not name. */
function shape(rows: readonly SyncHoldRow[]) {
  return rows.map((row) => ({ scope: row.scope, key: row.key, kind: row.kind, ladderStep: row.ladderStep, detail: row.detail, revision: row.revision }));
}

const iso = (date: Date) => date.toISOString();

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
    expect(await listSyncHolds(db(), pageId)).toEqual((await getSyncPage(db(), pageId))!.holds);
  });
});

describe("the first old hold column goes (0243)", () => {
  it("the migration drops `hold_step` alone; the hold writes and an acquisition run on what is left", async (context) => {
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

      // What the previous image runs over the table after a rollback — its
      // read of the old columns at an acquisition, its hold writes and their
      // mirror — names none but these columns: it runs unchanged. (This
      // build's hold writers are that image's.)
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
      const acquired = await acquireSyncPageOwnership(partialDb, { pageId, owner: owner() });
      if (acquired.kind !== "acquired") throw new Error(`expected to acquire the page: ${acquired.kind}`);
      await setResourceHold(partialDb, { pageId, generation: acquired.generation, file: "probe", hold: null });
      await clearPageHold(partialDb, { pageId, generation: acquired.generation, kinds: ["auth"] });
      await setPageHold(partialDb, { pageId, generation: acquired.generation, kind: "network", until: new Date("2099-01-01T00:00:00.000Z"), detail: { streak: 3 } });
      expect((await partial.pool.query("select hold_kind, hold_until, hold_detail, resource_holds from sync_pages where page_id = $1", [pageId])).rows).toEqual([
        { hold_kind: "network", hold_until: new Date("2099-01-01T00:00:00.000Z"), hold_detail: { streak: 3 }, resource_holds: {} },
      ]);
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

describe("the old hold columns, still written for a rollback to the previous image", () => {
  it("every hold write rewrites them in its transaction: what that image reads holds what the rows hold", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const { generation } = await own(pageId);
    const fenced = { pageId, generation };
    const networkUntil = new Date(Date.now() + 120_000);
    const breakerUntil = new Date(Date.now() + 1_800_000);
    const routeUntil = new Date(Date.now() + 5_000);
    const last429At = new Date(Date.now() - 1_000);
    const refusal = { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: "2026-10-04T09:00:00.000Z" };

    // The network hold alone is the slot's own hold.
    await setPageHold(db(), { ...fenced, kind: "network", until: networkUntil, detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" } });
    const network = (await listSyncHolds(db(), pageId))[0]!;
    expect(await oldColumns(pageId)).toEqual({
      hold_kind: "network",
      indefinite: false,
      hold_until: networkUntil,
      hold_since: network.since,
      hold_detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" },
      resource_holds: {},
    });
    await expectColumnsInStep(pageId);

    // A credentials hold beside it: the slot is the credentials hold's and
    // carries the network hold in its detail, as that image reads two holds.
    await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: refusal });
    const auth = (await listSyncHolds(db(), pageId))[0]!;
    expect(auth.kind).toBe("auth");
    expect(await oldColumns(pageId)).toMatchObject({
      hold_kind: "auth",
      indefinite: true,
      hold_since: auth.since,
      hold_detail: {
        ...refusal,
        timedHold: { kind: "network", until: iso(networkUntil), detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" } },
      },
    });
    await expectColumnsInStep(pageId);

    // A resource breaker and a route's state, beside each other in `resource_holds`.
    await setResourceHold(db(), { ...fenced, file: "transactions", hold: { until: breakerUntil, step: 1 } });
    await expectColumnsInStep(pageId);
    expect(await writeSyncRouteState(db(), {
      ...fenced,
      route: "messages.page",
      expectRevision: 0,
      entry: { holdUntil: routeUntil, ladderStep: 1, effectivePerMin: 7.5, policyVersion: "v1", last429AttemptId: 42, last429At },
    })).toEqual({ kind: "written", revision: 1 });
    const breaker = (await listSyncHolds(db(), pageId)).find((row) => row.scope === "resource")!;
    expect((await oldColumns(pageId)).resource_holds).toEqual({
      transactions: { until: iso(breakerUntil), step: 1, since: iso(breaker.since) },
      "route:state": {
        version: 1,
        routes: {
          "messages.page": {
            holdUntil: iso(routeUntil), ladderStep: 1, effectivePerMin: 7.5, policyVersion: "v1", last429AttemptId: 42,
            last429At: iso(last429At), revision: 1,
          },
        },
      },
    });
    await expectColumnsInStep(pageId);

    // An identity proof lifts the credentials hold alone: the slot is the
    // network hold's again.
    await clearPageHold(db(), { ...fenced, kinds: ["auth"] });
    expect(await oldColumns(pageId)).toMatchObject({
      hold_kind: "network",
      indefinite: false,
      hold_until: networkUntil,
      hold_detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" },
    });
    await expectColumnsInStep(pageId);
    await clearPageHold(db(), { ...fenced, kinds: ["network"] });
    await setResourceHold(db(), { ...fenced, file: "transactions", hold: null });
    expect(await oldColumns(pageId)).toMatchObject({
      hold_kind: null,
      indefinite: null,
      hold_until: null,
      hold_since: null,
      hold_detail: {},
      resource_holds: { "route:state": { version: 1, routes: { "messages.page": { revision: 1 } } } },
    });
    // The two sides agree: the previous image, taking the page after a
    // rollback, reads nothing back — and neither side moves when this build
    // takes it again.
    await expectColumnsInStep(pageId);
    await writeSafeRelease(db(), fenced);
    const before = { rows: await listSyncHolds(db(), pageId), columns: await oldColumns(pageId) };
    await own(pageId);
    expect({ rows: await listSyncHolds(db(), pageId), columns: await oldColumns(pageId) }).toEqual(before);
  });

  it("a hold write under no generation (the owner's route raise) rewrites them like a fenced one", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const slowed = { holdUntil: null, ladderStep: 1, effectivePerMin: 5, policyVersion: "v1", last429AttemptId: 42, last429At: new Date("2026-10-04T10:00:00.000Z") };
    // The page's actor took a credentials hold and slowed a route, and released.
    const fenced = { pageId, generation: (await own(pageId)).generation };
    await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    expect(await writeSyncRouteState(db(), { ...fenced, route: "messages.page", expectRevision: 0, entry: slowed })).toEqual({ kind: "written", revision: 1 });
    await writeSafeRelease(db(), fenced);

    // `sync` is stopped; the owner raises the route: a compare-and-set on the
    // route's revision, the credentials hold untouched, both sides written.
    expect(await writeSyncRouteState(db(), { pageId, route: "messages.page", expectRevision: 0, entry: { ...slowed, effectivePerMin: 6 } }))
      .toEqual({ kind: "stale" });
    expect(await writeSyncRouteState(db(), { pageId, route: "messages.page", expectRevision: 1, entry: { ...slowed, effectivePerMin: 6 } }))
      .toEqual({ kind: "written", revision: 2 });
    expect(shape(await listSyncHolds(db(), pageId))).toEqual([
      { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: { credentialsGeneration: "gen-a" }, revision: 1 },
      {
        scope: "route", key: "messages.page", kind: "route_budget", ladderStep: 1,
        detail: { effectivePerMin: 6, policyVersion: "v1", last429AttemptId: 42, last429At: "2026-10-04T10:00:00.000Z" }, revision: 2,
      },
    ]);
    expect(await oldColumns(pageId)).toMatchObject({
      hold_kind: "auth",
      indefinite: true,
      hold_detail: { credentialsGeneration: "gen-a" },
      resource_holds: { "route:state": { version: 1, routes: { "messages.page": { effectivePerMin: 6, revision: 2 } } } },
    });
    await expectColumnsInStep(pageId);
  });

  it("a write that fails writes neither side", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const { generation } = await own(pageId);
    await setPageHold(db(), { pageId, generation, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    const before = { rows: await listSyncHolds(db(), pageId), columns: await oldColumns(pageId) };
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
    expect({ rows: await listSyncHolds(db(), pageId), columns: await oldColumns(pageId) }).toEqual(before);
  });
});

describe("nothing reads the old hold columns", () => {
  const routeUntil = new Date(Date.now() + 300_000).toISOString();
  /** Columns that say something else than any rows of these tests: another
   *  credentials hold, a breaker, a held and slowed route. */
  const elsewhere = {
    kind: "identity_mismatch",
    until: "infinity",
    since: "2026-10-04T08:00:00.000Z",
    detail: { credentialsGeneration: "gen-z" },
    resourceHolds: {
      probe: { until: "2099-01-01T00:00:00.000Z", step: 7, since: "2026-10-02T21:54:26.507Z" },
      "route:state": {
        version: 1,
        routes: {
          "messaging.groups": {
            holdUntil: routeUntil, ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 99,
            last429At: "2026-10-04T08:30:00.000Z", revision: 4,
          },
        },
      },
    },
  };

  it("an acquisition takes the page's rows as they stand, whatever the columns say, and writes neither side", async (context) => {
    if (!testDb) return context.skip();
    // A page held by its rows, the columns saying something else.
    const held = await seedPage();
    const first = await own(held);
    await setPageHold(db(), { pageId: held, generation: first.generation, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    await setResourceHold(db(), { pageId: held, generation: first.generation, file: "posts", hold: { until: new Date(Date.now() + 1_800_000), step: 1 } });
    await writeSafeRelease(db(), { pageId: held, generation: first.generation });
    for (const columns of [
      elsewhere,
      // Nothing at all — rows changed alone, as a build that no longer writes the columns leaves them.
      { kind: null },
      // A route state no build ever wrote.
      { kind: null, resourceHolds: { "route:state": { version: 9, routes: {} } } },
    ]) {
      await writeOldColumns(held, columns);
      const before = { rows: await listSyncHolds(db(), held), columns: await oldColumns(held) };
      const acquired = await own(held);
      expect({ rows: await listSyncHolds(db(), held), columns: await oldColumns(held) }).toEqual(before);
      expect(shape(before.rows)).toEqual([
        { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: { credentialsGeneration: "gen-a" }, revision: 1 },
        { scope: "resource", key: "posts", kind: "resource_breaker", ladderStep: 1, detail: {}, revision: 1 },
      ]);
      const page = (await getSyncPage(db(), held))!;
      expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow)).toMatchObject({ scope: "credentials", kind: "auth" });
      await writeSafeRelease(db(), { pageId: held, generation: acquired.generation });
    }

    // A page whose columns hold something and that has no row: the hold-set
    // release never acquired it. Nothing is read here — which is why this
    // release ships only once every page's rows are what its columns say.
    const never = await seedPage();
    await writeOldColumns(never, elsewhere);
    await own(never);
    expect(await listSyncHolds(db(), never)).toEqual([]);
    const page = (await getSyncPage(db(), never))!;
    expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow)).toBeNull();
    expect(await oldColumns(never)).toMatchObject({ hold_kind: "identity_mismatch", indefinite: true, resource_holds: elsewhere.resourceHolds });
  });

  it("a hold write under no generation reads none back either — columns it cannot make sense of do not refuse it — and rewrites them from the rows", async (context) => {
    if (!testDb) return context.skip();
    for (const columns of [elsewhere, { kind: null, resourceHolds: { "route:state": "v1" } }]) {
      const pageId = await seedPage();
      await writeSafeRelease(db(), { pageId, generation: (await own(pageId)).generation });
      await writeOldColumns(pageId, columns);
      const until = new Date(Date.now() + 60_000);
      await setResourceHold(db(), { pageId, file: "posts", hold: { until, step: 1 } });
      const rows = await listSyncHolds(db(), pageId);
      expect(shape(rows)).toEqual([{ scope: "resource", key: "posts", kind: "resource_breaker", ladderStep: 1, detail: {}, revision: 1 }]);
      expect(await oldColumns(pageId)).toEqual({
        hold_kind: null,
        indefinite: null,
        hold_until: null,
        hold_since: null,
        hold_detail: {},
        resource_holds: { posts: { until: iso(until), step: 1, since: iso(rows[0]!.since) } },
      });
    }
  });
});
