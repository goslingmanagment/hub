import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureOfapiAttemptResponse,
  completeOfapiInteractiveRequest,
  createModel,
  createOfapiInteractiveRequest,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  createUser,
  getOfapiCaptureJob,
  getOfapiRequestAttempt,
  leaseNextOfapiCaptureJob,
  listRunnableOfapiCapturePages,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  releaseOfapiAttemptPreDispatch,
  recoverStaleOfapiCaptureWork,
  reserveOfapiRequestAttempt,
  resolveOfapiIndeterminateAttempt,
  setPageOfapiAccountId,
  settleOfapiCaptureParse,
} from "@agency_hub_core/db";

import { executeOfapiCaptureJobChunk } from "../apps/runtime/src/services/ofapi-capture-jobs.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

const NOW = new Date("2026-07-16T12:00:00.000Z");

async function seed() {
  const owner = await createUser(testDb!.db, {
    username: `owner-${randomUUID()}`,
    role: "owner",
    passwordHash: "x",
  });
  if (!owner) throw new Error("owner seed failed");
  const model = await createModel(testDb!.db, {
    slug: `capture-${randomUUID()}`,
    name: "Capture Test",
  });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(testDb!.db, {
    modelId: model.id,
    label: `capture-${randomUUID()}`,
  });
  if (!page) throw new Error("page seed failed");
  const accountId = `acct_${randomUUID()}`;
  await setPageOfapiAccountId(testDb!.db, {
    pageId: page.id,
    ofapiAccountId: accountId,
  });
  await testDb!.pool.query(`
    insert into ofapi_credit_state (
      id, spend_day, spent_credits, governed_scope_day,
      live_spent_credits, interactive_spent_credits, bulk_spent_credits,
      governed_unsettled_credits, last_balance, last_balance_at, updated_at
    ) values (1, $1::date, 0, $1::date, 0, 0, 0, 0, 1000, $2, $2)
    on conflict (id) do update set
      spend_day = excluded.spend_day,
      spent_credits = 0,
      governed_scope_day = excluded.governed_scope_day,
      live_spent_credits = 0,
      interactive_spent_credits = 0,
      bulk_spent_credits = 0,
      governed_unsettled_credits = 0,
      last_balance = 1000,
      last_balance_at = excluded.last_balance_at,
      updated_at = excluded.updated_at
  `, [NOW.toISOString().slice(0, 10), NOW]);
  return { owner, model, page, accountId };
}

async function createAndReserveInteractive(input?: {
  reservedCredits?: number;
  globalDailyCap?: number;
  scopeDailyCap?: number;
}) {
  const seeded = await seed();
  const request = await createOfapiInteractiveRequest(testDb!.db, {
    pageId: seeded.page.id,
    ofapiAccountId: seeded.accountId,
    principalUserId: seeded.owner.id,
    operation: "list_messages",
    surface: "messages",
    target: { path: `/api2/v2/chats/42/messages`, query: { limit: 20 } },
    now: NOW,
  });
  const reservation = await reserveOfapiRequestAttempt(testDb!.db, {
    ownerKind: "interactive_request",
    ownerId: request.id,
    pageId: seeded.page.id,
    ofapiAccountId: seeded.accountId,
    originPrincipalId: seeded.owner.id,
    budgetScope: "interactive",
    operation: "list_messages",
    endpointClass: "messages",
    egressKey: `page:${seeded.page.id}`,
    method: "GET",
    requestSemantics: "safe_read",
    requestShape: { path: `/api2/v2/chats/42/messages`, query: { limit: 20 } },
    surface: "messages",
    servingMode: "vendor_only",
    reservedCredits: input?.reservedCredits ?? 5,
    globalDailyCap: input?.globalDailyCap ?? 100,
    scopeDailyCap: input?.scopeDailyCap ?? 100,
    creditFloor: 10,
    balanceMaxAgeMs: 60 * 60 * 1000,
    principalCallCap: 100,
    principalCreditCap: 100,
    deadlineAt: new Date(NOW.getTime() + 60_000),
    now: NOW,
  });
  return { ...seeded, request, reservation };
}

