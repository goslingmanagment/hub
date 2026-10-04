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
  listSyncHolds,
  setPageHold,
  setResourceHold,
  SyncLegacyHoldsUnreadableError,
  writeSafeRelease,
  writeSyncRouteState,
  type Database,
  type FanslySendHolderIdentity,
  type SyncHoldRow,
} from "@agency_hub_core/db";
import { INDEFINITE_UNTIL } from "@agency_hub_core/shared";

import { holdSetOf, whyHeld } from "../apps/runtime/src/sync/engine/admission.ts";
import { routeAdmissionView, RouteClocks } from "../apps/runtime/src/sync/engine/route-policy.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// The hold set (0240, step 4 owner decision №26) on a real Postgres: the
// table's own rules, the old hold columns kept in step with it for the
// previous image (every hold write rewrites them in its transaction), and the
// way back — a page's rows re-read from those columns when they say something
// else: when its ownership is acquired, and before a hold write under no
// generation.

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
async function own(pageId: number): Promise<{ generation: bigint; holdsImported: boolean }> {
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
    hold_step: number;
    hold_detail: Record<string, unknown>;
    resource_holds: Record<string, unknown>;
  }>(
    `select hold_kind, hold_until = 'infinity'::timestamptz as indefinite,
            case when hold_until = 'infinity'::timestamptz then null else hold_until end as hold_until,
            hold_since, hold_step::int as hold_step, hold_detail, resource_holds
       from sync_pages where page_id = $1`,
    [pageId],
  );
  return row!;
}

/** Rows without the instants a test does not name. */
function shape(rows: readonly SyncHoldRow[]) {
  return rows.map((row) => ({ scope: row.scope, key: row.key, kind: row.kind, ladderStep: row.ladderStep, detail: row.detail, revision: row.revision }));
}

const iso = (date: Date) => date.toISOString();

