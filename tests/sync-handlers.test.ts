import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_DM_MESSAGE_HISTORY_LIMIT } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

const dbMocks = vi.hoisted(() => ({
  countRecentTerminalDmMessageConversationFailureStreak: vi.fn(),
  countActivePageFollows: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  deactivatePageSubscriptionsByGeneration: vi.fn(),
  finalizePageDmConversationMessageSync: vi.fn(),
  getCheckpoint: vi.fn(),
  getCurrentSubscribers: vi.fn(),
  getExistingPageDmMessageIds: vi.fn(),
  getPageDmConversationById: vi.fn(),
  listPageDmConversationsByPlatformConversationIds: vi.fn(),
  markPageDmConversationsInvisibleByGeneration: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  rebuildSubscriberRollups: vi.fn(),
  requestSyncStreamRevisions: vi.fn(),
  selectNextPageDmMessageSyncCandidate: vi.fn(),
  updateLegacySyncTimestamp: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertPageDmConversation: vi.fn(),
  upsertPageDmMessages: vi.fn(),
  upsertPageTopSpenders: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertPageFollows: vi.fn(),
  upsertPageSubscriptions: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
  refreshFanPageSubscriberState: vi.fn(),
}));

const onlyFansTransactionMocks = vi.hoisted(() => ({
  syncOnlyFansTransactions: vi.fn(),
}));

const sharedMocks = vi.hoisted(() => ({
  dmRetentionDate: vi.fn(() => new Date("2026-09-17T00:00:00.000Z")),
  normalizeFanslyTimestamp: vi.fn((value: number) => new Date(value >= 1_000_000_000_000 ? value : value * 1000)),
  persistRawPayload: vi.fn(),
  refreshPageMetadata: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
  trimFanslyFollowerPayload: vi.fn((value: unknown) => value),
  trimFanslyMessagingGroupsPayload: vi.fn((value: unknown) => value),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  hydrateFans: vi.fn(),
}));

const transactionMocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/onlyfans-transactions.ts", () => onlyFansTransactionMocks);
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", () => fanHydrationMocks);
vi.mock("../apps/runtime/src/services/sync/transactions.ts", () => transactionMocks);

import {
  executeDmConversationsChunk,
  executeDmMessagesChunk,
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executeSubscribersChunk,
  executeTopSpendersChunk,
  executeTransactionsChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";

function createTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    recordDmMessagesChunkSummary: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    getRequestObserver: vi.fn(() => null),
  };
}

async function recordStartedRequest(requestObserver: { onRequestEvent(event: unknown): Promise<void> } | null | undefined, operation: string) {
  await requestObserver?.onRequestEvent({
    requestId: `${operation}-request`,
    operation,
    endpointTemplate: `/${operation}`,
    method: "GET",
    attemptNumber: 1,
    timestamp: new Date("2026-03-10T00:00:00.000Z"),
    state: "started",
  });
}

function buildDmMessageSyncCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 777,
    platformConversationId: "group-1",
    fanId: 101,
    partnerPlatformUserId: "fan-1",
    unreadCount: 2,
    lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
    lastMessageId: "msg-80",
    newestStoredMessageId: null,
    storedMessageCount: 0,
    messageBackfillComplete: false,
    lastMessageSyncAt: null,
    ...overrides,
  };
}

function buildDmConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 777,
    platformAccountId: 55,
    fanId: 101,
    platformConversationId: "group-1",
    partnerPlatformUserId: "fan-1",
    partnerUsername: "fan_1",
    partnerDisplayName: "Fan 1",
    conversationFlags: 0,
    unreadCount: 2,
    subscriptionTierId: null,
    lastMessageId: "msg-80",
    lastUnreadMessageId: "msg-80",
    lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
    lastMessageSenderId: "fan-1",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "previous",
    lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
    lastModelMessageAt: null,
    storedMessageCount: 0,
    newestStoredMessageId: null,
    oldestStoredMessageId: null,
    messageBackfillComplete: false,
    lastMessageSyncAt: null,
    isVisible: true,
    lastSeenGeneration: 1,
    firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
    metadata: {},
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sync executor handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    onlyFansTransactionMocks.syncOnlyFansTransactions.mockReset();
    sharedMocks.persistRawPayload.mockReset();
    sharedMocks.refreshPageMetadata.mockReset();
    fanHydrationMocks.hydrateFans.mockReset();
    transactionMocks.syncTransactions.mockReset();

    dbMocks.upsertCheckpointProgress.mockResolvedValue({});
    dbMocks.upsertCheckpoint.mockResolvedValue({});
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: null,
      deletedCount: 0,
      summary: {
        storedMessageCount: 0,
        newestStoredMessageId: null,
        oldestStoredMessageId: null,
        lastFanMessageAt: null,
        lastModelMessageAt: null,
      },
    });
    dbMocks.getExistingPageDmMessageIds.mockResolvedValue(new Set());
    dbMocks.getPageDmConversationById.mockResolvedValue(null);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([]);
    dbMocks.markPageDmConversationsInvisibleByGeneration.mockResolvedValue(undefined);
    dbMocks.countRecentTerminalDmMessageConversationFailureStreak.mockResolvedValue(0);
    dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
    dbMocks.rebuildSubscriberRollups.mockResolvedValue(undefined);
    dbMocks.updateLegacySyncTimestamp.mockResolvedValue(undefined);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertPageDmConversation.mockResolvedValue(undefined);
    dbMocks.upsertPageDmMessages.mockResolvedValue(undefined);
    dbMocks.upsertPageTopSpenders.mockResolvedValue(undefined);
    dbMocks.upsertPageFollows.mockResolvedValue(undefined);
    dbMocks.upsertPageSubscriptions.mockResolvedValue(undefined);
    dbMocks.refreshFanPageFollowerState.mockResolvedValue(undefined);
    dbMocks.refreshFanPageSubscriberState.mockResolvedValue(undefined);
    sharedMocks.dmRetentionDate.mockReset();
    sharedMocks.dmRetentionDate.mockReturnValue(new Date("2026-09-17T00:00:00.000Z"));
    sharedMocks.normalizeFanslyTimestamp.mockReset();
    sharedMocks.normalizeFanslyTimestamp.mockImplementation((value: number) => new Date(value >= 1_000_000_000_000 ? value : value * 1000));
    sharedMocks.persistRawPayload.mockResolvedValue(undefined);
    sharedMocks.trimFanslyMessagingGroupsPayload.mockReset();
    sharedMocks.trimFanslyMessagingGroupsPayload.mockImplementation((value: unknown) => value);
  });

  it("syncs Fansly top spenders in steady state using the trailing 7 day window", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-20T12:00:00.000Z");
    vi.setSystemTime(now);

    const telemetry = createTelemetry();
    const getEarningsAccountsPage = vi.fn(async () => ({
      items: [{
        totalGross: 12_345,
        totalNet: 9_876,
        accountId: "acct-1",
        correlationAccountId: "fan-1",
      }],
      done: true,
      raw: [],
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getEarningsAccountsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "steady_state",
        accountCreatedAt: "2026-01-01T00:00:00.000Z",
        totalMonths: 3,
        completedMonths: 3,
        pendingWindows: [],
        lastWindowStartedAt: "2026-03-01T00:00:00.000Z",
        lastWindowEndedAt: "2026-03-08T00:00:00.000Z",
      },
    });
    dbMocks.upsertFans.mockResolvedValue([{
      id: 101,
      platformUserId: "fan-1",
    }]);

    const result = await executeTopSpendersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
          metadata: {
            accountCreatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        session: { authorization: "token" },
        proxy: null,
      },
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      yieldReason: null,
      stats: expect.objectContaining({
        mode: "steady_state",
        windowsProcessed: 1,
        windowsSplit: 0,
        upsertedRankings: 1,
      }),
    });
    expect(getEarningsAccountsPage).toHaveBeenCalledWith(expect.anything(), {
      after: new Date("2026-03-13T12:00:00.000Z"),
      before: now,
    });
    expect(sharedMocks.refreshPageMetadata).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageTopSpenders).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        platformAccountId: 10,
        sourceIdentityKey: "fan:fan-1",
        correlationAccountId: "fan-1",
        accountId: "acct-1",
        fanId: 101,
        grossAmountMills: 12_345n,
        creatorNetAmountMills: 9_876n,
        sourceWindowStartedAt: new Date("2026-03-13T12:00:00.000Z"),
        sourceWindowEndedAt: now,
      }),
    ]);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 10,
      stream: "top_spenders",
      lastSuccessfulRunId: 123,
      cursorTimestamp: now,
      state: expect.objectContaining({
        mode: "steady_state",
        pendingWindows: [],
        completedMonths: 3,
      }),
    }));

    vi.useRealTimers();
  });

  it("preserves top spender rows that only have account identity", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-20T12:00:00.000Z");
    vi.setSystemTime(now);

    const telemetry = createTelemetry();
    const getEarningsAccountsPage = vi.fn(async () => ({
      items: [{
        totalGross: 4_200,
        totalNet: 3_500,
        accountId: "acct-2",
        correlationAccountId: null,
      }],
      done: true,
      raw: [],
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getEarningsAccountsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "steady_state",
        accountCreatedAt: "2026-01-01T00:00:00.000Z",
        totalMonths: 3,
        completedMonths: 3,
        pendingWindows: [],
        lastWindowStartedAt: "2026-03-01T00:00:00.000Z",
        lastWindowEndedAt: "2026-03-08T00:00:00.000Z",
      },
    });

    const result = await executeTopSpendersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
          metadata: {
            accountCreatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        session: { authorization: "token" },
        proxy: null,
      },
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      yieldReason: null,
      stats: expect.objectContaining({
        windowsProcessed: 1,
        upsertedRankings: 1,
      }),
    });
    expect(dbMocks.upsertFans).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageTopSpenders).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        platformAccountId: 10,
        sourceIdentityKey: "account:acct-2",
        correlationAccountId: null,
        accountId: "acct-2",
        fanId: null,
        grossAmountMills: 4_200n,
        creatorNetAmountMills: 3_500n,
      }),
    ]);
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("skips top spender rows without any usable identity and records an anomaly", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-20T12:00:00.000Z");
    vi.setSystemTime(now);

    const telemetry = createTelemetry();
    const getEarningsAccountsPage = vi.fn(async () => ({
      items: [
        {
          totalGross: 12_345,
          totalNet: 9_876,
          accountId: "acct-1",
          correlationAccountId: "fan-1",
        },
        {
          totalGross: 2_000,
          totalNet: 1_500,
          accountId: null,
          correlationAccountId: null,
        },
      ],
      done: true,
      raw: [],
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getEarningsAccountsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "steady_state",
        accountCreatedAt: "2026-01-01T00:00:00.000Z",
        totalMonths: 3,
        completedMonths: 3,
        pendingWindows: [],
        lastWindowStartedAt: "2026-03-01T00:00:00.000Z",
        lastWindowEndedAt: "2026-03-08T00:00:00.000Z",
      },
    });
    dbMocks.upsertFans.mockResolvedValue([{
      id: 101,
      platformUserId: "fan-1",
    }]);

    const result = await executeTopSpendersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
          metadata: {
            accountCreatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        session: { authorization: "token" },
        proxy: null,
      },
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      yieldReason: null,
      stats: expect.objectContaining({
        windowsProcessed: 1,
        upsertedRankings: 1,
      }),
    });
    expect(dbMocks.upsertPageTopSpenders).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        sourceIdentityKey: "fan:fan-1",
        correlationAccountId: "fan-1",
      }),
    ]);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "top_spenders_missing_identity",
      severity: "warn",
      details: expect.objectContaining({
        skippedCount: 1,
      }),
    }));

    vi.useRealTimers();
  });

  it("splits capped monthly top spender windows into weekly chunks before continuing", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-20T12:00:00.000Z");
    vi.setSystemTime(now);

    const telemetry = createTelemetry();
    const getEarningsAccountsPage = vi.fn(async () => ({
      items: [],
      done: false,
      raw: [],
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getEarningsAccountsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);

    const result = await executeTopSpendersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
          metadata: {
            accountCreatedAt: "2026-03-01T00:00:00.000Z",
          },
        },
        session: { authorization: "token" },
        proxy: null,
      },
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0, 45_000),
    } as never);

    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: expect.objectContaining({
        mode: "bootstrap",
        totalMonths: 1,
        completedMonths: 0,
        pendingWindows: 3,
        windowsProcessed: 0,
        windowsSplit: 1,
      }),
    });
    expect(getEarningsAccountsPage).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertPageTopSpenders).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 10,
      stream: "top_spenders",
      state: expect.objectContaining({
        mode: "bootstrap",
        totalMonths: 1,
        completedMonths: 0,
        pendingWindows: [
          expect.objectContaining({ kind: "week", startedAt: "2026-03-01T00:00:00.000Z", endedAt: "2026-03-08T00:00:00.000Z" }),
          expect.objectContaining({ kind: "week", startedAt: "2026-03-08T00:00:00.000Z", endedAt: "2026-03-15T00:00:00.000Z" }),
          expect.objectContaining({ kind: "week", startedAt: "2026-03-15T00:00:00.000Z", endedAt: "2026-03-20T12:00:00.000Z" }),
        ],
      }),
    }));

    vi.useRealTimers();
  });

  it("splits capped steady-state weekly top spender windows into daily chunks before continuing", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-20T12:00:00.000Z");
    vi.setSystemTime(now);

    const telemetry = createTelemetry();
    const getEarningsAccountsPage = vi.fn(async () => ({
      items: [],
      done: false,
      raw: [],
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getEarningsAccountsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "steady_state",
        accountCreatedAt: "2026-03-01T00:00:00.000Z",
        totalMonths: 1,
        completedMonths: 1,
        pendingWindows: [],
        lastWindowStartedAt: "2026-03-06T12:00:00.000Z",
        lastWindowEndedAt: "2026-03-13T12:00:00.000Z",
      },
    });

    const result = await executeTopSpendersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 10,
          label: "fansly-page",
          metadata: {
            accountCreatedAt: "2026-03-01T00:00:00.000Z",
          },
        },
        session: { authorization: "token" },
        proxy: null,
      },
      syncRunId: 123,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0, 45_000),
    } as never);

    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: expect.objectContaining({
        mode: "steady_state",
        totalMonths: 1,
        completedMonths: 1,
        pendingWindows: 7,
        windowsProcessed: 0,
        windowsSplit: 1,
      }),
    });
    expect(getEarningsAccountsPage).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertPageTopSpenders).not.toHaveBeenCalled();

    const progressCall = dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1];
    expect(progressCall).toMatchObject({
      platformAccountId: 10,
      stream: "top_spenders",
      state: expect.objectContaining({
        mode: "steady_state",
        totalMonths: 1,
        completedMonths: 1,
      }),
    });
    expect(progressCall?.state.pendingWindows).toHaveLength(7);
    expect(progressCall?.state.pendingWindows[0]).toMatchObject({
      kind: "day",
      startedAt: "2026-03-13T12:00:00.000Z",
      endedAt: "2026-03-14T12:00:00.000Z",
    });
    expect(progressCall?.state.pendingWindows[6]).toMatchObject({
      kind: "day",
      startedAt: "2026-03-19T12:00:00.000Z",
      endedAt: "2026-03-20T12:00:00.000Z",
    });

    vi.useRealTimers();
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
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
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
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 12, 1);
    expect(dbMocks.updateLegacySyncTimestamp).toHaveBeenCalledWith(tx, {
      platformAccountId: 12,
      syncType: "followers",
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 12,
      stream: "followers",
    }));
    expect(dbMocks.countActivePageFollows).toHaveBeenCalledWith(db, 12);
    expect(dbMocks.requestSyncStreamRevisions).toHaveBeenCalledWith(db, {
      platformAccountId: 12,
      streams: ["followers_reconcile"],
      reason: "anomaly",
    });
  });

  it("runs follower reconcile finalization against generation-based state", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
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
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      generation: 1,
    });
    expect(dbMocks.refreshFanPageFollowerState).toHaveBeenCalledWith(tx, 13);
    expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 0);
    expect(dbMocks.updateLegacySyncTimestamp).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      syncType: "followers",
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 13,
      stream: "followers_reconcile",
    }));
  });

  it("finalizes subscribers inside one transaction on completed pages", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 1,
          items: [{
            id: "sub-1",
            subscriberId: "fan-1",
            historyId: null,
            subscriptionTierId: null,
            subscriptionTierName: null,
            subscriptionTierColor: null,
            planId: null,
            status: 3,
            price: 5000,
            renewPrice: 5000,
            autoRenew: 1,
            billingCycle: 30,
            duration: 30,
            renewDate: null,
            createdAt: new Date("2026-03-10T00:00:00.000Z").toISOString(),
            updatedAt: null,
            endsAt: new Date("2026-04-09T00:00:00.000Z").toISOString(),
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map([["fan-1", 91]]));

    const result = await executeSubscribersChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 14,
          label: "fansly-page",
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 14,
      generation: 1,
    });
    expect(dbMocks.refreshFanPageSubscriberState).toHaveBeenCalledWith(tx, 14);
    expect(dbMocks.rebuildSubscriberRollups).toHaveBeenCalledWith(tx, 14);
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 14,
      stream: "subscribers",
    }));
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

  it("resumes dm_conversations from versioned checkpoint state regardless of desired revision", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
      return {
      total: 200,
      items: [],
      accounts: [],
      groups: [],
      offset: 100,
      raw: {
        data: [],
        aggregationData: {
          total: 200,
          accounts: [],
          groups: [],
        },
      },
      done: true,
      };
    });
    const db = {};
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagingGroupsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "full_scan",
        generation: 7,
        offset: 100,
        pageCount: 1,
        providerReportedTotal: 200,
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    const result = await executeDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 42,
      },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(getMessagingGroupsPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      offset: 100,
      limit: 100,
    }));
    expect(dbMocks.listPageDmConversationsByPlatformConversationIds).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      platformConversationIds: [],
    });
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      generation: 7,
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(db, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_conversations",
      lastSuccessfulRunId: 900,
      state: expect.objectContaining({
        version: 1,
        generation: 7,
        lastFullSweepCompletedAt: expect.any(String),
      }),
    }));
  });

  it("resumes dm_messages from checkpoint state regardless of desired revision", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(requestContext.requestObserver, "messages");
      return {
      items: [{
        id: "msg-79",
        type: 1,
        dataVersion: 1,
        content: "hey there",
        groupId: "group-1",
        senderId: "fan-1",
        correlationId: null,
        inReplyTo: null,
        inReplyToRoot: null,
        createdAt: 1_770_000_000,
        attachments: [],
        embeds: [],
        interactions: [],
        likes: [],
        totalTipAmount: 25,
      }],
      groupId: "group-1",
      before: "msg-65",
      done: true,
      raw: {
        messages: [],
      },
      };
    });
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        currentConversationId: 777,
        currentPlatformConversationId: "group-1",
        currentBeforeMessageId: "msg-65",
        currentMode: "backfill",
      },
    });
    dbMocks.getPageDmConversationById.mockResolvedValue({
      id: 777,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-1",
      partnerPlatformUserId: "fan-1",
      partnerUsername: "fan_1",
      partnerDisplayName: "Fan 1",
      conversationFlags: 0,
      unreadCount: 2,
      subscriptionTierId: null,
      lastMessageId: "msg-80",
      lastUnreadMessageId: "msg-80",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-1",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: PAGE_DM_MESSAGE_HISTORY_LIMIT - 1,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-65",
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {},
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    });
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: PAGE_DM_MESSAGE_HISTORY_LIMIT,
        newestStoredMessageId: "msg-80",
        oldestStoredMessageId: "msg-79",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 999,
      },
      syncRunId: 901,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(2),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.selectNextPageDmMessageSyncCandidate).toHaveBeenCalledWith({}, {
      platformAccountId: 55,
    });
    expect(dbMocks.getPageDmConversationById).toHaveBeenCalledWith({}, 777);
    expect(getMessagesPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: "group-1",
      before: "msg-65",
      limit: 25,
    }));
    expect(dbMocks.upsertPageDmMessages).toHaveBeenCalledWith({}, expect.arrayContaining([
      expect.objectContaining({
        conversationId: 777,
        platformMessageId: "msg-79",
        senderRole: "fan",
      }),
    ]));
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      conversationId: 777,
      messageBackfillComplete: true,
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_messages",
      lastSuccessfulRunId: 901,
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
      },
    }));
    expect(telemetry.recordDmMessagesChunkSummary).toHaveBeenCalledWith({
      conversationsProcessed: 1,
      messageFetchRequests: 1,
      rateLimit429s: 0,
      chunkDurationMs: expect.any(Number),
      averageGapMs: 0,
    });
    expect(result.stats).toMatchObject({
      dmMessagesChunk: {
        conversationsProcessed: 1,
        messageFetchRequests: 1,
        rateLimit429s: 0,
        averageGapMs: 0,
      },
    });
  });

  it("yields dm_conversations when the chunk budget is exhausted mid-sweep", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await context.requestObserver?.onRequestEvent({ state: "started" });
      return {
        total: 200,
        items: [{
          groupId: "group-1",
          partnerAccountId: "fan-1",
          partnerUsername: "fan_1",
          flags: 0,
          unreadCount: 2,
          subscriptionTierId: null,
          lastMessageId: "msg-80",
          lastUnreadMessageId: "msg-80",
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
        }],
        groups: [{
          id: "group-1",
          users: [
            { groupId: "group-1", userId: "acct-dm", type: 1, permissionFlags: 0 },
            { groupId: "group-1", userId: "fan-1", type: 1, permissionFlags: 0 },
          ],
          lastMessage: {
            id: "msg-80",
            type: 1,
            dataVersion: 1,
            content: "hello there",
            groupId: "group-1",
            senderId: "fan-1",
            correlationId: null,
            inReplyTo: null,
            inReplyToRoot: null,
            createdAt: 1_770_000_000,
            attachments: [],
            embeds: [],
            interactions: [],
            likes: [],
            totalTipAmount: 0,
          },
        }],
        offset: 100,
        done: false,
        raw: {
          data: [],
          aggregationData: {
            total: 200,
            accounts: [],
            groups: [],
          },
        },
      };
    });
    const db = {};
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagingGroupsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertFans.mockResolvedValue([{ id: 101, platformUserId: "fan-1" }]);

    const result = await executeDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 902,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
    });
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(db, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_conversations",
      state: expect.objectContaining({
        offset: 100,
      }),
    }));
  });

  it("marks conversations excluded from message sync when the partner is missing from aggregation accounts", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: 1,
      items: [{
        groupId: "group-missing",
        partnerAccountId: "fan-missing",
        partnerUsername: "fan_missing",
        flags: 0,
        unreadCount: 2,
        subscriptionTierId: null,
        lastMessageId: "msg-80",
        lastUnreadMessageId: "msg-80",
      }],
      accounts: [{
        id: "fan-other",
        username: "fan_other",
        displayName: "Fan Other",
        createdAt: 1_770_000_000_000,
      }],
      groups: [{
        id: "group-missing",
        users: [
          { groupId: "group-missing", userId: "acct-dm", type: 1, permissionFlags: 0 },
          { groupId: "group-missing", userId: "fan-missing", type: 1, permissionFlags: 0 },
        ],
        lastMessage: {
          id: "msg-80",
          type: 1,
          dataVersion: 1,
          content: "hello there",
          groupId: "group-missing",
          senderId: "fan-missing",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        },
      }],
      offset: 0,
      done: true,
      raw: {
        data: [],
        aggregationData: {
          total: 1,
          accounts: [],
          groups: [],
        },
      },
    }));
    const db = {};
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagingGroupsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([{
      id: 777,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-missing",
      partnerPlatformUserId: "fan-missing",
      partnerUsername: "fan_missing",
      partnerDisplayName: "Fan Missing",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-79",
      lastUnreadMessageId: "msg-79",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-missing",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 7,
      newestStoredMessageId: "msg-79",
      oldestStoredMessageId: "msg-73",
      messageBackfillComplete: false,
      lastMessageSyncAt: new Date("2026-03-10T00:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {},
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    }]);

    const result = await executeDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 904,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.upsertFans).not.toHaveBeenCalled();
    expect(dbMocks.upsertFanPages).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageDmConversation).toHaveBeenCalledWith(db, expect.objectContaining({
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-missing",
      partnerPlatformUserId: "fan-missing",
      partnerUsername: "fan_missing",
      partnerDisplayName: "Fan Missing",
      storedMessageCount: 7,
      newestStoredMessageId: "msg-79",
      oldestStoredMessageId: "msg-73",
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      },
    }));
  });

  it("clears the message sync exclusion marker when the partner reappears in aggregation accounts", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: 1,
      items: [{
        groupId: "group-recovered",
        partnerAccountId: "fan-live",
        partnerUsername: "fan_live",
        flags: 0,
        unreadCount: 2,
        subscriptionTierId: null,
        lastMessageId: "msg-80",
        lastUnreadMessageId: "msg-80",
      }],
      accounts: [{
        id: "fan-live",
        username: "fan_live",
        displayName: "Fan Live",
        createdAt: 1_770_000_000_000,
      }],
      groups: [{
        id: "group-recovered",
        users: [
          { groupId: "group-recovered", userId: "acct-dm", type: 1, permissionFlags: 0 },
          { groupId: "group-recovered", userId: "fan-live", type: 1, permissionFlags: 0 },
        ],
        lastMessage: {
          id: "msg-80",
          type: 1,
          dataVersion: 1,
          content: "hello there",
          groupId: "group-recovered",
          senderId: "fan-live",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        },
      }],
      offset: 0,
      done: true,
      raw: {
        data: [],
        aggregationData: {
          total: 1,
          accounts: [],
          groups: [],
        },
      },
    }));
    const db = {};
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagingGroupsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([{
      id: 778,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-recovered",
      partnerPlatformUserId: "fan-live",
      partnerUsername: "fan_live",
      partnerDisplayName: "Fan Live",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-79",
      lastUnreadMessageId: "msg-79",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-live",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 7,
      newestStoredMessageId: "msg-79",
      oldestStoredMessageId: "msg-73",
      messageBackfillComplete: false,
      lastMessageSyncAt: new Date("2026-03-10T00:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      },
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    }]);
    dbMocks.upsertFans.mockResolvedValue([{ id: 101, platformUserId: "fan-live" }]);

    const result = await executeDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 905,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.upsertFans).toHaveBeenCalledWith(db, [expect.objectContaining({
      platformUserId: "fan-live",
    })]);
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(db, [expect.objectContaining({
      fanId: 101,
      platformAccountId: 55,
    })]);
    expect(dbMocks.upsertPageDmConversation).toHaveBeenCalledWith(db, expect.objectContaining({
      platformConversationId: "group-recovered",
      metadata: {},
    }));
  });

  it("clears the unresolvable exclusion marker when account lookup resolves the partner again", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: 1,
      items: [{
        groupId: "group-recheck",
        partnerAccountId: "fan-recheck",
        partnerUsername: "fan_recheck",
        flags: 0,
        unreadCount: 2,
        subscriptionTierId: null,
        lastMessageId: "msg-80",
        lastUnreadMessageId: "msg-80",
      }],
      accounts: [],
      groups: [{
        id: "group-recheck",
        users: [
          { groupId: "group-recheck", userId: "acct-dm", type: 1, permissionFlags: 0 },
          { groupId: "group-recheck", userId: "fan-recheck", type: 1, permissionFlags: 0 },
        ],
        lastMessage: {
          id: "msg-80",
          type: 1,
          dataVersion: 1,
          content: "hello there",
          groupId: "group-recheck",
          senderId: "fan-recheck",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        },
      }],
      offset: 0,
      done: true,
      raw: {
        data: [],
        aggregationData: {
          total: 1,
          accounts: [],
          groups: [],
        },
      },
    }));
    const getAccountsByIdsPage = vi.fn(async () => ({
      parsed: [{
        id: "fan-recheck",
        username: "fan_recheck",
        displayName: "Fan Recheck",
        createdAt: 1_770_000_000_000,
      }],
      raw: {},
    }));
    const db = {};
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagingGroupsPage,
        getAccountsByIdsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([buildDmConversation({
      id: 779,
      platformConversationId: "group-recheck",
      partnerPlatformUserId: "fan-recheck",
      partnerUsername: "fan_recheck",
      partnerDisplayName: "Fan Recheck",
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      },
    })]);
    dbMocks.upsertFans.mockResolvedValue([{ id: 101, platformUserId: "fan-recheck" }]);

    const result = await executeDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 9051,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(2),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(getAccountsByIdsPage).toHaveBeenCalledWith(expect.anything(), ["fan-recheck"]);
    expect(dbMocks.upsertPageDmConversation).toHaveBeenCalledWith(db, expect.objectContaining({
      platformConversationId: "group-recheck",
      metadata: {},
    }));
  });

  it("yields dm_messages when the chunk budget is exhausted mid-conversation", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(context.requestObserver, "messages");
      return {
        items: [{
          id: "msg-79",
          type: 1,
          dataVersion: 1,
          content: "hey there",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 25,
        }],
        groupId: "group-1",
        before: null,
        done: false,
        raw: {
          messages: [],
        },
      };
    });
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate
      .mockResolvedValueOnce({
        id: 777,
        platformConversationId: "group-1",
        fanId: 101,
        partnerPlatformUserId: "fan-1",
        unreadCount: 2,
        lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastMessageId: "msg-80",
        newestStoredMessageId: null,
        storedMessageCount: 0,
        messageBackfillComplete: false,
        lastMessageSyncAt: null,
      })
      .mockResolvedValueOnce(null);
    dbMocks.getPageDmConversationById.mockResolvedValue({
      id: 777,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-1",
      partnerPlatformUserId: "fan-1",
      partnerUsername: "fan_1",
      partnerDisplayName: "Fan 1",
      conversationFlags: 0,
      unreadCount: 2,
      subscriptionTierId: null,
      lastMessageId: "msg-80",
      lastUnreadMessageId: "msg-80",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-1",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {},
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    const result = await executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 903,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: expect.objectContaining({
        currentConversationId: 777,
        currentBeforeMessageId: "msg-79",
        currentMode: "backfill",
      }),
    });
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.finalizePageDmConversationMessageSync).not.toHaveBeenCalled();
    expect(telemetry.recordDmMessagesChunkSummary).toHaveBeenCalledWith({
      conversationsProcessed: 1,
      messageFetchRequests: 1,
      rateLimit429s: 0,
      chunkDurationMs: expect.any(Number),
      averageGapMs: 0,
    });
    expect(result.stats).toMatchObject({
      dmMessagesChunk: {
        conversationsProcessed: 1,
        messageFetchRequests: 1,
        rateLimit429s: 0,
        averageGapMs: 0,
      },
    });
  });

  it("counts 429 retries in dm_messages chunk summaries", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await context.requestObserver?.onRequestEvent({
        requestId: "messages-request",
        operation: "messages",
        endpointTemplate: "/message",
        method: "GET",
        attemptNumber: 1,
        timestamp: new Date("2026-03-10T00:00:00.000Z"),
        state: "started",
      });
      await context.requestObserver?.onRequestEvent({
        requestId: "messages-request",
        operation: "messages",
        endpointTemplate: "/message",
        method: "GET",
        attemptNumber: 1,
        timestamp: new Date("2026-03-10T00:00:00.100Z"),
        state: "retry",
        httpStatus: 429,
        durationMs: 100,
        retryDelayMs: 5_000,
        failureKind: "http",
      });
      await context.requestObserver?.onRequestEvent({
        requestId: "messages-request",
        operation: "messages",
        endpointTemplate: "/message",
        method: "GET",
        attemptNumber: 2,
        timestamp: new Date("2026-03-10T00:00:07.600Z"),
        state: "started",
      });
      return {
        items: [{
          id: "msg-79",
          type: 1,
          dataVersion: 1,
          content: "hey there",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 25,
        }],
        groupId: "group-1",
        before: null,
        done: true,
        raw: {
          messages: [],
        },
      };
    });
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate
      .mockResolvedValueOnce({
        id: 777,
        platformConversationId: "group-1",
        fanId: 101,
        partnerPlatformUserId: "fan-1",
        unreadCount: 2,
        lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastMessageId: "msg-80",
        newestStoredMessageId: null,
        storedMessageCount: 0,
        messageBackfillComplete: false,
        lastMessageSyncAt: null,
      })
      .mockResolvedValueOnce(null);
    dbMocks.getPageDmConversationById.mockResolvedValue({
      id: 777,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-1",
      partnerPlatformUserId: "fan-1",
      partnerUsername: "fan_1",
      partnerDisplayName: "Fan 1",
      conversationFlags: 0,
      unreadCount: 2,
      subscriptionTierId: null,
      lastMessageId: "msg-80",
      lastUnreadMessageId: "msg-80",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-1",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {},
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    });
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 1,
        newestStoredMessageId: "msg-79",
        oldestStoredMessageId: "msg-79",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 904,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(telemetry.recordDmMessagesChunkSummary).toHaveBeenCalledWith({
      conversationsProcessed: 1,
      messageFetchRequests: 2,
      rateLimit429s: 1,
      chunkDurationMs: expect.any(Number),
      averageGapMs: 7_600,
    });
    expect(result.stats).toMatchObject({
      dmMessagesChunk: {
        conversationsProcessed: 1,
        messageFetchRequests: 2,
        rateLimit429s: 1,
        averageGapMs: 7_600,
      },
    });
  });

  it("excludes unresolvable partners after repeated terminal dm_messages 5xx failures and continues", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
      params: { groupId: string },
    ) => {
      await recordStartedRequest(context.requestObserver, "messages");
      if (params.groupId === "group-broken") {
        throw new FanslyApiError("provider failure", 500);
      }

      return {
        items: [{
          id: "msg-81",
          type: 1,
          dataVersion: 1,
          content: "recovered conversation",
          groupId: "group-live",
          senderId: "fan-live",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_770_000_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        }],
        groupId: "group-live",
        before: null,
        done: true,
        raw: {
          messages: [],
        },
      };
    });
    const getAccountsByIdsPage = vi.fn(async () => ({
      parsed: [],
      raw: {},
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
        getAccountsByIdsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate
      .mockResolvedValueOnce(buildDmMessageSyncCandidate({
        id: 777,
        platformConversationId: "group-broken",
        partnerPlatformUserId: "fan-missing",
      }))
      .mockResolvedValueOnce(buildDmMessageSyncCandidate({
        id: 778,
        platformConversationId: "group-live",
        partnerPlatformUserId: "fan-live",
      }))
      .mockResolvedValueOnce(null);
    dbMocks.getPageDmConversationById.mockImplementation(async (_db: unknown, id: number) => {
      if (id === 777) {
        return buildDmConversation({
          id: 777,
          platformConversationId: "group-broken",
          partnerPlatformUserId: "fan-missing",
          partnerUsername: "fan_missing",
          partnerDisplayName: "Fan Missing",
          lastMessageSenderId: "fan-missing",
          lastMessageSenderRole: "fan",
        });
      }

      if (id === 778) {
        return buildDmConversation({
          id: 778,
          platformConversationId: "group-live",
          partnerPlatformUserId: "fan-live",
          partnerUsername: "fan_live",
          partnerDisplayName: "Fan Live",
          lastMessageSenderId: "fan-live",
          lastMessageSenderRole: "fan",
        });
      }

      return null;
    });
    dbMocks.countRecentTerminalDmMessageConversationFailureStreak.mockResolvedValueOnce(3);
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 778,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 1,
        newestStoredMessageId: "msg-81",
        oldestStoredMessageId: "msg-81",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 907,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.countRecentTerminalDmMessageConversationFailureStreak).toHaveBeenCalledWith({}, {
      platformAccountId: 55,
      platformConversationId: "group-broken",
    });
    expect(getAccountsByIdsPage).toHaveBeenCalledWith(expect.anything(), ["fan-missing"]);
    expect(dbMocks.upsertPageDmConversation).toHaveBeenCalledWith({}, expect.objectContaining({
      platformConversationId: "group-broken",
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      },
    }));
    expect(telemetry.addNote).toHaveBeenCalledWith(
      "Excluded DM conversation after repeated 5xx because partner account is unresolvable",
      expect.objectContaining({
        groupId: "group-broken",
        partnerPlatformUserId: "fan-missing",
        failureStreak: 3,
      }),
    );
    expect(getMessagesPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: "group-live",
    }));
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      conversationId: 778,
    }));
  });

  it("does not exclude repeated dm_messages 5xx failures when the partner still resolves", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (
      context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    ) => {
      await recordStartedRequest(context.requestObserver, "messages");
      throw new FanslyApiError("provider failure", 500);
    });
    const getAccountsByIdsPage = vi.fn(async () => ({
      parsed: [{
        id: "fan-live",
        username: "fan_live",
        displayName: "Fan Live",
        createdAt: 1_770_000_000_000,
      }],
      raw: {},
    }));
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
        getAccountsByIdsPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValueOnce(buildDmMessageSyncCandidate({
      id: 777,
      platformConversationId: "group-live",
      partnerPlatformUserId: "fan-live",
    }));
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      id: 777,
      platformConversationId: "group-live",
      partnerPlatformUserId: "fan-live",
      partnerUsername: "fan_live",
      partnerDisplayName: "Fan Live",
      lastMessageSenderId: "fan-live",
      lastMessageSenderRole: "fan",
    }));
    dbMocks.countRecentTerminalDmMessageConversationFailureStreak.mockResolvedValueOnce(3);

    await expect(executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 908,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never)).rejects.toThrow("provider failure");

    expect(getAccountsByIdsPage).toHaveBeenCalledWith(expect.anything(), ["fan-live"]);
    expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
    expect(telemetry.addNote).not.toHaveBeenCalled();
  });

  it("drops checkpointed conversations that are marked excluded before fetching messages", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: true,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        currentConversationId: 777,
        currentPlatformConversationId: "group-excluded",
        currentBeforeMessageId: null,
        currentMode: "incremental",
      },
    });
    dbMocks.getPageDmConversationById.mockResolvedValue({
      id: 777,
      platformAccountId: 55,
      fanId: 101,
      platformConversationId: "group-excluded",
      partnerPlatformUserId: "fan-1",
      partnerUsername: "fan_1",
      partnerDisplayName: "Fan 1",
      conversationFlags: 0,
      unreadCount: 2,
      subscriptionTierId: null,
      lastMessageId: "msg-80",
      lastUnreadMessageId: "msg-80",
      lastMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastMessageSenderId: "fan-1",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "previous",
      lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: PAGE_DM_MESSAGE_HISTORY_LIMIT,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-56",
      messageBackfillComplete: true,
      lastMessageSyncAt: new Date("2026-03-10T00:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      firstSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-03-10T00:00:00.000Z"),
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      },
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-10T00:00:00.000Z"),
    });
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);

    const result = await executeDmMessagesChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 55,
          label: "dm-page",
          platformAccountId: "acct-dm",
          metadata: {},
        },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: {
        desiredRevision: 1,
      },
      syncRunId: 906,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(2),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(getMessagesPage).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_messages",
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
      },
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_messages",
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
      },
    }));
  });
});
