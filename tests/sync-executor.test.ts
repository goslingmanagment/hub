import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FanslyApiError } from "@agency_hub_core/fansly";

const dbMocks = vi.hoisted(() => ({
  acquireNextSyncTaskLeaseForPage: vi.fn(),
  blockSyncTaskGeneration: vi.fn(),
  completeSyncTaskGeneration: vi.fn(),
  ensureSyncTaskRows: vi.fn(),
  failSyncTaskGeneration: vi.fn(),
  findPageById: vi.fn(),
  heartbeatSyncTaskLease: vi.fn(),
  listRunnableSyncPagesV2: vi.fn(),
  startSyncRun: vi.fn(),
  yieldSyncTaskGeneration: vi.fn(),
}));

const handlerMocks = vi.hoisted(() => ({
  executeStreamChunk: vi.fn(),
  resolveExecutorPageContext: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  persistFailedSyncPayload: vi.fn(),
}));

const telemetryMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    metadata: Record<string, unknown>;
    recordRunStarted: ReturnType<typeof vi.fn>;
    recordWorkerHeartbeat: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/executor-handlers.ts", () => handlerMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", async () => {
  const actual = await vi.importActual<typeof import("../apps/runtime/src/services/sync/shared.ts")>(
    "../apps/runtime/src/services/sync/shared.ts",
  );

  return {
    ...actual,
    persistFailedSyncPayload: sharedMocks.persistFailedSyncPayload,
  };
});
vi.mock("../apps/runtime/src/services/sync/observability.ts", () => ({
  SyncRunTelemetry: class {
    readonly metadata: Record<string, unknown>;
    readonly recordRunStarted = vi.fn(async () => undefined);
    readonly recordWorkerHeartbeat = vi.fn(async () => undefined);
    readonly finish = vi.fn(async () => undefined);

    constructor(_app: unknown, metadata: Record<string, unknown>) {
      this.metadata = metadata;
      telemetryMocks.instances.push(this);
    }

    getRequestObserver() {
      return null;
    }
  },
}));

import {
  executeNextSyncPageChunk,
  processSyncPageExecuteJob,
  startSyncPageExecutor,
} from "../apps/runtime/src/services/sync/executor.ts";