function messagePage(input: {
  nextPage: string | null;
  shape?: "accepted" | "contract_drift";
  creditsUsed?: number;
}) {
  if (input.shape === "contract_drift") {
    return Buffer.from(JSON.stringify({ data: null, _pagination: { next_page: null } }));
  }
  return Buffer.from(JSON.stringify({
    data: [
      { id: "100", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z", text: "head" },
      { id: "99", isSentByMe: true, createdAt: "2026-07-16T11:58:00.000Z", text: "older" },
    ],
    _pagination: { next_page: input.nextPage },
    _meta: { _credits: { used: input.creditsUsed ?? 1, balance: 999 } },
  }));
}

async function createCaptureExecutionFixture(input: {
  bodyBytes: Buffer;
  maxCalls?: number;
  maxCredits?: number;
  maxPages?: number;
}) {
  const seeded = await seed();
  const now = new Date();
  await testDb!.pool.query(`
    update ofapi_credit_state
    set last_balance = 1000,
        last_balance_at = $1,
        updated_at = $1
    where id = 1
  `, [now]);

  const dispatchGovernedRaw = vi.fn(async (
    _context: unknown,
    request: { beforeDispatch: () => Promise<boolean> },
  ) => {
    if (!await request.beforeDispatch()) {
      throw new Error("durable dispatch fence was not acquired");
    }
    return {
      status: 200,
      bodyBytes: input.bodyBytes,
      headers: { "content-type": "application/json" },
      receivedAt: new Date(),
    };
  });
  const app = createTestAppContext(testDb!, {
    ofapi: { dispatchGovernedRaw } as never,
    ofapiMirrorBackgroundCaptureEnabled: true,
    ofapiDmDailyCreditBudget: 100,
    ofapiBackfillDailyCreditBudget: 100,
    ofapiCreditFloor: 10,
  });
  // The production route is intentionally proxy-bound. The test dispatcher
  // never opens this socket; it only exercises the same durable egress lookup.
  await saveProxy(app, seeded.page.id, { url: "http://127.0.0.1:65535" });
  const created = await createOrGetOfapiCaptureJob(testDb!.db, {
    pageId: seeded.page.id,
    ofapiAccountId: seeded.accountId,
    kind: "chat_paginate",
    goal: "history_to_exhaustion",
    activeSlotKey: `page:${seeded.page.id}:chat:42`,
    target: {
      chatId: "42",
      frozenHeadId: "100",
      anchorMessageId: null,
      limit: 100,
    },
    budgetScope: "bulk",
    createdBy: "owner",
    maxCalls: input.maxCalls ?? 1,
    maxCredits: input.maxCredits ?? 1,
    maxPages: input.maxPages ?? 5,
    now,
  });
  return { ...seeded, app, dispatchGovernedRaw, job: created.job };
}

describe("OFAPI capture correctness repository", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    if (testDb) await resetIntegrationDatabase(testDb.pool);
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("captures exact bytes and settles owner, observation, ledger, and counters once", async () => {
    if (!testDb) return;
    const seeded = await createAndReserveInteractive();
    expect(seeded.reservation.admitted).toBe(true);
    if (!seeded.reservation.admitted) return;

    const dispatches = await Promise.all([
      markOfapiAttemptDispatching(testDb.db, {
        attemptId: seeded.reservation.attemptId,
        fenceToken: seeded.reservation.fenceToken,
        now: new Date(NOW.getTime() + 1_000),
      }),
      markOfapiAttemptDispatching(testDb.db, {
        attemptId: seeded.reservation.attemptId,
        fenceToken: seeded.reservation.fenceToken,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ]);
    expect(dispatches.sort()).toEqual([false, true]);

    const bodyBytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    const captured = await captureOfapiAttemptResponse(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      responseObservedAt: new Date(NOW.getTime() + 2_000),
      httpStatus: 200,
      httpOutcome: "invalid_response",
      responseHeaders: { "content-type": "application/json" },
      bodyBytes,
      request: { method: "GET", path: "/api2/v2/chats/42/messages" },
      producer: "test",
      observationKind: "ofapi.response.v1",
      settledCredits: 3,
      balanceAfter: 997,
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(captured.duplicate).toBe(false);

    const duplicate = await captureOfapiAttemptResponse(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      responseObservedAt: new Date(NOW.getTime() + 2_000),
      httpStatus: 200,
      httpOutcome: "invalid_response",
      responseHeaders: { "content-type": "application/json" },
      bodyBytes,
      request: { method: "GET", path: "/api2/v2/chats/42/messages" },
      producer: "test",
      observationKind: "ofapi.response.v1",
      settledCredits: 3,
      balanceAfter: 997,
      now: new Date(NOW.getTime() + 4_000),
    });
    expect(duplicate).toMatchObject({ duplicate: true, observationId: captured.observationId });

    await expect(captureOfapiAttemptResponse(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      responseObservedAt: new Date(NOW.getTime() + 2_000),
      httpStatus: 200,
      httpOutcome: "invalid_response",
      responseHeaders: {},
      bodyBytes: Buffer.from("different"),
      request: { method: "GET", path: "/api2/v2/chats/42/messages" },
      producer: "test",
      observationKind: "ofapi.response.v1",
      now: new Date(NOW.getTime() + 5_000),
    })).rejects.toThrow(/different raw bytes/);

    expect(await completeOfapiInteractiveRequest(testDb.db, {
      requestId: seeded.request.id,
      attemptId: seeded.reservation.attemptId,
      outcome: "failed",
      parserOutcome: "contract_rejected",
      errorCode: "invalid_response",
      now: new Date(NOW.getTime() + 6_000),
    })).toBe(true);

    const observation = await testDb.pool.query<{
      account_id: string;
      native_account_ref: string;
      actor_principal_id: string;
      payload: { response: { bodyEncoding: string; body: string } };
    }>("select account_id, native_account_ref, actor_principal_id, payload from observations where id = $1", [
      captured.observationId,
    ]);
    expect(Number(observation.rows[0]?.account_id)).toBe(seeded.page.id);
    expect(observation.rows[0]?.native_account_ref).toBe(seeded.accountId);
    expect(Number(observation.rows[0]?.actor_principal_id)).toBe(seeded.owner.id);
    expect(observation.rows[0]?.payload.response).toEqual({
      bodyEncoding: "base64",
      body: bodyBytes.toString("base64"),
      headers: { "content-type": "application/json" },
      receivedAt: new Date(NOW.getTime() + 2_000).toISOString(),
      status: 200,
    });

    const ledger = await testDb.pool.query<{ credits: number; n: string }>(`
      select min(credits)::int as credits, count(*)::text as n
      from ofapi_credit_ledger where attempt_id = $1
    `, [seeded.reservation.attemptId]);
    expect(ledger.rows[0]).toMatchObject({ credits: 3, n: "1" });
    const credit = await testDb.pool.query<{
      spent_credits: number;
      interactive_spent_credits: number;
      governed_unsettled_credits: number;
      last_balance: number;
    }>("select * from ofapi_credit_state where id = 1");
    expect(credit.rows[0]).toMatchObject({
      spent_credits: 3,
      interactive_spent_credits: 3,
      governed_unsettled_credits: 0,
      last_balance: 997,
    });
  });

  it("denies before creating a physical attempt and aggregates the refusal", async () => {
    if (!testDb) return;
    const seeded = await createAndReserveInteractive({
      reservedCredits: 5,
      globalDailyCap: 4,
    });
    expect(seeded.reservation).toMatchObject({ admitted: false, reason: "global_cap" });
    const attempts = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from ofapi_request_attempts",
    );
    const denials = await testDb.pool.query<{ denied_count: string; reason: string }>(
      "select denied_count::text, reason from ofapi_budget_denial_daily",
    );
    expect(attempts.rows[0]?.n).toBe("0");
    expect(denials.rows).toEqual([{ denied_count: "1", reason: "global_cap" }]);
  });

  it("releases a pre-dispatch reservation without inventing a vendor attempt", async () => {
    if (!testDb) return;
    const seeded = await createAndReserveInteractive();
    expect(seeded.reservation.admitted).toBe(true);
    if (!seeded.reservation.admitted) return;
    expect(await releaseOfapiAttemptPreDispatch(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      reasonCode: "deadline_before_dispatch",
      now: new Date(NOW.getTime() + 1_000),
    })).toBe(true);
    const attempt = await getOfapiRequestAttempt(testDb.db, seeded.reservation.attemptId);
    expect(attempt).toMatchObject({ state: "released_pre_dispatch", credit_state: "released" });
    const credit = await testDb.pool.query<{
      spent_credits: number;
      interactive_spent_credits: number;
      governed_unsettled_credits: number;
    }>("select * from ofapi_credit_state where id = 1");
    expect(credit.rows[0]).toMatchObject({
      spent_credits: 0,
      interactive_spent_credits: 0,
      governed_unsettled_credits: 0,
    });
  });

  it("keeps indeterminate spend known to reconciliation and resolves it append-only", async () => {
    if (!testDb) return;
    const seeded = await createAndReserveInteractive();
    expect(seeded.reservation.admitted).toBe(true);
    if (!seeded.reservation.admitted) return;
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      now: new Date(NOW.getTime() + 1_000),
    })).toBe(true);
    expect(await markOfapiAttemptIndeterminate(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      fenceToken: seeded.reservation.fenceToken,
      outcome: "transport",
      now: new Date(NOW.getTime() + 2_000),
    })).toBe(true);

    const known = await testDb.pool.query<{ source: string; credits: number; estimated: boolean }>(`
      select source, credits, estimated
      from ofapi_credit_ledger
      where attempt_id = $1 and attempt_entry_phase = 'settlement'
    `, [seeded.reservation.attemptId]);
    expect(known.rows).toEqual([{ source: "rest", credits: 5, estimated: true }]);

    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: seeded.reservation.attemptId,
      resolution: "confirmed_not_billed",
      actorUserId: seeded.owner.id,
      reason: "vendor support confirmed no charge",
      now: new Date(NOW.getTime() + 3_000),
    })).toBe(true);
    const attempt = await getOfapiRequestAttempt(testDb.db, seeded.reservation.attemptId);
    expect(attempt).toMatchObject({
      state: "indeterminate",
      credit_state: "released",
      certainty_resolution: "confirmed_not_billed",
    });
    const ledger = await testDb.pool.query<{ source: string; credits: number }>(`
      select source, credits from ofapi_credit_ledger
      where attempt_id = $1 order by id
    `, [seeded.reservation.attemptId]);
    expect(ledger.rows).toEqual([
      { source: "rest", credits: 5 },
      { source: "adjustment", credits: -5 },
    ]);
  });

  it("coalesces only within a page and advances a job only after local parse", async () => {
    if (!testDb) return;
    const seeded = await seed();
    const target = { chatId: "same-chat", frozenHead: "100", maxPages: 5 };
    const first = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "bounded_tail",
      activeSlotKey: `page:${seeded.page.id}:chat:same-chat`,
      target,
      budgetScope: "live",
      createdBy: "product_signal",
      maxCalls: 5,
      maxCredits: 20,
      now: NOW,
    });
    const coalesced = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:same-chat`,
      target: { chatId: "same-chat", frozenHead: "newer" },
      budgetScope: "live",
      createdBy: "owner",
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(first.created).toBe(true);
    expect(coalesced.created).toBe(false);
    expect(coalesced.job.target).toEqual(target);

    const otherPage = await createOnlyFansPage(testDb.db, {
      modelId: seeded.model.id,
      label: `capture-other-${randomUUID()}`,
    });
    if (!otherPage) throw new Error("other page seed failed");
    const other = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: otherPage.id,
      ofapiAccountId: `acct_${randomUUID()}`,
      kind: "chat_paginate",
      goal: "bounded_tail",
      activeSlotKey: `page:${otherPage.id}:chat:same-chat`,
      target,
      budgetScope: "live",
      createdBy: "product_signal",
      now: NOW,
    });
    expect(other.created).toBe(true);

    const leased = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "worker-1",
      leaseTtlMs: 60_000,
      now: NOW,
    });
    expect(leased?.id).toBe(first.job.id);
    if (!leased?.leaseToken) throw new Error("lease missing");
    const reservation = await reserveOfapiRequestAttempt(testDb.db, {
      ownerKind: "capture_job",
      ownerId: leased.id,
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      budgetScope: "live",
      operation: "list_messages",
      endpointClass: "messages",
      egressKey: `page:${seeded.page.id}`,
      method: "GET",
      requestSemantics: "safe_read",
      requestShape: { chatId: "same-chat", firstId: null },
      reservedCredits: 2,
      globalDailyCap: 100,
      scopeDailyCap: 100,
      creditFloor: 10,
      balanceMaxAgeMs: 60 * 60 * 1000,
      jobLeaseToken: leased.leaseToken,
      deadlineAt: new Date(NOW.getTime() + 30_000),
      now: NOW,
    });
    expect(reservation.admitted).toBe(true);
    if (!reservation.admitted) return;
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      jobLeaseToken: leased.leaseToken,
      now: new Date(NOW.getTime() + 1_000),
    })).toBe(true);
    const captured = await captureOfapiAttemptResponse(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      responseObservedAt: new Date(NOW.getTime() + 2_000),
      httpStatus: 200,
      httpOutcome: "success",
      responseHeaders: { "content-type": "application/json" },
      bodyBytes: Buffer.from('{"list":[{"id":"99"}]}'),
      request: { chatId: "same-chat" },
      producer: "test",
      observationKind: "ofapi.response.v1",
      settledCredits: 1,
      balanceAfter: 999,
      now: new Date(NOW.getTime() + 3_000),
    });
    expect((await getOfapiCaptureJob(testDb.db, leased.id))?.state).toBe("awaiting_parse");
    expect(await settleOfapiCaptureParse(testDb.db, {
      jobId: leased.id,
      attemptId: reservation.attemptId,
      leaseToken: leased.leaseToken,
      observationId: captured.observationId,
      observationReceivedAt: captured.receivedAt,
      parserOutcome: "accepted",
      rawCount: 1,
      acceptedCount: 1,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "progress",
        cursor: { firstId: "99" },
        acceptedItems: 1,
      },
      now: new Date(NOW.getTime() + 4_000),
    })).toBe(true);
    expect(await getOfapiCaptureJob(testDb.db, leased.id)).toMatchObject({
      state: "ready",
      cursor: { firstId: "99" },
      acceptedItems: 1,
      zeroProgressCount: 0,
    });
  });

  it("captures a paid page before parsing and never calls the vendor again after capture", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });

    expect(await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).toMatchObject({
      kind: "success",
      jobId: fixture.job.id,
    });
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "awaiting_parse",
      dispatchCount: 1,
    });

    fixture.dispatchGovernedRaw.mockImplementation(async () => {
      throw new Error("captured response must be replayed locally");
    });
    expect(await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).toMatchObject({
      kind: "success",
      jobId: fixture.job.id,
    });
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
    const completed = await getOfapiCaptureJob(testDb.db, fixture.job.id);
    expect(completed).toMatchObject({
      state: "complete",
      dispatchCount: 1,
    });
    expect(completed?.terminalObservationId).not.toBeNull();
    const terminal = await testDb.pool.query<{ payload: Record<string, unknown> }>(`
      select payload from observations where id = $1
    `, [completed?.terminalObservationId]);
    expect(terminal.rows[0]?.payload).toMatchObject({
      classification: "continuous_history",
      pages: 1,
      parseDebt: 0,
    });
    const attempts = await testDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from ofapi_request_attempts
      where capture_job_id = $1
    `, [fixture.job.id]);
    expect(attempts.rows[0]?.count).toBe("1");
  });

  it("captures valid JSON contract drift but freezes the cursor and does not retry the vendor", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null, shape: "contract_drift" }),
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "contract_rejected",
      cursor: null,
      acceptedPages: 0,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("reconciles exact credits from the captured response after a process crash", async () => {
    if (!testDb) return;
    const seeded = await seed();
    const created = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:credit-replay`,
      target: { chatId: "credit-replay", frozenHeadId: "100", limit: 100 },
      budgetScope: "bulk",
      createdBy: "owner",
      maxCalls: 5,
      maxCredits: 5,
      maxPages: 5,
      now: NOW,
    });
    const leased = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "worker-before-crash",
      leaseTtlMs: 60_000,
      now: NOW,
    });
    if (!leased?.leaseToken) throw new Error("lease missing");
    const reservation = await reserveOfapiRequestAttempt(testDb.db, {
      ownerKind: "capture_job",
      ownerId: created.job.id,
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      budgetScope: "bulk",
      operation: "ofapi_capture_chat_messages",
      endpointClass: "chat_messages",
      egressKey: `page:${seeded.page.id}`,
      method: "GET",
      requestSemantics: "safe_read",
      requestShape: { chatId: "credit-replay", firstId: "100" },
      reservedCredits: 1,
      globalDailyCap: 100,
      scopeDailyCap: 100,
      creditFloor: 10,
      balanceMaxAgeMs: 60 * 60 * 1000,
      jobLeaseToken: leased.leaseToken,
      deadlineAt: new Date(NOW.getTime() + 30_000),
      now: NOW,
    });
    if (!reservation.admitted) throw new Error("attempt was not admitted");
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      jobLeaseToken: leased.leaseToken,
      now: new Date(NOW.getTime() + 1_000),
    })).toBe(true);
    await captureOfapiAttemptResponse(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      responseObservedAt: new Date(NOW.getTime() + 2_000),
      httpStatus: 200,
      httpOutcome: "success",
      responseHeaders: { "content-type": "application/json" },
      bodyBytes: messagePage({ nextPage: null, creditsUsed: 3 }),
      request: { chatId: "credit-replay", firstId: "100" },
      producer: "test-before-crash",
      observationKind: "ofapi.chat_messages_page.v1",
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "awaiting_parse",
      spentCredits: 1,
    });

    const app = createTestAppContext(testDb, {
      ofapiMirrorBackgroundCaptureEnabled: true,
      ofapiDmDailyCreditBudget: 100,
      ofapiBackfillDailyCreditBudget: 100,
      ofapiCreditFloor: 10,
    });
    expect(await executeOfapiCaptureJobChunk(app, seeded.page.id)).toMatchObject({
      kind: "success",
      jobId: created.job.id,
    });
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "complete",
      spentCredits: 3,
    });
    expect(await getOfapiRequestAttempt(testDb.db, reservation.attemptId)).toMatchObject({
      settled_credits: 3,
      credit_estimated: false,
    });
  });

  it("stops with an explicit gap when a non-terminal page reaches its hard bound", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: "vendor-next-page" }),
      maxPages: 1,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "gap_open",
      dispatchCount: 1,
    });
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("denies the next page before dispatch when the job credit cap is exhausted", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: "vendor-next-page" }),
      maxCalls: 5,
      maxCredits: 1,
      maxPages: 5,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "job_cap",
      attemptCount: 1,
      dispatchCount: 1,
      spentCredits: 1,
    });
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("parks an expired dispatch as indeterminate instead of reissuing it", async () => {
    if (!testDb) return;
    const seeded = await seed();
    const created = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:expired`,
      target: { chatId: "expired", frozenHeadId: "100" },
      budgetScope: "bulk",
      createdBy: "owner",
      maxCalls: 2,
      maxCredits: 2,
      maxPages: 2,
      now: NOW,
    });
    const leased = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "crashed-worker",
      leaseTtlMs: 1_000,
      now: NOW,
    });
    if (!leased?.leaseToken) throw new Error("lease missing");
    const reservation = await reserveOfapiRequestAttempt(testDb.db, {
      ownerKind: "capture_job",
      ownerId: created.job.id,
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      budgetScope: "bulk",
      operation: "list_messages",
      endpointClass: "messages",
      egressKey: `page:${seeded.page.id}`,
      method: "GET",
      requestSemantics: "safe_read",
      requestShape: { chatId: "expired", firstId: "100" },
      reservedCredits: 1,
      globalDailyCap: 100,
      scopeDailyCap: 100,
      creditFloor: 10,
      balanceMaxAgeMs: 60 * 60 * 1000,
      jobLeaseToken: leased.leaseToken,
      deadlineAt: new Date(NOW.getTime() + 30_000),
      now: NOW,
    });
    if (!reservation.admitted) throw new Error("attempt was not admitted");
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      jobLeaseToken: leased.leaseToken,
      now: new Date(NOW.getTime() + 500),
    })).toBe(true);

    expect(await recoverStaleOfapiCaptureWork(testDb.db, {
      now: new Date(NOW.getTime() + 2_000),
    })).toEqual({ released: 0, indeterminate: 1, requeued: 0 });
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
    });
    expect(await getOfapiRequestAttempt(testDb.db, reservation.attemptId)).toMatchObject({
      state: "indeterminate",
      credit_state: "indeterminate",
    });
    expect(await listRunnableOfapiCapturePages(testDb.db, {
      now: new Date(NOW.getTime() + 3_000),
    })).toEqual([]);
  });

  it("does not hot-loop an awaiting-parse job parked after parser failure", async () => {
    if (!testDb) return;
    const seeded = await seed();
    const created = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:parser-failed`,
      target: { chatId: "parser-failed", frozenHeadId: "100" },
      budgetScope: "bulk",
      createdBy: "owner",
      maxCalls: 1,
      maxCredits: 1,
      maxPages: 1,
      now: NOW,
    });
    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'awaiting_parse', reason_code = 'parser_failed'
      where id = $1
    `, [created.job.id]);

    expect(await listRunnableOfapiCapturePages(testDb.db, { now: NOW })).toEqual([]);
    expect(await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "must-not-run",
      leaseTtlMs: 60_000,
      now: NOW,
    })).toBeNull();
  });
});
