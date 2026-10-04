import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramMocks = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(),
}));

// Decision 381: producers only flip latches. The Telegram sender is mocked so
// every case below can pin that NOTHING here sends directly — paging is the
// sweep's (tests/notification-paging-sweep.integration.test.ts).
vi.mock("../apps/runtime/src/services/telegram.ts", () => ({
  sendTelegramMessage: telegramMocks.sendTelegramMessage,
}));

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  finishSyncRequestAttempt,
  getNotificationIncidentByKey,
  insertSyncRequestAttempt,
  listNotificationIncidents,
  openNotificationIncident,
  resolveNotificationIncident,
  startSyncRun,
} from "@agency_hub_core/db";

import {
  handleSuccessfulPageVerificationRecovery,
  notifyOfapiAuthIncident,
  notifySyncChunkFailureIncident,
  resolveOfapiAuthIncident,
  resolveSyncChunkRecoveryIncidents,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { seedFormerFanslyRows } from "./helpers/fansly-legacy-rows.ts";
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

  it("keeps later provider failures open when only an old completed result settles", async () => {
    if (!testDb) throw new Error("Database required");
    const model = await createModel(testDb.db, { slug: "settlement", name: "Settlement" });
    if (!model) throw new Error("Missing model");
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "settlement" });
    if (!page) throw new Error("Missing page");
    const app = createTestAppContext(testDb);
    const oldRead = new Date("2026-09-15T10:00:00Z");
    const failureAt = new Date("2026-09-15T10:01:00Z");
    for (const kind of ["auth_blocked", "proxy_failed", "stream_failed_threshold"] as const) {
      const stream = kind === "stream_failed_threshold" ? "followers_reconcile" : null;
      await openNotificationIncident(testDb.db, {
        incidentKey: `${kind}:${page.id}${stream ? `:${stream}` : ""}`,
        kind, platformAccountId: page.id, stream, now: failureAt,
        errorSummary: "failure after the certified read",
      });
    }
    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: page.id, pageLabel: page.label, platform: "fansly",
      stream: "followers_reconcile", providerRecoveredAt: oldRead,
      recoveredAt: new Date("2026-09-15T10:02:00Z"),
    });
    for (const kind of ["auth_blocked", "proxy_failed"]) {
      expect((await getNotificationIncidentByKey(testDb.db, `${kind}:${page.id}`))?.status).toBe("open");
    }
    expect((await getNotificationIncidentByKey(testDb.db,
      `stream_failed_threshold:${page.id}:followers_reconcile`))?.status).toBe("resolved");
  });

  it("keeps page-wide auth/proxy incidents open and untombstoned when a chunk has no provider evidence", async () => {
    if (!testDb) throw new Error("Database required");
    const model = await createModel(testDb.db, { slug: "no-evidence", name: "No Evidence" });
    if (!model) throw new Error("Missing model");
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "no-evidence" });
    if (!page) throw new Error("Missing page");
    const app = createTestAppContext(testDb);
    const failureAt = new Date("2026-09-19T07:16:00Z");
    const keys = {
      auth_blocked: `auth_blocked:${page.id}`,
      proxy_failed: `proxy_failed:${page.id}`,
      proxy_missing: `proxy_missing:${page.id}`,
      stream_failed_threshold: `stream_failed_threshold:${page.id}:media_stats`,
    } as const;
    for (const [kind, incidentKey] of Object.entries(keys) as [keyof typeof keys, string][]) {
      await openNotificationIncident(testDb.db, {
        incidentKey, kind, platformAccountId: page.id,
        stream: kind === "stream_failed_threshold" ? "media_stats" : null,
        now: failureAt, errorSummary: "proxy outage",
      });
    }
    const chunk = {
      platformAccountId: page.id, pageLabel: page.label, platform: "fansly", stream: "media_stats",
    } as const;
    // A zero-request or all-failed chunk: no provider evidence.
    await resolveSyncChunkRecoveryIncidents(app, {
      ...chunk, recoveredAt: new Date("2026-09-19T07:20:00Z"), providerRecoveredAt: null,
    });
    expect((await getNotificationIncidentByKey(testDb.db, keys.auth_blocked))?.status).toBe("open");
    expect((await getNotificationIncidentByKey(testDb.db, keys.proxy_failed))?.status).toBe("open");
    expect((await getNotificationIncidentByKey(testDb.db, keys.proxy_missing))?.status).toBe("resolved");
    expect((await getNotificationIncidentByKey(testDb.db, keys.stream_failed_threshold))?.status).toBe("resolved");
    expect((await testDb.pool.query(
      "select incident_key from notification_incident_recoveries where incident_key = any($1::text[])",
      [[keys.auth_blocked, keys.proxy_failed]],
    )).rows).toEqual([]);

    // A chunk whose newest provider success follows the failure closes both at
    // that success, not at the chunk end.
    const successAt = new Date("2026-09-19T07:30:00Z");
    await resolveSyncChunkRecoveryIncidents(app, {
      ...chunk, recoveredAt: new Date("2026-09-19T07:31:00Z"), providerRecoveredAt: successAt,
    });
    for (const key of [keys.auth_blocked, keys.proxy_failed]) {
      expect(await getNotificationIncidentByKey(testDb.db, key)).toMatchObject({ status: "resolved", resolvedAt: successAt });
    }
  });

  // The page-wide latch of the cases below is the OFAPI auth alert
  // (`ofapi_auth`): it opens and resolves through the same latch machinery as
  // every page-level producer. The legacy executor's own auth latch
  // (`auth_blocked`) has no producer since step 4 (S4-19: the executor serves
  // no Fansly page); the resolvers that close one an older build left open are
  // covered with latches seeded as that producer left them.
  it("opens auth incidents once, resolves them on recovery, and reopens after a later recurrence", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "auth-model",
      name: "Auth Model",
    });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model!.id,
      label: "auth-page",
    });
    const latch = { platformAccountId: page!.id, pageLabel: page!.label, platform: "onlyfans" } as const;
    const app = createTestAppContext(testDb);

    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "authentication_failed" });
    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "authentication_failed" });

    let incident = await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page!.id}`);
    expect(incident?.status).toBe("open");
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await resolveOfapiAuthIncident(app, { ...latch, recoveredAt: new Date() });

    incident = await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page!.id}`);
    expect(incident?.status).toBe("resolved");
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "otp_code_required" });

    incident = await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page!.id}`);
    expect(incident?.status).toBe("open");
    expect(incident?.resolvedAt).toBeNull();
    expect(incident?.errorCode).toBe("otp_code_required");
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
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
    await seedFormerFanslyRows(testDb.pool, proxiedPage.id, new Date());
    await seedFormerFanslyRows(testDb.pool, thresholdPage.id, new Date());

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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: proxiedPage.id,
      pageLabel: proxiedPage.label,
      platform: "fansly",
      stream: "followers",
      providerRecoveredAt: new Date(),
    });

    proxyIncident = await getNotificationIncidentByKey(testDb.db, `proxy_failed:${proxiedPage.id}`);
    expect(proxyIncident?.status).toBe("resolved");
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await resolveSyncChunkRecoveryIncidents(app, {
      platformAccountId: thresholdPage.id,
      pageLabel: thresholdPage.label,
      platform: "fansly",
      stream: "subscribers",
      providerRecoveredAt: new Date(),
    });

    expect(await getNotificationIncidentByKey(
      testDb.db,
      `stream_failed_threshold:${thresholdPage.id}:subscribers`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
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
    await seedFormerFanslyRows(testDb.pool, page.id, new Date());

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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
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

  it("resolves the page-level incidents an older build left open after a successful verification", async (context) => {
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
    await seedFormerFanslyRows(testDb.pool, page.id, new Date());
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

    const legacyRows = async () => (await testDb!.pool.query(
      "select stream, status, blocker_kind, request_seq, applied_seq, updated_at from page_sync_states where page_id = $1 order by stream",
      [page.id],
    )).rows;
    const legacyRowsBefore = await legacyRows();
    expect(legacyRowsBefore.length).toBeGreaterThan(0);

    const app = createTestAppContext(testDb);
    await handleSuccessfulPageVerificationRecovery(app, {
      platformAccountId: page.id,
      pageLabel: page.label,
      platform: "fansly",
    });

    // The page's legacy rows are not the verification's to touch.
    expect(await legacyRows()).toEqual(legacyRowsBefore);

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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not resolve newer page-level failures from a stale verification recovery", async (context) => {
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
    await seedFormerFanslyRows(testDb.pool, page.id, new Date());

    const recoveredAt = new Date("2026-03-15T12:00:00.000Z");
    const newerFailureAt = new Date("2026-03-15T12:00:01.000Z");

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
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model!.id,
      label: "delayed-failure-recovery-page",
    });
    const latch = { platformAccountId: page!.id, pageLabel: page!.label, platform: "onlyfans" } as const;

    const failureAt = new Date("2026-03-15T12:00:00.000Z");
    const recoveredAt = new Date("2026-03-15T12:00:01.000Z");
    const laterFailureAt = new Date("2026-03-15T12:00:02.000Z");
    const app = createTestAppContext(testDb);

    await resolveOfapiAuthIncident(app, { ...latch, recoveredAt });

    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "old_delayed_failure", occurredAt: failureAt });

    expect(await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page!.id}`)).toBeNull();
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "new_failure_after_recovery", occurredAt: laterFailureAt });

    const incident = await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page!.id}`);
    expect(incident).toMatchObject({
      status: "open",
      errorCode: "new_failure_after_recovery",
    });
    expect(incident?.lastSeenAt.toISOString()).toBe(laterFailureAt.toISOString());
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  // W3.3 (D3-N1): an "existing" transition used to return before the send —
  // one transient Telegram failure at open time lost the page permanently.
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
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

    await notify(4); // 5th failure: existing-with-retry — sent row → no re-send
    expect(telegramMocks.sendTelegramMessage).not.toHaveBeenCalled();

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
    const page = (await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "out-of-order-failure-page",
    }))!;
    const latch = { platformAccountId: page.id, pageLabel: page.label, platform: "onlyfans" } as const;
    const app = createTestAppContext(testDb);
    const incidentKey = `ofapi_auth:${page.id}`;

    const earlyFailureAt = new Date("2026-03-15T12:00:00.000Z");
    const recoveredAt = new Date("2026-03-15T12:00:01.500Z");
    const lateFailureAt = new Date("2026-03-15T12:00:02.000Z");
    const laterRecoveryAt = new Date("2026-03-15T12:00:03.000Z");

    // The NEWEST failure lands first.
    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "newest_failure", occurredAt: lateFailureAt });

    // A delayed OLDER failure is processed afterwards. It must not move
    // last_seen_at backwards, and must not rewrite the current cause.
    await notifyOfapiAuthIncident(app, { ...latch, authStatus: "stale_delayed_failure", occurredAt: earlyFailureAt });

    let incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "open", errorCode: "newest_failure" });
    expect(incident?.lastSeenAt.toISOString()).toBe(lateFailureAt.toISOString());

    // A recovery that predates the newest failure must NOT resolve it. With a
    // regressed last_seen_at the maxLastSeenAt guard would have let it through.
    await resolveOfapiAuthIncident(app, { ...latch, recoveredAt });

    incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "open", errorCode: "newest_failure" });

    // A recovery that genuinely postdates it still resolves.
    await resolveOfapiAuthIncident(app, { ...latch, recoveredAt: laterRecoveryAt });

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
    const page = (await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "tie-timestamp-page",
    }))!;
    const app = createTestAppContext(testDb);
    const occurredAt = new Date("2026-03-15T12:00:00.000Z");

    for (const authStatus of ["first_writer", "same_millisecond_repeat"]) {
      await notifyOfapiAuthIncident(app, {
        platformAccountId: page.id,
        pageLabel: page.label,
        platform: "onlyfans",
        authStatus,
        occurredAt,
      });
    }

    // First-writer-wins: two events sharing a millisecond have no trustworthy
    // secondary order, so the stored cause is not churned.
    const incident = await getNotificationIncidentByKey(testDb.db, `ofapi_auth:${page.id}`);
    expect(incident).toMatchObject({ status: "open", errorCode: "first_writer" });
  });
});
