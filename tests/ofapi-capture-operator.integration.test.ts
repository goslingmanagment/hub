import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  createUser,
  getOfapiCaptureJob,
  getOfapiCaptureOperatorAttempt,
  leaseNextOfapiCaptureJob,
  markOfapiAttemptDispatching,
  markOfapiAttemptIndeterminate,
  reserveOfapiRequestAttempt,
  resolveOfapiIndeterminateAttempt,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { reconcileOwnerOfapiExportCreate } from "../apps/runtime/src/services/ofapi-capture-operator.ts";
import { buildOfapiExportQuoteRequest } from "../apps/runtime/src/services/ofapi-export-quotes.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

async function createUncertainExport() {
  const now = new Date();
  const owner = await createUser(testDb!.db, {
    username: `operator-${randomUUID()}`,
    role: "owner",
    passwordHash: "x",
  });
  const model = await createModel(testDb!.db, {
    slug: `operator-${randomUUID()}`,
    name: "Operator Test",
  });
  if (!owner || !model) throw new Error("operator fixture seed failed");
  const page = await createOnlyFansPage(testDb!.db, {
    modelId: model.id,
    label: `operator-${randomUUID()}`,
  });
  if (!page) throw new Error("operator page seed failed");
  const accountId = `acct_${randomUUID()}`;
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: accountId });
  await testDb!.pool.query(`
    insert into ofapi_credit_state (
      id, spend_day, spent_credits, governed_scope_day,
      live_spent_credits, interactive_spent_credits, bulk_spent_credits,
      governed_unsettled_credits, last_balance, last_balance_at, updated_at
    ) values (1, $1::date, 0, $1::date, 0, 0, 0, 0, 1000, $2, $2)
    on conflict (id) do update set
      spend_day = excluded.spend_day, spent_credits = 0,
      governed_scope_day = excluded.governed_scope_day,
      live_spent_credits = 0, interactive_spent_credits = 0,
      bulk_spent_credits = 0, governed_unsettled_credits = 0,
      last_balance = 1000, last_balance_at = excluded.last_balance_at,
      updated_at = excluded.updated_at
  `, [now.toISOString().slice(0, 10), now]);
  const created = await createOrGetOfapiCaptureJob(testDb!.db, {
    pageId: page.id,
    ofapiAccountId: accountId,
    kind: "account_export",
    activeSlotKey: `page:${page.id}:export`,
    target: {
      profile: "fleet_tail",
      type: "chat_messages",
      accountIds: [accountId],
      startDate: "2016-01-01T00:00:00.000Z",
      endDate: "2026-07-16T00:00:00.000Z",
      fileType: "csv",
      maxMessages: 10_000_000,
      quoteTtlMinutes: 1_440,
      chatIds: [],
      autoStart: false,
    },
    budgetScope: "bulk",
    originPrincipalId: owner.id,
    createdBy: "owner",
    maxCalls: 97,
    maxCredits: 5,
    now,
  });
  const leased = await leaseNextOfapiCaptureJob(testDb!.db, {
    pageId: page.id,
    leaseOwner: "operator-test",
    leaseTtlMs: 60_000,
    now,
  });
  if (!leased?.leaseToken) throw new Error("export job was not leased");
  const reservation = await reserveOfapiRequestAttempt(testDb!.db, {
    ownerKind: "capture_job",
    ownerId: created.job.id,
    pageId: page.id,
    ofapiAccountId: accountId,
    originPrincipalId: owner.id,
    budgetScope: "bulk",
    operation: "ofapi_export_quote_create",
    endpointClass: "data_exports",
    egressKey: `page:${page.id}`,
    method: "POST",
    requestSemantics: "stateful",
    requestShape: { autoStart: false },
    reservedCredits: 1,
    globalDailyCap: 100,
    scopeDailyCap: 100,
    creditFloor: 10,
    balanceMaxAgeMs: 60 * 60_000,
    jobLeaseToken: leased.leaseToken,
    deadlineAt: new Date(now.getTime() + 60_000),
    now,
  });
  if (!reservation.admitted) throw new Error(`attempt denied: ${reservation.reason}`);
  expect(await markOfapiAttemptDispatching(testDb!.db, {
    attemptId: reservation.attemptId,
    fenceToken: reservation.fenceToken,
    jobLeaseToken: leased.leaseToken,
    now: new Date(now.getTime() + 1_000),
  })).toBe(true);
  expect(await markOfapiAttemptIndeterminate(testDb!.db, {
    attemptId: reservation.attemptId,
    fenceToken: reservation.fenceToken,
    outcome: "transport",
    now: new Date(now.getTime() + 2_000),
  })).toBe(true);
  const job = await getOfapiCaptureJob(testDb!.db, created.job.id);
  if (!job) throw new Error("export job disappeared");
  return { app: createTestAppContext(testDb!), owner, job, attemptId: reservation.attemptId };
}

