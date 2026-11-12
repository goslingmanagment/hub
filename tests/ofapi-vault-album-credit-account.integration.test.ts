// The OnlyFans vault albums' own OFAPI credit account (scope `vault_album`):
// its own day ceiling and counter, never the common day counter nor a
// per-user counter, through the whole life of a reservation — and the
// existing scopes' counters unchanged by the same sequences.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureOfapiAttemptResponse,
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  createUser,
  leaseNextOfapiCaptureJob,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  reconcileOfapiCapturedAttemptCredit,
  releaseOfapiAttemptPreDispatch,
  reserveOfapiRequestAttempt,
  resolveOfapiIndeterminateAttempt,
  setPageOfapiAccountId,
  type OfapiBudgetScope,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

const NOW = new Date("2026-07-16T12:00:00.000Z");
const NEXT_DAY = new Date("2026-07-17T00:10:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

let ownerId = 0;

async function seedCreditState() {
  const owner = await createUser(testDb!.db, {
    username: `owner-${randomUUID()}`,
    role: "owner",
    passwordHash: "x",
  });
  if (!owner) throw new Error("owner seed failed");
  ownerId = owner.id;
  await testDb!.pool.query(`
    insert into ofapi_credit_state (
      id, spend_day, spent_credits, governed_scope_day,
      live_spent_credits, interactive_spent_credits, bulk_spent_credits,
      governed_unsettled_credits, last_balance, last_balance_at, updated_at
    ) values (1, $1::date, 0, $1::date, 0, 0, 0, 0, 100000, $2, $2)
    on conflict (id) do update set
      spend_day = excluded.spend_day,
      spent_credits = 0,
      governed_scope_day = excluded.governed_scope_day,
      live_spent_credits = 0,
      interactive_spent_credits = 0,
      bulk_spent_credits = 0,
      governed_unsettled_credits = 0,
      vault_album_spend_day = null,
      vault_album_spent_credits = 0,
      last_balance = 100000,
      last_balance_at = excluded.last_balance_at,
      updated_at = excluded.updated_at
  `, [NOW.toISOString().slice(0, 10), NOW]);
}

/** One leased capture job on its own page; the credit state is shared. */
async function leasedJob(scope: OfapiBudgetScope, now = NOW) {
  const model = await createModel(testDb!.db, { slug: `vault-${randomUUID()}`, name: "Vault Test" });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: `vault-${randomUUID()}` });
  if (!page) throw new Error("page seed failed");
  const accountId = `acct_${randomUUID()}`;
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: accountId });
  const created = await createOrGetOfapiCaptureJob(testDb!.db, {
    pageId: page.id,
    ofapiAccountId: accountId,
    kind: "chat_paginate",
    goal: "bounded_tail",
    activeSlotKey: `page:${page.id}:chat:${randomUUID()}`,
    target: { chatId: "1", frozenHeadId: "1" },
    budgetScope: scope,
    originPrincipalId: ownerId,
    createdBy: "owner",
    maxCalls: 100,
    maxCredits: 100_000,
    maxPages: 10,
    now,
  });
  const leased = await leaseNextOfapiCaptureJob(testDb!.db, {
    pageId: page.id,
    leaseOwner: `test-${randomUUID()}`,
    leaseTtlMs: 10 * 60_000,
    now,
  });
  if (!leased?.leaseToken || leased.id !== created.job.id) throw new Error("leased the wrong job");
  return { pageId: page.id, accountId, jobId: created.job.id, leaseToken: leased.leaseToken };
}

type Job = Awaited<ReturnType<typeof leasedJob>>;

async function reserve(job: Job, scope: OfapiBudgetScope, input: {
  credits: number;
  scopeCap?: number;
  globalCap?: number;
  principalCreditCap?: number;
  creditFloor?: number;
  now?: Date;
}) {
  const now = input.now ?? at(NOW, 1_000);
  return reserveOfapiRequestAttempt(testDb!.db, {
    ownerKind: "capture_job",
    ownerId: job.jobId,
    pageId: job.pageId,
    ofapiAccountId: job.accountId,
    originPrincipalId: ownerId,
    budgetScope: scope,
    operation: scope === "vault_album" ? "upload_media" : "list_messages",
    endpointClass: scope === "vault_album" ? "media" : "messages",
    egressKey: `page:${job.pageId}`,
    method: scope === "vault_album" ? "POST" : "GET",
    requestSemantics: scope === "vault_album" ? "stateful" : "safe_read",
    requestShape: { n: randomUUID() },
    reservedCredits: input.credits,
    globalDailyCap: input.globalCap ?? 1_000,
    scopeDailyCap: input.scopeCap ?? 1_000,
    creditFloor: input.creditFloor ?? 10,
    balanceMaxAgeMs: 365 * 24 * 60 * 60 * 1000,
    principalCallCap: 100,
    principalCreditCap: input.principalCreditCap ?? 1_000,
    jobLeaseToken: job.leaseToken,
    deadlineAt: at(now, 60_000),
    now,
  });
}

