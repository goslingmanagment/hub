import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND,
  getPageSyncState,
  pausePageSync,
  pausePageSyncForAuth,
  reconcileFanslyBulkStreamGate,
  clearPageSyncAuthBlock,
  skipPageSync,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

async function seedFanslyPage(label: string) {
  if (!testDb) {
    throw new Error("Expected the integration database to be available");
  }

  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });
  if (!model) {
    throw new Error(`Expected to create model for ${label}`);
  }
  const page = await createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
  if (!page) {
    throw new Error(`Expected to create Fansly page ${label}`);
  }
  await ensurePageSyncStates(testDb.db, { pageId: page.id });
  return page;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

describe("Fansly bulk-stream durable feature gate", () => {
  it("settles an in-flight gated skip without refreshing success metadata", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("gate-skip-settlement");
    const previousProgressedAt = new Date("2026-07-30T10:00:00.000Z");
    const previousSucceededAt = new Date("2026-07-30T09:00:00.000Z");
    const requestedAt = new Date("2026-08-01T11:59:00.000Z");
    const completedAt = new Date("2026-08-01T12:00:00.000Z");
    await testDb.pool.query(`
      update page_sync_states
      set status = 'idle',
          request_seq = applied_seq,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          leased_seq = null,
          lease_owner = null,
          lease_token = null,
          lease_heartbeat_at = null,
          lease_expires_at = null
      where page_id = $1
    `, [page.id]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'pending',
          request_seq = 4,
          applied_seq = 3,
          request_source = 'scheduled',
          dispatch_source = 'scheduled',
          requested_at = $2,
          progressed_at = $3,
          succeeded_at = $4,
          consecutive_failures = 2,
          last_error_code = 'previous_error',
          last_error_summary = 'previous failure',
          progress = '{"pendingTargets":17}'::jsonb
      where page_id = $1 and stream = 'fan_earnings'
    `, [page.id, requestedAt, previousProgressedAt, previousSucceededAt]);

    const lease = await acquirePageSyncLease(testDb.db, {
      pageId: page.id,
      workerId: "gate-skip-worker",
      leaseToken: "gate-skip-token",
      leaseTtlMs: 60_000,
      now: completedAt,
    });
    expect(lease?.stream).toBe("fan_earnings");

    await expect(skipPageSync(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      requestSeq: lease?.leasedSeq ?? 4,
      leaseToken: "gate-skip-token",
      progress: { skipped: "not_allowlisted" },
      now: new Date(completedAt.getTime() + 1_000),
    })).resolves.toBe(true);

    expect(await getPageSyncState(testDb.db, page.id, "fan_earnings")).toMatchObject({
      status: "idle",
      requestSeq: 4,
      appliedSeq: 4,
      progressedAt: previousProgressedAt,
      succeededAt: previousSucceededAt,
      consecutiveFailures: 2,
      lastErrorCode: "previous_error",
      lastErrorSummary: "previous failure",
      progress: { skipped: "not_allowlisted" },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("parks idle, pending, retrying, and dependency-blocked work with an owned marker", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const firstPage = await seedFanslyPage("gate-disabled-first");
    const secondPage = await seedFanslyPage("gate-disabled-second");
    const retryAt = new Date("2026-08-01T12:30:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    await testDb.pool.query(`
      update page_sync_states
      set status = 'idle',
          request_seq = 1,
          applied_seq = 1,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          retry_kind = null,
          retry_at = null
      where page_id = $1 and stream = 'fan_earnings'
    `, [firstPage.id]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'pending',
          request_seq = 2,
          applied_seq = 1,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          retry_kind = null,
          retry_at = null
      where page_id = $1 and stream = 'purchase_history'
    `, [firstPage.id]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'retrying',
          request_seq = 3,
          applied_seq = 2,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          retry_kind = 'provider',
          retry_at = $2
      where page_id = $1 and stream = 'fan_earnings'
    `, [secondPage.id, retryAt]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'blocked',
          request_seq = 2,
          applied_seq = 1,
          blocker_kind = 'dependency',
          blocker_code = 'unmet_dependency',
          blocker_message = 'light is not ready',
          blocked_at = $2
      where page_id = $1 and stream = 'purchase_history'
    `, [secondPage.id, new Date("2026-08-01T11:00:00.000Z")]);

    const transitions = await Promise.all([
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: firstPage.id,
        stream: "fan_earnings",
        gateState: "flag_off",
        now,
      }),
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: firstPage.id,
        stream: "purchase_history",
        gateState: "flag_off",
        now,
      }),
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: secondPage.id,
        stream: "fan_earnings",
        gateState: "not_allowlisted",
        now,
      }),
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: secondPage.id,
        stream: "purchase_history",
        gateState: "not_allowlisted",
        now,
      }),
    ]);

    expect(transitions).toEqual([
      { action: "paused", createdRecoveryGeneration: false },
      { action: "paused", createdRecoveryGeneration: false },
      { action: "paused", createdRecoveryGeneration: false },
      { action: "paused", createdRecoveryGeneration: false },
    ]);

    for (const [pageId, stream, blockerCode] of [
      [firstPage.id, "fan_earnings", "flag_off"],
      [firstPage.id, "purchase_history", "flag_off"],
      [secondPage.id, "fan_earnings", "not_allowlisted"],
      [secondPage.id, "purchase_history", "not_allowlisted"],
    ] as const) {
      expect(await getPageSyncState(testDb.db, pageId, stream)).toMatchObject({
        status: "paused",
        blockerKind: FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND,
        blockerCode,
        blockedAt: now,
      });
    }

    const retryingState = await getPageSyncState(
      testDb.db,
      secondPage.id,
      "fan_earnings",
    );
    expect(retryingState).toMatchObject({
      retryKind: "provider",
      retryAt,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not take ownership from running, auth-blocked, or manually paused/blocked rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const runningPage = await seedFanslyPage("gate-running");
    const protectedPage = await seedFanslyPage("gate-protected");
    const manualBlockedPage = await seedFanslyPage("gate-manual-blocked");
    const now = new Date("2026-08-01T13:00:00.000Z");

    await testDb.pool.query(`
      update page_sync_states
      set status = 'running',
          request_seq = 2,
          applied_seq = 1,
          leased_seq = 2,
          lease_owner = 'active-worker',
          lease_token = 'active-token',
          lease_heartbeat_at = $2::timestamptz,
          lease_expires_at = $2::timestamptz + interval '1 minute',
          blocker_kind = null
      where page_id = $1 and stream = 'fan_earnings'
    `, [runningPage.id, now]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'paused',
          blocker_kind = 'auth',
          blocker_code = 'session_dead',
          blocker_message = 'Re-authentication required',
          blocked_at = $2
      where page_id = $1 and stream = 'fan_earnings'
    `, [protectedPage.id, now]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'paused',
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          progress = '{"skipped":"flag_off"}'::jsonb
      where page_id = $1 and stream = 'purchase_history'
    `, [protectedPage.id]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'blocked',
          blocker_kind = 'auth',
          blocker_code = 'session_dead',
          blocker_message = 'Re-authentication required',
          blocked_at = $2
      where page_id = $1 and stream = 'fan_earnings'
    `, [manualBlockedPage.id, now]);
    await testDb.pool.query(`
      update page_sync_states
      set status = 'blocked',
          blocker_kind = 'manual',
          blocker_code = 'operator_hold',
          blocker_message = 'Held by operator',
          blocked_at = $2
      where page_id = $1 and stream = 'purchase_history'
    `, [manualBlockedPage.id, now]);

    const targets = [
      [runningPage.id, "fan_earnings"],
      [protectedPage.id, "fan_earnings"],
      [protectedPage.id, "purchase_history"],
      [manualBlockedPage.id, "fan_earnings"],
      [manualBlockedPage.id, "purchase_history"],
    ] as const;

    for (const [pageId, stream] of targets) {
      expect(await reconcileFanslyBulkStreamGate(testDb.db, {
        pageId,
        stream,
        gateState: "flag_off",
        now,
      })).toEqual({
        action: "unchanged",
        createdRecoveryGeneration: false,
      });
      expect(await reconcileFanslyBulkStreamGate(testDb.db, {
        pageId,
        stream,
        gateState: "ramped",
        now,
      })).toEqual({
        action: "unchanged",
        createdRecoveryGeneration: false,
      });
    }

    expect(await getPageSyncState(testDb.db, runningPage.id, "fan_earnings"))
      .toMatchObject({
        status: "running",
        leaseOwner: "active-worker",
        leaseToken: "active-token",
        blockerKind: null,
      });
    expect(await getPageSyncState(testDb.db, protectedPage.id, "fan_earnings"))
      .toMatchObject({
        status: "paused",
        blockerKind: "auth",
        blockerCode: "session_dead",
      });
    expect(await getPageSyncState(testDb.db, protectedPage.id, "purchase_history"))
      .toMatchObject({
        status: "paused",
        blockerKind: null,
        progress: { skipped: "flag_off" },
      });
    expect(await getPageSyncState(testDb.db, manualBlockedPage.id, "fan_earnings"))
      .toMatchObject({
        status: "blocked",
        blockerKind: "auth",
      });
    expect(await getPageSyncState(testDb.db, manualBlockedPage.id, "purchase_history"))
      .toMatchObject({
        status: "blocked",
        blockerKind: "manual",
      });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not undo a later operator pause layered over the feature gate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("gate-operator-overlay");
    await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "flag_off",
      now: new Date("2026-08-01T13:00:00.000Z"),
    });
    await pausePageSync(testDb.db, {
      pageId: page.id,
      streams: ["fan_earnings"],
      now: new Date("2026-08-01T13:05:00.000Z"),
    });

    expect(await getPageSyncState(testDb.db, page.id, "fan_earnings")).toMatchObject({
      status: "paused",
      blockerKind: null,
      blockerCode: null,
    });
    expect(await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "ramped",
      now: new Date("2026-08-01T13:10:00.000Z"),
    })).toEqual({
      action: "unchanged",
      createdRecoveryGeneration: false,
    });
    expect((await getPageSyncState(testDb.db, page.id, "fan_earnings"))?.status)
      .toBe("paused");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("preserves feature-gate ownership through a page-wide auth pause", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("gate-auth-overlay");
    const gatedAt = new Date("2026-08-01T13:00:00.000Z");
    await testDb.pool.query(`
      update page_sync_states
      set status = 'idle',
          request_seq = applied_seq,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          blocked_at = null
      where page_id = $1 and stream = 'fan_earnings'
    `, [page.id]);
    await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "not_allowlisted",
      now: gatedAt,
    });
    await pausePageSyncForAuth(testDb.db, {
      pageId: page.id,
      streams: ["fan_earnings", "purchase_history"],
      blockerCode: "session_dead",
      blockerMessage: "Re-authentication required",
      now: new Date("2026-08-01T13:05:00.000Z"),
    });

    expect(await getPageSyncState(testDb.db, page.id, "fan_earnings")).toMatchObject({
      status: "paused",
      blockerKind: FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND,
      blockerCode: "not_allowlisted",
      blockedAt: gatedAt,
    });
    expect(await getPageSyncState(testDb.db, page.id, "purchase_history")).toMatchObject({
      status: "paused",
      blockerKind: "auth",
      blockerCode: "session_dead",
    });
    const refreshedAuthAt = new Date("2026-08-01T13:07:00.000Z");
    await pausePageSyncForAuth(testDb.db, {
      pageId: page.id,
      streams: ["fan_earnings", "purchase_history"],
      blockerCode: "session_still_dead",
      blockerMessage: "Re-authentication is still required",
      now: refreshedAuthAt,
    });
    expect(await getPageSyncState(testDb.db, page.id, "fan_earnings")).toMatchObject({
      blockerKind: FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND,
      blockerCode: "not_allowlisted",
      blockedAt: gatedAt,
    });
    expect(await getPageSyncState(testDb.db, page.id, "purchase_history")).toMatchObject({
      blockerKind: "auth",
      blockerCode: "session_still_dead",
      blockedAt: refreshedAuthAt,
    });

    await clearPageSyncAuthBlock(testDb.db, page.id, {
      now: new Date("2026-08-01T13:10:00.000Z"),
    });
    expect((await getPageSyncState(testDb.db, page.id, "fan_earnings"))?.blockerKind)
      .toBe(FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND);

    expect(await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "ramped",
      now: new Date("2026-08-01T13:15:00.000Z"),
    })).toEqual({
      action: "resumed",
      createdRecoveryGeneration: true,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resumes only its marker, preserves active provider backoff, and keeps the outstanding generation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("gate-backoff-resume");
    const pausedAt = new Date("2026-08-01T13:00:00.000Z");
    const now = new Date("2026-08-01T14:00:00.000Z");
    const retryAt = new Date("2026-08-01T14:30:00.000Z");

    await testDb.pool.query(`
      update page_sync_states
      set status = 'paused',
          request_seq = 5,
          applied_seq = 4,
          request_source = 'scheduled',
          dispatch_source = 'scheduled',
          retry_kind = 'provider',
          retry_at = $2,
          blocker_kind = $3,
          blocker_code = 'flag_off',
          blocker_message = 'feature flag off',
          blocked_at = $4,
          progress = '{"records":3,"skipped":"flag_off"}'::jsonb
      where page_id = $1 and stream = 'fan_earnings'
    `, [
      page.id,
      retryAt,
      FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND,
      pausedAt,
    ]);

    expect(await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "ramped",
      now,
    })).toEqual({
      action: "resumed",
      createdRecoveryGeneration: false,
    });

    expect(await getPageSyncState(testDb.db, page.id, "fan_earnings")).toMatchObject({
      status: "retrying",
      requestSeq: 5,
      appliedSeq: 4,
      requestSource: "scheduled",
      dispatchSource: "scheduled",
      retryKind: "provider",
      retryAt,
      blockerKind: null,
      blockerCode: null,
      blockerMessage: null,
      blockedAt: null,
      progress: { records: 3 },
    });

    expect(await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "fan_earnings",
      gateState: "ramped",
      now: new Date(now.getTime() + 1_000),
    })).toEqual({
      action: "unchanged",
      createdRecoveryGeneration: false,
    });
    expect((await getPageSyncState(testDb.db, page.id, "fan_earnings"))?.requestSeq).toBe(5);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("turns a legacy skipped success into exactly one recovery generation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("gate-legacy-resume");
    const now = new Date("2026-08-01T15:00:00.000Z");

    await testDb.pool.query(`
      update page_sync_states
      set status = 'idle',
          request_seq = 7,
          applied_seq = 7,
          request_source = 'scheduled',
          dispatch_source = 'scheduled',
          request_payload = '{"old":true}'::jsonb,
          blocker_kind = null,
          blocker_code = null,
          blocker_message = null,
          blocked_at = null,
          progress = '{"records":11,"skipped":"not_allowlisted"}'::jsonb
      where page_id = $1 and stream = 'purchase_history'
    `, [page.id]);

    const concurrentResults = await Promise.all([
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: page.id,
        stream: "purchase_history",
        gateState: "ramped",
        now,
      }),
      reconcileFanslyBulkStreamGate(testDb.db, {
        pageId: page.id,
        stream: "purchase_history",
        gateState: "ramped",
        now,
      }),
    ]);
    expect(concurrentResults).toContainEqual({
      action: "resumed",
      createdRecoveryGeneration: true,
    });
    expect(concurrentResults).toContainEqual({
      action: "unchanged",
      createdRecoveryGeneration: false,
    });

    expect(await getPageSyncState(testDb.db, page.id, "purchase_history")).toMatchObject({
      status: "pending",
      requestSeq: 8,
      appliedSeq: 7,
      requestSource: "recovery",
      dispatchSource: "recovery",
      requestPayload: {},
      requestedAt: now,
      blockerKind: null,
      progress: { records: 11 },
    });

    expect(await reconcileFanslyBulkStreamGate(testDb.db, {
      pageId: page.id,
      stream: "purchase_history",
      gateState: "ramped",
      now: new Date(now.getTime() + 1_000),
    })).toEqual({
      action: "unchanged",
      createdRecoveryGeneration: false,
    });
    expect((await getPageSyncState(testDb.db, page.id, "purchase_history"))?.requestSeq).toBe(8);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