describe("OFAPI capture operator", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    if (testDb) await resetIntegrationDatabase(testDb.pool);
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("previews, resolves, and crash-safely adopts one uncertain create without another POST", async () => {
    if (!testDb) return;
    const fixture = await createUncertainExport();
    const payload = {
      action: "adopt_created" as const,
      attemptId: fixture.attemptId,
      expectedState: "blocked" as const,
      expectedReasonCode: "indeterminate" as const,
      expectedJobRowVersion: fixture.job.rowVersion,
      vendorExportId: "data_export_operator123",
      actualCredits: 3,
      reason: "independently verified in vendor console",
    };

    const preview = await reconcileOwnerOfapiExportCreate(fixture.app, {
      ...payload,
      dryRun: true,
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      status: "would_reconcile",
      job: { state: "retry_wait", rowVersion: fixture.job.rowVersion + 2 },
      attempt: {
        creditState: "settled",
        settledCredits: 3,
        certaintyResolution: "confirmed_billed",
      },
    });
    expect((await getOfapiCaptureJob(testDb.db, fixture.job.id))?.rowVersion)
      .toBe(fixture.job.rowVersion);

    expect(await resolveOfapiIndeterminateAttempt(testDb.db, {
      attemptId: fixture.attemptId,
      resolution: "confirmed_billed",
      actualCredits: 3,
      actorUserId: fixture.owner.id,
      reason: payload.reason,
    })).toBe(true);
    expect(await getOfapiCaptureJob(testDb.db, fixture.job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
      spentCredits: 3,
      rowVersion: fixture.job.rowVersion + 1,
    });

    // Simulate a process crash after certainty settlement but before the job
    // transition. The original owner CAS version remains the retry input.
    const executed = await reconcileOwnerOfapiExportCreate(fixture.app, {
      ...payload,
      dryRun: false,
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
    });
    expect(executed).toMatchObject({
      status: "reconciled",
      job: { state: "retry_wait", reasonCode: "export_create_reconciled" },
      attempt: { creditState: "settled", settledCredits: 3 },
    });
    const adopted = await getOfapiCaptureJob(testDb.db, fixture.job.id);
    expect(adopted).toMatchObject({ spentCredits: 3, rowVersion: fixture.job.rowVersion + 2 });
    const adoptedLease = await leaseNextOfapiCaptureJob(testDb.db, {
      pageId: fixture.job.pageId,
      leaseOwner: "operator-test-next",
      leaseTtlMs: 60_000,
    });
    expect(buildOfapiExportQuoteRequest(adoptedLease!)).toMatchObject({
      method: "GET",
      pathname: "/data-exports/data_export_operator123",
    });

    await expect(reconcileOwnerOfapiExportCreate(fixture.app, {
      ...payload,
      actualCredits: 4,
      dryRun: false,
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
    })).rejects.toThrow(/expected state/);
    const retry = await reconcileOwnerOfapiExportCreate(fixture.app, {
      ...payload,
      dryRun: false,
      jobId: fixture.job.id,
      actorUserId: fixture.owner.id,
    });
    expect(retry.status).toBe("reconciled");
    expect((await getOfapiCaptureOperatorAttempt(testDb.db, fixture.attemptId)))
      .toMatchObject({ certaintyResolution: "confirmed_billed", settledCredits: 3 });

    const notCreated = await createUncertainExport();
    const released = await reconcileOwnerOfapiExportCreate(notCreated.app, {
      action: "confirm_not_created",
      attemptId: notCreated.attemptId,
      expectedState: "blocked",
      expectedReasonCode: "indeterminate",
      expectedJobRowVersion: notCreated.job.rowVersion,
      reason: "independently verified absent in vendor console",
      dryRun: false,
      jobId: notCreated.job.id,
      actorUserId: notCreated.owner.id,
    });
    expect(released).toMatchObject({
      status: "reconciled",
      job: { state: "blocked", reasonCode: "export_quote_failed" },
      attempt: { creditState: "released", settledCredits: 0 },
    });
    const releasedJob = await getOfapiCaptureJob(testDb.db, notCreated.job.id);
    expect(releasedJob).toMatchObject({ spentCredits: 0 });
    expect(buildOfapiExportQuoteRequest(releasedJob!)).toBeNull();
  });
});
