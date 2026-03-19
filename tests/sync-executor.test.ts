import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FanslyApiError } from "@agency_hub_core/fansly";

const dbMocks = vi.hoisted(() => ({
  ensureSyncStreamStateRows: vi.fn(),
  findPageById: vi.fn(),
  listRunnableSyncStreamStatesForPage: vi.fn(),
  markSyncPageAuthFailed: vi.fn(),
  recordSyncStreamChunkFailure: vi.fn(),
  recordSyncStreamChunkStarted: vi.fn(),
  recordSyncStreamChunkSucceeded: vi.fn(),
  recordSyncStreamChunkYielded: vi.fn(),
  startSyncRun: vi.fn(),
}));

const handlerMocks = vi.hoisted(() => ({
  executeStreamChunk: vi.fn(),
  resolveExecutorPageContext: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  persistFailedSyncPayload: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
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
    getRequestObserver() {
      return null;
    }

    async recordRunStarted() {}

    async finish() {}
  },
}));

import {
  executeNextSyncPageChunk,
  processSyncPageExecuteJob,
  startSyncPageExecutor,
} from "../apps/runtime/src/services/sync/executor.ts";

describe("sync executor", () => {
  const streamState = {
    platformAccountId: 55,
    stream: "followers",
    status: "active",
    cadenceSeconds: 43_200,
    slotOffsetSeconds: 10,
    nextDueAt: new Date("2026-03-14T12:00:00.000Z"),
    basePriority: 20,
    effectivePriority: 45,
    pendingReason: "manual",
    desiredRevision: 3,
    satisfiedRevision: 2,
    desiredAt: new Date("2026-03-14T12:00:00.000Z"),
    requestPayload: null,
    backoffUntil: new Date(0),
    lastEnqueuedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
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

    dbMocks.startSyncRun.mockResolvedValue({
      id: 777,
      startedAt: new Date("2026-03-14T12:00:00.000Z"),
    });
    dbMocks.findPageById.mockResolvedValue({
      page: {
        id: 55,
        platform: "fansly",
      },
      proxy: {
        url: "socks5://proxy.example",
      },
    });
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

  it("completes the current job before sending a continuation wakeup", async () => {
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

    dbMocks.listRunnableSyncStreamStatesForPage
      .mockResolvedValueOnce([streamState])
      .mockResolvedValueOnce([streamState]);
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

    expect(dbMocks.recordSyncStreamChunkStarted).toHaveBeenCalledWith({}, 55, "followers");
    expect(dbMocks.recordSyncStreamChunkYielded).toHaveBeenCalledWith({}, 55, "followers");
    expect(boss.complete).toHaveBeenCalledWith("sync.page.execute", "job-1");
    expect(boss.send).toHaveBeenCalledWith(
      "sync.page.execute",
      { platformAccountId: 55 },
      {
        singletonKey: "55",
        priority: 45,
        group: {
          id: "fansly:socks5://proxy.example:1080",
        },
      },
    );
    expect(boss.complete.mock.invocationCallOrder[0]).toBeLessThan(boss.send.mock.invocationCallOrder[0]);
  });

  it("marks auth failures durably and does not request continuation", async () => {
    const app = {
      db: {},
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never;

    dbMocks.listRunnableSyncStreamStatesForPage.mockResolvedValueOnce([streamState]);
    handlerMocks.executeStreamChunk.mockRejectedValue(
      new FanslyApiError("expired session", 401),
    );

    const result = await executeNextSyncPageChunk(app, 55);

    expect(sharedMocks.persistFailedSyncPayload).toHaveBeenCalledTimes(1);
    expect(dbMocks.markSyncPageAuthFailed).toHaveBeenCalledWith({}, {
      platformAccountId: 55,
      errorCode: null,
      errorSummary: "expired session",
    });
    expect(result).toMatchObject({
      kind: "auth_failed",
      platformAccountId: 55,
      needsContinuation: false,
    });
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

    dbMocks.listRunnableSyncStreamStatesForPage
      .mockResolvedValueOnce([streamState])
      .mockResolvedValueOnce([]);
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
