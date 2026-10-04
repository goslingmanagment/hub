import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as NotificationIncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";
import type * as SyncSharedModule from "../apps/runtime/src/services/sync/shared.ts";

import { OfapiCollectionPolicyError, PageSyncLeaseLostError } from "@agency_hub_core/db";
import { executeObservedRequest, waitForHttpRequestDelay } from "@agency_hub_core/shared";

import { OfapiApiError } from "../apps/runtime/src/services/ofapi.ts";
import {
  PostsCaptureConfigurationError,
  PostsCaptureJobBlockedError,
} from "../apps/runtime/src/services/sync/posts.ts";

const dbMocks = vi.hoisted(() => ({
  acquirePageSyncLease: vi.fn(),
  blockPageSync: vi.fn(),
  clearPageSyncLease: vi.fn(),
  completePageSync: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  retryPageSync: vi.fn(),
  findPageById: vi.fn(),
  heartbeatPageSyncLease: vi.fn(),
  listRunnablePageSync: vi.fn(),
  listRunnableOfapiCapturePages: vi.fn(),
  // Required, not optional: the module factory spreads dbMocks over the REAL
  // module, so an unmocked skipPageSync would run for real and hit db.execute.
  skipPageSync: vi.fn(),
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

const notificationMocks = vi.hoisted(() => ({
  notifyOfapiGlobalIncident: vi.fn(),
  notifySyncChunkFailureIncident: vi.fn(),
  resolveOfapiGlobalIncident: vi.fn(),
  resolveSyncChunkRecoveryIncidents: vi.fn(),
}));

const telemetryMocks = vi.hoisted(() => ({
  lastSuccessfulAttemptAt: null as Date | null,
  instances: [] as Array<{
    metadata: Record<string, unknown>;
    recordRunStarted: ReturnType<typeof vi.fn>;
    recordWorkerHeartbeat: ReturnType<typeof vi.fn>;
    recordSkipped: ReturnType<typeof vi.fn>;
    addAnomaly: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/executor-handlers.ts", () => handlerMocks);
// The real registry assembles its pull maps from the handlers mocked above.
// The executor reads only the legacy executor's platform set, through the
// boundary (`sync/onlyfans/boundary.ts`, real here): the adapters that declare
// a stream — OnlyFans only, as tests/platform-registry.test.ts pins.
vi.mock("../apps/runtime/src/platforms/registry.ts", () => ({
  appPlatformRegistry: {
    all: () => [
      { key: "fansly", capabilities: { streams: [] } },
      { key: "onlyfans", capabilities: { streams: ["light", "subscribers"] } },
    ],
  },
}));
vi.mock("../apps/runtime/src/services/sync/shared.ts", async () => {
  const actual = await vi.importActual<typeof SyncSharedModule>(
    "../apps/runtime/src/services/sync/shared.ts",
  );

  return {
    ...actual,
    persistFailedSyncPayload: sharedMocks.persistFailedSyncPayload,
  };
});
vi.mock("../apps/runtime/src/services/notification-incidents.ts", () => notificationMocks);
vi.mock("../apps/runtime/src/services/sync/observability.ts", () => ({
  SyncRunTelemetry: class {
    readonly metadata: Record<string, unknown>;
    readonly recordRunStarted = vi.fn(async () => undefined);
    readonly recordWorkerHeartbeat = vi.fn(async () => undefined);
    readonly recordSkipped = vi.fn(async () => undefined);
    readonly addAnomaly = vi.fn(async () => undefined);
    readonly finish = vi.fn(async () => undefined);

    constructor(_app: unknown, metadata: Record<string, unknown>) {
      this.metadata = metadata;
      telemetryMocks.instances.push(this);
    }

    getRequestObserver() {
      return null;
    }

    getRequestTotalsSnapshot() {
      const at = telemetryMocks.lastSuccessfulAttemptAt;
      return { successfulAttempts: at ? 1 : 0, lastSuccessfulAttemptAt: at };
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
    stream: "subscribers",
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
    dispatchSource: "manual",
    platform: "onlyfans",
    proxyUrl: "socks5://proxy.example",
    egressKey: "shared-proxy-pool",
    createdAt: new Date("2026-03-14T12:00:00.000Z"),
    updatedAt: new Date("2026-03-14T12:00:00.000Z"),
  } as const;

  function createQueueHandoffApp(input?: { handoffSafe?: boolean }) {
    const client = {
      query: vi.fn(async (statement: string, _values?: unknown[]) => (
        statement.includes("select clock_timestamp()")
          ? { rows: [{ safe: input?.handoffSafe ?? true }] }
          : { rows: [] }
      )),
      release: vi.fn(),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const app = {
      db: {},
      logger,
      pool: {
        connect: vi.fn(async () => client),
      },
    } as never;
    return { app, client, logger };
  }

  function buildQueueJob(input?: {
    startedOn?: Date;
    expireInSeconds?: number;
    retryLimit?: number;
    singletonKey?: string | null;
  }) {
    return {
      id: "job-1",
      data: { platformAccountId: 55 },
      groupId: "onlyfans:direct",
      startedOn: input?.startedOn ?? new Date(),
      expireInSeconds: input?.expireInSeconds ?? 900,
      retryLimit: input?.retryLimit ?? 0,
      singletonKey: input?.singletonKey ?? "55",
    };
  }

  function completionResult(affected = 1) {
    return { jobs: ["job-1"], requested: 1, affected };
  }

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
    for (const mock of Object.values(notificationMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    telemetryMocks.instances.length = 0;
    telemetryMocks.lastSuccessfulAttemptAt = null;

    dbMocks.startSyncRun.mockResolvedValue({
      id: 777,
      startedAt: new Date("2026-03-14T12:00:00.000Z"),
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.acquirePageSyncLease.mockResolvedValue(null);
    dbMocks.blockPageSync.mockResolvedValue({ updated: true, blocked: true });
    dbMocks.completePageSync.mockResolvedValue(true);
    dbMocks.skipPageSync.mockResolvedValue(true);
    dbMocks.retryPageSync.mockResolvedValue({ updated: true, retried: true });
    dbMocks.findPageById.mockResolvedValue({
      page: {
        id: 55,
        label: "page-55",
        platform: "onlyfans",
      },
      proxy: {
        url: "socks5://proxy.example",
        rateLimitScopeKey: "shared-proxy-pool",
      },
    });
    dbMocks.heartbeatPageSyncLease.mockResolvedValue(true);
    dbMocks.clearPageSyncLease.mockResolvedValue(true);
    dbMocks.listRunnablePageSync.mockResolvedValue([]);
    dbMocks.listRunnableOfapiCapturePages.mockResolvedValue([]);
    dbMocks.yieldPageSync.mockResolvedValue({ updated: true, superseded: false });
    handlerMocks.resolveExecutorPageContext.mockResolvedValue({
      platform: "onlyfans",
      page: {
        id: 55,
        label: "page-55",
      },
      auth: { token: "" },
      proxy: null,
    });
  });

  it.each([
    ["a partial with no successful response", false, null],
    ["a partial with a successful response", false, "last_success"],
    ["a completion with no successful response", true, null],
    ["a completion with a successful response", true, "last_success"],
  ] as const)("recovers page-wide incidents only from provider evidence: %s", async (_name, satisfied, expected) => {
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    const lastSuccessAt = new Date(Date.now() - 1_000);
    telemetryMocks.lastSuccessfulAttemptAt = expected === "last_success" ? lastSuccessAt : null;
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "top_spenders" });
    // A top_spenders chunk computes from stored transactions: it completes
    // without a request, and a completion is not a provider answer.
    handlerMocks.executeStreamChunk.mockImplementation(async () => (satisfied
      ? { satisfied: true, yieldReason: null, stats: { windowsProcessed: 1 } }
      : { satisfied: false, yieldReason: "request_budget", stats: { windowsProcessed: 0 } }));
    await executeNextSyncPageChunk(app, 55);
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledWith(app, expect.objectContaining({
      providerRecoveredAt: expected === "last_success" ? lastSuccessAt : null,
      recoveredAt: expect.any(Date),
      stream: "top_spenders",
    }));
  });

  it("settles an unverified audience sweep without success or incident recovery", async () => {
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "subscribers" });
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true, yieldReason: null, qualityHold: "subscribers_empty_sweep_guard",
      stats: { fullSweepCompleted: true, destructiveFinalizationSkipped: true },
    });
    expect(await executeNextSyncPageChunk(app, 55)).toMatchObject({ kind: "skipped", stream: "subscribers" });
    expect(dbMocks.skipPageSync).toHaveBeenCalledOnce();
    expect(dbMocks.skipPageSync.mock.calls[0]?.[1]).not.toHaveProperty("progressedAt");
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith("skipped", "subscribers_empty_sweep_guard",
      expect.objectContaining({ qualityHold: "subscribers_empty_sweep_guard" }));
    expect(telemetryMocks.instances[0]?.finish.mock.calls[0]?.[2]).not.toHaveProperty("gatedSkip");
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).not.toHaveBeenCalled();
    expect(notificationMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
  });

  it("settles a gated no-op as skipped without claiming data success", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "top_spenders" as const,
      progress: {
        pendingTargets: 17,
        previousCounter: 4,
      },
      progressedAt: new Date("2026-03-13T12:00:00.000Z"),
      succeededAt: new Date("2026-03-13T11:00:00.000Z"),
    });
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      gatedSkip: "onlyfans_top_spenders_disabled",
      stats: { skipped: "onlyfans_top_spenders_disabled" },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({ kind: "skipped", stream: "top_spenders" });
    expect(dbMocks.skipPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "top_spenders",
      progress: { skipped: "onlyfans_top_spenders_disabled" },
    }));
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "skipped",
      "onlyfans_top_spenders_disabled",
      expect.objectContaining({
        skipped: "onlyfans_top_spenders_disabled",
        gatedSkip: "onlyfans_top_spenders_disabled",
      }),
    );
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).not.toHaveBeenCalled();
  });

  it("replaces stale progress with the current chunk snapshot after real work", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "fan_identities" as const,
      progress: {
        skipped: "onlyfans_top_spenders_disabled",
        pendingTargets: 17,
      },
    });
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      stats: {
        targetsFetched: 2,
        walkCompleted: true,
      },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({ kind: "success", stream: "fan_identities" });
    expect(dbMocks.completePageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      progress: {
        targetsFetched: 2,
        walkCompleted: true,
      },
    }));
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledTimes(1);
  });

  it("atomically completes the parent before enqueueing one fixed-key continuation", async () => {
    const { app, client } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => "job-next"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([
      {
        pageId: 55,
        platform: "onlyfans",
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
      // DB says the attempt is live; a process-clock check would reject this
      // deliberately ancient metadata value.
      job: buildQueueJob({
        startedOn: new Date("2000-01-01T00:00:00.000Z"),
        expireInSeconds: 900,
      }),
    });

    // Seeding and the lease cover only the legacy executor's platforms (S4-10).
    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, { pageId: 55, platforms: ["onlyfans"] });
    expect(dbMocks.acquirePageSyncLease).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      platforms: ["onlyfans"],
    }));
    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
      requestSeq: 3,
      leaseToken: "lease-1",
    }));
    expect(boss.complete).toHaveBeenCalledWith(
      "sync.page.execute",
      "job-1",
      null,
      { db: expect.objectContaining({ executeSql: expect.any(Function) }) },
    );
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      expect.objectContaining({
        singletonKey: "55",
        priority: 45,
        expireInSeconds: 900,
        retryLimit: 0,
        group: {
          id: "onlyfans:shared-proxy-pool",
        },
      }),
    );
    expect(boss.complete.mock.invocationCallOrder[0]!).toBeLessThan(boss.send.mock.invocationCallOrder[0]!);
    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain("select clock_timestamp()");
    expect(statements.slice(1)).toEqual(["begin", "commit"]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("rolls a grandfathered queue attempt forward before vendor work", async () => {
    const { app, client, logger } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => "job-current-contract"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 25,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob({
        expireInSeconds: 180,
        retryLimit: 2,
        singletonKey: "55:continuation:old-parent",
      }),
    });

    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
    expect(dbMocks.ensurePageSyncStates).not.toHaveBeenCalled();
    expect(dbMocks.acquirePageSyncLease).not.toHaveBeenCalled();
    expect(dbMocks.startSyncRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      needsContinuation: true,
      continuationPriority: 25,
    });
    expect(boss.complete).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      expect.objectContaining({
        singletonKey: "55",
        priority: 25,
        expireInSeconds: 900,
        retryLimit: 0,
        group: { id: "onlyfans:shared-proxy-pool" },
      }),
    );
    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain("select clock_timestamp()");
    expect(statements.slice(1)).toEqual(["begin", "commit"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        expireInSeconds: 180,
        retryLimit: 2,
        singletonKey: "55:continuation:old-parent",
      }),
      "Detected grandfathered sync page wakeup; attempting atomic rollover before vendor work",
    );
  });

  it("replaces a grandfathered wakeup even when the durable snapshot is not runnable", async () => {
    const { app } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => "unexpected-child"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob({
        singletonKey: "55:continuation:old-parent",
      }),
    });

    expect(result).toMatchObject({ needsContinuation: true, continuationPriority: 0 });
    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
    expect(dbMocks.acquirePageSyncLease).not.toHaveBeenCalled();
    expect(boss.complete).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      expect.objectContaining({ singletonKey: "55", expireInSeconds: 900, retryLimit: 0 }),
    );
  });

  it("completes a grandfathered wakeup without replacement for a missing page", async () => {
    const { app } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => "unexpected-child"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    dbMocks.findPageById.mockResolvedValueOnce(null);

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob({ singletonKey: "55:continuation:old-parent" }),
    });

    expect(result).toMatchObject({ needsContinuation: false });
    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
    expect(dbMocks.listRunnablePageSync).not.toHaveBeenCalled();
    expect(boss.complete).toHaveBeenCalledTimes(1);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("consumes a manual priority boost after one generic partial chunk", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "dm_conversations" as const,
      requestSource: "manual" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 25,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedMessages: 100 },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "dm_conversations",
      dispatchSource: "scheduled",
    }));
    expect(result).toMatchObject({
      kind: "yielded",
      continuationPriority: 25,
    });
  });

  it("honors an explicit continuation dispatch source", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "dm_conversations" as const,
      requestSource: "manual" as const,
      dispatchSource: "manual" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 35,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      continuationRequestSource: "recovery",
      stats: { processedMessages: 100 },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      dispatchSource: "recovery",
    }));
    expect(result).toMatchObject({ continuationPriority: 35 });
  });

  it("passes handler continuation retry time into yielded page sync state", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmTaskLease = {
      ...taskLease,
      stream: "dm_conversations" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmTaskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { chatsRead: 1 },
    });

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "dm_conversations",
      requestSeq: 3,
      leaseToken: "lease-1",
      retryAt,
      dispatchSource: "scheduled",
    }));
  });

  it("keeps a newer manual generation immediately runnable when an old chunk yields", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date("2026-03-14T13:00:00.000Z");

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "dm_conversations" as const,
    });
    dbMocks.yieldPageSync.mockResolvedValueOnce({ updated: true, superseded: true });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 65,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { processedMessages: 1 },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({
      kind: "yielded",
      continuationPriority: 65,
      continuationRetryAt: null,
    });
  });

  it("continues another runnable stream instead of parking the whole page behind a delayed yield", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date("2026-03-14T13:00:00.000Z");

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "dm_conversations" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 60,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { processedMessages: 1 },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({
      kind: "yielded",
      continuationPriority: 60,
      continuationRetryAt: null,
    });
  });

  it("persists delayed continuation in page state without queue-blocking urgent work", async () => {
    const { app } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => "job-next"),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmTaskLease = {
      ...taskLease,
      stream: "dm_conversations" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmTaskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { chatsRead: 1 },
    });

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob(),
    });

    expect(result).toMatchObject({
      kind: "yielded",
      needsContinuation: true,
      // resolvePageSyncPriority("dm_conversations", "scheduled")
      continuationPriority: 30,
      continuationRetryAt: retryAt,
    });
    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({ retryAt }));
    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.complete).toHaveBeenCalledWith(
      "sync.page.execute",
      "job-1",
      null,
      { db: expect.objectContaining({ executeSql: expect.any(Function) }) },
    );
  });

  it("executes only one chunk when continuation is delayed", async () => {
    const { app } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => null),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    const retryAt = new Date("2026-03-14T12:00:22.000Z");
    const dmTaskLease = {
      ...taskLease,
      stream: "dm_conversations" as const,
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(dmTaskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false,
      yieldReason: null,
      continuationRetryAt: retryAt,
      continuationRequestSource: "scheduled",
      stats: { chatsRead: 1 },
    });

    await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob(),
    });

    expect(boss.send).not.toHaveBeenCalled();
    expect(handlerMocks.executeStreamChunk).toHaveBeenCalledTimes(1);
    expect(dbMocks.acquirePageSyncLease).toHaveBeenCalledTimes(1);
    expect(boss.complete).toHaveBeenCalledTimes(1);
  });

  it("rolls parent completion back when continuation enqueue fails", async () => {
    const { app, client } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
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
        platform: "onlyfans",
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
      job: buildQueueJob(),
    })).rejects.toThrow("queue unavailable");

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.complete).toHaveBeenCalledTimes(1);
    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain("select clock_timestamp()");
    expect(statements.slice(1)).toEqual(["begin", "rollback"]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("hands off instead of draining locally when the continuation is already queued (null send)", async () => {
    // The old code read a NULL-key collision as "keep going locally" and
    // wedged the whole egress group. The fixed page key makes null mean that
    // this page already has its one wakeup; parent completion still commits.
    const { app, client } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => null),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 45,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValueOnce({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedThisChunk: 100 },
    });

    const result = await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob(),
    });

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(handlerMocks.executeStreamChunk).toHaveBeenCalledTimes(1);
    expect(boss.complete).toHaveBeenCalledTimes(1);
    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain("select clock_timestamp()");
    expect(statements.slice(1)).toEqual(["begin", "commit"]);
    expect(result).toMatchObject({
      kind: "yielded",
      platformAccountId: 55,
      needsContinuation: true,
    });
  });

  it("does not send or complete after the safe handoff deadline", async () => {
    // pg-boss expiration is a hard wall clock from job start (touch feeds
    // only the heartbeat monitor), so a long chunk can outlive its job. The
    // executor must notice and stop instead of zombie-driving chunks under
    // a job the queue already handed to retry.
    const { app, client } = createQueueHandoffApp({ handoffSafe: false });
    const boss = {
      complete: vi.fn(async () => completionResult()),
      send: vi.fn(async () => null),
    } as unknown as {
      complete: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };

    dbMocks.acquirePageSyncLease.mockImplementation(async () => taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValue([{
      pageId: 55,
      platform: "onlyfans",
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

    const result = await processSyncPageExecuteJob(app, boss as never, {
      // A process-clock comparison would consider this far-future job safe;
      // the database answer is authoritative.
      job: buildQueueJob({
        startedOn: new Date(Date.now() + 86_400_000),
        singletonKey: "55:continuation:unsafe-parent",
      }),
    });

    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.complete).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]?.[0]).toContain("select clock_timestamp()");
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({ platformAccountId: 55, needsContinuation: true });
  });

  it("does not enqueue when atomic completion reports lost ownership", async () => {
    const { app, client, logger } = createQueueHandoffApp();
    const boss = {
      complete: vi.fn(async () => completionResult(0)),
      send: vi.fn(async () => "job-next"),
    };

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "onlyfans",
      priority: 45,
      requestedAt: new Date("2026-03-14T12:00:00.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockResolvedValueOnce({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { processedThisChunk: 1 },
    });

    await processSyncPageExecuteJob(app, boss as never, {
      job: buildQueueJob({ singletonKey: "55:continuation:lost-owner" }),
    });

    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();
    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain("select clock_timestamp()");
    expect(statements.slice(1)).toEqual(["begin", "rollback"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", platformAccountId: 55 }),
      "Sync page execute job no longer owns its queue attempt; skipping handoff",
    );
  });

  it("releases the lease and goes idle when the leased page is missing or tombstoned", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    // findPageById filters status='active': a page tombstoned after scheduling
    // resolves to null. This must park the stream, not throw — a throw here
    // used to loop forever through pg-boss retries + lease reclaim.
    dbMocks.findPageById.mockResolvedValueOnce(null);

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({
      kind: "idle",
      platformAccountId: 55,
      runId: null,
      needsContinuation: false,
    });
    expect(dbMocks.clearPageSyncLease).toHaveBeenCalledWith({}, {
      pageId: 55,
      stream: "subscribers",
      leaseToken: "lease-1",
      nextStatus: "paused",
    });
    // No run row, no telemetry, no chunk execution for a dead page.
    expect(dbMocks.startSyncRun).not.toHaveBeenCalled();
    expect(telemetryMocks.instances).toHaveLength(0);
    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
  });

  it("stops at the boundary when the leased page is of a platform the legacy executor does not serve", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    // The lease is scoped to the served platforms, so this is a broken scope:
    // the chunk must not open a run or reach a handler for a Fansly page.
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.findPageById.mockResolvedValueOnce({
      page: { id: 55, label: "page-55", platform: "fansly" },
      proxy: null,
    });

    await expect(executeNextSyncPageChunk(app, 55)).rejects.toMatchObject({
      name: "LegacyExecutorBoundaryError",
      pageId: 55,
      platform: "fansly",
      site: "executor",
    });

    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, expect.objectContaining({ platforms: ["onlyfans"] }));
    expect(dbMocks.acquirePageSyncLease).toHaveBeenCalledWith({}, expect.objectContaining({ platforms: ["onlyfans"] }));
    expect(dbMocks.startSyncRun).not.toHaveBeenCalled();
    expect(telemetryMocks.instances).toHaveLength(0);
    expect(handlerMocks.resolveExecutorPageContext).not.toHaveBeenCalled();
    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
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
      stream: "subscribers",
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
      platform: "onlyfans",
      priority: 40,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockRejectedValue(new Error("temporary upstream failure"));

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
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
      stream: "subscribers",
      runId: 777,
      needsContinuation: true,
      continuationPriority: 40,
    });
  });

  it("records posts gate or mapping races as configuration errors, never successful skips", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "posts" as const,
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new PostsCaptureConfigurationError("ofapi_account_unmapped"),
    );

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "posts",
      retryKind: "configuration_wait",
    }));
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    expect(dbMocks.skipPageSync).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "failed",
      expect.objectContaining({
        summary: expect.stringContaining("requires an OFAPI account mapping"),
      }),
      { chunkStatus: "failed" },
    );
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
      platform: "onlyfans",
      priority: 41,
      requestedAt: new Date("2026-03-14T12:00:01.000Z"),
      proxyUrl: "socks5://proxy.example",
      egressKey: "shared-proxy-pool",
    }]);
    handlerMocks.executeStreamChunk.mockRejectedValue(new Error("manual action required upstream"));

    const result = await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
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
      stream: "subscribers",
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
      stream: "subscribers",
      generation: 3,
      leaseToken: "lease-1",
      trigger: "manual",
    });
    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
      requestSeq: 3,
      leaseToken: "lease-1",
      retryKind: "transient_network",
    }));
    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledWith(app, expect.objectContaining({
      platformAccountId: 55,
      syncRunId: 777,
      platform: "onlyfans",
      endpoint: "subscribers",
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

  it("sleeps until a collection cap resets under its own retry class, with no incident (review #136)", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const resetAt = new Date("2026-09-08T00:00:00.000Z");

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new OfapiCollectionPolicyError("daily_limit", { retryAt: resetAt }),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    // The owner's own daily budget, refused locally before any fetch: not a
    // vendor outage, so not the transient backoff ladder (which would poll
    // every 30 min until midnight) and not a "stream failed 3x" page.
    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
      retryKind: "ofapi_collection_policy",
      retryAt: resetAt,
      errorCode: "ofapi_collection_daily_limit",
    }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).not.toHaveBeenCalled();
    expect(notificationMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "failed", runId: 777 });
  });

  it("re-checks a paused background collection on a short cadence instead of parking (review #136)", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new OfapiCollectionPolicyError("background_paused"),
    );
    const before = Date.now();

    await executeNextSyncPageChunk(app, 55);

    // Resume must heal the stream by itself: a parked stream would silently
    // stop capture for every OFAPI page after the owner lifts the pause.
    const call = dbMocks.retryPageSync.mock.calls[0]?.[1] as { retryKind: string; retryAt?: Date };
    expect(call.retryKind).toBe("ofapi_collection_policy");
    expect(call.retryAt).toBeInstanceOf(Date);
    expect(call.retryAt!.getTime() - before).toBeGreaterThanOrEqual(14 * 60_000);
    expect(call.retryAt!.getTime() - before).toBeLessThanOrEqual(16 * 60_000);
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).not.toHaveBeenCalled();
  });

  it("parks a stream whose collection category is switched off, with no incident (review #136)", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new OfapiCollectionPolicyError("collection_off"),
    );

    await executeNextSyncPageChunk(app, 55);

    // A durable owner decision that no clock clears: park it for the owner,
    // who already sees the decision in the collection console.
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
      blockerKind: "manual_action_required",
      blockerCode: "ofapi_collection_collection_off",
      errorCode: "ofapi_collection_collection_off",
    }));
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).not.toHaveBeenCalled();
  });

  it("parks a stream immediately when its governed OFAPI capture job is blocked", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "posts",
      platform: "onlyfans",
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new PostsCaptureJobBlockedError("job-1", "indeterminate"),
    );

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "posts",
      blockerKind: "manual_action_required",
      blockerCode: "ofapi_capture_job_indeterminate",
    }));
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ forceOpen: true }),
    );
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
        stream: "subscribers",
      }),
      "Failed to heartbeat page sync lease",
    );
  });

  it.each([
    { waiting: "rate", heartbeat: "lost" },
    { waiting: "retry", heartbeat: "lost" },
    { waiting: "rate", heartbeat: "error" },
    { waiting: "retry", heartbeat: "error" },
  ])("stops physical attempts during $waiting wait after heartbeat $heartbeat", async ({ waiting, heartbeat }) => {
    vi.useFakeTimers();
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    if (heartbeat === "lost") dbMocks.heartbeatPageSyncLease.mockResolvedValueOnce(false);
    else dbMocks.heartbeatPageSyncLease.mockRejectedValueOnce(new Error("db unavailable"));
    let entered!: () => void;
    const waitingStarted = new Promise<void>((resolve) => { entered = resolve; });
    const physicalRequest = vi.fn(async () => "synthetic retryable response");
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      await executeObservedRequest({
        requestId: "lease-cancel",
        operation: "subscribers",
        endpointTemplate: "/synthetic",
        method: "GET",
        async waitForRateLimit() {
          if (waiting === "rate") {
            entered();
            await waitForHttpRequestDelay(60_000);
          }
          return 0;
        },
        observer: {
          async onRequestEvent(event) { if (event.state === "retry") entered(); },
        },
        execute: physicalRequest,
        onResponse: () => ({ kind: "retry", httpStatus: 503, retryDelayMs: 60_000 }),
        onTransportError: (error) => ({ kind: "failed", error }),
      });
      return { satisfied: true, stats: {} };
    });
    const running = executeNextSyncPageChunk(app, 55);
    await waitingStarted;
    await vi.advanceTimersByTimeAsync(30_001);

    await expect(running).resolves.toMatchObject({ kind: "idle", needsContinuation: false });
    expect(physicalRequest).toHaveBeenCalledTimes(waiting === "rate" ? 0 : 1);
    expect(telemetryMocks.instances[0]?.recordSkipped).toHaveBeenCalledWith("Page sync lease lost");
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    expect(sharedMocks.persistFailedSyncPayload).not.toHaveBeenCalled();
  });

  it("preserves returned response capture after heartbeat loss while fencing business completion", async () => {
    vi.useFakeTimers();
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.heartbeatPageSyncLease.mockResolvedValueOnce(false);
    let entered!: () => void;
    const requestStarted = new Promise<void>((resolve) => { entered = resolve; });
    let receive!: (body: string) => void;
    const inFlight = new Promise<string>((resolve) => { receive = resolve; });
    const capture = vi.fn();
    handlerMocks.executeStreamChunk.mockImplementation(async () => {
      const response = await executeObservedRequest({
        requestId: "lease-cancel-inflight",
        operation: "subscribers",
        endpointTemplate: "/synthetic",
        method: "GET",
        execute: () => { entered(); return inFlight; },
        onResponse: (value) => ({ kind: "success", value, httpStatus: 200 }),
        onTransportError: (error) => ({ kind: "failed", error }),
      });
      // The handler's capture-first step still receives the complete body.
      capture(response);
      return { satisfied: true, stats: { processedThisChunk: 1 } };
    });
    const running = executeNextSyncPageChunk(app, 55);
    await requestStarted;
    await vi.advanceTimersByTimeAsync(30_001);
    receive("verbatim response received after lease loss");

    await expect(running).resolves.toMatchObject({ kind: "idle", needsContinuation: false });
    expect(capture).toHaveBeenCalledWith("verbatim response received after lease loss");
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    expect(dbMocks.yieldPageSync).not.toHaveBeenCalled();
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
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

    const queueClient = {
      query: vi.fn(async (statement: string, _values?: unknown[]) => (
        statement.includes("select clock_timestamp()")
          ? { rows: [{ safe: true }] }
          : { rows: [] }
      )),
      release: vi.fn(),
    };
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
      // DM polling on: the executor's own pause of a disabled OnlyFans DM
      // stream (real db calls) stays out of this queue-mechanics case.
      config: { syncPageExecutorConcurrency: 2, onlyFansDmPollingEnabled: true },
      pool: { connect: vi.fn(async () => queueClient) },
    } as never;
    const boss = {
      complete: vi.fn(async () => completionResult()),
      fail: vi.fn(async () => {}),
      fetch: vi.fn(async (_queueName: string, options: Record<string, unknown>) => {
        const callNumber = boss.fetch.mock.calls.length;
        if (callNumber === 1) {
          expect(options).toMatchObject({
            batchSize: 1,
            includeMetadata: true,
            priority: false,
            orderByCreatedOn: true,
            groupConcurrency: 1,
            ignoreGroups: null,
          });
          return [{
            id: "job-1",
            data: { platformAccountId: 55 },
            groupId: "onlyfans:direct",
            startedOn: new Date(),
            expireInSeconds: 900,
            retryLimit: 0,
            singletonKey: "55",
          }];
        }

        expect(options).toMatchObject({
          batchSize: 1,
          includeMetadata: true,
          priority: false,
          orderByCreatedOn: true,
          groupConcurrency: 1,
          ignoreGroups: ["onlyfans:direct"],
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
    expect(boss.complete).toHaveBeenCalledWith(
      "sync.page.execute",
      "job-1",
      null,
      { db: expect.objectContaining({ executeSql: expect.any(Function) }) },
    );
    expect(boss.fail).not.toHaveBeenCalled();
  });

  it("terminates a gated chunk without claiming a successful sync", async () => {
    // A gated skip once called completePageSync, so page_sync_states got a
    // fresh succeeded_at and consecutive_failures = 0 for a stream that issued
    // zero requests: a stream standing still looked healthy.
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      gatedSkip: "onlyfans_top_spenders_disabled",
      stats: { skipped: "onlyfans_top_spenders_disabled" },
    });

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.skipPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "subscribers",
      leaseToken: "lease-1",
    }));
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    // skipPageSync deliberately takes no progressedAt: a chunk with no egress
    // made no progress.
    expect(dbMocks.skipPageSync.mock.calls[0]?.[1]).not.toHaveProperty("progressedAt");
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "skipped",
      "onlyfans_top_spenders_disabled",
      // `gatedSkip` in the run stats is the structured marker the UX keys
      // "gated off" on. The `skipped` OUTCOME cannot serve as that marker:
      // recordSkipped writes it for every lost lease, on healthy streams too.
      expect.objectContaining({
        skipped: "onlyfans_top_spenders_disabled",
        gatedSkip: "onlyfans_top_spenders_disabled",
      }),
    );
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).not.toHaveBeenCalled();
  });

  it("still records an ordinary satisfied chunk as a successful sync", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      stats: { processedThisChunk: 3 },
    });

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.completePageSync).toHaveBeenCalledTimes(1);
    expect(dbMocks.skipPageSync).not.toHaveBeenCalled();
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "success",
      null,
      expect.objectContaining({ processedThisChunk: 3 }),
    );
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledTimes(1);
  });

  describe("OFAPI status matrix (decision #245)", () => {
    const ofapiError = (status: number | null) =>
      new OfapiApiError(
        `OFAPI request failed: GET /acct_x/tracking-links returned ${status ?? "nothing"}`,
        status,
        null,
      );
    const app = () => ({
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    }) as never;

    const creditsLease = {
      ...taskLease,
      stream: "fan_identities" as const,
      retryKind: "ofapi_insufficient_credits",
    };
    /** A handler outcome that first records one OFAPI request on the chunk
     *  budget, the way the real client's request observer does. */
    const outcomeAfterOneRequest = (outcome: Record<string, unknown>) =>
      async (_app: unknown, input: { budget: { onRequestEvent(event: unknown): Promise<void> } }) => {
        await input.budget.onRequestEvent({ state: "started" });
        return outcome;
      };

    it("retries a 402 under ofapi_insufficient_credits and opens the monitor's own low-credit latch, once", async () => {
      const ctx = app();
      // Third consecutive failure: the per-stream threshold alert would open here.
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
        ...taskLease,
        stream: "fan_identities" as const,
        consecutiveFailures: 2,
      });
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockRejectedValue(ofapiError(402));

      const result = await executeNextSyncPageChunk(ctx, 55);

      expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
        pageId: 55,
        stream: "fan_identities",
        retryKind: "ofapi_insufficient_credits",
      }));
      expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
      expect(notificationMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
      expect(notificationMocks.notifyOfapiGlobalIncident).toHaveBeenCalledWith(ctx, expect.objectContaining({
        kind: "ofapi_low_credit",
        errorSummary: expect.stringContaining("402"),
      }));
      // One pool, one alarm: no "stream failed 3x" on top of the credits incident.
      expect(notificationMocks.notifySyncChunkFailureIncident).not.toHaveBeenCalled();
      // The executor's latch IS the credit-ledger monitor's latch (no subKey),
      // so the two paths dedupe against each other and either can close it.
      const incident = notificationMocks.notifyOfapiGlobalIncident.mock.calls[0]?.[1] as {
        kind: "ofapi_low_credit";
        subKey?: string | null;
      };
      expect(incident.subKey ?? null).toBeNull();
      const { incidentKey } = await vi.importActual<typeof NotificationIncidentsModule>(
        "../apps/runtime/src/services/notification-incidents.ts",
      );
      expect(incidentKey({ kind: incident.kind, platformAccountId: null, subKey: incident.subKey ?? null }))
        .toBe(incidentKey({ kind: "ofapi_low_credit", platformAccountId: null }));
      expect(result).toMatchObject({ kind: "failed", stream: "fan_identities", needsContinuation: false });
    });

    it("resolves the credits incident on the first successful chunk that got an OFAPI response", async () => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(creditsLease);
      handlerMocks.executeStreamChunk.mockImplementation(
        outcomeAfterOneRequest({ satisfied: true, yieldReason: null, stats: {} }) as never,
      );

      const result = await executeNextSyncPageChunk(ctx, 55);

      expect(result).toMatchObject({ kind: "success", stream: "fan_identities" });
      expect(notificationMocks.resolveOfapiGlobalIncident).toHaveBeenCalledTimes(1);
      expect(notificationMocks.resolveOfapiGlobalIncident).toHaveBeenCalledWith(ctx, expect.objectContaining({
        kind: "ofapi_low_credit",
      }));
      expect((notificationMocks.resolveOfapiGlobalIncident.mock.calls[0]?.[1] as { subKey?: string | null }).subKey ?? null)
        .toBeNull();
    });

    it("resolves the credits incident from a partial chunk too, once a request went through", async () => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(creditsLease);
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockImplementation(
        outcomeAfterOneRequest({ satisfied: false, yieldReason: "request_budget", stats: {} }) as never,
      );

      const result = await executeNextSyncPageChunk(ctx, 55);

      expect(result).toMatchObject({ kind: "yielded", stream: "fan_identities" });
      expect(notificationMocks.resolveOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    });

    it("does not resolve the credits incident from a partial that made no request (credit floor, daily budget)", async () => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(creditsLease);
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockResolvedValue({
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: new Date("2026-03-14T13:00:00.000Z"),
        stats: { deferred: "credit_floor" },
      });

      const result = await executeNextSyncPageChunk(ctx, 55);

      expect(result).toMatchObject({ kind: "yielded", stream: "fan_identities" });
      expect(notificationMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    });

    it("does not resolve the credits incident from a success that made no request", async () => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(creditsLease);
      handlerMocks.executeStreamChunk.mockResolvedValue({ satisfied: true, yieldReason: null, stats: {} });

      await executeNextSyncPageChunk(ctx, 55);

      expect(notificationMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    });

    it("leaves the credits incident alone when the lease was not a credits retry", async () => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, retryKind: "transient_network" });
      handlerMocks.executeStreamChunk.mockImplementation(
        outcomeAfterOneRequest({ satisfied: true, yieldReason: null, stats: {} }) as never,
      );

      await executeNextSyncPageChunk(ctx, 55);

      expect(notificationMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    });

    it.each([401, 403])("parks a %s for an operator without pausing the page for re-login", async (status) => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "fan_identities" as const });
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockRejectedValue(ofapiError(status));

      const result = await executeNextSyncPageChunk(ctx, 55);

      expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
        pageId: 55,
        stream: "fan_identities",
        blockerKind: "manual_action_required",
        blockerCode: `ofapi_http_${status}`,
      }));
      expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
      expect(notificationMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "failed", needsContinuation: false });
    });

    it.each([
      [429, "rate_limit"],
      [500, "provider_5xx"],
      [503, "provider_5xx"],
      [null, "transient_network"],
    ])("retries a %s response under %s", async (status, retryKind) => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "fan_identities" as const });
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockRejectedValue(ofapiError(status));

      await executeNextSyncPageChunk(ctx, 55);

      expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({ retryKind }));
      expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
      expect(notificationMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
      // Every other class keeps the ordinary per-stream failure alert path.
      expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledTimes(1);
    });

    it.each([400, 404, 422])("parks any other 4xx (%s) as provider_bad_data instead of hot-retrying it", async (status) => {
      const ctx = app();
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "fan_identities" as const });
      dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
      handlerMocks.executeStreamChunk.mockRejectedValue(ofapiError(status));

      await executeNextSyncPageChunk(ctx, 55);

      expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
        blockerKind: "provider_bad_data",
        blockerCode: `ofapi_http_${status}`,
      }));
      expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    });
  });
});
