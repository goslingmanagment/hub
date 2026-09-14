import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as FanHydrationModule from "../apps/runtime/src/services/sync/fan-hydration.ts";
import { PAGE_DM_MESSAGE_HISTORY_LIMIT } from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
} from "@agency_hub_core/shared";

const dbMocks = vi.hoisted(() => ({
  observeFanslyDmHead: vi.fn(),
  hasUnresolvedFanslyDmHead: vi.fn(async () => false),
  nextFanslyDmHeadRetryAt: vi.fn(async () => null),
  getFanslyDmHeadTarget: vi.fn<typeof DbModule.getFanslyDmHeadTarget>(async () => null),
  recordFanslyDmHeadAttempt: vi.fn(),
  // The transactions executor now resolves live effective config (one read per
  // chunk); these chunk tests use a bare db so stub it to "no overrides".
  getConfigOverrides: vi.fn(async () => new Map()),
  countRecentTerminalDmMessageConversationFailureStreak: vi.fn(),
  countActivePageFollows: vi.fn(),
  countPageDmThreadsByGeneration: vi.fn(),
  countPageDmVisibleThreadsBelowGeneration: vi.fn(),
  countPageFollowsByGeneration: vi.fn(),
  deactivatePageFollowsByGeneration: vi.fn(),
  deactivatePageSubscriptionsByGeneration: vi.fn(),
  finalizePageDmConversationMessageSync: vi.fn(),
  findErasureLogTouchingPageSince: vi.fn(),
  getCheckpoint: vi.fn(),
  getCurrentSubscribers: vi.fn(),
  getExistingPageDmMessageIds: vi.fn(),
  getPageDmConversationById: vi.fn(),
  listPageDmConversationsByPlatformConversationIds: vi.fn(),
  listPageDmThreadIdsStampedWithGeneration: vi.fn(),
  markPageDmConversationsInvisibleByGeneration: vi.fn(),
  tryAcquireDmArchiveWriterFenceLock: vi.fn(),
  maxPageDmThreadGeneration: vi.fn(),
  maxPageFollowGeneration: vi.fn(),
  maxPageSubscriptionGeneration: vi.fn(),
  rebuildFollowerRollups: vi.fn(),
  rebuildSubscriberRollups: vi.fn(),
  readPageFollowDeactivationGenerationBuckets: vi.fn(),
  readPageFollowReconcileActivity: vi.fn(),
  requestPageSync: vi.fn(),
  selectNextPageDmMessageDeepBackfillCandidate: vi.fn(),
  selectNextPageDmMessageSyncCandidate: vi.fn(),
  updatePageSyncTimestampCache: vi.fn(),
  upsertArchivedPageSubscriptions: vi.fn(),
  upsertCheckpoint: vi.fn(),
  upsertCheckpointProgress: vi.fn(),
  upsertPageDmConversation: vi.fn(),
  excludePageDmConversationMessageSync: vi.fn(),
  upsertPageDmMessages: vi.fn(),
  upsertPageTopSpenders: vi.fn(),
  upsertFanPageExternalPresences: vi.fn(),
  upsertFanPages: vi.fn(),
  upsertFans: vi.fn(),
  upsertPageFollows: vi.fn(),
  upsertPageSubscriptions: vi.fn(),
  refreshFanPageFollowerState: vi.fn(),
  refreshFanPageSubscriberState: vi.fn(),
}));


const sharedMocks = vi.hoisted(() => ({
  // WP-F0(a): the per-endpoint capture-shape versions the three journaling call
  // sites now pass. Real VALUES, not vi.fn(): a handler reads them as constants,
  // and the assertions below pin the exact string that reaches the journal —
  // which is the point of having them (replay tooling must be able to tell a
  // pre-[A20] 4-field capture from a widened 18-field one).
  FANSLY_FOLLOWERS_CAPTURE_MAPPER_VERSION: "fansly-phase1-v5+followers-capture-v2",
  FANSLY_GROUPS_CAPTURE_MAPPER_VERSION: "fansly-phase1-v5+groups-capture-v2",
  dmRetentionDate: vi.fn(() => new Date("2026-09-17T00:00:00.000Z")),
  normalizeDmTipAmountCents: vi.fn((platform: "fansly" | "onlyfans", totalTipAmount: number | null | undefined) => (
    typeof totalTipAmount !== "number" || !Number.isFinite(totalTipAmount) || totalTipAmount <= 0
      ? 0
      : platform === "fansly"
      ? Math.round(totalTipAmount / 10)
      : Math.round(totalTipAmount)
  )),
  normalizeFanslyTimestamp: vi.fn((value: number) => new Date(value >= 1_000_000_000_000 ? value : value * 1000)),
  persistRawPayload: vi.fn(),
  refreshPageMetadata: vi.fn(),
  retentionDate: vi.fn(() => new Date("2026-09-10T00:00:00.000Z")),
  trimFanslyFollowerPayload: vi.fn((value: unknown) => value),
  trimFanslyMessagingGroupsPayload: vi.fn((value: unknown) => value),
}));

const tipContextMocks = vi.hoisted(() => ({
  materializeFanslyDmTipContextsBestEffort: vi.fn(),
}));

const fanHydrationMocks = vi.hoisted(() => ({
  hydrateFans: vi.fn(),
  lookupHydratedFans: vi.fn(),
  upsertHydratedFansForPage: vi.fn(),
}));

const transactionMocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});
vi.mock("../apps/runtime/src/services/sync/shared.ts", () => sharedMocks);
vi.mock(
  "../apps/runtime/src/services/sync/fansly-tip-contexts.ts",
  () => tipContextMocks,
);
vi.mock("../apps/runtime/src/services/sync/fan-hydration.ts", async () => {
  const actual = await vi.importActual<typeof FanHydrationModule>(
    "../apps/runtime/src/services/sync/fan-hydration.ts",
  );
  return {
    ...actual,
    hydrateFans: fanHydrationMocks.hydrateFans,
    lookupHydratedFans: fanHydrationMocks.lookupHydratedFans,
    upsertHydratedFansForPage: fanHydrationMocks.upsertHydratedFansForPage,
  };
});
vi.mock("../apps/runtime/src/services/sync/transactions.ts", () => transactionMocks);

import {
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executeStreamChunk,
  fanslyDmMessagesChunk,
  fanslySubscribersChunk,
  fanslyTopSpendersChunk,
  fanslyTransactionsChunk,
  onlyfansDmMessagesChunk,
  onlyfansTransactionsChunk,
} from "../apps/runtime/src/services/sync/executor-handlers.ts";
import {
  fanslyDmConversationsChunk,
} from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
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

/** Declares the row-side half of the G2 dual proof: what
 *  `page_dm_threads.last_seen_generation` would report for the sweep's
 *  generation once this page's upserts land. */
/** G3: the row-side membership record — how many page_dm_threads rows carry the
 *  sweep's generation when its page transaction counts them. */
