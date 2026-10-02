import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureSyncPage,
  findAgentHydrationRequestByRef,
  insertAgentKey,
  listAgentHydrationEvents,
  setConfigOverride,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { historyKeyOfLegacyHydration } from "../apps/runtime/src/sync/requests/legacy-hydration.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";

// The legacy hydration route on a live Fansly page (design S2 §7.5, step 3
// §3.5 item 10): the agent files a hydration request as before; once the
// page's history requests are open the hub files a one-fan history request
// for it (requester `legacy_hydration_wrapper`, depth `before_boundary`,
// idempotent by the legacy ref) and the legacy row reads as that request's
// fan, in the legacy vocabulary. Before the requests open the row stays
// `requested`; a page being switched answers 409; nobody decides a wrapper.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const DAY_MS = 86_400_000;
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}wrapper-suite-token`;
const CONVERSATION_REF = "810272281019305984";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let pageId = 0;
let threadId = 0;

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
  appContext = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  const model = await createModel(testDb.db, { slug: "lilly", name: "Lilly" });
  const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "lilly-1" });
  pageId = page!.id;
  const owner = await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await insertAgentKey(testDb.db, {
    name: "wrapper",
    keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN),
    capabilities: ["read:messages", "request:hydration"],
    pageIds: [pageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: owner?.id ?? null,
  });
  for (const [key, value] of [["agentReadPlaneMode", "full"], ["agentHydrationMode", "request_only"]] as const) {
    await setConfigOverride(testDb.db, { key, value, userId: null, groupId: randomUUID() });
  }
  const fan = await testDb.pool.query<{ id: string }>(
    "insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', '438766025723355136', 'rick', now()) returning id",
  );
  const thread = await testDb.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
            stored_message_count, message_coverage_status, last_message_at, oldest_stored_message_id,
            newest_stored_message_id, last_message_id, is_visible)
     values ($1, $2, $3, '438766025723355136', 12, 'partial_window', now(), '100', '112', '112', true) returning id`,
    [pageId, Number(fan.rows[0]!.id), CONVERSATION_REF],
  );
  threadId = Number(thread.rows[0]!.id);
  await ensureSyncPage(testDb.db, { pageId });

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" } });
  const setCookie = login.headers["set-cookie"];
  ownerCookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  await server?.close();
  server = null;
});

async function live(options: { requestsOpen: boolean }) {
  await setModeDirect(testDb!.pool, pageId, "live");
  await testDb!.pool.query(
    `update sync_pages set requests_enabled_at = clock_timestamp() + ($2::text)::interval where page_id = $1`,
    [pageId, options.requestsOpen ? "-1 second" : "1 hour"],
  );
}

