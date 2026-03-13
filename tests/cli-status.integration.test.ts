import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  finishSyncRequestAttempt,
  finishSyncRun,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
  startSyncRun,
} from "@agency_hub_core/db";

import { getStatusDetail, getStatusWatchSnapshot } from "../apps/runtime/src/services/sync.ts";
import { startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function loadCliProgram(appContext: ReturnType<typeof createTestAppContext>) {
  vi.resetModules();
  vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({
    createAppContext: async () => appContext,
  }));

  const { buildProgram } = await import("../apps/runtime/src/cli.ts");
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
    outputError: () => {},
  });
  return program;
}

async function runCli(
  appContext: ReturnType<typeof createTestAppContext>,
  args: string[],
) {
  const logs: string[] = [];
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part ?? "")).join(" "));
  });

  try {
    const program = await loadCliProgram(appContext);
    await program.parseAsync(args, { from: "user" });
  } finally {
    consoleSpy.mockRestore();
  }

  return logs;
}

async function setRunTimes(
  testDb: NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>,
  runId: number,
  startedAt: Date,
  finishedAt: Date | null,
) {
  await testDb.pool.query(
    "update sync_runs set started_at = $1, finished_at = $2 where id = $3",
    [startedAt, finishedAt, runId],
  );
}

async function seedCompletedRun(
  testDb: NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>,
  pageId: number,
  input: {
    startedAt: Date;
    finishedAt: Date;
    trigger: string;
    includeTelemetry?: boolean;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: pageId,
    stream: "light",
    trigger: input.trigger,
  });

  if (input.includeTelemetry) {
    const attempt = await insertSyncRequestAttempt(testDb.db, {
      syncRunId: run.id,
      platformAccountId: pageId,
      provider: "fansly",
      stream: "light",
      operation: "account_me",
      logicalRequestId: `account_me:${run.id}`,
      attemptNumber: 1,
      requestShape: { endpoint: "account_me" },
      startedAt: new Date(input.startedAt.getTime() + 500),
    });
    await finishSyncRequestAttempt(testDb.db, attempt.id, {
      state: "success",
      httpStatus: 200,
      durationMs: 125,
      responseShape: { ok: true },
      finishedAt: new Date(input.startedAt.getTime() + 625),
    });
    await insertSyncRunEvent(testDb.db, {
      syncRunId: run.id,
      platformAccountId: pageId,
      provider: "fansly",
      stream: "light",
      eventType: "phase_started",
      severity: "info",
      message: "Phase started",
      emittedAt: new Date(input.startedAt.getTime() + 750),
    });
    await insertSyncRunEvent(testDb.db, {
      syncRunId: run.id,
      platformAccountId: pageId,
      provider: "fansly",
      stream: "light",
      eventType: "run_finished",
      severity: "info",
      message: "Sync run finished",
      emittedAt: input.finishedAt,
    });
  }

  await finishSyncRun(testDb.db, run.id, {
    status: "success",
    stats: {
      health: "healthy",
      requestTotals: {
        totalAttempts: input.includeTelemetry ? 1 : 0,
        logicalRequests: input.includeTelemetry ? 1 : 0,
        retryAttempts: 0,
        failedAttempts: 0,
      },
      anomalies: [],
      boundary: {
        kind: "after",
        requestedLowerBound: input.startedAt.toISOString(),
        olderThanBoundaryItems: 0,
        olderThanBoundaryPages: 0,
      },
      checkpoint: {
        advanced: {
          transactions: true,
        },
        after: {
          transactions: {
            cursorTimestamp: input.finishedAt.toISOString(),
          },
        },
      },
    },
  });
  await setRunTimes(testDb, run.id, input.startedAt, input.finishedAt);

  return run;
}

async function seedRunningRun(
  testDb: NonNullable<Awaited<ReturnType<typeof startTestDatabase>>>,
  pageId: number,
  input: {
    startedAt: Date;
    requestStartedAt: Date;
    eventAt: Date;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: pageId,
    stream: "light",
    trigger: "worker",
  });

  await setRunTimes(testDb, run.id, input.startedAt, null);
  await insertSyncRequestAttempt(testDb.db, {
    syncRunId: run.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "light",
    operation: "earnings_transactions",
    logicalRequestId: `earnings:${run.id}`,
    attemptNumber: 1,
    requestShape: { after: input.startedAt.toISOString() },
    startedAt: input.requestStartedAt,
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: run.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "light",
    eventType: "phase_started",
    severity: "info",
    message: "Sync run is active",
    emittedAt: input.eventAt,
  });

  return run;
}

