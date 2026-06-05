import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageSyncLeaseLostError } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

const dbMocks = vi.hoisted(() => ({
  acquirePageSyncLease: vi.fn(),
  blockPageSync: vi.fn(),
  completePageSync: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  retryPageSync: vi.fn(),
  findPageById: vi.fn(),
  heartbeatPageSyncLease: vi.fn(),
  listRunnablePageSync: vi.fn(),
  startSyncRun: vi.fn(),
  yieldPageSync: vi.fn(),
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
    recordSkipped: ReturnType<typeof vi.fn>;
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
    readonly recordSkipped = vi.fn(async () => undefined);
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
    pageId: 55,
    stream: "followers",
    status: "pending",
    requestSeq: 3,
    leasedSeq: 3,
    appliedSeq: 2,
    cadenceSeconds: 43_200,
    slotOffsetSeconds: 10,
    lastScheduledSlot: 40000,
    requestedAt: new Date("2026-03-14T12:00:00.000Z"),
    requestPayload: null,
    retryKind: null,
    retryAt: null,
    blockerKind: null,
    blockerCode: null,
    blockerMessage: null,
    blockedAt: null,
    phase: null,
    workClass: "live",
    progress: {},
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    leaseHeartbeatAt: new Date("2026-03-14T12:00:00.000Z"),
    leaseExpiresAt: new Date("2026-03-14T12:02:00.000Z"),
    enqueuedAt: null,
    startedAt: null,
    progressedAt: null,
    finishedAt: null,
    succeededAt: null,
    failedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    operationId: 99,
    requestSource: "manual",
    platform: "fansly",
    proxyUrl: "socks5://proxy.example",
    egressKey: "shared-proxy-pool",
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
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.acquirePageSyncLease.mockResolvedValue(null);
    dbMocks.blockPageSync.mockResolvedValue({ updated: true, blocked: true });
    dbMocks.completePageSync.mockResolvedValue(true);
    dbMocks.retryPageSync.mockResolvedValue({ updated: true, retried: true });
    dbMocks.findPageById.mockResolvedValue({
      page: {
        id: 55,
        label: "page-55",
        platform: "fansly",
      },
      proxy: {
        url: "socks5://proxy.example",
        rateLimitScopeKey: "shared-proxy-pool",
      },
    });
    dbMocks.heartbeatPageSyncLease.mockResolvedValue(true);
    dbMocks.listRunnablePageSync.mockResolvedValue([]);
    dbMocks.yieldPageSync.mockResolvedValue(true);
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

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([
      {
        pageId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
        egressKey: "shared-proxy-pool",
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

    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, { pageId: 55 });
    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
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
          id: "fansly:shared-proxy-pool",
        },
      }),
    );
    expect(boss.send.mock.invocationCallOrder[0]).toBeLessThan(boss.complete.mock.invocationCallOrder[0]);
  });

  it("passes handler continuation retry time into yielded page sync state", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmMessagesTaskLease = {
      ...taskLease,
      stream: "dm_messages" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmMessagesTaskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { deepBackfillRequests: 1 },
    });

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "dm_messages",
      requestSeq: 3,
      leaseToken: "lease-1",
      retryAt,
      requestSource: "scheduled",
    }));
  });

  it("queues delayed continuation wakeup for paced deep backfill", async () => {
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
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmMessagesTaskLease = {
      ...taskLease,
      stream: "dm_messages" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmMessagesTaskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { deepBackfillRequests: 1 },
    });

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    });

    expect(result).toMatchObject({
      kind: "yielded",
      needsContinuation: true,
      continuationPriority: 25,
      continuationRetryAt: retryAt,
    });
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      expect.objectContaining({
        singletonKey: "55:dm-messages-deep-continuation",
        priority: 25,
        startAfter: retryAt,
        group: {
          id: "fansly:shared-proxy-pool",
        },
      }),
    );
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
  });

  it("does not drain locally when paced deep continuation is already queued", async () => {
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
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmMessagesTaskLease = {
      ...taskLease,
      stream: "dm_messages" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmMessagesTaskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { deepBackfillRequests: 1 },
    });

    await processSyncPageExecuteJob(app, boss as never, {
      job: {
        id: "job-1",
        data: { platformAccountId: 55 },
        groupId: "fansly:direct",
      },
    });

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(handlerMocks.executeStreamChunk).toHaveBeenCalledTimes(1);
    expect(dbMocks.acquirePageSyncLease).toHaveBeenCalledTimes(1);
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
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

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([
      {
        pageId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
        egressKey: "shared-proxy-pool",
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

    dbMocks.acquirePageSyncLease
      .mockResolvedValueOnce(taskLease)
      .mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync
      .mockResolvedValueOnce([{
        pageId: 55,
        platform: "fansly",
        priority: 45,
        requestedAt: new Date("2026-03-14T12:00:00.000Z"),
        proxyUrl: "socks5://proxy.example",
        egressKey: "shared-proxy-pool",
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
    expect(dbMocks.yieldPageSync).toHaveBeenCalledTimes(1);
    expect(dbMocks.completePageSync).toHaveBeenCalledTimes(1);
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

    dbMocks.acquirePageSyncLease.mockImplementation(async () => taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValue([{
      pageId: 55,
      platform: "fansly",
      priority: 45,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
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

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledTimes(1);
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      blockerKind: "auth",
      blockerCode: "credentials_invalid",
      blockerMessage: "expired session",
    }));
    expect(result).toMatchObject({
      kind: "blocked",
      platformAccountId: 55,
      needsContinuation: false,
    });
  });

  it("treats lease loss as a skipped idle result without retrying or blocking", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new PageSyncLeaseLostError(),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      stream: null,
      runId: 777,
      needsContinuation: false,
    });
  });

  it("treats lost leases during retry persistence as skipped", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.retryPageSync.mockResolvedValueOnce({ updated: false, retried: false });
    handlerMocks.executeStreamChunk.mockRejectedValue(new Error("temporary upstream failure"));

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
    }));
    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      stream: null,
      runId: 777,
      needsContinuation: false,
    });
  });

  it("continues newer pending work when stale retry persistence does not apply", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.retryPageSync.mockResolvedValueOnce({ updated: true, retried: false });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
      priority: 40,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockRejectedValue(new Error("temporary upstream failure"));

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      retryKind: "transient_network",
    }));
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        summary: "temporary upstream failure",
      }),
      {
        chunkStatus: "stale_retry",
      },
    );
    expect(result).toMatchObject({
      kind: "failed",
      platformAccountId: 55,
      stream: "followers",
      runId: 777,
      needsContinuation: true,
      continuationPriority: 40,
    });
  });

  it("treats lost leases during auth blocking as skipped", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.blockPageSync.mockResolvedValueOnce({ updated: false, blocked: false });
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      blockerKind: "auth",
      blockerCode: "credentials_invalid",
    }));
    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      stream: null,
      runId: 777,
      needsContinuation: false,
    });
  });

  it("continues newer pending work when stale auth blocking does not apply", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.blockPageSync.mockResolvedValueOnce({ updated: true, blocked: false });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
      priority: 42,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      blockerKind: "auth",
    }));
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        summary: "expired session",
      }),
      {
        chunkStatus: "stale_block",
      },
    );
    expect(result).toMatchObject({
      kind: "failed",
      platformAccountId: 55,
      stream: "followers",
      runId: 777,
      needsContinuation: true,
      continuationPriority: 42,
    });
  });

  it("continues newer pending work when stale manual blocking does not apply", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.blockPageSync.mockResolvedValueOnce({ updated: true, blocked: false });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
      priority: 41,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockRejectedValue(new Error("manual action required upstream"));

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      blockerKind: "manual_action_required",
    }));
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        summary: "manual action required upstream",
      }),
      {
        chunkStatus: "stale_block",
      },
    );
    expect(result).toMatchObject({
      kind: "failed",
      platformAccountId: 55,
      stream: "followers",
      runId: 777,
      needsContinuation: true,
      continuationPriority: 41,
    });
  });

  it("records a failed run when page-context decryption fails before chunk execution", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
    handlerMocks.resolveExecutorPageContext.mockRejectedValue(
      new Error("No encryption key configured for version 1"),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.startSyncRun).toHaveBeenCalledWith({}, {
      platformAccountId: 55,
      stream: "followers",
      generation: 3,
      leaseToken: "lease-1",
      trigger: "manual",
    });
    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      retryKind: "transient_network",
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

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      return {
        satisfied: true,
        stats: { processedThisChunk: 1 },
      };
    });

    await executeNextSyncPageChunk(app, 55);

    expect(telemetryMocks.instances[0]?.recordWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(dbMocks.heartbeatPageSyncLease).toHaveBeenCalledTimes(1);
  });

  it("fences the lease when heartbeat persistence fails", async () => {
    vi.useFakeTimers();

    const logger = { warn: vi.fn(), error: vi.fn() };
    const app = {
      db: {},
      logger,
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.heartbeatPageSyncLease.mockRejectedValueOnce(new Error("db unavailable"));
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      return {
        satisfied: true,
        stats: { processedThisChunk: 1 },
      };
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      stream: null,
      runId: 777,
      needsContinuation: false,
    });
    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        platformAccountId: 55,
        stream: "followers",
      }),
      "Failed to heartbeat page sync lease",
    );
  });

  it("treats chunk errors as skipped when the lease was fenced before the error surfaced", async () => {
    vi.useFakeTimers();

    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.heartbeatPageSyncLease.mockRejectedValueOnce(new Error("db unavailable"));
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      throw new Error("upstream failed after fence");
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      stream: null,
      runId: 777,
      needsContinuation: false,
    });
    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
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

    dbMocks.acquirePageSyncLease
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
