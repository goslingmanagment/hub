import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as NotificationIncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";
import type * as SyncSharedModule from "../apps/runtime/src/services/sync/shared.ts";

import { OfapiCollectionPolicyError, PageSyncLeaseLostError } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { executeObservedRequest, waitForHttpRequestDelay } from "@agency_hub_core/shared";

import { ProxyMissingError } from "../apps/runtime/src/services/errors.ts";
import { OfapiApiError } from "../apps/runtime/src/services/ofapi.ts";
import {
  PostsCaptureConfigurationError,
  PostsCaptureJobBlockedError,
} from "../apps/runtime/src/services/sync/posts.ts";

const dbMocks = vi.hoisted(() => ({
  acquirePageSyncLease: vi.fn(),
  armPageSyncProviderHold: vi.fn(),
  blockPageSync: vi.fn(),
  pausePageSyncForAuth: vi.fn(),
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
  notifyAuthFailedIncident: vi.fn(),
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
import {
  FanslyTransactionsItemContractError,
  FollowersReconcileConsistencyError,
} from "../apps/runtime/src/services/sync/errors.ts";

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
    dispatchSource: "manual",
    platform: "fansly",
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
      groupId: "fansly:direct",
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
    dbMocks.armPageSyncProviderHold.mockImplementation(async (_db: unknown, input: { holdUntil: Date }) =>
      input.holdUntil);
    dbMocks.blockPageSync.mockResolvedValue({ updated: true, blocked: true });
    dbMocks.completePageSync.mockResolvedValue(true);
    dbMocks.skipPageSync.mockResolvedValue(true);
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
    dbMocks.clearPageSyncLease.mockResolvedValue(true);
    dbMocks.listRunnablePageSync.mockResolvedValue([]);
    dbMocks.listRunnableOfapiCapturePages.mockResolvedValue([]);
    dbMocks.yieldPageSync.mockResolvedValue({ updated: true, superseded: false });
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

  it.each(["followers_reconcile", "fan_earnings"] as const)(
    "settles a reused %s result with its original freshness and no provider recovery", async (stream) => {
      const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
      const succeededAt = new Date("2026-03-14T12:00:00.000Z");
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream });
      // The reuse makes no request, and the original completion time may come
      // from a walk that made none either (a fan_earnings walk over fresh fans).
      handlerMocks.executeStreamChunk.mockResolvedValue({
        satisfied: true, yieldReason: null, succeededAt, stats: { reusedCompletedWalk: true },
      });
      expect(await executeNextSyncPageChunk(app, 55)).toMatchObject({ kind: "success" });
      expect(dbMocks.completePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ succeededAt }));
      expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledWith(app,
        expect.objectContaining({ providerRecoveredAt: null, recoveredAt: expect.any(Date), stream }));
    });

  it.each([
    ["a partial with no successful response", false, null],
    ["a partial with a successful response", false, "last_success"],
    ["a completion stamped this chunk with no successful response", true, null],
    ["a completion with a successful response", true, "last_success"],
  ] as const)("recovers page-wide incidents only from provider evidence: %s", async (_name, satisfied, expected) => {
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    const lastSuccessAt = new Date(Date.now() - 1_000);
    telemetryMocks.lastSuccessfulAttemptAt = expected === "last_success" ? lastSuccessAt : null;
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, stream: "fan_earnings" });
    // A fan_earnings walk finishing on an exhausted cursor stamps succeededAt
    // now; that is a completion time, not a provider answer.
    handlerMocks.executeStreamChunk.mockImplementation(async () => (satisfied
      ? { satisfied: true, yieldReason: null, succeededAt: new Date(), stats: { walkCompleted: true } }
      : { satisfied: false, yieldReason: "request_budget", stats: { fansFetched: 0 } }));
    await executeNextSyncPageChunk(app, 55);
    expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledWith(app, expect.objectContaining({
      providerRecoveredAt: expected === "last_success" ? lastSuccessAt : null,
      recoveredAt: expect.any(Date),
      stream: "fan_earnings",
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
      stream: "fan_earnings" as const,
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
      gatedSkip: "not_allowlisted",
      stats: { skipped: "not_allowlisted" },
    });

    const result = await executeNextSyncPageChunk(app, 55);

    expect(result).toMatchObject({ kind: "skipped", stream: "fan_earnings" });
    expect(dbMocks.skipPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "fan_earnings",
      progress: { skipped: "not_allowlisted" },
    }));
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "skipped",
      "not_allowlisted",
      expect.objectContaining({
        skipped: "not_allowlisted",
        gatedSkip: "not_allowlisted",
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
      stream: "purchase_history" as const,
      progress: {
        skipped: "not_allowlisted",
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

    expect(result).toMatchObject({ kind: "success", stream: "purchase_history" });
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
      // DB says the attempt is live; a process-clock check would reject this
      // deliberately ancient metadata value.
      job: buildQueueJob({
        startedOn: new Date("2000-01-01T00:00:00.000Z"),
        expireInSeconds: 900,
      }),
    });

    expect(dbMocks.ensurePageSyncStates).toHaveBeenCalledWith({}, { pageId: 55 });
    expect(dbMocks.yieldPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
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
          id: "fansly:shared-proxy-pool",
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
      platform: "fansly",
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
        group: { id: "fansly:shared-proxy-pool" },
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
      stream: "dm_messages" as const,
      requestSource: "manual" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
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
      stream: "dm_messages",
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
      stream: "dm_messages" as const,
      requestSource: "manual" as const,
      dispatchSource: "manual" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
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
      dispatchSource: "scheduled",
    }));
  });

  it.each([
    ["a deferral-only chunk keeps", "fansly_dm_threads_deferred"],
    ["an ordinary partial chunk resets", null],
  ] as const)("%s the failure streak, freshness and incidents", async (_name, deferral) => {
    const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
    const retryAt = new Date(Date.now() + 10 * 60_000);
    const progressedAt = new Date("2026-03-13T12:00:00.000Z");
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease, stream: "dm_messages" as const, consecutiveFailures: 22, progressedAt,
    });
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: false, yieldReason: null, continuationRetryAt: retryAt,
      ...(deferral ? { deferral } : {}), stats: { deferredThreads: 1 },
    });

    expect(await executeNextSyncPageChunk(app, 55)).toMatchObject({
      kind: "yielded", stream: "dm_messages", continuationRetryAt: retryAt,
    });

    const settled = dbMocks.yieldPageSync.mock.calls[0]?.[1];
    expect(settled).toMatchObject({ retryAt });
    if (deferral) {
      // Only the wake-up moves: no progress stamp, streak or incident change.
      expect(settled).toMatchObject({ keepFailureStreak: true, progressedAt });
      expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith("partial", null,
        expect.objectContaining({ deferral, deferredThreads: 1 }));
      expect(notificationMocks.resolveSyncChunkRecoveryIncidents).not.toHaveBeenCalled();
    } else {
      expect(settled).not.toHaveProperty("keepFailureStreak");
      expect(settled?.progressedAt).not.toEqual(progressedAt);
      expect(notificationMocks.resolveSyncChunkRecoveryIncidents).toHaveBeenCalledOnce();
    }
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
  });

  it("keeps a newer manual generation immediately runnable when an old chunk yields", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date("2026-03-14T13:00:00.000Z");

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "dm_messages" as const,
    });
    dbMocks.yieldPageSync.mockResolvedValueOnce({ updated: true, superseded: true });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
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
      stream: "dm_messages" as const,
    });
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([{
      pageId: 55,
      platform: "fansly",
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
      job: buildQueueJob(),
    });

    expect(result).toMatchObject({
      kind: "yielded",
      needsContinuation: true,
      continuationPriority: 25,
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
      platform: "fansly",
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
      platform: "fansly",
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
      stream: "followers",
      leaseToken: "lease-1",
      nextStatus: "paused",
    });
    // No run row, no telemetry, no chunk execution for a dead page.
    expect(dbMocks.startSyncRun).not.toHaveBeenCalled();
    expect(telemetryMocks.instances).toHaveLength(0);
    expect(handlerMocks.executeStreamChunk).not.toHaveBeenCalled();
  });

  it("marks auth failures durably and does not request continuation", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401, undefined, '{"success":false,"error":{"code":401}}'),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledTimes(1);
    // Decision #248: the provider's response body rides into the `:failed`
    // observation payload, which persistFailedSyncPayload writes verbatim from
    // `failure.error`.
    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledWith(app, expect.objectContaining({
      failure: expect.objectContaining({
        summary: "expired session",
        error: expect.objectContaining({
          responseSnippet: '{"success":false,"error":{"code":401}}',
        }),
      }),
    }));
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      requestSeq: 3,
      leaseToken: "lease-1",
      blockerKind: "auth",
      blockerCode: "credentials_invalid",
      blockerMessage: "expired session",
    }));
    // Stage 26: a dead session parks the WHOLE page, not just the failing stream.
    expect(dbMocks.pausePageSyncForAuth).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      blockerCode: "credentials_invalid",
      streams: expect.arrayContaining(["light", "dm_messages", "followers"]),
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
      stream: "followers",
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
      stream: "followers",
      blockerKind: "manual_action_required",
      blockerCode: "ofapi_collection_collection_off",
      errorCode: "ofapi_collection_collection_off",
    }));
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).not.toHaveBeenCalled();
  });

  it("parks the stream with blocker proxy_missing when the context refuses proxyless Fansly egress (W3.1)", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    dbMocks.listRunnablePageSync.mockResolvedValueOnce([]);
    handlerMocks.resolveExecutorPageContext.mockRejectedValue(
      new ProxyMissingError('Page "55" has no assigned proxy; Fansly egress is refused (fail-closed)'),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    // W3.1 (decision #124): a refused proxyless resolution is a config state
    // — the stream parks (manual action) instead of hot-retrying the refusal.
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      blockerKind: "manual_action_required",
      blockerCode: "proxy_missing",
    }));
    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "failed",
      runId: 777,
      needsContinuation: false,
    });
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

  it.each([
    { previousConsecutiveFailures: 0, previousRetryKind: null },
    { previousConsecutiveFailures: 1, previousRetryKind: "provider_404" },
  ])("retries Fansly 404 failures before the terminal attempt ($previousConsecutiveFailures prior)", async ({
    previousConsecutiveFailures,
    previousRetryKind,
  }) => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      consecutiveFailures: previousConsecutiveFailures,
      retryKind: previousRetryKind,
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(new FanslyApiError("not found", 404));

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      retryKind: "provider_404",
    }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      previousConsecutiveFailures,
      forceOpen: false,
    }));
  });

  it("blocks a Fansly 404 after two retries and opens the incident immediately", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      consecutiveFailures: 2,
      retryKind: "provider_404",
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(new FanslyApiError("not found", 404));

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      blockerKind: "provider_bad_data",
      blockerCode: "provider_404_exhausted",
    }));
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      previousConsecutiveFailures: 2,
      forceOpen: true,
    }));
  });

  const transactionItemRejection = () => new FanslyTransactionsItemContractError({ field: "amount" });

  it.each([
    { consecutiveFailures: 0, lastErrorCode: null, retryKind: null },
    // The planner cleared retry_kind when it made the retry due.
    { consecutiveFailures: 1, lastErrorCode: "transaction_item_contract_rejected", retryKind: null },
    // Two failures, but the one before this chunk was not a rejection.
    { consecutiveFailures: 2, lastErrorCode: "http_500", retryKind: "provider_5xx" },
  ])("retries a rejected transaction page item ($consecutiveFailures prior, last $lastErrorCode)", async ({
    consecutiveFailures,
    lastErrorCode,
    retryKind,
  }) => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "transactions",
      consecutiveFailures,
      lastErrorCode,
      retryKind,
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(transactionItemRejection());

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "transactions",
      retryKind: "transaction_item_contract_rejected",
      errorCode: "transaction_item_contract_rejected",
    }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      forceOpen: false,
    }));
  });

  it("parks the transactions lane as provider_bad_data on the third rejection in a row", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      stream: "transactions",
      consecutiveFailures: 2,
      lastErrorCode: "transaction_item_contract_rejected",
      // The streak is read from last_error_code: the planner nulls retry_kind
      // when it materializes a due retry, so retry_kind is not a counter.
      retryKind: null,
      progress: { phase: "transactions", offset: 100 },
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(transactionItemRejection());

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "transactions",
      blockerKind: "provider_bad_data",
      blockerCode: "transaction_item_contract_rejected",
      errorCode: "transaction_item_contract_rejected",
      progress: { phase: "transactions", offset: 100 },
    }));
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      stream: "transactions",
      previousConsecutiveFailures: 2,
      forceOpen: true,
    }));
  });

  it("sleeps a rate-limited page until the provider's own Retry-After deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-14T12:00:00.000Z"));
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    // Fansly answered `Retry-After: 600`; the adapter stopped retrying in
    // process and handed the deadline over.
    const retryAfterAt = new Date("2026-03-14T12:10:00.000Z");

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("rate limited", 429, undefined, undefined, retryAfterAt),
    );

    await executeNextSyncPageChunk(app, 55);

    // Without this the row woke on the 60s rung of the ladder and walked
    // straight back into the same limit, three times over.
    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      retryKind: "rate_limit",
      retryAt: retryAfterAt,
    }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
  });

  it.each([
    { status: 429, retryKind: "rate_limit", delayMs: 30 * 60_000, forceOpen: false },
    { status: 429, retryKind: "rate_limit", delayMs: 30 * 60_000 + 1, forceOpen: true },
    { status: 429, retryKind: "rate_limit", delayMs: 86_400_000, forceOpen: true },
    { status: 503, retryKind: "provider_5xx", delayMs: 30 * 60_000, forceOpen: false },
    { status: 503, retryKind: "provider_5xx", delayMs: 30 * 60_000 + 1, forceOpen: true },
    { status: 503, retryKind: "provider_5xx", delayMs: 86_400_000, forceOpen: true },
  ])("reports a long provider cooldown without shortening it ($status, $delayMs ms)", async ({
    status, retryKind, delayMs, forceOpen,
  }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-03-14T12:00:00.000Z");
    vi.setSystemTime(now);
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;
    const retryAt = new Date(now.getTime() + delayMs);
    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("provider unavailable", status, undefined, undefined, retryAt),
    );

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({ retryKind, retryAt }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      previousConsecutiveFailures: 0,
      forceOpen,
      ...(forceOpen ? { errorSummary: expect.stringContaining(retryAt.toISOString()) } : {}),
    }));
  });

  it("keeps the durable ladder when it outlasts the provider's deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-14T12:00:00.000Z"));
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce({
      ...taskLease,
      // Sixth consecutive failure: the ladder is already at its 30 min cap.
      consecutiveFailures: 5,
      retryKind: "provider_5xx",
    });
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("unavailable", 503, undefined, undefined, new Date("2026-03-14T12:00:30.000Z")),
    );

    await executeNextSyncPageChunk(app, 55);

    // A short Retry-After may not pull a repeatedly failing stream forward
    // into a hot loop: the wake-up is the LATER of the two.
    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      retryKind: "provider_5xx",
      retryAt: new Date("2026-03-14T12:30:00.000Z"),
    }));
  });

  it("leaves the ladder to itself when the provider named no deadline", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(new FanslyApiError("rate limited", 429));

    await executeNextSyncPageChunk(app, 55);

    const call = dbMocks.retryPageSync.mock.calls[0]?.[1] as { retryKind: string };
    expect(call.retryKind).toBe("rate_limit");
    // No `retryAt` key at all — retryPageSync computes the rung itself.
    expect(call).not.toHaveProperty("retryAt");
  });

  describe("page provider hold (R04)", () => {
    const now = new Date("2026-03-14T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
    });

    it.each([
      ["the provider's Retry-After", at(600_000), at(600_000), at(600_000)],
      // Never capped: the failing stream waits the whole deadline, and so do
      // its siblings.
      ["a Retry-After a day away, uncapped", at(86_400_000), at(86_400_000), at(86_400_000)],
      ["a fixed 120 s without a Retry-After", null, at(120_000), undefined],
      ["a fixed 120 s when the Retry-After has already passed", at(-1_000), at(120_000), at(60_000)],
      // A thrown 429 with a short Retry-After means the adapter's in-process
      // retries already met repeated 429s: the page never holds for less.
      ["a 120 s floor when the Retry-After is seconds away", at(10_000), at(120_000), at(60_000)],
      ["a Retry-After just past the 120 s floor", at(121_000), at(121_000), at(121_000)],
    ] as const)("holds the page on a first Fansly 429 until %s", async (_name, retryAfterAt, holdUntil, retryAt) => {
      const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
      handlerMocks.executeStreamChunk.mockRejectedValue(
        new FanslyApiError("rate limited", 429, undefined, undefined, retryAfterAt),
      );

      const result = await executeNextSyncPageChunk(app, 55);

      expect(result).toMatchObject({ kind: "failed", stream: "followers" });
      expect(dbMocks.armPageSyncProviderHold).toHaveBeenCalledWith({}, {
        pageId: 55, stream: "followers", syncRunId: 777, reason: "rate_limit",
        holdUntil, retryAfterAt, now,
      });
      // The failing stream keeps its own retry exactly as before.
      const retry = dbMocks.retryPageSync.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(retry).toMatchObject({ retryKind: "rate_limit" });
      expect(retry.retryAt).toEqual(retryAt);
      expect(telemetryMocks.instances[0]?.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "page_provider_hold",
        severity: "warn",
        details: expect.objectContaining({ holdUntil: holdUntil.toISOString() }),
      }));
    });

    // A provider deadline speaks for the page on every 429, whatever the
    // streak: exactly that instant, without the first 429's 120 s floor.
    it.each([
      ["after a 5xx", { consecutiveFailures: 1, retryKind: "provider_5xx" }, at(600_000), at(600_000)],
      ["after an earlier 429 whose hold has passed", { consecutiveFailures: 2, retryKind: "rate_limit" },
        at(900_000), at(900_000)],
      ["a Retry-After seconds away", { consecutiveFailures: 1, retryKind: "rate_limit" }, at(10_000), at(120_000)],
    ] as const)("holds the page on a later 429 of a streak until its Retry-After: %s", async (
      _name, lease, retryAfterAt, retryAt,
    ) => {
      const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, ...lease });
      handlerMocks.executeStreamChunk.mockRejectedValue(
        new FanslyApiError("rate limited", 429, undefined, undefined, retryAfterAt),
      );

      await executeNextSyncPageChunk(app, 55);

      expect(dbMocks.armPageSyncProviderHold).toHaveBeenCalledWith({}, {
        pageId: 55, stream: "followers", syncRunId: 777, reason: "rate_limit",
        holdUntil: retryAfterAt, retryAfterAt, now,
      });
      const retry = dbMocks.retryPageSync.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(retry).toMatchObject({ retryKind: "rate_limit" });
      expect(retry.retryAt).toEqual(retryAt);
    });

    it.each([
      ["a later 429 of the same failure streak without a Retry-After",
        { consecutiveFailures: 1, retryKind: "rate_limit" }, new FanslyApiError("rate limited", 429)],
      ["a later 429 of the same failure streak whose Retry-After has passed",
        { consecutiveFailures: 1, retryKind: "rate_limit" },
        new FanslyApiError("rate limited", 429, undefined, undefined, at(-1_000))],
      ["a 5xx with a Retry-After", {},
        new FanslyApiError("unavailable", 503, undefined, undefined, at(600_000))],
      ["an OFAPI 429", {}, new OfapiApiError("rate limited", 429, null)],
    ] as const)("does not hold the page for %s", async (_name, lease, error) => {
      const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce({ ...taskLease, ...lease });
      handlerMocks.executeStreamChunk.mockRejectedValue(error);

      await executeNextSyncPageChunk(app, 55);

      expect(dbMocks.retryPageSync).toHaveBeenCalledTimes(1);
      expect(dbMocks.armPageSyncProviderHold).not.toHaveBeenCalled();
      expect(telemetryMocks.instances[0]?.addAnomaly).not.toHaveBeenCalled();
    });

    it("records no anomaly when a longer hold is already in force", async () => {
      const app = { db: {}, logger: { warn: vi.fn(), error: vi.fn() } } as never;
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
      dbMocks.armPageSyncProviderHold.mockResolvedValueOnce(null);
      handlerMocks.executeStreamChunk.mockRejectedValue(new FanslyApiError("rate limited", 429));

      await executeNextSyncPageChunk(app, 55);

      expect(dbMocks.armPageSyncProviderHold).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.instances[0]?.addAnomaly).not.toHaveBeenCalled();
    });

    it("still retries the failing stream when the hold cannot be written", async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const app = { db: {}, logger } as never;
      dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
      dbMocks.armPageSyncProviderHold.mockRejectedValueOnce(new Error("db down"));
      handlerMocks.executeStreamChunk.mockRejectedValue(new FanslyApiError("rate limited", 429));

      expect(await executeNextSyncPageChunk(app, 55)).toMatchObject({ kind: "failed" });

      expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({ retryKind: "rate_limit" }));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ platformAccountId: 55, stream: "followers" }),
        expect.stringContaining("provider hold"),
      );
    });
  });

  it("blocks an unsafe follower reconcile snapshot without retrying", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(new FollowersReconcileConsistencyError({
      code: "followers_reconcile_inconsistent_snapshot",
      message: "Follower reconcile generation is incomplete",
    }));

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).not.toHaveBeenCalled();
    expect(dbMocks.blockPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      blockerKind: "provider_bad_data",
      blockerCode: "followers_reconcile_inconsistent_snapshot",
    }));
    expect(notificationMocks.notifySyncChunkFailureIncident).toHaveBeenCalledWith(app, expect.objectContaining({
      forceOpen: true,
    }));
  });

  it("retries one follower snapshot that moved during a live paginated scan", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockRejectedValue(new FollowersReconcileConsistencyError({
      code: "followers_reconcile_snapshot_drift",
      message: "Follower count moved during the scan",
      retryable: true,
    }));

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.retryPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      retryKind: "followers_reconcile_snapshot_drift",
    }));
    expect(dbMocks.blockPageSync).not.toHaveBeenCalled();
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
        operation: "followers",
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
        operation: "followers",
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
      config: { syncPageExecutorConcurrency: 2 },
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
            groupId: "fansly:direct",
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
    expect(boss.complete).toHaveBeenCalledWith(
      "sync.page.execute",
      "job-1",
      null,
      { db: expect.objectContaining({ executeSql: expect.any(Function) }) },
    );
    expect(boss.fail).not.toHaveBeenCalled();
  });

  it("terminates a ramp-gated chunk without claiming a successful sync", async () => {
    // The gated skip used to call completePageSync, so page_sync_states got a
    // fresh succeeded_at and consecutive_failures = 0 for a stream that issued
    // zero requests. That is how lora-1 stood still for 13 days looking healthy.
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.acquirePageSyncLease.mockResolvedValueOnce(taskLease);
    handlerMocks.executeStreamChunk.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      gatedSkip: "not_allowlisted",
      stats: { skipped: "not_allowlisted" },
    });

    await executeNextSyncPageChunk(app, 55);

    expect(dbMocks.skipPageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      pageId: 55,
      stream: "followers",
      leaseToken: "lease-1",
    }));
    expect(dbMocks.completePageSync).not.toHaveBeenCalled();
    // skipPageSync deliberately takes no progressedAt: a chunk with no egress
    // made no progress.
    expect(dbMocks.skipPageSync.mock.calls[0]?.[1]).not.toHaveProperty("progressedAt");
    expect(telemetryMocks.instances[0]?.finish).toHaveBeenCalledWith(
      "skipped",
      "not_allowlisted",
      // `gatedSkip` in the run stats is the structured marker the UX keys
      // "gated off" on. The `skipped` OUTCOME cannot serve as that marker:
      // recordSkipped writes it for every lost lease, on healthy streams too.
      expect.objectContaining({
        skipped: "not_allowlisted",
        gatedSkip: "not_allowlisted",
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
      expect(dbMocks.pausePageSyncForAuth).not.toHaveBeenCalled();
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
      expect(dbMocks.pausePageSyncForAuth).not.toHaveBeenCalled();
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
