import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  closeOrphanedSyncRuns: vi.fn(),
  deleteExpiredPendingDeviceTokens: vi.fn(),
  deleteExpiredRawPayloads: vi.fn(),
  deleteExpiredSyncObservability: vi.fn(),
  getLatestScheduledReportDateOnOrBefore: vi.fn(),
  getTelegramSettings: vi.fn(),
}));

const executorMocks = vi.hoisted(() => ({
  startSyncPageExecutor: vi.fn(),
}));

const telegramReportMocks = vi.hoisted(() => ({
  sendDailyRevenueTelegramReport: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  ensurePlannerSchedule: vi.fn(),
  ensureSyncQueues: vi.fn(),
  ensureTelegramDailyReportSchedule: vi.fn(),
  ensureWorkboardQueues: vi.fn(),
  ensureWorkboardRecomputeSchedule: vi.fn(),
}));

const plannerMocks = vi.hoisted(() => ({
  runSyncPlannerCycle: vi.fn(),
}));

const ofapiEventMocks = vi.hoisted(() => ({
  ensureOfapiQueues: vi.fn(),
  ensureOfapiSchedules: vi.fn(),
  startOfapiEventWorker: vi.fn(),
}));

const ofapiCreditMocks = vi.hoisted(() => ({
  ensureOfapiCreditQueues: vi.fn(),
  ensureOfapiCreditSchedules: vi.fn(),
  startOfapiCreditWorker: vi.fn(),
  isOfapiCreditLedgerEnabled: vi.fn(() => false),
  createOfapiCreditSpendSink: vi.fn(() => async () => {}),
  runOfapiCreditBurnMonitor: vi.fn(),
}));

const ofapiCommandMocks = vi.hoisted(() => ({
  ensureOfapiCommandQueues: vi.fn(),
  ensureOfapiCommandSchedules: vi.fn(),
  startOfapiCommandWorker: vi.fn(),
}));

const ofapiDmAnalyticsMocks = vi.hoisted(() => ({
  ensureOfapiDmAnalyticsQueues: vi.fn(),
  ensureOfapiDmAnalyticsSchedules: vi.fn(),
  startOfapiDmAnalyticsWorker: vi.fn(),
}));

const dbDiskAlertMocks = vi.hoisted(() => ({
  DB_DISK_USAGE_CHECK_QUEUE: "db.disk-usage.check",
  ensureDbDiskUsageQueue: vi.fn(),
  ensureDbDiskUsageSchedule: vi.fn(),
  runDbDiskUsageCheck: vi.fn(),
}));

const observationsPartitionMocks = vi.hoisted(() => ({
  OBSERVATIONS_PARTITIONS_QUEUE: "observations.partitions.ensure",
  ensureObservationsPartitionQueue: vi.fn(),
  ensureObservationsPartitionSchedule: vi.fn(),
  runObservationsPartitionCheck: vi.fn(),
}));

const canonicalizeDriverMocks = vi.hoisted(() => ({
  CANONICALIZE_SWEEP_QUEUE: "canonicalize.sweep",
  ensureCanonicalizeQueues: vi.fn(),
  ensureCanonicalizeSchedule: vi.fn(),
  runCanonicalization: vi.fn(),
}));

