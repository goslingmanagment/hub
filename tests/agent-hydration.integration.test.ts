import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
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
  ensureTargetedThreadBackfillQueue,
  parseTargetedThreadBackfillJob,
  sendTargetedThreadBackfillJob,
  TARGETED_THREAD_BACKFILL_QUEUE,
  type TargetedThreadBackfillResult,
} from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
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
  const { rows: threadRows } = await pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, $2, $3, '438766025723355136', 12, 'partial_window', '2026-03-02T00:00:00Z',
       'm-100', 'm-112', 'm-112') returning id`,
    [fanslyPageId, fanId, CONVERSATION_REF],
  );
  fanslyThreadId = Number(threadRows[0]!.id);
  // Stored messages, so an approved `beforeAt` boundary has something to resolve
  // against: the oldest message at or after the instant is the cursor to page
  // back from.
  await pool.query(
    `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id,
       sender_platform_user_id, sender_role, created_at, content)
     values
       ($1, $2, 'm-100', '438766025723355136', 'fan', '2026-02-10T00:00:00Z', 'older'),
       ($1, $2, 'm-106', '438766025723355136', 'fan', '2026-02-20T00:00:00Z', 'boundary'),
       ($1, $2, 'm-112', '438766025723355136', 'fan', '2026-03-01T00:00:00Z', 'newest')`,
    [fanslyThreadId, fanslyPageId],
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
  // The page-slot probe: an empty queue. Tests about the slot itself run a real
  // pg-boss (`startRealBoss`), because the `exclusive` policy is the behaviour
  // under test and a stub would only restate the assumption.
  const findJobs = vi.fn(async () => []);
  // pg-boss `send` is overloaded; the cast narrows the stub to the one shape the
  // executor uses while keeping `.mock` assertable.
  return { send, findJobs } as unknown as HydrationBoss & { send: typeof send };
}

/** A real pg-boss on the test database with the targeted-backfill queue created
 *  exactly as the worker creates it. No worker is attached: a sent job stays
 *  `created` and holds its page's slot until the test frees it. */
async function startRealBoss() {
  const boss = new PgBoss({ connectionString: testDb!.connectionString });
  await boss.start();
  await ensureTargetedThreadBackfillQueue(boss);
  return boss;
}

/** Another visible Fansly thread on the fixture page, same fan. */
async function seedFanslyThread(conversationRef: string, pageId = fanslyPageId) {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
       partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
       oldest_stored_message_id, newest_stored_message_id, last_message_id)
     values ($1, (select fan_id from page_dm_threads where id = $2), $3,
       '438766025723355136', 3, 'partial_window', '2026-03-02T00:00:00Z', 's-1', 's-3', 's-3')
     returning id`,
    [pageId, fanslyThreadId, conversationRef],
  );
  return Number(rows[0]!.id);
}

