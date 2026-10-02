import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentHistoryRequestCreateResponseSchema,
  agentHistoryRequestGetResponseSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
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
import { seedSyncPage, setModeDirect } from "./helpers/sync-engine-host.ts";

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
  appContext = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
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

  it("every page that is not live with requests open answers the same 409, agent and owner alike", async () => {
    // The gate is the page's state, not the mode alone: a live page answers
    // 409 until its requests_enabled_at has passed, and a Fansly page the
    // engine has no row for (never seeded) is as closed as an `off` one.
    const handles = { db: db(), pool: testDb!.pool };
    const closed: Array<{ label: string; pageId: number }> = [];
    for (const mode of ["off", "handover"] as const) {
      closed.push(await seedSyncPage(handles, { label: `gate-${mode}`, mode }));
    }
    const notOpened = await seedSyncPage(handles, { label: "gate-live-not-opened", mode: "live", guard: "fansly_sync_engine" });
    closed.push(notOpened);
    const opensLater = await seedSyncPage(handles, { label: "gate-live-later", mode: "live", guard: "fansly_sync_engine" });
    await testDb!.pool.query(
      `update sync_pages set requests_enabled_at = clock_timestamp() + interval '1 hour',
              legacy_imported_at = clock_timestamp() where page_id = $1`,
      [opensLater.pageId],
    );
    closed.push(opensLater);
    // Once live and opened, then rolled back: the old opening does not carry over.
    const rolledBack = await seedSyncPage(handles, { label: "gate-rolled-back", mode: "live", guard: "fansly_sync_engine" });
    await openRequests(rolledBack.pageId);
    await setModeDirect(testDb!.pool, rolledBack.pageId, "shadow");
    closed.push(rolledBack);
    const model = await createModel(db(), { slug: "model-gate-no-row", name: "gate-no-row" });
    const noRow = await createFanslyPage(db(), { modelId: model!.id, label: "gate-no-row" });
    closed.push({ label: "gate-no-row", pageId: noRow!.id });
    expect(Number((await testDb!.pool.query("select count(*) from sync_pages where page_id = $1", [noRow!.id])).rows[0].count))
      .toBe(0);

    const ownerId = Number((await testDb!.pool.query("select id from users where username = 'owner'")).rows[0].id);
    const GATE = `${AGENT_KEY_TOKEN_PREFIX}history-gate-token`;
    await insertKey(GATE, "history-gate", ["read:messages", "request:hydration"], closed.map((page) => page.pageId), ownerId);

    for (const page of closed) {
      const agent = await agentPost(`/api/v1/agent/pages/${page.label}/history-requests`, createBody(MIXED_FANS), GATE);
      expect(agent.statusCode, page.label).toBe(409);
      expect(agent.json(), page.label).toMatchObject({ error: "history_requests_unavailable_on_page", statusCode: 409 });

      const owner = await ownerPost(`/api/v1/sync/pages/${page.label}/history-requests`, createBody(MIXED_FANS));
      expect(owner.statusCode, page.label).toBe(409);
      expect(owner.json().error, page.label).toBe("history_requests_unavailable_on_page");
    }
    expect(Number((await testDb!.pool.query("select count(*) from history_requests")).rows[0].count)).toBe(0);

    // The same body on the one live, opened page is filed.
    const open = await agentPost("/api/v1/agent/pages/lora-1/history-requests", createBody(MIXED_FANS));
    expect(open.statusCode).toBe(200);
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
  it("files a request: each fan's chat or refusal at once, idempotent, audited by digest", async () => {
    const body = createBody(MIXED_FANS, { reason: "whole chats for the July audit" });
    const created = await agentPost("/api/v1/agent/pages/lora-1/history-requests", body);
    expect(created.statusCode).toBe(200);
    const document = created.json();
    expect(agentHistoryRequestCreateResponseSchema.safeParse(document).success).toBe(true);
    expect(document.disposition).toBe("created");
    expect(document.request).toMatchObject({
      pageLabel: "lora-1",
      state: "open",
      requesterKind: "agent_key",
      depth: { kind: "all" },
      counts: { total: 4, ready: 1, refused: 1 },
      eta: { basis: "estimate" },
    });
    const items = document.items as Array<Record<string, unknown>>;
    expect(items.map((item) => [item.ordinal, (item.input as { kind: string }).kind, item.state])).toEqual([
      [0, "fan", "queued"],
      [1, "chat_url", "ready"],
      [2, "conversation", "queued"],
      [3, "fan", "refused"],
    ]);
    expect(items[1]).toMatchObject({ satisfiedBy: "already_satisfied", historyState: "complete", historyProof: "empty_page" });
    expect(items[2]).toMatchObject({ historyState: "unverified", conversationRef: group(3) });
    expect(items[3]).toMatchObject({ refusal: "not_found", conversationRef: null });
    // Nothing is waiting on a page that has no running engine owner here.
    expect(document.request.waitingReason).toBe("ownership_unconfirmed");

    // The envelope: the thread inventory WAS read; a request establishes no floor.
    const planes = document.capture.planes as Array<{ plane: string; state: string }>;
    expect(planes.find((plane) => plane.plane === "page_dm_threads")?.state).toBe("read");
    expect(document.conclusion.blockers).toEqual(expect.arrayContaining(["claim_not_declared", "capture_floor_unknown"]));
    expect(document.delivery).toMatchObject({ returned: 4, nextCursor: null, snapshotExhausted: true });

    // Same key and fans: the same request. Same key, other fans: a 409.
    const again = await agentPost("/api/v1/agent/pages/lora-1/history-requests", body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ disposition: "coalesced", request: { ref: document.request.ref } });
    const mismatch = await agentPost("/api/v1/agent/pages/lora-1/history-requests", { ...body, fans: MIXED_FANS.slice(0, 1) });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toBe("idempotency_mismatch");

    // The agent audit holds a digest of the reason, never the sentence.
    const audit = await testDb!.pool.query<{ request_summary: Record<string, unknown> }>(
      "select request_summary from agent_read_audit where operation = 'agentHistoryRequestCreate' order by id",
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]!.request_summary).toMatchObject({
      requestRef: document.request.ref,
      disposition: "created",
      fans: 4,
      reasonSha256: sha256Hex("whole chats for the July audit"),
    });
    expect(JSON.stringify(audit.rows)).not.toContain("July audit");
  });

  it("reads a request by ref, filters its fans, and answers any other key the static 404", async () => {
    const created = (await agentPost("/api/v1/agent/pages/lora-1/history-requests", createBody(MIXED_FANS))).json();
    const ref = created.request.ref as string;

    const read = await agentGet(`/api/v1/agent/history-requests/${ref}`);
    expect(read.statusCode).toBe(200);
    const document = read.json();
    expect(agentHistoryRequestGetResponseSchema.safeParse(document).success).toBe(true);
    expect(document.request.ref).toBe(ref);
    expect(document.items).toHaveLength(4);

    const ready = (await agentGet(`/api/v1/agent/history-requests/${ref}?state=ready`)).json();
    expect(ready.items.map((item: { ordinal: number }) => item.ordinal)).toEqual([1]);
    expect(ready.delivery).toMatchObject({
      returned: 1,
      matchedInScope: { value: 1, exact: true },
      snapshotExhausted: false,
      caveats: expect.arrayContaining(["no_frozen_snapshot"]),
    });

    const foreign = await agentGet(`/api/v1/agent/history-requests/${ref}`, OTHER);
    const unknown = await agentGet(`/api/v1/agent/history-requests/${randomUUID()}`, OTHER);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    // `read:messages` guards the fans' chat refs.
    expect((await agentGet(`/api/v1/agent/history-requests/${ref}`, NO_MESSAGES)).statusCode).toBe(403);
  });

  it("pages more than 200 fans through get with the create's own cursor", async () => {
    const fans = Array.from({ length: 250 }, (_, index) => ({
      kind: "fan",
      platformUserId: `7000000000000${String(index).padStart(5, "0")}`,
    }));
    const created = (await agentPost("/api/v1/agent/pages/lora-1/history-requests", createBody(fans))).json();
    expect(created.items).toHaveLength(200);
    expect(created.request.counts).toMatchObject({ total: 250, refused: 250 });
    expect(created.delivery).toMatchObject({ returned: 200, cappedBy: "limit", snapshotExhausted: false });
    const cursor = created.delivery.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));

    const rest = await agentGet(`/api/v1/agent/history-requests/${created.request.ref}?cursor=${cursor}`);
    expect(rest.statusCode).toBe(200);
    const page = rest.json();
    expect(page.items.map((item: { ordinal: number }) => item.ordinal)).toEqual(
      Array.from({ length: 50 }, (_, index) => 200 + index),
    );
    expect(page.delivery).toMatchObject({ returned: 50, nextCursor: null, snapshotExhausted: true });
    expect(page.conclusion.blockers).toContain("mutable_sort_key_traversal");

    // A cursor pins the scope; another key cannot spend it.
    expect((await agentGet(`/api/v1/agent/history-requests/${created.request.ref}?cursor=${cursor}&state=ready`)).statusCode)
      .toBe(400);
    const other = await agentGet(`/api/v1/agent/history-requests/${created.request.ref}?cursor=${cursor}`, NO_MESSAGES);
    expect(other.statusCode).toBe(403);
  });

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
  it("file, read, page, list and cancel through the same service", async () => {
    const created = await ownerPost("/api/v1/sync/pages/lora-1/history-requests", createBody(MIXED_FANS, {
      depth: { kind: "latest", count: 5 },
    }));
    expect(created.statusCode).toBe(200);
    const document = created.json();
    expect(document).toMatchObject({
      disposition: "created",
      nextAfterOrdinal: null,
      request: { requesterKind: "owner_session", depth: { kind: "latest", count: 5 } },
    });
    // The owner's create is recorded in the owner audit trail.
    const audits = await testDb!.pool.query<{ event_type: string }>(
      "select event_type from audit_events where event_type = 'admin.history_request_create'",
    );
    expect(audits.rows).toHaveLength(1);

    const ref = document.request.ref as string;
    const page = (await ownerGet(`/api/v1/sync/history-requests/${ref}?limit=2&afterOrdinal=0`)).json();
    expect(page.items.map((item: { ordinal: number }) => item.ordinal)).toEqual([1, 2]);
    expect(page.nextAfterOrdinal).toBe(2);

    const list = (await ownerGet("/api/v1/sync/history-requests?pageLabel=lora-1&state=open")).json();
    expect(list.requests.map((request: { ref: string }) => request.ref)).toEqual([ref]);

    const cancelled = await ownerPost(`/api/v1/sync/history-requests/${ref}/cancel`, {});
    expect(cancelled.json()).toMatchObject({ disposition: "cancelled", request: { state: "cancelled" } });

    expect((await ownerGet("/api/v1/sync/history-requests?pageLabel=no-such-page")).statusCode).toBe(404);
    expect((await ownerGet(`/api/v1/sync/history-requests/${randomUUID()}`)).statusCode).toBe(404);
    expect((await ownerPost("/api/v1/sync/pages/no-such-page/history-requests", createBody(MIXED_FANS))).statusCode)
      .toBe(404);
  });

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

