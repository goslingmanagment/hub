import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveBlockedOfapiExportPilotJob,
  cancelBlockedOfapiExportQuoteJob,
  captureOfapiAttemptResponse,
  completeOfapiInteractiveRequest,
  createModel,
  createOfapiInteractiveRequest,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  createUser,
  evaluateOfapiHistoryCoverage,
  getComposableOfapiMessageCoverageProof,
  getOfapiCaptureJob,
  getOfapiCaptureOperatorStatus,
  getOfapiRequestAttempt,
  insertObservation,
  leaseNextOfapiCaptureJob,
  listRunnableOfapiCapturePages,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  OFAPI_CAPTURE_PARSER_VERSION,
  OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION,
  releaseOfapiAttemptPreDispatch,
  recoverStaleOfapiCaptureWork,
  replayOfapiCaptureJobParse,
  resetOfapiMessageCoverageProjection,
  reserveOfapiRequestAttempt,
  resolveOfapiIndeterminateAttempt,
  revokeOfapiMessageCoverage,
  setPageOfapiAccountId,
  setOfapiCaptureControl,
  settleOfapiCaptureParse,
} from "@agency_hub_core/db";

import { executeOfapiCaptureJobChunk } from "../apps/runtime/src/services/ofapi-capture-jobs.ts";
import {
  OFAPI_CAPTURE_MATERIALIZER_VERSION,
  runOfapiCaptureMaterialization,
} from "../apps/runtime/src/services/ofapi-capture-materialization.ts";
import { OfapiGovernedRequestError } from "../apps/runtime/src/services/ofapi.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  runOfapiMessageCoverageProjection,
} from "../apps/runtime/src/services/projections/ofapi-message-coverage.ts";
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
  requireFreshStorageHealth?: boolean;
  storageHealth?: {
    healthy: boolean;
    breached: boolean;
    checkedAt: Date;
    error?: string | null;
  };
}) {
  const seeded = await seed();
  if (input?.storageHealth) {
    const failure = input.storageHealth.error != null;
    await testDb!.pool.query(`
      insert into ofapi_storage_health_state (
        id, healthy, breached, checked_at,
        used_bytes, free_bytes, total_bytes, error, updated_at
      ) values (1, $1, $2, $3, $4, $5, $6, $7, $3)
      on conflict (id) do update set
        healthy = excluded.healthy,
        breached = excluded.breached,
        checked_at = excluded.checked_at,
        used_bytes = excluded.used_bytes,
        free_bytes = excluded.free_bytes,
        total_bytes = excluded.total_bytes,
        error = excluded.error,
        updated_at = excluded.updated_at
    `, [
      input.storageHealth.healthy,
      input.storageHealth.breached,
      input.storageHealth.checkedAt,
      failure ? null : 80,
      failure ? null : 20,
      failure ? null : 100,
      input.storageHealth.error ?? null,
    ]);
  }
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
    ...(input?.requireFreshStorageHealth === undefined
      ? {}
      : { requireFreshStorageHealth: input.requireFreshStorageHealth }),
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
  maxItems?: number;
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
    maxItems: input.maxItems ?? null,
    now,
  });
  return { ...seeded, app, dispatchGovernedRaw, job: created.job };
}