describe("CLI status flows", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  let lanaPage: Awaited<ReturnType<typeof createFanslyPage>> | null = null;
  let novaPage: Awaited<ReturnType<typeof createFanslyPage>> | null = null;

  beforeAll(async () => {
    try {
      testDb = await startTestDatabase();
    } catch (error) {
      console.warn(
        `Skipping integration tests: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    if (!testDb) {
      return;
    }

    await testDb.pool.query(`
      truncate fan_flags, fan_summaries, fan_notes, audit_events, api_keys,
               auth_sessions, user_page_assignments, users, daily_revenue,
               daily_followers, daily_subscribers, transactions, page_subscriptions,
               page_follows, fan_pages, fans, raw_payloads, sync_checkpoints,
               sync_request_attempts, sync_run_events, sync_runs,
               platform_account_proxies, platform_account_credentials,
               platform_accounts, models
      restart identity cascade
    `);

    const lanaModel = await createModel(testDb.db, {
      slug: "lana-model",
      name: "Lana Model",
    });
    lanaPage = await createFanslyPage(testDb.db, {
      modelId: lanaModel.id,
      label: "lana",
    });

    const novaModel = await createModel(testDb.db, {
      slug: "nova-model",
      name: "Nova Model",
    });
    novaPage = await createFanslyPage(testDb.db, {
      modelId: novaModel.id,
      label: "nova",
    });
  });

  it("renders filtered status list and detailed run output from persisted observability rows", async (context) => {
    if (!testDb || !lanaPage || !novaPage) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const since = new Date("2026-03-10T09:00:00.000Z");
    const recentLanaRun = await seedCompletedRun(testDb, lanaPage.id, {
      startedAt: new Date("2026-03-10T10:00:00.000Z"),
      finishedAt: new Date("2026-03-10T10:00:05.000Z"),
      trigger: "cli",
      includeTelemetry: true,
    });
    const oldLanaRun = await seedCompletedRun(testDb, lanaPage.id, {
      startedAt: new Date("2026-03-01T10:00:00.000Z"),
      finishedAt: new Date("2026-03-01T10:00:05.000Z"),
      trigger: "worker",
    });
    await seedCompletedRun(testDb, novaPage.id, {
      startedAt: new Date("2026-03-10T10:30:00.000Z"),
      finishedAt: new Date("2026-03-10T10:30:05.000Z"),
      trigger: "worker",
    });

    const statusOutput = (await runCli(appContext, [
      "status",
      "--page",
      "lana",
      "--since",
      since.toISOString(),
      "--limit",
      "5",
    ])).join("\n");
    const detailOutput = (await runCli(appContext, [
      "status",
      "--run",
      String(recentLanaRun.id),
    ])).join("\n");
    const detail = await getStatusDetail(appContext, recentLanaRun.id);

    expect(statusOutput).toContain("run_id\tpage_label\tstream\ttrigger\tstatus\thealth");
    expect(statusOutput).toContain(`${recentLanaRun.id}\tlana\tlight\tcli\tsuccess\thealthy`);
    expect(statusOutput).not.toContain("\tnova\t");
    expect(statusOutput).not.toContain(`${oldLanaRun.id}\tlana\tlight\tworker`);

    expect(detailOutput).toContain(`Run ${recentLanaRun.id} lana light`);
    expect(detailOutput).toContain("Status: success  Health: healthy");
    expect(detailOutput).toContain("Events:");
    expect(detailOutput).toContain("phase_started");
    expect(detailOutput).toContain("Request Attempts:");
    expect(detailOutput).toContain("account_me");

    expect(detail.run.startedAt).toBeInstanceOf(Date);
    expect(detail.run.finishedAt).toBeInstanceOf(Date);
    expect(detail.events[0]?.emittedAt).toBeInstanceOf(Date);
    expect(detail.attempts[0]?.startedAt).toBeInstanceOf(Date);
  });

  it("builds filtered watch snapshots for running runs with inflight attempts", async (context) => {
    if (!testDb || !lanaPage || !novaPage) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const since = new Date("2026-03-10T09:00:00.000Z");
    const recentLanaRun = await seedCompletedRun(testDb, lanaPage.id, {
      startedAt: new Date("2026-03-10T10:00:00.000Z"),
      finishedAt: new Date("2026-03-10T10:00:05.000Z"),
      trigger: "cli",
      includeTelemetry: true,
    });
    const runningLanaRun = await seedRunningRun(testDb, lanaPage.id, {
      startedAt: new Date("2026-03-10T10:10:00.000Z"),
      requestStartedAt: new Date("2026-03-10T10:10:02.000Z"),
      eventAt: new Date("2026-03-10T10:10:03.000Z"),
    });
    await seedRunningRun(testDb, novaPage.id, {
      startedAt: new Date("2026-03-10T10:15:00.000Z"),
      requestStartedAt: new Date("2026-03-10T10:15:01.000Z"),
      eventAt: new Date("2026-03-10T10:15:02.000Z"),
    });
    const oldLanaRun = await seedCompletedRun(testDb, lanaPage.id, {
      startedAt: new Date("2026-03-01T10:00:00.000Z"),
      finishedAt: new Date("2026-03-01T10:00:05.000Z"),
      trigger: "worker",
    });

    const snapshot = await getStatusWatchSnapshot(appContext, {
      pageLabel: "lana",
      limit: 5,
      since,
      afterEventId: 0,
    });

    expect(snapshot.runningRuns.map((run) => run.runId)).toEqual([runningLanaRun.id]);
    expect(snapshot.inflightAttempts.map((attempt) => attempt.runId)).toEqual([runningLanaRun.id]);
    expect(snapshot.recentRuns.map((run) => run.runId)).toContain(recentLanaRun.id);
    expect(snapshot.recentRuns.map((run) => run.runId)).not.toContain(oldLanaRun.id);
    expect(snapshot.recentRuns.some((run) => run.pageLabel === "nova")).toBe(false);
    expect(snapshot.recentRuns.every((run) => run.startedAt instanceof Date)).toBe(true);
    expect(snapshot.runningRuns[0]?.lastActivityAt).toBeInstanceOf(Date);
    expect(snapshot.inflightAttempts[0]?.startedAt).toBeInstanceOf(Date);
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.events.every((event) => event.pageLabel === "lana")).toBe(true);
    expect(snapshot.events.every((event) => event.emittedAt instanceof Date)).toBe(true);
  });
});