function file(idempotencyKey = randomUUID()) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/agent/pages/lilly-1/threads/${CONVERSATION_REF}/hydration-requests`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      target: { kind: "thread_backfill_before", beforeMessageRef: "100" },
      reason: "the fan's first month is missing",
      maxCalls: 5,
      idempotencyKey,
    },
  });
}

function poll(requestRef: string) {
  return server!.inject({ method: "GET", url: `/api/v1/agent/hydration-requests/${requestRef}`, headers: { authorization: `Bearer ${TOKEN}` } });
}

async function historyOf(ref: string) {
  return (await testDb!.pool.query<{ id: string; requester_kind: string; depth_kind: string; depth_boundary_message_ref: string | null; legacy_hydration_request_id: string | null }>(
    `select id::text as id, requester_kind, depth_kind, depth_boundary_message_ref, legacy_hydration_request_id::text
       from history_requests where request_ref = $1::uuid`,
    [ref],
  )).rows[0]!;
}

describe("the hydration wrapper", () => {
  it("files a one-fan history request on a live page with open requests and reads its fan as the legacy state", async () => {
    await live({ requestsOpen: true });
    const key = randomUUID();
    const created = await file(key);
    expect(created.statusCode, created.body).toBe(200);
    const request = created.json().request as { requestRef: string; state: string; progress: { executionRef: string; lastError: string } };
    expect(request.state).toBe("dispatching");
    const row = (await findAgentHydrationRequestByRef(testDb!.db, request.requestRef)).request!;
    expect(row.executionLane).toBe("fansly_sync_engine");
    expect(request.progress.executionRef).toBe(row.executionRef);
    const history = await historyOf(row.executionRef!);
    expect(history).toMatchObject({
      requester_kind: "legacy_hydration_wrapper", depth_kind: "before_boundary", depth_boundary_message_ref: "100",
      legacy_hydration_request_id: String(row.id),
    });
    const idempotency = await testDb!.pool.query<{ key: string }>("select idempotency_key::text as key from history_requests where id = $1", [history.id]);
    expect(idempotency.rows[0]!.key).toBe(historyKeyOfLegacyHydration(request.requestRef));
    const events = await listAgentHydrationEvents(testDb!.db, row.id);
    expect(events.map((event) => [event.kind, event.fromState, event.toState])).toEqual([
      ["created", null, "requested"], ["dispatched", "requested", "dispatching"],
    ]);

    // The same body again: the same row, the same history request.
    const again = await file(key);
    expect(again.json()).toMatchObject({ disposition: "coalesced", request: { requestRef: request.requestRef, state: "dispatching" } });
    expect((await testDb!.pool.query("select count(*)::int as n from history_requests")).rows[0].n).toBe(1);

    // The fan read down to the boundary: partially completed; to an empty page: completed.
    await testDb!.pool.query(
      "update history_request_items set state = 'ready', satisfied_by = 'boundary', satisfied_at = now() where request_id = $1", [history.id],
    );
    await testDb!.pool.query("update history_requests set state = 'done', done_at = now() where id = $1", [history.id]);
    expect((await poll(request.requestRef)).json().request).toMatchObject({ state: "partially_completed", progress: { lastError: "none" } });
    await testDb!.pool.query("update history_request_items set satisfied_by = 'empty_page' where request_id = $1", [history.id]);
    expect((await poll(request.requestRef)).json().request).toMatchObject({ state: "completed" });
    await testDb!.pool.query(
      "update history_request_items set state = 'blocked', satisfied_by = null, satisfied_at = null where request_id = $1", [history.id],
    );
    await testDb!.pool.query("update history_requests set state = 'open', done_at = null where id = $1", [history.id]);
    expect((await poll(request.requestRef)).json().request).toMatchObject({ state: "failed", progress: { lastError: "quarantined" } });
    await testDb!.pool.query("update history_requests set state = 'cancelled', cancelled_at = now() where id = $1", [history.id]);
    expect((await poll(request.requestRef)).json().request).toMatchObject({ state: "expired" });

    // Nobody decides a wrapper.
    const decision = await server!.inject({
      method: "POST", url: `/api/v1/agent/hydration-requests/${request.requestRef}/decision`, headers: { cookie: ownerCookie },
      payload: {
        decision: "approve", expectedVersion: row.rowVersion, coverageFingerprint: row.coverageFingerprint, idempotencyKey: randomUUID(),
        maxCalls: 5, maxCredits: 10, maxPages: 5, maxItems: 100, expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
        allowMarkReadSideEffect: true,
      },
    });
    expect(decision.statusCode).toBe(409);
    expect(decision.json()).toMatchObject({ error: "engine_managed" });
    expect(threadId).toBeGreaterThan(0);
  });

  it("leaves the row requested while the page's requests are not open yet", async () => {
    await live({ requestsOpen: false });
    const created = await file();
    expect(created.statusCode).toBe(200);
    expect(created.json().request.state).toBe("requested");
    expect((await testDb!.pool.query("select count(*)::int as n from history_requests")).rows[0].n).toBe(0);
  });

  it("answers 409 fansly_page_switching while the page is being switched, and files nothing", async () => {
    await setModeDirect(testDb!.pool, pageId, "handover");
    const created = await file();
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ error: "fansly_page_switching" });
    expect((await testDb!.pool.query("select count(*)::int as n from agent_hydration_requests")).rows[0].n).toBe(0);
  });

  it("files a hydration request as before on a shadow page", async () => {
    await setModeDirect(testDb!.pool, pageId, "shadow");
    const created = await file();
    expect(created.statusCode).toBe(200);
    expect(created.json().request).toMatchObject({ state: "requested", progress: { executionRef: null } });
  });
});