async function createExportQuoteExecutionFixture(
  dispatchGovernedRaw: ReturnType<typeof vi.fn>,
  options: {
    profile?: "pilot_chats" | "fleet_tail";
    maxMessages?: number;
    chatIds?: string[];
    endDate?: string;
  } = {},
) {
  const seeded = await seed();
  const now = new Date();
  await testDb!.pool.query(`
    update ofapi_credit_state
    set last_balance = 1000, last_balance_at = $1, updated_at = $1
    where id = 1
  `, [now]);
  const app = createTestAppContext(testDb!, {
    ofapi: { dispatchGovernedRaw } as never,
    ofapiMirrorBackgroundCaptureEnabled: true,
    ofapiDmDailyCreditBudget: 100,
    ofapiBackfillDailyCreditBudget: 100,
    ofapiCreditFloor: 10,
  });
  await saveProxy(app, seeded.page.id, { url: "http://127.0.0.1:65535" });
  const created = await createOrGetOfapiCaptureJob(testDb!.db, {
    pageId: seeded.page.id,
    ofapiAccountId: seeded.accountId,
    kind: "account_export",
    activeSlotKey: `page:${seeded.page.id}:export`,
    target: {
      profile: options.profile ?? "fleet_tail",
      type: "chat_messages",
      accountIds: [seeded.accountId],
      startDate: "2016-11-01T00:00:00.000Z",
      endDate: options.endDate ?? "2026-07-16T00:00:00.000Z",
      fileType: "csv",
      maxMessages: options.maxMessages ?? 10_000_000,
      quoteTtlMinutes: 1_440,
      chatIds: options.chatIds ?? [],
      autoStart: false,
    },
    budgetScope: "bulk",
    originPrincipalId: seeded.owner.id,
    createdBy: "owner",
    maxCalls: 31,
    maxCredits: 5,
    now,
  });
  return { ...seeded, app, job: created.job };
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

  it("enforces principal call caps for the whole UTC day and resets at the next day", async () => {
    if (!testDb) return;
    const seeded = await seed();
    await testDb.pool.query(`
      insert into ofapi_principal_budget_state (
        principal_user_id, window_started_at, used_calls, used_credits, updated_at
      ) values ($1, $2, 1, 0, $3)
    `, [seeded.owner.id, new Date("2026-07-16T00:00:00.000Z"), NOW]);

    const reserveAt = async (now: Date) => {
      const request = await createOfapiInteractiveRequest(testDb!.db, {
        pageId: seeded.page.id,
        ofapiAccountId: seeded.accountId,
        principalUserId: seeded.owner.id,
        operation: "list_messages",
        surface: "messages",
        target: { path: "/api2/v2/chats/42/messages", query: { limit: 20 } },
        now,
      });
      return reserveOfapiRequestAttempt(testDb!.db, {
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
        requestShape: { path: "/api2/v2/chats/42/messages", query: { limit: 20 } },
        surface: "messages",
        servingMode: "vendor_only",
        reservedCredits: 1,
        globalDailyCap: 100,
        scopeDailyCap: 100,
        creditFloor: 10,
        balanceMaxAgeMs: 48 * 60 * 60 * 1000,
        principalCallCap: 1,
        principalCreditCap: 100,
        deadlineAt: new Date(now.getTime() + 60_000),
        now,
      });
    };

    const deniedAtNextHour = await reserveAt(new Date("2026-07-16T13:00:00.000Z"));
    expect(deniedAtNextHour).toEqual({
      admitted: false,
      reason: "principal_call_cap",
      retryAt: new Date("2026-07-17T00:00:00.000Z"),
    });

    const admittedNextDay = await reserveAt(new Date("2026-07-17T00:01:00.000Z"));
    expect(admittedNextDay.admitted).toBe(true);
    const principal = await testDb.pool.query<{
      window_started_at: Date;
      used_calls: number;
      used_credits: number;
    }>(`
      select window_started_at, used_calls, used_credits
      from ofapi_principal_budget_state
      where principal_user_id = $1
    `, [seeded.owner.id]);
    expect(principal.rows[0]).toMatchObject({
      window_started_at: new Date("2026-07-17T00:00:00.000Z"),
      used_calls: 1,
      used_credits: 1,
    });
  });

  it("temporarily denies missing, stale, or breached storage without punishing the principal", async () => {
    if (!testDb) return;
    const cases = [
      { label: "missing", storageHealth: undefined },
      {
        label: "stale",
        storageHealth: {
          healthy: true,
          breached: false,
          checkedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
        },
      },
      {
        label: "breached",
        storageHealth: { healthy: false, breached: true, checkedAt: NOW },
      },
    ] as const;

    for (const sample of cases) {
      if (sample.label === "missing") {
        await testDb.pool.query("delete from ofapi_storage_health_state");
      }
      const seeded = await createAndReserveInteractive({
        requireFreshStorageHealth: true,
        ...(sample.storageHealth === undefined ? {} : { storageHealth: sample.storageHealth }),
      });
      expect(seeded.reservation).toEqual({
        admitted: false,
        reason: "storage_unhealthy",
        retryAt: new Date(NOW.getTime() + 5 * 60 * 1000),
      });
      const principal = await testDb.pool.query<{
        consecutive_budget_denials: number;
        blocked_until: Date | null;
        last_denial_reason: string | null;
      }>(`
        select consecutive_budget_denials, blocked_until, last_denial_reason
        from ofapi_principal_budget_state
        where principal_user_id = $1
      `, [seeded.owner.id]);
      expect(principal.rows[0]).toMatchObject({
        consecutive_budget_denials: 0,
        blocked_until: null,
        last_denial_reason: null,
      });
    }

    const attempts = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from ofapi_request_attempts",
    );
    expect(attempts.rows[0]?.n).toBe("0");
  });

  it("admits governed capture with a fresh healthy storage sample", async () => {
    if (!testDb) return;
    const seeded = await createAndReserveInteractive({
      requireFreshStorageHealth: true,
      storageHealth: { healthy: true, breached: false, checkedAt: NOW },
    });
    expect(seeded.reservation.admitted).toBe(true);
  });

  it("parks an incident pause reversibly and wakes its slot on resume", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });
    await setOfapiCaptureControl(testDb.db, {
      controlKey: "global",
      paused: true,
      reason: "incident containment",
      expectedVersion: 0,
      actorUserId: fixture.owner.id,
      execute: true,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "retry_wait",
      reasonCode: "persistent_pause",
    });
    expect(fixture.dispatchGovernedRaw).not.toHaveBeenCalled();

    await setOfapiCaptureControl(testDb.db, {
      controlKey: "global",
      paused: false,
      reason: "incident cleared",
      expectedVersion: 1,
      actorUserId: fixture.owner.id,
      execute: true,
    });
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "ready",
      reasonCode: null,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps transient balance, floor, and deadline denials retryable", async () => {
    if (!testDb) return;
    const seeded = await seed();
    let sequence = 0;
    const reserveDeniedJob = async (input: {
      balance: number | null;
      balanceAt: Date | null;
      deadlineAt: Date;
      expectedReason: "balance_stale" | "credit_floor" | "deadline";
      expectedRetryAt: Date;
    }) => {
      sequence += 1;
      await testDb!.pool.query(`
        update ofapi_credit_state
        set last_balance = $1, last_balance_at = $2
        where id = 1
      `, [input.balance, input.balanceAt]);
      const created = await createOrGetOfapiCaptureJob(testDb!.db, {
        pageId: seeded.page.id,
        ofapiAccountId: seeded.accountId,
        kind: "chat_paginate",
        goal: "history_to_exhaustion",
        activeSlotKey: `page:${seeded.page.id}:chat:denial-${sequence}`,
        target: { chatId: `denial-${sequence}`, frozenHeadId: "100" },
        budgetScope: "bulk",
        createdBy: "owner",
        maxCalls: 1,
        maxCredits: 1,
        maxPages: 1,
        now: NOW,
      });
      const leased = await leaseNextOfapiCaptureJob(testDb!.db, {
        pageId: seeded.page.id,
        leaseOwner: `denial-${sequence}`,
        leaseTtlMs: 60_000,
        now: NOW,
      });
      if (!leased?.leaseToken || leased.id !== created.job.id) {
        throw new Error("denial fixture leased the wrong job");
      }
      expect(await reserveOfapiRequestAttempt(testDb!.db, {
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
        requestShape: { chatId: `denial-${sequence}` },
        reservedCredits: 1,
        globalDailyCap: 100,
        scopeDailyCap: 100,
        creditFloor: 10,
        balanceMaxAgeMs: 60 * 60 * 1000,
        jobLeaseToken: leased.leaseToken,
        deadlineAt: input.deadlineAt,
        now: NOW,
      })).toEqual({
        admitted: false,
        reason: input.expectedReason,
        retryAt: input.expectedRetryAt,
      });
      expect(await getOfapiCaptureJob(testDb!.db, created.job.id)).toMatchObject({
        state: "retry_wait",
        reasonCode: input.expectedReason,
        nextAttemptAt: input.expectedRetryAt,
      });
    };

    await reserveDeniedJob({
      balance: null,
      balanceAt: null,
      deadlineAt: new Date(NOW.getTime() + 60_000),
      expectedReason: "balance_stale",
      expectedRetryAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    await reserveDeniedJob({
      balance: 10,
      balanceAt: NOW,
      deadlineAt: new Date(NOW.getTime() + 60_000),
      expectedReason: "credit_floor",
      expectedRetryAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    await reserveDeniedJob({
      balance: 1_000,
      balanceAt: NOW,
      deadlineAt: NOW,
      expectedReason: "deadline",
      expectedRetryAt: new Date(NOW.getTime() + 60_000),
    });
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

    // A stale worker cannot leave an orphan terminal proof: the journal fact
    // is inserted only after the lease/job CAS has been validated in the same
    // transaction.
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
        kind: "complete",
        terminal: {
          producer: "stale-test-worker",
          kind: "ofapi.capture_completed.v1",
          payload: { stale: true },
          payloadHash: Buffer.alloc(32),
          idempotencyKey: `stale-proof:${leased.id}`,
          coverage: null,
        },
      },
      now: new Date(NOW.getTime() + 5_000),
    })).toBe(false);
    const orphanProof = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from observations
      where source = 'ofapi_capture' and kind = 'ofapi.capture_completed.v1'
    `);
    expect(orphanProof.rows[0]?.n).toBe("0");
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
      chatId: "42",
      classification: "continuous_history",
      pages: 1,
      parseDebt: 0,
      source: "pagination_exhausted",
      counts: {
        raw: 2,
        accepted: 2,
        boundaryDuplicate: 0,
        explicitlyIrrelevant: 0,
        rejected: 0,
      },
      evidence: {
        kind: "vendor_eof",
        pages: 1,
      },
    });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "100",
      requestedFirstId: "100",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toEqual({ eligible: false, reason: "no_certificate" });

    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "100",
      requestedFirstId: "100",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toEqual({ eligible: false, reason: "projection_lag" });

    await runMessageArchiveProjection(fixture.app, { accountId: fixture.page.id });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "100",
      requestedFirstId: "99",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toMatchObject({
      eligible: true,
      coverage: {
        pageId: fixture.page.id,
        chatId: "42",
        classification: "continuous_history",
      },
    });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "101",
      requestedFirstId: "99",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toEqual({ eligible: false, reason: "stale_head" });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "100",
      requestedFirstId: "98",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toEqual({ eligible: false, reason: "range_unproven" });

    const coverageEvents = await testDb.pool.query<{ type: string; account_seq: string }>(`
      select type, account_seq::text
      from domain_events
      where account_id = $1
        and type in ('capture.coverage_observed', 'stream.projection_checkpoint')
      order by account_seq
    `, [fixture.page.id]);
    expect(coverageEvents.rows.at(-2)?.type).toBe("capture.coverage_observed");
    expect(coverageEvents.rows.at(-1)?.type).toBe("stream.projection_checkpoint");
    const attempts = await testDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from ofapi_request_attempts
      where capture_job_id = $1
    `, [fixture.job.id]);
    expect(attempts.rows[0]?.count).toBe("1");
  });

  it("revokes a coverage proof append-only and preserves revocation on projection rebuild", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });
    await runMessageArchiveProjection(fixture.app, { accountId: fixture.page.id });
    const proof = await getComposableOfapiMessageCoverageProof(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedFrozenHeadId: "100",
      proofPolicyVersion: fixture.job.proofPolicyVersion,
    });
    if (!proof) throw new Error("coverage proof missing");
    const actionId = randomUUID();
    const revokeInput = {
      actionId,
      pageId: fixture.page.id,
      chatId: "42",
      expectedSourceAccountSeq: proof.sourceAccountSeq,
      actorUserId: fixture.owner.id,
      reason: "proof invalidated by verified adapter defect",
    };

    expect(await revokeOfapiMessageCoverage(testDb.db, revokeInput)).toMatchObject({
      status: "would_revoke",
      sourceAccountSeq: proof.sourceAccountSeq,
    });
    expect(await getComposableOfapiMessageCoverageProof(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedFrozenHeadId: "100",
      proofPolicyVersion: fixture.job.proofPolicyVersion,
    })).not.toBeNull();
    const revoked = await revokeOfapiMessageCoverage(testDb.db, {
      ...revokeInput,
      execute: true,
    });
    expect(revoked).toMatchObject({ status: "revoked", pageId: fixture.page.id, chatId: "42" });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "100",
      requestedFirstId: "99",
      acceptedProofPolicyVersions: [fixture.job.proofPolicyVersion],
    })).toEqual({ eligible: false, reason: "no_certificate" });

    const revocationEvents = await testDb.pool.query<{ type: string }>(`
      select type
      from domain_events
      where account_id = $1
        and type in ('capture.coverage_revoked', 'stream.projection_checkpoint')
      order by account_seq desc
      limit 2
    `, [fixture.page.id]);
    expect(revocationEvents.rows.map((row) => row.type).reverse()).toEqual([
      "capture.coverage_revoked",
      "stream.projection_checkpoint",
    ]);

    await resetOfapiMessageCoverageProjection(testDb.db, fixture.page.id);
    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });
    expect(await getComposableOfapiMessageCoverageProof(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedFrozenHeadId: "100",
      proofPolicyVersion: fixture.job.proofPolicyVersion,
    })).toBeNull();
    expect(await revokeOfapiMessageCoverage(testDb.db, {
      ...revokeInput,
      execute: true,
    })).toMatchObject({ status: "already_reconciled" });
  });

  it("composes bounded anchor chains without poisoning a lagging projection", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });
    await runMessageArchiveProjection(fixture.app, { accountId: fixture.page.id });

    const oldProof = await testDb.pool.query<{
      proof_observation_id: string;
      proof_observation_received_at: Date;
      source_account_seq: string;
      target_hash: string;
      page_chain_hash: string;
    }>(`
      select proof_observation_id::text,
             proof_observation_received_at,
             source_account_seq::text,
             target_hash,
             page_chain_hash
      from ofapi_message_coverage
      where page_id = $1 and chat_id = '42'
    `, [fixture.page.id]);
    const prior = oldProof.rows[0];
    if (!prior) throw new Error("old coverage proof missing");

    const anchorBody = Buffer.from(JSON.stringify({
      data: [
        { id: "102", isSentByMe: false, createdAt: "2026-07-16T12:01:00.000Z", text: "new" },
        { id: "101", isSentByMe: true, createdAt: "2026-07-16T12:00:00.000Z", text: "middle" },
        { id: "100", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z", text: "anchor" },
      ],
      _pagination: { next_page: "older-than-anchor" },
      _meta: { _credits: { used: 1, balance: 998 } },
    }));
    fixture.dispatchGovernedRaw.mockImplementation(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence missing");
      return {
        status: 200,
        bodyBytes: anchorBody,
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const repair = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: fixture.page.id,
      ofapiAccountId: fixture.accountId,
      kind: "chat_paginate",
      goal: "connect_to_anchor",
      activeSlotKey: `page:${fixture.page.id}:chat:42`,
      target: {
        chatId: "42",
        frozenHeadId: "102",
        anchorMessageId: "100",
        limit: 100,
      },
      budgetScope: "interactive",
      createdBy: "interactive_open",
      originPrincipalId: fixture.owner.id,
      maxCalls: 1,
      maxCredits: 1,
      maxPages: 1,
      maxItems: 100,
    });

    const callsBeforeRepair = fixture.dispatchGovernedRaw.mock.calls.length;
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(callsBeforeRepair + 1);
    expect(await getOfapiCaptureJob(testDb.db, repair.job.id)).toMatchObject({
      state: "complete",
      result: {
        classification: "continuous_history",
        completionEvidence: "anchor_chain",
        lastMessageId: "99",
      },
    });

    const terminal = await testDb.pool.query<{ payload: Record<string, unknown> }>(`
      select observation.payload
      from observations observation
      join ofapi_capture_jobs job
        on job.terminal_observation_id = observation.id
       and job.terminal_observation_received_at = observation.received_at
      where job.id = $1
    `, [repair.job.id]);
    expect(terminal.rows[0]?.payload).toMatchObject({
      classification: "continuous_history",
      range: { fromMessageId: "99", toFrozenHeadId: "102" },
      evidence: {
        kind: "anchor_chain",
        inheritedProof: {
          proofObservationId: Number(prior.proof_observation_id),
          proofObservationReceivedAt: prior.proof_observation_received_at.toISOString(),
          sourceAccountSeq: Number(prior.source_account_seq),
          targetHash: prior.target_hash,
          pageChainHash: prior.page_chain_hash,
          frozenHeadId: "100",
          oldestMessageId: "99",
        },
      },
      supersedes: {
        proofObservationId: Number(prior.proof_observation_id),
        sourceAccountSeq: Number(prior.source_account_seq),
      },
    });

    // A second valid completion can commit before the projector consumes the
    // first one. Both were atomically checked against the same old proof; the
    // reducer must advance through them in sequence instead of wedging on the
    // now-monotone intermediate row.
    const laterAnchorBody = Buffer.from(JSON.stringify({
      data: [
        { id: "104", isSentByMe: false, createdAt: "2026-07-16T12:03:00.000Z" },
        { id: "103", isSentByMe: true, createdAt: "2026-07-16T12:02:00.000Z" },
        { id: "100", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z" },
      ],
      _pagination: { next_page: "older-than-anchor" },
      _meta: { _credits: { used: 1, balance: 997 } },
    }));
    fixture.dispatchGovernedRaw.mockImplementation(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence missing");
      return {
        status: 200,
        bodyBytes: laterAnchorBody,
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const laterRepair = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: fixture.page.id,
      ofapiAccountId: fixture.accountId,
      kind: "chat_paginate",
      goal: "connect_to_anchor",
      activeSlotKey: `page:${fixture.page.id}:chat:42`,
      target: {
        chatId: "42",
        frozenHeadId: "104",
        anchorMessageId: "100",
        limit: 100,
      },
      budgetScope: "interactive",
      createdBy: "interactive_open",
      originPrincipalId: fixture.owner.id,
      maxCalls: 1,
      maxCredits: 1,
      maxPages: 1,
      maxItems: 100,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, laterRepair.job.id)).toMatchObject({
      state: "complete",
      result: { completionEvidence: "anchor_chain", lastMessageId: "99" },
    });

    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });
    await runMessageArchiveProjection(fixture.app, { accountId: fixture.page.id });
    expect(await evaluateOfapiHistoryCoverage(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedCurrentHeadId: "104",
      requestedFirstId: "99",
      acceptedProofPolicyVersions: [laterRepair.job.proofPolicyVersion],
    })).toMatchObject({ eligible: true });
  });

  it("atomically blocks anchor completion when the inherited proof changed", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await runOfapiMessageCoverageProjection(fixture.app, { accountId: fixture.page.id });

    const inheritedProof = await getComposableOfapiMessageCoverageProof(testDb.db, {
      pageId: fixture.page.id,
      chatId: "42",
      expectedFrozenHeadId: "100",
      proofPolicyVersion: fixture.job.proofPolicyVersion,
    });
    if (!inheritedProof) throw new Error("inherited proof missing");

    const anchorBody = Buffer.from(JSON.stringify({
      data: [
        { id: "102", isSentByMe: false, createdAt: "2026-07-16T12:01:00.000Z" },
        { id: "100", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z" },
      ],
      _pagination: { next_page: "older-than-anchor" },
      _meta: { _credits: { used: 1, balance: 998 } },
    }));
    fixture.dispatchGovernedRaw.mockImplementation(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence missing");
      return {
        status: 200,
        bodyBytes: anchorBody,
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const repair = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: fixture.page.id,
      ofapiAccountId: fixture.accountId,
      kind: "chat_paginate",
      goal: "connect_to_anchor",
      activeSlotKey: `page:${fixture.page.id}:chat:42`,
      target: {
        chatId: "42",
        frozenHeadId: "102",
        anchorMessageId: "100",
        limit: 100,
      },
      budgetScope: "interactive",
      createdBy: "interactive_open",
      originPrincipalId: fixture.owner.id,
      maxCalls: 1,
      maxCredits: 1,
      maxPages: 1,
      maxItems: 100,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    const capturedJob = await getOfapiCaptureJob(testDb.db, repair.job.id);
    if (
      !capturedJob?.leaseToken ||
      capturedJob.pendingObservationId === null ||
      capturedJob.pendingObservationReceivedAt === null
    ) {
      throw new Error("repair response was not durably captured");
    }
    const attempt = await testDb.pool.query<{ id: string }>(`
      select id::text
      from ofapi_request_attempts
      where capture_job_id = $1 and state = 'response_captured'
    `, [repair.job.id]);
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId) throw new Error("captured repair attempt missing");

    // Simulate a newer coverage projection winning after the parser read its
    // anchor but before the completion transaction acquires the row lock.
    await testDb.pool.query(`
      update ofapi_message_coverage
      set page_chain_hash = repeat('f', 64), updated_at = now()
      where page_id = $1 and chat_id = '42'
    `, [fixture.page.id]);

    const terminalKey = `anchor-race-proof:${repair.job.id}`;
    expect(await settleOfapiCaptureParse(testDb.db, {
      jobId: repair.job.id,
      attemptId,
      leaseToken: capturedJob.leaseToken,
      observationId: capturedJob.pendingObservationId,
      observationReceivedAt: capturedJob.pendingObservationReceivedAt,
      parserOutcome: "accepted",
      rawCount: 2,
      acceptedCount: 2,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "complete",
        expectedSupersedes: { conversationRef: "42", proof: inheritedProof },
        terminal: {
          producer: "race-test",
          kind: "ofapi.capture_completed.v1",
          payload: { mustNotBeCaptured: true },
          payloadHash: Buffer.alloc(32, 7),
          idempotencyKey: terminalKey,
          coverage: {
            conversationRef: "42",
            dedupKey: `anchor-race-coverage:${repair.job.id}`,
            checkpointDedupKey: `anchor-race-checkpoint:${repair.job.id}`,
          },
        },
      },
    })).toBe(true);

    expect(await getOfapiCaptureJob(testDb.db, repair.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "anchor_proof_changed",
      pendingObservationId: null,
      pendingObservationReceivedAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      terminalObservationId: null,
    });
    const forbidden = await testDb.pool.query<{ observations: string; events: string }>(`
      select
        (select count(*)::text from observations where idempotency_key = $1) as observations,
        (select count(*)::text from domain_events
          where account_id = $2 and dedup_key = $3) as events
    `, [terminalKey, fixture.page.id, `anchor-race-coverage:${repair.job.id}`]);
    expect(forbidden.rows[0]).toEqual({ observations: "0", events: "0" });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
  });

  it("materializes each captured page once with the producer's inclusive-boundary rule", async () => {
    if (!testDb) return;
    const responses = [
      Buffer.from(JSON.stringify({
        data: [
          { id: "100", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z" },
          { id: "99", isSentByMe: true, createdAt: "2026-07-16T11:58:00.000Z" },
        ],
        _pagination: { next_page: "99" },
        _meta: { _credits: { used: 1, balance: 999 } },
      })),
      Buffer.from(JSON.stringify({
        data: [
          { id: "99", isSentByMe: true, createdAt: "2026-07-16T11:58:00.000Z" },
          { id: "98", isSentByMe: false, createdAt: "2026-07-16T11:57:00.000Z" },
        ],
        _pagination: { next_page: null },
        _meta: { _credits: { used: 1, balance: 998 } },
      })),
    ];
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: responses[0]!,
      maxCalls: 2,
      maxCredits: 2,
      maxPages: 2,
    });
    fixture.dispatchGovernedRaw.mockImplementation(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence missing");
      const bodyBytes = responses.shift();
      if (!bodyBytes) throw new Error("unexpected extra page request");
      return {
        status: 200,
        bodyBytes,
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "complete",
      acceptedItems: 2,
      acceptedPages: 1,
    });

    const captured = await testDb.pool.query<{
      parse_version: number;
      boundary_is_duplicate: boolean;
    }>(`
      select parse_version,
             coalesce((payload->'request'->>'boundaryIsDuplicate')::boolean, false)
               as boundary_is_duplicate
      from observations
      where account_id = $1
        and source = 'ofapi_capture'
        and kind = 'ofapi.chat_messages_page.v1'
      order by id
    `, [fixture.page.id]);
    expect(captured.rows).toEqual([
      { parse_version: OFAPI_CAPTURE_MATERIALIZER_VERSION, boundary_is_duplicate: false },
      { parse_version: OFAPI_CAPTURE_MATERIALIZER_VERSION, boundary_is_duplicate: true },
    ]);
    expect(await runOfapiCaptureMaterialization(fixture.app)).toMatchObject({ scanned: 0 });
    const material = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from domain_events
      where account_id = $1 and type = 'message.material_observed'
    `, [fixture.page.id]);
    expect(material.rows[0]?.n).toBe("3");
  });

  it("certifies the production-observed exclusive first_id response", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: Buffer.from(JSON.stringify({
        data: [
          { id: "99", isSentByMe: false, createdAt: "2026-07-16T11:59:00.000Z" },
          { id: "98", isSentByMe: true, createdAt: "2026-07-16T11:58:00.000Z" },
        ],
        _pagination: { next_page: null },
        _meta: { _credits: { used: 1, balance: 999 } },
      })),
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "complete",
      sourceContractVersion: OFAPI_CAPTURE_SOURCE_CONTRACT_VERSION,
      parserVersion: OFAPI_CAPTURE_PARSER_VERSION,
    });
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);

    const terminal = await testDb.pool.query<{ semantics: string }>(`
      select payload->'evidence'->>'boundarySemantics' as semantics
      from observations
      where source = 'ofapi_capture'
        and kind = 'ofapi.capture_completed.v1'
        and payload->>'jobId' = $1
    `, [fixture.job.id]);
    expect(terminal.rows).toEqual([{ semantics: "exclusive" }]);
  });

  it("captures valid JSON contract drift but freezes the cursor and does not retry the vendor", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null, shape: "contract_drift" }),
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    const blocked = await getOfapiCaptureJob(testDb.db, fixture.job.id);
    expect(blocked).toMatchObject({
      state: "blocked",
      reasonCode: "contract_rejected",
      cursor: null,
      acceptedPages: 0,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);

    const replayInput = {
      jobId: fixture.job.id,
      expectedState: "blocked" as const,
      expectedReasonCode: "contract_rejected" as const,
      expectedJobRowVersion: blocked!.rowVersion,
      actorUserId: fixture.owner.id,
      reason: "adapter was reviewed and fixed",
    };
    expect(await replayOfapiCaptureJobParse(testDb.db, replayInput)).toMatchObject({
      dryRun: true,
      status: "would_replay",
      next: { state: "awaiting_parse" },
    });
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "contract_rejected",
    });
    expect(await replayOfapiCaptureJobParse(testDb.db, {
      ...replayInput,
      execute: true,
    })).toMatchObject({ dryRun: false, status: "replayed" });
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "awaiting_parse",
      reasonCode: null,
    });
    // This test intentionally keeps the old adapter. It re-quarantines the
    // same local bytes and proves the operator action never dispatches OFAPI.
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("blocks an oversized accepted page before materialization", async () => {
    if (!testDb) return;
    const data = Array.from({ length: 301 }, (_value, index) => ({
      id: String(100 - index),
      isSentByMe: index % 2 === 0,
      createdAt: new Date(Date.parse("2026-07-16T11:59:00.000Z") - index * 1_000).toISOString(),
      text: `message-${index}`,
    }));
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: Buffer.from(JSON.stringify({
        data,
        _pagination: { next_page: "older" },
        _meta: { _credits: { used: 1, balance: 999 } },
      })),
      maxItems: 300,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "item_cap_exceeded",
      acceptedItems: 0,
      acceptedPages: 0,
    });
    const material = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from domain_events
      where account_id = $1 and type = 'message.material_observed'
    `, [fixture.page.id]);
    expect(material.rows[0]?.n).toBe("0");
    expect(fixture.dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a terminal idempotency conflict without publishing coverage", async () => {
    if (!testDb) return;
    const fixture = await createCaptureExecutionFixture({
      bodyBytes: messagePage({ nextPage: null }),
    });
    await insertObservation(testDb.db, {
      source: "ofapi_capture",
      producer: "conflict-fixture",
      platform: "onlyfans",
      accountId: fixture.page.id,
      nativeAccountRef: fixture.accountId,
      kind: "ofapi.capture_completed.v1",
      payload: { conflicting: true },
      payloadHash: Buffer.alloc(32, 7),
      idempotencyKey: `capture-complete:${fixture.job.id}:${fixture.job.targetHash}`,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await expect(
      executeOfapiCaptureJobChunk(fixture.app, fixture.page.id),
    ).rejects.toThrow(/conflicts with a captured fact/);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "awaiting_parse",
      terminalObservationId: null,
    });
    const coverage = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from domain_events
      where account_id = $1 and type = 'capture.coverage_observed'
    `, [fixture.page.id]);
    expect(coverage.rows[0]?.n).toBe("0");
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

  it("recovers expired interactive attempts into an operator-visible terminal state", async () => {
    if (!testDb) return;
    const reserved = await createAndReserveInteractive();
    if (!reserved.reservation.admitted) throw new Error("interactive reservation denied");
    expect(await recoverStaleOfapiCaptureWork(testDb.db, {
      now: new Date(NOW.getTime() + 61_000),
    })).toEqual({ released: 1, indeterminate: 0, requeued: 0 });
    expect(await getOfapiRequestAttempt(testDb.db, reserved.reservation.attemptId)).toMatchObject({
      state: "released_pre_dispatch",
      credit_state: "released",
    });

    await resetIntegrationDatabase(testDb.pool);
    const dispatched = await createAndReserveInteractive();
    if (!dispatched.reservation.admitted) throw new Error("interactive reservation denied");
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: dispatched.reservation.attemptId,
      fenceToken: dispatched.reservation.fenceToken,
      now: new Date(NOW.getTime() + 1_000),
    })).toBe(true);
    expect(await recoverStaleOfapiCaptureWork(testDb.db, {
      now: new Date(NOW.getTime() + 61_000),
    })).toEqual({ released: 0, indeterminate: 1, requeued: 0 });
    expect(await getOfapiRequestAttempt(testDb.db, dispatched.reservation.attemptId))
      .toMatchObject({ state: "indeterminate", credit_state: "indeterminate" });
    const status = await getOfapiCaptureOperatorStatus(testDb.db);
    expect(status.indeterminate.count).toBe(1);
    expect(status.indeterminate.samples[0]?.attemptId).toBe(dispatched.reservation.attemptId);
  });

  it("releases a crashed floor probe without globally pinning live admission", async () => {
    if (!testDb) return;
    const seeded = await seed();
    await testDb.pool.query(`
      update ofapi_credit_state
      set last_balance = null, last_balance_at = null
      where id = 1
    `);
    const created = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      kind: "chat_paginate",
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:floor-probe`,
      target: { chatId: "floor-probe", frozenHeadId: "100" },
      budgetScope: "live",
      createdBy: "verification_probe",
      maxCalls: 2,
      maxCredits: 2,
      maxPages: 2,
      now: NOW,
    });
    const leased = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "floor-probe-crash",
      leaseTtlMs: 1_000,
      now: NOW,
    });
    if (!leased?.leaseToken) throw new Error("floor probe lease missing");
    const reservation = await reserveOfapiRequestAttempt(testDb.db, {
      ownerKind: "capture_job",
      ownerId: created.job.id,
      pageId: seeded.page.id,
      ofapiAccountId: seeded.accountId,
      budgetScope: "live",
      operation: "list_messages",
      endpointClass: "messages",
      egressKey: `page:${seeded.page.id}`,
      method: "GET",
      requestSemantics: "safe_read",
      requestShape: { chatId: "floor-probe", firstId: "100" },
      reservedCredits: 1,
      globalDailyCap: 100,
      scopeDailyCap: 100,
      creditFloor: 10,
      balanceMaxAgeMs: 60 * 60 * 1000,
      allowFloorProbe: true,
      jobLeaseToken: leased.leaseToken,
      deadlineAt: new Date(NOW.getTime() + 30_000),
      now: NOW,
    });
    if (!reservation.admitted) throw new Error(`floor probe denied: ${reservation.reason}`);
    expect(reservation.isFloorProbe).toBe(true);
    expect(await markOfapiAttemptDispatching(testDb.db, {
      attemptId: reservation.attemptId,
      fenceToken: reservation.fenceToken,
      jobLeaseToken: leased.leaseToken,
      now: new Date(NOW.getTime() + 500),
    })).toBe(true);

    expect(await recoverStaleOfapiCaptureWork(testDb.db, {
      now: new Date(NOW.getTime() + 31_000),
    })).toEqual({ released: 0, indeterminate: 1, requeued: 0 });
    expect(await getOfapiRequestAttempt(testDb.db, reservation.attemptId)).toMatchObject({
      state: "indeterminate",
      credit_state: "settled",
      certainty_resolution: "safe_read_retry_assumed_billed",
    });
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "retry_wait",
      reasonCode: "indeterminate_safe_read_retry",
    });
    const credit = await testDb.pool.query<{ governed_unsettled_credits: number }>(
      "select governed_unsettled_credits from ofapi_credit_state where id = 1",
    );
    expect(credit.rows[0]?.governed_unsettled_credits).toBe(0);
  });

  it("requeues the same frozen safe-read job only after owner certainty resolution", async () => {
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

    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: reservation.attemptId,
      resolution: "confirmed_billed",
      actorUserId: seeded.owner.id,
      reason: "vendor console confirmed the safe GET charge",
      now: new Date(NOW.getTime() + 3_000),
    })).toBe(true);
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "retry_wait",
      reasonCode: "operator_reconciled_safe_read",
      target: { chatId: "expired", frozenHeadId: "100" },
      spentCredits: 1,
      attemptCount: 1,
      dispatchCount: 1,
    });
    expect(await listRunnableOfapiCapturePages(testDb.db, {
      now: new Date(NOW.getTime() + 3_001),
    })).toEqual([{
      pageId: seeded.page.id,
      priority: 0,
      requestedAt: new Date(NOW.getTime() + 3_000),
    }]);

    const released = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: seeded.page.id,
      leaseOwner: "second-crashed-worker",
      leaseTtlMs: 1_000,
      now: new Date(NOW.getTime() + 3_001),
    });
    expect(released).toMatchObject({ id: created.job.id });

    expect(await recoverStaleOfapiCaptureWork(testDb.db, {
      now: new Date(NOW.getTime() + 5_000),
    })).toEqual({ released: 0, indeterminate: 0, requeued: 1 });
    expect(await getOfapiCaptureJob(testDb.db, created.job.id)).toMatchObject({
      state: "ready",
      reasonCode: "lease_expired_before_attempt",
    });
    const historicalAttempt = await getOfapiRequestAttempt(testDb.db, reservation.attemptId);
    expect(historicalAttempt).toMatchObject({
      state: "indeterminate",
      certainty_resolution: "confirmed_billed",
    });
    expect(new Date(String(historicalAttempt?.certainty_resolved_at))).toEqual(
      new Date(NOW.getTime() + 3_000),
    );
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

  it("quotes an account export but never starts it", async () => {
    if (!testDb) return;
    const calls: Array<{
      method: string;
      pathname: string;
      body: Record<string, unknown> | null;
    }> = [];
    const responses: Array<Record<string, unknown>> = [];
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: {
        method: string;
        pathname: string;
        bodyBytes?: Buffer | null;
        beforeDispatch: () => Promise<boolean>;
      },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      calls.push({
        method: request.method,
        pathname: request.pathname,
        body: request.bodyBytes ? JSON.parse(request.bodyBytes.toString("utf8")) : null,
      });
      const body = responses.shift();
      if (!body) throw new Error("unexpected extra export request");
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify(body)),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);
    responses.push(
      {
        data: {
          id: "data_export_quote123",
          type: "chat_messages",
          status: "calculating_credits",
          start_date: "2016-11-01T00:00:00.000Z",
          end_date: "2026-07-16T00:00:00.000Z",
          file_type: "csv",
        },
        _meta: { _credits: { used: 0, balance: 1000 } },
      },
      {
        data: {
          id: "data_export_quote123",
          type: "chat_messages",
          status: "calculating_credits_completed",
          start_date: "2016-11-01T00:00:00.000Z",
          end_date: "2026-07-16T00:00:00.000Z",
          file_type: "csv",
          accounts: [{ id: fixture.accountId }],
          total_rows: 2460,
          credit_cost: 123,
        },
        _meta: { _credits: { used: 0, balance: 1000 } },
      },
    );

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "retry_wait",
      cursor: {
        phase: "quote_calculating",
        vendorExportId: "data_export_quote123",
      },
    });
    await testDb.pool.query(
      "update ofapi_capture_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [fixture.job.id],
    );
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "POST", pathname: "/data-exports" });
    expect(calls[0]?.body).toMatchObject({
      type: "chat_messages",
      auto_start: false,
      options: { maxMessages: 10_000_000, skipMassMessages: false },
    });
    expect(calls[1]).toEqual({
      method: "GET",
      pathname: "/data-exports/data_export_quote123",
      body: null,
    });
    expect(calls.every((call) => !call.pathname.endsWith("/start"))).toBe(true);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "owner_approval_required",
      cursor: {
        phase: "quoted",
        vendorExportId: "data_export_quote123",
        totalRows: 2460,
        creditCost: 123,
      },
    });
    expect(await cancelBlockedOfapiExportQuoteJob(testDb.db, {
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
      reason: "quote recorded; release slot for the next profile",
    })).toEqual({ cancelled: true, currentState: "cancelled" });
    const next = await createOrGetOfapiCaptureJob(testDb.db, {
      pageId: fixture.page.id,
      ofapiAccountId: fixture.accountId,
      kind: "account_export",
      activeSlotKey: `page:${fixture.page.id}:export`,
      target: {
        profile: "pilot_chats",
        type: "chat_messages",
        accountIds: [fixture.accountId],
        startDate: "2016-11-01T00:00:00.000Z",
        endDate: "2026-07-16T00:00:00.000Z",
        fileType: "csv",
        maxMessages: 100,
        quoteTtlMinutes: 1_440,
        chatIds: ["42"],
        autoStart: false,
      },
      budgetScope: "bulk",
      originPrincipalId: fixture.owner.id,
      createdBy: "owner",
      maxCalls: 31,
      maxCredits: 5,
    });
    expect(next.created).toBe(true);
  });

  it("treats a captured export-create 422 as a safely cancellable failure", async () => {
    if (!testDb) return;
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      return {
        status: 422,
        bodyBytes: Buffer.from(JSON.stringify({
          message: "The start date is outside the supported range.",
          errors: { start_date: ["outside the supported range"] },
        })),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(dispatchGovernedRaw).toHaveBeenCalledTimes(1);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "export_quote_failed",
      attemptCount: 1,
      dispatchCount: 1,
      spentCredits: 1,
    });
    expect(await cancelBlockedOfapiExportQuoteJob(testDb.db, {
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
      reason: "captured validation rejection; retry with corrected target",
    })).toEqual({ cancelled: true, currentState: "cancelled" });
  });

  it("records a scraping export whose price is unavailable until start", async () => {
    if (!testDb) return;
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify({
          data: {
            id: "data_export_scrape_quote",
            type: "chat_messages",
            status: "calculating_credits_completed",
            start_date: "2016-11-01T00:00:00+00:00",
            end_date: "2026-07-16T23:59:59+00:00",
            file_type: "csv",
            requires_scraping: true,
            auto_started: false,
            credit_calculation_note: "Credits are calculated after scraping completes.",
            effective_options: {
              maxMessages: 10_000_000,
              skipMassMessages: false,
              chatIds: [],
            },
          },
          _meta: { _credits: { used: 0, balance: 1000 } },
        })),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(dispatchGovernedRaw).toHaveBeenCalledTimes(1);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "export_quote_requires_start",
      spentCredits: 0,
      cursor: {
        phase: "quote_unavailable",
        vendorExportId: "data_export_scrape_quote",
        totalRows: null,
        creditCost: null,
      },
    });
    expect(await cancelBlockedOfapiExportQuoteJob(testDb.db, {
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
      reason: "unstarted scraping export has no preflight price",
    })).toEqual({ cancelled: true, currentState: "cancelled" });
  });

  it("does not widen a non-midnight export end to the end of its UTC day", async () => {
    if (!testDb) return;
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify({
          data: {
            id: "data_export_intraday_end",
            type: "chat_messages",
            status: "calculating_credits",
            start_date: "2016-11-01T00:00:00+00:00",
            end_date: "2026-07-16T23:59:59+00:00",
            file_type: "csv",
          },
          _meta: { _credits: { used: 0, balance: 1_000 } },
        })),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw, {
      endDate: "2026-07-16T12:00:00.000Z",
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    expect(dispatchGovernedRaw).toHaveBeenCalledTimes(1);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "export_contract_rejected",
    });
  });

  it("starts one owner-approved bounded pilot and reconciles its terminal cost", async () => {
    if (!testDb) return;
    const calls: Array<{ method: string; pathname: string }> = [];
    const responses: Array<Record<string, unknown>> = [];
    let expectedAccountId = "";
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: {
        method: string;
        pathname: string;
        beforeDispatch: () => Promise<boolean>;
      },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      calls.push({ method: request.method, pathname: request.pathname });
      const body = responses.shift();
      if (!body) throw new Error("unexpected extra export request");
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify(body)),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw, {
      profile: "pilot_chats",
      maxMessages: 1_000,
      chatIds: ["42"],
    });
    expectedAccountId = fixture.accountId;
    const fullStatus = (status: "in_progress" | "completed") => ({
      data: {
        id: "data_export_pilot_start",
        type: "chat_messages",
        status,
        start_date: "2016-11-01T00:00:00.000Z",
        end_date: "2026-07-16T00:00:00.000Z",
        file_type: "csv",
        accounts: [{ id: expectedAccountId }],
        total_rows: 40,
        rows_processed: status === "completed" ? 40 : 20,
        failed_downloads: 0,
        credit_cost: 2,
        ...(status === "completed"
          ? { download_url: "https://exports.example.test/pilot.csv?signature=secret" }
          : {}),
      },
      _meta: { _credits: { used: 0, balance: 998 } },
    });
    responses.push(
      {
        data: {
          id: "data_export_pilot_start",
          type: "chat_messages",
          status: "calculating_credits_completed",
          start_date: "2016-11-01T00:00:00.000Z",
          end_date: "2026-07-16T00:00:00.000Z",
          file_type: "csv",
          requires_scraping: true,
          auto_started: false,
          effective_options: {
            maxMessages: 1_000,
            skipMassMessages: false,
            chatIds: [42],
          },
        },
        _meta: { _credits: { used: 0, balance: 1_000 } },
      },
      {
        data: {
          id: "data_export_pilot_start",
          status: "pending",
          message: "Data export has been started.",
        },
        _meta: { _credits: { used: 0, balance: 1_000 } },
      },
      fullStatus("in_progress"),
      fullStatus("completed"),
    );

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    const quoted = await getOfapiCaptureJob(testDb.db, fixture.job.id);
    expect(quoted).toMatchObject({
      state: "blocked",
      reasonCode: "export_quote_requires_start",
      cursor: { phase: "quote_unavailable" },
    });
    expect(await approveBlockedOfapiExportPilotJob(testDb.db, {
      jobId: fixture.job.id,
      expectedRowVersion: quoted!.rowVersion,
      approvedMaxCredits: 50,
      actorUserId: fixture.owner.id,
      reason: "bounded integration pilot",
      execute: true,
    })).toMatchObject({ outcome: "approved" });
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      maxCredits: quoted!.spentCredits + 50 + 4,
      maxCalls: quoted!.attemptCount + 1 + 288,
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "awaiting_parse",
      spentCredits: 50,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "retry_wait",
      spentCredits: 50,
      cursor: { phase: "in_progress" },
    });

    for (const expectedKind of ["success", "blocked"] as const) {
      await testDb.pool.query(
        "update ofapi_capture_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
        [fixture.job.id],
      );
      expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
      expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe(expectedKind);
    }

    expect(calls.filter((call) => call.pathname.endsWith("/start"))).toHaveLength(1);
    expect(calls).toEqual([
      { method: "POST", pathname: "/data-exports" },
      { method: "POST", pathname: "/data-exports/data_export_pilot_start/start" },
      { method: "GET", pathname: "/data-exports/data_export_pilot_start" },
      { method: "GET", pathname: "/data-exports/data_export_pilot_start" },
    ]);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "artifact_capture_required",
      spentCredits: 2,
      cursor: {
        phase: "artifact_pending",
        totalRows: 40,
        rowsProcessed: 40,
        creditCost: 2,
        failedDownloads: 0,
      },
    });
  });

  it("never repeats an indeterminate owner-approved export start", async () => {
    if (!testDb) return;
    const calls: string[] = [];
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: {
        pathname: string;
        beforeDispatch: () => Promise<boolean>;
      },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      calls.push(request.pathname);
      if (request.pathname.endsWith("/start")) {
        throw new OfapiGovernedRequestError(
          "scripted uncertain export start",
          "post_dispatch",
          "transport",
        );
      }
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify({
          data: {
            id: "data_export_uncertain_start",
            type: "chat_messages",
            status: "calculating_credits_completed",
            start_date: "2016-11-01T00:00:00.000Z",
            end_date: "2026-07-16T00:00:00.000Z",
            file_type: "csv",
            requires_scraping: true,
            auto_started: false,
            effective_options: {
              maxMessages: 1_000,
              skipMassMessages: false,
              chatIds: [42],
            },
          },
          _meta: { _credits: { used: 0, balance: 1_000 } },
        })),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw, {
      profile: "pilot_chats",
      maxMessages: 1_000,
      chatIds: ["42"],
    });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");
    const quoted = await getOfapiCaptureJob(testDb.db, fixture.job.id);
    expect(await approveBlockedOfapiExportPilotJob(testDb.db, {
      jobId: fixture.job.id,
      expectedRowVersion: quoted!.rowVersion,
      approvedMaxCredits: 50,
      actorUserId: fixture.owner.id,
      reason: "indeterminate-start regression",
      execute: true,
    })).toMatchObject({ outcome: "approved" });

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("failed");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
      spentCredits: 50,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
    expect(calls.filter((pathname) => pathname.endsWith("/start"))).toHaveLength(1);
  });

  it("never repeats an indeterminate export-create POST", async () => {
    if (!testDb) return;
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: { beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      throw new OfapiGovernedRequestError(
        "scripted uncertain export create",
        "post_dispatch",
        "transport",
      );
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("failed");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
      attemptCount: 1,
      dispatchCount: 1,
      spentCredits: 1,
    });
    expect(await cancelBlockedOfapiExportQuoteJob(testDb.db, {
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
      reason: "must not free an uncertain stateful slot",
    })).toEqual({ cancelled: false, currentState: "blocked" });
    const attempt = await testDb.pool.query<{ id: string }>(`
      select id::text as id
      from ofapi_request_attempts
      where capture_job_id = $1
      order by reserved_at desc
      limit 1
    `, [fixture.job.id]);
    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: attempt.rows[0]!.id,
      resolution: "confirmed_billed",
      actorUserId: fixture.owner.id,
      reason: "vendor console confirmed the uncertain create charge",
    })).toBe(true);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
      spentCredits: 1,
    });
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("idle");
    expect(dispatchGovernedRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a null-cost quote and keeps the stateful create slot fenced", async () => {
    if (!testDb) return;
    let expectedAccountId = "";
    let dispatchNo = 0;
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: { method: string; beforeDispatch: () => Promise<boolean> },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      dispatchNo += 1;
      const body = request.method === "POST"
        ? {
          data: {
            id: "data_export_null_cost",
            type: "chat_messages",
            status: "calculating_credits",
            start_date: "2016-11-01T00:00:00.000Z",
            end_date: "2026-07-16T00:00:00.000Z",
            file_type: "csv",
          },
          _meta: { _credits: { used: 0, balance: 1000 } },
        }
        : {
          data: {
            id: "data_export_null_cost",
            type: "chat_messages",
            status: "calculating_credits_completed",
            start_date: "2016-11-01T00:00:00.000Z",
            end_date: "2026-07-16T00:00:00.000Z",
            file_type: "csv",
            accounts: [{ id: expectedAccountId }],
            total_rows: null,
            credit_cost: null,
          },
          _meta: { _credits: { used: 0, balance: 1000 } },
        };
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify(body)),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);
    expectedAccountId = fixture.accountId;

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await testDb.pool.query(
      "update ofapi_capture_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [fixture.job.id],
    );
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");

    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "export_quote_missing_cost",
    });
    expect(await cancelBlockedOfapiExportQuoteJob(testDb.db, {
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
      reason: "must not turn a malformed quote into a new create",
    })).toEqual({ cancelled: false, currentState: "blocked" });
    expect(dispatchNo).toBe(2);
  });

  it("retries an indeterminate export-status GET without repeating export creation", async () => {
    if (!testDb) return;
    const calls: Array<{ method: string; pathname: string }> = [];
    let statusDispatches = 0;
    let expectedAccountId = "";
    const dispatchGovernedRaw = vi.fn(async (
      _context: unknown,
      request: {
        method: string;
        pathname: string;
        beforeDispatch: () => Promise<boolean>;
      },
    ) => {
      if (!await request.beforeDispatch()) throw new Error("dispatch fence lost");
      calls.push({ method: request.method, pathname: request.pathname });
      if (request.method === "GET") {
        statusDispatches += 1;
        if (statusDispatches === 1) {
          throw new OfapiGovernedRequestError(
            "scripted uncertain status read",
            "post_dispatch",
            "transport",
          );
        }
      }
      const body = request.method === "POST"
        ? {
          data: {
            id: "data_export_quote_retry",
            type: "chat_messages",
            status: "calculating_credits",
            start_date: "2016-11-01T00:00:00.000Z",
            end_date: "2026-07-16T00:00:00.000Z",
            file_type: "csv",
          },
          _meta: { _credits: { used: 0, balance: 1000 } },
        }
        : {
          data: {
            id: "data_export_quote_retry",
            type: "chat_messages",
            status: "calculating_credits_completed",
            start_date: "2016-11-01T00:00:00.000Z",
            end_date: "2026-07-16T00:00:00.000Z",
            file_type: "csv",
            accounts: [{ id: expectedAccountId }],
            total_rows: 42,
            credit_cost: 3,
          },
          _meta: { _credits: { used: 0, balance: 1000 } },
        };
      return {
        status: 200,
        bodyBytes: Buffer.from(JSON.stringify(body)),
        headers: { "content-type": "application/json" },
        receivedAt: new Date(),
      };
    });
    const fixture = await createExportQuoteExecutionFixture(dispatchGovernedRaw);
    expectedAccountId = fixture.accountId;

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    await testDb.pool.query(
      "update ofapi_capture_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [fixture.job.id],
    );

    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("failed");
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "retry_wait",
      reasonCode: "indeterminate_safe_read_retry",
      attemptCount: 2,
      dispatchCount: 2,
      spentCredits: 1,
    });
    const uncertainRead = await testDb.pool.query<{
      state: string;
      credit_state: string;
      settled_credits: number | null;
      certainty_resolution: string | null;
    }>(`
      select state, credit_state, settled_credits, certainty_resolution
      from ofapi_request_attempts
      where capture_job_id = $1
      order by owner_attempt_no desc
      limit 1
    `, [fixture.job.id]);
    expect(uncertainRead.rows[0]).toEqual({
      state: "indeterminate",
      credit_state: "settled",
      settled_credits: 1,
      certainty_resolution: "safe_read_retry_assumed_billed",
    });
    await testDb.pool.query(
      "update ofapi_capture_jobs set next_attempt_at = now() - interval '1 second' where id = $1",
      [fixture.job.id],
    );
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("success");
    expect((await executeOfapiCaptureJobChunk(fixture.app, fixture.page.id)).kind).toBe("blocked");

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "owner_approval_required",
      attemptCount: 3,
      dispatchCount: 3,
      spentCredits: 1,
      cursor: {
        phase: "quoted",
        vendorExportId: "data_export_quote_retry",
        totalRows: 42,
        creditCost: 3,
      },
    });
  });
});
