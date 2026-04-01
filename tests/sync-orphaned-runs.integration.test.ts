import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeInactiveSyncRuns,
  closeOrphanedSyncRuns,
  createFanslyPage,
  createModel,
  getSyncRun,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
  startSyncRun,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function setRunStartedAt(
  testDb: StartedTestDatabase,
  runId: number,
  startedAt: Date,
) {
  await testDb.pool.query(
    "update sync_runs set started_at = $1 where id = $2",
    [startedAt, runId],
  );
}

describe("closeOrphanedSyncRuns", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("closes orphaned running runs, preserves observability rows, and is idempotent", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "orphaned-sync-runs",
      name: "Orphaned Sync Runs",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "orphaned-sync-page",
    });

    const cutoff = new Date("2026-03-20T16:00:00.000Z");
    const cleanupFinishedAt = new Date("2026-03-20T16:05:00.000Z");
    const failedRunStartedAt = new Date("2026-03-20T15:30:00.000Z");
    const partialRunStartedAt = new Date("2026-03-20T15:40:00.000Z");
    const activeRunStartedAt = new Date("2026-03-20T16:01:00.000Z");

    const failedRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "light",
      trigger: "worker",
    });
    const partialRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "dm_messages",
      trigger: "worker",
    });
    const activeRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "followers",
      trigger: "worker",
    });

    await Promise.all([
      setRunStartedAt(testDb, failedRun.id, failedRunStartedAt),
      setRunStartedAt(testDb, partialRun.id, partialRunStartedAt),
      setRunStartedAt(testDb, activeRun.id, activeRunStartedAt),
    ]);

    await insertSyncRequestAttempt(testDb.db, {
      syncRunId: failedRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "light",
      operation: "account_me",
      logicalRequestId: `account_me:${failedRun.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "account_me" },
      startedAt: new Date("2026-03-20T15:31:00.000Z"),
    });
    await insertSyncRequestAttempt(testDb.db, {
      syncRunId: partialRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "dm_messages",
      operation: "messages_page",
      logicalRequestId: `messages_page:${partialRun.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "messages_page" },
      startedAt: new Date("2026-03-20T15:41:00.000Z"),
    });
    await insertSyncRunEvent(testDb.db, {
      syncRunId: partialRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "dm_messages",
      eventType: "checkpoint_advanced",
      severity: "info",
      message: "Advanced dm_messages checkpoint",
      emittedAt: new Date("2026-03-20T15:42:00.000Z"),
    });

    const cleanupResult = await closeOrphanedSyncRuns(testDb.db, {
      startedBefore: cutoff,
      finishedAt: cleanupFinishedAt,
      errorSummary: "Worker restarted",
    });

    expect(cleanupResult).toEqual({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });

    const [failedRunAfterCleanup, partialRunAfterCleanup, activeRunAfterCleanup] = await Promise.all([
      getSyncRun(testDb.db, failedRun.id),
      getSyncRun(testDb.db, partialRun.id),
      getSyncRun(testDb.db, activeRun.id),
    ]);

    expect(failedRunAfterCleanup).toMatchObject({
      runId: failedRun.id,
      status: "failed",
      errorSummary: "Worker restarted",
    });
    expect(failedRunAfterCleanup?.finishedAt?.toISOString()).toBe(cleanupFinishedAt.toISOString());
    expect(partialRunAfterCleanup).toMatchObject({
      runId: partialRun.id,
      status: "partial",
      errorSummary: "Worker restarted",
    });
    expect(partialRunAfterCleanup?.finishedAt?.toISOString()).toBe(cleanupFinishedAt.toISOString());
    expect(activeRunAfterCleanup).toMatchObject({
      runId: activeRun.id,
      status: "running",
      errorSummary: null,
      finishedAt: null,
    });

    const attemptCount = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from sync_http_attempts
      where sync_run_id in (${failedRun.id}, ${partialRun.id})
    `);
    const eventCount = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from sync_run_events
      where sync_run_id = ${partialRun.id}
    `);

    expect(attemptCount.rows[0]?.count).toBe(2);
    expect(eventCount.rows[0]?.count).toBe(1);

    const secondCleanup = await closeOrphanedSyncRuns(testDb.db, {
      startedBefore: cutoff,
      finishedAt: new Date("2026-03-20T16:10:00.000Z"),
      errorSummary: "Worker restarted",
    });

    expect(secondCleanup).toEqual({
      totalCount: 0,
      failedCount: 0,
      partialCount: 0,
    });
  });
});

