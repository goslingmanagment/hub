import { readdirSync, readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  listRunnablePageSync,
  markPageSyncEnqueued,
  requestPageSync as requestPageSyncRows,
  resetPageSync,
  resumePageSync,
  scheduleDuePageSync,
  type SyncStream,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";
import { LEGACY_SYNC_RETIRED_CODE } from "../apps/runtime/src/services/errors.ts";
import {
  requestAllPagesSync,
  requestPageSync,
} from "../apps/runtime/src/services/sync-control.ts";
import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";
import type { SyncTriggerScope } from "../apps/runtime/src/services/sync-queue.ts";
import { legacyExecutorPlatforms } from "../apps/runtime/src/sync/onlyfans/boundary.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { EVERY_PLATFORM } from "./helpers/page-sync-scope.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage, setModeDirect } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Step 4, S4-10 (design `step4-design.md` §PNR stage 1): Fansly leaves the
 * legacy page-sync executor. Fansly declares no legacy stream, so the planner
 * seeds, schedules and wakes OnlyFans pages only; the executor seeds and
 * leases nothing of a Fansly page; the app-level `requestPageSync` refuses a
 * Fansly page (409 `legacy_sync_retired`); the owner's levers act on the
 * engine for a page it owns and refuse any other Fansly page.
 *
 * S4-10 writes no legacy state (E17): the Fansly `page_sync_states` rows stay
 * exactly as they are — idle, pending or retrying with a null blocker.
 *
 * Step 4, S4-21 (the point of no return, stage 2) parks them for good:
 * migration 0239 makes every Fansly row `paused` with the `retired` blocker,
 * and the executor's platform set is the one fence left in its queries. The
 * second half below takes the data steps a reverted image's roll-back would
 * take on the parked rows and proves nothing of the page becomes runnable —
 * with the platform set, and without it.
 */

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";

const SCOPES = ["light", "followers", "all", "data", "messages", "posts"] as const satisfies readonly SyncTriggerScope[];
const BLOCKS = ["connection", "financials", "audience", "messages_live", "messages_history"] as const;
/** The scope `all` of a Fansly page before S4-10: what a reverted image's
 *  roll-back requested as `recovery`. */
const REVERTED_ALL_SCOPE: SyncStream[] = [
  "light",
  "transactions",
  "top_spenders",
  "subscribers",
  "followers",
  "followers_reconcile",
  "dm_conversations",
  "dm_messages",
];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  // With the database URL the api starts its pg-boss (`trigger-all`).
  app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function pool() {
  if (!testDb) throw new Error("no test database");
  return testDb.pool;
}

/** A live Fansly page (the production state since step 3), a Fansly page the
 *  engine does not own (`off`), and an OnlyFans page. Each Fansly page has
 *  the legacy rows the pre-S4-10 image left: one idle, one pending with
 *  `request_seq > applied_seq`, one retrying, the rest as seeded. */
