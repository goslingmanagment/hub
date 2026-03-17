import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  countActivePageFollows: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  deactivatePageSubscriptionsByGeneration: vi.fn(),
  finalizePageDmConversationMessageSync: vi.fn(),
  getCheckpoint: vi.fn(),
  getCurrentSubscribers: vi.fn(),
  getExistingPageDmMessageIds: vi.fn(),
  getPageDmConversationById: vi.fn(),
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
    dbMocks.markPageDmConversationsInvisibleByGeneration.mockResolvedValue(undefined);
    dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
    dbMocks.rebuildSubscriberRollups.mockResolvedValue(undefined);
    dbMocks.updateLegacySyncTimestamp.mockResolvedValue(undefined);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertPageDmConversation.mockResolvedValue(undefined);
    dbMocks.upsertPageDmMessages.mockResolvedValue(undefined);
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
    const db = {
      query: {
        pageDmConversations: {
          findFirst: vi.fn(async () => null),
        },
      },
    };
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
        lastFullSweepCompletedAt: expect.any(String),
      }),
    }));
  });

  it("resumes dm_messages from checkpoint state regardless of desired revision", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_messages");
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
      storedMessageCount: 74,
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
        storedMessageCount: 75,
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
    const db = {
      query: {
        pageDmConversations: {
          findFirst: vi.fn(async () => null),
        },
      },
    };
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

  it("yields dm_messages when the chunk budget is exhausted mid-conversation", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await context.requestObserver?.onRequestEvent({ state: "started" });
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
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue({
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
  });
});
