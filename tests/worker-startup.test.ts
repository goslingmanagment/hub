import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  closeOrphanedSyncRuns: vi.fn(),
  deleteExpiredRawPayloads: vi.fn(),
  deleteExpiredSyncObservability: vi.fn(),
  getTelegramSettings: vi.fn(),
  hasScheduledReportForDate: vi.fn(),
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
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync/executor.ts", () => executorMocks);
vi.mock("../apps/runtime/src/services/telegram-report.ts", () => telegramReportMocks);
vi.mock("../apps/runtime/src/services/sync/planner.ts", () => ({
  runSyncPlannerCycle: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  ensureTelegramDailyReportSchedule: queueMocks.ensureTelegramDailyReportSchedule,
  ensurePlannerSchedule: queueMocks.ensurePlannerSchedule,
  ensureSyncQueues: queueMocks.ensureSyncQueues,
  RAW_PAYLOAD_CLEANUP_QUEUE: "raw-payload-cleanup",
  SYNC_PLANNER_QUEUE: "sync-planner",
  TELEGRAM_DAILY_REPORT_QUEUE: "telegram.daily-report",
}));

import { startWorkerServices } from "../apps/runtime/src/worker.ts";

describe("worker startup", () => {
  beforeEach(() => {
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

    dbMocks.closeOrphanedSyncRuns.mockResolvedValue({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });
    queueMocks.ensurePlannerSchedule.mockResolvedValue(undefined);
    queueMocks.ensureSyncQueues.mockResolvedValue(undefined);
    executorMocks.startSyncPageExecutor.mockResolvedValue(undefined);
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
    expect(app.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      processStartedAt,
      orphanedRunTotal: 2,
      orphanedRunFailed: 1,
      orphanedRunPartial: 1,
    }), "Orphaned sync run startup cleanup complete");
    expect(queueMocks.ensureTelegramDailyReportSchedule).toHaveBeenCalledTimes(1);
    expect(queueMocks.ensureTelegramDailyReportSchedule).toHaveBeenCalledWith(boss);
    expect(app.logger.info).toHaveBeenCalledWith("Worker started");

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
    expect(queueMocks.ensurePlannerSchedule).toHaveBeenCalledWith(boss);
    expect(queueMocks.ensureTelegramDailyReportSchedule).toHaveBeenCalledTimes(1);
    expect(queueMocks.ensureTelegramDailyReportSchedule).toHaveBeenCalledWith(boss);
    expect(boss.work).toHaveBeenCalledWith(
      "telegram.daily-report",
      { batchSize: 1 },
      expect.any(Function),
    );

    await runtime.shutdown();
  });

  it("throws when a scheduled Telegram report delivery fails so the job can retry", async () => {
    const reportHourUtc = new Date().getUTCHours();
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
    dbMocks.hasScheduledReportForDate.mockResolvedValue(false);
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
    const workCalls = boss.work.mock.calls as unknown as Array<[string, unknown, () => Promise<unknown>]>;
    const telegramWorkCall = workCalls.find(([queueName]) => queueName === "telegram.daily-report");
    const handler = telegramWorkCall?.[2];

    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("Expected telegram.daily-report handler to be registered");
    }
    await expect(handler()).rejects.toThrow("Telegram daily report delivery failed: connection refused");
    expect(dbMocks.getTelegramSettings).toHaveBeenCalledWith({}, {
      defaultReportHourUtc: reportHourUtc,
    });
    expect(dbMocks.hasScheduledReportForDate).toHaveBeenCalledTimes(1);
    expect(telegramReportMocks.sendDailyRevenueTelegramReport).toHaveBeenCalledWith(app, expect.any(Date));

    await runtime.shutdown();
  });
});
