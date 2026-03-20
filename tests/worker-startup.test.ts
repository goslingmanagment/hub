import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  closeOrphanedSyncRuns: vi.fn(),
  deleteExpiredRawPayloads: vi.fn(),
  deleteExpiredSyncObservability: vi.fn(),
}));

const executorMocks = vi.hoisted(() => ({
  startSyncPageExecutor: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  ensurePlannerSchedule: vi.fn(),
  ensureSyncQueues: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/bootstrap.ts", () => ({
  createAppContext: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync/executor.ts", () => executorMocks);
vi.mock("../apps/runtime/src/services/sync/planner.ts", () => ({
  runSyncPlannerCycle: vi.fn(),
}));
vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  ensurePlannerSchedule: queueMocks.ensurePlannerSchedule,
  ensureSyncQueues: queueMocks.ensureSyncQueues,
  RAW_PAYLOAD_CLEANUP_QUEUE: "raw-payload-cleanup",
  SYNC_PLANNER_QUEUE: "sync-planner",
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
    expect(app.logger.info).toHaveBeenCalledWith("Worker started");

    await runtime.shutdown();

    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
