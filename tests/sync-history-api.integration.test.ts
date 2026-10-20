import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  insertAgentKey,
  setConfigOverride,
  upsertFans,
  writeThreadChain,
  type Database,
  type ThreadChainState,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
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
 * History requests over HTTP (design §7.4, §7.7): the agent operations and
 * the owner routes against a real database and the real server.
 *
 *  - a page not switched to the engine answers 409
 *    history_requests_unavailable_on_page (every page in step 2);
 *  - on a live page with requests open, create / get / list / cancel work for
 *    an agent key and for the owner, through the SAME service;
 *  - fans page through the create's own cursor;
 *  - a key sees every requester's requests on its pages and nothing else: a
 *    request on another page is the plane's one static 404;
 *  - `hub threads`, #3 and the transcript report a chat's proven coverage.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR = 3_600_000;
const EPOCH_MS = 1561494359900;
const BASE_MS = Date.now() - 30 * 24 * HOUR;
const snowflake = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
const msg = (k: number) => snowflake(BASE_MS + k * 60_000);
const group = (n: number) => snowflake(BASE_MS - n * 1000);
const fan = (n: number) => `51000000000000${String(n).padStart(4, "0")}`;

const FULL = `${AGENT_KEY_TOKEN_PREFIX}history-full-token`;
const NO_MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}history-nomsg-token`;
const OTHER = `${AGENT_KEY_TOKEN_PREFIX}history-other-token`;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let livePageId = 0;

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

async function openRequests(pageId: number) {
  await testDb!.pool.query(
    `update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute',
            legacy_imported_at = clock_timestamp(), mode_changed_at = clock_timestamp() - interval '1 day'
      where page_id = $1`,
    [pageId],
  );
}

async function seedThread(pageId: number, n: number, chain: { from: number; to: number; complete?: boolean } | null, stored?: number) {
  const [fanRow] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: fan(n) }]);
  const count = chain === null ? stored ?? 0 : chain.to - chain.from + 1;
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            stored_message_count, newest_stored_message_id, oldest_stored_message_id, message_coverage_status, is_visible,
            last_message_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'partial_window', true, now())
     returning id::text as id`,
    [pageId, group(n), fanRow!.id, fan(n), count, count > 0 ? msg(40) : null, count > 0 ? msg(1) : null],
  );
  const threadId = Number(inserted.rows[0]!.id);
  if (chain !== null) {
    const complete = chain.complete === true;
    const headAt = new Date(Date.now() - HOUR);
    const state: ThreadChainState = {
      epoch: 0,
      state: complete ? "complete" : "partial",
      headId: msg(chain.to),
      headAt,
      oldestId: msg(chain.from),
      oldestCreatedAtMs: BASE_MS + chain.from * 60_000,
      count,
      upwardCount: 0,
      proof: complete ? "empty_page" : null,
      proofWitness: complete ? { kind: "raw", rawPayloadId: 1 } : null,
      provenAt: complete ? headAt : null,
    };
    await db().transaction(async (tx) => {
      await writeThreadChain(tx as unknown as Database, threadId, { chain: state, source: "journal_rebuild" });
    });
  }
  return threadId;
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

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
  const handles = { db: db(), pool: testDb.pool };

  const live = await seedSyncPage(handles, { label: "lora-1", mode: "live", guard: "fansly_sync_engine" });
  await openRequests(live.pageId);
  livePageId = live.pageId;
  const shadow = await seedSyncPage(handles, { label: "lora-2", mode: "shadow" });
  const elsewhere = await seedSyncPage(handles, { label: "lora-3", mode: "live", guard: "fansly_sync_engine" });
  await openRequests(elsewhere.pageId);

  // lora-1: a partial chain, a complete one, and messages legacy stored unproven.
  await seedThread(live.pageId, 1, { from: 1, to: 30 });
  await seedThread(live.pageId, 2, { from: 1, to: 10, complete: true });
  await seedThread(live.pageId, 3, null, 12);
  await seedThread(elsewhere.pageId, 4, { from: 1, to: 5 });

  const owner = await createUserAccount(appContext, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  const ownerId = owner?.id ?? 0;
  await insertKey(FULL, "history-full", ["read:messages", "request:hydration"], [live.pageId, shadow.pageId], ownerId);
  await insertKey(NO_MESSAGES, "history-nomsg", ["request:hydration"], [live.pageId], ownerId);
  await insertKey(OTHER, "history-other", ["read:messages", "request:hydration"], [elsewhere.pageId], ownerId);
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

function agentPost(url: string, payload: Record<string, unknown>, token = FULL) {
  return server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
}

function agentGet(url: string, token = FULL) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function ownerPost(url: string, payload: Record<string, unknown>) {
  return server!.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
}

function ownerGet(url: string) {
  return server!.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
}

function createBody(fans: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    fans,
    depth: { kind: "all" },
    reason: "integration: whole chats",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

const MIXED_FANS = [
  { kind: "fan", platformUserId: fan(1) },
  { kind: "chat_url", url: `https://fansly.com/messages/${group(2)}` },
  { kind: "conversation", conversationRef: group(3) },
  { kind: "fan", platformUserId: "999999999999999999" },
];

describe("history requests: the per-page gate (step 2)", () => {
  it("a page not switched to the engine answers 409 history_requests_unavailable_on_page, agent and owner alike", async () => {
    const agent = await agentPost("/api/v1/agent/pages/lora-2/history-requests", createBody(MIXED_FANS));
    expect(agent.statusCode).toBe(409);
    expect(agent.json()).toMatchObject({ error: "history_requests_unavailable_on_page", statusCode: 409 });
    expect(agent.json().message).toContain("hydration route");

    const owner = await ownerPost("/api/v1/sync/pages/lora-2/history-requests", createBody(MIXED_FANS));
    expect(owner.statusCode).toBe(409);
    expect(owner.json().error).toBe("history_requests_unavailable_on_page");
    expect(Number((await testDb!.pool.query("select count(*) from history_requests")).rows[0].count)).toBe(0);
  });

  it("a page outside the grant is the static 404, and a missing capability a 403", async () => {
    const outside = await agentPost("/api/v1/agent/pages/lora-3/history-requests", createBody(MIXED_FANS));
    const missing = await agentPost("/api/v1/agent/pages/no-such-page/history-requests", createBody(MIXED_FANS));
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body);

    const noMessages = await agentPost("/api/v1/agent/pages/lora-1/history-requests", createBody(MIXED_FANS), NO_MESSAGES);
    expect(noMessages.statusCode).toBe(403);
    expect(noMessages.json().error).toBe("agent_capability_missing");
  });
});

describe("history requests: the agent operations", () => {
  it("lists every requester's requests on the key's pages, newest first, and nothing else", async () => {
    const mine = (await agentPost("/api/v1/agent/pages/lora-1/history-requests", createBody(MIXED_FANS))).json();
    const owners = (await ownerPost("/api/v1/sync/pages/lora-1/history-requests", createBody(MIXED_FANS.slice(0, 2)))).json();
    const elsewhere = await agentPost(
      "/api/v1/agent/pages/lora-3/history-requests",
      createBody([{ kind: "fan", platformUserId: fan(4) }]),
      OTHER,
    );
    expect(elsewhere.statusCode).toBe(200);

    const list = (await agentGet("/api/v1/agent/history-requests")).json();
    expect(list.items.map((item: { ref: string; requesterKind: string }) => [item.ref, item.requesterKind])).toEqual([
      [owners.request.ref, "owner_session"],
      [mine.request.ref, "agent_key"],
    ]);
    expect(list.delivery).toMatchObject({ returned: 2, matchedInScope: { value: 2, exact: true }, snapshotExhausted: true });

    // A label outside the grant narrows to nothing.
    expect((await agentGet("/api/v1/agent/history-requests?pageLabel=lora-3")).json().items).toEqual([]);

    // A keyset walk, one at a time.
    const first = (await agentGet("/api/v1/agent/history-requests?limit=1")).json();
    expect(first.items.map((item: { ref: string }) => item.ref)).toEqual([owners.request.ref]);
    expect(first.delivery.cappedBy).toBe("limit");
    const second = (await agentGet(`/api/v1/agent/history-requests?cursor=${first.delivery.nextCursor}`)).json();
    expect(second.items.map((item: { ref: string }) => item.ref)).toEqual([mine.request.ref]);

    const open = (await agentGet("/api/v1/agent/history-requests?state=done")).json();
    expect(open.items).toEqual([]);
  });

  it("cancels any requester's request on a granted page, idempotently, and audits it", async () => {
    const owners = (await ownerPost("/api/v1/sync/pages/lora-1/history-requests", createBody(MIXED_FANS))).json();
    const ref = owners.request.ref as string;

    expect((await agentPost(`/api/v1/agent/history-requests/${ref}/cancel`, {}, OTHER)).statusCode).toBe(404);

    const cancelled = await agentPost(`/api/v1/agent/history-requests/${ref}/cancel`, { reason: "superseded by a wider ask" });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      disposition: "cancelled",
      request: { ref, state: "cancelled", counts: { cancelled: 2, ready: 1, refused: 1 } },
      delivery: { returned: 1 },
    });
    const again = await agentPost(`/api/v1/agent/history-requests/${ref}/cancel`, {});
    expect(again.json().disposition).toBe("already_cancelled");

    const audit = await testDb!.pool.query<{ request_summary: Record<string, unknown> }>(
      "select request_summary from agent_read_audit where operation = 'agentHistoryRequestCancel' order by id",
    );
    expect(audit.rows.map((row) => row.request_summary.disposition)).toEqual(["cancelled", "already_cancelled"]);
    expect(audit.rows[0]!.request_summary.reasonSha256).toBe(sha256Hex("superseded by a wider ask"));
    const works = await testDb!.pool.query<{ state: string }>(
      "select state from sync_work where page_id = $1 and resource = 'dm-messages.history'",
      [livePageId],
    );
    expect(works.rows.map((row) => row.state).every((state) => state === "cancelled")).toBe(true);
  });
});

describe("history requests: the owner routes", () => {
  it("refuse an agent key and a missing session, and the owner cookie opens no agent operation", async () => {
    expect([401, 403]).toContain((await agentGet("/api/v1/sync/history-requests")).statusCode);
    expect([401, 403]).toContain(
      (await agentPost("/api/v1/sync/pages/lora-1/history-requests", createBody(MIXED_FANS))).statusCode,
    );
    const anonymous = await server!.inject({ method: "GET", url: "/api/v1/sync/history-requests" });
    expect(anonymous.statusCode).toBe(401);
    expect([401, 403]).toContain((await ownerGet("/api/v1/agent/history-requests")).statusCode);
  });
});