describe("sync executor", () => {
  const taskLease = {
    platformAccountId: 55,
    task: "followers",
    status: "queued",
    desiredGeneration: 3,
    runningGeneration: 3,
    appliedGeneration: 2,
    scheduleIntervalSeconds: 43_200,
    slotOffsetSeconds: 10,
    lastScheduledSlot: 40000,
    lastRequestedAt: new Date("2026-03-14T12:00:00.000Z"),
    requestPayload: null,
    retryClass: null,
    retryAt: null,
    blockerType: null,
    blockerCode: null,
    blockerReason: null,
    blockedSince: null,
    currentPhase: null,
    currentWorkClass: "live",
    progressPayload: {},
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    leaseHeartbeatAt: new Date("2026-03-14T12:00:00.000Z"),
    leaseExpiresAt: new Date("2026-03-14T12:02:00.000Z"),
    lastEnqueuedAt: null,
    lastStartedAt: null,
    lastProgressAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    operationId: 99,
    operationSource: "manual",
    platform: "fansly",
    proxyUrl: "socks5://proxy.example",
    createdAt: new Date("2026-03-14T12:00:00.000Z"),
    updatedAt: new Date("2026-03-14T12:00:00.000Z"),
  } as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    for (const mock of Object.values(handlerMocks)) {
      mock.mockReset();
    }
    sharedMocks.persistFailedSyncPayload.mockReset();
    telemetryMocks.instances.length = 0;

    dbMocks.startSyncRun.mockResolvedValue({
      id: 777,
      startedAt: new Date("2026-03-14T12:00:00.000Z"),
    });
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValue(null);
    dbMocks.blockSyncTaskGeneration.mockResolvedValue(true);
    dbMocks.completeSyncTaskGeneration.mockResolvedValue(true);
    dbMocks.failSyncTaskGeneration.mockResolvedValue(true);
    dbMocks.findPageById.mockResolvedValue({
      page: {
        id: 55,
        label: "page-55",
        platform: "fansly",
      },
      proxy: {
        url: "socks5://proxy.example",
      },
    });
    dbMocks.heartbeatSyncTaskLease.mockResolvedValue(true);
    dbMocks.listRunnableSyncPagesV2.mockResolvedValue([]);
    dbMocks.yieldSyncTaskGeneration.mockResolvedValue(true);
    handlerMocks.resolveExecutorPageContext.mockResolvedValue({
      platform: "fansly",
      page: {
        id: 55,
        label: "page-55",
      },
      session: { authorization: "token" },
      proxy: null,
    });
  });

  it("queues the continuation wakeup before completing the current job", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const boss = {
      complete: vi.fn(async () => {}),
      send: vi.fn(async () => "job-next"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnableSyncPagesV2.mockResolvedValueOnce([
      {
        platformAccountId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
      },
    ]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedThisChunk: 100 },
    });

    await processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    });

    expect(dbMocks.ensureSyncTaskRows).toHaveBeenCalledWith({}, { platformAccountId: 55 });
    expect(dbMocks.yieldSyncTaskGeneration).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      task: "followers",
      generation: 3,
      leaseToken: "lease-1",
    }));
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      expect.objectContaining({
        singletonKey: undefined,
        priority: 45,
        group: {
          id: "fansly:socks5://proxy.example:1080",
        },
      }),
    );
    expect(boss.send.mock.invocationCallOrder[0]).toBeLessThan(boss.complete.mock.invocationCallOrder[0]);
  });

  it("does not complete the current job when the continuation wakeup fails", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const boss = {
      complete: vi.fn(async () => {}),
      send: vi.fn(async () => {
        throw new Error("queue unavailable");
      }),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnableSyncPagesV2.mockResolvedValueOnce([
      {
        platformAccountId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
      },
    ]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedThisChunk: 100 },
    });

    await expect(processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    })).rejects.toThrow("queue unavailable");

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.complete).not.toHaveBeenCalled();
  });

  it("continues draining locally when PgBoss cannot enqueue a duplicate continuation", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const boss = {
      complete: vi.fn(async () => {}),
      send: vi.fn(async () => null),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquireNextSyncTaskLeaseForPage
      .mockResolvedValueOnce(taskLease)
      .mockResolvedValueOnce(taskLease);
    dbMocks.listRunnableSyncPagesV2
      .mockResolvedValueOnce([{
        platformAccountId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
      }])
      .mockResolvedValueOnce([]);
    handlerMocks.executeStreamChunk
      .mockResolvedValueOnce({
        satisfied: false,
        yieldReason: "request_budget",
        stats: { processedThisChunk: 100 },
      })
      .mockResolvedValueOnce({
        satisfied: true,
        stats: { processedThisChunk: 1 },
      });

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    });

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(handlerMocks.executeStreamChunk).toHaveBeenCalledTimes(2);
    expect(dbMocks.yieldSyncTaskGeneration).toHaveBeenCalledTimes(1);
    expect(dbMocks.completeSyncTaskGeneration).toHaveBeenCalledTimes(1);
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
    expect(result).toMatchObject({
      kind: "success",
      platformAccountId: 55,
      needsContinuation: false,
    });
  });

  it("fails instead of draining forever when continuation wakeups keep getting skipped", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const boss = {
      complete: vi.fn(async () => {}),
      send: vi.fn(async () => null),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquireNextSyncTaskLeaseForPage.mockImplementation(async () => taskLease);
    dbMocks.listRunnableSyncPagesV2.mockResolvedValue([{
      platformAccountId: 55,
      platform: "fansly",
      priority: 45,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedThisChunk: 1 },
    });

    await expect(processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    })).rejects.toThrow("Sync page executor exceeded 500 local chunks for page 55");

    expect(handlerMocks.executeStreamChunk).toHaveBeenCalledTimes(500);
    expect(boss.complete).not.toHaveBeenCalled();
  });

  it("marks auth failures durably and does not request continuation", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledTimes(1);
    expect(dbMocks.blockSyncTaskGeneration).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      task: "followers",
      generation: 3,
      blockerType: "auth",
      blockerCode: "credentials_invalid",
      blockerReason: "expired session",
    }));
    expect(result).toMatchObject({
      kind: "auth_failed",
      platformAccountId: 55,
      needsContinuation: false,
    });
  });

  it("records a failed run when page-context decryption fails before chunk execution", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnableSyncPagesV2.mockResolvedValueOnce([]);
    handlerMocks.resolveExecutorPageContext.mockRejectedValue(
      new Error("No encryption key configured for version 1"),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.startSyncRun).toHaveBeenCalledWith({}, {
      platformAccountId: 55,
      stream: "followers",
      task: "followers",
      operationId: 99,
      generation: 3,
      leaseToken: "lease-1",
      trigger: "manual",
    });
    expect(dbMocks.failSyncTaskGeneration).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      task: "followers",
      generation: 3,
      leaseToken: "lease-1",
      retryClass: "transient_network",
    }));
    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledWith(app, expect.objectContaining({
      platformAccountId: 55,
      syncRunId: 777,
      platform: "fansly",
      endpoint: "followers",
    }));
    expect(telemetryMocks.instances[0]?.recordRunStarted).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        summary: expect.stringContaining("No encryption key configured for version 1"),
      }),
      {
        chunkStatus: "failed",
      },
    );
    expect(result).toMatchObject({
      kind: "failed",
      platformAccountId: 55,
      runId: 777,
      needsContinuation: false,
    });
  });

  it("keeps long-running chunks alive with a worker heartbeat", async () => {
    vi.useFakeTimers();

    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquireNextSyncTaskLeaseForPage.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      return {
        satisfied: true,
        stats: { processedThisChunk: 1 },
      };
    });

    await executeNextSyncPageChunk(app, 55);

    expect(telemetryMocks.instances[0]?.recordWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(dbMocks.heartbeatSyncTaskLease).toHaveBeenCalledTimes(1);
  });

  it("executor workers fetch with groupConcurrency and ignore active groups", async () => {
    vi.useFakeTimers();

    const abortController = new AbortController();
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });

    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
      config: { syncPageExecutorConcurrency: 2 },
    } as never;
    const boss = {
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      fetch: vi.fn(async (_queueName: string, options: Record<string, unknown>) => {
        const callNumber = boss.fetch.mock.calls.length;
        if (callNumber === 1) {
          expect(options).toMatchObject({
            batchSize: 1,
            includeMetadata: true,
            priority: true,
            orderByCreatedOn: true,
            groupConcurrency: 1,
            ignoreGroups: null,
          });
          return [{
            id: "job-1",
            data: { platformAccountId: 55 },
            groupId: "fansly:direct",
          }];
        }

        expect(options).toMatchObject({
          batchSize: 1,
          includeMetadata: true,
          priority: true,
          orderByCreatedOn: true,
          groupConcurrency: 1,
          ignoreGroups: ["fansly:direct"],
        });
        abortController.abort();
        releaseChunk();
        return [];
      }),
      send: vi.fn(async () => null),
      touch: vi.fn(async () => {}),
    };

    dbMocks.acquireNextSyncTaskLeaseForPage
      .mockResolvedValueOnce(taskLease)
      .mockResolvedValueOnce(null);
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await chunkGate;
      return {
        satisfied: true,
        stats: { processedThisChunk: 1 },
      };
    });

    const executorPromise = startSyncPageExecutor(app, boss as never, {
      signal: abortController.signal,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await executorPromise;

    expect(boss.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
    expect(boss.fail).not.toHaveBeenCalled();
  });
});
