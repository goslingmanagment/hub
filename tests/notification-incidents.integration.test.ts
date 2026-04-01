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
  insertSyncRequestAttempt,
  listNotificationIncidents,
  markPageSyncAuthBlocked,
  openNotificationIncident,
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
});