function stubGenerationSetCount(count: number) {
  dbMocks.countPageDmThreadsByGeneration.mockResolvedValue(count);
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

const FOLLOWER_SWEEP_STARTED_AT = "2026-08-24T20:00:00.000Z";

describe("sync executor handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(dbMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    sharedMocks.persistRawPayload.mockReset();
    tipContextMocks.materializeFanslyDmTipContextsBestEffort.mockReset();
    sharedMocks.refreshPageMetadata.mockReset();
    fanHydrationMocks.hydrateFans.mockReset();
    fanHydrationMocks.lookupHydratedFans.mockReset();
    fanHydrationMocks.upsertHydratedFansForPage.mockReset();
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
    // G3: tests that reach a checkpoint write declare the row-side generation
    // set with stubGenerationSetCount(); the default is "no rows stamped",
    // which is only ever read by tests that never write.
    dbMocks.countPageDmThreadsByGeneration.mockResolvedValue(0);
    // The empty-sweep guard's reading: "no visible thread would be hidden".
    // Only a sweep that observes nothing at all ever asks.
    dbMocks.countPageDmVisibleThreadsBelowGeneration.mockResolvedValue(0);
    // No id on an incoming page is already stamped with this sweep's
    // generation — the non-overlapping case every other test assumes.
    dbMocks.listPageDmThreadIdsStampedWithGeneration.mockResolvedValue([]);
    // The erasure fence is free unless a test says an erasure holds it.
    dbMocks.tryAcquireDmArchiveWriterFenceLock.mockResolvedValue(true);
    dbMocks.findErasureLogTouchingPageSince.mockResolvedValue(null);
    dbMocks.markPageDmConversationsInvisibleByGeneration.mockResolvedValue(undefined);
    dbMocks.maxPageDmThreadGeneration.mockResolvedValue(0);
    dbMocks.maxPageFollowGeneration.mockResolvedValue(0);
    dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(0);
    dbMocks.countRecentTerminalDmMessageConversationFailureStreak.mockResolvedValue(0);
    dbMocks.countPageFollowsByGeneration.mockResolvedValue(0);
    dbMocks.readPageFollowDeactivationGenerationBuckets.mockResolvedValue([]);
    dbMocks.deactivatePageFollowsByGeneration.mockResolvedValue([]);
    dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
      firstSeenDuringSweepOutsideGeneration: 0,
      activeFollowerCount: 0,
      deactivationCandidateCount: 0,
    });
    dbMocks.rebuildFollowerRollups.mockResolvedValue(undefined);
    dbMocks.rebuildSubscriberRollups.mockResolvedValue(undefined);
    dbMocks.updatePageSyncTimestampCache.mockResolvedValue(undefined);
    dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);
    dbMocks.upsertFanPages.mockResolvedValue(undefined);
    dbMocks.upsertPageDmConversation.mockResolvedValue(undefined);
    dbMocks.excludePageDmConversationMessageSync.mockResolvedValue(true);
    dbMocks.upsertPageDmMessages.mockResolvedValue(undefined);
    dbMocks.upsertPageTopSpenders.mockResolvedValue(undefined);
    dbMocks.upsertFanPageExternalPresences.mockResolvedValue(undefined);
    dbMocks.upsertFans.mockResolvedValue([]);
    dbMocks.upsertPageFollows.mockResolvedValue(undefined);
    dbMocks.upsertArchivedPageSubscriptions.mockResolvedValue(undefined);
    dbMocks.upsertPageSubscriptions.mockResolvedValue(undefined);
    dbMocks.refreshFanPageFollowerState.mockResolvedValue(undefined);
    dbMocks.refreshFanPageSubscriberState.mockResolvedValue(undefined);
    sharedMocks.dmRetentionDate.mockReset();
    sharedMocks.dmRetentionDate.mockReturnValue(new Date("2026-09-17T00:00:00.000Z"));
    sharedMocks.normalizeDmTipAmountCents.mockReset();
    sharedMocks.normalizeDmTipAmountCents.mockImplementation(
      (platform: "fansly" | "onlyfans", totalTipAmount: number | null | undefined) => (
        typeof totalTipAmount !== "number" || !Number.isFinite(totalTipAmount) || totalTipAmount <= 0
          ? 0
          : platform === "fansly"
          ? Math.round(totalTipAmount / 10)
          : Math.round(totalTipAmount)
      ),
    );
    sharedMocks.normalizeFanslyTimestamp.mockReset();
    sharedMocks.normalizeFanslyTimestamp.mockImplementation((value: number) => new Date(value >= 1_000_000_000_000 ? value : value * 1000));
    sharedMocks.persistRawPayload.mockResolvedValue({
      id: 444,
      capturedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    tipContextMocks.materializeFanslyDmTipContextsBestEffort.mockResolvedValue({
      envelopeStatus: "absent",
      tipItemsSeen: 0,
      contexts: [],
      rejectedItems: [],
      droppedOptionalMemberCount: 0,
      upserted: 0,
      unchanged: 0,
      conversationConflicts: 0,
      failed: false,
    });
    sharedMocks.trimFanslyMessagingGroupsPayload.mockReset();
    sharedMocks.trimFanslyMessagingGroupsPayload.mockImplementation((value: unknown) => value);
    fanHydrationMocks.hydrateFans.mockResolvedValue(new Map());
    fanHydrationMocks.lookupHydratedFans.mockImplementation(async (
      app: { adapter?: { getAccountsByIdsPage?: ((requestContext: unknown, ids: string[]) => Promise<{ parsed: Array<{ id: string; username: string | null; displayName: string | null; createdAt?: number | null }> }>) | undefined } },
      input: {
        requestContext: unknown;
        platformUserIds: string[];
      },
    ) => {
      const uniqueIds = Array.from(new Set(input.platformUserIds.filter(Boolean)));

      if (typeof app.adapter?.getAccountsByIdsPage === "function") {
        const response = await app.adapter.getAccountsByIdsPage(input.requestContext, uniqueIds);
        const accounts = response.parsed;
        return {
          accounts,
          fallbackIds: uniqueIds.filter((id) => !accounts.some((account) => account.id === id)),
        };
      }

      return {
        accounts: uniqueIds.map((id) => ({
          id,
          username: id,
          displayName: id,
          createdAt: 1_770_000_000_000,
        })),
        fallbackIds: [],
      };
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockImplementation(async (
      db: object,
      input: {
        platformAccountId: number;
        accounts: Array<{
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }>;
        fallbackIds?: string[];
      },
    ) => {
      const fans: Array<{ id: number; platformUserId: string }> = await dbMocks.upsertFans(db, [
        ...input.accounts.map((account: {
          id: string;
          username: string | null;
          displayName: string | null;
          createdAt?: number | null;
        }) => ({
          platform: "fansly" as const,
          platformUserId: account.id,
          username: account.username,
          displayName: account.displayName,
          createdAtExternal: account.createdAt ? new Date(account.createdAt) : null,
          metadata: {},
        })),
        ...(input.fallbackIds ?? []).map((platformUserId: string) => ({
          platform: "fansly" as const,
          platformUserId,
          metadata: {},
        })),
      ]);

      if (fans.length > 0) {
        await dbMocks.upsertFanPages(db, fans.map((fan: { id: number; platformUserId: string }) => ({
          fanId: fan.id,
          platformAccountId: input.platformAccountId,
        })));
      }

      return new Map(fans.map((fan: { id: number; platformUserId: string }) => [fan.platformUserId, fan.id] as const));
    });
  });

  it("rejects the retired history stream before registry dispatch", async () => {
    const telemetry = createTelemetry();
    await expect(executeStreamChunk({
      db: {},
      config: {
        onlyFansDmPollingEnabled: false,
      },
    } as never, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 55,
          label: "onlyfans-page",
          platformAccountId: "of-55",
          metadata: {},
        },
        auth: { token: "secret" },
        proxy: null,
      },
      streamState: {
        stream: "dm_messages",
      },
      syncRunId: 910,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow(/Unsupported executor stream "dm_messages"/);
    expect(telemetry.addNote).not.toHaveBeenCalled();
  });

  it("keeps the retired OnlyFans history handler physically incapable of vendor I/O", async () => {
    const listChatMessages = vi.fn(async () => {
      throw new Error("must not run");
    });
    const result = await onlyfansDmMessagesChunk({
      ofapi: { listChatMessages },
    } as never, {
      pageContext: {
        platform: "onlyfans",
        page: { id: 55, label: "onlyfans-page" },
      },
      streamState: { stream: "dm_messages" },
    } as never);

    expect(result).toEqual({
      satisfied: true,
      yieldReason: null,
      stats: { skipped: "legacy_ofapi_dm_messages_retired" },
    });
    expect(listChatMessages).not.toHaveBeenCalled();
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

    const result = await fanslyTopSpendersChunk(app, {
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

    const result = await fanslyTopSpendersChunk(app, {
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

    const result = await fanslyTopSpendersChunk(app, {
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

    const result = await fanslyTopSpendersChunk(app, {
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

    const result = await fanslyTopSpendersChunk(app, {
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

    await expect(fanslySubscribersChunk(app, {
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
        requestSeq: 5,
      },
      syncRunId: 100,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledTimes(1);
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
  });

  it("guards against destructive subscriber finalization on a partial non-empty first page", async () => {
    const telemetry = createTelemetry();
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
    };
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage: vi.fn(async () => ({
          total: 2,
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
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);

    await expect(fanslySubscribersChunk(app, {
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
        requestSeq: 5,
      },
      syncRunId: 100,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "subscribers_partial_page_guard",
      details: {
        providerReportedTotal: 2,
        observedCount: 1,
        pageCount: 1,
        mode: "active",
      },
    }));
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageSubscriptionsByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("promotes followers_reconcile when follower drift is detected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T01:00:00.000Z"));

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
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
          accounts: [{
            id: "fan-1",
            username: "fan_1",
            displayName: "Fan 1",
            createdAt: 1_770_000_000_000,
            lastSeenAt: 1_775_782_500_000,
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

    try {
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
          requestSeq: 3,
        },
        syncRunId: 101,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(),
      } as never);

      expect(result.satisfied).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, expect.any(Array));
      expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, expect.any(Array));
      expect(dbMocks.upsertFanPageExternalPresences).toHaveBeenCalledWith(tx, [{
        fanId: 91,
        platformAccountId: 12,
        externalPresenceAt: expect.any(Date),
        externalPresenceObservedAt: expect.any(Date),
        externalPresenceSource: "fansly_followers_last_seen",
      }]);
      expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 12, 1);
      expect(dbMocks.updatePageSyncTimestampCache).toHaveBeenCalledWith(tx, {
        pageId: 12,
        syncType: "followers",
      });
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
        platformAccountId: 12,
        stream: "followers",
      }));
      expect(dbMocks.countActivePageFollows).toHaveBeenCalledWith(db, 12);
      expect(dbMocks.requestPageSync).toHaveBeenCalledWith(db, {
        pageId: 12,
        streams: ["followers_reconcile"],
        source: "anomaly",
        includeQueueState: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

it("guards against empty first-page follower reconcile wipes when active followers already exist", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
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
        followCount: 5,
      },
    },
  });
  dbMocks.countActivePageFollows.mockResolvedValue(3);

  await expect(executeFollowersReconcileChunk(app, {
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
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never)).rejects.toThrow("refusing destructive finalization");

  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_empty_first_page_guard",
    details: {
      sourceFollowerCount: 5,
      existingActiveFollowers: 3,
    },
  }));
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
});

it("does not carry a restart marker into a newer follower revision", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1000",
          followerId: "fan-1",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 3,
      generation: 613,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

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
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: false,
    continuationRetryAt: expect.any(Date),
    stats: {
      snapshotRestartCount: 1,
      destructiveFinalization: false,
      finalizationWithheld: true,
    },
  });

  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_generation_guard",
    details: expect.objectContaining({
      sourceFollowerCount: 2,
      observedCount: 1,
      generationObservedCount: 1,
      pageCount: 1,
    }),
  }));
  expect(db.transaction).toHaveBeenCalledTimes(2);
  expect(dbMocks.upsertPageFollows).toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(expect.anything(), {
    platformAccountId: 13,
    stream: "followers_reconcile",
    state: {
      revision: 4,
      generation: 614,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
      verificationPending: false,
    },
  });
});

it("delays a second follower mismatch inside the same restart scope", async () => {
  const telemetry = createTelemetry();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback({})),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: {
      getFollowersPage: vi.fn(async () => ({
        items: [{
          id: "1000",
          followerId: "fan-1",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-1",
          username: "fan_1",
          displayName: "Fan 1",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 614,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      sourceFollowerCount: 2,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

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
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: false,
    continuationRetryAt: expect.any(Date),
    stats: {
      snapshotRestartCount: 2,
      destructiveFinalization: false,
      finalizationWithheld: true,
    },
  });

  expect(sharedMocks.refreshPageMetadata).toHaveBeenCalledTimes(1);
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    platformAccountId: 13,
    stream: "followers_reconcile",
    state: expect.objectContaining({ verificationPending: true }),
  }));
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.upsertCheckpointProgress).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      state: expect.objectContaining({ snapshotRestartCount: 2 }),
    }),
  );
});

it("closes follower reconcile non-destructively after two fresh retries", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const getFollowersPage = vi.fn();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: { getFollowersPage },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 615,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 2,
      snapshotRestartCount: 2,
      restartReason: "snapshot_mismatch",
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 2 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);

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
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      destructiveFinalization: false,
      finalizationWithheld: true,
      nonDestructiveClose: true,
    },
  });
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
  expect(dbMocks.updatePageSyncTimestampCache).not.toHaveBeenCalled();
  expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 2);
  expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
    state: expect.objectContaining({
      destructiveFinalization: false,
      membershipCertified: false,
    }),
    lastSuccessfulRunId: 102,
  }));
  expect(telemetry.addNote).toHaveBeenCalledWith(
    "Follower reconcile completed non-destructively after two fresh generations could not certify terminal membership",
    expect.objectContaining({ code: "followers_reconcile_nondestructive_close" }),
  );
});

it("finalizes follower reconcile against a freshly captured terminal headline", async () => {
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
        items: [{
          id: "1002",
          followerId: "fan-2",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-2",
          username: "fan_2",
          displayName: "Fan 2",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 3,
      snapshotRestartCount: 0,
      restartReason: null,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 92, platformUserId: "fan-2" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

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
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      sourceFollowerCount: 2,
      startingSourceFollowerCount: 3,
      generationObservedCount: 2,
    },
  });
  expect(sharedMocks.refreshPageMetadata).toHaveBeenCalledTimes(1);
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
  expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 2);
  expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
    state: expect.objectContaining({
      sourceFollowerCount: 2,
      snapshotRestartCount: 0,
    }),
  }));
  expect(telemetry.addNote).toHaveBeenCalledWith(
    "Follower headline changed during reconcile; terminal membership proof passed",
    {
      code: "followers_reconcile_terminal_headline_changed",
      startingSourceFollowerCount: 3,
      terminalSourceFollowerCount: 2,
      generationObservedCount: 2,
      pageCount: 2,
      membershipProof: "exact_generation",
    },
  );
  expect(telemetry.addAnomaly).not.toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_generation_guard",
  }));
  expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      requestParams: {
        offset: 100,
        limit: 100,
        mode: "reconcile",
        generation: 613,
        fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      },
    }),
    expect.anything(),
  );
});

