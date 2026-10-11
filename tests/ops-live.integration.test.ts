import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";

import { opsLiveResponseSchema, type OpsLiveResponse } from "@agency_hub_core/contracts";
import {
  createModel,
  createOnlyFansPage,
  deletePageByLabel,
  ensurePollRows,
  insertAgentKey,
  openNotificationIncident,
  resolveNotificationIncident,
  setPagePause,
  upsertDemand,
  upsertInstanceHeartbeat,
  type Database,
} from "@agency_hub_core/db";
import { buildRunningSnapshot, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { OPS_LIVE_QUEUE_TTL_MS, OPS_LIVE_STATE_TTL_MS, createOpsLiveReader } from "../apps/runtime/src/services/ops-live.ts";
import { ensureSyncQueues } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";
import { seedPageHold, seedRouteState } from "./helpers/sync-holds.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * `GET /api/v1/ops/live` against a real database and the real server:
 *
 *  - who may call it — the monitoring token or the owner's dashboard session,
 *    nobody else, identically in both enforcement modes;
 *  - the pages (both platforms, the deleted one left out), each engine page's
 *    pauses, holds in force, open work, and why that work waits in the
 *    engine's own words;
 *  - the feed of sent requests over both journals, and how a cursor narrows
 *    it and brings an unanswered request again once it completes;
 *  - the job queue with dead letters counted apart, the open incidents, the
 *    process heartbeats;
 *  - that nothing of a request's parameters, a work's subject, a hold's key
 *    or an error message leaves, and that the read writes nothing.
 */

const MONITORING_TOKEN = "ops-live-monitor-secret";
const AGENT_KEY = `${AGENT_KEY_TOKEN_PREFIX}opsliveprobe00000000`;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 3_600_000;
/** A chat id: a work subject that must never be served. */
const GROUP = "810272281019305984";
const SECRET_PARAM = "param-that-must-not-leave";
const SECRET_ERROR = "error-text-that-must-not-leave";
/** A route no attempt of the fixture was sent on: its id would be a hold's key. */
const HELD_ROUTE = "subscribers.page";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterToken = "";
const pages = { running: 0, idle: 0, onlyfans: 0 };
const attempts: Record<"old" | "answered" | "unknown" | "failed" | "pending" | "fresh" | "neverSent" | "shadow" | "ancient", number> = {
  old: 0, answered: 0, unknown: 0, failed: 0, pending: 0, fresh: 0, neverSent: 0, shadow: 0, ancient: 0,
};
const legacy = { ok: 0, failed: 0 };

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function workIdOf(pageId: number, resource: string, subject = ""): Promise<number> {
  const result = await testDb!.pool.query<{ id: string }>(
    "select id::text from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1",
    [pageId, resource, subject],
  );
  return Number(result.rows[0]!.id);
}

/** One engine attempt, sent `sentSecondsAgo` ago (null: admitted, never sent)
 *  and answered `completedSecondsAgo` ago (null: unanswered). */
async function engineAttempt(input: {
  pageId: number;
  sentSecondsAgo: number | null;
  completedSecondsAgo: number | null;
  outcome: string;
  shadow?: boolean;
  httpStatus?: number | null;
  errorClass?: string | null;
}): Promise<number> {
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
            operation, request, outcome, send_mark, admitted_at, sent_at, completed_at, http_status, error_class,
            duration_ms, response_bytes, apply_state)
     values ($1, $2::boolean, 'dm-messages.head', $3, 'urgent', 1, 2000, 0.1, 2200, 'messages.page', $4::jsonb, $5,
             case when $6::float8 is null then null when $2::boolean then 'shadow' else 'request_start' end,
             clock_timestamp() - make_interval(secs => coalesce($6::float8, 30) + 1),
             clock_timestamp() - make_interval(secs => $6::float8),
             clock_timestamp() - make_interval(secs => $7::float8),
             $8::smallint, $9, case when $7::float8 is null then null else 100 end, case when $8::smallint = 200 then 3158 end,
             case when $2::boolean then 'skipped' else 'none' end)
     returning id::text`,
    [
      input.pageId, input.shadow ?? false, GROUP, JSON.stringify({ groupId: SECRET_PARAM }), input.outcome,
      input.sentSecondsAgo, input.completedSecondsAgo, input.httpStatus ?? null, input.errorClass ?? null,
    ],
  );
  return Number(result.rows[0]!.id);
}

/** One attempt of the older journal, started `startedSecondsAgo` ago. */
async function legacyAttempt(input: {
  pageId: number;
  startedSecondsAgo: number;
  state: "success" | "failed";
  httpStatus: number;
}): Promise<number> {
  const run = await testDb!.pool.query<{ id: string }>(
    `insert into sync_runs (page_id, stream, outcome, started_at, finished_at)
     values ($1, 'transactions', 'succeeded', clock_timestamp() - make_interval(secs => $2::float8), clock_timestamp())
     returning id::text`,
    [input.pageId, input.startedSecondsAgo + 1],
  );
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into sync_http_attempts (sync_run_id, page_id, provider, stream, operation, logical_request_id, attempt_number,
            state, failure_kind, http_status, duration_ms, request_shape, error_message, started_at, finished_at, response_body_bytes)
     values ($1, $2, 'onlyfans', 'transactions', 'transactions.list', $3, 1, $4::sync_http_attempt_state,
             case when $4::sync_http_attempt_state = 'failed' then 'http'::sync_http_failure_kind end, $5, 250, $6::jsonb,
             case when $4::sync_http_attempt_state = 'failed' then $7 end,
             clock_timestamp() - make_interval(secs => $8::float8),
             clock_timestamp() - make_interval(secs => $8::float8) + interval '250 milliseconds', 512)
     returning id::text`,
    [
      Number(run.rows[0]!.id), input.pageId, `fixture-${input.startedSecondsAgo}`, input.state, input.httpStatus,
      JSON.stringify({ cursor: SECRET_PARAM }), SECRET_ERROR, input.startedSecondsAgo,
    ],
  );
  return Number(result.rows[0]!.id);
}

