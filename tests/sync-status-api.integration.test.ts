import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentSyncStatusResponseSchema,
  agentSyncWhyResponseSchema,
  syncPageRefreshResponseSchema,
  syncPagesResponseSchema,
  syncPageWorkGetResponseSchema,
  syncPageWorkResponseSchema,
} from "@agency_hub_core/contracts";
import {
  ensurePollRows,
  insertAgentKey,
  setConfigOverride,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SYNC_PAGE_REFRESH_AUDIT_EVENT } from "../apps/runtime/src/modules/sync-engine/index.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * The engine's page status, "why waiting" and "sync now" over HTTP (plan §10,
 * design §3.9, §7.3, §7.4), against a real database and the real server:
 *
 *  - the owner routes read every page's status and its work rows from the
 *    journal the page runs (the shadow journal on `off`/`shadow` pages), and
 *    "sync now" makes a page's polls due (202, audited) — never on an `off`
 *    page, which no actor runs (409 sync_page_off);
 *  - the agent plane reads the same status and rows through the same
 *    functions: only the key's pages, `read:datasets` always, `read:messages`
 *    too for a key whose subjects are chats, and the static 404 for a page
 *    outside the grant.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 3_600_000;
const GROUP = "810272281019305984";

const DATASETS = `${AGENT_KEY_TOKEN_PREFIX}sync-datasets-token`;
const MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}sync-messages-token`;
const NO_DATASETS = `${AGENT_KEY_TOKEN_PREFIX}sync-nodatasets-token`;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
const pages: Record<"shadow" | "off" | "elsewhere", number> = { shadow: 0, off: 0, elsewhere: 0 };
const works: Record<"poll" | "followers" | "head" | "closed" | "elsewhere" | "offPoll", number> = {
  poll: 0, followers: 0, head: 0, closed: 0, elsewhere: 0, offPoll: 0,
};

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

async function insertKey(token: string, name: string, capabilities: string[], pageIds: number[], ownerId: number) {
  await insertAgentKey(testDb!.db, {
    name,
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities: capabilities as never,
    pageIds,
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });
}

async function workIdOf(pageId: number, resource: string, subject = ""): Promise<number> {
  const result = await testDb!.pool.query<{ id: string }>(
    "select id::text from sync_work where page_id = $1 and resource = $2 and subject = $3 order by id desc limit 1",
    [pageId, resource, subject],
  );
  return Number(result.rows[0]!.id);
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  const handles = { db: db(), pool: testDb.pool };

  pages.shadow = (await seedSyncPage(handles, { label: "lora-1", mode: "shadow" })).pageId;
  pages.off = (await seedSyncPage(handles, { label: "lora-2", mode: "off" })).pageId;
  pages.elsewhere = (await seedSyncPage(handles, { label: "lora-3", mode: "shadow" })).pageId;

  // lora-1's shadow journal: two polls due in an hour, a chat's head read,
  // and a closed probe whose attempt was simulated.
  await ensurePollRows(db(), {
    pageId: pages.shadow,
    shadow: true,
    polls: [
      { resource: "subscribers.poll", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 },
      { resource: "followers.head", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 },
    ],
  });
  works.poll = await workIdOf(pages.shadow, "subscribers.poll");
  works.followers = await workIdOf(pages.shadow, "followers.head");
  await upsertDemand(db(), {
    pageId: pages.shadow, shadow: true, resource: "dm-messages.head", subject: GROUP, kind: "trigger", class: "urgent",
  });
  works.head = await workIdOf(pages.shadow, "dm-messages.head", GROUP);
  await upsertDemand(db(), {
    pageId: pages.shadow, shadow: true, resource: "probe.manual", kind: "trigger", class: "urgent",
  });
  works.closed = await workIdOf(pages.shadow, "probe.manual");
  const attempt = await testDb.pool.query<{ id: string }>(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms,
            jitter_u, pause_ms, operation, request, outcome, send_mark, sent_at, completed_at, apply_state)
     values ($1, true, $2, 'probe.manual', '', 'urgent', 1, 2000, 0.1, 2200, 'polls', '{}'::jsonb, 'shadow', 'shadow',
             clock_timestamp(), clock_timestamp(), 'skipped')
     returning id::text`,
    [pages.shadow, works.closed],
  );
  await testDb.pool.query(
    `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'applied',
            applied_revision = 1, last_attempt_id = $2, result = '{"probe":"ok"}'::jsonb
      where id = $1`,
    [works.closed, Number(attempt.rows[0]!.id)],
  );
  // A live row on the shadow page is not its journal: status reads skip it.
  await upsertDemand(db(), {
    pageId: pages.shadow, shadow: false, resource: "account.verify", kind: "trigger", class: "urgent",
  });
  // The other pages' polls.
  await ensurePollRows(db(), {
    pageId: pages.elsewhere,
    shadow: true,
    polls: [{ resource: "subscribers.poll", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 }],
  });
  works.elsewhere = await workIdOf(pages.elsewhere, "subscribers.poll");
  await ensurePollRows(db(), {
    pageId: pages.off,
    shadow: true,
    polls: [{ resource: "subscribers.poll", class: "planned", everyMs: 2 * HOUR_MS, phase: 0.5 }],
  });
  works.offPoll = await workIdOf(pages.off, "subscribers.poll");

  const owner = await createUserAccount(appContext, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  const ownerId = owner?.id ?? 0;
  await insertKey(DATASETS, "sync-datasets", ["read:datasets"], [pages.shadow, pages.off], ownerId);
  await insertKey(MESSAGES, "sync-messages", ["read:datasets", "read:messages"], [pages.shadow], ownerId);
  await insertKey(NO_DATASETS, "sync-nodatasets", ["read:messages"], [pages.shadow], ownerId);
  await setConfigOverride(testDb.db, { key: "agentReadPlaneMode", value: "full", userId: null, groupId: randomUUID() });

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: "owner-secret" },
  });
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  ownerCookie = String(raw ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function ownerGet(url: string) {
  return server!.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
}

function ownerPost(url: string, payload: Record<string, unknown>) {
  return server!.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
}

function agentGet(url: string, token: string) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

async function dueInFuture(workId: number): Promise<boolean> {
  const result = await testDb!.pool.query<{ future: boolean }>(
    "select due_at > clock_timestamp() as future from sync_work where id = $1", [workId]);
  return result.rows[0]!.future;
}

describe("owner routes: status and work", () => {
  it("every engine page's status, each from the journal it runs", async () => {
    const response = await ownerGet("/api/v1/sync/pages");
    expect(response.statusCode).toBe(200);
    const document = syncPagesResponseSchema.parse(response.json());
    expect(document.pages.map((page) => page.pageLabel).sort()).toEqual(["lora-1", "lora-2", "lora-3"]);
    const shadow = document.pages.find((page) => page.pageLabel === "lora-1")!;
    expect(shadow.mode).toBe("shadow");
    // No actor runs here: every open shadow row waits on the missing owner;
    // the live row on the shadow page is not counted.
    expect(shadow.queue.planned).toEqual({ runnable: 0, waitingByReason: { ownership_unconfirmed: 2 } });
    expect(shadow.queue.urgent).toEqual({ runnable: 0, waitingByReason: { ownership_unconfirmed: 1 } });
    expect(shadow.owner.running).toBe(false);
    // The simulated probe of the hour: counted as a shadow send, by class and key.
    expect(shadow.shadow).toEqual({ attemptsLastHour: 1, demandVsEstimate: null });
    expect(shadow.sendsLastHour).toEqual({ urgent: 1, requests: 0, planned: 0, byResource: { "probe.manual": 1 } });
    expect(shadow.pause.settingMs).toBeGreaterThanOrEqual(2_000);
    expect(shadow.requests).toEqual([]);
  });

  it("a page's work rows newest first, filtered, each with why it waits", async () => {
    const all = await ownerGet("/api/v1/sync/pages/lora-1/work");
    expect(all.statusCode).toBe(200);
    const document = syncPageWorkResponseSchema.parse(all.json());
    expect(document.work.map((row) => row.id)).toEqual(
      [works.closed, works.head, works.poll, works.followers].sort((a, b) => b - a),
    );
    expect(document.work.every((row) => row.shadow)).toBe(true);
    const closed = document.work.find((row) => row.id === works.closed)!;
    expect(closed).toMatchObject({
      state: "done",
      waitingReason: null,
      closeReason: "applied",
      lastAttempt: { outcome: "shadow", httpStatus: null },
    });
    expect(closed).not.toHaveProperty("result");
    const head = document.work.find((row) => row.id === works.head)!;
    expect(head).toMatchObject({ resource: "dm-messages.head", subject: GROUP, waitingReason: "ownership_unconfirmed" });

    const filtered = await ownerGet("/api/v1/sync/pages/lora-1/work?resource=dm-messages.head&state=open");
    expect(filtered.json().work.map((row: { id: number }) => row.id)).toEqual([works.head]);
    const paged = await ownerGet("/api/v1/sync/pages/lora-1/work?limit=1&offset=1");
    expect(paged.json().work).toHaveLength(1);

    const unknown = await ownerGet("/api/v1/sync/pages/no-such-page/work");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("sync_page_not_found");
    const badKey = await ownerGet("/api/v1/sync/pages/lora-1/work?resource=transactions");
    expect(badKey.statusCode).toBe(400);
  });

  it("one work row by id — the status link of a queued wait — only on its own page", async () => {
    const own = await ownerGet(`/api/v1/sync/pages/lora-1/work/${works.head}`);
    expect(own.statusCode).toBe(200);
    expect(syncPageWorkGetResponseSchema.parse(own.json()).work).toMatchObject({ id: works.head, state: "open" });
    // A live row reads too, whichever journal the page runs.
    const live = await workIdOf(pages.shadow, "account.verify");
    expect((await ownerGet(`/api/v1/sync/pages/lora-1/work/${live}`)).json().work).toMatchObject({ id: live, shadow: false });

    const foreign = await ownerGet(`/api/v1/sync/pages/lora-1/work/${works.elsewhere}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe("sync_work_not_found");
  });

  it("is the owner's: no session is a 401, an agent key is refused", async () => {
    for (const url of ["/api/v1/sync/pages", "/api/v1/sync/pages/lora-1/work", `/api/v1/sync/pages/lora-1/work/${works.head}`]) {
      expect((await server!.inject({ method: "GET", url })).statusCode, url).toBe(401);
      expect((await agentGet(url, MESSAGES)).statusCode, url).toBeGreaterThanOrEqual(401);
      expect((await agentGet(url, MESSAGES)).statusCode, url).toBeLessThanOrEqual(403);
    }
    const refresh = await server!.inject({ method: "POST", url: "/api/v1/sync/pages/lora-1/refresh", payload: {} });
    expect(refresh.statusCode).toBe(401);
  });
});

describe("owner routes: sync now", () => {
  it("makes the page's polls due in the journal it runs, wakes nothing else, and audits it", async () => {
    expect(await dueInFuture(works.poll)).toBe(true);
    const response = await ownerPost("/api/v1/sync/pages/lora-1/refresh", {});
    expect(response.statusCode).toBe(202);
    expect(syncPageRefreshResponseSchema.parse(response.json())).toEqual({ bumped: 2, shadow: true });
    expect(await dueInFuture(works.poll)).toBe(false);
    // Another page's polls are untouched.
    expect(await dueInFuture(works.elsewhere)).toBe(true);

    const audit = await testDb!.pool.query<{ platform_account_id: string; metadata: Record<string, unknown> }>(
      "select platform_account_id::text, metadata from audit_events where event_type = $1",
      [SYNC_PAGE_REFRESH_AUDIT_EVENT],
    );
    expect(audit.rows).toHaveLength(1);
    expect(Number(audit.rows[0]!.platform_account_id)).toBe(pages.shadow);
    expect(audit.rows[0]!.metadata).toMatchObject({ pageLabel: "lora-1", resources: null, bumped: 2, shadow: true });

    // Already due: nothing more to bump.
    expect((await ownerPost("/api/v1/sync/pages/lora-1/refresh", {})).json()).toEqual({ bumped: 0, shadow: true });
  });

  it("narrows to resource files", async () => {
    const response = await ownerPost("/api/v1/sync/pages/lora-1/refresh", { resources: ["followers"] });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ bumped: 1, shadow: true });
    expect(await dueInFuture(works.poll)).toBe(true);
    expect(await dueInFuture(works.followers)).toBe(false);
    const bad = await ownerPost("/api/v1/sync/pages/lora-1/refresh", { resources: ["followers.head"] });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses an off page (no actor runs it) and an unknown one, and writes nothing", async () => {
    const off = await ownerPost("/api/v1/sync/pages/lora-2/refresh", {});
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("sync_page_off");
    expect(await dueInFuture(works.offPoll)).toBe(true);
    const unknown = await ownerPost("/api/v1/sync/pages/no-such-page/refresh", {});
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("sync_page_not_found");
    const audit = await testDb!.pool.query("select 1 from audit_events where event_type = $1", [SYNC_PAGE_REFRESH_AUDIT_EVENT]);
    expect(audit.rows).toHaveLength(0);
  });
});

describe("agent plane: sync status and why", () => {
  it("status covers the key's pages only, with the plane's envelope", async () => {
    const response = await agentGet("/api/v1/agent/sync/pages", DATASETS);
    expect(response.statusCode).toBe(200);
    const document = agentSyncStatusResponseSchema.parse(response.json());
    expect(document.pages.map((page) => page.pageLabel).sort()).toEqual(["lora-1", "lora-2"]);
    expect(document.delivery).toMatchObject({ returned: 2, nextCursor: null });
    expect(document.conclusion.blockers).toContain("capture_floor_unknown");

    const one = agentSyncStatusResponseSchema.parse((await agentGet("/api/v1/agent/sync/pages?pageLabel=lora-2", DATASETS)).json());
    expect(one.pages.map((page) => page.pageLabel)).toEqual(["lora-2"]);
    // A label outside the grant narrows to nothing; it never widens the read.
    const outside = agentSyncStatusResponseSchema.parse((await agentGet("/api/v1/agent/sync/pages?pageLabel=lora-3", DATASETS)).json());
    expect(outside.pages).toEqual([]);

    const noDatasets = await agentGet("/api/v1/agent/sync/pages", NO_DATASETS);
    expect(noDatasets.statusCode).toBe(403);
    expect(noDatasets.json().error).toBe("agent_capability_missing");
  });

  it("why reads one key's rows; a chat key needs read:messages; a page outside the grant is the static 404", async () => {
    const poll = await agentGet("/api/v1/agent/pages/lora-1/sync/work?resource=subscribers.poll", DATASETS);
    expect(poll.statusCode).toBe(200);
    const document = agentSyncWhyResponseSchema.parse(poll.json());
    expect(document.work.map((row) => row.id)).toEqual([works.poll]);
    expect(document.work[0]).toMatchObject({ shadow: true, waitingReason: "ownership_unconfirmed", kind: "poll" });

    // A named subject with no open row: the newest closed one.
    const closed = agentSyncWhyResponseSchema.parse(
      (await agentGet("/api/v1/agent/pages/lora-1/sync/work?resource=probe.manual&subject=", DATASETS)).json(),
    );
    expect(closed.work.map((row) => [row.id, row.state])).toEqual([[works.closed, "done"]]);

    const chatWithout = await agentGet("/api/v1/agent/pages/lora-1/sync/work?resource=dm-messages.head", DATASETS);
    expect(chatWithout.statusCode).toBe(403);
    expect(chatWithout.json().error).toBe("agent_capability_missing");
    const chat = await agentGet(`/api/v1/agent/pages/lora-1/sync/work?resource=dm-messages.head&subject=${GROUP}`, MESSAGES);
    expect(chat.statusCode).toBe(200);
    expect(agentSyncWhyResponseSchema.parse(chat.json()).work.map((row) => row.subject)).toEqual([GROUP]);

    const outside = await agentGet("/api/v1/agent/pages/lora-3/sync/work?resource=subscribers.poll", MESSAGES);
    const missing = await agentGet("/api/v1/agent/pages/no-such-page/sync/work?resource=subscribers.poll", MESSAGES);
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body);

    const badKey = await agentGet("/api/v1/agent/pages/lora-1/sync/work?resource=dm-live.frame", DATASETS);
    expect(badKey.statusCode).toBe(400);
  });
});