it("resumes terminal follower verification without refetching the list and charges its request", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const getFollowersPage = vi.fn();
  const app = {
    db,
    config: {
      followerPageDelayMs: 0,
      syncSharedRateLimitEnabled: false,
    },
    adapter: { getFollowersPage },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 1,
      pageCount: 2,
      sourceFollowerCount: 1,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockImplementation(async (
    _app: unknown,
    _pageContext: unknown,
    _syncType: unknown,
    _telemetry: unknown,
    requestObserver: { onRequestEvent(event: unknown): Promise<void> } | null,
  ) => {
    await recordStartedRequest(requestObserver, "account_me");
    return { parsed: { account: { followCount: 1 } } };
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);
  const budget = new SyncChunkBudget(1);

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
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget,
  } as never);

  expect(result.satisfied).toBe(true);
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(budget.totalRequests).toBe(1);
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
});

it("certifies a terminal join only from a first-seen row outside the completed generation", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const getFollowersPage = vi.fn();
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
    adapter: { getFollowersPage },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 0,
      observedCount: 1,
      pageCount: 1,
      sourceFollowerCount: 1,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 2 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(1);
  dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
    firstSeenDuringSweepOutsideGeneration: 1,
    activeFollowerCount: 2,
    deactivationCandidateCount: 0,
  });

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
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      membershipProof: "new_followers_seen_during_sweep",
      destructiveFinalization: true,
    },
  });
  expect(getFollowersPage).not.toHaveBeenCalled();
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: new Date(FOLLOWER_SWEEP_STARTED_AT),
  });
});

it("blocks a certified follower wipe above the one-percent safety ceiling", async () => {
  const telemetry = createTelemetry();
  const tx = {};
  const db = {
    transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
  };
  const app = {
    db,
    config: { followerPageDelayMs: 0, syncSharedRateLimitEnabled: false },
    adapter: { getFollowersPage: vi.fn() },
  } as never;
  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 100,
      observedCount: 100,
      pageCount: 2,
      sourceFollowerCount: 100,
      snapshotRestartCount: 0,
      restartReason: null,
      verificationPending: true,
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: { account: { followCount: 100 } },
  });
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(100);
  dbMocks.readPageFollowReconcileActivity.mockResolvedValue({
    firstSeenDuringSweepOutsideGeneration: 0,
    activeFollowerCount: 1_000,
    deactivationCandidateCount: 51,
  });
  dbMocks.readPageFollowDeactivationGenerationBuckets.mockResolvedValue([
    { lastSeenGeneration: null, count: 40 },
    { lastSeenGeneration: 610, count: 11 },
  ]);

  await expect(executeFollowersReconcileChunk(app, {
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
    streamState: { requestSeq: 4 },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never)).rejects.toMatchObject({
    code: "followers_reconcile_deactivation_blast_radius",
    retryable: false,
  });

  expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_deactivation_blast_radius",
    details: expect.objectContaining({
      deactivationCandidateCount: 51,
      deactivationLimit: 50,
      candidateGenerationBuckets: [
        { lastSeenGeneration: null, count: 40 },
        { lastSeenGeneration: 610, count: 11 },
      ],
    }),
  }));
});