async function admitted(job: Job, scope: OfapiBudgetScope, input: Parameters<typeof reserve>[2]) {
  const result = await reserve(job, scope, input);
  if (!result.admitted) throw new Error(`expected admission, got ${result.reason}`);
  return result;
}

async function counters() {
  const row = (await testDb!.pool.query<{
    spend_day: string;
    spent_credits: number;
    live_spent_credits: number;
    interactive_spent_credits: number;
    bulk_spent_credits: number;
    vault_album_spend_day: string | null;
    vault_album_spent_credits: number;
    governed_unsettled_credits: number;
  }>(`
    select to_char(spend_day, 'YYYY-MM-DD') as spend_day, spent_credits,
           live_spent_credits, interactive_spent_credits, bulk_spent_credits,
           to_char(vault_album_spend_day, 'YYYY-MM-DD') as vault_album_spend_day,
           vault_album_spent_credits, governed_unsettled_credits
    from ofapi_credit_state where id = 1
  `)).rows[0]!;
  const principal = (await testDb!.pool.query<{ used_calls: number; used_credits: number }>(
    "select used_calls, used_credits from ofapi_principal_budget_state where principal_user_id = $1",
    [ownerId],
  )).rows[0] ?? { used_calls: 0, used_credits: 0 };
  return { ...row, principalCalls: principal.used_calls, principalCredits: principal.used_credits };
}

async function dispatch(job: Job, attempt: { attemptId: string; fenceToken: string }, now = at(NOW, 2_000)) {
  expect(await markOfapiAttemptDispatching(testDb!.db, {
    ...attempt, jobLeaseToken: job.leaseToken, now,
  })).toBe(true);
}

async function capture(attempt: { attemptId: string; fenceToken: string }, settledCredits: number | null) {
  await captureOfapiAttemptResponse(testDb!.db, {
    ...attempt,
    responseObservedAt: at(NOW, 3_000),
    httpStatus: 200,
    httpOutcome: "success",
    responseHeaders: { "content-type": "application/json" },
    bodyBytes: Buffer.from(JSON.stringify({ ok: randomUUID() })),
    request: { method: "POST" },
    producer: "test",
    observationKind: "ofapi.response.v1",
    settledCredits,
    now: at(NOW, 3_000),
  });
}

