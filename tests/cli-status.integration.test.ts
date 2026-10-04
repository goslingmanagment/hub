import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  finishSyncRequestAttempt,
  finishSyncRun,
  insertSyncRequestAttempt,
  pageSyncCursors as pageSyncCursorRows,
  syncRateLimits,
  pageSyncStates as pageSyncStateRows,
  insertSyncRunEvent,
  startSyncRun,
} from "@agency_hub_core/db";

import { getStatusDetail, getStatusWatchSnapshot } from "../apps/runtime/src/services/sync.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
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
  testDb: StartedTestDatabase,
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
  testDb: StartedTestDatabase,
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
  testDb: StartedTestDatabase,
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

const SYNC_MONITOR_NOW = new Date("2026-03-20T12:00:00.000Z");

async function seedSyncMonitorRows(
  testDb: StartedTestDatabase,
  pageId: number,
) {
  const lightRun = await startSyncRun(testDb.db, {
    platformAccountId: pageId,
    stream: "light",
    trigger: "worker",
  });
  await setRunTimes(
    testDb,
    lightRun.id,
    new Date("2026-03-20T10:00:00.000Z"),
    null,
  );
  await insertSyncRunEvent(testDb.db, {
    syncRunId: lightRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "light",
    eventType: "phase_started",
    severity: "info",
    message: "Light sync active",
    emittedAt: new Date("2026-03-20T10:05:00.000Z"),
  });

  const transactionsRun = await startSyncRun(testDb.db, {
    platformAccountId: pageId,
    stream: "transactions",
    trigger: "worker",
  });
  await finishSyncRun(testDb.db, transactionsRun.id, {
    status: "partial",
    stats: {},
  });
  await setRunTimes(
    testDb,
    transactionsRun.id,
    new Date("2026-03-20T09:00:00.000Z"),
    new Date("2026-03-20T09:04:00.000Z"),
  );
  const attempt = await insertSyncRequestAttempt(testDb.db, {
    syncRunId: transactionsRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "transactions",
    operation: "transaction_backfill",
    logicalRequestId: `tx:${transactionsRun.id}`,
    attemptNumber: 1,
    requestShape: {},
    startedAt: new Date("2026-03-20T09:02:00.000Z"),
  });
  await finishSyncRequestAttempt(testDb.db, attempt.id, {
    state: "retry",
    failureKind: "http",
    httpStatus: 429,
    durationMs: 500,
    errorMessage: "Rate limited",
    responseShape: {},
    finishedAt: new Date("2026-03-20T09:02:00.500Z"),
  });

  await testDb.db.insert(pageSyncStateRows).values([
    {
      pageId,
      stream: "light",
      status: "running",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(new Date("2026-03-20T12:15:00.000Z").getTime() / 1000 / 3600) - 1,
      requestSeq: 2,
      appliedSeq: 2,
      startedAt: new Date("2026-03-20T10:00:00.000Z"),
    },
    {
      pageId,
      stream: "transactions",
      status: "retrying",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(new Date("2026-03-20T12:15:00.000Z").getTime() / 1000 / 3600) - 1,
      requestSeq: 4,
      appliedSeq: 3,
      retryAt: new Date("2026-03-20T12:04:00.000Z"),
    },
  ]);
  await testDb.db.insert(pageSyncCursorRows).values({
    pageId,
    stream: "transactions",
    state: {
      mode: "backfill",
      completed: false,
      provider: "fansly",
      phase: "transactions",
      snapshotEnd: "2026-03-20T08:00:00.000Z",
      newestSeenAt: "2026-03-20T07:55:00.000Z",
      dirtyFrom: null,
      processedTransactions: 8,
      processedChargebacks: 1,
      transactionPages: 2,
      chargebackPages: 0,
      offset: 8,
    },
    cursorLastSucceededAt: new Date("2026-03-20T09:05:00.000Z"),
  });
  await testDb.db.insert(syncRateLimits).values({
    provider: "fansly",
    scope: "global",
    egressKey: "direct",
    minSpacingMs: 1_000,
    nextAvailableAt: new Date("2026-03-20T12:04:00.000Z"),
  });
}

describe("CLI status flows", () => {
  let testDb: StartedTestDatabase | null = null;
  let lanaPage: Awaited<ReturnType<typeof createFanslyPage>> | null = null;
  let novaPage: Awaited<ReturnType<typeof createFanslyPage>> | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
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

    await resetIntegrationDatabase(testDb.pool);

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
    expect(statusOutput).toContain(`${recentLanaRun.id}\tlana\tlight\tmanual\tsuccess\thealthy`);
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

  it("renders sync monitor output and supports page filtering", async (context) => {
    if (!testDb || !lanaPage || !novaPage) {
      context.skip();
      return;
    }

    vi.useFakeTimers();
    vi.setSystemTime(SYNC_MONITOR_NOW);

    const appContext = createTestAppContext(testDb);
    await seedSyncMonitorRows(testDb, lanaPage.id);

    const fullOutput = (await runCli(appContext, [
      "sync",
      "status",
    ])).join("\n");
    const filteredOutput = (await runCli(appContext, [
      "sync",
      "status",
      "--page",
      "lana",
    ])).join("\n");

    expect(fullOutput).toContain("Sync Monitor 2026-03-20T12:00:00.000Z");
    // 2 pages x 17 MONITORED streams. WP-F1 added `stats_snapshot` AND repaired
    // the already-missing `posts`, which had been invisible in the monitor since
    // it shipped — the same blind spot a wedged fan_earnings walk had before
    // W8.1; WP-F2 added `notifications`, the lane whose wedge costs facts rather
    // than freshness; WP-F3 added `catalog`, whose wedge is invisible in every
    // other surface — the page keeps syncing DMs and money while its inventory
    // silently ages and M stops moving; WP-F5 added `post_replies`, whose wedge
    // is quieter still — the walk queue keeps every row, nothing errors, and the
    // comment archive simply stops growing part-way through its first pass;
    // WP-F7 added `payouts`, whose steady state is TWO calls a day — a volume
    // no dashboard notices going to zero, and the first thing lost is the
    // money-out history the finance side reconciles against; WP-F4 added
    // `media_stats`, the loudest lane in the tree by call volume — it is built
    // to run at 100 % of its own daily cap, so "calls went to zero" is the
    // signal and nothing else in the monitor would show it. The
    // `MONITORED_SYNC_STREAMS ⊇ getSyncStreamsForPlatform("fansly")` pin is what
    // keeps the next omission from being silent.
    expect(fullOutput).toContain("Pages=2 Streams=34");
    expect(fullOutput).toContain("Providers: fansly:limited");
    expect(fullOutput).toContain("lana");
    expect(fullOutput).toContain("nova");
    expect(fullOutput).toContain("Retrying=1");
    expect(fullOutput).toContain("stalled");
    // The seeded legacy transactions checkpoint stays as a record: step 4
    // (S4-16) deleted the legacy Fansly transactions lane with the reader of
    // its backfill state, so the monitor renders no progress from it.
    expect(fullOutput).toMatch(/lana\s+transactions\s+retrying\s+-\s/);
    expect(fullOutput).not.toContain("items backfilled");

    expect(filteredOutput).toContain("lana");
    expect(filteredOutput).toContain("Pages=1 Streams=17");
    expect(filteredOutput).toContain("Retrying=1");
  });
});
