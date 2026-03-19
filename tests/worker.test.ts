import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  ensureSyncStreamStateRows: vi.fn(),
  promoteDueSyncStreamStateRows: vi.fn(),
  listRunnableSyncPages: vi.fn(),
  markSyncPageWakeupEnqueued: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  sendSyncPageWakeup: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
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
    dbMocks.ensureSyncStreamStateRows.mockReset();
    dbMocks.promoteDueSyncStreamStateRows.mockReset();
    dbMocks.listRunnableSyncPages.mockReset();
    dbMocks.markSyncPageWakeupEnqueued.mockReset();
    queueMocks.sendSyncPageWakeup.mockReset();
  });

  it("promotes due rows and emits one wakeup per runnable page", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:00:00.000Z");
    dbMocks.listRunnableSyncPages.mockResolvedValue([
      {
        platformAccountId: 11,
        platform: "fansly",
        priority: 60,
        desiredAt: now,
        proxyUrl: "socks5://proxy-a.example",
      },
      {
        platformAccountId: 22,
        platform: "onlyfans",
        priority: 45,
        desiredAt: now,
        proxyUrl: null,
      },
    ]);
    queueMocks.sendSyncPageWakeup
      .mockResolvedValueOnce("job-11")
      .mockResolvedValueOnce("job-22");

    const pages = await runSyncPlannerCycle({ db: {} } as never, boss, now);

    expect(dbMocks.ensureSyncStreamStateRows).toHaveBeenCalledWith({}, { now });
    expect(dbMocks.promoteDueSyncStreamStateRows).toHaveBeenCalledWith({}, now);
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
    expect(dbMocks.markSyncPageWakeupEnqueued).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(2);
  });

  it("does not stamp enqueue metadata when pg-boss deduplicates a wakeup", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:01:00.000Z");
    dbMocks.listRunnableSyncPages.mockResolvedValue([
      {
        platformAccountId: 33,
        platform: "fansly",
        priority: 60,
        desiredAt: now,
        proxyUrl: null,
      },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue(null);

    await runSyncPlannerCycle({ db: {} } as never, boss, now);

    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(boss, {
      egressKey: "direct",
      platformAccountId: 33,
      priority: 60,
      provider: "fansly",
    });
    expect(dbMocks.markSyncPageWakeupEnqueued).not.toHaveBeenCalled();
  });
});
