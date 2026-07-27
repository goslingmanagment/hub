import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramMocks = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/telegram.ts", () => ({
  sendTelegramMessage: telegramMocks.sendTelegramMessage,
}));

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  finishSyncRequestAttempt,
  getNotificationIncidentByKey,
  getPageSyncState,
  insertSyncRequestAttempt,
  listDeliveryAttempts,
  listNotificationIncidents,
  markPageSyncAuthBlocked,
  openNotificationIncident,
  resolveNotificationIncident,
  startSyncRun,
} from "@agency_hub_core/db";

import {
  handleSuccessfulPageVerificationRecovery,
  notifyAuthFailedIncident,
  notifySyncChunkFailureIncident,
  resolveSyncChunkRecoveryIncidents,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

describe("notification incidents integration", () => {
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
    telegramMocks.sendTelegramMessage.mockReset();
    telegramMocks.sendTelegramMessage.mockResolvedValue({
      status: "sent",
      chatId: "6065935464",
      messageId: 1,
    });

    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("opens auth incidents once, resolves them on recovery, and reopens after a later recurrence", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "auth-model",
      name: "Auth Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "auth-page",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: page.id,
    });

    const app = createTestAppContext(testDb);

    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorSummary: "session expired",
    });
    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorSummary: "session expired",
    });

    let incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendTelegramMessage).toHaveBeenLastCalledWith(expect.anything(), {
      text: expect.stringContaining("🚨 Auth failed"),
    });

    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      stream: "light",
    });

    incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident?.status).toBe("resolved");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(telegramMocks.sendTelegramMessage).toHaveBeenLastCalledWith(expect.anything(), {
      text: expect.stringContaining("✅ Resolved"),
    });

    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorSummary: "session expired again",
    });

    incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident?.status).toBe("open");
    expect(incident?.resolvedAt).toBeNull();
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(3);
  });

  it("records skipped Telegram attempts when an opened incident has no destination", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    telegramMocks.sendTelegramMessage.mockResolvedValue({
      status: "skipped",
      reason: "unconfigured",
    });

    const model = await createModel(testDb.db, {
      slug: "unconfigured-alert-model",
      name: "Unconfigured Alert Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "unconfigured-alert-page",
    });
    const app = createTestAppContext(testDb);

    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorSummary: "session expired",
    });

    const incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident?.status).toBe("open");

    const attempts = await listDeliveryAttempts(testDb.db, {
      kind: ["incident_opened"],
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "skipped",
      error: "unconfigured",
      notificationIncidentId: incident?.id,
    });
  });

  it("classifies proxied transport failures separately and opens stream incidents exactly at the third failure", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "failure-model",
      name: "Failure Model",
    });
    const proxiedPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "proxied-page",
    });
    const thresholdPage = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "threshold-page",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: proxiedPage.id,
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: thresholdPage.id,
    });

    const app = createTestAppContext(testDb);

    const proxiedRun = await startSyncRun(testDb.db, {
      platformAccountId: proxiedPage.id,
      stream: "followers",
      trigger: "worker",
    });
    const proxiedAttempt = await insertSyncRequestAttempt(testDb.db, {
      syncRunId: proxiedRun.id,
      platformAccountId: proxiedPage.id,
      provider: "fansly",
      stream: "followers",
      operation: "followers_page",
      logicalRequestId: "followers_page:1",
      attemptNumber: 1,
    });
    await finishSyncRequestAttempt(testDb.db, proxiedAttempt.id, {
      state: "failed",
      failureKind: "transport",
      errorMessage: "proxy connect failed",
    });

    await notifySyncChunkFailureIncident(app, {
      platformAccountId: proxiedPage.id,
      pageLabel: proxiedPage.label,
      platform: "fansly",
      stream: "followers",
      runId: proxiedRun.id,
      hasProxy: true,
      previousConsecutiveFailures: 0,
      errorSummary: "proxy connect failed",
    });
    await notifySyncChunkFailureIncident(app, {
      platformAccountId: proxiedPage.id,
      pageLabel: proxiedPage.label,
      platform: "fansly",
      stream: "followers",
      runId: proxiedRun.id,
      hasProxy: true,
      previousConsecutiveFailures: 1,
      errorSummary: "proxy connect failed",
    });

    let proxyIncident = await getNotificationIncidentByKey(testDb.db, `proxy_failed:${proxiedPage.id}`);
    expect(proxyIncident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);

    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: proxiedPage.id,
      pageLabel: proxiedPage.label,
      platform: "fansly",
      stream: "followers",
    });

    proxyIncident = await getNotificationIncidentByKey(testDb.db, `proxy_failed:${proxiedPage.id}`);
    expect(proxyIncident?.status).toBe("resolved");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(2);

    telegramMocks.sendTelegramMessage.mockClear();

    const thresholdRun = await startSyncRun(testDb.db, {
      platformAccountId: thresholdPage.id,
      stream: "subscribers",
      trigger: "worker",
    });

    await notifySyncChunkFailureIncident(app, {
      platformAccountId: thresholdPage.id,
      pageLabel: thresholdPage.label,
      platform: "fansly",
      stream: "subscribers",
      runId: thresholdRun.id,
      hasProxy: false,
      previousConsecutiveFailures: 1,
      errorSummary: "provider temporary failure",
    });

    expect(await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${thresholdPage.id}:subscribers`,
    )).toBeNull();
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await notifySyncChunkFailureIncident(app, {
      platformAccountId: thresholdPage.id,
      pageLabel: thresholdPage.label,
      platform: "fansly",
      stream: "subscribers",
      runId: thresholdRun.id,
      hasProxy: false,
      previousConsecutiveFailures: 2,
      errorSummary: "provider temporary failure",
    });
    await notifySyncChunkFailureIncident(app, {
      platformAccountId: thresholdPage.id,
      pageLabel: thresholdPage.label,
      platform: "fansly",
      stream: "subscribers",
      runId: thresholdRun.id,
      hasProxy: false,
      previousConsecutiveFailures: 3,
      errorSummary: "provider temporary failure",
    });

    const thresholdIncident = await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${thresholdPage.id}:subscribers`,
    );
    expect(thresholdIncident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(telegramMocks.sendTelegramMessage).toHaveBeenLastCalledWith(expect.anything(), {
      text: expect.stringContaining("Stream: subscribers"),
    });

    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: thresholdPage.id,
      pageLabel: thresholdPage.label,
      platform: "fansly",
      stream: "subscribers",
    });

    expect(await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${thresholdPage.id}:subscribers`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("opens a forced stream blocker incident below the retry threshold", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "forced-blocker-model",
      name: "Forced Blocker Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "forced-blocker-page",
    }))!;
    const app = createTestAppContext(testDb);
    const run = (await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "followers",
      trigger: "worker",
    }))!;

    await notifySyncChunkFailureIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      stream: "followers",
      runId: run.id,
      hasProxy: false,
      previousConsecutiveFailures: 0,
      forceOpen: true,
      errorSummary: "permanent provider failure",
    });

    expect(await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${page.id}:followers`,
    )).toEqual(expect.objectContaining({ status: "open" }));
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("detects terminal proxy failures from the newest attempt window instead of the oldest rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "latest-failure-model",
      name: "Latest Failure Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "latest-proxy-page",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: page.id,
    });

    const app = createTestAppContext(testDb);
    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "followers",
      trigger: "worker",
    });

    await testDb.pool.query(`
      insert into sync_http_attempts (
        sync_run_id,
        page_id,
        provider,
        stream,
        operation,
        logical_request_id,
        attempt_number,
        state,
        started_at,
        finished_at
      )
      select $1,
             $2,
             'fansly',
             'followers',
             'followers_page',
             'followers_page:' || gs::text,
             1,
             'success',
             timestamptz '2026-03-22T00:00:00.000Z' + make_interval(secs => gs),
             timestamptz '2026-03-22T00:00:00.000Z' + make_interval(secs => gs + 1)
      from generate_series(1, 2001) gs
    `, [run.id, page.id]);

    await testDb.pool.query(`
      insert into sync_http_attempts (
        sync_run_id,
        page_id,
        provider,
        stream,
        operation,
        logical_request_id,
        attempt_number,
        state,
        failure_kind,
        error_message,
        started_at,
        finished_at
      )
      values (
        $1,
        $2,
        'fansly',
        'followers',
        'followers_page',
        'followers_page:2002',
        1,
        'failed',
        'transport',
        'proxy connect failed',
        timestamptz '2026-03-23T00:00:00.000Z',
        timestamptz '2026-03-23T00:00:01.000Z'
      )
    `, [run.id, page.id]);

    await notifySyncChunkFailureIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      stream: "followers",
      runId: run.id,
      hasProxy: true,
      previousConsecutiveFailures: 0,
      errorSummary: "proxy connect failed",
    });

    const incident = await getNotificationIncidentByKey(testDb.db, `proxy_failed:${page.id}`);
    expect(incident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("opens one persisted incident under concurrent callers without throwing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "concurrency-model",
      name: "Concurrency Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "concurrency-page",
    });

    const currentTestDb = testDb;
    const now = new Date("2026-03-15T12:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        openNotificationIncident(currentTestDb.db, {
          incidentKey: `auth_blocked:${page.id}`,
          kind: "auth_blocked",
          platformAccountId: page.id,
          errorCode: "auth_blocked",
          errorSummary: "session expired",
          metadata: {
            pageLabel: page.label,
            platform: "fansly",
          },
          now,
        })),
    );

    expect(results).toHaveLength(8);
    expect(results.every((result) => result.incident.status === "open")).toBe(true);
    expect(results.filter((result) => result.transition === "opened")).toHaveLength(1);
    expect(results.every((result) => ["opened", "existing"].includes(result.transition))).toBe(true);

    const incidents = await listNotificationIncidents(testDb.db, {
      platformAccountId: page.id,
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toEqual(expect.objectContaining({
      incidentKey: `auth_blocked:${page.id}`,
      status: "open",
      errorCode: "auth_blocked",
      errorSummary: "session expired",
    }));
  });

  it("retries wrapped unique violations when concurrent opens lose the insert race", async () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const incident = {
      id: 1,
      incidentKey: "auth_blocked:1",
      kind: "auth_blocked",
      platformAccountId: 1,
      stream: null,
      status: "open",
      openedAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      errorCode: "auth_blocked",
      errorSummary: "session expired",
      metadata: {},
      updatedAt: now,
    };
    let transactionCount = 0;
    const fakeDb = {
      async transaction(callback: (tx: unknown) => Promise<unknown>) {
        transactionCount += 1;
        if (transactionCount === 1) {
          return callback({
            execute: vi.fn(async () => ({ rows: [] })),
            insert: vi.fn(() => ({
              values: vi.fn(() => ({
                returning: vi.fn(async () => {
                  const error = new Error("insert failed") as Error & { cause: { code: string } };
                  error.cause = { code: "23505" };
                  throw error;
                }),
              })),
            })),
          });
        }

        return callback({
          execute: vi.fn(async () => ({
            rows: [{
              id: 1,
              status: "open",
              resolvedAt: null,
              lastSeenAt: now,
            }],
          })),
          // The retried attempt sees `lastSeenAt === now`, i.e. the same event
          // it is replaying, so the repository reads the row back instead of
          // rewriting it.
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(async () => [incident]),
              })),
            })),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => ({
                returning: vi.fn(async () => [incident]),
              })),
            })),
          })),
        });
      },
    };

    const result = await openNotificationIncident(fakeDb as never, {
      incidentKey: "auth_blocked:1",
      kind: "auth_blocked",
      platformAccountId: 1,
      errorCode: "auth_blocked",
      errorSummary: "session expired",
      now,
    });

    expect(transactionCount).toBe(2);
    expect(result.transition).toBe("existing");
    expect(result.incident).toMatchObject({
      id: 1,
      status: "open",
    });
  });

  it("does not reopen a resolved incident from a stale open retry", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "stale-open-model",
      name: "Stale Open Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "stale-open-page",
    });

    const incidentKey = `auth_blocked:${page.id}`;
    const openedAt = new Date("2026-03-15T12:00:00.000Z");
    const staleSeenAt = new Date("2026-03-15T12:00:01.000Z");
    const resolvedAt = new Date("2026-03-15T12:00:02.000Z");
    const laterSeenAt = new Date("2026-03-15T12:00:03.000Z");

    await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "session expired",
      now: openedAt,
    });
    await resolveNotificationIncident(testDb.db, {
      incidentKey,
      now: resolvedAt,
    });

    const staleResult = await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "stale duplicate open",
      now: staleSeenAt,
    });

    expect(staleResult.transition).toBe("existing");
    expect(staleResult.incident.status).toBe("resolved");
    let incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({
      status: "resolved",
      errorSummary: "session expired",
    });
    expect(incident?.lastSeenAt.toISOString()).toBe(resolvedAt.toISOString());

    const laterResult = await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "session expired again",
      now: laterSeenAt,
    });

    expect(laterResult.transition).toBe("reopened");
    incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({
      status: "open",
      errorSummary: "session expired again",
    });
    expect(incident?.lastSeenAt.toISOString()).toBe(laterSeenAt.toISOString());
  });

  it("clears auth_blocked state and resolves page-level incidents after successful verification recovery", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "recovery-model",
      name: "Recovery Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "recovery-page",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: page.id,
    });
    await markPageSyncAuthBlocked(testDb.db, {
      pageId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "expired session",
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `auth_blocked:${page.id}`,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "expired session",
      metadata: {
        pageLabel: page.label,
        platform: "fansly",
      },
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `proxy_failed:${page.id}`,
      kind: "proxy_failed",
      platformAccountId: page.id,
      errorCode: "transport",
      errorSummary: "proxy down",
      metadata: {
        pageLabel: page.label,
        platform: "fansly",
      },
    });

    const app = createTestAppContext(testDb);
    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
    });

    const statusRows = await testDb.pool.query<{ count: string }>(`
      select count(*)::int as count
      from page_sync_states
      where page_id = $1
        and status = 'blocked'
        and blocker_kind = 'auth'
    `, [page.id]);
    expect(statusRows.rows[0]?.count).toBe(0);

    const incidents = await listNotificationIncidents(testDb.db, {
      platformAccountId: page.id,
    });
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "auth_blocked",
        status: "resolved",
      }),
      expect.objectContaining({
        kind: "proxy_failed",
        status: "resolved",
      }),
    ]));
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("does not clear newer page-level failures from stale verification recovery", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "stale-recovery-model",
      name: "Stale Recovery Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "stale-recovery-page",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: page.id,
    });

    const recoveredAt = new Date("2026-03-15T12:00:00.000Z");
    const newerFailureAt = new Date("2026-03-15T12:00:01.000Z");

    await markPageSyncAuthBlocked(testDb.db, {
      pageId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "new session failure",
      now: newerFailureAt,
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `auth_blocked:${page.id}`,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "new session failure",
      metadata: {
        pageLabel: page.label,
        platform: "fansly",
      },
      now: newerFailureAt,
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `proxy_failed:${page.id}`,
      kind: "proxy_failed",
      platformAccountId: page.id,
      errorCode: "transport",
      errorSummary: "new proxy failure",
      metadata: {
        pageLabel: page.label,
        platform: "fansly",
      },
      now: newerFailureAt,
    });

    const app = createTestAppContext(testDb);
    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      recoveredAt,
    });

    expect(await getPageSyncState(testDb.db, page.id, "light")).toMatchObject({
      status: "blocked",
      blockerKind: "auth",
      lastErrorSummary: "new session failure",
    });

    const incidents = await listNotificationIncidents(testDb.db, {
      platformAccountId: page.id,
    });
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "auth_blocked",
        status: "open",
        errorSummary: "new session failure",
      }),
      expect.objectContaining({
        kind: "proxy_failed",
        status: "open",
        errorSummary: "new proxy failure",
      }),
    ]));
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not open delayed failures that occurred before recovery", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "delayed-failure-recovery-model",
      name: "Delayed Failure Recovery Model",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "delayed-failure-recovery-page",
    });

    const failureAt = new Date("2026-03-15T12:00:00.000Z");
    const recoveredAt = new Date("2026-03-15T12:00:01.000Z");
    const laterFailureAt = new Date("2026-03-15T12:00:02.000Z");
    const app = createTestAppContext(testDb);

    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      recoveredAt,
    });

    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorCode: "auth_blocked",
      errorSummary: "old delayed failure",
      occurredAt: failureAt,
    });

    expect(await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`)).toBeNull();
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorCode: "auth_blocked",
      errorSummary: "new failure after recovery",
      occurredAt: laterFailureAt,
    });

    const incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident).toMatchObject({
      status: "open",
      errorSummary: "new failure after recovery",
    });
    expect(incident?.lastSeenAt.toISOString()).toBe(laterFailureAt.toISOString());
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  // W3.3 (D3-N1): an "existing" transition used to return before the send —
  // one transient Telegram failure at open time lost the page permanently.
  it("re-sends a lost open notification on later passes, stops once sent", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "lost-page-model",
      name: "Lost Page Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lost-page",
    }))!;
    const app = createTestAppContext(testDb);

    telegramMocks.sendTelegramMessage.mockResolvedValue({
      status: "failed",
      error: "telegram 502",
    });

    const notify = () => notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorSummary: "session expired",
    });

    await notify(); // opened; attempt #1 failed
    await notify(); // existing + no sent row → re-send; attempt #2 failed

    let attempts = await listDeliveryAttempts(testDb.db, { kind: ["incident_opened"] });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === "failed")).toBe(true);

    telegramMocks.sendTelegramMessage.mockResolvedValue({
      status: "sent",
      chatId: "6065935464",
      messageId: 2,
    });
    await notify(); // attempt #3 sent
    await notify(); // sent row exists → no further sends

    attempts = await listDeliveryAttempts(testDb.db, { kind: ["incident_opened"] });
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.status === "sent")).toHaveLength(1);
  });

  it("caps open-notification re-sends at five total attempts (D3-N1)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "capped-page-model",
      name: "Capped Page Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "capped-page",
    }))!;
    const app = createTestAppContext(testDb);

    telegramMocks.sendTelegramMessage.mockResolvedValue({
      status: "failed",
      error: "telegram destination gone",
    });

    for (let pass = 0; pass < 8; pass += 1) {
      await notifyAuthFailedIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: "fansly",
        errorSummary: "session expired",
      });
    }

    const attempts = await listDeliveryAttempts(testDb.db, { kind: ["incident_opened"] });
    expect(attempts).toHaveLength(5);
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(5);
  });

  // W3.3 (A36): the old exact-equality gate meant a manual resolve
  // mid-streak silenced the stream forever (the count never re-equals 3).
  it("re-alerts a stream-failure streak after a manual resolve", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "streak-model",
      name: "Streak Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "streak-page",
    }))!;
    const app = createTestAppContext(testDb);
    const run = (await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "light",
      trigger: "worker",
    }))!;

    const notify = (previousConsecutiveFailures: number) =>
      notifySyncChunkFailureIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: "fansly",
        stream: "light",
        runId: run.id,
        hasProxy: false,
        previousConsecutiveFailures,
        errorSummary: "provider temporary failure",
      });

    await notify(1); // 2nd failure: below threshold, silent
    expect(await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${page.id}:light`,
    )).toBeNull();

    await notify(2); // 3rd failure: opens + notifies
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);

    await notify(4); // 5th failure: existing-with-retry — sent row → no re-send
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(1);

    // Owner resolves manually mid-streak; the condition persists.
    await resolveNotificationIncident(testDb.db, {
      incidentKey: `stream_failed_threshold:${page.id}:light`,
    });

    await notify(5); // 6th failure: reopened + notified again
    const incident = await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${page.id}:light`,
    );
    expect(incident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  // W3.3 (D4-N1): if the auth-block clear fails, the incidents are still
  // TRUE — nothing resolves, and the caller reports syncUnblocked:false.
  it("keeps incidents open and reports syncUnblocked=false when the auth-block clear fails", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "clear-failure-model",
      name: "Clear Failure Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "clear-failure-page",
    }))!;
    await ensurePageSyncStates(testDb.db, {
      pageId: page.id,
    });
    await markPageSyncAuthBlocked(testDb.db, {
      pageId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "expired session",
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `auth_blocked:${page.id}`,
      kind: "auth_blocked",
      platformAccountId: page.id,
      errorCode: "auth_blocked",
      errorSummary: "expired session",
      metadata: { pageLabel: page.label, platform: "fansly" },
    });
    await openNotificationIncident(testDb.db, {
      incidentKey: `proxy_failed:${page.id}`,
      kind: "proxy_failed",
      platformAccountId: page.id,
      errorCode: "transport",
      errorSummary: "proxy down",
      metadata: { pageLabel: page.label, platform: "fansly" },
    });

    const app = createTestAppContext(testDb);
    const failingApp = {
      ...app,
      db: new Proxy(app.db, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return () => Promise.reject(new Error("connection reset during clear"));
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof app.db,
    };

    const result = await handleSuccessfulPageVerificationRecovery(failingApp, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
    });
    expect(result).toEqual({ syncUnblocked: false });

    // Streams stay blocked; both incidents stay open; nothing paged Resolved.
    const blockedRows = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from page_sync_states
      where page_id = $1
        and status = 'blocked'
        and blocker_kind = 'auth'
    `, [page.id]);
    expect(blockedRows.rows[0]?.count).toBeGreaterThan(0);

    const incidents = await listNotificationIncidents(testDb.db, {
      platformAccountId: page.id,
    });
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "auth_blocked", status: "open" }),
      expect.objectContaining({ kind: "proxy_failed", status: "open" }),
    ]));
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  // Producers stamp their event time before persisting, so two concurrent
  // terminals routinely reach the repository in the reverse order. Ordering
  // must follow the EVENT, never the arrival.
  it("keeps incident state owned by the newest event when a failure arrives late", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "out-of-order-failure-model",
      name: "Out Of Order Failure Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "out-of-order-failure-page",
    }))!;
    const app = createTestAppContext(testDb);
    const incidentKey = `auth_blocked:${page.id}`;

    const earlyFailureAt = new Date("2026-03-15T12:00:00.000Z");
    const recoveredAt = new Date("2026-03-15T12:00:01.500Z");
    const lateFailureAt = new Date("2026-03-15T12:00:02.000Z");
    const laterRecoveryAt = new Date("2026-03-15T12:00:03.000Z");

    // The NEWEST failure lands first.
    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorCode: "auth_blocked",
      errorSummary: "newest failure",
      occurredAt: lateFailureAt,
    });

    // A delayed OLDER failure is processed afterwards. It must not move
    // last_seen_at backwards, and must not rewrite the current cause.
    await notifyAuthFailedIncident(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      errorCode: "auth_blocked",
      errorSummary: "stale delayed failure",
      occurredAt: earlyFailureAt,
    });

    let incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "open", errorSummary: "newest failure" });
    expect(incident?.lastSeenAt.toISOString()).toBe(lateFailureAt.toISOString());

    // A recovery that predates the newest failure must NOT resolve it. With a
    // regressed last_seen_at the maxLastSeenAt guard would have let it through.
    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      recoveredAt,
    });

    incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "open", errorSummary: "newest failure" });

    // A recovery that genuinely postdates it still resolves.
    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
      recoveredAt: laterRecoveryAt,
    });

    incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "resolved" });
    expect(incident?.resolvedAt?.toISOString()).toBe(laterRecoveryAt.toISOString());
  });

  it("treats an equal-timestamp repeat as a duplicate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, {
      slug: "tie-timestamp-model",
      name: "Tie Timestamp Model",
    }))!;
    const page = (await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "tie-timestamp-page",
    }))!;
    const app = createTestAppContext(testDb);
    const occurredAt = new Date("2026-03-15T12:00:00.000Z");

    for (const errorSummary of ["first writer", "same-millisecond repeat"]) {
      await notifyAuthFailedIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: "fansly",
        errorCode: "auth_blocked",
        errorSummary,
        occurredAt,
      });
    }

    // First-writer-wins: two events sharing a millisecond have no trustworthy
    // secondary order, so the stored cause is not churned.
    const incident = await getNotificationIncidentByKey(testDb.db, `auth_blocked:${page.id}`);
    expect(incident).toMatchObject({ status: "open", errorSummary: "first writer" });
  });
});