const messageArchiveMocks = vi.hoisted(() => ({
  MESSAGE_ARCHIVE_SWEEP_QUEUE: "projections.message-archive.sweep",
  ensureMessageArchiveQueues: vi.fn(),
  ensureMessageArchiveSchedule: vi.fn(),
  runMessageArchiveProjection: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync/executor.ts", () => executorMocks);
vi.mock("../apps/runtime/src/services/telegram-report.ts", () => telegramReportMocks);
vi.mock("../apps/runtime/src/services/sync/planner.ts", () => ({
  runSyncPlannerCycle: plannerMocks.runSyncPlannerCycle,
}));
vi.mock("../apps/runtime/src/services/ofapi-events.ts", () => ofapiEventMocks);
vi.mock("../apps/runtime/src/services/ofapi-credits.ts", () => ofapiCreditMocks);
vi.mock("../apps/runtime/src/services/ofapi-command-executor.ts", () => ofapiCommandMocks);
vi.mock("../apps/runtime/src/services/ofapi-dm-analytics.ts", () => ofapiDmAnalyticsMocks);
vi.mock("../apps/runtime/src/services/db-disk-alert.ts", () => dbDiskAlertMocks);
vi.mock("../apps/runtime/src/services/observations-partitions.ts", () => observationsPartitionMocks);
vi.mock("../apps/runtime/src/services/canonicalize-driver.ts", () => canonicalizeDriverMocks);
vi.mock("../apps/runtime/src/services/projections/message-archive.ts", () => messageArchiveMocks);
vi.mock("../apps/runtime/src/services/projections/fan-earnings.ts", () => ({
  runFanEarningsProjection: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/ofapi-chargebacks-sync.ts", () => ({
  OFAPI_CHARGEBACKS_RECONCILE_QUEUE: "ofapi.chargebacks.reconcile",
  ensureOfapiChargebacksQueue: vi.fn(),
  ensureOfapiChargebacksSchedule: vi.fn(),
  startOfapiChargebacksWorker: vi.fn(),
  runOfapiChargebacksReconcile: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  ensureQueueCreated: vi.fn(async () => {}),
  ensureTelegramDailyReportSchedule: queueMocks.ensureTelegramDailyReportSchedule,
  ensurePlannerSchedule: queueMocks.ensurePlannerSchedule,
  ensureSyncQueues: queueMocks.ensureSyncQueues,
  ensureWorkboardQueues: queueMocks.ensureWorkboardQueues,
  ensureWorkboardRecomputeSchedule: queueMocks.ensureWorkboardRecomputeSchedule,
  RAW_PAYLOAD_CLEANUP_QUEUE: "raw-payload-cleanup",
  SYNC_PLANNER_QUEUE: "sync-planner",
  TELEGRAM_DAILY_REPORT_QUEUE: "telegram.daily-report",
  WORKBOARD_RECOMPUTE_QUEUE: "workboard.recompute",
  WORKBOARD_CLASSIFY_QUEUE: "workboard.classify-closing",
  WORKBOARD_FAN_RECOMPUTE_QUEUE: "workboard.fan-recompute",
}));
vi.mock("../apps/runtime/src/services/golden-signals.ts", () => ({
  OPS_METRICS_SAMPLE_QUEUE: "ops.metrics.sample",
  ensureOpsMetricsQueue: vi.fn(),
  ensureOpsMetricsSchedule: vi.fn(),
  startGoldenSignalWorker: vi.fn(async () => "gs-worker"),
  runGoldenSignalSample: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/workboard-event-recompute.ts", () => ({
  startWorkboardEventRecompute: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
  runWorkboardFanRecompute: vi.fn(),
}));

import { startWorkerServices } from "../apps/runtime/src/worker-services.ts";

function getTelegramWorkHandler(boss: {
  work: ReturnType<typeof vi.fn>;
}) {
  const workCalls = boss.work.mock.calls as unknown as Array<[string, unknown, () => Promise<unknown>]>;
  const telegramWorkCall = workCalls.find(([queueName]) => queueName === "telegram.daily-report");
  const handler = telegramWorkCall?.[2];

  if (!handler) {
    throw new Error("Expected telegram.daily-report handler to be registered");
  }

  return handler;
}

function getRawPayloadCleanupHandler(boss: {
  work: ReturnType<typeof vi.fn>;
}) {
  const workCalls = boss.work.mock.calls as unknown as Array<[string, unknown, () => Promise<unknown>]>;
  const workCall = workCalls.find(([queueName]) => queueName === "raw-payload-cleanup");
  const handler = workCall?.[2];
  if (!handler) {
    throw new Error("Expected raw-payload-cleanup handler to be registered");
  }
  return handler;
}

describe("worker startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));

    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(executorMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(telegramReportMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(queueMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(ofapiCommandMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    for (const mock of Object.values(ofapiDmAnalyticsMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    dbDiskAlertMocks.ensureDbDiskUsageQueue.mockReset();
    dbDiskAlertMocks.ensureDbDiskUsageQueue.mockResolvedValue(undefined);
    dbDiskAlertMocks.ensureDbDiskUsageSchedule.mockReset();
    dbDiskAlertMocks.ensureDbDiskUsageSchedule.mockResolvedValue(undefined);
    dbDiskAlertMocks.runDbDiskUsageCheck.mockReset();
    dbDiskAlertMocks.runDbDiskUsageCheck.mockResolvedValue(null);
    observationsPartitionMocks.ensureObservationsPartitionQueue.mockReset();
    observationsPartitionMocks.ensureObservationsPartitionQueue.mockResolvedValue(undefined);
    observationsPartitionMocks.ensureObservationsPartitionSchedule.mockReset();
    observationsPartitionMocks.ensureObservationsPartitionSchedule.mockResolvedValue(undefined);
    observationsPartitionMocks.runObservationsPartitionCheck.mockReset();
    observationsPartitionMocks.runObservationsPartitionCheck.mockResolvedValue({ ensured: [], leadMonths: 3, failed: false });
    plannerMocks.runSyncPlannerCycle.mockReset();

    dbMocks.closeOrphanedSyncRuns.mockResolvedValue({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });
    queueMocks.ensurePlannerSchedule.mockResolvedValue(undefined);
    queueMocks.ensureSyncQueues.mockResolvedValue(undefined);
    executorMocks.startSyncPageExecutor.mockResolvedValue(undefined);
    plannerMocks.runSyncPlannerCycle.mockResolvedValue([]);
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue(null);
    telegramReportMocks.sendDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "sent",
        chatId: "6065935464",
        messageId: 1,
      },
      report: {
        reportDate: "2026-03-20",
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs orphan cleanup once before queues and executor startup", async () => {
    const processStartedAt = new Date("2026-03-20T16:00:00.000Z");
    const order: string[] = [];
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: false,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {
        order.push("app.close");
      }),
    };
    const boss = {
      start: vi.fn(async () => {
        order.push("boss.start");
      }),
      stop: vi.fn(async () => {
        order.push("boss.stop");
      }),
      schedule: vi.fn(async () => {
        order.push("boss.schedule");
      }),
      work: vi.fn(async (queueName: string) => {
        order.push(`boss.work:${queueName}`);
      }),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    dbMocks.closeOrphanedSyncRuns.mockImplementation(async () => {
      order.push("cleanup");
      return {
        totalCount: 2,
        failedCount: 1,
        partialCount: 1,
      };
    });
    queueMocks.ensureSyncQueues.mockImplementation(async () => {
      order.push("ensureSyncQueues");
    });
    queueMocks.ensurePlannerSchedule.mockImplementation(async () => {
      order.push("ensurePlannerSchedule");
    });
    plannerMocks.runSyncPlannerCycle.mockImplementation(async () => {
      order.push("runSyncPlannerCycle");
      return [];
    });
    executorMocks.startSyncPageExecutor.mockImplementation(async () => {
      order.push("startSyncPageExecutor");
    });

    const runtime = await startWorkerServices(app as never, boss as never, { processStartedAt });

    expect(dbMocks.closeOrphanedSyncRuns).toHaveBeenCalledTimes(1);
    expect(dbMocks.closeOrphanedSyncRuns).toHaveBeenCalledWith({}, {
      startedBefore: processStartedAt,
      finishedAt: expect.any(Date),
      errorSummary: "Worker restarted",
    });
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("boss.start"));
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("ensureSyncQueues"));
    expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("startSyncPageExecutor"));
    expect(order.indexOf("runSyncPlannerCycle")).toBeGreaterThan(order.indexOf("ensureSyncQueues"));
    expect(order.indexOf("runSyncPlannerCycle")).toBeLessThan(order.indexOf("startSyncPageExecutor"));
    expect(app.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      processStartedAt,
      orphanedRunTotal: 2,
      orphanedRunFailed: 1,
      orphanedRunPartial: 1,
    }), "Orphaned sync run startup cleanup complete");
    // Stage 25: schedules are the scheduler role's job, never the worker's.
    expect(queueMocks.ensureTelegramDailyReportSchedule).not.toHaveBeenCalled();
    expect(ofapiCommandMocks.ensureOfapiCommandQueues).toHaveBeenCalledWith(
      boss,
      expect.any(Set),
    );
    expect(ofapiCommandMocks.ensureOfapiCommandSchedules).not.toHaveBeenCalled();
    expect(ofapiCommandMocks.startOfapiCommandWorker).toHaveBeenCalledWith(app, boss);
    expect(ofapiDmAnalyticsMocks.ensureOfapiDmAnalyticsQueues).toHaveBeenCalledWith(
      boss,
      expect.any(Set),
    );
    expect(ofapiDmAnalyticsMocks.ensureOfapiDmAnalyticsSchedules).not.toHaveBeenCalled();
    expect(ofapiDmAnalyticsMocks.startOfapiDmAnalyticsWorker).toHaveBeenCalledWith(app, boss);
    expect(app.logger.info).toHaveBeenCalledWith("Worker started");

    await expect(getRawPayloadCleanupHandler(boss)()).resolves.toBeUndefined();
    expect(dbMocks.deleteExpiredPendingDeviceTokens).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteExpiredPendingDeviceTokens).toHaveBeenCalledWith(
      app.db,
      new Date("2026-03-23T11:00:00.000Z"),
    );

    await runtime.shutdown();

    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("registers the Telegram daily report schedule when Telegram is enabled", async () => {
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 7,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    const runtime = await startWorkerServices(app as never, boss as never);

    expect(queueMocks.ensureSyncQueues).toHaveBeenCalledWith(boss, expect.any(Set));
    // Stage 25: cron registration moved to the scheduler role — the worker
    // creates queues and consumes, but never registers schedules.
    expect(queueMocks.ensurePlannerSchedule).not.toHaveBeenCalled();
    expect(plannerMocks.runSyncPlannerCycle).toHaveBeenCalledWith(app, boss);
    expect(queueMocks.ensureTelegramDailyReportSchedule).not.toHaveBeenCalled();
    expect(boss.work).toHaveBeenCalledWith(
      "telegram.daily-report",
      { batchSize: 1 },
      expect.any(Function),
    );

    await runtime.shutdown();
  });

  it("catches up yesterday's report after the worker misses the scheduled hour", async () => {
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));
    const reportHourUtc = 9;
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: reportHourUtc,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc,
    });

    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-22");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledTimes(1);
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledWith(
      app,
      new Date("2026-03-23T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });

  it("catches up multiple trailing missing report dates in order", async () => {
    vi.setSystemTime(new Date("2026-03-25T11:00:00.000Z"));
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc: 9,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-22");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-24");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenNthCalledWith(
      1,
      app,
      new Date("2026-03-24T00:00:00.000Z"),
    );
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenNthCalledWith(
      2,
      app,
      new Date("2026-03-25T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });

  it("does not send yesterday's report before the configured hour arrives", async () => {
    vi.setSystemTime(new Date("2026-03-23T08:00:00.000Z"));
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: 9,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc: 9,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);

    await expect(handler()).resolves.toBeUndefined();
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-21");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).not.toHaveBeenCalled();

    await runtime.shutdown();
  });

  it("throws when a scheduled Telegram report delivery fails so the job can retry", async () => {
    vi.setSystemTime(new Date("2026-03-23T11:00:00.000Z"));
    const reportHourUtc = 9;
    const app = {
      db: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      config: {
        syncObservabilityRetentionDays: 30,
        telegramEnabled: true,
        telegramReportHourUtc: reportHourUtc,
      },
      close: vi.fn(async () => {}),
    };
    const boss = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => {}),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
    };

    dbMocks.getTelegramSettings.mockResolvedValue({
      enabled: true,
      dailyReportEnabled: true,
      reportHourUtc,
    });
    dbMocks.getLatestScheduledReportDateOnOrBefore.mockResolvedValue("2026-03-21");
    telegramReportMocks.sendDailyRevenueTelegramReport.mockResolvedValue({
      delivery: {
        status: "failed",
        error: "connection refused",
      },
      report: {
        reportDate: "2026-03-20",
      },
    });

    const runtime = await startWorkerServices(app as never, boss as never);
    const handler = getTelegramWorkHandler(boss);
    await expect(handler()).rejects.toThrow("Telegram daily report delivery failed: connection refused");
    expect(dbMocks.getTelegramSettings).toHaveBeenCalledWith({}, {
      defaultReportHourUtc: reportHourUtc,
    });
    expect(dbMocks.getLatestScheduledReportDateOnOrBefore).toHaveBeenCalledWith({}, "2026-03-22");
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledWith(
      app,
      new Date("2026-03-23T00:00:00.000Z"),
    );

    await runtime.shutdown();
  });
});
