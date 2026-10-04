import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as CaptureTransportModule from
  "../apps/runtime/src/services/ofapi-capture-transport.ts";
import type * as SyncQueueModule from "../apps/runtime/src/services/sync-queue.ts";
import type * as PostsModule from "../apps/runtime/src/services/sync/posts.ts";

const dbMocks = vi.hoisted(() => ({
  closeInactiveSyncRuns: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  scheduleDuePageSync: vi.fn(),
  listRunnablePageSync: vi.fn(),
  markPageSyncEnqueued: vi.fn(),
  retireLegacyOnlyFansDmMessages: vi.fn(),
  recoverStaleOfapiCaptureWork: vi.fn(),
  listRunnableOfapiCapturePages: vi.fn(),
  findPageById: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  sendSyncPageWakeup: vi.fn(),
}));
const captureTransportMocks = vi.hoisted(() => ({
  recoverExpiredOfapiInteractiveResponses: vi.fn(),
}));
const postsSchedulingMocks = vi.hoisted(() => ({
  pauseIneligibleOnlyFansPostsForAllPages: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync-queue.ts", async () => {
  const actual = await vi.importActual<typeof SyncQueueModule>(
    "../apps/runtime/src/services/sync-queue.ts",
  );

  return {
    ...actual,
    sendSyncPageWakeup: queueMocks.sendSyncPageWakeup,
  };
});
vi.mock("../apps/runtime/src/services/ofapi-capture-transport.ts", async () => {
  const actual = await vi.importActual<typeof CaptureTransportModule>(
    "../apps/runtime/src/services/ofapi-capture-transport.ts",
  );
  return {
    ...actual,
    recoverExpiredOfapiInteractiveResponses:
      captureTransportMocks.recoverExpiredOfapiInteractiveResponses,
  };
});
vi.mock("../apps/runtime/src/services/sync/posts.ts", async () => ({
  ...await vi.importActual<typeof PostsModule>("../apps/runtime/src/services/sync/posts.ts"),
  pauseIneligibleOnlyFansPostsForAllPages:
    postsSchedulingMocks.pauseIneligibleOnlyFansPostsForAllPages,
}));

import { runSyncPlannerCycle } from "../apps/runtime/src/services/sync/planner.ts";

describe("sync planner", () => {
  beforeEach(() => {
    dbMocks.closeInactiveSyncRuns.mockReset();
    dbMocks.ensurePageSyncStates.mockReset();
    dbMocks.scheduleDuePageSync.mockReset();
    dbMocks.listRunnablePageSync.mockReset();
    dbMocks.markPageSyncEnqueued.mockReset();
    dbMocks.retireLegacyOnlyFansDmMessages.mockReset();
    dbMocks.recoverStaleOfapiCaptureWork.mockReset();
    dbMocks.listRunnableOfapiCapturePages.mockReset();
    dbMocks.findPageById.mockReset();
    captureTransportMocks.recoverExpiredOfapiInteractiveResponses.mockReset();
    postsSchedulingMocks.pauseIneligibleOnlyFansPostsForAllPages.mockReset();
    queueMocks.sendSyncPageWakeup.mockReset();
    dbMocks.closeInactiveSyncRuns.mockResolvedValue({
      totalCount: 0,
      failedCount: 0,
      partialCount: 0,
    });
    dbMocks.retireLegacyOnlyFansDmMessages.mockResolvedValue(0);
    dbMocks.recoverStaleOfapiCaptureWork.mockResolvedValue({
      released: 0,
      indeterminate: 0,
      requeued: 0,
    });
    dbMocks.listRunnableOfapiCapturePages.mockResolvedValue([]);
    captureTransportMocks.recoverExpiredOfapiInteractiveResponses.mockResolvedValue({
      scanned: 0,
      terminalized: 0,
      materialized: 0,
      raced: 0,
      unavailable: 0,
      errors: 0,
    });
    postsSchedulingMocks.pauseIneligibleOnlyFansPostsForAllPages.mockResolvedValue(0);
  });

  it("runs inactive cleanup before promoting rows and emits one wakeup per runnable page", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:00:00.000Z");
    const order: string[] = [];
    dbMocks.listRunnablePageSync.mockResolvedValue([
      {
        pageId: 11,
        platform: "onlyfans",
        priority: 60,
        requestedAt: now,
        proxyUrl: "socks5://proxy-a.example",
        egressKey: "socks5://proxy-a.example:1080",
      },
      {
        pageId: 22,
        platform: "onlyfans",
        priority: 45,
        requestedAt: now,
        proxyUrl: null,
        egressKey: "direct",
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
    dbMocks.ensurePageSyncStates.mockImplementation(async () => {
      order.push("ensurePageSyncStates");
    });
    dbMocks.scheduleDuePageSync.mockImplementation(async () => {
      order.push("scheduleDuePageSync");
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
    // Step 4 (S4-10): only the platforms the legacy executor serves.
    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, { now, platforms: ["onlyfans"] });
    expect(postsSchedulingMocks.pauseIneligibleOnlyFansPostsForAllPages).toHaveBeenCalledWith(
      expect.objectContaining({ db: {} }),
      now,
    );
    expect(dbMocks.scheduleDuePageSync).toHaveBeenCalledWith({}, { now, platforms: ["onlyfans"] });
    expect(dbMocks.listRunnablePageSync).toHaveBeenCalledWith({}, now, { platforms: ["onlyfans"] });
    expect(captureTransportMocks.recoverExpiredOfapiInteractiveResponses).toHaveBeenCalledWith(
      expect.objectContaining({ db: {} }),
      { now },
    );
    expect(order).toEqual([
      "cleanup",
      "ensurePageSyncStates",
      "scheduleDuePageSync",
    ]);
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenNthCalledWith(1, boss, {
      egressKey: "socks5://proxy-a.example:1080",
      platformAccountId: 11,
      priority: 60,
      provider: "onlyfans",
    });
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenNthCalledWith(2, boss, {
      egressKey: "direct",
      platformAccountId: 22,
      priority: 45,
      provider: "onlyfans",
    });
    expect(dbMocks.markPageSyncEnqueued).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(2);
  });

  it("does not stamp enqueue metadata when pg-boss deduplicates a wakeup", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:01:00.000Z");
    dbMocks.listRunnablePageSync.mockResolvedValue([
      {
        pageId: 33,
        platform: "onlyfans",
        priority: 60,
        requestedAt: now,
        proxyUrl: null,
        egressKey: "direct",
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
      provider: "onlyfans",
    });
    expect(dbMocks.markPageSyncEnqueued).not.toHaveBeenCalled();
  });

  it("logs cleanup counts when inactive runs are auto-closed", async () => {
    const boss = {
      send: vi.fn(),
    } as never;
    const now = new Date("2026-03-14T12:02:00.000Z");
    const logger = {
      info: vi.fn(),
    };
    dbMocks.listRunnablePageSync.mockResolvedValue([]);
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