async function seedPages(now: Date) {
  const handles = { db: app.db, pool: pool() };
  const live = await seedSyncPage(handles, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" });
  const off = await seedSyncPage(handles, { label: "lora-9", mode: "off" });
  const model = await createModel(app.db, { slug: "of-model", name: "OF model" });
  const onlyfans = await createOnlyFansPage(app.db, { modelId: model!.id, label: "lana-of" });
  for (const pageId of [live.pageId, off.pageId]) {
    // As the pre-S4-10 planner seeded them.
    await ensurePageSyncStates(app.db, { pageId, now });
    await pool().query(
      `update page_sync_states
          set status = 'idle', applied_seq = request_seq, succeeded_at = $2, blocker_kind = null,
              blocker_code = null, blocker_message = null, blocked_at = null, retry_at = null, retry_kind = null
        where page_id = $1 and stream = 'light'`,
      [pageId, now],
    );
    await requestPageSyncRows(app.db, { pageId, streams: ["dm_messages"], source: "recovery", now });
    await pool().query(
      `update page_sync_states
          set status = 'pending', blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null,
              retry_at = null, retry_kind = null
        where page_id = $1 and stream = 'dm_messages'`,
      [pageId],
    );
    await pool().query(
      `update page_sync_states
          set status = 'retrying', retry_kind = 'rate_limit', retry_at = $2::timestamptz + interval '10 minutes',
              request_seq = applied_seq + 1, blocker_kind = null, blocker_code = null, blocker_message = null,
              blocked_at = null
        where page_id = $1 and stream = 'transactions'`,
      [pageId, now],
    );
  }
  return { live, off, onlyfans: { pageId: onlyfans!.id, label: onlyfans!.label } };
}

/** Every legacy row of the pages, byte for byte (and its cursors). */
async function legacySnapshot(pageIds: readonly number[]) {
  const states = await pool().query<{ row: string }>(
    `select row_to_json(s)::text as row from page_sync_states s
      where s.page_id = any($1::bigint[]) order by s.page_id, s.stream`,
    [pageIds],
  );
  const cursors = await pool().query<{ row: string }>(
    `select row_to_json(c)::text as row from page_sync_cursors c
      where c.page_id = any($1::bigint[]) order by c.page_id, c.stream`,
    [pageIds],
  );
  return { states: states.rows.map((r) => r.row), cursors: cursors.rows.map((r) => r.row) };
}

async function rowsOf(pageId: number) {
  return (await pool().query<{ stream: string; status: string; blocker_kind: string | null }>(
    "select stream::text, status::text, blocker_kind from page_sync_states where page_id = $1 order by stream",
    [pageId],
  )).rows;
}

function recordingBoss() {
  const woken: number[] = [];
  const boss = {
    send: vi.fn(async (_queue: string, payload: { platformAccountId: number }) => {
      woken.push(payload.platformAccountId);
      return `job-${woken.length}`;
    }),
  };
  return { boss, woken };
}

async function startOwnerServer() {
  await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  server = await buildApiServer(app);
  await server.ready();
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: "owner-secret" },
  });
  const setCookie = login.headers["set-cookie"];
  ownerCookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
}

function owner(method: "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return server!.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload === undefined ? {} : { payload }) });
}

const retired = (label: string) => expect.objectContaining({
  name: "LegacySyncRetiredError",
  statusCode: 409,
  code: LEGACY_SYNC_RETIRED_CODE,
  pageLabel: label,
  platform: "fansly",
});

