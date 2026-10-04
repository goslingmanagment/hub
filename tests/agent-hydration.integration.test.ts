import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  findAgentHydrationRequestByRef,
  insertAgentKey,
  listAgentHydrationEvents,
  setConfigOverride,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import {
  hasHydrationExecutorLane,
  ofapiJobSettlement,
  reconcileAgentHydrationDispatches,
  runAgentHydrationCycle,
  sweepStuckAgentHydration,
} from "../apps/runtime/src/services/agent-hydration.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Agent Read Plane slice C: hydration requests and their execution.
 *
 * The properties, in the order the design argues for them:
 *   an agent files an INTENT and nothing runs; the owner decides, with explicit
 *   caps and an explicit answer to the #158 mark-read question; an approval
 *   becomes EXACTLY ONE job on machinery that already exists; a rejection
 *   becomes nothing at all; a second decision is a 409, not an overwrite; a
 *   crashed run ends `failed` and needs a fresh decision, never an auto-retry.
 *
 * The executor has ONE lane, OnlyFans: an approval becomes a durable
 * `ofapi_capture_jobs` row, and the whole contract of this slice is which row
 * gets written with which caps. The legacy Fansly lane (the targeted thread
 * backfill and its auto-approve policy) is gone since step 4 (S4-15): a
 * Fansly request is the Fansly Sync Engine's history request
 * (tests/sync-hydration-wrapper.integration.test.ts), so here a Fansly page
 * the engine does not own shows what is left for it — the intent can be
 * filed, read and rejected, never approved or dispatched.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}hydration-suite-token`;
const OTHER_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}hydration-other-token`;
const CONVERSATION_REF = "810272281019305984";
const OF_CONVERSATION_REF = "of-chat-4242";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let ownerId = 0;
let fanslyPageId = 0;
let onlyfansPageId = 0;
let onlyfansThreadId = 0;

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

  const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
  if (!model) {
    throw new Error("fixture model was not created");
  }
  const fanslyPage = await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-2" });
  const onlyfansPage = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lora-of" });
  if (!fanslyPage || !onlyfansPage) {
    throw new Error("fixture pages were not created");
  }
  fanslyPageId = fanslyPage.id;
  onlyfansPageId = onlyfansPage.id;

  const owner = await createUserAccount(appContext, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  ownerId = owner?.id ?? 0;

  await insertAgentKey(testDb.db, {
    name: "hydration",
    keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN),
    capabilities: ["read:messages", "request:hydration"],
    pageIds: [fanslyPageId, onlyfansPageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });
  // A SECOND key, granted the same pages: #12 must still refuse it the first
  // key's request. A grant check alone would let it through.
  await insertAgentKey(testDb.db, {
    name: "hydration-other",
    keyPrefix: OTHER_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(OTHER_TOKEN),
    capabilities: ["request:hydration"],
    pageIds: [fanslyPageId, onlyfansPageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });

  await setFlag("agentReadPlaneMode", "full");
  await setFlag("agentHydrationMode", "request_only");

  await seedThreads();

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

// Typed value, matching what the validated admin write path stores. Before
// decision #216 the number budget was written here as String(budget) and only
// worked because drizzle's jsonb double-parse coerced it back on read.
async function setFlag(key: string, value: string | number | boolean) {
  await setConfigOverride(testDb!.db, { key, value, userId: null, groupId: randomUUID() });
}

async function seedThreads() {
  const pool = testDb!.pool;
  const { rows: fanRows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('fansly', '438766025723355136', 'rick', '2026-01-05T00:00:00Z') returning id`,
  );
  const fanId = Number(fanRows[0]!.id);
  await pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '438766025723355136', 12, 'partial_window', '2026-03-02T00:00:00Z',
       'm-100', 'm-112', 'm-112')`,
    [fanslyPageId, fanId, CONVERSATION_REF],
  );

  const { rows: ofFanRows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('onlyfans', '99887766', 'ofrick', '2026-01-05T00:00:00Z') returning id`,
  );
  const { rows: ofThreadRows } = await pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '99887766', 4, 'partial_window', '2026-03-02T00:00:00Z',
       'of-1', 'of-4', 'of-4') returning id`,
    [onlyfansPageId, Number(ofFanRows[0]!.id), OF_CONVERSATION_REF],
  );
  onlyfansThreadId = Number(ofThreadRows[0]!.id);
  await pool.query(
    `update pages set ofapi_account_id = 'acct_of_test' where id = $1`,
    [onlyfansPageId],
  );
}

function agentPost(url: string, payload: Record<string, unknown>, token = TOKEN) {
  return server!.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function agentGet(url: string, token = TOKEN) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function ownerPost(url: string, payload: Record<string, unknown>) {
  return server!.inject({ method: "POST", url, headers: { cookie: ownerCookie }, payload });
}

function ownerGet(url: string) {
  return server!.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    target: { kind: "thread_backfill_before", beforeAt: "2026-02-01T00:00:00Z" },
    reason: "January is missing and the fan paid in January",
    maxCalls: 5,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function fileRequest(
  pageLabel = "lora-2",
  conversationRef = CONVERSATION_REF,
  overrides: Record<string, unknown> = {},
) {
  const response = await agentPost(
    `/api/v1/agent/pages/${pageLabel}/threads/${conversationRef}/hydration-requests`,
    createBody(overrides),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function approve(
  request: { requestRef: string; rowVersion: number; coverageFingerprint: string },
  overrides: Record<string, unknown> = {},
) {
  return ownerPost(`/api/v1/agent/hydration-requests/${request.requestRef}/decision`, {
    decision: "approve",
    expectedVersion: request.rowVersion,
    coverageFingerprint: request.coverageFingerprint,
    idempotencyKey: randomUUID(),
    // EVERY ceiling. An approval carrying only `maxCalls` produced an OnlyFans
    // capture job its own executor refuses (`target_invalid`) and, since one
    // approval buys one attempt, silently spent the owner's decision on a job
    // that could never run.
    maxCalls: 5,
    maxPages: 4,
    maxCredits: 3,
    expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    allowMarkReadSideEffect: false,
    ...overrides,
  });
}

/**
 * Drives the OnlyFans capture executor one step with NO vendor client
 * configured.
 *
 * This is the difference between "a row exists" and "the job can run": the
 * executor blocks `target_invalid` when the job's target or caps are
 * unschedulable, and `transport_unavailable` only AFTER it has successfully
 * built the request plan. So `transport_unavailable` is the assertion that the
 * job is real work waiting on a client, not a corpse.
 */
async function stepOfapiCaptureExecutor(pageId: number) {
  const captureApp = createTestAppContext(testDb!, {
    authPolicyEnforcement: "enforce",
    ofapiMirrorBackgroundCaptureEnabled: true,
  });
  const { executeOfapiCaptureJobChunk } = await import(
    "../apps/runtime/src/services/ofapi-capture-jobs.ts"
  );
  const result = await executeOfapiCaptureJobChunk(captureApp, pageId);
  const { rows } = await testDb!.pool.query<{ state: string; reason_code: string | null }>(
    "select state, reason_code from ofapi_capture_jobs where id = $1::uuid",
    [result.jobId],
  );
  return { ...result, jobState: rows[0]?.state ?? null, reasonCode: rows[0]?.reason_code ?? null };
}

/** An OnlyFans request: the one platform an executor lane serves. */
function fileOnlyFansRequest(overrides: Record<string, unknown> = {}, conversationRef = OF_CONVERSATION_REF) {
  return fileRequest("lora-of", conversationRef, overrides);
}

/** An OnlyFans approval: its history read marks the chat read (#158), so the
 *  owner has to consent for the approval to be admissible at all. */
function approveOnlyFans(
  request: { requestRef: string; rowVersion: number; coverageFingerprint: string },
  overrides: Record<string, unknown> = {},
) {
  return approve(request, { allowMarkReadSideEffect: true, ...overrides });
}

async function captureJobs() {
  const { rows } = await testDb!.pool.query<{
    id: string;
    page_id: string;
    ofapi_account_id: string;
    kind: string;
    goal: string;
    state: string;
    active_slot_key: string | null;
    target: Record<string, unknown>;
    budget_scope: string;
    created_by: string;
  }>(
    `select id::text as id, page_id::text as page_id, ofapi_account_id, kind, goal, state, active_slot_key,
            target, budget_scope, created_by
     from ofapi_capture_jobs order by created_at, id`,
  );
  return rows;
}

/** Another visible OnlyFans thread on the fixture page, same fan. */
async function seedOnlyFansThread(conversationRef: string) {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, (select fan_id from page_dm_threads where id = $2), $3,
       '99887766', 3, 'partial_window', '2026-03-02T00:00:00Z', 's-1', 's-3', 's-3')
     returning id`,
    [onlyfansPageId, onlyfansThreadId, conversationRef],
  );
  return Number(rows[0]!.id);
}

describe("[sync-critical] agent hydration requests", () => {
  it("#11 files an intent and NOTHING is queued by filing it", async () => {
    const body = await fileRequest();
    expect(body.disposition).toBe("created");
    expect(body.request.state).toBe("requested");
    expect(body.request.admissibility.selected).toBe("vendor_paid_low");
    // The free lane is EVALUATED and reported, not silently skipped.
    expect(body.request.admissibility.orderEvaluated[0]).toBe("free_local_replay");
    expect(body.request.admissibility.costNote).toBe("egress_quota_and_ban_risk");
    // Free-form text never crosses the boundary: the digest does.
    expect(body.request.reasonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty("request.reason");
    // The envelope law holds on a write too.
    expect(body.capture.planes.length).toBeGreaterThan(0);
    expect(body.conclusion.blockers).toContain("claim_not_declared");

    // Filing changed nothing about execution: no job of any kind exists, and
    // the cycle has nothing to do, in `request_only` or in `dispatch`.
    for (const mode of ["request_only", "dispatch"] as const) {
      await setFlag("agentHydrationMode", mode);
      expect(await runAgentHydrationCycle(appContext)).toMatchObject({ mode, dispatched: 0, refused: 0 });
    }
    expect(await captureJobs()).toEqual([]);
    expect((await testDb!.pool.query("select to_regclass('pgboss.job') is null as absent")).rows[0].absent).toBe(true);
  });

  it("#11 is idempotent: the same key and body return the SAME request", async () => {
    const idempotencyKey = randomUUID();
    const first = await fileRequest("lora-2", CONVERSATION_REF, { idempotencyKey });
    const second = await fileRequest("lora-2", CONVERSATION_REF, { idempotencyKey });
    expect(second.disposition).toBe("coalesced");
    expect(second.request.requestRef).toBe(first.request.requestRef);
  });

  it("#11 refuses the same idempotency key with a different body", async () => {
    const idempotencyKey = randomUUID();
    await fileRequest("lora-2", CONVERSATION_REF, { idempotencyKey });
    const clash = await agentPost(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/hydration-requests`,
      createBody({ idempotencyKey, reason: "a completely different question" }),
    );
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("idempotency_mismatch");
  });

  it("#11 refuses a target that is out of reach with 409, not a silent row", async () => {
    const response = await agentPost(
      "/api/v1/agent/pages/lora-2/threads/no-such-thread/hydration-requests",
      createBody(),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("hydration_not_admissible");
  });

  it("#12 serves the filing key and refuses every other reader with the SAME 404", async () => {
    const { request } = await fileRequest();
    const mine = await agentGet(`/api/v1/agent/hydration-requests/${request.requestRef}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().request.requestRef).toBe(request.requestRef);

    // Another key, same page grant, still refused — and byte-identically to a
    // uuid that never existed.
    const other = await agentGet(
      `/api/v1/agent/hydration-requests/${request.requestRef}`,
      OTHER_TOKEN,
    );
    const missing = await agentGet(`/api/v1/agent/hydration-requests/${randomUUID()}`, OTHER_TOKEN);
    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(missing.body);
  });

  it("#13 approve -> EXACTLY ONE capture job is created, for the right chat and page", async () => {
    const { request } = await fileOnlyFansRequest();
    expect(request.admissibility.selected).toBe("vendor_paid_high");
    const decided = await approveOnlyFans(request);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().disposition).toBe("approved");
    expect(decided.json().request.state).toBe("approved");
    expect(decided.json().request.decision).toMatchObject({ maxCalls: 5, decisionSource: "owner", policyVersion: null });

    // Still nothing: `request_only` decides but never executes.
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(0);
    expect(await captureJobs()).toEqual([]);

    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(1);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "dispatching", dispatchCount: 1, executionLane: "vendor_paid_high" });
    // The job id was minted BEFORE the claim and is what the request already
    // points at — there is no window where a dispatching row has no reference.
    expect(await captureJobs()).toEqual([expect.objectContaining({
      id: stored.request?.executionRef,
      page_id: String(onlyfansPageId),
      ofapi_account_id: "acct_of_test",
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      state: "ready",
      // One capture job per chat at a time.
      active_slot_key: `page:${onlyfansPageId}:chat:${OF_CONVERSATION_REF}`,
      // No stored message resolves the `beforeAt` boundary, so the walk
      // starts at the thread's head.
      target: expect.objectContaining({ chatId: OF_CONVERSATION_REF, frozenHeadId: "of-4" }),
      budget_scope: "bulk",
      created_by: "owner",
    })]);

    // One approval, one attempt: the next cycle starts nothing.
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, refused: 0 });
    expect(await captureJobs()).toHaveLength(1);
  });

  it("#13 never approves a Fansly request (no executor lane runs it); a rejection still closes it", async () => {
    expect(hasHydrationExecutorLane("onlyfans")).toBe(true);
    expect(hasHydrationExecutorLane("fansly")).toBe(false);

    const { request } = await fileRequest();
    // Every ceiling named, mark-read refused (Fansly's read does not mark):
    // the approval the legacy lane ran until step 4 (S4-15).
    const refused = await approve(request, { maxCredits: 0 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("hydration_not_admissible");
    const untouched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(untouched.request).toMatchObject({ state: "requested", rowVersion: request.rowVersion });
    expect((await listAgentHydrationEvents(testDb!.db, untouched.request!.id)).map((event) => event.kind))
      .toEqual(["created"]);

    const rejected = await ownerPost(`/api/v1/agent/hydration-requests/${request.requestRef}/decision`, {
      decision: "reject",
      expectedVersion: request.rowVersion,
      coverageFingerprint: request.coverageFingerprint,
      idempotencyKey: randomUUID(),
      reason: "no executor runs it",
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().request.state).toBe("rejected");
  });

  it("the executor claims no Fansly approval: one decided by an earlier image waits out its expiry unspent", async () => {
    const { request } = await fileRequest();
    await testDb!.pool.query(
      `update agent_hydration_requests
          set state = 'approved', row_version = row_version + 1, decided_at = now(), decision_source = 'owner',
              decided_by_user_id = $2, decision_approved = true, decision_allow_mark_read = false,
              decision_max_calls = 5, decision_max_credits = 0, decision_max_pages = 4,
              expires_at = now() + interval '1 hour'
        where request_ref = $1::uuid`,
      [request.requestRef, ownerId],
    );
    await setFlag("agentHydrationMode", "dispatch");

    for (let pass = 0; pass < 2; pass += 1) {
      expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, refused: 1, expired: 0 });
    }
    const waiting = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(waiting.request).toMatchObject({ state: "approved", dispatchCount: 0, executionRef: null });
    expect(await captureJobs()).toEqual([]);
    expect((await testDb!.pool.query("select to_regclass('pgboss.job') is null as absent")).rows[0].absent).toBe(true);

    await testDb!.pool.query("update agent_hydration_requests set expires_at = now() - interval '1 minute'");
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ expired: 1, dispatched: 0, refused: 0 });
    const expired = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(expired.request?.state).toBe("expired");
  });

  it("approves nothing on its own: a dispatch cycle leaves a filed request for the owner's decision", async () => {
    // The auto-approve policy went at step 4 (S4-15) and its keys with the
    // legacy Fansly config keys (S4-26): no setting decides a request.
    const { request } = await fileRequest();
    await setFlag("agentHydrationMode", "dispatch");

    const cycle = await runAgentHydrationCycle(appContext);
    expect(cycle).toEqual({
      mode: "dispatch", expired: 0, swept: 0, reconciled: 0, dispatched: 0, refused: 0, engineSettled: 0,
    });
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "requested", decisionSource: null });
    expect((await listAgentHydrationEvents(testDb!.db, stored.request!.id)).map((event) => event.kind))
      .toEqual(["created"]);
  });

  it("a `beforeAt` boundary resolves to the message the job pages back from (P1-1)", async () => {
    // Stored messages, so an approved `beforeAt` boundary has something to
    // resolve against: the oldest message at or after the instant is the
    // cursor to page back from.
    await testDb!.pool.query(
      `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id,
         sender_platform_user_id, sender_role, created_at, content)
       values
         ($1, $2, 'of-1', '99887766', 'fan', '2026-02-10T00:00:00Z', 'older'),
         ($1, $2, 'of-2', '99887766', 'fan', '2026-02-20T00:00:00Z', 'boundary'),
         ($1, $2, 'of-4', '99887766', 'fan', '2026-03-01T00:00:00Z', 'newest')`,
      [onlyfansThreadId, onlyfansPageId],
    );
    const { request } = await fileOnlyFansRequest({
      target: { kind: "thread_backfill_before", beforeAt: "2026-02-15T00:00:00Z" },
    });
    await approveOnlyFans(request);
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);
    // The oldest stored message at or after the instant — not the thread's
    // head, which is what a walk without a boundary would have used.
    expect((await captureJobs())[0]!.target.frozenHeadId).toBe("of-2");
  });

  it("the OnlyFans job freezes its head at the approved boundary (P1-1)", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF, {
      target: { kind: "thread_backfill_before", beforeMessageRef: "of-3" },
    });
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    const { rows } = await testDb!.pool.query<{ target: Record<string, unknown> }>(
      "select target from ofapi_capture_jobs where id = $1::uuid",
      [stored.request?.executionRef],
    );
    // NOT the thread's own last message id: the approved boundary.
    expect(rows[0]!.target.frozenHeadId).toBe("of-3");
  });

  it("coverage is recomputed at decision time, not compared with itself (P1-2)", async () => {
    const { request } = await fileOnlyFansRequest();
    // Somebody deepened the thread between the filing and the decision: the
    // owner would now be paying for history we already hold. The old check
    // compared the request's own stored fingerprint with the echoed copy and
    // could never see this.
    await testDb!.pool.query(
      `update page_dm_threads set stored_message_count = 900, oldest_stored_message_id = 'of-0'
       where id = $1`,
      [onlyfansThreadId],
    );
    const stale = await approveOnlyFans(request);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("hydration_proposal_stale");
  });

  it("dispatch refuses when coverage moved after the decision, WITHOUT burning the attempt (P1-2)", async () => {
    const { request } = await fileOnlyFansRequest();
    expect((await approveOnlyFans(request)).statusCode).toBe(200);
    await testDb!.pool.query(
      "update page_dm_threads set stored_message_count = 900 where id = $1",
      [onlyfansThreadId],
    );
    await setFlag("agentHydrationMode", "dispatch");
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, refused: 1 });
    expect(await captureJobs()).toEqual([]);
    // Still approved: the attempt was NOT consumed, so the owner keeps the
    // decision and it closes by expiry rather than by a spurious failure.
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("approved");
    expect(stored.request?.dispatchCount).toBe(0);
  });

  it("an approval refused before its claim leaves the next one its turn in the same cycle", async () => {
    // The older approval is refused by revalidation (its thread was deepened
    // after the decision), so it stays `approved` and comes first in
    // `decided_at` order on EVERY cycle. It starts nothing, so it must not
    // stand in the way of the approval behind it.
    await seedOnlyFansThread("of-chat-second");
    const stale = (await fileOnlyFansRequest()).request;
    const fresh = (await fileOnlyFansRequest({}, "of-chat-second")).request;
    expect((await approveOnlyFans(stale)).statusCode).toBe(200);
    expect((await approveOnlyFans(fresh)).statusCode).toBe(200);
    await testDb!.pool.query(
      "update page_dm_threads set stored_message_count = 900 where id = $1",
      [onlyfansThreadId],
    );
    await setFlag("agentHydrationMode", "dispatch");

    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 1, refused: 1 });
    const refused = await findAgentHydrationRequestByRef(testDb!.db, stale.requestRef);
    expect(refused.request).toMatchObject({ state: "approved", dispatchCount: 0 });
    const dispatched = await findAgentHydrationRequestByRef(testDb!.db, fresh.requestRef);
    expect(dispatched.request?.state).toBe("dispatching");
    expect((await captureJobs()).map((job) => job.target.chatId)).toEqual(["of-chat-second"]);
  });

  it("a missing OFAPI mapping does not consume the approval (P2b)", async () => {
    await testDb!.pool.query("update pages set ofapi_account_id = null where id = $1", [
      onlyfansPageId,
    ]);
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(0);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("approved");
    expect(stored.request?.dispatchCount).toBe(0);
    const { rows } = await testDb!.pool.query("select id from ofapi_capture_jobs");
    expect(rows).toHaveLength(0);
  });

  it("an INDETERMINATE job write is left dispatching, never marked failed (P1-4)", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    await setFlag("agentHydrationMode", "dispatch");
    // The write threw after possibly landing: the job may exist right now.
    await testDb!.pool.query(`
      create function hydration_test_lost_capture_job() returns trigger language plpgsql as $$
      begin raise exception 'connection reset after the insert'; end $$;
      create trigger hydration_test_lost_capture_job before insert on ofapi_capture_jobs
        for each row execute function hydration_test_lost_capture_job();
    `);
    try {
      expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(0);
    } finally {
      await testDb!.pool.query(`
        drop trigger hydration_test_lost_capture_job on ofapi_capture_jobs;
        drop function hydration_test_lost_capture_job();
      `);
    }

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // NOT failed. Settling here would let the owner authorize the same paid work
    // a second time while the first copy is still going.
    expect(stored.request?.state).toBe("dispatching");
    expect(stored.request?.executionRef).not.toBeNull();
    // ... and never claimed again: the row keeps pointing at the reference it
    // minted until reconciliation or the deadline closes it from evidence.
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, refused: 0 });
    expect((await findAgentHydrationRequestByRef(testDb!.db, request.requestRef)).request?.dispatchCount).toBe(1);
  });

  it("OFAPI coalescence attaches only to a matching target and caps (P1-6)", async () => {
    // Somebody else's exhaustion job already occupies this chat's active slot,
    // with far larger ceilings. Attaching would make this tightly capped
    // hydration track and report work it never authorized.
    await testDb!.pool.query(
      `insert into ofapi_capture_jobs (id, page_id, ofapi_account_id, kind, goal, state,
         active_slot_key, target, target_hash, budget_scope, created_by,
         max_calls, max_credits, max_pages, max_items,
         source_contract_version, parser_version, proof_policy_version)
       values (gen_random_uuid(), $1, 'acct_of_test', 'chat_paginate', 'history_to_exhaustion',
         'ready', $2, '{"chatId":"of-chat-4242","frozenHeadId":"of-999","anchorMessageId":null,"limit":100}'::jsonb,
         repeat('a', 64), 'bulk', 'owner', 999, 999, 999, 99999, 'v1', 'v1', 'v1')`,
      [onlyfansPageId, `page:${onlyfansPageId}:chat:${OF_CONVERSATION_REF}`],
    );

    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // Refused, not silently attached to the stranger's job.
    expect(stored.request?.state).toBe("failed");
    const { rows } = await testDb!.pool.query<{ max_calls: number }>(
      "select max_calls from ofapi_capture_jobs where page_id = $1",
      [onlyfansPageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.max_calls).toBe(999);
  });

  it("a terminal job past its deadline is settled from its RESULT, not as a timeout (P1-5)", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);
    const dispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // It finished AFTER the deadline but before this cycle.
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'blocked', reason_code = 'gap_open',
         accepted_items = 250, accepted_pages = 3, spent_credits = 3 where id = $1::uuid`,
      [dispatched.request!.executionRef],
    );
    await testDb!.pool.query(
      "update agent_hydration_requests set dispatch_deadline_at = now() - interval '1 hour'",
    );

    await runAgentHydrationCycle(appContext);
    const settled = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // The real outcome and the real spend, not `failed/timeout` with zeroes.
    expect(settled.request?.state).toBe("partially_completed");
    expect(settled.request?.lastError).toBe("budget_exhausted");
    expect(settled.request?.acceptedItems).toBe(250);
    expect(settled.request?.spentCredits).toBe(3);
  });

  it("state never moves without its journal entry (P1-3)", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    // Every version the row has ever had is accounted for by an event, and the
    // events are in the order the transitions happened.
    expect(events.map((event) => event.rowVersion)).toEqual([0, stored.request!.rowVersion]);
    expect(events.map((event) => event.toState)).toEqual(["requested", "approved"]);
    expect(events.map((event) => event.actor)).toEqual(["agent_key", "owner_session"]);
  });

  it("an expired request cannot be decided even before the sweeper sees it (P2f)", async () => {
    const { request } = await fileOnlyFansRequest();
    await testDb!.pool.query(
      "update agent_hydration_requests set expires_at = now() - interval '1 minute'",
    );
    const late = await approveOnlyFans(request);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("conflict");
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("requested");
  });

  it("a refused poll does not spend the key's row budget (P2g)", async () => {
    const rowsCharged = async () => {
      const { rows } = await testDb!.pool.query<{ total: string }>(
        "select coalesce(sum(rows_returned), 0)::text as total from agent_key_usage_daily",
      );
      return rows[0]!.total;
    };
    const before = await rowsCharged();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const missing = await agentGet(`/api/v1/agent/hydration-requests/${randomUUID()}`);
      expect(missing.statusCode).toBe(404);
    }
    // A request that delivered nothing charges nothing: repeated failed polls
    // must not burn a daily allowance for zero rows.
    expect(await rowsCharged()).toBe(before);

    // ... and a poll that DOES deliver still charges its row, so the fix is not
    // simply "never charge".
    const { request } = await fileRequest();
    const served = await agentGet(`/api/v1/agent/hydration-requests/${request.requestRef}`);
    expect(served.statusCode).toBe(200);
    expect(await rowsCharged()).not.toBe(before);
  });

  it("#12 claims no plane it did not read (P1-7)", async () => {
    const { request } = await fileRequest();
    const polled = await agentGet(`/api/v1/agent/hydration-requests/${request.requestRef}`);
    expect(polled.statusCode).toBe(200);
    const threads = polled.json().capture.planes
      .find((plane: { plane: string }) => plane.plane === "page_dm_threads");
    // This operation reads the request table, `pages` and `agent_keys` — it never
    // touches the thread inventory, so the envelope must not say it did.
    // Decision #199: a witness proves a query actually ran.
    expect(threads.state).not.toBe("read");

    // ... while #11, which DOES query the thread to resolve the target, says so.
    expect(
      (await agentPost(
        `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/hydration-requests`,
        createBody(),
      )).json().capture.planes.find((plane: { plane: string }) => plane.plane === "page_dm_threads")
        .state,
    ).toBe("read");
  });

  it("#13 reject -> nothing is ever enqueued", async () => {
    const { request } = await fileOnlyFansRequest();
    const rejected = await ownerPost(
      `/api/v1/agent/hydration-requests/${request.requestRef}/decision`,
      {
        decision: "reject",
        expectedVersion: request.rowVersion,
        coverageFingerprint: request.coverageFingerprint,
        idempotencyKey: randomUUID(),
        reason: "not worth the credits",
      },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().request.state).toBe("rejected");

    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(0);
    expect(await captureJobs()).toEqual([]);
  });

  it("a second decision is a 409 CAS conflict, never an overwrite", async () => {
    const { request } = await fileOnlyFansRequest();
    // The VERSION half of the CAS, on a request still in `requested`: a decision
    // formed against a version that no longer exists is refused even though the
    // state would have allowed it. Without this the state check alone would pass
    // a regression that dropped version checking entirely.
    const wrongVersion = await approveOnlyFans(request, { expectedVersion: request.rowVersion + 7 });
    expect(wrongVersion.statusCode).toBe(409);
    expect(wrongVersion.json().error).toBe("conflict");
    const untouched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(untouched.request?.state).toBe("requested");

    expect((await approveOnlyFans(request)).statusCode).toBe(200);
    // ... and the STATE half: same stale rowVersion, different idempotency key.
    const again = await approveOnlyFans(request);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("conflict");
  });

  it("replaying the SAME decision is already_decided, not a second decision", async () => {
    const { request } = await fileOnlyFansRequest();
    // A replay is the IDENTICAL body, expiry included: a different expiry is a
    // different decision, and the mismatch branch below proves the difference is
    // detected rather than swallowed.
    const replayable = {
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    };
    const first = await approveOnlyFans(request, replayable);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await approveOnlyFans(request, replayable);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().disposition).toBe("already_decided");

    // The same key with a DIFFERENT decision body is a mismatch, not a replay.
    const mutated = await approveOnlyFans(request, { ...replayable, maxCalls: 50 });
    expect(mutated.statusCode).toBe(409);
    expect(mutated.json().error).toBe("idempotency_mismatch");
  });

  it("a decision quoting a stale coverage fingerprint is 409, not an approval", async () => {
    const { request } = await fileOnlyFansRequest();
    const stale = await approveOnlyFans(request, { coverageFingerprint: "0".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("hydration_proposal_stale");
  });

  it("an approval must state the mark-read side effect and a cap and an expiry", async () => {
    const { request } = await fileOnlyFansRequest();
    const naked = await ownerPost(
      `/api/v1/agent/hydration-requests/${request.requestRef}/decision`,
      {
        decision: "approve",
        expectedVersion: request.rowVersion,
        coverageFingerprint: request.coverageFingerprint,
        idempotencyKey: randomUUID(),
      },
    );
    expect(naked.statusCode).toBe(400);
  });

  it("#158: an OnlyFans approval that refuses mark-read is not admissible", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    const refused = await approve(request, { allowMarkReadSideEffect: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("hydration_not_admissible");

    // With consent it decides, and the consent lands IN the execution record.
    const consented = await approve(request, { allowMarkReadSideEffect: true });
    expect(consented.statusCode, consented.body).toBe(200);
    expect(consented.json().request.decision.allowMarkReadSideEffect).toBe(true);

    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(1);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("dispatching");
    const { rows } = await testDb!.pool.query<{
      manifest: Record<string, unknown>;
      max_calls: number;
      max_pages: number;
      max_credits: number;
    }>(
      "select manifest, max_calls, max_pages, max_credits from ofapi_capture_jobs where id = $1::uuid",
      [stored.request?.executionRef],
    );
    // Every ceiling the owner named reaches the job. All three are load-bearing:
    // the executor refuses a job missing ANY of them.
    expect(rows[0]!.max_calls).toBe(5);
    expect(rows[0]!.max_pages).toBe(4);
    expect(rows[0]!.max_credits).toBe(3);
    expect(rows[0]!.manifest.allowMarkReadSideEffect).toBe(true);
    expect(rows[0]!.manifest.hydrationRequestRef).toBe(request.requestRef);

    // THE ASSERTION THAT MATTERS: the job is SCHEDULABLE. Asserting the row
    // alone stayed green over a job that its own executor blocks
    // `target_invalid` on its first lease — and that dead job would have burned
    // the owner's single attempt.
    const step = await stepOfapiCaptureExecutor(onlyfansPageId);
    expect(step.jobId).toBe(stored.request?.executionRef);
    expect(step.reasonCode).not.toBe("target_invalid");
    // It got all the way to "no vendor client configured", which is the last
    // thing before the wire.
    expect(step.reasonCode).toBe("transport_unavailable");
  });

  it("#158: an OnlyFans approval below the lane's credit floor is refused", async () => {
    // `maxCredits: 0` is contract-legal and would block the capture job
    // `target_invalid` on its first lease. The refusal belongs at decision time,
    // where the owner can still change the number.
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    const broke = await approve(request, { allowMarkReadSideEffect: true, maxCredits: 0 });
    expect(broke.statusCode).toBe(409);
    expect(broke.json().error).toBe("hydration_not_admissible");
  });

  it("an approval that omits any ceiling is a 400, not an unschedulable job", async () => {
    const { request } = await fileOnlyFansRequest();
    for (const missing of ["maxCalls", "maxPages", "maxCredits"] as const) {
      const body: Record<string, unknown> = {
        decision: "approve",
        expectedVersion: request.rowVersion,
        coverageFingerprint: request.coverageFingerprint,
        idempotencyKey: randomUUID(),
        maxCalls: 5,
        maxPages: 4,
        maxCredits: 3,
        expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
        allowMarkReadSideEffect: true,
      };
      delete body[missing];
      const response = await ownerPost(
        `/api/v1/agent/hydration-requests/${request.requestRef}/decision`,
        body,
      );
      expect(response.statusCode, missing).toBe(400);
    }
  });

  it("a run that left no record is settled failed at its deadline and needs a FRESH decision, never a retry", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(1);

    // The claim landed and its job did not survive: nothing says what ran.
    // Before the deadline the request stays open; reconciliation has no record
    // to settle it from.
    await testDb!.pool.query("delete from ofapi_capture_jobs");
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ reconciled: 0, swept: 0, dispatched: 0 });
    expect((await findAgentHydrationRequestByRef(testDb!.db, request.requestRef)).request?.state).toBe("dispatching");

    await testDb!.pool.query(
      "update agent_hydration_requests set dispatch_deadline_at = now() - interval '1 minute'",
    );
    const cycle = await runAgentHydrationCycle(appContext);
    expect(cycle).toMatchObject({ reconciled: 0, swept: 1, dispatched: 0 });
    // NOT re-created. One approval buys one attempt.
    expect(await captureJobs()).toEqual([]);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "failed", lastError: "timeout" });
    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    expect(events.at(-1)).toMatchObject({ kind: "failed", fromState: "dispatching", toState: "failed", actor: "sweeper" });

    // A later cycle changes nothing, and the same request cannot be decided
    // again: a failed request is terminal.
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, swept: 0 });
    const again = await approveOnlyFans({ ...request, rowVersion: stored.request!.rowVersion });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("conflict");
  });

  it("a cycle claims at most five approvals", async () => {
    // Six approvals, five claims, and the sixth is the next cycle's.
    const requests = [];
    for (let index = 0; index < 6; index += 1) {
      requests.push((await fileRequest("lora-of", OF_CONVERSATION_REF)).request);
    }
    for (const request of requests) {
      expect((await approve(request, { allowMarkReadSideEffect: true })).statusCode).toBe(200);
    }
    await setFlag("agentHydrationMode", "dispatch");

    const first = await runAgentHydrationCycle(appContext);
    expect(first.dispatched + first.refused).toBe(5);
    const last = await findAgentHydrationRequestByRef(testDb!.db, requests[5]!.requestRef);
    expect(last.request?.state).toBe("approved");
    expect(last.request?.dispatchCount).toBe(0);

    const second = await runAgentHydrationCycle(appContext);
    expect(second.dispatched + second.refused).toBe(1);
  });

  it("an OnlyFans outcome is derived from EXHAUSTION, never from row counts", async () => {
    // The whole mapping, stated. Row counts appear nowhere in it: a run
    // truncated by its own ceiling returns plenty of rows and must NOT read as
    // `completed`, while an honest run that reached the end of the vendor's
    // history and found nothing new must.
    expect(ofapiJobSettlement({ state: "complete", reasonCode: null }))
      .toEqual({ state: "completed", lastError: "none" });
    expect(ofapiJobSettlement({ state: "blocked", reasonCode: "gap_open" }))
      .toEqual({ state: "partially_completed", lastError: "budget_exhausted" });
    // The owner's own ceiling binding is BUDGET, never a vendor outage — the
    // difference between "your limit stopped it" and "OnlyFans is broken", which
    // is the difference between reading a number and debugging a vendor.
    expect(ofapiJobSettlement({
      state: "blocked",
      reasonCode: "job_cap",
      acceptedItems: 120,
      acceptedPages: 2,
    })).toEqual({ state: "partially_completed", lastError: "budget_exhausted" });
    expect(ofapiJobSettlement({
      state: "blocked",
      reasonCode: "item_cap_exceeded",
      acceptedItems: 0,
      acceptedPages: 0,
    })).toEqual({ state: "failed", lastError: "budget_exhausted" });
    expect(ofapiJobSettlement({ state: "blocked", reasonCode: "target_invalid" }))
      .toEqual({ state: "failed", lastError: "vendor_unavailable" });
    expect(ofapiJobSettlement({ state: "cancelled", reasonCode: null }))
      .toEqual({ state: "failed", lastError: "quarantined" });
    // Still running: no verdict at all, rather than a guess.
    expect(ofapiJobSettlement({ state: "leased", reasonCode: null })).toBeNull();

    // ... and the cap-truncated case end to end, because it is the one that used
    // to be reported to the owner as `completed`.
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);
    const dispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'blocked', reason_code = 'gap_open',
         accepted_items = 300, accepted_pages = 3, spent_credits = 3 where id = $1::uuid`,
      [dispatched.request!.executionRef],
    );
    expect(await reconcileAgentHydrationDispatches(appContext)).toBe(1);
    const settled = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(settled.request?.state).toBe("partially_completed");
    expect(settled.request?.lastError).toBe("budget_exhausted");
    expect(settled.request?.spentCredits).toBe(3);
  });

  it("the sweeper does not kill a request whose capture job is still running", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext);
    await testDb!.pool.query(
      "update agent_hydration_requests set dispatch_deadline_at = now() - interval '1 hour'",
    );

    // The job is `ready`: it is going to spend credits. Calling the request dead
    // now would take that spend out of the owner's view entirely.
    expect(await sweepStuckAgentHydration(appContext)).toBe(0);
    const alive = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(alive.request?.state).toBe("dispatching");

    // Once the job is terminal, reconciliation settles it — and only a run that
    // never produced a job is closed by the deadline.
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'cancelled', completed_at = now()
       where id = $1::uuid`,
      [alive.request!.executionRef],
    );
    expect(await sweepStuckAgentHydration(appContext)).toBe(1);
    const dead = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(dead.request?.state).toBe("failed");
  });

  it("the flag OFF still closes the request of a run dispatched before the flip", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext)).dispatched).toBe(1);
    await seedOnlyFansThread("of-chat-second");
    const waiting = (await fileOnlyFansRequest({}, "of-chat-second")).request;
    expect((await approveOnlyFans(waiting)).statusCode).toBe(200);

    await setFlag("agentHydrationMode", "off");
    const dispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'blocked', reason_code = 'gap_open',
         accepted_items = 40, accepted_pages = 2, spent_credits = 2 where id = $1::uuid`,
      [dispatched.request!.executionRef],
    );
    const cycle = await runAgentHydrationCycle(appContext);
    // Bookkeeping about work already dispatched goes on; nothing new starts.
    expect(cycle).toMatchObject({ mode: "off", reconciled: 1, dispatched: 0, expired: 0 });
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "partially_completed", acceptedItems: 40, spentCredits: 2 });
    expect((await findAgentHydrationRequestByRef(testDb!.db, waiting.requestRef)).request?.state).toBe("approved");
    expect(await captureJobs()).toHaveLength(1);
  });

  it("an expired approval is never dispatched", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    await testDb!.pool.query(
      "update agent_hydration_requests set expires_at = now() - interval '1 minute'",
    );
    await setFlag("agentHydrationMode", "dispatch");
    const cycle = await runAgentHydrationCycle(appContext);
    expect(cycle.expired).toBe(1);
    expect(cycle.dispatched).toBe(0);
    expect(await captureJobs()).toEqual([]);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("expired");
  });

  it("the flag OFF makes the whole family inert", async () => {
    await setFlag("agentHydrationMode", "off");
    const create = await agentPost(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/hydration-requests`,
      createBody(),
    );
    expect(create.statusCode).toBe(503);
    expect(create.json().error).toBe("agent_plane_disabled");
    const list = await ownerGet("/api/v1/agent/hydration-requests");
    expect(list.statusCode).toBe(503);
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ mode: "off", dispatched: 0, expired: 0 });
  });

  it("the owner approval queue serves the board and an agent key never sees it", async () => {
    await fileRequest();
    const queue = await ownerGet("/api/v1/agent/hydration-requests?state=requested");
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json().items).toHaveLength(1);
    expect(queue.json().items[0].pageLabel).toBe("lora-2");

    const asAgent = await agentGet("/api/v1/agent/hydration-requests?state=requested");
    expect([401, 403]).toContain(asAgent.statusCode);
  });

  it("every hydration response is no-store", async () => {
    const created = await agentPost(
      `/api/v1/agent/pages/lora-2/threads/${CONVERSATION_REF}/hydration-requests`,
      createBody(),
    );
    expect(created.headers["cache-control"]).toBe("no-store");
    const refused = await agentGet(`/api/v1/agent/hydration-requests/${randomUUID()}`);
    expect(refused.statusCode).toBe(404);
    expect(refused.headers["cache-control"]).toBe("no-store");
  });

  it("the owner queue stops claiming an exhausted snapshot when it caps (BL-C1)", async () => {
    await fileRequest();
    const capped = await ownerGet("/api/v1/agent/hydration-requests?state=requested&limit=1");
    expect(capped.statusCode, capped.body).toBe(200);
    const body = capped.json();
    expect(body.items).toHaveLength(1);
    // The list has no cursor, so a full page must say so instead of reporting
    // an exact, exhausted count while rows fall off the end.
    expect(body.delivery.cappedBy).toBe("limit");
    expect(body.delivery.snapshotExhausted).toBe(false);
    expect(body.delivery.matchedInScope.exact).toBe(false);
  });
});