/** A targeted run that refused before its first vendor request. */
function refusedRun(outcome: TargetedThreadBackfillResult["outcome"]): TargetedThreadBackfillResult {
  return {
    outcome,
    threadId: fanslyThreadId,
    platformAccountId: fanslyPageId,
    syncRunId: null,
    requests: 0,
    insertedMessages: 0,
    journaledMessages: 0,
    overlapFound: false,
    providerHistoryExhausted: false,
    storedMessageCountBefore: 12,
    oldestStoredMessageIdBefore: null,
    messageCoverageStatus: null,
    retentionLimit: null,
    projectionDebtRecorded: false,
  };
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

  it("the approved BOUNDARY reaches the lane, not a generic walk (P1-1)", async () => {
    // An approval says "deepen PAST this message". If the boundary never reaches
    // the job, the vendor spend AND the completeness verdict describe a
    // different scope than the one the owner authorized.
    const { request } = await fileRequest("lora-2", CONVERSATION_REF, {
      target: { kind: "thread_backfill_before", beforeMessageRef: "m-106" },
    });
    await approve(request, { maxItems: 40 });
    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(1);
    const payload = boss.send.mock.calls[0]![1] as Record<string, unknown>;
    const parsed = parseTargetedThreadBackfillJob(payload);
    expect(parsed!.startBeforeMessageRef).toBe("m-106");
    // The item ceiling travels too, or an explicit item cap is unenforceable on
    // a lane whose every request accepts up to 25 messages.
    expect(parsed!.maxItems).toBe(40);
  });

  it("a `beforeAt` boundary resolves to the message the walk starts before (P1-1)", async () => {
    const { request } = await fileRequest("lora-2", CONVERSATION_REF, {
      target: { kind: "thread_backfill_before", beforeAt: "2026-02-15T00:00:00Z" },
    });
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    await runAgentHydrationCycle(appContext, boss);
    const payload = boss.send.mock.calls[0]![1] as Record<string, unknown>;
    // The oldest stored message at or after the instant — not the thread's
    // deepest message, which is what a generic walk would have used.
    expect(payload.startBeforeMessageRef).toBe("m-106");
  });

  it("the OnlyFans job freezes its head at the approved boundary (P1-1)", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF, {
      target: { kind: "thread_backfill_before", beforeMessageRef: "of-3" },
    });
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    await runAgentHydrationCycle(appContext, stubBoss());
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    const { rows } = await testDb!.pool.query<{ target: Record<string, unknown> }>(
      "select target from ofapi_capture_jobs where id = $1::uuid",
      [stored.request?.executionRef],
    );
    // NOT the thread's own last message id: the approved boundary.
    expect(rows[0]!.target.frozenHeadId).toBe("of-3");
  });

  it("coverage is recomputed at decision time, not compared with itself (P1-2)", async () => {
    const { request } = await fileRequest();
    // Somebody deepened the thread between the filing and the decision: the
    // owner would now be paying for history we already hold. The old check
    // compared the request's own stored fingerprint with the echoed copy and
    // could never see this.
    await testDb!.pool.query(
      `update page_dm_threads set stored_message_count = 900, oldest_stored_message_id = 'm-1'
       where id = $1`,
      [fanslyThreadId],
    );
    const stale = await approve(request);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("hydration_proposal_stale");
  });

  it("dispatch refuses when coverage moved after the decision, WITHOUT burning the attempt (P1-2)", async () => {
    const { request } = await fileRequest();
    expect((await approve(request)).statusCode).toBe(200);
    await testDb!.pool.query(
      "update page_dm_threads set stored_message_count = 900 where id = $1",
      [fanslyThreadId],
    );
    await setFlag("agentHydrationMode", "dispatch");
    const boss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
    // Still approved: the attempt was NOT consumed, so the owner keeps the
    // decision and it closes by expiry rather than by a spurious failure.
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("approved");
    expect(stored.request?.dispatchCount).toBe(0);
  });

  it("a missing OFAPI mapping does not consume the approval (P2b)", async () => {
    await testDb!.pool.query("update pages set ofapi_account_id = null where id = $1", [
      onlyfansPageId,
    ]);
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await approve(request, { allowMarkReadSideEffect: true });
    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext, stubBoss())).dispatched).toBe(0);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("approved");
    expect(stored.request?.dispatchCount).toBe(0);
    const { rows } = await testDb!.pool.query("select id from ofapi_capture_jobs");
    expect(rows).toHaveLength(0);
  });

  it("an INDETERMINATE send is left dispatching, never marked failed (P1-4)", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");
    // The send threw after possibly landing: the job may be running right now.
    const flaky = {
      send: vi.fn(async () => {
        throw new Error("connection reset after the insert");
      }),
      findJobs: vi.fn(async () => []),
    } as unknown as Parameters<typeof runAgentHydrationCycle>[1];
    expect((await runAgentHydrationCycle(appContext, flaky)).dispatched).toBe(0);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // NOT failed. Settling here would let the owner authorize the same paid work
    // a second time while the first copy is still going.
    expect(stored.request?.state).toBe("dispatching");
    expect(stored.request?.executionRef).not.toBeNull();
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
    await runAgentHydrationCycle(appContext, stubBoss());

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
    await runAgentHydrationCycle(appContext, stubBoss());
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

    await runAgentHydrationCycle(appContext, stubBoss());
    const settled = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // The real outcome and the real spend, not `failed/timeout` with zeroes.
    expect(settled.request?.state).toBe("partially_completed");
    expect(settled.request?.lastError).toBe("budget_exhausted");
    expect(settled.request?.acceptedItems).toBe(250);
    expect(settled.request?.spentCredits).toBe(3);
  });

  it("state never moves without its journal entry (P1-3)", async () => {
    const { request } = await fileRequest();
    await approve(request);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    // Every version the row has ever had is accounted for by an event, and the
    // events are in the order the transitions happened.
    expect(events.map((event) => event.rowVersion)).toEqual([0, stored.request!.rowVersion]);
    expect(events.map((event) => event.toState)).toEqual(["requested", "approved"]);
  });

  it("an expired request cannot be decided even before the sweeper sees it (P2f)", async () => {
    const { request } = await fileRequest();
    await testDb!.pool.query(
      "update agent_hydration_requests set expires_at = now() - interval '1 minute'",
    );
    const late = await approve(request);
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

  it("two approvals on one Fansly page: ONE is dispatched, the other waits with its attempt unspent", async () => {
    // Production 2026-09-27..29: the targeted queue is `exclusive` on a PAGE
    // singletonKey, so a second same-page send returns null — and the executor
    // had already claimed the approval's single attempt, so 121 approvals ended
    // `failed/vendor_unavailable` 10-20 ms after dispatch without a Fansly call.
    await seedFanslyThread("second-thread-ref");
    const first = (await fileRequest()).request;
    const second = (await fileRequest("lora-2", "second-thread-ref")).request;
    expect((await approve(first)).statusCode).toBe(200);
    expect((await approve(second)).statusCode).toBe(200);
    await setFlag("agentHydrationMode", "dispatch");

    const boss = await startRealBoss();
    try {
      const cycle = await runAgentHydrationCycle(appContext, boss);
      expect(cycle.dispatched).toBe(1);

      const dispatched = await findAgentHydrationRequestByRef(testDb!.db, first.requestRef);
      expect(dispatched.request?.state).toBe("dispatching");
      const waiting = await findAgentHydrationRequestByRef(testDb!.db, second.requestRef);
      expect(waiting.request?.state).toBe("approved");
      expect(waiting.request?.dispatchCount).toBe(0);
      expect(waiting.request?.lastError).toBe("none");

      // It keeps waiting while the page's slot is held, and nothing piles up
      // behind the slot either: the queue holds exactly the one job.
      await runAgentHydrationCycle(appContext, boss);
      const stillWaiting = await findAgentHydrationRequestByRef(testDb!.db, second.requestRef);
      expect(stillWaiting.request?.state).toBe("approved");
      expect(stillWaiting.request?.dispatchCount).toBe(0);
      const jobs = await boss.findJobs(TARGETED_THREAD_BACKFILL_QUEUE, { key: String(fanslyPageId) });
      expect(jobs).toHaveLength(1);
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("a targeted job already holding the page's slot keeps an approval waiting, not failed", async () => {
    // The slot can be taken by work the hydration table knows nothing about —
    // the owner's `dm backfill-thread` CLI sends to the same queue and key.
    const otherThreadId = await seedFanslyThread("cli-thread-ref");
    const { request } = await fileRequest();
    expect((await approve(request)).statusCode).toBe(200);
    await setFlag("agentHydrationMode", "dispatch");

    const boss = await startRealBoss();
    try {
      const cliJob = await sendTargetedThreadBackfillJob(boss, {
        threadId: otherThreadId,
        platformAccountId: fanslyPageId,
      });
      expect(cliJob).not.toBeNull();

      expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(0);
      const waiting = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
      expect(waiting.request?.state).toBe("approved");
      expect(waiting.request?.dispatchCount).toBe(0);
      expect(waiting.request?.lastError).toBe("none");

      // Once the slot is free, the SAME approval runs.
      await boss.cancel(TARGETED_THREAD_BACKFILL_QUEUE, cliJob!);
      expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(1);
      const dispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
      expect(dispatched.request?.state).toBe("dispatching");
      expect(dispatched.request?.dispatchCount).toBe(1);
    } finally {
      await boss.stop();
    }
  }, 30_000);

  it("a run refused before its first vendor request re-arms the approval instead of failing it", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");
    expect((await runAgentHydrationCycle(appContext, stubBoss())).dispatched).toBe(1);
    const firstRun = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);

    // Another stream of the page was mid-chunk: zero Fansly requests were made.
    await settleAgentHydrationFromBackfill(appContext, request.requestRef, refusedRun("page_busy"));

    const rearmed = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // Not `failed/vendor_unavailable`: the vendor was never asked, and the
    // approval's one VENDOR attempt is still unspent.
    expect(rearmed.request?.state).toBe("approved");
    expect(rearmed.request?.lastError).toBe("none");
    expect(rearmed.request?.executionRef).toBeNull();
    const events = await listAgentHydrationEvents(testDb!.db, rearmed.request!.id);
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "approved",
      "dispatched",
      "rearmed",
    ]);
    const rearmEvent = events.at(-1)!;
    expect(rearmEvent.fromState).toBe("dispatching");
    expect(rearmEvent.toState).toBe("approved");
    expect(rearmEvent.detail.cause).toBe("page_busy");
    // The row forgets the refused job; the journal keeps the reference.
    expect(rearmEvent.detail.executionRef).toBe(firstRun.request?.executionRef);

    // The next cycle dispatches it again.
    const boss = stubBoss();
    expect((await runAgentHydrationCycle(appContext, boss)).dispatched).toBe(1);
    const redispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(redispatched.request?.state).toBe("dispatching");
    expect(redispatched.request?.dispatchCount).toBe(2);
  });

  it("re-arming is capped: a page that never frees ends failed/timeout, never vendor_unavailable", async () => {
    const { request } = await fileRequest();
    await approve(request);
    await setFlag("agentHydrationMode", "dispatch");

    const refusals = [
      "page_busy",
      "lease_unavailable",
      "thread_checkpoint_in_progress",
      "page_busy",
    ] as const;
    for (const [index, outcome] of refusals.entries()) {
      expect((await runAgentHydrationCycle(appContext, stubBoss())).dispatched, `run ${index + 1}`)
        .toBe(1);
      await settleAgentHydrationFromBackfill(appContext, request.requestRef, refusedRun(outcome));
    }

    // Three re-arms, then the fourth refusal settles. `timeout` — the page never
    // freed within the attempts — rather than blaming a vendor nobody called.
    const settled = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(settled.request?.state).toBe("failed");
    expect(settled.request?.lastError).toBe("timeout");
    expect(settled.request?.dispatchCount).toBe(4);
    const events = await listAgentHydrationEvents(testDb!.db, settled.request!.id);
    expect(events.filter((event) => event.kind === "rearmed")).toHaveLength(3);
    expect(events.at(-1)?.detail.cause).toBe("page_busy");

    // A refusal that is not transient still fails on the spot.
    const other = (await fileRequest("lora-2", CONVERSATION_REF, { idempotencyKey: randomUUID() }))
      .request;
    await approve(other);
    await runAgentHydrationCycle(appContext, stubBoss());
    await settleAgentHydrationFromBackfill(
      appContext,
      other.requestRef,
      refusedRun("thread_not_eligible"),
    );
    const ineligible = await findAgentHydrationRequestByRef(testDb!.db, other.requestRef);
    expect(ineligible.request?.state).toBe("failed");
    expect(ineligible.request?.dispatchCount).toBe(1);
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

describe("[sync-critical] hydration autopilot (decision #202)", () => {
  /**
   * The policy the owner delegated ONE act to: authorizing a single bounded
   * Fansly thread-deepening attempt inside a daily reserved-call budget.
   *
   * Every test here answers "what may this policy NEVER do", because that is
   * where the delegation's whole safety lives. A request the policy may not
   * decide must be LEFT for the owner — never rejected on their behalf, which
   * would silently answer a question they were meant to answer.
   */

  async function autopilot(mode: "shadow" | "enforce", budget: number) {
    await setFlag("agentHydrationMode", "dispatch");
    await setFlag("agentHydrationAutoApproveMode", mode);
    await setFlag("agentHydrationAutoDailyCallBudget", budget);
  }

  it("shadow decides NOTHING: it reports what it would do and leaves the row alone", async () => {
    const { request } = await fileRequest();
    await autopilot("shadow", 200);

    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);

    expect(cycle.autoApprove?.mode).toBe("shadow");
    expect(cycle.autoApprove?.approved).toBe(1);
    expect(cycle.autoApprove?.reservedCalls).toBe(5);
    expect(cycle.dispatched).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("requested");
    expect(stored.request?.decisionSource).toBeNull();
    // Nothing was journaled either: a shadow pass is an observation, not history.
    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    expect(events.map((event) => event.kind)).toEqual(["created"]);
  });

  it("enforce approves as auto_policy and dispatches within the SAME cycle", async () => {
    const { request } = await fileRequest();
    await autopilot("enforce", 200);

    const boss = stubBoss();
    const cycle = await runAgentHydrationCycle(appContext, boss);
    expect(cycle.autoApprove?.approved).toBe(1);
    expect(cycle.dispatched).toBe(1);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("dispatching");
    // The decision names its author. No fabricated owner: `decided_by_user_id`
    // stays null, and the policy version travels with the row.
    expect(stored.request?.decisionSource).toBe("auto_policy");
    expect(stored.request?.decidedByUserId).toBeNull();
    expect(stored.request?.decisionPolicyVersion).toBe(1);
    // The two caps the policy is NEVER allowed to widen.
    expect(stored.request?.decisionAllowMarkRead).toBe(false);
    expect(stored.request?.decisionMaxCalls).toBeLessThanOrEqual(40);

    const events = await listAgentHydrationEvents(testDb!.db, stored.request!.id);
    const approved = events.find((event) => event.kind === "approved");
    expect(approved?.actor).toBe("auto_policy");
    expect(approved?.detail.decisionSource).toBe("auto_policy");
    expect(approved?.detail.policyVersion).toBe(1);
  });

  it("clamps an agent's own ceiling to the policy maximum", async () => {
    const { request } = await fileRequest("lora-2", CONVERSATION_REF, { maxCalls: 200 });
    await autopilot("enforce", 200);
    await runAgentHydrationCycle(appContext, stubBoss());

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // 200 asked, 40 granted: the policy's per-request bound is not negotiable
    // by the caller who benefits from widening it.
    expect(stored.request?.decisionMaxCalls).toBe(40);
  });

  it("an over-budget request is LEFT for the owner, never auto-rejected", async () => {
    const { request } = await fileRequest("lora-2", CONVERSATION_REF, { maxCalls: 30 });
    await autopilot("enforce", 10);

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    expect(cycle.autoApprove?.skippedBudget).toBe(1);
    expect(cycle.autoApprove?.approved).toBe(0);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("requested");
    expect(stored.request?.decisionSource).toBeNull();
  });

  it("a zero budget keeps enforce inert", async () => {
    await fileRequest();
    await autopilot("enforce", 0);
    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    expect(cycle.autoApprove?.approved).toBe(0);
    expect(cycle.dispatched).toBe(0);
  });

  it("today's reservations are spent, not forgotten: a second pass sees less budget", async () => {
    await fileRequest("lora-2", CONVERSATION_REF, { maxCalls: 40 });
    await autopilot("enforce", 45);
    const first = await runAgentHydrationCycle(appContext, stubBoss());
    expect(first.autoApprove?.approved).toBe(1);
    expect(first.autoApprove?.reservedCalls).toBe(40);

    // A different thread, so the per-conversation and per-page guards are not
    // what refuses it: only 5 calls remain of today's 45.
    const pool = testDb!.pool;
    const { rows } = await pool.query<{ id: string }>(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id,
         partner_platform_user_id, stored_message_count, message_coverage_status, last_message_at,
         oldest_stored_message_id, newest_stored_message_id, last_message_id)
       values ($1, (select fan_id from page_dm_threads where id = $2), 'second-thread-ref',
         '438766025723355136', 3, 'partial_window', '2026-03-02T00:00:00Z', 's-1', 's-3', 's-3')
       returning id`,
      [fanslyPageId, fanslyThreadId],
    );
    expect(rows).toHaveLength(1);
    // Settle the first run: otherwise the one-live-approval-per-page guard is
    // what refuses the next request, and the budget carry-over stays untested.
    await pool.query(
      `update agent_hydration_requests set state = 'completed', settled_at = now()
       where state = 'dispatching'`,
    );
    await fileRequest("lora-2", "second-thread-ref", { maxCalls: 40 });

    const second = await runAgentHydrationCycle(appContext, stubBoss());
    expect(second.autoApprove?.budgetRemaining).toBe(5);
    expect(second.autoApprove?.skippedBudget).toBe(1);
    expect(second.autoApprove?.approved).toBe(0);
  });

  it("never touches OnlyFans: its lane's read marks a fan's thread read", async () => {
    const { request } = await fileRequest("lora-of", OF_CONVERSATION_REF);
    await autopilot("enforce", 200);

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    // Not even CONSIDERED — the candidate query excludes the platform, so the
    // policy cannot consent to the mark-read side effect for the owner.
    expect(cycle.autoApprove?.considered).toBe(0);

    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(stored.request?.state).toBe("requested");
  });

  it("skips a page whose dm stream is auth-parked", async () => {
    await fileRequest();
    // Real sync-state rows, then parked exactly as pausePageSyncForAuth parks
    // them — the state the targeted backfill now writes on a 401.
    await ensurePageSyncStates(testDb!.db, { pageId: fanslyPageId });
    const parked = await testDb!.pool.query(
      `update page_sync_states set status = 'paused', blocker_kind = 'auth',
         blocker_code = 'credentials_invalid', blocked_at = now()
       where page_id = $1 and stream = 'dm_messages'`,
      [fanslyPageId],
    );
    expect(parked.rowCount).toBe(1);
    await autopilot("enforce", 200);

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    // A dead session would burn the budget on requests that cannot succeed.
    expect(cycle.autoApprove?.considered).toBe(0);
    expect(cycle.autoApprove?.approved).toBe(0);
  });

  it("ignores a revoked key's parked wishes", async () => {
    await fileRequest();
    await testDb!.pool.query(
      `update agent_keys set revoked_at = now() where key_prefix = $1`,
      [TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6)],
    );
    await autopilot("enforce", 200);

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    expect(cycle.autoApprove?.considered).toBe(0);
  });

  it("one live approval per page at a time", async () => {
    await fileRequest();
    await autopilot("enforce", 200);
    // First pass approves and dispatches; the row is now `dispatching`.
    expect((await runAgentHydrationCycle(appContext, stubBoss())).autoApprove?.approved).toBe(1);

    await fileRequest("lora-2", CONVERSATION_REF, { idempotencyKey: randomUUID() });
    const second = await runAgentHydrationCycle(appContext, stubBoss());
    expect(second.autoApprove?.considered).toBe(0);
  });

  it("one pass approves at most ONE request per page, and still reaches every page", async () => {
    // Production 2026-09-27..29: the live-approval guard was evaluated once per
    // candidate batch, so one pass approved up to ten requests on the SAME page
    // and all but one of them could never run.
    await seedFanslyThread("second-thread-ref");
    await seedFanslyThread("third-thread-ref");
    const { rows: modelRows } = await testDb!.pool.query<{ model_id: string }>(
      "select model_id from pages where id = $1",
      [fanslyPageId],
    );
    const otherPage = await createFanslyPage(testDb!.db, {
      modelId: Number(modelRows[0]!.model_id),
      label: "lora-3",
    });
    await testDb!.pool.query(
      "update agent_keys set page_ids = array_append(page_ids, $1::bigint) where key_prefix = $2",
      [otherPage!.id, TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6)],
    );
    await seedFanslyThread("other-page-thread-ref", otherPage!.id);

    const oldest = (await fileRequest()).request;
    await fileRequest("lora-2", "second-thread-ref");
    await fileRequest("lora-2", "third-thread-ref");
    const otherPageRequest = (await fileRequest("lora-3", "other-page-thread-ref")).request;
    await autopilot("enforce", 200);

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    // One per page: lora-2's OLDEST request and lora-3's — not three of lora-2's.
    expect(cycle.autoApprove?.approved).toBe(2);
    expect(cycle.autoApprove?.reservedCalls).toBe(10);
    expect(cycle.dispatched).toBe(2);
    const { rows } = await testDb!.pool.query<{ request_ref: string; state: string }>(
      "select request_ref::text, state from agent_hydration_requests order by id",
    );
    const decided = rows.filter((row) => row.state !== "requested").map((row) => row.request_ref);
    expect(decided.sort()).toEqual([oldest.requestRef, otherPageRequest.requestRef].sort());
    expect(rows.filter((row) => row.state === "requested")).toHaveLength(2);
  });

  it("an auto-approval that ended without a vendor call gives its reservation back", async () => {
    // Decision #202 reserves maxCalls at decision time. A reservation for work
    // that is KNOWN not to have touched the vendor — a refused run, an approval
    // that expired unstarted — is returned; a run that may have spent (the
    // stuck sweeper's `timeout`) keeps it.
    await seedFanslyThread("second-thread-ref");
    await seedFanslyThread("third-thread-ref");
    const first = (await fileRequest("lora-2", CONVERSATION_REF, { maxCalls: 40 })).request;
    await autopilot("enforce", 80);
    expect((await runAgentHydrationCycle(appContext, stubBoss())).autoApprove?.reservedCalls)
      .toBe(40);

    // The run refused on a stable condition before its first request.
    await settleAgentHydrationFromBackfill(
      appContext,
      first.requestRef,
      refusedRun("thread_not_eligible"),
    );
    const refused = await findAgentHydrationRequestByRef(testDb!.db, first.requestRef);
    expect(refused.request?.state).toBe("failed");
    expect(refused.request?.acceptedPages).toBe(0);

    await fileRequest("lora-2", "second-thread-ref", { maxCalls: 40 });
    const second = await runAgentHydrationCycle(appContext, stubBoss());
    expect(second.autoApprove?.approved).toBe(1);
    // All 80 were available again; 40 remain after this approval.
    expect(second.autoApprove?.budgetRemaining).toBe(40);

    // The second run's worker died: the sweeper settles it `timeout`, and the
    // spend it may have made stays counted.
    await testDb!.pool.query(
      `update agent_hydration_requests set dispatch_deadline_at = now() - interval '1 minute'
       where state = 'dispatching'`,
    );
    await fileRequest("lora-2", "third-thread-ref", { maxCalls: 40 });
    const third = await runAgentHydrationCycle(appContext, stubBoss());
    expect(third.swept).toBe(1);
    expect(third.autoApprove?.approved).toBe(1);
    expect(third.autoApprove?.budgetRemaining).toBe(0);
  });

  it("leaving enforce PARKS approvals the policy already made", async () => {
    const { request } = await fileRequest();
    await autopilot("enforce", 200);
    // Approve, but keep the dispatch from happening in the same pass by making
    // the executor see the policy already switched off afterwards.
    const boss = stubBoss();
    await runAgentHydrationCycle(appContext, boss);
    const dispatched = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    expect(dispatched.request?.state).toBe("dispatching");

    // A SECOND request, auto-approved, then the switch flips before its dispatch.
    await testDb!.pool.query(
      `update agent_hydration_requests set state = 'approved', dispatched_at = null,
         dispatch_deadline_at = null, execution_ref = null, dispatch_count = 0
       where request_ref = $1`,
      [request.requestRef],
    );
    await setFlag("agentHydrationAutoApproveMode", "shadow");

    const held = await runAgentHydrationCycle(appContext, stubBoss());
    expect(held.autoHeld).toBe(1);
    expect(held.dispatched).toBe(0);
    const stored = await findAgentHydrationRequestByRef(testDb!.db, request.requestRef);
    // Still authorized, simply not started: re-entering enforce resumes it.
    expect(stored.request?.state).toBe("approved");
  });

  it("the owner's own decisions still dispatch while the policy is off", async () => {
    const { request } = await fileRequest();
    await setFlag("agentHydrationMode", "dispatch");
    await setFlag("agentHydrationAutoApproveMode", "off");
    const decided = await approve(request);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().request.decision.decisionSource).toBe("owner");

    const cycle = await runAgentHydrationCycle(appContext, stubBoss());
    expect(cycle.autoApprove).toBeNull();
    expect(cycle.dispatched).toBe(1);
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
