import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  findAgentHydrationRequestByRef,
  insertAgentKey,
  listAgentHydrationEvents,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import {
  hasHydrationExecutorLane,
  runAgentHydrationCycle,
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
  appContext = createTestAppContext(testDb);

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
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });

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
  await pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '99887766', 4, 'partial_window', '2026-03-02T00:00:00Z',
       'of-1', 'of-4', 'of-4') returning id`,
    [onlyfansPageId, Number(ofFanRows[0]!.id), OF_CONVERSATION_REF],
  );
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
    // the cycle has nothing to do until the owner decides.
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ dispatched: 0, refused: 0 });
    expect(await captureJobs()).toEqual([]);
    expect((await testDb!.pool.query("select to_regclass('pgboss.job') is null as absent")).rows[0].absent).toBe(true);
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

  it("approves no Fansly request on its own: a dispatch cycle leaves it for the owner's decision", async () => {
    // The Fansly auto-approve policy went at step 4 (S4-15); the OnlyFans one
    // (owner 2026-10-25) never decides another platform's request.
    const { request } = await fileRequest();

    const cycle = await runAgentHydrationCycle(appContext);
    expect(cycle).toEqual({
      expired: 0, swept: 0, reconciled: 0, dispatched: 0, refused: 0, engineSettled: 0, autoApproved: 0,
    });
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "requested", decisionSource: null });
    expect((await listAgentHydrationEvents(testDb!.db, stored.request!.id)).map((event) => event.kind))
      .toEqual(["created"]);
  });

  it("auto-approves an OnlyFans request whose chat has nothing unread — as the policy, never the owner", async () => {
    const { request } = await fileOnlyFansRequest();

    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ autoApproved: 1, dispatched: 1 });
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({
      state: "dispatching",
      decisionSource: "auto_policy",
      decisionPolicyVersion: 2,
      decidedByUserId: null,
      decisionAllowMarkRead: true,
      decisionMaxCredits: 20,
    });
    expect((await listAgentHydrationEvents(testDb!.db, stored.request!.id)).map((event) => [event.kind, event.actor]))
      .toEqual([["created", "agent_key"], ["approved", "auto_policy"], ["dispatched", "executor"]]);
  });

  it("leaves an OnlyFans request for the owner while the chat has unread or the fan wrote last", async () => {
    const { request } = await fileOnlyFansRequest();
    await testDb!.pool.query("update page_dm_threads set unread_count = 2 where platform_account_id = $1", [onlyfansPageId]);
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ autoApproved: 0, dispatched: 0 });

    await testDb!.pool.query("update page_dm_threads set unread_count = 0 where platform_account_id = $1", [onlyfansPageId]);
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, message_type)
       values ($1, 'onlyfans', $2, '9100000001', 'fan', false, now(), 'hey', 1)`,
      [onlyfansPageId, OF_CONVERSATION_REF],
    );
    expect(await runAgentHydrationCycle(appContext)).toMatchObject({ autoApproved: 0, dispatched: 0 });
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request).toMatchObject({ state: "requested", decisionSource: null });
  });

  it("an INDETERMINATE job write is left dispatching, never marked failed (P1-4)", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
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

  it("a run that left no record is settled failed at its deadline and needs a FRESH decision, never a retry", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
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

  it("an expired approval is never dispatched", async () => {
    const { request } = await fileOnlyFansRequest();
    await approveOnlyFans(request);
    await testDb!.pool.query(
      "update agent_hydration_requests set expires_at = now() - interval '1 minute'",
    );
    const cycle = await runAgentHydrationCycle(appContext);
    expect(cycle.expired).toBe(1);
    expect(cycle.dispatched).toBe(0);
    expect(await captureJobs()).toEqual([]);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("expired");
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
});
