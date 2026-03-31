import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  closeInactiveSyncRuns: vi.fn(),
  ensureSyncTaskRows: vi.fn(),
  scheduleDueSyncTasks: vi.fn(),
  listRunnableSyncPagesV2: vi.fn(),
  markSyncTaskWakeupEnqueued: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  sendSyncPageWakeup: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync-queue.ts", async () => {
  const actual = await vi.importActual<typeof import("../apps/runtime/src/services/sync-queue.ts")>(
    "../apps/runtime/src/services/sync-queue.ts",
  );

  return {
    ...actual,
    sendSyncPageWakeup: queueMocks.sendSyncPageWakeup,
  };
});

import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";

describe("sync planner", () => {
  beforeEach(() => {
    dbMocks.closeInactiveSyncRuns.mockReset();
    dbMocks.ensureSyncTaskRows.mockReset();
    dbMocks.scheduleDueSyncTasks.mockReset();
    dbMocks.listRunnableSyncPagesV2.mockReset();
    dbMocks.markSyncTaskWakeupEnqueued.mockReset();
    queueMocks.sendSyncPageWakeup.mockReset();
    dbMocks.closeInactiveSyncRuns.mockResolvedValue({
      totalCount: 0,
      failedCount: 0,
      partialCount: 0,
    });
  });

  it("runs inactive cleanup before promoting rows and emits one wakeup per runnable page", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:00:00.000Z");
    const order: string[] = [];
    dbMocks.listRunnableSyncPagesV2.mockResolvedValue([
      {
        platformAccountId: 11,
        platform: "fansly",
        priority: 60,
        requestedAt: now,
        proxyUrl: "socks5://proxy-a.example",
      },
      {
        platformAccountId: 22,
        platform: "onlyfans",
        priority: 45,
        requestedAt: now,
        proxyUrl: null,
      },
    ]);
    queueMocks.sendSyncPageWakeup
      .mockResolvedValueOnce("job-11")
      .mockResolvedValueOnce("job-22");
    dbMocks.closeInactiveSyncRuns.mockImplementation(async () => {
      order.push("cleanup");
      return {
        totalCount: 0,
        failedCount: 0,
        partialCount: 0,
      };
    });
    dbMocks.ensureSyncTaskRows.mockImplementation(async () => {
      order.push("ensureSyncTaskRows");
    });
    dbMocks.scheduleDueSyncTasks.mockImplementation(async () => {
      order.push("scheduleDueSyncTasks");
    });

    const pages = await runSyncPlannerCycle({
      db: {},
      logger: { info: vi.fn() },
    } as never, boss, now);

    expect(dbMocks.closeInactiveSyncRuns).toHaveBeenCalledWith({}, {
      inactiveBefore: new Date("2026-03-14T11:58:30.000Z"),
      finishedAt: now,
      errorSummary: "Sync run auto-closed after inactivity",
    });
    expect(dbMocks.ensureSyncTaskRows).toHaveBeenCalledWith({}, { now });
    expect(dbMocks.scheduleDueSyncTasks).toHaveBeenCalledWith({}, { now });
    expect(order).toEqual([
      "cleanup",
      "ensureSyncTaskRows",
      "scheduleDueSyncTasks",
    ]);
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenNthCalledWith(1, boss, {
      egressKey: "socks5://proxy-a.example:1080",
      platformAccountId: 11,
      priority: 60,
      provider: "fansly",
    });
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenNthCalledWith(2, boss, {
      egressKey: "direct",
      platformAccountId: 22,
      priority: 45,
      provider: "onlyfans",
    });
    expect(dbMocks.markSyncTaskWakeupEnqueued).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(2);
  });

  it("does not stamp enqueue metadata when pg-boss deduplicates a wakeup", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:01:00.000Z");
    dbMocks.listRunnableSyncPagesV2.mockResolvedValue([
      {
        platformAccountId: 33,
        platform: "fansly",
        priority: 60,
        requestedAt: now,
        proxyUrl: null,
      },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue(null);

    await runSyncPlannerCycle({
      db: {},
      logger: { info: vi.fn() },
    } as never, boss, now);

    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(boss, {
      egressKey: "direct",
      platformAccountId: 33,
      priority: 60,
      provider: "fansly",
    });
    expect(dbMocks.markSyncTaskWakeupEnqueued).not.toHaveBeenCalled();
  });

  it("logs cleanup counts when inactive runs are auto-closed", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:02:00.000Z");
    const logger = {
      info: vi.fn(),
    };
    dbMocks.listRunnableSyncPagesV2.mockResolvedValue([]);
    dbMocks.closeInactiveSyncRuns.mockResolvedValue({
      totalCount: 2,
      failedCount: 1,
      partialCount: 1,
    });

    await runSyncPlannerCycle({
      db: {},
      logger,
    } as never, boss, now);

    expect(logger.info).toHaveBeenCalledWith({
      finishedAt: now,
      inactiveRunTotal: 2,
      inactiveRunFailed: 1,
      inactiveRunPartial: 1,
    }, "Inactive sync run cleanup complete");
  });
});