describe("Fansly off the legacy executor (step 4, S4-10)", () => {
  it("every Fansly lever scope resolves to engine registry keys", async () => {
    const { fanslyFilesForStreams, fanslyKeysForStreams } = await import("../apps/runtime/src/sync/fansly/legacy-streams.ts");
    for (const scope of SCOPES) {
      const streams = FANSLY_ENGINE_SCOPE_STREAMS[scope];
      expect(streams.length, scope).toBeGreaterThan(0);
      // Every stream of the scope is taken over by at least one registry key.
      for (const stream of streams) expect(fanslyKeysForStreams([stream]), `${scope}/${stream}`).not.toEqual([]);
      expect(fanslyFilesForStreams(streams), scope).not.toEqual([]);
    }
  });

  it("writes no legacy state of a Fansly page: planner ticks, executor wake-ups, refused requests, every lever, "
    + "trigger-all and a page delete leave its rows byte-identical; OnlyFans is served as before", async () => {
    const now = new Date();
    const pages = await seedPages(now);
    const fansly = [pages.live.pageId, pages.off.pageId];
    const before = await legacySnapshot(fansly);
    expect(before.states.length).toBeGreaterThan(3);
    expect((await rowsOf(pages.onlyfans.pageId))).toEqual([]);
    // A Fansly page born live (S4-05) has no legacy rows, and gets none.
    const born = await seedSyncPage({ db: app.db, pool: pool() }, { label: "ari-2", mode: "live", guard: "fansly_sync_engine" });

    // The planner, twice, the second time with every slot due.
    const { boss, woken } = recordingBoss();
    await runSyncPlannerCycle(app, boss as never, now);
    await runSyncPlannerCycle(app, boss as never, new Date(now.getTime() + 25 * 3_600_000));
    expect(woken.length).toBeGreaterThan(0);
    expect(new Set(woken)).toEqual(new Set([pages.onlyfans.pageId]));
    expect((await rowsOf(pages.onlyfans.pageId)).length).toBeGreaterThan(0);
    expect(await rowsOf(born.pageId)).toEqual([]);

    // A stray wake-up of the executor for a Fansly page seeds, leases and
    // writes nothing.
    for (const pageId of [...fansly, born.pageId]) {
      expect(await executeNextSyncPageChunk(app, pageId)).toMatchObject({ kind: "idle", stream: null, runId: null });
    }

    // The app-level request refuses every scope; trigger-all requests
    // OnlyFans only.
    for (const page of [pages.live, pages.off]) {
      for (const scope of SCOPES) {
        await expect(requestPageSync(app, boss as never, { pageLabel: page.label, scope, reason: "manual" }))
          .rejects.toThrow(retired(page.label));
      }
    }
    const all = await requestAllPagesSync(app, boss as never, { scope: "all", reason: "manual" });
    expect(all.map((result) => result.pageLabel)).toEqual([pages.onlyfans.label]);

    // The owner's levers: the engine's on the live page, 409 on the other.
    await startOwnerServer();
    for (const scope of SCOPES) {
      const engine = await owner("POST", "/api/v1/admin/sync/trigger", { pageLabel: pages.live.label, scope });
      expect(engine.statusCode, scope).toBe(202);
      const refused = await owner("POST", "/api/v1/admin/sync/trigger", { pageLabel: pages.off.label, scope });
      expect(refused.statusCode, scope).toBe(409);
      expect(refused.json()).toMatchObject({ error: LEGACY_SYNC_RETIRED_CODE, statusCode: 409 });
    }
    const triggerAll = await owner("POST", "/api/v1/admin/sync/trigger-all");
    expect(triggerAll.statusCode).toBe(202);
    // The two live pages through the engine, the OnlyFans page through legacy.
    expect(triggerAll.json()).toEqual({ accepted: true, pagesQueued: 3 });
    for (const action of ["trigger", "pause", "resume", "reset"] as const) {
      for (const block of BLOCKS) {
        const engine = await owner("POST", `/api/v1/admin/sync/blocks/${action}`, { pageLabel: pages.live.label, block });
        expect(engine.statusCode, `${action} ${block}`).toBe(200);
        const refused = await owner("POST", `/api/v1/admin/sync/blocks/${action}`, { pageLabel: pages.off.label, block });
        expect(refused.statusCode, `${action} ${block}`).toBe(409);
        expect(refused.json()).toMatchObject({ error: LEGACY_SYNC_RETIRED_CODE });
      }
    }
    expect((await owner("POST", "/api/v1/admin/sync/followers-reconcile/reset", { pageLabel: pages.live.label })).statusCode)
      .toBe(200);
    const refusedReset = await owner("POST", "/api/v1/admin/sync/followers-reconcile/reset", { pageLabel: pages.off.label });
    expect(refusedReset.statusCode).toBe(409);
    expect(refusedReset.json()).toMatchObject({ error: LEGACY_SYNC_RETIRED_CODE });

    // Deleting a Fansly page leaves its legacy rows as they are; an OnlyFans
    // page's are parked as before.
    expect((await owner("DELETE", `/api/v1/admin/pages/${pages.off.label}`)).statusCode).toBe(200);
    expect((await owner("DELETE", `/api/v1/admin/pages/${pages.onlyfans.label}`)).statusCode).toBe(200);
    expect(new Set((await rowsOf(pages.onlyfans.pageId)).map((row) => row.status))).toEqual(new Set(["paused"]));

    expect(await legacySnapshot(fansly)).toEqual(before);
    expect(await rowsOf(born.pageId)).toEqual([]);
    // No legacy run was ever opened for a Fansly page.
    expect((await pool().query(
      "select count(*)::int as n from sync_runs where page_id = any($1::bigint[])",
      [fansly],
    )).rows[0].n).toBe(0);
  });
});

// ── step 4, S4-21: the rows parked, the platform set the fence ──────────────

/** The migration that parks the rows (0239 at the time of writing), found by
 *  its name: its number is the next free one at merge. */
function retireMigrationSql(): string {
  const dir = "packages/db/migrations";
  const found = readdirSync(dir).filter((file) => file.endsWith("_retire_fansly_legacy_sync_states.sql"));
  if (found.length !== 1) throw new Error(`expected one retire migration, found ${found.length}`);
  return readFileSync(`${dir}/${found[0]!}`, "utf8");
}

/** The migration's statement, as the deploy applies it. */
async function parkFanslyLegacyRows(): Promise<void> {
  await pool().query(retireMigrationSql());
}

interface LegacyRow {
  stream: string;
  status: string;
  blocker_kind: string | null;
  blocker_code: string | null;
  request_seq: string;
  applied_seq: string;
  leased_seq: string | null;
  lease_token: string | null;
  lease_owner: string | null;
  retry_kind: string | null;
  retry_at: Date | null;
}

async function legacyRows(pageId: number): Promise<LegacyRow[]> {
  return (await pool().query<LegacyRow>(
    `select stream::text, status::text, blocker_kind, blocker_code, request_seq::text, applied_seq::text,
            leased_seq::text, lease_token, lease_owner, retry_kind, retry_at
       from page_sync_states where page_id = $1 order by stream`,
    [pageId],
  )).rows;
}