it("finalizes follower reconcile when offset drift duplicates raw rows but the unique generation is complete", async () => {
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
        items: [{
          id: "1002",
          followerId: "fan-2",
          lastSeenAt: 1_775_782_500_000,
        }],
        accounts: [{
          id: "fan-2",
          username: "fan_2",
          displayName: "Fan 2",
          createdAt: 1_770_000_000_000,
          lastSeenAt: 1_775_782_500_000,
        }],
        done: true,
        raw: {},
      })),
    },
  } as never;

  dbMocks.getCheckpoint.mockResolvedValue({
    state: {
      revision: 4,
      generation: 613,
      fullSweepStartedAt: FOLLOWER_SWEEP_STARTED_AT,
      offset: 7200,
      observedCount: 2,
      pageCount: 2,
      sourceFollowerCount: 2,
      snapshotRestartCount: 1,
      restartReason: "snapshot_mismatch",
    },
  });
  sharedMocks.refreshPageMetadata.mockResolvedValue({
    parsed: {
      account: {
        followCount: 2,
      },
    },
  });
  dbMocks.upsertFans.mockResolvedValue([{ id: 92, platformUserId: "fan-2" }]);
  dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

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
      requestSeq: 4,
    },
    syncRunId: 102,
    telemetry: telemetry as never,
    budget: new SyncChunkBudget(),
  } as never);

  expect(result).toMatchObject({
    satisfied: true,
    stats: {
      sourceFollowerCount: 2,
      generationObservedCount: 2,
    },
  });
  expect(dbMocks.countPageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
  });
  expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
    platformAccountId: 13,
    generation: 613,
    lastSeenBefore: expect.any(Date),
  });
  const completedCheckpoint = dbMocks.upsertCheckpoint.mock.calls.at(-1)?.[1];
  expect(completedCheckpoint?.state).toMatchObject({
    snapshotRestartCount: 0,
  });
  expect(completedCheckpoint?.state).not.toHaveProperty("restartReason");
  expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
    code: "followers_reconcile_offset_drift_tolerated",
    details: {
      sourceFollowerCount: 2,
      observedCount: 3,
      generationObservedCount: 2,
      pageCount: 3,
      membershipProof: "exact_generation",
    },
  }));
});

  it("hydrates incremental follower rows by fallback ID when aggregation accounts are missing", async () => {
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
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
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
          followCount: 1,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-1"],
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);
    dbMocks.countActivePageFollows.mockResolvedValue(1);

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
        requestSeq: 3,
      },
      syncRunId: 101,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-1"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: 12,
      accounts: [],
      fallbackIds: ["fan-1"],
    });
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        platformAccountId: 12,
        fanId: 91,
        platformFollowId: "1000",
      }),
    ]);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "followers_missing_aggregation_accounts",
      severity: "warn",
    }));
  });

  it("maps partially aggregated follower reconcile rows before generation finalization", async () => {
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
          items: [
            {
              id: "1002",
              followerId: "fan-1",
              lastSeenAt: 1_775_782_500_000,
            },
            {
              id: "1001",
              followerId: "fan-2",
              lastSeenAt: 1_775_782_400_000,
            },
          ],
          accounts: [{
            id: "fan-1",
            username: "fan_1",
            displayName: "Fan 1",
            createdAt: 1_770_000_000_000,
            lastSeenAt: 1_775_782_500_000,
          }],
          done: true,
          raw: {},
        })),
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: {
        account: {
          followCount: 2,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-2"],
    });
    dbMocks.upsertFans.mockResolvedValue([
      { id: 91, platformUserId: "fan-1" },
      { id: 92, platformUserId: "fan-2" },
    ]);
    dbMocks.countPageFollowsByGeneration.mockResolvedValue(2);

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
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(fanHydrationMocks.lookupHydratedFans).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformUserIds: ["fan-2"],
    }));
    expect(fanHydrationMocks.upsertHydratedFansForPage).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      accounts: [expect.objectContaining({ id: "fan-1" })],
      fallbackIds: ["fan-2"],
    });
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        fanId: 91,
        platformFollowId: "1002",
        lastSeenGeneration: 1,
      }),
      expect.objectContaining({
        fanId: 92,
        platformFollowId: "1001",
        lastSeenGeneration: 1,
      }),
    ]);
    expect(dbMocks.upsertPageFollows.mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.deactivatePageFollowsByGeneration.mock.invocationCallOrder[0],
    );
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      generation: 1,
      lastSeenBefore: expect.any(Date),
    });
  });

  it("blocks follower reconcile finalization when fallback hydration still leaves source rows unmapped", async () => {
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
          items: [{
            id: "1000",
            followerId: "fan-1",
            lastSeenAt: 1_775_782_500_000,
          }],
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
          followCount: 1,
        },
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [],
      fallbackIds: ["fan-1"],
    });
    fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValueOnce(new Map());

    await expect(executeFollowersReconcileChunk(app, {
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
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never)).rejects.toThrow("refusing destructive finalization");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "followers_unmapped_source_rows",
      severity: "error",
      details: expect.objectContaining({
        stream: "followers_reconcile",
        unmappedFollowerCount: 1,
      }),
    }));
    expect(dbMocks.upsertPageFollows).not.toHaveBeenCalled();
    expect(dbMocks.deactivatePageFollowsByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.refreshFanPageFollowerState).not.toHaveBeenCalled();
    expect(dbMocks.rebuildFollowerRollups).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
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
        requestSeq: 4,
      },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertPageFollows).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.upsertFanPages).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.upsertFanPageExternalPresences).toHaveBeenCalledWith(tx, []);
    expect(dbMocks.deactivatePageFollowsByGeneration).toHaveBeenCalledWith(tx, {
      platformAccountId: 13,
      generation: 1,
      lastSeenBefore: expect.any(Date),
    });
    expect(dbMocks.refreshFanPageFollowerState).toHaveBeenCalledWith(tx, 13);
    expect(dbMocks.rebuildFollowerRollups).toHaveBeenCalledWith(tx, 13, 0);
    expect(dbMocks.updatePageSyncTimestampCache).toHaveBeenCalledWith(tx, {
      pageId: 13,
      syncType: "followers",
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 13,
      stream: "followers_reconcile",
    }));
  });

  it("starts the first follower generation at one when checkpoint and projection are empty", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.maxPageFollowGeneration.mockResolvedValue(0);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: { account: { followCount: 0 } },
    });

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
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 1 } });
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "followers_reconcile",
      state: expect.objectContaining({ generation: 1 }),
    });
  });

  it("starts a fresh follower generation above the persisted row high-water", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: {
        followerPageDelayMs: 0,
        syncSharedRateLimitEnabled: false,
      },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({ state: { revision: 3, generation: 613 } });
    dbMocks.maxPageFollowGeneration.mockResolvedValue(861);
    sharedMocks.refreshPageMetadata.mockResolvedValue({
      parsed: { account: { followCount: 9_307 } },
    });

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
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 862 } });
    expect(dbMocks.maxPageFollowGeneration).toHaveBeenCalledWith(db, 13);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "followers_reconcile",
      state: expect.objectContaining({ generation: 862 }),
    });
  });

  it("keeps a newer subscriber checkpoint generation above a lower row high-water", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: false },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({ state: { revision: 3, generation: 900 } });
    dbMocks.maxPageSubscriptionGeneration.mockResolvedValue(861);

    const result = await fanslySubscribersChunk(app, {
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
      streamState: { requestSeq: 4 },
      syncRunId: 102,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 901 } });
    expect(dbMocks.maxPageSubscriptionGeneration).toHaveBeenCalledWith(db, 13);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 13,
      stream: "subscribers",
      state: expect.objectContaining({ generation: 901 }),
    });
  });

  it("finalizes subscribers inside one transaction on completed pages", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const getSubscribersPage = vi.fn(async () => ({
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
    }));
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        revision: 5,
        generation: 0,
        historyBackfilledAt: "2026-07-01T00:00:00.000Z",
      },
    });
    fanHydrationMocks.lookupHydratedFans.mockResolvedValue({
      accounts: [{
        id: "fan-1",
        username: "fan_1",
        displayName: "Fan 1",
        createdAt: 1_770_000_000_000,
      }],
      fallbackIds: [],
    });
    dbMocks.upsertFans.mockResolvedValue([{ id: 91, platformUserId: "fan-1" }]);

    const result = await fanslySubscribersChunk(app, {
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
        requestSeq: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(getSubscribersPage).toHaveBeenCalledWith(
      expect.any(Object),
      { limit: 100, offset: 0, status: "3,4" },
    );
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(dbMocks.upsertArchivedPageSubscriptions).not.toHaveBeenCalled();
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

  it("finalizes active subscribers before a one-time archive-only expired backfill", async () => {
    const telemetry = createTelemetry();
    const tx = {};
    const db = {
      transaction: vi.fn(async (callback: (dbTx: object) => Promise<unknown>) => callback(tx)),
    };
    const activeSubscription = {
      id: "sub-active",
      subscriberId: "fan-active",
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
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: null,
      endsAt: "2026-04-09T00:00:00.000Z",
    };
    const expiredSubscription = {
      ...activeSubscription,
      id: "sub-expired",
      subscriberId: "fan-expired",
      status: 5,
      autoRenew: 0,
      endsAt: "2026-02-01T00:00:00.000Z",
    };
    const getSubscribersPage = vi.fn(async (
      _context: unknown,
      params: { status: string },
    ) => ({
      total: 1,
      items: [params.status === "3,4" ? activeSubscription : expiredSubscription],
      done: true,
      raw: {},
    }));
    const app = {
      db,
      config: {
        syncSharedRateLimitEnabled: false,
      },
      adapter: {
        getSubscribersPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.upsertFans
      .mockResolvedValueOnce([{ id: 91, platformUserId: "fan-active" }])
      .mockResolvedValueOnce([{ id: 92, platformUserId: "fan-expired" }]);

    const result = await fanslySubscribersChunk(app, {
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
        requestSeq: 6,
      },
      syncRunId: 103,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 1,
        mode: "expired",
        processedThisChunk: 2,
      },
    });
    expect(getSubscribersPage.mock.calls.map(([, params]) => params.status)).toEqual([
      "3,4",
      "5",
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertPageSubscriptions).toHaveBeenCalledTimes(1);
    expect(dbMocks.upsertArchivedPageSubscriptions).toHaveBeenCalledTimes(1);
    expect(
      dbMocks.deactivatePageSubscriptionsByGeneration.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dbMocks.upsertArchivedPageSubscriptions.mock.invocationCallOrder[0]!,
    );
    const fanPageInputs = dbMocks.upsertFanPages.mock.calls.flatMap((call) => call[1]);
    expect(fanPageInputs).toContainEqual(expect.objectContaining({
      fanId: 91,
      isSubscriber: true,
    }));
    expect(fanPageInputs).not.toContainEqual(expect.objectContaining({
      fanId: 92,
      isSubscriber: true,
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(tx, expect.objectContaining({
      platformAccountId: 14,
      stream: "subscribers",
      state: expect.objectContaining({
        mode: "expired",
        observedCount: 1,
        historyBackfilledAt: expect.any(String),
      }),
    }));
  });

  it("records OnlyFans transaction pulls as skips (webhook-sourced since Stage 18)", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
    } as never;

    const result = await onlyfansTransactionsChunk(app, {
      pageContext: {
        platform: "onlyfans",
        page: {
          id: 99,
          label: "onlyfans-page",
          platformAccountId: "of-99",
          metadata: {},
          commissionRate: 0.2,
        },
        auth: { token: "" },
        proxy: null,
      },
      streamState: {
        requestSeq: 7,
        requestPayload: null,
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    // The stream completes without egress: OF transaction truth arrives via
    // the Stage 13 webhook writer gate, never a pull walker.
    expect(result.satisfied).toBe(true);
    expect(result.yieldReason).toBe(null);
    expect(result.stats).toMatchObject({ skipped: "onlyfans_transactions_webhook_sourced" });
  });

  it("passes the active lease to Fansly transaction syncs for mid-run progress updates", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
    } as never;
    transactionMocks.syncTransactions.mockResolvedValue({
      satisfied: true,
      yieldReason: null,
      processed: 2,
      processedTransactions: 2,
      newestSeenAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    const result = await fanslyTransactionsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 77,
          label: "fansly-page",
          commissionRate: 0.2,
        },
        session: { authorization: "secret" },
        proxy: null,
      },
      streamState: {
        requestSeq: 7,
        leasedSeq: 7,
        leaseToken: "lease-token",
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(transactionMocks.syncTransactions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      activeLease: {
        requestSeq: 7,
        leaseToken: "lease-token",
      },
    }));
    expect(result.satisfied).toBe(true);
  });

  it("propagates yielded Fansly transaction chunks", async () => {
    const telemetry = createTelemetry();
    const app = {
      db: {},
      config: {
        syncSharedRateLimitEnabled: false,
      },
    } as never;
    transactionMocks.syncTransactions.mockResolvedValue({
      satisfied: false,
      yieldReason: "request_budget",
      processed: 1,
      processedTransactions: 1,
      newestSeenAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    const result = await fanslyTransactionsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: {
          id: 77,
          label: "fansly-page",
          commissionRate: 0.2,
        },
        session: { authorization: "secret" },
        proxy: null,
      },
      streamState: {
        requestSeq: 7,
        leasedSeq: 7,
        leaseToken: "lease-token",
      },
      syncRunId: 200,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(),
    } as never);

    expect(transactionMocks.syncTransactions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      budget: expect.any(SyncChunkBudget),
    }));
    expect(result.satisfied).toBe(false);
    expect(result.yieldReason).toBe("request_budget");
  });

  it("captures then restarts a legacy dm_conversations sweep that has no unique-id snapshot", async () => {
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

    await expect(fanslyDmConversationsChunk(app, {
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
        requestSeq: 42,
      },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never)).rejects.toThrow("legacy sweep without its unique-id snapshot");

    expect(getMessagingGroupsPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      offset: 100,
      limit: 100,
    }));
    expect(sharedMocks.persistRawPayload).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_legacy_snapshot_restart",
      severity: "error",
      details: expect.objectContaining({
        providerReportedTotal: 200,
        pageCount: 2,
        offset: 100,
        abandonedGeneration: 7,
        restartGeneration: 8,
      }),
    }));
    expect(dbMocks.listPageDmConversationsByPlatformConversationIds).not.toHaveBeenCalled();
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.maxPageDmThreadGeneration).toHaveBeenCalledWith(db, 55);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      stream: "dm_conversations",
      state: expect.objectContaining({
        version: 2,
        generation: 8,
        offset: 0,
        observedCount: 0,
        providerReportedTotal: null,
      }),
    });
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).not.toHaveProperty(
      "snapshotConversationIds",
    );
  });

  it("rejects a dm_conversations page when provider total drifts during a sweep", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (
      requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    ) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
      return {
        total: 199,
        items: [],
        accounts: [],
        groups: [],
        offset: 100,
        raw: {
          data: [],
          aggregationData: {
            total: 199,
            accounts: [],
            groups: [],
          },
        },
        done: false,
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
        observedCount: 100,
        pageCount: 1,
        providerReportedTotal: 200,
        snapshotConversationIds: Array.from({ length: 100 }, (_, index) => `group-${index}`),
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    await expect(fanslyDmConversationsChunk(app, {
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
        requestSeq: 42,
      },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never)).rejects.toThrow("provider total presence or value changed during the sweep");

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_provider_total_drift_guard",
      severity: "error",
      details: expect.objectContaining({
        providerReportedTotal: 200,
        currentProviderReportedTotal: 199,
        observedCount: 100,
        pageCount: 2,
        offset: 100,
        abandonedGeneration: 7,
        restartGeneration: 8,
      }),
    }));
    expect(dbMocks.listPageDmConversationsByPlatformConversationIds).not.toHaveBeenCalled();
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, expect.objectContaining({
      state: expect.objectContaining({
        version: 2,
        generation: 8,
        offset: 0,
        observedCount: 0,
        providerReportedTotal: null,
      }),
    }));
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an invalid present provider total",
      providerReportedTotal: null,
      observedCount: 0,
      page: { total: -1, items: [], done: true },
      anomalyCode: "dm_conversations_provider_total_invalid",
    },
    {
      name: "a provider total disappearing after a present page",
      providerReportedTotal: 2,
      observedCount: 1,
      page: { total: undefined, items: [], done: true },
      anomalyCode: "dm_conversations_provider_total_drift_guard",
    },
    {
      name: "a provider total appearing after an absent page",
      providerReportedTotal: null,
      observedCount: 1,
      page: { total: 2, items: [], done: true },
      anomalyCode: "dm_conversations_provider_total_drift_guard",
    },
    {
      name: "a terminal unique-id count below provider total",
      providerReportedTotal: 2,
      observedCount: 1,
      page: { total: 2, items: [], done: true },
      anomalyCode: "dm_conversations_partial_page_guard",
    },
  ])("captures and restarts dm_conversations on $name", async ({
    providerReportedTotal,
    observedCount,
    page,
    anomalyCode,
  }) => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      ...page,
      accounts: [],
      groups: [],
      offset: 100,
      raw: {
        data: page.items,
        aggregationData: {
          ...(page.total === undefined ? {} : { total: page.total }),
          accounts: [],
          groups: [],
        },
      },
    }));
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: true },
      adapter: { getMessagingGroupsPage },
    } as never;
    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 2,
        mode: "full_scan",
        generation: 7,
        offset: 100,
        observedCount,
        pageCount: 1,
        providerReportedTotal,
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    await expect(fanslyDmConversationsChunk(app, {
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
      streamState: { requestSeq: 42 },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never)).rejects.toThrow("restarted the DM conversation sweep");

    expect(sharedMocks.persistRawPayload).toHaveBeenCalledTimes(1);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: anomalyCode,
      severity: "error",
    }));
    // The page was captured and then dropped BEFORE any of the work it would
    // have cost: no conversation read, no hydration, no thread write, no
    // invisibility pass, no completed checkpoint. These guards decide from the
    // response alone, so they must not spend a single further Fansly request.
    expect(dbMocks.listPageDmConversationsByPlatformConversationIds).not.toHaveBeenCalled();
    expect(fanHydrationMocks.upsertHydratedFansForPage).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, expect.objectContaining({
      state: expect.objectContaining({
        version: 2,
        generation: 8,
        offset: 0,
        observedCount: 0,
        providerReportedTotal: null,
      }),
    }));
  });

  it("captures and restarts dm_conversations when a row already carries this sweep's generation", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (
      requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    ) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
      return {
        total: 2,
        items: [{ groupId: "group-overlap", flags: 0, unreadCount: 0, partnerAccountId: "fan-1" }],
        accounts: [],
        groups: [],
        offset: 100,
        done: true,
        raw: { data: [], aggregationData: { total: 2, accounts: [], groups: [] } },
      };
    });
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: true },
      adapter: { getMessagingGroupsPage },
    } as never;
    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 2,
        mode: "full_scan",
        generation: 7,
        offset: 100,
        observedCount: 1,
        pageCount: 1,
        providerReportedTotal: 2,
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });
    // The row-side stamp is the overlap evidence the cumulative array used to
    // hold: this id was applied by an earlier offset page of THIS sweep.
    dbMocks.listPageDmThreadIdsStampedWithGeneration.mockResolvedValue(["group-overlap"]);

    await expect(fanslyDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: { id: 55, label: "dm-page", platformAccountId: "acct-dm", metadata: {} },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: { requestSeq: 42 },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never)).rejects.toThrow("restarted the DM conversation sweep");

    expect(dbMocks.listPageDmThreadIdsStampedWithGeneration).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      generation: 7,
      platformConversationIds: ["group-overlap"],
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_snapshot_overlap_guard",
      severity: "error",
      details: expect.objectContaining({
        overlappingConversationIds: ["group-overlap"],
        overlapCount: 1,
        duplicateIdsWithinPage: 0,
        observedCount: 1,
        pageCount: 2,
        offset: 100,
      }),
    }));
    // Read before the upserts and refused before any of them: the page is
    // captured, never applied.
    expect(fanHydrationMocks.upsertHydratedFansForPage).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
  });

  it("captures and restarts dm_conversations when one page repeats an id against itself", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (
      requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    ) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
      return {
        total: 2,
        items: [
          { groupId: "group-twice", flags: 0, unreadCount: 0, partnerAccountId: "fan-1" },
          { groupId: "group-twice", flags: 0, unreadCount: 0, partnerAccountId: "fan-1" },
        ],
        accounts: [],
        groups: [],
        offset: 0,
        done: true,
        raw: { data: [], aggregationData: { total: 2, accounts: [], groups: [] } },
      };
    });
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: true },
      adapter: { getMessagingGroupsPage },
    } as never;
    dbMocks.getCheckpoint.mockResolvedValue(null);

    await expect(fanslyDmConversationsChunk(app, {
      pageContext: {
        platform: "fansly",
        page: { id: 55, label: "dm-page", platformAccountId: "acct-dm", metadata: {} },
        session: { authorization: "token" },
        proxy: null,
      },
      streamState: { requestSeq: 42 },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never)).rejects.toThrow("restarted the DM conversation sweep");

    // No stored state can see this one — it is the in-memory half of the
    // guard, and it fires from the response alone, before the page costs
    // anything else.
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_snapshot_overlap_guard",
      details: expect.objectContaining({
        duplicateIdsWithinPage: 1,
        overlapCount: 0,
      }),
    }));
    expect(dbMocks.listPageDmThreadIdsStampedWithGeneration).not.toHaveBeenCalled();
    expect(dbMocks.listPageDmConversationsByPlatformConversationIds).not.toHaveBeenCalled();
    expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
  });

  it("completes a consistently total-less dm_conversations sweep non-destructively", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: null,
      items: [],
      accounts: [],
      groups: [],
      offset: 100,
      raw: {
        data: [],
        aggregationData: {
          total: null,
          accounts: [],
          groups: [],
        },
      },
      done: true,
    }));
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: true },
      adapter: { getMessagingGroupsPage },
    } as never;
    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        mode: "full_scan",
        generation: 7,
        offset: 100,
        observedCount: 1,
        snapshotConversationIds: ["group-seen"],
        pageCount: 1,
        providerReportedTotal: null,
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });
    stubGenerationSetCount(1);

    const result = await fanslyDmConversationsChunk(app, {
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
      streamState: { requestSeq: 42 },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        observedCount: 1,
        providerTotalMode: "absent",
        providerReportedTotal: null,
        destructiveFinalization: false,
        fullSweepCompleted: true,
      },
    });
    expect(sharedMocks.persistRawPayload).toHaveBeenCalledTimes(1);
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(db, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_conversations",
      lastSuccessfulRunId: 900,
      state: expect.objectContaining({
        providerTotalMode: "absent",
        providerReportedTotal: null,
        destructiveFinalization: false,
      }),
    }));
    expect(telemetry.addNote).toHaveBeenCalledWith(
      "DM conversation sweep completed without a provider total; unseen conversations remain visible",
      {
        code: "dm_conversations_provider_total_absent_nondestructive",
        observedCount: 1,
        pageCount: 2,
        providerTotalMode: "absent",
      },
    );
  });

  it("resumes a v1 checkpoint by adopting its id array's length as the observed count", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async (
      requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    ) => {
      await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
      return {
        total: 100,
        items: [],
        accounts: [],
        groups: [],
        offset: 100,
        raw: {
          data: [],
          aggregationData: {
            total: 100,
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
        providerReportedTotal: 100,
        snapshotConversationIds: Array.from({ length: 100 }, (_, index) => `group-${index}`),
        unchangedPageStreak: 0,
        fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });
    stubGenerationSetCount(100);

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 42,
      },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 7,
        observedCount: 100,
        providerReportedTotal: 100,
        fullSweepCompleted: true,
      },
    });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(dbMocks.markPageDmConversationsInvisibleByGeneration).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      generation: 7,
    });
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith(db, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_conversations",
      lastSuccessfulRunId: 900,
      state: expect.objectContaining({
        version: 2,
        generation: 7,
        // Migrated from the v1 array's length — nothing else in the stored
        // state said 100.
        observedCount: 100,
        generationSetCount: 100,
        membershipCertified: true,
        providerReportedTotal: 100,
        lastFullSweepCompletedAt: expect.any(String),
      }),
    }));
    expect(dbMocks.upsertCheckpoint.mock.calls.at(-1)?.[1]?.state).not.toHaveProperty(
      "snapshotConversationIds",
    );
    expect(dbMocks.upsertCheckpoint.mock.calls.at(-1)?.[1]?.state).not.toHaveProperty(
      "erasureDelta",
    );
    expect(dbMocks.maxPageDmThreadGeneration).not.toHaveBeenCalled();
  });

  describe("dm_conversations generation membership (G3)", () => {
    const RESUMED_OBSERVED_COUNT = 4;

    function terminalPageApp() {
      const getMessagingGroupsPage = vi.fn(async () => ({
        total: 4,
        items: [],
        accounts: [],
        groups: [],
        offset: 100,
        raw: { data: [], aggregationData: { total: 4, accounts: [], groups: [] } },
        done: true,
      }));
      const db = {};
      return {
        db,
        app: {
          db,
          config: { syncSharedRateLimitEnabled: true },
          adapter: { getMessagingGroupsPage },
        } as never,
      };
    }

    function seedResumedSweepCheckpoint() {
      dbMocks.getCheckpoint.mockResolvedValue({
        state: {
          version: 2,
          mode: "full_scan",
          generation: 7,
          offset: 100,
          observedCount: RESUMED_OBSERVED_COUNT,
          pageCount: 1,
          providerReportedTotal: 4,
          unchangedPageStreak: 0,
          fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
          lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
        },
      });
    }

    function chunkInput(telemetry: ReturnType<typeof createTelemetry>, maxRequests = 1) {
      return {
        pageContext: {
          platform: "fansly",
          page: { id: 55, label: "dm-page", platformAccountId: "acct-dm", metadata: {} },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: { requestSeq: 42 },
        syncRunId: 900,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(maxRequests),
      } as never;
    }

    it("withholds the destructive finalization when the generation set is short a stamped thread", async () => {
      const telemetry = createTelemetry();
      const { db, app } = terminalPageApp();
      seedResumedSweepCheckpoint();
      // One of the four threads never got stamped at generation 7 — the exact
      // regression the monotonic guard exists to prevent, seen from outside.
      stubGenerationSetCount(3);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      // Not a success and not a full sweep: the walk finished, the
      // certification did not.
      expect(result).toMatchObject({
        satisfied: false,
        continuationRequestSource: "scheduled",
        stats: {
          fullSweepCompleted: false,
          finalizationWithheld: true,
          membershipCertified: false,
          observedCount: 4,
          generationSetCount: 3,
        },
      });
      // Throttled, not hot-looped: the retry re-walks the whole page.
      expect(result.continuationRetryAt).toBeInstanceOf(Date);
      expect(dbMocks.countPageDmThreadsByGeneration).toHaveBeenCalledWith(db, {
        platformAccountId: 55,
        generation: 7,
      });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith({
        code: "dm_conversations_generation_membership_guard",
        severity: "error",
        message:
          "DM conversation sweep generation set did not reproduce its observed count; refusing destructive finalization",
        details: {
          generation: 7,
          pageCount: 2,
          observedCount: 4,
          generationSetCount: 3,
          providerTotalMode: "present",
          providerReportedTotal: 4,
          finalizationWithheld: true,
        },
      });
      // THE point of G3: no thread is hidden on an uncertified membership
      // record, and the run does not claim a completed full sweep.
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).toMatchObject({
        membershipCertified: false,
        destructiveFinalization: false,
        generationSetCount: 3,
        observedCount: 4,
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      });
    });

    it("still withholds on an erasure-explained shortfall, and reports it calmly", async () => {
      const telemetry = createTelemetry();
      const { db, app } = terminalPageApp();
      seedResumedSweepCheckpoint();
      stubGenerationSetCount(3);
      dbMocks.findErasureLogTouchingPageSince.mockResolvedValue({
        id: 12,
        scopeType: "fan",
        scopeRef: "fan-9",
        startedAt: new Date("2026-03-10T04:00:00.000Z"),
        completedAt: new Date("2026-03-10T04:00:05.000Z"),
      });

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      expect(dbMocks.findErasureLogTouchingPageSince).toHaveBeenCalledWith(db, {
        pageId: 55,
        since: new Date("2026-03-10T00:00:00.000Z"),
      });
      // The erasure log proves only that SOME erasure touched the page — never
      // that it deleted these particular rows. It buys a calm note, not
      // permission to hide a thread.
      expect(result).toMatchObject({
        satisfied: false,
        stats: { fullSweepCompleted: false, finalizationWithheld: true, membershipCertified: false },
      });
      expect(telemetry.addAnomaly).not.toHaveBeenCalled();
      expect(telemetry.addNote).toHaveBeenCalledWith(
        "DM conversation sweep generation set trails its observed count by rows an erasure could have removed inside the sweep window; finalization withheld",
        {
          code: "dm_conversations_dual_proof_erasure_delta",
          generation: 7,
          observedCount: 4,
          generationSetCount: 3,
          erasureDelta: 1,
          finalizationWithheld: true,
        },
      );
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).toMatchObject({
        membershipCertified: false,
        destructiveFinalization: false,
        generationSetCount: 3,
        erasureDelta: 1,
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      });
    });

    it("withholds a total-less sweep too, where nothing destructive was due", async () => {
      const telemetry = createTelemetry();
      const getMessagingGroupsPage = vi.fn(async () => ({
        total: null,
        items: [],
        accounts: [],
        groups: [],
        offset: 100,
        raw: { data: [], aggregationData: { total: null, accounts: [], groups: [] } },
        done: true,
      }));
      const db = {};
      const app = {
        db,
        config: { syncSharedRateLimitEnabled: true },
        adapter: { getMessagingGroupsPage },
      } as never;
      dbMocks.getCheckpoint.mockResolvedValue({
        state: {
          version: 2,
          mode: "full_scan",
          generation: 7,
          offset: 100,
          observedCount: 4,
          pageCount: 1,
          providerTotalMode: "absent",
          providerReportedTotal: null,
          unchangedPageStreak: 0,
          fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
          lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
        },
      });
      stubGenerationSetCount(3);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      // No provider total means no invisibility pass either way — but an
      // uncertified sweep still must not read as a completed one.
      expect(result).toMatchObject({
        satisfied: false,
        stats: {
          providerTotalMode: "absent",
          destructiveFinalization: false,
          membershipCertified: false,
          finalizationWithheld: true,
          fullSweepCompleted: false,
        },
      });
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).toMatchObject({
        membershipCertified: false,
        // Unchanged: the coverage UX is not told a full sweep landed.
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      });
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "dm_conversations_generation_membership_guard",
        details: expect.objectContaining({ providerTotalMode: "absent" }),
      }));
      // …and it does not also claim it "completed without a provider total".
      const noteCalls = telemetry.addNote.mock.calls as unknown as Array<
        [string, { code?: string } | undefined]
      >;
      expect(noteCalls.some((call) =>
        call[1]?.code === "dm_conversations_provider_total_absent_nondestructive"
      )).toBe(false);
    });

    it("never consults the erasure log when the generation set holds more rows than the sweep observed", async () => {
      const telemetry = createTelemetry();
      const { app } = terminalPageApp();
      seedResumedSweepCheckpoint();
      // A surplus cannot be explained by a deleter — only a shortfall can.
      stubGenerationSetCount(5);

      await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      expect(dbMocks.findErasureLogTouchingPageSince).not.toHaveBeenCalled();
      expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
        code: "dm_conversations_generation_membership_guard",
        details: expect.objectContaining({ observedCount: 4, generationSetCount: 5 }),
      }));
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
    });

    it("defers the chunk without writing when an erasure holds the page fence", async () => {
      const telemetry = createTelemetry();
      const { db, app } = terminalPageApp();
      seedResumedSweepCheckpoint();
      stubGenerationSetCount(4);
      dbMocks.tryAcquireDmArchiveWriterFenceLock.mockResolvedValue(false);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      expect(dbMocks.tryAcquireDmArchiveWriterFenceLock).toHaveBeenCalledWith(db, 55);
      expect(result).toMatchObject({
        satisfied: false,
        yieldReason: null,
        continuationRequestSource: "scheduled",
        stats: { erasureFenceDeferred: true, fullSweepCompleted: false, observedCount: 4 },
      });
      expect(result.continuationRetryAt).toBeInstanceOf(Date);
      // Deferred, not failed and not applied: nothing was read past the lock,
      // nothing was written, and the offset did not move.
      expect(dbMocks.listPageDmThreadIdsStampedWithGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress).not.toHaveBeenCalled();
      expect(telemetry.addAnomaly).not.toHaveBeenCalled();
      expect(telemetry.addNote).toHaveBeenCalledWith(
        "DM conversation sweep deferred a page while an erasure held the page fence",
        {
          code: "dm_conversations_erasure_fence_deferred",
          generation: 7,
          pageCount: 2,
          offset: 100,
        },
      );
    });

    it("latches the per-page divergence note to one per run", async () => {
      const telemetry = createTelemetry();
      const pages = [
        { groupId: "group-a", offset: 0 },
        { groupId: "group-b", offset: 100 },
      ];
      let call = 0;
      const getMessagingGroupsPage = vi.fn(async (
        requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
      ) => {
        await recordStartedRequest(requestContext.requestObserver, "dm_conversations");
        const current = pages[call]!;
        call += 1;
        return {
          total: 300,
          items: [{
            groupId: current.groupId,
            flags: 0,
            unreadCount: 0,
            partnerAccountId: "fan-1",
            lastMessageId: "msg-1",
          }],
          accounts: [],
          groups: [{
            id: current.groupId,
            users: [{ groupId: current.groupId, userId: "acct-dm" }, { groupId: current.groupId, userId: "fan-1" }],
            lastMessage: {
              id: "msg-1",
              senderId: "fan-1",
              content: "hi",
              createdAt: 1_773_000_000_000,
            },
          }],
          offset: current.offset,
          raw: { data: [], aggregationData: { total: 300, accounts: [], groups: [] } },
          done: false,
        };
      });
      const db = {};
      const app = {
        db,
        config: { syncSharedRateLimitEnabled: true },
        adapter: { getMessagingGroupsPage },
      } as never;
      dbMocks.getCheckpoint.mockResolvedValue(null);
      dbMocks.upsertPageDmConversation.mockResolvedValue(null);
      fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValue(new Map([["fan-1", 101]]));
      // The row-side set never catches up — both pages diverge, one note lands.
      stubGenerationSetCount(0);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry, 2));

      expect(result).toMatchObject({ satisfied: false });
      expect(getMessagingGroupsPage).toHaveBeenCalledTimes(2);
      expect(dbMocks.countPageDmThreadsByGeneration).toHaveBeenCalledTimes(2);
      const noteCalls = telemetry.addNote.mock.calls as unknown as Array<
        [string, { code?: string } | undefined]
      >;
      const divergenceNotes = noteCalls.filter(
        (call) => call[1]?.code === "dm_conversations_dual_proof_page_divergence",
      );
      expect(divergenceNotes).toHaveLength(1);
      expect(divergenceNotes[0]?.[1]).toMatchObject({
        generation: 1,
        pageCount: 1,
        observedCount: 1,
        generationSetCount: 0,
      });
      expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).toMatchObject({
        generationSetCount: 0,
        observedCount: 2,
      });
    });
  });

  // The dm_conversations twin of "guards against destructive subscriber
  // finalization on an empty first page" above: a sweep that observed nothing
  // may not read its own zero as proof of an empty inbox.
  describe("dm_conversations empty sweep guard", () => {
    function emptyPageApp() {
      const getMessagingGroupsPage = vi.fn(async () => ({
        total: 0,
        items: [],
        accounts: [],
        groups: [],
        offset: 0,
        raw: { data: [], aggregationData: { total: 0, accounts: [], groups: [] } },
        done: true,
      }));
      const db = {};
      return {
        db,
        getMessagingGroupsPage,
        app: {
          db,
          config: { syncSharedRateLimitEnabled: true },
          adapter: { getMessagingGroupsPage },
        } as never,
      };
    }

    function chunkInput(telemetry: ReturnType<typeof createTelemetry>) {
      return {
        pageContext: {
          platform: "fansly",
          page: { id: 55, label: "dm-page", platformAccountId: "acct-dm", metadata: {} },
          session: { authorization: "token" },
          proxy: null,
        },
        streamState: { requestSeq: 42 },
        syncRunId: 900,
        telemetry: telemetry as never,
        budget: new SyncChunkBudget(1),
      } as never;
    }

    it("withholds the finalization when an empty sweep would hide visible threads", async () => {
      const telemetry = createTelemetry();
      const { db, app } = emptyPageApp();
      dbMocks.getCheckpoint.mockResolvedValue(null);
      stubGenerationSetCount(0);
      // Three threads the destructive pass would have blanked on this answer.
      dbMocks.countPageDmVisibleThreadsBelowGeneration.mockResolvedValue(3);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      expect(dbMocks.countPageDmVisibleThreadsBelowGeneration).toHaveBeenCalledWith(db, {
        platformAccountId: 55,
        generation: 1,
      });
      expect(result).toMatchObject({
        satisfied: false,
        continuationRequestSource: "scheduled",
        stats: {
          observedCount: 0,
          generationSetCount: 0,
          membershipCertified: false,
          destructiveFinalization: false,
          finalizationWithheld: true,
          emptySweepGuard: true,
          fullSweepCompleted: false,
        },
      });
      expect(result.continuationRetryAt).toBeInstanceOf(Date);
      expect(telemetry.addAnomaly).toHaveBeenCalledWith({
        code: "dm_conversations_empty_sweep_guard",
        severity: "warn",
        message:
          "DM conversation sweep observed no conversations while the page still has visible threads; refusing destructive finalization",
        details: {
          generation: 1,
          pageCount: 1,
          observedCount: 0,
          generationSetCount: 0,
          visibleThreadCount: 3,
          providerTotalMode: "present",
          providerReportedTotal: 0,
          finalizationWithheld: true,
        },
      });
      // Not the membership guard: nothing was lost, nothing was listed.
      expect(telemetry.addNote).not.toHaveBeenCalled();
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
      expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).toMatchObject({
        membershipCertified: false,
        destructiveFinalization: false,
        observedCount: 0,
        generationSetCount: 0,
        lastFullSweepCompletedAt: null,
      });
    });

    it("certifies an empty sweep when no visible thread stands to be hidden", async () => {
      const telemetry = createTelemetry();
      const { app } = emptyPageApp();
      dbMocks.getCheckpoint.mockResolvedValue(null);
      stubGenerationSetCount(0);
      dbMocks.countPageDmVisibleThreadsBelowGeneration.mockResolvedValue(0);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      expect(result).toMatchObject({
        satisfied: true,
        stats: {
          observedCount: 0,
          membershipCertified: true,
          destructiveFinalization: true,
          finalizationWithheld: false,
          emptySweepGuard: false,
          fullSweepCompleted: true,
        },
      });
      expect(telemetry.addAnomaly).not.toHaveBeenCalled();
      expect(dbMocks.markPageDmConversationsInvisibleByGeneration).toHaveBeenCalled();
      expect(dbMocks.upsertCheckpoint).toHaveBeenCalled();
    });

    it("never asks the guard's question on a sweep that observed a conversation", async () => {
      const telemetry = createTelemetry();
      const getMessagingGroupsPage = vi.fn(async () => ({
        total: 1,
        items: [{
          groupId: "group-a",
          flags: 0,
          unreadCount: 0,
          partnerAccountId: "fan-1",
          lastMessageId: "msg-1",
        }],
        accounts: [],
        groups: [{
          id: "group-a",
          users: [{ groupId: "group-a", userId: "acct-dm" }, { groupId: "group-a", userId: "fan-1" }],
          lastMessage: { id: "msg-1", senderId: "fan-1", content: "hi", createdAt: 1_773_000_000_000 },
        }],
        offset: 0,
        raw: { data: [], aggregationData: { total: 1, accounts: [], groups: [] } },
        done: true,
      }));
      const db = {};
      const app = {
        db,
        config: { syncSharedRateLimitEnabled: true },
        adapter: { getMessagingGroupsPage },
      } as never;
      dbMocks.getCheckpoint.mockResolvedValue(null);
      dbMocks.upsertPageDmConversation.mockResolvedValue(null);
      fanHydrationMocks.upsertHydratedFansForPage.mockResolvedValue(new Map([["fan-1", 101]]));
      stubGenerationSetCount(1);

      const result = await fanslyDmConversationsChunk(app, chunkInput(telemetry));

      // A non-empty sweep pays for no extra count: the destructive pass is
      // bounded by what it actually observed.
      expect(dbMocks.countPageDmVisibleThreadsBelowGeneration).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        satisfied: true,
        stats: { observedCount: 1, membershipCertified: true, emptySweepGuard: false },
      });
    });
  });

  it("starts a fresh dm_conversations sweep above the persisted thread high-water", async () => {
    const telemetry = createTelemetry();
    const db = {};
    const app = {
      db,
      config: { syncSharedRateLimitEnabled: true },
      adapter: {},
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        generation: 17,
        lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
      },
    });
    dbMocks.maxPageDmThreadGeneration.mockResolvedValue(2_144);

    const result = await fanslyDmConversationsChunk(app, {
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
      streamState: { requestSeq: 42 },
      syncRunId: 900,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(0),
    } as never);

    expect(result).toMatchObject({ satisfied: false, stats: { generation: 2_145 } });
    expect(dbMocks.maxPageDmThreadGeneration).toHaveBeenCalledWith(db, 55);
    expect(dbMocks.upsertCheckpointProgress).toHaveBeenCalledWith(db, {
      platformAccountId: 55,
      stream: "dm_conversations",
      state: expect.objectContaining({ generation: 2_145 }),
    });
  });

  it("repairs an incomplete conversation head, captures its tips, and requests follow-up", async () => {
    const telemetry = createTelemetry();
    const headRepairRaw = {
      messages: [],
      tips: [{ id: "tip-head-repair", message: "captured from repair" }],
    };
    const getMessagesPage = vi.fn(async () => ({
      items: [{
        id: "msg-80",
        type: 1,
        dataVersion: 1,
        content: "repaired head",
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
      }],
      groupId: "group-1",
      before: null,
      done: true,
      raw: headRepairRaw,
    }));
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: 1,
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
          content: "new head",
          groupId: "group-1",
          senderId: null,
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
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    // One conversation on the page, one row stamped with the sweep's generation.
    stubGenerationSetCount(1);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([
      buildDmConversation({
        lastMessageId: "msg-79",
        lastUnreadMessageId: "msg-79",
        newestStoredMessageId: "msg-79",
        oldestStoredMessageId: "msg-55",
        storedMessageCount: 25,
        messageCoverageStatus: "complete",
        messageBackfillComplete: true,
        lastMessageSyncAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ]);
    dbMocks.upsertFans.mockResolvedValue([{ id: 101, platformUserId: "fan-1" }]);
    dbMocks.upsertPageDmConversation.mockImplementation(async (_db, input) => ({
      ...buildDmConversation(),
      ...input,
      id: 777,
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      isVisible: input.isVisible ?? true,
      messageCoverageStatus: input.messageCoverageStatus ?? "pending_backfill",
      metadata: input.metadata ?? {},
    }));

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 42,
      },
      syncRunId: 901,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(getMessagesPage).toHaveBeenCalledWith(expect.anything(), {
      groupId: "group-1",
      limit: 1,
    });
    expect(sharedMocks.persistRawPayload).toHaveBeenCalledWith(db, expect.objectContaining({
      endpoint: "dm_messages",
      requestParams: { groupId: "group-1", limit: 1, headRepair: true },
      responsePayload: headRepairRaw,
      payloadKind: "dm_messages",
    }), expect.objectContaining({
      action: "inserting dm_messages head-repair raw payload",
      platform: "fansly",
    }));
    expect(tipContextMocks.materializeFanslyDmTipContextsBestEffort).toHaveBeenCalledWith(
      app,
      {
        accountId: 55,
        requestParams: { groupId: "group-1", limit: 1, headRepair: true },
        responsePayload: headRepairRaw,
        sourceRawPayloadId: 444,
        capturedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    );
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(db, {
      pageId: 55,
      streams: ["dm_messages"],
      source: "scheduled",
    });
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
        totalTipAmount: 20000,
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

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 999,
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
    expect(tipContextMocks.materializeFanslyDmTipContextsBestEffort).toHaveBeenCalledWith(
      app,
      {
        accountId: 55,
        requestParams: { groupId: "group-1", limit: 25, before: "msg-65" },
        responsePayload: { messages: [] },
        sourceRawPayloadId: 444,
        capturedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    );
    expect(dbMocks.upsertPageDmMessages).toHaveBeenCalledWith({}, expect.arrayContaining([
      expect.objectContaining({
        conversationId: 777,
        platformMessageId: "msg-79",
        senderRole: "fan",
        totalTipAmountCents: 2000,
      }),
    ]));
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      conversationId: 777,
      messageCoverageStatus: "complete",
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

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 1,
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
        version: 2,
        offset: 100,
        // The count is the whole membership the mid-sweep checkpoint carries
        // now — the ids live on the rows it just stamped.
        observedCount: 1,
      }),
    }));
    expect(dbMocks.upsertCheckpointProgress.mock.calls.at(-1)?.[1]?.state).not.toHaveProperty(
      "snapshotConversationIds",
    );
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
    // One conversation on the page, one row stamped with the sweep's generation.
    stubGenerationSetCount(1);
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

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 904,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(1),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.upsertFans).toHaveBeenCalledWith(db, []);
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
    // One conversation on the page, one row stamped with the sweep's generation.
    stubGenerationSetCount(1);
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

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 1,
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
    // One conversation on the page, one row stamped with the sweep's generation.
    stubGenerationSetCount(1);
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

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 1,
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

  it("keeps the unresolvable exclusion marker when aggregation has a stale partner account", async () => {
    const telemetry = createTelemetry();
    const getMessagingGroupsPage = vi.fn(async () => ({
      total: 1,
      items: [{
        groupId: "group-stale-aggregation",
        partnerAccountId: "fan-stale-aggregation",
        partnerUsername: "fan_stale_aggregation",
        flags: 0,
        unreadCount: 2,
        subscriptionTierId: null,
        lastMessageId: "msg-80",
        lastUnreadMessageId: "msg-80",
      }],
      accounts: [{
        id: "fan-stale-aggregation",
        username: "fan_stale_aggregation",
        displayName: "Fan Stale Aggregation",
        createdAt: 1_770_000_000_000,
      }],
      groups: [{
        id: "group-stale-aggregation",
        users: [
          { groupId: "group-stale-aggregation", userId: "acct-dm", type: 1, permissionFlags: 0 },
          { groupId: "group-stale-aggregation", userId: "fan-stale-aggregation", type: 1, permissionFlags: 0 },
        ],
        lastMessage: {
          id: "msg-80",
          type: 1,
          dataVersion: 1,
          content: "stale aggregation account",
          groupId: "group-stale-aggregation",
          senderId: "fan-stale-aggregation",
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
      parsed: [],
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
    // One conversation on the page, one row stamped with the sweep's generation.
    stubGenerationSetCount(1);
    dbMocks.listPageDmConversationsByPlatformConversationIds.mockResolvedValue([buildDmConversation({
      id: 780,
      platformConversationId: "group-stale-aggregation",
      partnerPlatformUserId: "fan-stale-aggregation",
      partnerUsername: "fan_stale_aggregation",
      partnerDisplayName: "Fan Stale Aggregation",
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      },
    })]);
    dbMocks.upsertFans.mockResolvedValue([{ id: 101, platformUserId: "fan-stale-aggregation" }]);

    const result = await fanslyDmConversationsChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 9052,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(2),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(getAccountsByIdsPage).toHaveBeenCalledWith(expect.anything(), ["fan-stale-aggregation"]);
    expect(dbMocks.upsertPageDmConversation).toHaveBeenCalledWith(db, expect.objectContaining({
      platformConversationId: "group-stale-aggregation",
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
      },
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

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
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

  it("runs one live-first deep backfill page when normal dm_messages work is exhausted", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(context.requestObserver, "messages");
      return {
        items: [{
          id: "msg-24",
          type: 1,
          dataVersion: 1,
          content: "older spender context",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_769_999_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        }],
        groupId: "group-1",
        before: "msg-25",
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
        fanslyDmDeepBackfillEnabled: true,
        fanslyDmDeepBackfillMaxRequestsPerRun: 1,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mockResolvedValueOnce({
      ...buildDmMessageSyncCandidate({
        storedMessageCount: 25,
        newestStoredMessageId: "msg-80",
        retentionLimit: 500,
        isSpender: true,
      }),
    });
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 25,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-25",
      messageCoverageStatus: "partial_window",
    }));
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 26,
        newestStoredMessageId: "msg-80",
        oldestStoredMessageId: "msg-24",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 904,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(true);
    expect(dbMocks.selectNextPageDmMessageSyncCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(getMessagesPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: "group-1",
      before: "msg-25",
      limit: 25,
    }));
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({
      conversationId: 777,
      messageCoverageStatus: "partial_window",
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_messages",
      lastSuccessfulRunId: 904,
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
      },
    }));
    expect(result.stats).toMatchObject({
      currentMode: null,
      deepBackfillRequests: 1,
      deepBackfillPaused: true,
    });
  });

  it("gives deep backfill a quota slot when live dm_messages keeps producing work", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(context.requestObserver, "messages");
      return {
        items: [{
          id: "msg-24",
          type: 1,
          dataVersion: 1,
          content: "older quota context",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_769_999_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        }],
        groupId: "group-1",
        before: "msg-25",
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
        fanslyDmDeepBackfillEnabled: true,
        fanslyDmDeepBackfillMaxRequestsPerRun: 1,
        fanslyDmDeepBackfillLiveRequestsPerDeep: 4,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
        liveMessageRequestsSinceDeepBackfill: 4,
      },
    });
    dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mockResolvedValueOnce({
      ...buildDmMessageSyncCandidate({
        storedMessageCount: 25,
        newestStoredMessageId: "msg-80",
        retentionLimit: 500,
        isSpender: true,
      }),
    });
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 25,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-25",
      messageCoverageStatus: "partial_window",
    }));
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 26,
        newestStoredMessageId: "msg-80",
        oldestStoredMessageId: "msg-24",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 905,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(dbMocks.selectNextPageDmMessageDeepBackfillCandidate).toHaveBeenCalledTimes(1);
    expect(dbMocks.selectNextPageDmMessageSyncCandidate).not.toHaveBeenCalled();
    expect(getMessagesPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      groupId: "group-1",
      before: "msg-25",
      limit: 25,
    }));
    expect(dbMocks.upsertCheckpoint).toHaveBeenCalledWith({}, expect.objectContaining({
      platformAccountId: 55,
      stream: "dm_messages",
      lastSuccessfulRunId: 905,
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
      },
    }));
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        deepBackfillRequests: 1,
        deepBackfillPaused: true,
      },
    });
  });

  it("continues immediately after a quota deep backfill page even when idle deep pacing is configured", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(context.requestObserver, "messages");
      return {
        items: [{
          id: "msg-24",
          type: 1,
          dataVersion: 1,
          content: "older quota context",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_769_999_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        }],
        groupId: "group-1",
        before: "msg-25",
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
        fanslyDmDeepBackfillEnabled: true,
        fanslyDmDeepBackfillMaxRequestsPerRun: 1,
        fanslyDmDeepBackfillLiveRequestsPerDeep: 4,
        fanslyDmDeepBackfillContinuationDelayMs: 22_000,
        fanslyDmDeepBackfillContinuationJitterMs: 0,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue({
      state: {
        version: 1,
        currentConversationId: null,
        currentPlatformConversationId: null,
        currentBeforeMessageId: null,
        currentMode: null,
        liveMessageRequestsSinceDeepBackfill: 4,
      },
    });
    dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mockResolvedValueOnce({
      ...buildDmMessageSyncCandidate({
        storedMessageCount: 25,
        newestStoredMessageId: "msg-80",
        retentionLimit: 500,
        isSpender: true,
      }),
    });
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 25,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-25",
      messageCoverageStatus: "partial_window",
    }));
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 26,
        newestStoredMessageId: "msg-80",
        oldestStoredMessageId: "msg-24",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 906,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(false);
    expect(result.yieldReason).toBeNull();
    expect(result.continuationRetryAt).toBeNull();
    expect(result.continuationRequestSource).toBe("scheduled");
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(result.stats).toMatchObject({
      deepBackfillRequests: 1,
      deepBackfillPaused: true,
      deepBackfillSelectionReason: "quota",
      deepBackfillContinuationDelayMs: 0,
      deepBackfillContinuationRequestSource: "scheduled",
    });
  });

  it("paces deep backfill continuation when a continuation delay is configured", async () => {
    const telemetry = createTelemetry();
    const getMessagesPage = vi.fn(async (context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null }) => {
      await recordStartedRequest(context.requestObserver, "messages");
      return {
        items: [{
          id: "msg-24",
          type: 1,
          dataVersion: 1,
          content: "older spender context",
          groupId: "group-1",
          senderId: "fan-1",
          correlationId: null,
          inReplyTo: null,
          inReplyToRoot: null,
          createdAt: 1_769_999_000,
          attachments: [],
          embeds: [],
          interactions: [],
          likes: [],
          totalTipAmount: 0,
        }],
        groupId: "group-1",
        before: "msg-25",
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
        fanslyDmDeepBackfillEnabled: true,
        fanslyDmDeepBackfillMaxRequestsPerRun: 1,
        fanslyDmDeepBackfillContinuationDelayMs: 22_000,
        fanslyDmDeepBackfillContinuationJitterMs: 0,
      },
      adapter: {
        getMessagesPage,
      },
    } as never;

    dbMocks.getCheckpoint.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValue(null);
    dbMocks.selectNextPageDmMessageDeepBackfillCandidate.mockResolvedValueOnce({
      ...buildDmMessageSyncCandidate({
        storedMessageCount: 25,
        newestStoredMessageId: "msg-80",
        retentionLimit: 500,
        isSpender: true,
      }),
    });
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 25,
      newestStoredMessageId: "msg-80",
      oldestStoredMessageId: "msg-25",
      messageCoverageStatus: "partial_window",
    }));
    dbMocks.finalizePageDmConversationMessageSync.mockResolvedValue({
      conversation: {
        id: 777,
      },
      deletedCount: 0,
      summary: {
        storedMessageCount: 26,
        newestStoredMessageId: "msg-80",
        oldestStoredMessageId: "msg-24",
        lastFanMessageAt: new Date("2026-03-10T00:00:00.000Z"),
        lastModelMessageAt: null,
      },
    });

    const startedAt = Date.now();
    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
      },
      syncRunId: 904,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(5),
    } as never);

    expect(result.satisfied).toBe(false);
    expect(result.yieldReason).toBeNull();
    expect(result.continuationRequestSource).toBe("scheduled");
    expect(result.continuationRetryAt).toBeInstanceOf(Date);
    expect(result.continuationRetryAt?.getTime()).toBeGreaterThanOrEqual(startedAt + 22_000);
    expect(result.continuationRetryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 22_000);
    expect(dbMocks.upsertCheckpoint).not.toHaveBeenCalled();
    expect(result.stats).toMatchObject({
      currentMode: null,
      deepBackfillRequests: 1,
      deepBackfillPaused: true,
      deepBackfillContinuationDelayMs: 22_000,
      deepBackfillContinuationRequestSource: "scheduled",
    });
  });

  function headCatchupHarness(targetAtPage: number | null) {
    let checkpoint: Record<string, unknown> | null = null;
    let completedAttempt = false;
    dbMocks.getCheckpoint.mockImplementation(async () => checkpoint ? { state: checkpoint } : null);
    dbMocks.upsertCheckpointProgress.mockImplementation(async (_db, input) => {
      checkpoint = input.state;
      return {};
    });
    dbMocks.selectNextPageDmMessageSyncCandidate.mockResolvedValueOnce(buildDmMessageSyncCandidate());
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 100, newestStoredMessageId: "newer", messageCoverageStatus: "complete",
    }));
    dbMocks.getFanslyDmHeadTarget.mockImplementation(async () => ({
      messageId: "expected", captured: false, attempts: completedAttempt ? 1 : 0,
      lastAttemptAt: completedAttempt ? new Date() : null,
    }));
    dbMocks.recordFanslyDmHeadAttempt.mockImplementation(async () => { completedAttempt = true; });
    const getMessagesPage = vi.fn(async (context, _params: { before: string | null }) => {
      const n = getMessagesPage.mock.calls.length;
      await context.requestObserver.onRequestEvent({
        requestId: `head-${n}`, operation: "messages", endpointTemplate: "/message",
        method: "GET", attemptNumber: 1, timestamp: new Date(), state: "started",
      });
      return {
        items: [{ id: n === targetAtPage ? "expected" : `known-${n}`, senderId: "fan-1",
          createdAt: 1_770_000_000, content: "body" }],
        groupId: "group-1", before: null, done: false, raw: { messages: [] },
      };
    });
    dbMocks.getExistingPageDmMessageIds.mockImplementation(async (_db, input) => new Set(input.platformMessageIds));
    const app = { db: {}, config: { syncSharedRateLimitEnabled: true, fanslyDmHeadCatchupPageAllowlist: "dm-page" },
      adapter: { getMessagesPage } };
    const run = () => fanslyDmMessagesChunk(app as never, {
      pageContext: { platform: "fansly", page: { id: 55, label: "dm-page", platformAccountId: "acct-dm", metadata: {} },
        session: {}, proxy: null }, streamState: { requestSeq: 1 }, syncRunId: 905,
      telemetry: createTelemetry(), budget: new SyncChunkBudget(1),
    } as never);
    return { app, run, getMessagesPage, checkpoint: () => checkpoint };
  }

  it("resumes a missing-head walk past overlap and only confirms the exact target", async () => {
    const h = headCatchupHarness(2);
    await h.run();
    expect(h.checkpoint()).toMatchObject({ currentBeforeMessageId: "known-1", headCatchup: { messageId: "expected", pagesRead: 1 } });
    expect(dbMocks.recordFanslyDmHeadAttempt).not.toHaveBeenCalled();
    await h.run();
    expect(h.getMessagesPage.mock.calls.map((call) => call[1].before)).toEqual([null, "known-1"]);
    expect(dbMocks.recordFanslyDmHeadAttempt).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ messageId: "expected" }));
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
  });

  it("caps one missing-head attempt at five pages across chunk restarts", async () => {
    const h = headCatchupHarness(null);
    for (let i = 0; i < 5; i++) await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(5);
    expect(dbMocks.recordFanslyDmHeadAttempt).toHaveBeenCalledTimes(1);
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({ messageCoverageStatus: "complete" }));
  });

  it.each([1, null])("keeps incremental continuity beyond the target/cap (%s) until the old overlap", async (targetAtPage) => {
    const h = headCatchupHarness(targetAtPage);
    dbMocks.getExistingPageDmMessageIds.mockResolvedValue(new Set());
    for (let i = 0; i < 6; i++) await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(6);
    expect(h.checkpoint()).toMatchObject({ currentConversationId: 777, currentBeforeMessageId: "known-6" });
    expect(h.checkpoint()).not.toHaveProperty("headCatchup");
    expect(dbMocks.finalizePageDmConversationMessageSync).not.toHaveBeenCalled();
    dbMocks.getExistingPageDmMessageIds.mockImplementation(async (_db, input) => new Set(input.platformMessageIds));
    await h.run();
    expect(h.getMessagesPage.mock.calls.at(-1)?.[1].before).toBe("known-6");
    expect(dbMocks.recordFanslyDmHeadAttempt).toHaveBeenCalledTimes(1);
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
  });

  it("keeps the initial backfill window cap when a new thread head is captured", async () => {
    const h = headCatchupHarness(1);
    dbMocks.getPageDmConversationById.mockResolvedValue(buildDmConversation({
      storedMessageCount: 0, messageCoverageStatus: "pending_backfill",
    }));
    dbMocks.getExistingPageDmMessageIds.mockResolvedValue(new Set());
    h.getMessagesPage.mockImplementation(async (context) => {
      await context.requestObserver.onRequestEvent({
        requestId: "initial", operation: "messages", method: "GET", attemptNumber: 1,
        timestamp: new Date(), state: "started",
      });
      return { items: Array.from({ length: 25 }, (_, i) => ({
        id: i === 0 ? "expected" : `initial-${i}`, senderId: "fan-1", createdAt: 1_770_000_000, content: "body",
      })), groupId: "group-1", before: null, done: false, raw: { messages: [] } };
    });
    await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
    expect(dbMocks.finalizePageDmConversationMessageSync).toHaveBeenCalledWith({}, expect.objectContaining({ messageCoverageStatus: "partial_window" }));
  });

  it("disabling the page allowlist drops only the recovery pin before the next request", async () => {
    const h = headCatchupHarness(null);
    await h.run();
    h.app.config.fanslyDmHeadCatchupPageAllowlist = "none";
    await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordFanslyDmHeadAttempt).not.toHaveBeenCalled();
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
  });

  it("rollback preserves the unfinished baseline cursor while disabling extra target search", async () => {
    const h = headCatchupHarness(null);
    dbMocks.getExistingPageDmMessageIds.mockResolvedValue(new Set());
    await h.run();
    h.app.config.fanslyDmHeadCatchupPageAllowlist = "none";
    await h.run();
    expect(h.getMessagesPage.mock.calls[1]?.[1].before).toBe("known-1");
    expect(h.checkpoint()).toMatchObject({ currentConversationId: 777 });
    expect(h.checkpoint()).not.toHaveProperty("headCatchup");
    expect(dbMocks.recordFanslyDmHeadAttempt).not.toHaveBeenCalled();
  });

  it("an external target receipt preserves unfinished ordinary incremental history", async () => {
    const h = headCatchupHarness(null);
    dbMocks.getExistingPageDmMessageIds.mockResolvedValue(new Set());
    await h.run();
    dbMocks.getFanslyDmHeadTarget.mockResolvedValue({ messageId: "expected", captured: true, attempts: 0, lastAttemptAt: null });
    await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(h.getMessagesPage.mock.calls[1]?.[1].before).toBe("known-1");
    expect(h.checkpoint()).toMatchObject({ currentConversationId: 777, currentBeforeMessageId: "known-2" });
    expect(h.checkpoint()).not.toHaveProperty("headCatchup");
    expect(dbMocks.finalizePageDmConversationMessageSync).not.toHaveBeenCalled();
  });

  it("a persisted receipt prevents repeating a walk after a summary/checkpoint crash", async () => {
    const h = headCatchupHarness(null);
    await h.run();
    dbMocks.getFanslyDmHeadTarget.mockResolvedValue({ messageId: "expected", captured: false, attempts: 1, lastAttemptAt: new Date(Date.now() + 1000) });
    await h.run();
    expect(h.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(h.checkpoint()).toMatchObject({ currentConversationId: null });
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

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
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

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
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
    expect(dbMocks.excludePageDmConversationMessageSync).toHaveBeenCalledWith({}, {
      conversationId: 777,
      platformAccountId: 55,
      partnerPlatformUserId: "fan-missing",
      reason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
    });
    expect(dbMocks.upsertPageDmConversation).not.toHaveBeenCalled();
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

    await expect(fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
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

    const result = await fanslyDmMessagesChunk(app, {
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
        requestSeq: 1,
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