describe("the hold set table (0240)", () => {
  it("the migration: an empty table beside the old columns it leaves alone, granted to the read role", async (context) => {
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
      // Its state reaches the table when its ownership is acquired, never by
      // a copy the previous image — still running here — could outdate.
      expect((await partial.pool.query("select count(*)::int as n from sync_holds")).rows).toEqual([{ n: 0 }]);
      expect((await partial.pool.query("select to_jsonb(sp) as row from sync_pages sp")).rows).toEqual(before.rows);
      expect((await partial.pool.query("select has_table_privilege('read_only', 'sync_holds', 'select') as granted")).rows).toEqual([{ granted: true }]);
      const acquired = await acquireSyncPageOwnership(partial.db as unknown as Database, {
        pageId: Number(before.rows[0].row.page_id),
        owner: owner(),
      });
      expect(acquired).toMatchObject({ kind: "acquired", holdsImported: true });
      expect((await partial.pool.query("select scope, key, kind, ladder_step::int as step from sync_holds order by scope, key, kind")).rows).toEqual([
        { scope: "page", key: "", kind: "auth", step: 0 },
        { scope: "resource", key: "probe", kind: "resource_breaker", step: 7 },
      ]);
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

describe("the old hold columns, kept in step for the previous image", () => {
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
      hold_step: 0,
      hold_detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" },
      resource_holds: {},
    });

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

    // A resource breaker and a route's state, beside each other in `resource_holds`.
    await setResourceHold(db(), { ...fenced, file: "transactions", hold: { until: breakerUntil, step: 1 } });
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

    // An identity proof lifts the credentials hold alone: the slot is the
    // network hold's again.
    await clearPageHold(db(), { ...fenced, kinds: ["auth"] });
    expect(await oldColumns(pageId)).toMatchObject({
      hold_kind: "network",
      indefinite: false,
      hold_until: networkUntil,
      hold_detail: { streak: 3, networkSince: "2026-10-04T08:59:00.000Z" },
    });
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
    // The two sides agree: a new owner has nothing to read back.
    await writeSafeRelease(db(), fenced);
    expect((await own(pageId)).holdsImported).toBe(false);
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

describe("the hold set read back from the old columns", () => {
  /** What the previous image wrote: the slot and `resource_holds`. */
  async function writeOldColumns(pageId: number, columns: { kind: string | null; until?: string | null; since?: string | null; detail?: unknown; resourceHolds?: unknown }) {
    await testDb!.pool.query(
      `update sync_pages set hold_kind = $2, hold_until = $3::timestamptz, hold_since = $4::timestamptz,
              hold_detail = $5::jsonb, resource_holds = $6::jsonb where page_id = $1`,
      [pageId, columns.kind, columns.until ?? null, columns.since ?? null, JSON.stringify(columns.detail ?? {}), JSON.stringify(columns.resourceHolds ?? {})],
    );
  }

  it("a page's state first reaches the table this way: both page holds, the breakers and the route state", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const since = "2026-10-04T08:00:00.000Z";
    const networkUntil = new Date(Date.now() + 90_000).toISOString();
    const routeUntil = new Date(Date.now() + 300_000).toISOString();
    const breakerUntil = new Date(Date.now() + 1_800_000).toISOString();
    await writeOldColumns(pageId, {
      kind: "auth",
      until: "infinity",
      since,
      detail: {
        status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: since,
        timedHold: { kind: "network", until: networkUntil, detail: { streak: 4, networkSince: "2026-10-04T07:59:00.000Z" } },
      },
      resourceHolds: {
        probe: { until: breakerUntil, step: 7, since: "2026-10-02T21:54:26.507558+00:00" },
        // An older build's endpoint-group hold: no build reads it any more.
        "dm-conversations": { until: breakerUntil, kind: "rate_limit_list", step: 2 },
        "route:state": {
          version: 1,
          routes: {
            "messaging.groups": {
              holdUntil: routeUntil, ladderStep: 2, effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 99,
              last429At: "2026-10-04T08:30:00.000Z", revision: 4,
            },
            polls: { holdUntil: null, ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 2 },
          },
        },
      },
    });
    const first = await own(pageId);
    expect(first.holdsImported).toBe(true);
    const rows = await listSyncHolds(db(), pageId);
    expect(shape(rows)).toEqual([
      { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: { status: 401, credentialsGeneration: "gen-b", failedAttemptId: 7, failedAt: since }, revision: 1 },
      { scope: "page", key: "", kind: "network", ladderStep: 0, detail: { streak: 4, networkSince: "2026-10-04T07:59:00.000Z" }, revision: 1 },
      { scope: "resource", key: "probe", kind: "resource_breaker", ladderStep: 7, detail: {}, revision: 1 },
      {
        scope: "route", key: "messaging.groups", kind: "route_budget", ladderStep: 2,
        detail: { effectivePerMin: 3, policyVersion: "abc", last429AttemptId: 99, last429At: "2026-10-04T08:30:00.000Z" }, revision: 4,
      },
      { scope: "route", key: "messaging.groups", kind: "route_hold", ladderStep: 0, detail: {}, revision: 1 },
      { scope: "route", key: "polls", kind: "route_budget", ladderStep: 0, detail: { effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null }, revision: 2 },
    ]);
    expect(rows.map((row) => row.until?.toISOString() ?? null)).toEqual([
      INDEFINITE_UNTIL.toISOString(), networkUntil, breakerUntil, null, routeUntil, null,
    ]);
    expect(rows[0]!.since.toISOString()).toBe(since);
    expect(rows[1]!.since.toISOString()).toBe("2026-10-04T07:59:00.000Z");
    expect(rows[2]!.since.toISOString()).toBe("2026-10-02T21:54:26.507Z");

    // What the engine admits by, from the page row: nothing while the network
    // hold stands, then only the identity checks the credentials hold admits.
    const page = (await getSyncPage(db(), pageId))!;
    const holds = holdSetOf(page.holds);
    expect(whyHeld(holds, null, {}, page.dbNow)).toMatchObject({ scope: "page", kind: "network" });
    const afterNetwork = new Date(Date.parse(networkUntil) + 1);
    expect(whyHeld(holds, null, {}, afterNetwork)).toMatchObject({ scope: "credentials", kind: "auth" });
    expect(whyHeld(holds, null, { operation: { kind: "verify", digest: "gen-c" } }, afterNetwork)).toBeNull();
    expect(holds.routes).toMatchObject({ ok: true, state: { routes: { "messaging.groups": { holdUntil: routeUntil, revision: 4, effectivePerMin: 3 } } } });
    if (!holds.routes.ok) throw new Error("the route state reads");
    const routes = routeAdmissionView(new RouteClocks({ sends: [], state: holds.routes.state }), [{ key: "dm-conversations.head", operations: ["messaging.groups"] }], afterNetwork);
    expect(whyHeld(holds, routes, { operation: { kind: "candidate_check" }, work: { resource: "dm-conversations.head" } }, afterNetwork))
      .toEqual({ scope: "route_hold", kind: "route", until: new Date(routeUntil), routes: ["messaging.groups"], held: ["messaging.groups"] });

    // The columns are now exactly what the rows say (the group hold is gone
    // from them): the next owner reads nothing back.
    expect((await oldColumns(pageId)).resource_holds).not.toHaveProperty("dm-conversations");
    await writeSafeRelease(db(), { pageId, generation: first.generation });
    const before = await listSyncHolds(db(), pageId);
    const second = await own(pageId);
    expect(second.holdsImported).toBe(false);
    expect(await listSyncHolds(db(), pageId)).toEqual(before);
  });

  it("after a rollback: what the previous image wrote and lifted meanwhile is the page's state", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const first = await own(pageId);
    const fenced = { pageId, generation: first.generation };
    // This image: an auth hold and a breaker.
    await setPageHold(db(), { ...fenced, kind: "auth", until: "infinity", detail: { credentialsGeneration: "gen-a" } });
    await setResourceHold(db(), { ...fenced, file: "posts", hold: { until: new Date(Date.now() + 1_800_000), step: 1 } });
    await writeSafeRelease(db(), fenced);
    // The previous image ran the page: its identity proof cleared the hold,
    // an ok answer lifted the breaker, and a 429 held and slowed a route.
    const routeUntil = new Date(Date.now() + 40_000).toISOString();
    await writeOldColumns(pageId, {
      kind: null,
      resourceHolds: {
        "route:state": {
          version: 1,
          routes: {
            "media.offer_stats": {
              holdUntil: routeUntil, ladderStep: 1, effectivePerMin: 2.5, policyVersion: "p", last429AttemptId: 5,
              last429At: "2026-10-04T10:00:00.000Z", revision: 1,
            },
          },
        },
      },
    });
    const second = await own(pageId);
    expect(second.holdsImported).toBe(true);
    const rows = await listSyncHolds(db(), pageId);
    expect(shape(rows)).toEqual([
      {
        scope: "route", key: "media.offer_stats", kind: "route_budget", ladderStep: 1,
        detail: { effectivePerMin: 2.5, policyVersion: "p", last429AttemptId: 5, last429At: "2026-10-04T10:00:00.000Z" }, revision: 1,
      },
      { scope: "route", key: "media.offer_stats", kind: "route_hold", ladderStep: 0, detail: {}, revision: 1 },
    ]);
    // The slowdown is durable across it: the next write is a compare-and-set
    // on the revision that image left.
    const state = { ladderStep: 2, effectivePerMin: 1.5, policyVersion: "p", last429AttemptId: 6, last429At: new Date() };
    expect(await writeSyncRouteState(db(), { pageId, generation: second.generation, route: "media.offer_stats", expectRevision: 0, entry: { ...state, holdUntil: null } }))
      .toEqual({ kind: "stale" });
    expect(await writeSyncRouteState(db(), { pageId, generation: second.generation, route: "media.offer_stats", expectRevision: 1, entry: { ...state, holdUntil: new Date(routeUntil) } }))
      .toEqual({ kind: "written", revision: 2 });
  });

  it("a hold write under no generation (the owner's route raise) reads the columns back first: it never writes outdated rows over what the previous image left", async (context) => {
    if (!testDb) return context.skip();
    const slowed = { holdUntil: null, ladderStep: 1, effectivePerMin: 5, policyVersion: "v1", last429AttemptId: 42, last429At: new Date("2026-10-04T10:00:00.000Z") };
    const refusal = { status: 401, credentialsGeneration: "gen-a", failedAttemptId: 50, failedAt: "2026-10-04T10:05:00.000Z" };
    const breakerUntil = new Date(Date.now() + 1_800_000).toISOString();
    /** A page this image slowed a route of (revision 1) and released — a
     *  rollback follows — and that the previous image then ran: it took a
     *  credentials hold and a breaker, and wrote `route` as `entry`. */
    async function afterRollback(entry: Record<string, unknown>): Promise<number> {
      const pageId = await seedPage();
      const fenced = { pageId, generation: (await own(pageId)).generation };
      expect(await writeSyncRouteState(db(), { ...fenced, route: "messages.page", expectRevision: 0, entry: slowed })).toEqual({ kind: "written", revision: 1 });
      await writeSafeRelease(db(), fenced);
      const routes = (await oldColumns(pageId)).resource_holds["route:state"] as { routes: Record<string, Record<string, unknown>> };
      await writeOldColumns(pageId, {
        kind: "auth",
        until: "infinity",
        since: refusal.failedAt,
        detail: refusal,
        resourceHolds: {
          posts: { until: breakerUntil, step: 2, since: refusal.failedAt },
          "route:state": { version: 1, routes: { "messages.page": { ...routes.routes["messages.page"], ...entry } } },
        },
      });
      return pageId;
    }
    const held = [
      { scope: "page", key: "", kind: "auth", ladderStep: 0, detail: refusal, revision: 1 },
      { scope: "resource", key: "posts", kind: "resource_breaker", ladderStep: 2, detail: {}, revision: 1 },
    ];
    const state = { effectivePerMin: 5, policyVersion: "v1", last429AttemptId: 42, last429At: "2026-10-04T10:00:00.000Z" };

    // This image is back and its host has not taken the page yet. A raise of
    // the route that image left alone is written — over the rows its columns
    // say, so the holds it took stand on both sides.
    const untouched = await afterRollback({});
    expect(await writeSyncRouteState(db(), { pageId: untouched, route: "messages.page", expectRevision: 1, entry: { ...slowed, effectivePerMin: 6 } }))
      .toEqual({ kind: "written", revision: 2 });
    expect(shape(await listSyncHolds(db(), untouched))).toEqual([
      ...held,
      { scope: "route", key: "messages.page", kind: "route_budget", ladderStep: 1, detail: { ...state, effectivePerMin: 6 }, revision: 2 },
    ]);
    expect(await oldColumns(untouched)).toMatchObject({
      hold_kind: "auth",
      indefinite: true,
      hold_detail: refusal,
      resource_holds: {
        posts: { until: breakerUntil, step: 2 },
        "route:state": { version: 1, routes: { "messages.page": { effectivePerMin: 6, revision: 2 } } },
      },
    });
    // The two sides agree, and the page is held as that image held it.
    expect((await own(untouched)).holdsImported).toBe(false);
    const page = (await getSyncPage(db(), untouched))!;
    expect(whyHeld(holdSetOf(page.holds), null, {}, page.dbNow)).toMatchObject({ scope: "credentials", kind: "auth" });

    // A raise computed from this image's rows of a route that image slowed
    // again (its second 429: revision 2) meets that revision: nothing raised,
    // and the columns stand as that image left them.
    const routeUntil = new Date(Date.now() + 300_000).toISOString();
    const again = { holdUntil: routeUntil, ladderStep: 2, effectivePerMin: 2.5, last429AttemptId: 51, last429At: "2026-10-04T10:06:00.000Z", revision: 2 };
    const slowedAgain = await afterRollback(again);
    const before = await oldColumns(slowedAgain);
    expect(await writeSyncRouteState(db(), { pageId: slowedAgain, route: "messages.page", expectRevision: 1, entry: { ...slowed, effectivePerMin: 6 } }))
      .toEqual({ kind: "stale" });
    expect(await oldColumns(slowedAgain)).toEqual(before);
    expect(shape(await listSyncHolds(db(), slowedAgain))).toEqual([
      ...held,
      {
        scope: "route", key: "messages.page", kind: "route_budget", ladderStep: 2,
        detail: { ...state, effectivePerMin: 2.5, last429AttemptId: 51, last429At: "2026-10-04T10:06:00.000Z" }, revision: 2,
      },
      { scope: "route", key: "messages.page", kind: "route_hold", ladderStep: 0, detail: {}, revision: 1 },
    ]);
  });

  it("rows changed alone are replaced by what the columns say — this build is a rollback target only of a build that still writes the columns", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await writeSafeRelease(db(), { pageId, generation: (await own(pageId)).generation });
    // A writer that left the columns alone — a hand, or a later build that no
    // longer mirrors: a credentials hold and a held, slowed route, rows only.
    await testDb.pool.query(
      `insert into sync_holds (page_id, scope, key, kind, until, ladder_step, detail)
       values ($1, 'page', '', 'auth', 'infinity', 0, '{"credentialsGeneration":"gen-a"}'),
              ($1, 'route', 'messages.page', 'route_hold', clock_timestamp() + interval '5 minutes', 0, '{}'),
              ($1, 'route', 'messages.page', 'route_budget', null, 1, '{"effectivePerMin":5,"policyVersion":"v1","last429AttemptId":9,"last429At":"2026-10-04T10:00:00.000Z"}')`,
      [pageId],
    );
    const before = (await getSyncPage(db(), pageId))!;
    expect(whyHeld(holdSetOf(before.holds), null, {}, before.dbNow)).toMatchObject({ scope: "credentials", kind: "auth" });
    // The columns hold nothing, and they win: the page is open again. Hence
    // the order of the releases after this one (README, "The hold set"): the
    // first only stops reading the columns back and still writes them.
    expect((await own(pageId)).holdsImported).toBe(true);
    expect(await listSyncHolds(db(), pageId)).toEqual([]);
    const after = (await getSyncPage(db(), pageId))!;
    expect(whyHeld(holdSetOf(after.holds), null, {}, after.dbNow)).toBeNull();
  });

  it("a page-wide 429 hold an older build left holds the page until its end all the same (fail closed)", async (context) => {
    if (!testDb) return context.skip();
    const own429 = await seedPage();
    const until = new Date(Date.now() + 120_000);
    await writeOldColumns(own429, { kind: "rate_limit", until: until.toISOString(), since: "2026-10-04T08:00:00.000Z", detail: { status: 429 } });
    expect((await own(own429)).holdsImported).toBe(true);
    const page = (await getSyncPage(db(), own429))!;
    expect(shape(page.holds)).toEqual([
      { scope: "page", key: "", kind: "network", ladderStep: 0, detail: { status: 429, legacyKind: "rate_limit" }, revision: 1 },
    ]);
    expect(whyHeld(holdSetOf(page.holds), null, { operation: { kind: "candidate_check" } }, page.dbNow)).toMatchObject({ scope: "page", until });
    expect(await oldColumns(own429)).toMatchObject({ hold_kind: "network", hold_until: until, hold_detail: { status: 429, legacyKind: "rate_limit" } });

    const carried = await seedPage();
    await writeOldColumns(carried, {
      kind: "identity_mismatch",
      until: "infinity",
      since: "2026-10-04T08:00:00.000Z",
      detail: { credentialsGeneration: "gen-a", timedHold: { kind: "rate_limit", until: until.toISOString(), detail: { lastRateLimitAt: "2026-10-04T08:10:00.000Z" } } },
    });
    await own(carried);
    const rows = await listSyncHolds(db(), carried);
    expect(shape(rows)).toEqual([
      { scope: "page", key: "", kind: "identity_mismatch", ladderStep: 0, detail: { credentialsGeneration: "gen-a" }, revision: 1 },
      { scope: "page", key: "", kind: "network", ladderStep: 0, detail: { lastRateLimitAt: "2026-10-04T08:10:00.000Z", legacyKind: "rate_limit" }, revision: 1 },
    ]);
    expect(rows[1]!.until).toEqual(until);
  });

  it("a page that holds nothing on either side is not written; old columns no build wrote refuse the acquisition", async (context) => {
    if (!testDb) return context.skip();
    const clean = await seedPage();
    const acquired = await own(clean);
    expect(acquired.holdsImported).toBe(false);
    expect(await listSyncHolds(db(), clean)).toEqual([]);
    expect(await oldColumns(clean)).toMatchObject({ hold_kind: null, hold_detail: {}, resource_holds: {} });

    for (const [routeState, diagnostic] of [
      [{ version: 9, routes: {} }, /route_state_version:9/],
      ["v1", /route_state_not_an_object/],
      [{ version: 1, routes: [] }, /route_state_routes/],
      [{ version: 1, routes: { polls: { holdUntil: "soon", ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 1 } } }, /route_state_entry:polls/],
      [{ version: 1, routes: { polls: { holdUntil: null, ladderStep: 0, effectivePerMin: null, policyVersion: null, last429AttemptId: null, last429At: null, revision: 0 } } }, /route_state_entry:polls/],
    ] as const) {
      const pageId = await seedPage();
      // Rows a newer state left stay as they are: an unreadable hold never opens a page.
      await testDb.pool.query("insert into sync_holds (page_id, scope, key, kind, until) values ($1, 'page', '', 'auth', 'infinity')", [pageId]);
      await writeOldColumns(pageId, { kind: null, resourceHolds: { "route:state": routeState } });
      const refused = acquireSyncPageOwnership(db(), { pageId, owner: owner() });
      await expect(refused).rejects.toBeInstanceOf(SyncLegacyHoldsUnreadableError);
      await expect(refused).rejects.toThrow(diagnostic);
      // Nor does a hold write under no generation go over them.
      await expect(setResourceHold(db(), { pageId, file: "posts", hold: { until: new Date(Date.now() + 60_000), step: 1 } }))
        .rejects.toBeInstanceOf(SyncLegacyHoldsUnreadableError);
      // Nothing was written: the page is not owned, its rows and columns stand.
      expect(await query("select owner_generation::int as generation from sync_pages where page_id = $1", [pageId])).toEqual([{ generation: 0 }]);
      expect(shape(await listSyncHolds(db(), pageId))).toEqual([{ scope: "page", key: "", kind: "auth", ladderStep: 0, detail: {}, revision: 1 }]);
      expect((await oldColumns(pageId)).resource_holds).toEqual({ "route:state": routeState });
    }
  });
});