/** An OnlyFans page with a runnable `transactions` request (the planner's seed, then a request). */
async function requestOnlyFansStream(pageId: number, now: Date): Promise<void> {
  await ensurePageSyncStates(app.db, { pageId, now });
  await pool().query(
    `update page_sync_states
        set applied_seq = request_seq, status = case when status = 'paused' then status else 'idle' end
      where page_id = $1`,
    [pageId],
  );
  await requestPageSyncRows(app.db, { pageId, streams: ["transactions"], source: "manual", now });
}

describe("the Fansly legacy rows parked for good (step 4, S4-21, migration 0239)", () => {
  it("parks every Fansly row — leased, retrying, blocked or idle — keeps its sequences, and leaves OnlyFans and a "
    + "row parked already untouched", async () => {
    const now = new Date();
    const pages = await seedPages(now);
    // A lease an older executor left running, and a stream an auth failure blocked.
    await pool().query(
      `update page_sync_states
          set status = 'running', request_seq = applied_seq + 1, leased_seq = applied_seq + 1, lease_owner = 'old-executor',
              lease_token = 'old-lease', lease_heartbeat_at = $2, lease_expires_at = $2::timestamptz + interval '5 minutes'
        where page_id = $1 and stream = 'subscribers'`,
      [pages.live.pageId, now],
    );
    await pool().query(
      `update page_sync_states
          set status = 'blocked', blocker_kind = 'auth', blocker_code = 'fansly_auth', blocker_message = 'dead session',
              blocked_at = $2
        where page_id = $1 and stream = 'followers'`,
      [pages.live.pageId, now],
    );
    await requestOnlyFansStream(pages.onlyfans.pageId, now);
    const onlyFansBefore = await legacySnapshot([pages.onlyfans.pageId]);
    const before = await legacyRows(pages.live.pageId);
    expect([...new Set(before.map((row) => row.status))])
      .toEqual(expect.arrayContaining(["idle", "pending", "retrying", "running", "blocked"]));

    await parkFanslyLegacyRows();

    for (const page of [pages.live, pages.off]) {
      const rows = await legacyRows(page.pageId);
      expect(rows.length).toBeGreaterThan(3);
      for (const row of rows) {
        expect(row, `${page.label} ${row.stream}`).toMatchObject({
          status: "paused",
          blocker_kind: "retired",
          blocker_code: "fansly_sync_engine_owned",
          leased_seq: null,
          lease_token: null,
          lease_owner: null,
          retry_kind: null,
          retry_at: null,
        });
      }
    }
    // What each stream had asked for and applied stays on the row, as a record.
    expect((await legacyRows(pages.live.pageId)).map((row) => [row.stream, row.request_seq, row.applied_seq]))
      .toEqual(before.map((row) => [row.stream, row.request_seq, row.applied_seq]));
    const blocked = await pool().query<{ blocked_at: Date; blocker_message: string }>(
      "select blocked_at, blocker_message from page_sync_states where page_id = $1 and stream = 'followers'",
      [pages.live.pageId],
    );
    // The first block's instant is kept; the message says who reads the page now.
    expect(blocked.rows[0]!.blocked_at).toEqual(now);
    expect(blocked.rows[0]!.blocker_message).toBe(
      "Legacy Fansly sync streams are permanently retired; the page is read by the Fansly Sync Engine",
    );
    expect(await legacySnapshot([pages.onlyfans.pageId])).toEqual(onlyFansBefore);

    // Applied again (a later database, a re-run): nothing is rewritten.
    const parked = await legacySnapshot([pages.live.pageId, pages.off.pageId]);
    await parkFanslyLegacyRows();
    expect(await legacySnapshot([pages.live.pageId, pages.off.pageId])).toEqual(parked);
    // The acceptance query of the release: no Fansly row is left unparked.
    expect((await pool().query(
      `select count(*)::int as n from page_sync_states s join pages p on p.id = s.page_id
        where p.platform = 'fansly' and not (s.status = 'paused' and s.blocker_kind = 'retired')`,
    )).rows[0].n).toBe(0);
  });

  it("no way back: on the parked rows a reverted image's roll-back steps — mode off, every stream requested as recovery, "
    + "a resume, a reset — make nothing runnable, with the platform set or without it", async () => {
    const now = new Date();
    const pages = await seedPages(now);
    await requestOnlyFansStream(pages.onlyfans.pageId, now);
    await parkFanslyLegacyRows();
    const parked = await legacySnapshot([pages.live.pageId]);

    // The data steps of a roll-back as the pre-S4-21 images ran it: the page
    // leaves the engine (`off`), its rows are seeded and every stream of the
    // old scope `all` is requested as recovery, then resumed and reset by hand.
    await setModeDirect(pool(), pages.live.pageId, "off");
    await ensurePageSyncStates(app.db, { pageId: pages.live.pageId, now });
    const requests = await requestPageSyncRows(app.db, {
      pageId: pages.live.pageId,
      streams: REVERTED_ALL_SCOPE,
      source: "recovery",
      now,
    });
    expect(requests.map((request) => request.stream).sort()).toEqual([...REVERTED_ALL_SCOPE].sort());
    await resumePageSync(app.db, { pageId: pages.live.pageId, streams: REVERTED_ALL_SCOPE, now });
    await resetPageSync(app.db, { pageId: pages.live.pageId, streams: REVERTED_ALL_SCOPE, now });
    // A planner pass of such an image with every slot due.
    await scheduleDuePageSync(app.db, { now: new Date(now.getTime() + 25 * 3_600_000) });

    // Every row is still parked: paused, `retired`.
    expect(new Set((await legacyRows(pages.live.pageId)).map((row) => `${row.status}/${row.blocker_kind}`)))
      .toEqual(new Set(["paused/retired"]));
    expect(parked.states.length).toBe((await legacyRows(pages.live.pageId)).length);

    for (const platforms of [legacyExecutorPlatforms(), EVERY_PLATFORM]) {
      const runnable = (await listRunnablePageSync(app.db, now, { platforms })).map((row) => row.pageId);
      expect(runnable, platforms.join("+")).toEqual([pages.onlyfans.pageId]);
      expect(await acquirePageSyncLease(app.db, {
        pageId: pages.live.pageId, workerId: "reverted-executor", leaseToken: "drill", leaseTtlMs: 60_000, now, platforms,
      })).toBeNull();
    }
  });

  it("the platform set alone holds: an unparked pending Fansly row is not listed, marked or leased; an OnlyFans "
    + "stream stays runnable", async () => {
    const now = new Date();
    const pages = await seedPages(now);
    await requestOnlyFansStream(pages.onlyfans.pageId, now);
    const platforms = legacyExecutorPlatforms();
    expect(platforms).toEqual(["onlyfans"]);
    const fansly = [pages.live.pageId, pages.off.pageId];
    const before = await legacySnapshot(fansly);

    // Unparked: each Fansly page holds a pending `dm_messages` request with no
    // blocker, whatever its engine mode — a row a stray writer could leave.
    expect((await listRunnablePageSync(app.db, now, { platforms: EVERY_PLATFORM })).map((row) => row.pageId).sort())
      .toEqual([...fansly, pages.onlyfans.pageId].sort());

    expect((await listRunnablePageSync(app.db, now, { platforms })).map((row) => [row.pageId, row.platform]))
      .toEqual([[pages.onlyfans.pageId, "onlyfans"]]);
    expect(await listRunnablePageSync(app.db, now, { platforms: [] })).toEqual([]);
    for (const pageId of [...fansly, pages.onlyfans.pageId]) await markPageSyncEnqueued(app.db, pageId, now, { platforms });
    for (const pageId of fansly) {
      expect(await acquirePageSyncLease(app.db, {
        pageId, workerId: "executor", leaseToken: `lease-${pageId}`, leaseTtlMs: 60_000, now, platforms,
      })).toBeNull();
    }
    // Not a column of a Fansly row moved: no enqueue mark, no lease.
    expect(await legacySnapshot(fansly)).toEqual(before);

    const enqueued = await pool().query<{ enqueued: boolean }>(
      "select enqueued_at is not null as enqueued from page_sync_states where page_id = $1 and stream = 'transactions'",
      [pages.onlyfans.pageId],
    );
    expect(enqueued.rows).toEqual([{ enqueued: true }]);
    expect(await acquirePageSyncLease(app.db, {
      pageId: pages.onlyfans.pageId, workerId: "executor", leaseToken: "of-lease", leaseTtlMs: 60_000, now, platforms,
    })).toMatchObject({ pageId: pages.onlyfans.pageId, platform: "onlyfans", stream: "transactions", status: "running" });
  });
});