describe("closeInactiveSyncRuns", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("closes only runs whose derived last activity is older than the inactivity cutoff", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "inactive-sync-runs",
      name: "Inactive Sync Runs",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "inactive-sync-page",
    });

    const inactiveBefore = new Date("2026-03-20T16:00:00.000Z");
    const cleanupFinishedAt = new Date("2026-03-20T16:03:00.000Z");

    const inactiveFailedRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "light",
      trigger: "worker",
    });
    const inactivePartialRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "dm_messages",
      trigger: "worker",
    });
    const activeByRecentRequestRun = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "followers",
      trigger: "worker",
    });

    await Promise.all([
      setRunStartedAt(testDb, inactiveFailedRun.id, new Date("2026-03-20T15:20:00.000Z")),
      setRunStartedAt(testDb, inactivePartialRun.id, new Date("2026-03-20T15:30:00.000Z")),
      setRunStartedAt(testDb, activeByRecentRequestRun.id, new Date("2026-03-20T15:00:00.000Z")),
    ]);

    await insertSyncRequestAttempt(testDb.db, {
      syncRunId: inactiveFailedRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "light",
      operation: "account_me",
      logicalRequestId: `account_me:${inactiveFailedRun.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "account_me" },
      startedAt: new Date("2026-03-20T15:21:00.000Z"),
    });
    await insertSyncRequestAttempt(testDb.db, {
      syncRunId: inactivePartialRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "dm_messages",
      operation: "messages_page",
      logicalRequestId: `messages_page:${inactivePartialRun.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "messages_page" },
      startedAt: new Date("2026-03-20T15:31:00.000Z"),
    });
    await insertSyncRunEvent(testDb.db, {
      syncRunId: inactivePartialRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "dm_messages",
      eventType: "checkpoint_advanced",
      severity: "info",
      message: "Advanced dm_messages checkpoint",
      emittedAt: new Date("2026-03-20T15:32:00.000Z"),
    });
    await insertSyncRequestAttempt(testDb.db, {
      syncRunId: activeByRecentRequestRun.id,
      platformAccountId: page.id,
      provider: "fansly",
      stream: "followers",
      operation: "followers",
      logicalRequestId: `followers:${activeByRecentRequestRun.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "followers" },
      startedAt: new Date("2026-03-20T16:01:00.000Z"),
    });

    const cleanupResult = await closeInactiveSyncRuns(testDb.db, {
      inactiveBefore,
      finishedAt: cleanupFinishedAt,
      errorSummary: "Sync run auto-closed after inactivity",
    });

    expect(cleanupResult).toEqual({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });

    const [failedRunAfterCleanup, partialRunAfterCleanup, activeRunAfterCleanup] = await Promise.all([
      getSyncRun(testDb.db, inactiveFailedRun.id),
      getSyncRun(testDb.db, inactivePartialRun.id),
      getSyncRun(testDb.db, activeByRecentRequestRun.id),
    ]);

    expect(failedRunAfterCleanup).toMatchObject({
      runId: inactiveFailedRun.id,
      status: "failed",
      errorSummary: "Sync run auto-closed after inactivity",
    });
    expect(failedRunAfterCleanup?.finishedAt?.toISOString()).toBe(cleanupFinishedAt.toISOString());
    expect(partialRunAfterCleanup).toMatchObject({
      runId: inactivePartialRun.id,
      status: "partial",
      errorSummary: "Sync run auto-closed after inactivity",
    });
    expect(partialRunAfterCleanup?.finishedAt?.toISOString()).toBe(cleanupFinishedAt.toISOString());
    expect(activeRunAfterCleanup).toMatchObject({
      runId: activeByRecentRequestRun.id,
      status: "running",
      errorSummary: null,
      finishedAt: null,
    });

    const attemptCount = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from sync_http_attempts
      where sync_run_id in (${inactiveFailedRun.id}, ${inactivePartialRun.id}, ${activeByRecentRequestRun.id})
    `);
    const eventCount = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from sync_run_events
      where sync_run_id = ${inactivePartialRun.id}
    `);

    expect(attemptCount.rows[0]?.count).toBe(3);
    expect(eventCount.rows[0]?.count).toBe(1);

    const secondCleanup = await closeInactiveSyncRuns(testDb.db, {
      inactiveBefore,
      finishedAt: new Date("2026-03-20T16:06:00.000Z"),
      errorSummary: "Sync run auto-closed after inactivity",
    });

    expect(secondCleanup).toEqual({
      totalCount: 0,
      failedCount: 0,
      partialCount: 0,
    });
  });
});
