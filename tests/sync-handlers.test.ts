import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  countActivePageFollows: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  deactivatePageSubscriptionsByGeneration: vi.fn(),
  getCheckpoint: vi.fn(),
  getCurrentSubscribers: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  rebuildSubscriberRollups: vi.fn(),
  requestSyncStreamRevisions: vi.fn(),
  updateLegacySyncTimestamp: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertFanPage: vi.fn(),
  upsertFans: vi.fn(),
  upsertPageFollow: vi.fn(),
  upsertPageSubscription: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
  refreshFanPageSubscriberState: vi.fn(),
}));

const onlyFansTransactionMocks = vi.hoisted(() => ({
  syncOnlyFansTransactions: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  persistRawPayload: vi.fn(),
  refreshPageMetadata: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
  trimFanslyFollowerPayload: vi.fn((value: unknown) => value),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  hydrateFans: vi.fn(),
}));

const transactionMocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync/onlyfans-transactions.ts", () => onlyFansTransactionMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", () => fanHydrationMocks);
vi.mock("../apps/runtime/src/services/sync/transactions.ts", () => transactionMocks);

import {
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executeSubscribersChunk,
  executeTransactionsChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";

function createTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

describe("sync executor handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      mock.mockReset();
    }
    onlyFansTransactionMocks.syncOnlyFansTransactions.mockReset();
    sharedMocks.persistRawPayload.mockReset();
    sharedMocks.refreshPageMetadata.mockReset();
    fanHydrationMocks.hydrateFans.mockReset();
    transactionMocks.syncTransactions.mockReset();

    dbMocks.upsertCheckpointProgress.mockResolvedValue({});
    dbMocks.upsertCheckpoint.mockResolvedValue({});
    dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
    dbMocks.rebuildSubscriberRollups.mockResolvedValue(undefined);
    dbMocks.updateLegacySyncTimestamp.mockResolvedValue(undefined);
    dbMocks.upsertFanPage.mockResolvedValue(undefined);
    dbMocks.upsertPageFollow.mockResolvedValue(undefined);
    dbMocks.upsertPageSubscription.mockResolvedValue(undefined);
    dbMocks.refreshFanPageFollowerState.mockResolvedValue(undefined);
    dbMocks.refreshFanPageSubscriberState.mockResolvedValue(undefined);
    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
  });

  it("guards against destructive subscriber finalization on an empty first page", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 0,
          items: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.getCurrentSubscribers.mockResolvedValue({
      rows: [{ id: 1 }],
    });
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map());

    await expect(executeSubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 5,
      },
      syncRunId: 100,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
  });

  it("promotes followers_reconcile when follower drift is detected", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [{ id: "1000", followerId: "fan-1" }],
          accounts: [{
            id: "fan-1",
            username: "fan_1",
            displayName: "Fan 1",
            createdAt: 1_770_000_000_000,
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      cursorText: "known-follow",
      state: {
        revision: 3,
        knownFollowId: "known-follow",
        newestFollowId: null,
        offset: 0,
        pageCount: 0,
        sourceFollowerCount: 1,
      },
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
    dbMocks.countActivePageFollows.mockResolvedValue(0);

    const result = await executeFollowersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 12,
          label: "fansly-page",
          platformAccountId: "acct-12",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 3,
      },
      syncRunId: 101,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.requestSyncStreamRevisions).toHaveBeenCalledWith({}, {
      platformAccountId: 12,
      streams: ["followers_reconcile"],
      reason: "anomaly",
    });
  });

  it("runs follower reconcile finalization against generation-based state", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getFollowersPage: vi.fn(async () => ({
          items: [],
          accounts: [],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 0,
        },
      },
    });
    dbMocks.upsertFans.mockResolvedValue([]);

    const result = await executeFollowersReconcileChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 13,
          label: "fansly-page",
          platformAccountId: "acct-13",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledTimes(1);
    expect(dbMocks.refreshFanPageFollowerState).toHaveBeenCalledWith({}, 13);
  });

  it("consumes OnlyFans manual transaction override payloads revision-safely", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      onlyFansAdapter: {},
    } as never;
    onlyFansTransactionMocks.syncOnlyFansTransactions.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      processedTransactions: 10,
      processedChargebacks: 2,
      processed: 12,
      newestSeenAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    const result = await executeTransactionsChunk(app, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 99,
          label: "onlyfans-page",
          platformAccountId: "of-99",
          metadata: {},
          commissionRate: 0.2,
        },
        auth: { token: "secret" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 7,
        requestPayload: {
          revision: 7,
          onlyFansTransactionsStart: "2026-03-01T00:00:00.000Z",
        },
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(onlyFansTransactionMocks.syncOnlyFansTransactions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      rescanStart: new Date("2026-03-01T00:00:00.000Z"),
    }));
    expect(result.clearRequestPayload).toBe(true);
  });

  it("propagates yielded OnlyFans transaction chunks", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      onlyFansAdapter: {},
    } as never;
    onlyFansTransactionMocks.syncOnlyFansTransactions.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      processedTransactions: 4,
      processedChargebacks: 0,
      processed: 4,
      newestSeenAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    const result = await executeTransactionsChunk(app, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 100,
          label: "onlyfans-page",
          platformAccountId: "of-100",
          metadata: {},
          commissionRate: 0.2,
        },
        auth: { token: "secret" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 7,
        requestPayload: null,
      },
      syncRunId: 201,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(false);
    expect(result.yieldReason).toBe("request_budget");
    expect(result.clearRequestPayload).toBe(false);
  });
});
