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
  ofapiJobSettlement,
  reconcileAgentHydrationDispatches,
  runAgentHydrationCycle,
  settleAgentHydrationFromBackfill,
  sweepStuckAgentHydration,
} from "../apps/runtime/src/services/agent-hydration.ts";
import {
  parseTargetedThreadBackfillJob,
  TARGETED_THREAD_BACKFILL_QUEUE,
} from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

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
 * The executor is exercised with a STUB queue client rather than a live worker:
 * the whole contract of this slice is which job gets enqueued with which
 * arguments, and a stub is what makes that assertable to the argument.
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
let fanslyThreadId = 0;
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

async function setFlag(key: string, value: string) {
  await setConfigOverride(testDb!.db, { key, value, userId: null, groupId: randomUUID() });
}

async function seedThreads() {
  const pool = testDb!.pool;
  const { rows: fanRows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('fansly', '438766025723355136', 'rick', '2026-01-05T00:00:00Z') returning id`,
  );
  const fanId = Number(fanRows[0]!.id);
  const { rows: threadRows } = await pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '438766025723355136', 12, 'partial_window', '2026-03-02T00:00:00Z',
       'm-100', 'm-112', 'm-112') returning id`,
    [fanslyPageId, fanId, CONVERSATION_REF],
  );
  fanslyThreadId = Number(threadRows[0]!.id);

  const { rows: ofFanRows } = await pool.query<{ id: string }>(
    `insert into fans (platform, platform_user_id, username, first_seen_at)
     values ('onlyfans', '99887766', 'ofrick', '2026-01-05T00:00:00Z') returning id`,
  );
  await pool.query(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '99887766', 4, 'partial_window', '2026-03-02T00:00:00Z',
       'of-1', 'of-4', 'of-4')`,
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

/**
 * The executor's only outside contact: a queue client. Everything this slice
 * promises is visible in what lands here.
 *
 * It echoes the caller's `id` back, exactly as pg-boss does — the executor mints
 * that id before the claim and the request already points at it, so a stub that
 * invented its own would hide whether the two ever agree.
 */
type HydrationBoss = Parameters<typeof runAgentHydrationCycle>[1];

function stubBoss() {
  const send = vi.fn(async (_queue: string, _data: unknown, options?: { id?: string }) =>
    options?.id ?? "job-1");
  // pg-boss `send` is overloaded; the cast narrows the stub to the one shape the
  // executor uses while keeping `.mock` assertable.
  return { send } as unknown as HydrationBoss & { send: typeof send };
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

    // Filing changed nothing about execution: with the flag at request_only the
    // cycle has nothing to do, and it would have nothing to do anyway.
    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);
    expect(cycle.dispatched).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
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

  it("#13 approve -> the EXACT expected job is enqueued for the right thread and page", async () => {
    const { request } = await fileRequest();
    const decided = await approve(request);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().disposition).toBe("approved");
    expect(decided.json().request.state).toBe("approved");
    expect(decided.json().request.decision.maxCalls).toBe(5);

    // Still nothing: `request_only` decides but never executes.
    const idleBoss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, idleBoss)).dispatched).toBe(0);
    expect(idleBoss.send).not.toHaveBeenCalled();

    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);
    expect(cycle.dispatched).toBe(1);
    expect(boss.send).toHaveBeenCalledTimes(1);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    const [queue, payload, options] = boss.send.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(queue).toBe(TARGETED_THREAD_BACKFILL_QUEUE);
    // Not just "a payload was sent": the payload has to survive the parser the
    // worker actually runs it through, or the run refuses it as unusable.
    const parsed = parseTargetedThreadBackfillJob(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.threadId).toBe(fanslyThreadId);
    expect(payload.threadId).toBe(fanslyThreadId);
    // The owner's ceiling BINDS, and it is the SMALLER of the two numbers that
    // bound vendor requests on this lane (maxCalls 5, maxPages 4).
    expect(parsed!.maxRequests).toBe(4);
    // The depth cap is lifted for THIS run only — going deeper is what was
    // approved.
    expect(payload.ignoreRetentionLimit).toBe(true);
    expect(payload.hydrationRequestRef).toBe(request.requestRef);
    // The queue singleton is the PAGE: one targeted run per page at a time.
    expect(options.singletonKey).toBe(String(fanslyPageId));
    // The job id was minted BEFORE the claim and is what the request already
    // points at — there is no window where a dispatching row has no reference.
    expect(options.id).toBe(stored.request?.executionRef);

    expect(stored.request?.state).toBe("dispatching");
    expect(stored.request?.dispatchCount).toBe(1);
    expect(stored.request?.executionLane).toBe("vendor_paid_low");
  });

  it("#13 reject -> nothing is ever enqueued", async () => {
    const { request } = await fileRequest();
    const rejected = await ownerPost(
      `/api/v1/agent/hydration-requests/${request.requestRef}/decision`,
      {
        decision: "reject",
        expectedVersion: request.rowVersion,
        coverageFingerprint: request.coverageFingerprint,
        idempotencyKey: randomUUID(),
        reason: "not worth the egress quota",
      },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().request.state).toBe("rejected");

    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);
    expect(cycle.dispatched).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("a second decision is a 409 CAS conflict, never an overwrite", async () => {
    const { request } = await fileRequest();
    // The VERSION half of the CAS, on a request still in `requested`: a decision
    // formed against a version that no longer exists is refused even though the
    // state would have allowed it. Without this the state check alone would pass
    // a regression that dropped version checking entirely.
    const wrongVersion = await approve(request, { expectedVersion: request.rowVersion + 7 });
    expect(wrongVersion.statusCode).toBe(409);
    expect(wrongVersion.json().error).toBe("conflict");
    const untouched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(untouched.request?.state).toBe("requested");

    expect((await approve(request)).statusCode).toBe(200);
    // ... and the STATE half: same stale rowVersion, different idempotency key.
    const again = await approve(request);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("conflict");
  });

  it("replaying the SAME decision is already_decided, not a second decision", async () => {
    const { request } = await fileRequest();
    // A replay is the IDENTICAL body, expiry included: a different expiry is a
    // different decision, and the mismatch branch below proves the difference is
    // detected rather than swallowed.
    const replayable = {
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    };
    const first = await approve(request, replayable);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await approve(request, replayable);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().disposition).toBe("already_decided");

    // The same key with a DIFFERENT decision body is a mismatch, not a replay.
    const mutated = await approve(request, { ...replayable, maxCalls: 50 });
    expect(mutated.statusCode).toBe(409);
    expect(mutated.json().error).toBe("idempotency_mismatch");
  });

  it("a decision quoting a stale coverage fingerprint is 409, not an approval", async () => {
    const { request } = await fileRequest();
    const stale = await approve(request, { coverageFingerprint: "0".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("hydration_proposal_stale");
  });

  it("an approval must state the mark-read side effect and a cap and an expiry", async () => {
    const { request } = await fileRequest();
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
    const boss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(1);
    // The OnlyFans lane is a durable capture job, not a pg-boss send.
    expect(boss.send).not.toHaveBeenCalled();

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
    const { request } = await fileRequest();
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
        allowMarkReadSideEffect: false,
      };
      delete body[missing];
      const response = await ownerPost(
        `/api/v1/agent/hydration-requests/${request.requestRef}/decision`,
        body,
      );
      expect(response.statusCode, missing).toBe(400);
    }
  });

  it("a crashed run is swept to failed and needs a FRESH decision, never a retry", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    await runAgentHydrationCycle(appContext, boss);

    // The worker died: the request is dispatching and its deadline passes.
    await testDb!.pool.query(
      "update agent_hydration_requests set dispatch_deadline_at = now() - interval '1 minute'",
    );
    const secondBoss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, secondBoss);
    expect(cycle.swept).toBe(1);
    // NOT re-enqueued. One approval buys one attempt.
    expect(secondBoss.send).not.toHaveBeenCalled();

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("failed");
    expect(stored.request?.lastError).toBe("timeout");

    // A third cycle changes nothing: a failed request is terminal.
    const thirdBoss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, thirdBoss)).dispatched).toBe(0);
    expect(thirdBoss.send).not.toHaveBeenCalled();
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
    await runAgentHydrationCycle(appContext, stubBoss());
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
    await runAgentHydrationCycle(appContext, stubBoss());
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

  it("a backfill result settles the request that asked for it", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext, stubBoss());

    await settleAgentHydrationFromBackfill(appContext, request.requestRef, {
      outcome: "completed",
      threadId: fanslyThreadId,
      platformAccountId: fanslyPageId,
      syncRunId: 1,
      requests: 3,
      insertedMessages: 61,
      journaledMessages: 75,
      overlapFound: true,
      providerHistoryExhausted: false,
      storedMessageCountBefore: 12,
      oldestStoredMessageIdBefore: "m-100",
      messageCoverageStatus: "complete",
      retentionLimit: 200,
      projectionDebtRecorded: false,
    });

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("completed");
    expect(stored.request?.acceptedItems).toBe(61);

    // The append-only journal carries the whole life of the request.
    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "approved",
      "dispatched",
      "settled",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("an expired approval is never dispatched", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await testDb!.pool.query(
      "update agent_hydration_requests set expires_at = now() - interval '1 minute'",
    );
    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);
    expect(cycle.expired).toBe(1);
    expect(cycle.dispatched).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
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
    const boss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, boss)).mode).toBe("off");
    expect(boss.send).not.toHaveBeenCalled();
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
});