async function loginCookie(target: Awaited<ReturnType<typeof buildApiServer>>, username: string, password: string): Promise<string> {
  const login = await target.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(login.statusCode).toBe(200);
  const header = login.headers["set-cookie"];
  const cookie = String((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return cookie;
}

/** The job queue's schema with the sync queues and their dead-letter queues,
 *  as a boot leaves it; no worker runs. */
async function createJobQueues(): Promise<void> {
  const boss = new PgBoss({ connectionString: testDb!.connectionString, schedule: false, supervise: false });
  boss.on("error", () => undefined);
  await boss.start();
  try {
    await ensureSyncQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/** One job row, written directly: created `createdAgo` ago, due to start
 *  `startAfter` from now, finished `completedAgo` ago (null: not finished). */
async function job(name: string, state: string, createdAgo: string, startAfter: string, completedAgo: string | null = null): Promise<void> {
  await testDb!.pool.query(
    `insert into pgboss.job (name, state, created_on, start_after, completed_on)
     values ($1, $2::pgboss.job_state, now() - $3::interval, now() + $4::interval, now() - $5::interval)`,
    [name, state, createdAgo, startAfter, completedAgo],
  );
}

function monitorGet(url = "/api/v1/ops/live") {
  return server!.inject({ method: "GET", url, headers: { "x-monitoring-token": MONITORING_TOKEN } });
}

async function live(url = "/api/v1/ops/live"): Promise<OpsLiveResponse> {
  const response = await monitorGet(url);
  expect(response.statusCode, response.body).toBe(200);
  return opsLiveResponseSchema.parse(response.json());
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    authPolicyEnforcement: "enforce",
    healthSyncMonitoringToken: MONITORING_TOKEN,
  });
  const handles = { db: db(), pool: testDb.pool };

  // lora-1: a live page whose owner beats — its work waits for its own reasons.
  pages.running = (await seedSyncPage(handles, { label: "lora-1", mode: "live", guard: "fansly_sync_engine" })).pageId;
  await testDb.pool.query(
    `update sync_pages
        set owner_generation = 1, owner_host = 'sync-test',
            owner_acquired_at = clock_timestamp() - interval '1 hour', owner_heartbeat_at = clock_timestamp()
      where page_id = $1`,
    [pages.running],
  );
  // lora-2: a live page nobody runs, paused and held.
  pages.idle = (await seedSyncPage(handles, { label: "lora-2", mode: "live", guard: "fansly_sync_engine" })).pageId;
  // An OnlyFans page, and a deleted Fansly page.
  const model = await createModel(testDb.db, { slug: "of-model", name: "OF model" });
  pages.onlyfans = (await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "lora-of" }))!.id;
  await seedSyncPage(handles, { label: "gone-1", mode: "live", guard: "fansly_sync_engine" });
  await deletePageByLabel(testDb.db, "gone-1");

  // lora-1's work: a poll due in an hour, a poll whose time has come, a chat's
  // read being served, a quarantined probe — and what shadow mode left behind.
  await ensurePollRows(db(), {
    pageId: pages.running,
    polls: [
      { resource: "subscribers.poll", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 },
      { resource: "followers.head", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 },
    ],
  });
  await testDb.pool.query(
    "update sync_work set due_at = clock_timestamp() - interval '5 seconds' where id = $1",
    [await workIdOf(pages.running, "followers.head")],
  );
  await upsertDemand(db(), { pageId: pages.running, resource: "dm-messages.head", subject: GROUP, kind: "trigger", class: "urgent" });
  await testDb.pool.query(
    "update sync_work set state = 'running', waiting_reason = 'running' where id = $1",
    [await workIdOf(pages.running, "dm-messages.head", GROUP)],
  );
  await upsertDemand(db(), { pageId: pages.running, resource: "probe.manual", kind: "trigger", class: "planned" });
  await testDb.pool.query(
    "update sync_work set state = 'quarantined', waiting_reason = 'quarantined' where id = $1",
    [await workIdOf(pages.running, "probe.manual")],
  );
  await testDb.pool.query(
    `insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at)
     values ($1, true, 'account.verify', '', 'trigger', 'urgent', clock_timestamp() - interval '1 hour')`,
    [pages.running],
  );
  // lora-2's: one poll, nobody to serve it.
  await ensurePollRows(db(), {
    pageId: pages.idle,
    polls: [{ resource: "subscribers.poll", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 }],
  });
  await setPagePause(db(), { pageId: pages.idle, requests: true, resources: ["followers.head"], note: "owner's note" });
  await seedPageHold(testDb, { pageId: pages.idle, kind: "network", untilSeconds: 600 });
  // A 429 five seconds ago: the route is held for five minutes and slowed to
  // one request in two minutes; another route keeps only its ladder step.
  await seedRouteState(testDb, {
    pageId: pages.idle, route: HELD_ROUTE, holdSeconds: 300, ladderStep: 2, effectivePerMin: 0.5, last429SecondsAgo: 5,
  });
  await seedRouteState(testDb, { pageId: pages.idle, route: "followers.page", holdSeconds: null, ladderStep: 1 });
  // A breaker that ended an hour ago is not in force.
  await testDb.pool.query(
    `insert into sync_holds (page_id, scope, key, kind, until, ladder_step)
     values ($1, 'resource', 'followers', 'resource_breaker', clock_timestamp() - interval '1 hour', 3)`,
    [pages.idle],
  );

  // The engine's journal, oldest send first.
  attempts.ancient = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 720, completedSecondsAgo: 719, outcome: "response", httpStatus: 200 });
  attempts.old = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 300, completedSecondsAgo: 299, outcome: "response", httpStatus: 200 });
  attempts.pending = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 240, completedSecondsAgo: null, outcome: "sent" });
  attempts.unknown = await engineAttempt({ pageId: pages.idle, sentSecondsAgo: 180, completedSecondsAgo: 170, outcome: "unknown" });
  attempts.failed = await engineAttempt({
    pageId: pages.running, sentSecondsAgo: 120, completedSecondsAgo: 119, outcome: "response", httpStatus: 500, errorClass: "subject_failure",
  });
  attempts.answered = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 90, completedSecondsAgo: 89, outcome: "response", httpStatus: 200 });
  attempts.fresh = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 5, completedSecondsAgo: null, outcome: "sent" });
  attempts.neverSent = await engineAttempt({
    pageId: pages.running, sentSecondsAgo: null, completedSecondsAgo: 10, outcome: "transport_error", errorClass: "network",
  });
  attempts.shadow = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 30, completedSecondsAgo: 30, outcome: "shadow", shadow: true });
  // The older journal: the OnlyFans page's pulls.
  legacy.ok = await legacyAttempt({ pageId: pages.onlyfans, startedSecondsAgo: 60, state: "success", httpStatus: 200 });
  legacy.failed = await legacyAttempt({ pageId: pages.onlyfans, startedSecondsAgo: 45, state: "failed", httpStatus: 503 });

  await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await createUserAccount(appContext, { username: "lead", role: "team_lead", password: "lead-secret" }, { source: "cli" });
  await createUserAccount(appContext, { username: "anton", role: "chatter" }, { source: "cli" });
  chatterToken = (await issueChatterDeviceToken(appContext, { username: "anton", pageLabel: "lora-1" }, { source: "cli" })).key;
  await insertAgentKey(testDb.db, {
    name: "ops-live-probe",
    keyPrefix: AGENT_KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(AGENT_KEY),
    capabilities: ["read:datasets"],
    pageIds: [pages.running],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: null,
  });

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("access", () => {
  it("is the monitoring token's and the owner's, identically in both enforcement modes", async () => {
    const logServer = await buildApiServer(createTestAppContext(testDb!, { healthSyncMonitoringToken: MONITORING_TOKEN }));
    try {
      const ownerCookie = await loginCookie(server!, "owner", "owner-secret");
      const leadCookie = await loginCookie(server!, "lead", "lead-secret");
      const cells: Array<[string, Record<string, string>, number]> = [
        ["nobody", {}, 401],
        ["a wrong token", { "x-monitoring-token": "not-the-token" }, 401],
        ["the monitoring token", { "x-monitoring-token": MONITORING_TOKEN }, 200],
        ["the owner's session", { cookie: ownerCookie }, 200],
        // Every other dashboard role reads `/health/sync` scoped to its pages;
        // this answer has no scoped form.
        ["a team lead's session", { cookie: leadCookie }, 403],
        ["a chatter's device token", { authorization: `Bearer ${chatterToken}` }, 403],
        ["an agent key", { authorization: `Bearer ${AGENT_KEY}` }, 403],
      ];
      for (const [who, headers, expected] of cells) {
        const viaEnforce = await server!.inject({ method: "GET", url: "/api/v1/ops/live", headers });
        const viaLog = await logServer.inject({ method: "GET", url: "/api/v1/ops/live", headers });
        expect(viaEnforce.statusCode, `enforce, ${who}: ${viaEnforce.body}`).toBe(expected);
        expect(viaLog.statusCode, `log, ${who}: ${viaLog.body}`).toBe(expected);
      }
    } finally {
      await logServer.close();
    }
  });

  it("without a configured token only the owner's session reads it", async () => {
    await server!.close();
    server = await buildApiServer(createTestAppContext(testDb!, { authPolicyEnforcement: "enforce" }));
    expect((await monitorGet()).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/ops/live", headers: { "x-monitoring-token": "" } })).statusCode).toBe(401);
    const ownerCookie = await loginCookie(server, "owner", "owner-secret");
    expect((await server.inject({ method: "GET", url: "/api/v1/ops/live", headers: { cookie: ownerCookie } })).statusCode).toBe(200);
  });
});

describe("pages", () => {
  it("lists the active pages of both platforms by platform and label, the deleted one left out", async () => {
    const answer = await live();
    expect(answer.pages.map((page) => [page.platform, page.label, page.engine])).toEqual([
      ["fansly", "lora-1", true],
      ["fansly", "lora-2", true],
      ["onlyfans", "lora-of", false],
    ]);
    // A page outside the engine has none of its state.
    expect(answer.pages[2]).toEqual({
      label: "lora-of", platform: "onlyfans", engine: false, pausedAll: false, pausedRequests: false, pausedResources: [],
      holds: [], openWork: 0, dueNow: 0, nextDueAt: null, waiting: [], lastSentAt: null,
    });
  });

  it("counts a page's open work and says why it waits in the engine's own words", async () => {
    const page = (await live()).pages.find((entry) => entry.label === "lora-1")!;
    // Four rows; what shadow mode left behind is not work of the page.
    expect(page.openWork).toBe(4);
    // Due and not being served: the poll whose time has come — not the chat's
    // read being served, not the quarantined probe.
    expect(page.dueNow).toBe(1);
    expect(page.waiting).toEqual([
      { reason: "not_due", count: 1 },
      { reason: "class_share", count: 1 },
      { reason: "quarantined", count: 1 },
      { reason: "running", count: 1 },
    ]);
    const due = await testDb!.pool.query<{ dueAt: Date }>(
      `select due_at as "dueAt" from sync_work where page_id = $1 and resource = 'subscribers.poll' and not shadow`,
      [pages.running],
    );
    expect(page.nextDueAt).toBe(due.rows[0]!.dueAt.toISOString());
    expect(page).toMatchObject({ pausedAll: false, pausedRequests: false, pausedResources: [], holds: [], lastSentAt: null });
  });

  it("reports a page's pauses and the holds in force — never a hold's key", async () => {
    const response = await monitorGet();
    const page = opsLiveResponseSchema.parse(response.json()).pages.find((entry) => entry.label === "lora-2")!;
    expect(page).toMatchObject({ pausedAll: false, pausedRequests: true, pausedResources: ["followers.head"] });
    expect(page.holds.map((hold) => [hold.scope, hold.kind, hold.until === null])).toEqual([
      ["page", "network", false],
      // The route's slowdown after its 429 has no end; its hold has one. The
      // other route's state row slows nothing: not a hold.
      ["route", "route_budget", true],
      ["route", "route_hold", false],
    ]);
    expect(new Date(page.holds[0]!.until!).getTime()).toBeGreaterThan(Date.now());
    // Nobody runs the page: that is why its poll waits, whatever holds it.
    expect(page.openWork).toBe(1);
    expect(page.waiting).toEqual([{ reason: "ownership_unconfirmed", count: 1 }]);
    // Neither the route a hold is on nor the owner's pause note leaves.
    expect(response.body).not.toContain(HELD_ROUTE);
    expect(response.body).not.toContain("owner's note");
  });

  it("a page hold is why a running page's requests wait", async () => {
    await seedPageHold(testDb!, { pageId: pages.running, kind: "auth", untilSeconds: "infinity" });
    const page = (await live()).pages.find((entry) => entry.label === "lora-1")!;
    // A credentials hold has no end.
    expect(page.holds).toEqual([{ scope: "page", kind: "auth", until: null }]);
    expect(page.waiting).toEqual([
      { reason: "page_hold", count: 3 },
      { reason: "running", count: 1 },
    ]);
  });

  it("takes the last send from the engine's page row", async () => {
    await testDb!.pool.query(
      "update sync_pages set last_send_at = '2026-10-11T03:20:34.381Z', last_completed_at = '2026-10-11T03:20:34.500Z' where page_id = $1",
      [pages.running],
    );
    const page = (await live()).pages.find((entry) => entry.label === "lora-1")!;
    expect(page.lastSentAt).toBe("2026-10-11T03:20:34.381Z");
  });
});

describe("attempts", () => {
  it("without a cursor: every request sent in the last ten minutes, both journals, by send time", async () => {
    const response = await monitorGet();
    const answer = opsLiveResponseSchema.parse(response.json());
    expect(answer.attempts.map((attempt) => attempt.id)).toEqual([
      `e${attempts.old}`,
      `e${attempts.pending}`,
      `e${attempts.unknown}`,
      `e${attempts.failed}`,
      `e${attempts.answered}`,
      `l${legacy.ok}`,
      `l${legacy.failed}`,
      `e${attempts.fresh}`,
    ]);
    const byId = new Map(answer.attempts.map((attempt) => [attempt.id, attempt]));
    expect(byId.get(`e${attempts.answered}`)).toMatchObject({
      page: "lora-1", resource: "dm-messages.head", operation: "messages.page", class: "urgent",
      failed: false, httpStatus: 200, durationMs: 100, responseBytes: 3158,
    });
    expect(byId.get(`e${attempts.answered}`)!.completedAt).not.toBeNull();
    // Unanswered: no completion, no status, no duration.
    expect(byId.get(`e${attempts.pending}`)).toMatchObject({
      completedAt: null, failed: false, httpStatus: null, durationMs: null, responseBytes: null,
    });
    // Ended without a usable answer: an error class, or no answer at all.
    expect(byId.get(`e${attempts.failed}`)).toMatchObject({ failed: true, httpStatus: 500 });
    expect(byId.get(`e${attempts.unknown}`)).toMatchObject({ page: "lora-2", failed: true, httpStatus: null });
    // The older journal: the stream for a resource, no class.
    expect(byId.get(`l${legacy.ok}`)).toMatchObject({
      page: "lora-of", resource: "transactions", operation: "transactions.list", class: null,
      failed: false, httpStatus: 200, durationMs: 250, responseBytes: 512,
    });
    expect(byId.get(`l${legacy.failed}`)).toMatchObject({ failed: true, httpStatus: 503 });
    // Sent twelve minutes ago, admitted but never sent, left by shadow mode: not in the feed.
    for (const absent of [attempts.ancient, attempts.neverSent, attempts.shadow]) {
      expect(byId.has(`e${absent}`), String(absent)).toBe(false);
    }
    // Nothing of a request's parameters, its work's subject or an error message leaves.
    for (const secret of [GROUP, SECRET_PARAM, SECRET_ERROR]) {
      expect(response.body, secret).not.toContain(secret);
    }
  });

  it("with a cursor: what was sent or completed since, and an unanswered request again once it completes", async () => {
    const first = await live();
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    const cursorUrl = `/api/v1/ops/live?cursor=${first.nextCursor}`;

    // Only the request of five seconds ago lies within 30 seconds of the cursor.
    const second = await live(cursorUrl);
    expect(second.attempts.map((attempt) => attempt.id)).toEqual([`e${attempts.fresh}`]);
    expect(second.attempts[0]!.completedAt).toBeNull();

    // The request sent four minutes ago is answered now: it comes again, completed.
    await testDb!.pool.query(
      `update sync_attempts set outcome = 'response', completed_at = clock_timestamp(), http_status = 200, duration_ms = 240000
        where id = $1`,
      [attempts.pending],
    );
    const third = await live(cursorUrl);
    expect(third.attempts.map((attempt) => attempt.id)).toEqual([`e${attempts.pending}`, `e${attempts.fresh}`]);
    expect(third.attempts[0]).toMatchObject({ httpStatus: 200, failed: false, durationMs: 240_000 });
    expect(third.attempts[0]!.completedAt).not.toBeNull();
    // The same id as in the first answer: the caller merges by it.
    expect(first.attempts.find((attempt) => attempt.id === `e${attempts.pending}`)!.completedAt).toBeNull();
  });

  it("a cursor Hub cannot read is answered as if it were absent, not with an error", async () => {
    const plain = (await live()).attempts.map((attempt) => attempt.id);
    for (const cursor of ["garbage", "t1-", "t9-abc", "%00", "a".repeat(500), "..%2F..%2Fetc"]) {
      const answer = await live(`/api/v1/ops/live?cursor=${cursor}`);
      expect(answer.attempts.map((attempt) => attempt.id), cursor).toEqual(plain);
    }
    // A repeated parameter too.
    expect((await live("/api/v1/ops/live?cursor=a&cursor=b")).attempts.map((attempt) => attempt.id)).toEqual(plain);
  });
});

describe("queue, incidents, processes", () => {
  it("answers zeros for a database the job queue has not started in", async () => {
    expect((await testDb!.pool.query("select to_regclass('pgboss.job') is null as absent")).rows[0].absent).toBe(true);
    expect((await live()).queue).toEqual({ waiting: 0, active: 0, failedLastHour: 0, deadLetters: 0, oldestWaitingAgeMs: null });
  });

  it("counts waiting, active and failed jobs, and keeps dead letters apart", async () => {
    await createJobQueues();
    await job("sync.page.execute", "created", "5 minutes", "-5 minutes");
    await job("sync.page.execute", "retry", "2 minutes", "-1 minute");
    // Not yet due to start: not waiting.
    await job("sync.page.execute", "created", "1 minute", "1 hour");
    await job("sync.page.execute", "active", "1 minute", "-1 minute");
    await job("sync.page.execute", "failed", "20 minutes", "-20 minutes", "10 minutes");
    await job("sync.page.execute", "failed", "3 hours", "-3 hours", "2 hours");
    await job("sync.page.execute", "completed", "3 hours", "-3 hours", "2 hours");
    // A record of a failure seven days old: a dead letter, never "the oldest waiting job".
    await job("sync.page.execute.dlq", "created", "7 days", "-7 days");

    const { queue } = await live();
    expect(queue).toMatchObject({ waiting: 2, active: 1, failedLastHour: 1, deadLetters: 1 });
    expect(queue.oldestWaitingAgeMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(queue.oldestWaitingAgeMs).toBeLessThan(6 * 60_000);
  });

  it("lists the open incidents, newest first, with a summary of at most 160 characters", async () => {
    await openNotificationIncident(testDb!.db, {
      incidentKey: `stream_failed_threshold:${pages.onlyfans}:posts`,
      kind: "stream_failed_threshold",
      platformAccountId: pages.onlyfans,
      stream: "posts",
      errorSummary: `OFAPI posts capture blocked: ${"x".repeat(300)}`,
      now: new Date(Date.now() - 60_000),
    });
    await openNotificationIncident(testDb!.db, {
      incidentKey: "db_disk_usage:global", kind: "db_disk_usage", platformAccountId: null, errorSummary: null,
    });
    await openNotificationIncident(testDb!.db, {
      incidentKey: `auth_blocked:${pages.running}`, kind: "auth_blocked", platformAccountId: pages.running, errorSummary: "Session expired",
    });
    await resolveNotificationIncident(testDb!.db, { incidentKey: `auth_blocked:${pages.running}` });

    const { incidents } = await live();
    expect(incidents.map((incident) => [incident.kind, incident.stream])).toEqual([
      ["db_disk_usage", null],
      ["stream_failed_threshold", "posts"],
    ]);
    expect(incidents[0]!.summary).toBe("");
    expect(incidents[1]!.summary).toHaveLength(160);
    expect(incidents[1]!.summary.startsWith("OFAPI posts capture blocked: xxx")).toBe(true);
    expect(incidents[1]!.id).toMatch(/^\d+$/);
  });

  it("lists the processes' heartbeats and the revision this build runs", async () => {
    const startedAt = new Date("2026-10-10T21:42:58.049Z");
    for (const role of ["sync", "api"]) {
      await upsertInstanceHeartbeat(appContext.db, {
        role, instanceId: `${role}-1`, startedAt, imageTag: "2260ef739aa0", running: buildRunningSnapshot(appContext.config),
      });
    }
    const previous = process.env.GIT_SHA;
    process.env.GIT_SHA = "2260ef739aa0";
    try {
      const answer = await live();
      expect(answer.revision).toBe("2260ef739aa0");
      expect(answer.processes.map((entry) => [entry.role, entry.startedAt])).toEqual([
        ["api", startedAt.toISOString()],
        ["sync", startedAt.toISOString()],
      ]);
      expect(Date.now() - new Date(answer.processes[0]!.lastSeenAt).getTime()).toBeLessThan(60_000);
      expect(Math.abs(Date.now() - new Date(answer.generatedAt).getTime())).toBeLessThan(60_000);
    } finally {
      if (previous === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = previous;
    }
  });
});

describe("the clock it runs on", () => {
  it("reads the feed on every request, pages and incidents once in two seconds, the queue once in thirty", async () => {
    // The route's reader on a clock the test moves.
    let clockMs = 1_000_000;
    const read = createOpsLiveReader(appContext, { nowMs: () => clockMs });
    const first = opsLiveResponseSchema.parse(await read(undefined));
    expect(first.queue.waiting).toBe(0);

    // A request sent now, a page paused now, an incident opened now, a job waiting now.
    const sentNow = await engineAttempt({ pageId: pages.running, sentSecondsAgo: 0, completedSecondsAgo: null, outcome: "sent" });
    await setPagePause(db(), { pageId: pages.running, all: true });
    await openNotificationIncident(testDb!.db, {
      incidentKey: "db_disk_usage:global", kind: "db_disk_usage", platformAccountId: null, errorSummary: "disk",
    });
    await createJobQueues();
    await job("sync.page.execute", "created", "1 minute", "-1 minute");

    clockMs += OPS_LIVE_STATE_TTL_MS - 1;
    const second = opsLiveResponseSchema.parse(await read(undefined));
    expect(second.attempts.at(-1)!.id).toBe(`e${sentNow}`);
    expect(second.pages).toEqual(first.pages);
    expect(second.incidents).toEqual([]);
    expect(second.queue).toEqual(first.queue);

    clockMs += 1;
    const third = opsLiveResponseSchema.parse(await read(undefined));
    expect(third.pages.find((page) => page.label === "lora-1")!.pausedAll).toBe(true);
    expect(third.incidents).toHaveLength(1);
    expect(third.queue).toEqual(first.queue);

    clockMs += OPS_LIVE_QUEUE_TTL_MS - OPS_LIVE_STATE_TTL_MS;
    expect(opsLiveResponseSchema.parse(await read(undefined)).queue.waiting).toBe(1);
  });

  it("writes nothing: no audit row, no metric sample, no table of its own", async () => {
    const facts = async () => (await testDb!.pool.query<{ audit: string; metrics: string; tables: string }>(
      `select (select count(*) from audit_events) as audit,
              (select count(*) from ops_metric_samples) as metrics,
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and c.relkind in ('r', 'p')) as tables`,
    )).rows[0];
    const before = await facts();
    const first = await live();
    await live(`/api/v1/ops/live?cursor=${first.nextCursor}`);
    expect(await facts()).toEqual(before);
  });
});