describe("OFAPI vault album credit account", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    if (!testDb) return;
    await resetIntegrationDatabase(testDb.pool);
    await seedCreditState();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("admits nothing above the albums' own ceiling and records the denial under its scope", async () => {
    if (!testDb) return;
    const first = await leasedJob("vault_album");
    await admitted(first, "vault_album", { credits: 6, scopeCap: 10 });
    const second = await leasedJob("vault_album");
    expect(await reserve(second, "vault_album", { credits: 5, scopeCap: 10 }))
      .toMatchObject({ admitted: false, reason: "scope_cap" });
    const third = await leasedJob("vault_album");
    await admitted(third, "vault_album", { credits: 4, scopeCap: 10 });
    const zero = await leasedJob("vault_album");
    expect(await reserve(zero, "vault_album", { credits: 1, scopeCap: 0 }))
      .toMatchObject({ admitted: false, reason: "scope_cap" });

    expect(await counters()).toMatchObject({
      spent_credits: 0, bulk_spent_credits: 0, vault_album_spent_credits: 10,
      governed_unsettled_credits: 10, principalCalls: 0, principalCredits: 0,
    });
    const denials = await testDb.pool.query(
      "select scope, reason, denied_count::int from ofapi_budget_denial_daily order by page_id",
    );
    expect(denials.rows).toEqual([
      { scope: "vault_album", reason: "scope_cap", denied_count: 1 },
      { scope: "vault_album", reason: "scope_cap", denied_count: 1 },
    ]);
  });

  it("keeps albums and reads out of each other's limits, the per-user ones included", async () => {
    if (!testDb) return;
    // Reads fill the common day budget and the person's credit allowance.
    const read = await leasedJob("bulk");
    await admitted(read, "bulk", { credits: 10, globalCap: 10, principalCreditCap: 10 });
    const album = await leasedJob("vault_album");
    await admitted(album, "vault_album", {
      credits: 8, scopeCap: 8, globalCap: 10, principalCreditCap: 10,
    });
    // The album took nothing from the reads, and the reads are still full.
    // (A denial parks its job, so each try below takes a fresh one.)
    expect(await reserve(await leasedJob("bulk"), "bulk", { credits: 1, globalCap: 10 }))
      .toMatchObject({ admitted: false, reason: "global_cap" });
    expect(await reserve(await leasedJob("bulk"), "bulk", { credits: 1, globalCap: 11 }))
      .toMatchObject({ admitted: true });
    // The albums' ceiling is full; reads did not use it.
    const albumAgain = await leasedJob("vault_album");
    expect(await reserve(albumAgain, "vault_album", { credits: 1, scopeCap: 8 }))
      .toMatchObject({ admitted: false, reason: "scope_cap" });

    expect(await counters()).toMatchObject({
      spent_credits: 11, bulk_spent_credits: 11, vault_album_spent_credits: 8,
      governed_unsettled_credits: 19, principalCalls: 2, principalCredits: 11,
    });
  });

  it("still holds an album to the balance floor and counts it in the unsettled pool", async () => {
    if (!testDb) return;
    await testDb.pool.query("update ofapi_credit_state set last_balance = 100 where id = 1");
    const read = await leasedJob("bulk");
    await admitted(read, "bulk", { credits: 30, creditFloor: 10 });
    const album = await leasedJob("vault_album");
    // 100 − 30 unsettled − 50 = 20 < the reserve of 25.
    expect(await reserve(album, "vault_album", { credits: 50, creditFloor: 25 }))
      .toMatchObject({ admitted: false, reason: "credit_floor" });
    await admitted(await leasedJob("vault_album"), "vault_album", { credits: 45, creditFloor: 25 });
    const read2 = await leasedJob("bulk");
    // 100 − 75 unsettled − 20 = 5 < 10: the album's reserve weighs on reads' floor too.
    expect(await reserve(read2, "bulk", { credits: 20, creditFloor: 10 }))
      .toMatchObject({ admitted: false, reason: "credit_floor" });
  });

  it("never moves the common or per-user counters when an album's reservation is released, settled or corrected", async () => {
    if (!testDb) return;
    const read = await leasedJob("bulk");
    const readAttempt = await admitted(read, "bulk", { credits: 3 });
    const before = await counters();
    expect(before).toMatchObject({
      spent_credits: 3, bulk_spent_credits: 3, principalCalls: 1, principalCredits: 3,
    });

    // Released before dispatch.
    const released = await leasedJob("vault_album");
    const releasedAttempt = await admitted(released, "vault_album", { credits: 5 });
    expect(await releaseOfapiAttemptPreDispatch(testDb.db, {
      ...releasedAttempt, reasonCode: "test_release", now: at(NOW, 1_500),
    })).toBe(true);
    expect(await counters()).toMatchObject({
      spent_credits: 3, bulk_spent_credits: 3, vault_album_spent_credits: 0,
      governed_unsettled_credits: 3, principalCalls: 1, principalCredits: 3,
    });

    // Settled by the response's actual charge.
    const settled = await leasedJob("vault_album");
    const settledAttempt = await admitted(settled, "vault_album", { credits: 5 });
    await dispatch(settled, settledAttempt);
    await capture(settledAttempt, 7);
    expect(await counters()).toMatchObject({
      spent_credits: 3, vault_album_spent_credits: 7, governed_unsettled_credits: 3,
      principalCalls: 1, principalCredits: 3,
    });

    // Settled at the estimate, then corrected by the provider receipt.
    const receipt = await leasedJob("vault_album");
    const receiptAttempt = await admitted(receipt, "vault_album", { credits: 5 });
    await dispatch(receipt, receiptAttempt);
    await capture(receiptAttempt, null);
    expect(await reconcileOfapiCapturedAttemptCredit(testDb.db, {
      attemptId: receiptAttempt.attemptId, actualCredits: 6, now: at(NOW, 4_000),
    })).toBe(true);
    expect(await counters()).toMatchObject({
      spent_credits: 3, vault_album_spent_credits: 13, principalCredits: 3,
    });

    // Lost response, corrected later by the owner.
    const late = await leasedJob("vault_album");
    const lateAttempt = await admitted(late, "vault_album", { credits: 5 });
    await dispatch(late, lateAttempt);
    expect(await markOfapiAttemptIndeterminate(testDb.db, {
      ...lateAttempt, outcome: "transport", now: at(NOW, 3_000),
    })).toBe(true);
    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: lateAttempt.attemptId, resolution: "confirmed_billed", actualCredits: 2,
      actorUserId: ownerId, reason: "test", now: at(NOW, 5_000),
    })).toBe(true);
    expect(await counters()).toMatchObject({
      spent_credits: 3, bulk_spent_credits: 3, live_spent_credits: 0, interactive_spent_credits: 0,
      vault_album_spent_credits: 15, governed_unsettled_credits: 3,
      principalCalls: 1, principalCredits: 3,
    });

    // The read's own life cycle is untouched by all of the above.
    expect(await releaseOfapiAttemptPreDispatch(testDb.db, {
      ...readAttempt, reasonCode: "test_release", now: at(NOW, 6_000),
    })).toBe(true);
    expect(await counters()).toMatchObject({
      spent_credits: 0, bulk_spent_credits: 0, vault_album_spent_credits: 15,
      governed_unsettled_credits: 0, principalCalls: 0, principalCredits: 0,
    });
  });

  it("does not spend the ceiling twice when two albums race at its edge", async () => {
    if (!testDb) return;
    const jobs = await Promise.all([leasedJob("vault_album"), leasedJob("vault_album")]);
    const results = await Promise.all(jobs.map((job) => reserve(job, "vault_album", { credits: 6, scopeCap: 10 })));
    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect(results.filter((result) => !result.admitted)).toEqual([
      { admitted: false, reason: "scope_cap", retryAt: expect.any(Date) },
    ]);
    expect(await counters()).toMatchObject({ vault_album_spent_credits: 6, spent_credits: 0 });
  });

  it("books corrections to the reservation's own day across a day change", async () => {
    if (!testDb) return;
    // Day 1: one album lost its response, one waits before dispatch.
    const lost = await leasedJob("vault_album");
    const lostAttempt = await admitted(lost, "vault_album", { credits: 5, scopeCap: 10 });
    await dispatch(lost, lostAttempt);
    expect(await markOfapiAttemptIndeterminate(testDb.db, {
      ...lostAttempt, outcome: "transport", now: at(NOW, 3_000),
    })).toBe(true);
    const waiting = await leasedJob("vault_album");
    const waitingAttempt = await admitted(waiting, "vault_album", { credits: 4, scopeCap: 10 });
    const read = await leasedJob("bulk");
    await admitted(read, "bulk", { credits: 2 });
    expect(await counters()).toMatchObject({
      vault_album_spend_day: "2026-07-16", vault_album_spent_credits: 9, spent_credits: 2,
    });

    // Day 2 starts with a fresh ceiling: day 1's spend neither carries over…
    const next = await leasedJob("vault_album", NEXT_DAY);
    await admitted(next, "vault_album", { credits: 10, scopeCap: 10, now: at(NEXT_DAY, 1_000) });
    expect(await counters()).toMatchObject({
      vault_album_spend_day: "2026-07-17", vault_album_spent_credits: 10,
      spend_day: "2026-07-16", spent_credits: 2,
    });

    // …nor do day 1's late correction and release land on day 2.
    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: lostAttempt.attemptId, resolution: "confirmed_not_billed",
      actorUserId: ownerId, reason: "test", now: at(NEXT_DAY, 2_000),
    })).toBe(true);
    expect(await releaseOfapiAttemptPreDispatch(testDb.db, {
      ...waitingAttempt, reasonCode: "test_release", now: at(NEXT_DAY, 3_000),
    })).toBe(true);
    expect(await counters()).toMatchObject({
      vault_album_spend_day: "2026-07-17", vault_album_spent_credits: 10,
      spend_day: "2026-07-16", spent_credits: 2, governed_unsettled_credits: 12,
    });
    // The ledger keeps day 1's charge and its correction exactly once.
    const ledger = await testDb.pool.query<{ credits: number }>(
      "select credits from ofapi_credit_ledger where attempt_id = $1 order by id",
      [lostAttempt.attemptId],
    );
    expect(ledger.rows.map((row) => row.credits)).toEqual([5, -5]);
  });
});