describe("a chat's proven coverage on the read plane (design §7.7)", () => {
  it("hub threads items carry the chain and a proven_chain floor; unproven chats claim none", async () => {
    const response = await agentGet("/api/v1/agent/threads?pageLabel=lora-1");
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    const byRef = new Map(items.map((item) => [item.conversationRef, item]));
    expect(byRef.get(group(1))).toMatchObject({
      historyState: "partial",
      historyProof: null,
      contiguousCount: 30,
      contiguousOldestAt: new Date(BASE_MS + 60_000).toISOString(),
      captureFloor: { kind: "proven_chain", at: new Date(BASE_MS + 60_000).toISOString() },
    });
    expect(byRef.get(group(2))).toMatchObject({
      historyState: "complete",
      historyProof: "empty_page",
      contiguousCount: 10,
      captureFloor: { kind: "proven_chain" },
    });
    expect(byRef.get(group(3))).toMatchObject({
      historyState: "unverified",
      contiguousCount: 0,
      contiguousOldestAt: null,
      captureFloor: { kind: "unknown", at: null },
    });
  });

  it("the person's threads and the transcript carry the same coverage", async () => {
    const person = (await agentGet(`/api/v1/agent/people/fansly/${fan(1)}`)).json();
    expect(person.threads[0]).toMatchObject({ historyState: "partial", captureFloor: { kind: "proven_chain" } });

    const window = "from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z";
    const transcript = await agentGet(`/api/v1/agent/pages/lora-1/threads/${group(2)}/messages?${window}`);
    expect(transcript.statusCode).toBe(200);
    const document = transcript.json();
    expect(document.threadCoverage).toEqual({
      historyState: "complete",
      historyProof: "empty_page",
      contiguousOldestAt: new Date(BASE_MS + 60_000).toISOString(),
      contiguousCount: 10,
      headConfirmedAt: expect.any(String),
    });
    const planes = document.capture.planes as Array<{ plane: string; state: string }>;
    expect(planes.find((plane) => plane.plane === "page_dm_threads")?.state).toBe("read");

    const none = (await agentGet(`/api/v1/agent/pages/lora-1/threads/123/messages?${window}`)).json();
    expect(none.threadCoverage).toBeNull();
  });
});
