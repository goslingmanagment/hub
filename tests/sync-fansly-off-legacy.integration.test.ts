import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  issueSyncSwitchCapability,
  listRunnablePageSync,
  requestPageSync as requestPageSyncRows,
  setSyncPageMode,
  type SyncStream,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";
import {
  LEGACY_SYNC_RETIRED_CODE,
  requestAllPagesSync,
  requestPageSync,
} from "../apps/runtime/src/services/sync-control.ts";
import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";
import type { SyncTriggerScope } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

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
 * exactly as they are — today idle, pending or retrying with a null blocker —
 * so a revert of S4-10 (whose image runs `sync rollback` again) finds them
 * recoverable. The recovery data path below takes the data steps of that
 * reverted image's rollback and proves the page's streams become runnable.
 */

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";

const SCOPES = ["light", "followers", "all", "data", "messages", "posts"] as const satisfies readonly SyncTriggerScope[];
const BLOCKS = ["connection", "financials", "audience", "messages_live", "messages_history"] as const;
/** The scope `all` of a Fansly page before S4-10 (the reverted image's
 *  `requestPageSync(scope 'all', reason 'recovery')`). */
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

    // The planner, twice, the second time with every slot due.
    const { boss, woken } = recordingBoss();
    await runSyncPlannerCycle(app, boss as never, now);
    await runSyncPlannerCycle(app, boss as never, new Date(now.getTime() + 25 * 3_600_000));
    expect(woken.length).toBeGreaterThan(0);
    expect(new Set(woken)).toEqual(new Set([pages.onlyfans.pageId]));
    expect((await rowsOf(pages.onlyfans.pageId)).length).toBeGreaterThan(0);

    // A stray wake-up of the executor for a Fansly page seeds, leases and
    // writes nothing.
    for (const pageId of fansly) {
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
    expect(triggerAll.json()).toEqual({ accepted: true, pagesQueued: 2 });
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
    // No legacy run was ever opened for a Fansly page.
    expect((await pool().query(
      "select count(*)::int as n from sync_runs where page_id = any($1::bigint[])",
      [fansly],
    )).rows[0].n).toBe(0);
  });

  it("recovery data path: on the rows S4-10 leaves, the reverted image's rollback makes the page's streams runnable",
    async () => {
      const now = new Date();
      const pages = await seedPages(now);
      const { boss } = recordingBoss();
      await runSyncPlannerCycle(app, boss as never, now);
      await expect(requestPageSync(app, boss as never, { pageLabel: pages.live.label, scope: "all", reason: "recovery" }))
        .rejects.toThrow(retired(pages.live.label));
      // The rows as S4-10 leaves them: idle, pending, retrying — no blocker,
      // nothing parked — and fenced while the page is live.
      const shaped = (await rowsOf(pages.live.pageId)).filter((row) => ["light", "dm_messages", "transactions"].includes(row.stream));
      expect(shaped).toEqual([
        { stream: "dm_messages", status: "pending", blocker_kind: null },
        { stream: "light", status: "idle", blocker_kind: null },
        { stream: "transactions", status: "retrying", blocker_kind: null },
      ]);
      expect((await listRunnablePageSync(app.db, now)).map((row) => row.pageId)).not.toContain(pages.live.pageId);

      // The reverted image's `sync rollback --page` data steps: live →
      // handover → off (its steps 1 and 5), then its last step's
      // `requestPageSync(scope 'all', reason 'recovery')` — the app layer
      // seeds the page's rows first, then requests the scope's streams.
      const capability = issueSyncSwitchCapability({ pageId: pages.live.pageId, purpose: "revert drill" });
      for (const [from, to] of [["live", "handover"], ["handover", "off"]] as const) {
        expect(await setSyncPageMode(app.db, {
          pageId: pages.live.pageId,
          to,
          expectFrom: from,
          changedBy: "test:reverted rollback",
          capability,
        })).toMatchObject({ kind: "changed", from, to });
      }
      await ensurePageSyncStates(app.db, { pageId: pages.live.pageId, now });
      const requests = await requestPageSyncRows(app.db, {
        pageId: pages.live.pageId,
        streams: REVERTED_ALL_SCOPE,
        source: "recovery",
        now,
      });
      expect(requests.map((request) => request.stream).sort()).toEqual([...REVERTED_ALL_SCOPE].sort());

      const outstanding = await pool().query<{ stream: string }>(
        `select stream::text from page_sync_states
          where page_id = $1 and request_seq > applied_seq and status <> 'paused' order by stream`,
        [pages.live.pageId],
      );
      expect(outstanding.rows.map((row) => row.stream)).toEqual(expect.arrayContaining(REVERTED_ALL_SCOPE));
      const runnable = await listRunnablePageSync(app.db, now);
      expect(runnable.map((row) => row.pageId)).toContain(pages.live.pageId);
      // The reverted executor, which serves Fansly again, leases a stream.
      const lease = await acquirePageSyncLease(app.db, {
        pageId: pages.live.pageId,
        workerId: "reverted-executor",
        leaseToken: "drill",
        leaseTtlMs: 60_000,
        now,
      });
      expect(lease).toMatchObject({ pageId: pages.live.pageId, platform: "fansly", status: "running" });
    });
});
