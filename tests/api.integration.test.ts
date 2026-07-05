import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOnlyFansPage,
  createUser,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  setPageOfapiAccountId,
  findUserByUsername,
  finalizePageDmConversationMessageSync,
  finishSyncRequestAttempt,
  finishSyncRun,
  getNotificationIncidentByKey,
  insertSyncRequestAttempt,
  insertSyncRunEvent,
  insertAiUsageEvents,
  markPageSyncAuthBlocked,
  openNotificationIncident,
  recalculateFanPageSpend,
  rebuildFollowerRollups,
  rebuildRevenueRollups,
  rebuildSubscriberRollups,
  storeFanslySession,
  pageSyncCursors as pageSyncCursorRows,
  syncRateLimits,
  pageSyncStates as pageSyncStateRows,
  startSyncRun,
  updatePageMetadata,
  upsertFanPage,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertPageFollow,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import { PgBoss } from "pg-boss";
import {
  encryptJson,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  MOSCOW_TIME_ZONE,
  previousBusinessDate,
  resolveBusinessDateRange,
} from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { startSyncPageExecutor } from "../apps/runtime/src/services/sync/executor.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  createUserAccount,
  issueChatterApiKey,
  setUserPassword,
  unassignPageFromUser,
} from "../apps/runtime/src/services/auth.ts";
import { getModelRevenueReport, getPageRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { ensureSyncQueues, SYNC_PAGE_EXECUTE_QUEUE } from "../apps/runtime/src/services/sync-queue.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function seedPhase2Fixture(testDb: StartedTestDatabase) {
  const lanaModel = await createModel(testDb.db, {
    slug: "lana-model",
    name: "Lana Model",
  });
  const lilyModel = await createModel(testDb.db, {
    slug: "lily-model",
    name: "Lily Model",
  });
  const lanaPage = await createFanslyPage(testDb.db, {
    modelId: lanaModel.id,
    label: "lana",
  });
  const lilyPage = await createFanslyPage(testDb.db, {
    modelId: lilyModel.id,
    label: "lily1",
  });
  await storeFanslySession(testDb.db, lanaPage.id, "encrypted-lana-session", 1);
  await storeFanslySession(testDb.db, lilyPage.id, "encrypted-lily-session", 1);

  await updatePageMetadata(testDb.db, lanaPage.id, {
    platformAccountIdValue: "acct-lana",
    username: "lana_page",
    displayName: "Lana",
    followerCount: 1,
    subscriberCount: 1,
    earningsBalanceMills: 7000n,
    metadata: {},
    syncType: "light",
  });
  await updatePageMetadata(testDb.db, lilyPage.id, {
    platformAccountIdValue: "acct-lily",
    username: "lily_page",
    displayName: "Lily",
    followerCount: 0,
    subscriberCount: 0,
    earningsBalanceMills: 3000n,
    metadata: {},
    syncType: "light",
  });

  const [fan] = await upsertFans(testDb.db, [{
    platform: "fansly",
    platformUserId: "fan-001",
    username: "buyer",
    displayName: "Buyer One",
  }]);

  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lanaPage.id,
    isFollower: true,
    followerSince: new Date("2026-03-02T12:00:00.000Z"),
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-20T12:00:00.000Z"),
    autoRenew: true,
  });
  await upsertFanPage(testDb.db, {
    fanId: fan.id,
    platformAccountId: lilyPage.id,
    isFollower: false,
    isSubscriber: false,
  });

  await upsertPageFollow(testDb.db, {
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    platformFollowId: "follow-lana-1",
    followedAt: new Date("2026-03-02T12:00:00.000Z"),
  });
  await upsertPageSubscription(testDb.db, {
    platformSubscriptionId: "sub-lana-1",
    platformAccountId: lanaPage.id,
    fanId: fan.id,
    rawStatus: 3,
    canonicalStatus: "active",
    priceMills: 5000n,
    renewPriceMills: 5000n,
    autoRenew: true,
    sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
    endsAt: new Date("2026-03-20T12:00:00.000Z"),
  });

  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-subscription",
    rawType: 15001,
    canonicalType: "subscription",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 5000n,
    sourceDestinationAmountMills: 5000n,
    creatorNetAmountMills: 5000n,
    occurredAt: new Date("2026-03-05T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "pending",
    rawStatus: 1,
    grossAmountMills: 2000n,
    sourceDestinationAmountMills: 2000n,
    creatorNetAmountMills: 2000n,
    occurredAt: new Date("2026-03-06T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lanaPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-reversal",
    rawType: 16013,
    canonicalType: "payout_reversal",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 900n,
    sourceDestinationAmountMills: 900n,
    creatorNetAmountMills: 900n,
    occurredAt: new Date("2026-03-07T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: lilyPage.id,
    source: "onlymonster",
    fanId: fan.id,
    transactionId: "tx-lily-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 3000n,
    sourceDestinationAmountMills: 3000n,
    creatorNetAmountMills: 3000n,
    occurredAt: new Date("2026-03-06T13:00:00.000Z"),
  });

  await rebuildRevenueRollups(testDb.db, lanaPage.id);
  await rebuildRevenueRollups(testDb.db, lilyPage.id);
  await rebuildFollowerRollups(testDb.db, lanaPage.id, 1);
  await rebuildSubscriberRollups(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lanaPage.id);
  await recalculateFanPageSpend(testDb.db, lilyPage.id);

  return {
    lanaModel,
    lanaPage,
    lilyPage,
  };
}

function setCookieHeaderFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error("Expected set-cookie header");
  }
  return value;
}

function sessionCookieFrom(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const value = setCookieHeaderFrom(response);
  return value.split(";")[0]!;
}

async function loginOwnerCookie(server: Awaited<ReturnType<typeof buildApiServer>>) {
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      username: "dima",
      password: "owner-secret",
    },
  });

  return sessionCookieFrom(login);
}

function createAutoSyncFanslyAdapter(input: {
  accountId: string;
  username: string;
  displayName: string | null;
}): AppContext["adapter"] {
  const accountMe = {
    account: {
      id: input.accountId,
      username: input.username,
      displayName: input.displayName,
      createdAt: 1_772_157_317_000,
      followCount: 0,
      subscriberCount: 0,
      earningsWallet: null,
      walls: [],
      subscriptionTiers: [],
    },
  };

  return {
    async verifySession() {
      return {
        parsed: accountMe,
        raw: accountMe,
      };
    },
    async getAccountMe() {
      return {
        parsed: accountMe,
        raw: accountMe,
      };
    },
    async getAccountsByIdsPage() {
      return {
        parsed: [],
        raw: [],
      };
    },
    async getTransactionsPage() {
      return {
        total: 0,
        items: [],
        offset: 0,
        done: true,
        raw: {
          total: 0,
          data: [],
        },
      };
    },
    async getSubscribersPage() {
      return {
        total: 0,
        items: [],
        offset: 0,
        done: true,
        raw: {
          stats: {
            totalActive: 0,
            totalExpired: 0,
            total: 0,
          },
          subscriptions: [],
        },
      };
    },
    async getFollowersPage() {
      return {
        total: 0,
        items: [],
        offset: 0,
        done: true,
        accounts: [],
        raw: {
          followers: [],
          aggregationData: {
            accounts: [],
          },
        },
      };
    },
    async getMessagingGroupsPage() {
      return {
        total: 0,
        items: [],
        accounts: [],
        groups: [],
        offset: 0,
        done: true,
        raw: {
          data: [],
          aggregationData: {
            total: 0,
            accounts: [],
            groups: [],
          },
        },
      };
    },
    async getGroupDetail(_context: unknown, groupId: string) {
      const parsed = {
        id: groupId,
        type: 1,
        groupFlags: 0,
        users: [],
        lastMessage: null,
      };

      return {
        parsed,
        raw: parsed,
      };
    },
    async getMessagesPage(_context: unknown, params: { groupId: string; before?: string | null }) {
      return {
        items: [],
        groupId: params.groupId,
        before: params.before ?? null,
        done: true,
        raw: {
          messages: [],
        },
      };
    },
    async getEarningsAccountsPage(_context: unknown, params: { after?: Date | null; before?: Date | null }) {
      return {
        items: [],
        after: params.after ?? null,
        before: params.before ?? null,
        done: true,
        raw: [],
      };
    },
    async getEarningsStatsAccountsPage() {
      return { items: [], raw: [] };
    },
    async getEarningsMonthlyStatsAccountsPage() {
      return { items: [], raw: [] };
    },
    async getMediaOrderHistoryPage() {
      return { items: [], raw: [] };
    },
    async close() {},
  } as AppContext["adapter"];
}

async function seedConversationApiFixture(input: {
  testDb: StartedTestDatabase;
  pageId: number;
}) {
  const [subscriberFan, reactivationFan] = await upsertFans(input.testDb.db, [
    {
      platform: "fansly",
      platformUserId: "fan-001",
      username: "buyer",
      displayName: "Buyer One",
    },
    {
      platform: "fansly",
      platformUserId: "fan-777",
      username: "silent_spender",
      displayName: "Silent Spender",
    },
  ]);

  const conversation = await upsertPageDmConversation(input.testDb.db, {
    platformAccountId: input.pageId,
    fanId: subscriberFan.id,
    platformConversationId: "conversation-001",
    partnerPlatformUserId: "fan-001",
    partnerUsername: "buyer",
    partnerDisplayName: "Buyer One",
    conversationFlags: 0,
    unreadCount: 2,
    subscriptionTierId: null,
    lastMessageId: "conversation-msg-004",
    lastUnreadMessageId: "conversation-msg-004",
    lastMessageAt: new Date("2026-03-14T08:00:00.000Z"),
    lastMessageSenderId: "fan-001",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Need help with anything else?",
    lastFanMessageAt: new Date("2026-03-14T08:00:00.000Z"),
    lastModelMessageAt: new Date("2026-03-13T08:30:00.000Z"),
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await upsertPageDmMessages(input.testDb.db, [
    {
      conversationId: conversation.id,
      platformAccountId: input.pageId,
      platformMessageId: "conversation-msg-001",
      senderPlatformUserId: "acct-lana",
      senderRole: "model",
      createdAt: new Date("2026-03-13T08:00:00.000Z"),
      content: "hey there",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
    {
      conversationId: conversation.id,
      platformAccountId: input.pageId,
      platformMessageId: "conversation-msg-002",
      senderPlatformUserId: "fan-001",
      senderRole: "fan",
      createdAt: new Date("2026-03-13T08:15:00.000Z"),
      content: "hi!",
      totalTipAmountCents: 0,
      inReplyToMessageId: "conversation-msg-001",
      inReplyToRootMessageId: "conversation-msg-001",
    },
    {
      conversationId: conversation.id,
      platformAccountId: input.pageId,
      platformMessageId: "conversation-msg-003",
      senderPlatformUserId: "acct-lana",
      senderRole: "model",
      createdAt: new Date("2026-03-13T08:30:00.000Z"),
      content: "absolutely",
      totalTipAmountCents: 0,
      inReplyToMessageId: "conversation-msg-002",
      inReplyToRootMessageId: "conversation-msg-001",
    },
    {
      conversationId: conversation.id,
      platformAccountId: input.pageId,
      platformMessageId: "conversation-msg-004",
      senderPlatformUserId: "fan-001",
      senderRole: "fan",
      createdAt: new Date("2026-03-14T08:00:00.000Z"),
      content: "Need help with anything else?",
      totalTipAmountCents: 2000,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
  ]);

  await finalizePageDmConversationMessageSync(input.testDb.db, {
    conversationId: conversation.id,
    messageCoverageStatus: "complete",
    lastMessageSyncAt: new Date("2026-03-17T11:45:00.000Z"),
  });

  await upsertFanPage(input.testDb.db, {
    fanId: reactivationFan.id,
    platformAccountId: input.pageId,
    isSubscriber: false,
    subscriberSince: new Date("2026-01-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-02-01T12:00:00.000Z"),
    autoRenew: false,
  });
  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: reactivationFan.id,
    transactionId: "tx-conversation-reactivation",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 12000n,
    sourceDestinationAmountMills: 12000n,
    creatorNetAmountMills: 12000n,
    occurredAt: new Date("2026-02-15T12:00:00.000Z"),
  });
  await recalculateFanPageSpend(input.testDb.db, input.pageId);

  await input.testDb.db.insert(pageSyncStateRows).values([
    {
      pageId: input.pageId,
      stream: "dm_conversations",
      status: "idle",
      cadenceSeconds: 1800,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(new Date("2026-03-17T12:30:00.000Z").getTime() / 1000 / 1800) - 1,
      requestSeq: 3,
      appliedSeq: 3,
      finishedAt: new Date("2026-03-17T11:50:00.000Z"),
      succeededAt: new Date("2026-03-17T11:50:00.000Z"),
    },
    {
      pageId: input.pageId,
      stream: "dm_messages",
      status: "idle",
      cadenceSeconds: 86400,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(new Date("2026-03-17T14:00:00.000Z").getTime() / 1000 / 86400) - 1,
      requestSeq: 2,
      appliedSeq: 2,
      finishedAt: new Date("2026-03-17T11:45:00.000Z"),
      succeededAt: new Date("2026-03-17T11:45:00.000Z"),
    },
  ]);

  await input.testDb.db.insert(pageSyncCursorRows).values({
    pageId: input.pageId,
    stream: "dm_conversations",
    state: {
      version: 1,
      lastFullSweepCompletedAt: "2026-03-17T09:00:00.000Z",
    },
    cursorLastSucceededAt: new Date("2026-03-17T11:50:00.000Z"),
  });

  return {
    subscriberFan,
    reactivationFan,
    conversation,
  };
}

async function seedWorkboardApiFixture(input: {
  testDb: StartedTestDatabase;
  pageId: number;
}) {
  const [
    visibleSubscriber,
    snoozedSubscriber,
    activeSpender,
    inactiveSpender,
    microSpender,
    deletedSubscriber,
    deletedActiveSpender,
    deletedInactiveSpender,
  ] = await upsertFans(input.testDb.db, [
    {
      platform: "fansly",
      platformUserId: "wb-api-subscriber-visible",
      username: "wb_api_subscriber_visible",
      displayName: "WB API Subscriber Visible",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-subscriber-snoozed",
      username: "wb_api_subscriber_snoozed",
      displayName: "WB API Subscriber Snoozed",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-active-spender",
      username: "wb_api_active_spender",
      displayName: "WB API Active Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-inactive-spender",
      username: "wb_api_inactive_spender",
      displayName: "WB API Inactive Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-micro-spender",
      username: "wb_api_micro_spender",
      displayName: "WB API Micro Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-subscriber-deleted",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-active-spender-deleted",
    },
    {
      platform: "fansly",
      platformUserId: "wb-api-inactive-spender-deleted",
    },
  ]);

  for (const [index, fan] of [visibleSubscriber, snoozedSubscriber].entries()) {
    await upsertFanPage(input.testDb.db, {
      fanId: fan.id,
      platformAccountId: input.pageId,
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
      subscriptionExpiresAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      autoRenew: index === 0,
    });
    await upsertPageSubscription(input.testDb.db, {
      platformSubscriptionId: `wb-api-sub-${index + 1}`,
      platformAccountId: input.pageId,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: index === 0,
      sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
      endsAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      subscriptionTierName: "VIP",
    });
  }

  await upsertFanPage(input.testDb.db, {
    fanId: deletedSubscriber.id,
    platformAccountId: input.pageId,
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-31T12:00:00.000Z"),
    autoRenew: false,
  });
  await upsertPageSubscription(input.testDb.db, {
    platformSubscriptionId: "wb-api-sub-deleted",
    platformAccountId: input.pageId,
    fanId: deletedSubscriber.id,
    rawStatus: 3,
    canonicalStatus: "active",
    priceMills: 5000n,
    renewPriceMills: 5000n,
    autoRenew: false,
    sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
    endsAt: new Date("2026-03-31T12:00:00.000Z"),
    subscriptionTierName: "VIP",
  });

  await upsertFanPage(input.testDb.db, {
    fanId: deletedActiveSpender.id,
    platformAccountId: input.pageId,
  });
  await upsertFanPage(input.testDb.db, {
    fanId: deletedInactiveSpender.id,
    platformAccountId: input.pageId,
  });

  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: activeSpender.id,
    transactionId: "wb-api-active-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 125000n,
    sourceDestinationAmountMills: 125000n,
    creatorNetAmountMills: 125000n,
    occurredAt: new Date("2026-03-25T12:00:00.000Z"),
  });
  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: inactiveSpender.id,
    transactionId: "wb-api-inactive-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 140000n,
    sourceDestinationAmountMills: 140000n,
    creatorNetAmountMills: 140000n,
    occurredAt: new Date("2026-02-10T12:00:00.000Z"),
  });
  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: deletedActiveSpender.id,
    transactionId: "wb-api-active-tip-deleted",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 135000n,
    sourceDestinationAmountMills: 135000n,
    creatorNetAmountMills: 135000n,
    occurredAt: new Date("2026-03-23T12:00:00.000Z"),
  });
  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: deletedInactiveSpender.id,
    transactionId: "wb-api-inactive-tip-deleted",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 145000n,
    sourceDestinationAmountMills: 145000n,
    creatorNetAmountMills: 145000n,
    occurredAt: new Date("2026-02-05T12:00:00.000Z"),
  });
  await upsertTransaction(input.testDb.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    fanId: microSpender.id,
    transactionId: "wb-api-micro-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 100n,
    sourceDestinationAmountMills: 100n,
    creatorNetAmountMills: 100n,
    occurredAt: new Date("2026-03-24T12:00:00.000Z"),
  });

  await recalculateFanPageSpend(input.testDb.db, input.pageId);

  return {
    visibleSubscriber,
    snoozedSubscriber,
    activeSpender,
    inactiveSpender,
    microSpender,
    deletedSubscriber,
    deletedActiveSpender,
    deletedInactiveSpender,
  };
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function setSyncRunTimes(
  testDb: StartedTestDatabase,
  runId: number,
  startedAt: Date,
  finishedAt: Date | null,
) {
  await testDb.pool.query(
    "update sync_runs set started_at = $1, finished_at = $2 where id = $3",
    [startedAt, finishedAt, runId],
  );
}

async function seedMonitorCompletedRun(
  testDb: StartedTestDatabase,
  input: {
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile";
    startedAt: Date;
    finishedAt: Date;
    trigger?: string;
    status: "success" | "partial" | "failed" | "skipped";
    errorSummary?: string | null;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    trigger: input.trigger ?? "worker",
  });
  await finishSyncRun(testDb.db, run.id, {
    status: input.status,
    errorSummary: input.errorSummary ?? null,
    stats: {},
  });
  await setSyncRunTimes(testDb, run.id, input.startedAt, input.finishedAt);
  return run;
}

async function seedMonitorRunningRun(
  testDb: StartedTestDatabase,
  input: {
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile";
    startedAt: Date;
    trigger?: string;
  },
) {
  const run = await startSyncRun(testDb.db, {
    platformAccountId: input.pageId,
    stream: input.stream,
    trigger: input.trigger ?? "worker",
  });
  await setSyncRunTimes(testDb, run.id, input.startedAt, null);
  return run;
}

async function seedMonitorAttempt(
  testDb: StartedTestDatabase,
  input: {
    runId: number;
    pageId: number;
    stream: "light" | "transactions" | "subscribers" | "dm_conversations" | "dm_messages" | "followers" | "followers_reconcile";
    startedAt: Date;
    finishedAt?: Date;
    state: "started" | "success" | "retry" | "failed";
    httpStatus?: number | null;
    failureKind?: "timeout" | "transport" | "http" | "provider" | null;
    errorMessage?: string | null;
    attemptNumber?: number;
    operation?: string;
    provider?: "fansly" | "onlyfans";
    requestShape?: Record<string, unknown>;
    responseShape?: Record<string, unknown>;
  },
) {
  const attempt = await insertSyncRequestAttempt(testDb.db, {
    syncRunId: input.runId,
    platformAccountId: input.pageId,
    provider: input.provider ?? "fansly",
    stream: input.stream,
    operation: input.operation ?? `${input.stream}_request`,
    logicalRequestId: `${input.stream}:${input.runId}:${input.startedAt.toISOString()}`,
    attemptNumber: input.attemptNumber ?? 1,
    requestShape: input.requestShape ?? {},
    startedAt: input.startedAt,
  });
  if (input.state === "started") {
    return attempt;
  }

  await finishSyncRequestAttempt(testDb.db, attempt.id, {
    state: input.state,
    httpStatus: input.httpStatus ?? null,
    failureKind: input.failureKind ?? null,
    errorMessage: input.errorMessage ?? null,
    durationMs: Math.max(1, (input.finishedAt ?? input.startedAt).getTime() - input.startedAt.getTime()),
    responseShape: input.responseShape ?? {},
    finishedAt: input.finishedAt ?? input.startedAt,
  });

  return attempt;
}

async function seedSyncMonitorScenario(
  testDb: StartedTestDatabase,
  pageId: number,
  now = new Date(),
) {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000);
  const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  const completedMessageCreatedAt = minutesAgo(80);
  const completedLastMessageAt = minutesAgo(76);
  const completedSyncAt = minutesAgo(75);
  const laggingLastMessageAt = minutesAgo(50);
  const laggingLastMessageSyncAt = minutesAgo(120);
  const pendingConversationAt = minutesAgo(45);
  const excludedConversationAt = minutesAgo(60);
  const authFailedAt = minutesAgo(60);
  const lightRunningStartedAt = hoursAgo(2);
  const lightRunningEventAt = minutesAgo(115);
  const transactionsStartedAt = hoursAgo(3);
  const transactionsFinishedAt = minutesAgo(173);
  const last429At = minutesAgo(178);
  const transactionsEventAt = minutesAgo(177);
  const followersSucceededAt = hoursAgo(30);
  const followersStartedAt = minutesAgo(45);
  const followersFailedAt = minutesAgo(40);
  const last5xxAt = minutesAgo(44);
  const oldLightStartedAt = hoursAgo(30);
  const oldLightFinishedAt = new Date(oldLightStartedAt.getTime() + 2 * 60_000);
  const oldLight429At = new Date(oldLightStartedAt.getTime() + 60_000);
  const retryAt = minutesFromNow(4);

  const [fanA, fanB, fanC, fanD] = await upsertFans(testDb.db, [
    {
      platform: "fansly",
      platformUserId: "monitor-fan-a",
      username: "monitor_a",
      displayName: "Monitor A",
    },
    {
      platform: "fansly",
      platformUserId: "monitor-fan-b",
      username: "monitor_b",
      displayName: "Monitor B",
    },
    {
      platform: "fansly",
      platformUserId: "monitor-fan-c",
      username: "monitor_c",
      displayName: "Monitor C",
    },
    {
      platform: "fansly",
      platformUserId: "monitor-fan-d",
      username: "monitor_d",
      displayName: "Monitor D",
    },
  ]);

  for (const fan of [fanA, fanB, fanC, fanD]) {
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: pageId,
      isFollower: false,
      isSubscriber: false,
    });
  }

  const completedConversation = await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanA.id,
    platformConversationId: "monitor-conv-complete",
    partnerPlatformUserId: "monitor-fan-a",
    partnerUsername: "monitor_a",
    partnerDisplayName: "Monitor A",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-msg-002",
    lastUnreadMessageId: null,
    lastMessageAt: completedLastMessageAt,
    lastMessageSenderId: "monitor-fan-a",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Latest stored message",
    lastFanMessageAt: completedLastMessageAt,
    lastModelMessageAt: completedMessageCreatedAt,
    newestStoredMessageId: "monitor-msg-002",
    oldestStoredMessageId: "monitor-msg-001",
    storedMessageCount: 2,
    messageBackfillComplete: true,
    lastMessageSyncAt: completedSyncAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });
  await upsertPageDmMessages(testDb.db, [
    {
      conversationId: completedConversation.id,
      platformAccountId: pageId,
      platformMessageId: "monitor-msg-001",
      senderPlatformUserId: "acct-lana",
      senderRole: "model",
      createdAt: completedMessageCreatedAt,
      content: "Opening line",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
    {
      conversationId: completedConversation.id,
      platformAccountId: pageId,
      platformMessageId: "monitor-msg-002",
      senderPlatformUserId: "monitor-fan-a",
      senderRole: "fan",
      createdAt: completedLastMessageAt,
      content: "Latest stored message",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    },
  ]);
  await finalizePageDmConversationMessageSync(testDb.db, {
    conversationId: completedConversation.id,
    messageCoverageStatus: "complete",
    lastMessageSyncAt: completedSyncAt,
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanB.id,
    platformConversationId: "monitor-conv-lagging",
    partnerPlatformUserId: "monitor-fan-b",
    partnerUsername: "monitor_b",
    partnerDisplayName: "Monitor B",
    conversationFlags: 0,
    unreadCount: 1,
    subscriptionTierId: null,
    lastMessageId: "monitor-lagging-003",
    lastUnreadMessageId: "monitor-lagging-003",
    lastMessageAt: laggingLastMessageAt,
    lastMessageSenderId: "monitor-fan-b",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Lagging conversation",
    lastFanMessageAt: laggingLastMessageAt,
    lastModelMessageAt: null,
    newestStoredMessageId: "monitor-lagging-002",
    oldestStoredMessageId: "monitor-lagging-001",
    storedMessageCount: 2,
    messageBackfillComplete: false,
    lastMessageSyncAt: laggingLastMessageSyncAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanC.id,
    platformConversationId: "monitor-conv-pending",
    partnerPlatformUserId: "monitor-fan-c",
    partnerUsername: "monitor_c",
    partnerDisplayName: "Monitor C",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-pending-001",
    lastUnreadMessageId: null,
    lastMessageAt: pendingConversationAt,
    lastMessageSenderId: "acct-lana",
    lastMessageSenderRole: "model",
    lastMessagePreview: "Pending backfill",
    lastFanMessageAt: null,
    lastModelMessageAt: pendingConversationAt,
    newestStoredMessageId: "monitor-pending-001",
    oldestStoredMessageId: "monitor-pending-001",
    storedMessageCount: 1,
    messageBackfillComplete: false,
    lastMessageSyncAt: pendingConversationAt,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: pageId,
    fanId: fanD.id,
    platformConversationId: "monitor-conv-excluded",
    partnerPlatformUserId: "monitor-fan-d",
    partnerUsername: "monitor_d",
    partnerDisplayName: "Monitor D",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "monitor-excluded-001",
    lastUnreadMessageId: null,
    lastMessageAt: excludedConversationAt,
    lastMessageSenderId: "monitor-fan-d",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "Excluded conversation",
    lastFanMessageAt: excludedConversationAt,
    lastModelMessageAt: null,
    newestStoredMessageId: null,
    oldestStoredMessageId: null,
    storedMessageCount: 0,
    messageBackfillComplete: false,
    lastMessageSyncAt: null,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {
      [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "message sync disabled",
    },
  });

  await testDb.db.insert(pageSyncStateRows).values([
    {
      pageId,
      stream: "light",
      status: "running",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(30).getTime() / 1000 / 3600) - 1,
      requestSeq: 3,
      appliedSeq: 3,
      startedAt: lightRunningStartedAt,
    },
    {
      pageId,
      stream: "transactions" as const,
      status: "retrying",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(15).getTime() / 1000 / 3600) - 1,
      requestSeq: 4,
      appliedSeq: 3,
      retryAt: retryAt,
    },
    {
      pageId,
      stream: "subscribers" as const,
      status: "paused",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(60).getTime() / 1000 / 3600) - 1,
      requestSeq: 1,
      appliedSeq: 1,
    },
    {
      pageId,
      stream: "dm_conversations" as const,
      status: "blocked",
      cadenceSeconds: 1800,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(minutesFromNow(10).getTime() / 1000 / 1800) - 1,
      requestSeq: 2,
      appliedSeq: 1,
      failedAt: authFailedAt,
      blockerKind: "auth",
      blockerCode: "auth_blocked",
      blockerMessage: "Session expired",
      blockedAt: authFailedAt,
      lastErrorCode: "auth_blocked",
      lastErrorSummary: "Session expired",
    },
    {
      pageId,
      stream: "dm_messages" as const,
      status: "idle",
      cadenceSeconds: 86400,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(hoursAgo(-2).getTime() / 1000 / 86400) - 1,
      requestSeq: 2,
      appliedSeq: 2,
      finishedAt: completedSyncAt,
      succeededAt: completedSyncAt,
    },
    {
      pageId,
      stream: "followers" as const,
      status: "idle",
      cadenceSeconds: 3600,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(hoursAgo(-12).getTime() / 1000 / 3600) - 1,
      requestSeq: 6,
      appliedSeq: 6,
      finishedAt: followersSucceededAt,
      succeededAt: followersSucceededAt,
      failedAt: followersFailedAt,
      consecutiveFailures: 2,
      lastErrorCode: "http_500",
      lastErrorSummary: "Followers sync failed",
    },
    {
      pageId,
      stream: "followers_reconcile",
      status: "idle",
      cadenceSeconds: 172800,
      slotOffsetSeconds: 0,
      lastScheduledSlot: Math.floor(hoursAgo(-48).getTime() / 1000 / 172800) - 1,
      requestSeq: 1,
      appliedSeq: 1,
    },
  ]);

  await testDb.db.insert(pageSyncCursorRows).values([
    {
      pageId,
      stream: "transactions",
      state: {
        mode: "backfill",
        completed: false,
        provider: "fansly",
        phase: "transactions",
        snapshotEnd: hoursAgo(5).toISOString(),
        newestSeenAt: hoursAgo(5).toISOString(),
        dirtyFrom: null,
        processedTransactions: 15,
        processedChargebacks: 2,
        transactionPages: 3,
        chargebackPages: 0,
        offset: 15,
      },
      cursorLastSucceededAt: completedSyncAt,
    },
    {
      pageId,
      stream: "subscribers",
      state: {
        revision: 1,
        generation: 1,
        offset: 2,
        pageCount: 1,
        providerReportedTotal: 5,
      },
    },
    {
      pageId,
      stream: "dm_conversations",
      state: {
        version: 1,
        mode: "full_scan",
        generation: 1,
        offset: 2,
        pageCount: 1,
        providerReportedTotal: 4,
        unchangedPageStreak: 0,
        fullSweepStartedAt: hoursAgo(4).toISOString(),
        lastFullSweepCompletedAt: null,
      },
    },
    {
      pageId,
      stream: "dm_messages",
      state: {
        version: 1,
        currentConversationId: completedConversation.id,
        currentPlatformConversationId: "monitor-conv-complete",
        currentBeforeMessageId: null,
        currentMode: "backfill",
      },
      cursorLastSucceededAt: completedSyncAt,
    },
    {
      pageId,
      stream: "followers",
      state: {
        revision: 6,
        knownFollowId: "monitor-follow-004",
        newestFollowId: "monitor-follow-010",
        offset: 4,
        pageCount: 2,
        sourceFollowerCount: 10,
      },
      cursorLastSucceededAt: followersSucceededAt,
    },
    {
      pageId,
      stream: "followers_reconcile" as const,
      state: {
        revision: 1,
        generation: 1,
        offset: 2,
        pageCount: 1,
        sourceFollowerCount: 10,
      },
    },
  ]);

  const runningLightRun = await seedMonitorRunningRun(testDb, {
    pageId,
    stream: "light",
    startedAt: lightRunningStartedAt,
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: runningLightRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "light",
    eventType: "phase_started",
    severity: "info",
    message: "Light sync is active",
    emittedAt: lightRunningEventAt,
  });

  const transactionsRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "transactions",
    status: "partial",
    startedAt: transactionsStartedAt,
    finishedAt: transactionsFinishedAt,
  });
  await seedMonitorAttempt(testDb, {
    runId: transactionsRun.id,
    pageId,
    stream: "transactions",
    startedAt: last429At,
    finishedAt: new Date(last429At.getTime() + 30_000),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Rate limited",
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: transactionsRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "transactions",
    eventType: "backfill_progress",
    severity: "warn",
    message: "Transactions backfill slowed by 429s",
    emittedAt: transactionsEventAt,
  });

  const dmMessagesRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "dm_messages",
    status: "success",
    startedAt: completedMessageCreatedAt,
    finishedAt: completedSyncAt,
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: dmMessagesRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "dm_messages",
    eventType: "run_finished",
    severity: "info",
    message: "DM message sync completed",
    emittedAt: completedSyncAt,
  });

  const failedFollowersRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "followers",
    status: "failed",
    startedAt: followersStartedAt,
    finishedAt: followersFailedAt,
    errorSummary: "Followers sync failed",
  });
  await seedMonitorAttempt(testDb, {
    runId: failedFollowersRun.id,
    pageId,
    stream: "followers",
    startedAt: last5xxAt,
    finishedAt: new Date(last5xxAt.getTime() + 30_000),
    state: "failed",
    httpStatus: 500,
    failureKind: "http",
    errorMessage: "Internal server error",
  });
  await insertSyncRunEvent(testDb.db, {
    syncRunId: failedFollowersRun.id,
    platformAccountId: pageId,
    provider: "fansly",
    stream: "followers",
    eventType: "run_failed",
    severity: "error",
    message: "Followers sync failed",
    emittedAt: followersFailedAt,
  });

  const oldLightRun = await seedMonitorCompletedRun(testDb, {
    pageId,
    stream: "light",
    status: "success",
    startedAt: oldLightStartedAt,
    finishedAt: oldLightFinishedAt,
  });
  await seedMonitorAttempt(testDb, {
    runId: oldLightRun.id,
    pageId,
    stream: "light",
    startedAt: oldLight429At,
    finishedAt: new Date(oldLight429At.getTime() + 20_000),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Old rate limit",
  });

  await testDb.pool.query(`
    insert into egress_endpoints (
      platform_account_id,
      kind,
      url,
      encrypted_auth,
      key_version,
      rate_limit_scope_key
    ) values ($1, 'proxy', 'socks5://proxy.example', null, null, 'socks5://proxy.example:1080')
  `, [pageId]);

  await testDb.db.insert(syncRateLimits).values({
    provider: "fansly",
    scope: "global",
    egressKey: "socks5://proxy.example:1080",
    minSpacingMs: 1_000,
    nextAvailableAt: retryAt,
  });

  return {
    retryAt,
    completedSyncAt,
    followersFailedAt,
    last429At,
    last5xxAt,
    lightRunningEventAt,
    lightRunningStartedAt,
  };
}

async function seedSyncRequestsScenario(
  testDb: StartedTestDatabase,
  input: {
    lanaPageId: number;
    lilyPageId: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const secondsAgo = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

  const lanaStartedAt = secondsAgo(3);
  const lilySharedAt = secondsAgo(4);
  const lilyGhostAt = secondsAgo(5);
  const lanaRetryAt = secondsAgo(8);
  const lanaFailedAt = secondsAgo(14);
  const oldAttemptAt = secondsAgo(75);

  await upsertPageDmConversation(testDb.db, {
    platformAccountId: input.lanaPageId,
    fanId: null,
    platformConversationId: "group-live-1",
    partnerPlatformUserId: "fan-live-1",
    partnerUsername: "fan_live",
    partnerDisplayName: "Fan Live",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "dm-live-001",
    lastUnreadMessageId: null,
    lastMessageAt: lanaStartedAt,
    lastMessageSenderId: "fan-live-1",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "hello there",
    lastFanMessageAt: lanaStartedAt,
    lastModelMessageAt: null,
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  });

  const lanaMessagesRun = await seedMonitorRunningRun(testDb, {
    pageId: input.lanaPageId,
    stream: "dm_messages",
    startedAt: secondsAgo(6),
  });
  const lilyFollowersRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "followers",
    status: "success",
    startedAt: secondsAgo(10),
    finishedAt: secondsAgo(2),
  });
  const lilyGhostMessagesRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "dm_messages",
    status: "success",
    startedAt: secondsAgo(9),
    finishedAt: secondsAgo(4),
  });
  const lanaTransactionsRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lanaPageId,
    stream: "transactions",
    status: "partial",
    startedAt: secondsAgo(12),
    finishedAt: secondsAgo(7),
  });
  const lanaFollowersRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lanaPageId,
    stream: "followers",
    status: "failed",
    startedAt: secondsAgo(20),
    finishedAt: secondsAgo(13),
  });
  const lilyOldRun = await seedMonitorCompletedRun(testDb, {
    pageId: input.lilyPageId,
    stream: "light",
    status: "success",
    startedAt: secondsAgo(90),
    finishedAt: secondsAgo(70),
  });

  await seedMonitorAttempt(testDb, {
    runId: lanaMessagesRun.id,
    pageId: input.lanaPageId,
    stream: "dm_messages",
    operation: "messages",
    startedAt: lanaStartedAt,
    state: "started",
    requestShape: {
      endpointTemplate: "/message",
      method: "GET",
      rateLimitWaitMs: 1_200,
      groupId: "group-live-1",
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyFollowersRun.id,
    pageId: input.lilyPageId,
    stream: "followers",
    operation: "followers",
    startedAt: lilySharedAt,
    finishedAt: new Date(lilySharedAt.getTime() + 240),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/account/:accountId/followersnew",
      method: "GET",
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyGhostMessagesRun.id,
    pageId: input.lilyPageId,
    stream: "dm_messages",
    operation: "messages",
    startedAt: lilyGhostAt,
    finishedAt: new Date(lilyGhostAt.getTime() + 320),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/message",
      method: "GET",
      groupId: "group-ghost-1",
      egressKey: "proxy-b",
    },
    responseShape: {
      returnedItems: 2,
      done: true,
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lanaTransactionsRun.id,
    pageId: input.lanaPageId,
    stream: "transactions",
    operation: "earnings_transactions",
    attemptNumber: 2,
    startedAt: lanaRetryAt,
    finishedAt: new Date(lanaRetryAt.getTime() + 650),
    state: "retry",
    httpStatus: 429,
    failureKind: "http",
    errorMessage: "Rate limited",
    requestShape: {
      endpointTemplate: "/account/wallets/earnings/transactions",
      method: "GET",
      rateLimitWaitMs: 2_500,
      egressKey: "proxy-a",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lanaFollowersRun.id,
    pageId: input.lanaPageId,
    stream: "followers",
    operation: "followers",
    startedAt: lanaFailedAt,
    finishedAt: new Date(lanaFailedAt.getTime() + 900),
    state: "failed",
    httpStatus: 500,
    failureKind: "http",
    errorMessage: "Provider error",
    requestShape: {
      endpointTemplate: "/account/:accountId/followersnew",
      method: "GET",
      egressKey: "proxy-c",
    },
  });
  await seedMonitorAttempt(testDb, {
    runId: lilyOldRun.id,
    pageId: input.lilyPageId,
    stream: "light",
    operation: "account_me",
    startedAt: oldAttemptAt,
    finishedAt: new Date(oldAttemptAt.getTime() + 180),
    state: "success",
    httpStatus: 200,
    requestShape: {
      endpointTemplate: "/account/me",
      method: "GET",
      egressKey: "proxy-old",
    },
  });

  return {
    now,
    lanaStartedAt,
    lilySharedAt,
    lilyGhostAt,
    lanaRetryAt,
    lanaFailedAt,
    oldAttemptAt,
  };
}

describe("api integration", () => {
  let testDb: StartedTestDatabase | null = null;
  let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let fixture: Awaited<ReturnType<typeof seedPhase2Fixture>> | null = null;
  let workerBoss: PgBoss | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);

    const appContext = createTestAppContext(testDb);
    fixture = await seedPhase2Fixture(testDb);
    await createUserAccount(appContext, {
      username: "dima",
      role: "owner",
      password: "owner-secret",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "lead",
      role: "team_lead",
      password: "lead-secret",
    }, { source: "cli" });
    await assignPageToUser(appContext, {
      username: "lead",
      pageLabel: "lana",
    }, { source: "cli" });
    await createUserAccount(appContext, {
      username: "anton",
      role: "chatter",
    }, { source: "cli" });

    if (server) {
      await server.close();
    }
    server = await buildApiServer(appContext);
    await server.ready();
  });

  afterEach(async () => {
    vi.useRealTimers();

    if (workerBoss) {
      await workerBoss.stop();
      workerBoss = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("logs in with a cookie session and supports logout", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value).toBeTruthy();
    expect(setCookieHeaderFrom(login)).not.toContain("Secure");
    expect(login.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
        role: "owner",
      },
    });

    const cookie = sessionCookieFrom(login);
    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      authMethod: "session",
      user: {
        username: "dima",
      },
    });

    const badLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });
    expect(badLogin.statusCode).toBe(401);

    const logout = await server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        cookie,
      },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rate limits repeated login attempts", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "dima",
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: "rate_limit_exceeded",
      message: "Too many login attempts",
      statusCode: 429,
    });
  });

  it("keeps the account backoff when the attacker rotates IPs (audit B7)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: `10.0.0.${attempt + 1}`,
        payload: {
          username: "dima",
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    // A fresh IP gets a fresh per-IP bucket, but the per-account lock holds.
    const freshIp = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.0.0.99",
      payload: {
        username: "dima",
        password: "wrong",
      },
    });
    expect(freshIp.statusCode).toBe(429);

    // Other accounts stay loggable from that IP.
    const otherAccount = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.0.0.99",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    expect(otherAccount.statusCode).toBe(200);
  });

  it("rate limits cross-account spraying per IP (audit B7)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "10.1.1.1",
        payload: {
          username: `sprayed-user-${attempt}`,
          password: "wrong",
        },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.1.1.1",
      payload: {
        username: "sprayed-user-final",
        password: "wrong",
      },
    });
    expect(limited.statusCode).toBe(429);

    // The spray bucket is per IP: another address is unaffected.
    const otherIp = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.1.1.2",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(otherIp.statusCode).toBe(200);
  });

  it("rejects oversized login bodies before they reach the audit log (audit P-3)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const oversizedUsername = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "u".repeat(255),
        password: "wrong",
      },
    });
    expect(oversizedUsername.statusCode).toBe(400);

    const oversizedPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "p".repeat(1025),
      },
    });
    expect(oversizedPassword.statusCode).toBe(400);

    const audited = await testDb.pool.query(
      "select count(*)::int as count from audit_events where event_type = 'auth.login_failed'",
    );
    expect(audited.rows[0].count).toBe(0);
  });

  it("rejects expired sessions", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await testDb.pool.query(`
      update auth_sessions
      set expires_at = now() - interval '1 day'
    `);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);
  });

  it("revokes live sessions when a password is reset", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    await setUserPassword(createTestAppContext(testDb), {
      username: "dima",
      password: "owner-secret-2",
    }, { source: "cli" });

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        cookie,
      },
    });
    expect(me.statusCode).toBe(401);

    const oldPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret-2",
      },
    });
    expect(newPassword.statusCode).toBe(200);
  });

  it("marks the login cookie Secure for trusted https proxy requests", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb, {
      trustProxy: true,
    });
    await createUserAccount(appContext, {
      username: "proxy-owner",
      role: "owner",
      password: "proxy-secret",
    }, { source: "cli" });

    const proxyServer = await buildApiServer(appContext);
    await proxyServer.ready();

    try {
      const login = await proxyServer.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          "x-forwarded-proto": "https",
        },
        payload: {
          username: "proxy-owner",
          password: "proxy-secret",
        },
      });

      expect(login.statusCode).toBe(200);
      expect(setCookieHeaderFrom(login)).toContain("Secure");
    } finally {
      await proxyServer.close();
    }
  });

  it("reads legacy content_manager users but rejects creating new ones through admin APIs", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await testDb.pool.query(`
      insert into users (username, role, password_hash)
      values ('legacy-content-manager', 'content_manager', null)
    `);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const list = await server.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: {
        cookie,
      },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: "legacy-content-manager",
        role: "content_manager",
      }),
    ]));

    const create = await server.inject({
      method: "POST",
      url: "/api/v1/admin/users",
      headers: {
        cookie,
      },
      payload: {
        username: "new-content-manager",
        role: "content_manager",
      },
    });
    expect(create.statusCode).toBe(400);

    const createdRows = await testDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from users
      where username = 'new-content-manager'
    `);
    expect(createdRows.rows[0]?.count).toBe("0");
  });

  it("lists admin users with api key summaries and exposes key activity details", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const firstKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const secondKey = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const usersResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: {
        cookie,
      },
    });
    expect(usersResponse.statusCode).toBe(200);
    expect(usersResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: "anton",
        role: "chatter",
        apiKeyStatus: {
          activeKeyPrefix: secondKey.keyPrefix,
          activeKeyCount: 1,
          activeKeyCreatedAt: expect.any(String),
          activeKeyLastUsedAt: null,
        },
      }),
      expect.objectContaining({
        username: "dima",
        role: "owner",
        apiKeyStatus: null,
      }),
    ]));

    const apiKeysResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/users/anton/api-keys",
      headers: {
        cookie,
      },
    });
    expect(apiKeysResponse.statusCode).toBe(200);
    expect(apiKeysResponse.json()).toEqual([
      expect.objectContaining({
        keyPrefix: secondKey.keyPrefix,
        isActive: true,
        revokedAt: null,
        revokedReason: null,
      }),
      expect.objectContaining({
        keyPrefix: firstKey.keyPrefix,
        isActive: false,
        revokedAt: expect.any(String),
        revokedReason: "rotated",
      }),
    ]);
  });

  it("ingests ai usage batches for chatter api keys and stores rows against the authenticated chatter", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    const issuedKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${issuedKey.key}`,
      },
      payload: {
        events: [
          {
            clientEventId: "evt-001",
            feature: "fast-reply",
            model: "gpt-4o",
            inputTokens: 12,
            outputTokens: 18,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            conversationId: "conversation-001",
            durationMs: 420,
            isCacheHit: false,
            isRegeneration: false,
            completedAt: "2026-04-04T09:00:00.000Z",
          },
          {
            clientEventId: "evt-002",
            feature: "fan-summary",
            model: "gpt-4o-mini",
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            conversationId: null,
            durationMs: null,
            isCacheHit: true,
            isRegeneration: false,
            completedAt: "2026-04-04T09:05:00.000Z",
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      receivedCount: 2,
      insertedCount: 2,
      invalidCount: 0,
      dedupedCount: 0,
    });

    const rows = await testDb.pool.query<{
      username: string;
      client_event_id: string;
      feature: string;
      model: string;
    }>(`
      select u.username,
             e.client_event_id,
             e.feature::text,
             e.model
      from ai_usage_events e
      inner join users u on u.id = e.user_id
      order by e.client_event_id asc
    `);

    expect(rows.rows).toEqual([
      {
        username: "anton",
        client_event_id: "evt-001",
        feature: "fast-reply",
        model: "gpt-4o",
      },
      {
        username: "anton",
        client_event_id: "evt-002",
        feature: "fan-summary",
        model: "gpt-4o-mini",
      },
    ]);
  });

  it("rejects ai usage ingestion without an api key principal", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const unauthenticated = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      payload: {
        events: [{
          clientEventId: "evt-unauth",
          feature: "fast-reply",
          model: "gpt-4o",
          inputTokens: 1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          conversationId: null,
          durationMs: null,
          isCacheHit: false,
          isRegeneration: false,
          completedAt: "2026-04-04T09:00:00.000Z",
        }],
      },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = await loginOwnerCookie(server);
    const sessionAuthenticated = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        cookie,
      },
      payload: {
        events: [{
          clientEventId: "evt-session",
          feature: "fast-reply",
          model: "gpt-4o",
          inputTokens: 1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          conversationId: null,
          durationMs: null,
          isCacheHit: false,
          isRegeneration: false,
          completedAt: "2026-04-04T09:00:00.000Z",
        }],
      },
    });
    expect(sessionAuthenticated.statusCode).toBe(403);
  });

  it("dedupes repeated client event ids per chatter but keeps the same id separate across chatters", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    await createUser(appContext.db, {
      username: "boris",
      role: "chatter",
      passwordHash: null,
    });
    const antonKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const borisKey = await issueChatterApiKey(appContext, {
      username: "boris",
      pageLabel: "lana",
    }, { source: "cli" });

    const payload = {
      events: [{
        clientEventId: "evt-shared",
        feature: "help-me",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        conversationId: "conversation-007",
        durationMs: 250,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: "2026-04-04T10:00:00.000Z",
      }],
    };

    const firstAnton = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload,
    });
    expect(firstAnton.statusCode).toBe(200);
    expect(firstAnton.json()).toEqual({
      receivedCount: 1,
      insertedCount: 1,
      invalidCount: 0,
      dedupedCount: 0,
    });

    const secondAnton = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload,
    });
    expect(secondAnton.statusCode).toBe(200);
    expect(secondAnton.json()).toEqual({
      receivedCount: 1,
      insertedCount: 0,
      invalidCount: 0,
      dedupedCount: 1,
    });

    const boris = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${borisKey.key}`,
      },
      payload,
    });
    expect(boris.statusCode).toBe(200);
    expect(boris.json()).toEqual({
      receivedCount: 1,
      insertedCount: 1,
      invalidCount: 0,
      dedupedCount: 0,
    });

    const grouped = await testDb.pool.query<{
      username: string;
      event_count: string;
    }>(`
      select u.username,
             count(*)::text as event_count
      from ai_usage_events e
      inner join users u on u.id = e.user_id
      group by u.username
      order by u.username asc
    `);

    expect(grouped.rows).toEqual([
      { username: "anton", event_count: "1" },
      { username: "boris", event_count: "1" },
    ]);
  });

  it("dual-writes operator observations at the audit choke point (Stage 7 producer 6)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // The suite's beforeEach already created users and assigned a page —
    // every audited admin action must have produced an operator observation.
    const observations = await testDb.pool.query<{ kind: string; producer: string }>(
      "select kind, producer from observations where source = 'operator' order by id",
    );
    expect(observations.rows.length).toBeGreaterThanOrEqual(4);
    expect(observations.rows.every((row) => row.producer === "api:admin")).toBe(true);
    const kinds = new Set(observations.rows.map((row) => row.kind));
    expect(kinds).toContain("user.created");
    expect(kinds).toContain("user.page_assigned");

    // A fresh audited action adds a distinct observation with the actor.
    const appContext = createTestAppContext(testDb);
    await issueChatterApiKey(appContext, { username: "anton", pageLabel: "lana" }, { source: "cli" });
    const issued = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where source = 'operator' and kind = 'api_key.issued'",
    );
    expect(Number(issued.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it("gates raw revenue routes to dashboard session roles (Stage 2 chatter-read-scope)", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const chatterKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const warnSpy = vi.spyOn(appContext.logger, "warn");
    const gateServer = await buildApiServer(appContext);
    await gateServer.ready();

    const gatedUrls = [
      "/api/v1/pages/lana/revenue?period=7d",
      "/api/v1/pages/lana/transactions?limit=10&offset=0",
      "/api/v1/pages/lana/revenue/daily?period=30d",
      "/api/v1/pages/lana/fans/fan-001/transactions?limit=10&offset=0",
    ];

    try {
      // Default mode is "log": bearer-key hits serve normally and log would-deny.
      for (const url of gatedUrls) {
        const response = await gateServer.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${chatterKey.key}` },
        });
        expect(response.statusCode, `${url} in log mode`).toBe(200);
      }
      const wouldDenyLogs = warnSpy.mock.calls.filter(([, message]) =>
        typeof message === "string" && message.startsWith("would-deny"));
      expect(wouldDenyLogs).toHaveLength(gatedUrls.length);

      // Enforce mode refuses bearer keys with 403…
      appContext.config.revenueRouteRoleEnforcement = "enforce";
      for (const url of gatedUrls) {
        const response = await gateServer.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${chatterKey.key}` },
        });
        expect(response.statusCode, `${url} in enforce mode`).toBe(403);
      }

      // …while owner sessions keep working…
      const ownerCookie = await loginOwnerCookie(gateServer);
      for (const url of gatedUrls) {
        const response = await gateServer.inject({
          method: "GET",
          url,
          headers: { cookie: ownerCookie },
        });
        expect(response.statusCode, `${url} for owner session`).toBe(200);
      }

      // …and the chatter-facing spenders board stays reachable (do not over-gate).
      const spenders = await gateServer.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=0",
        headers: { authorization: `Bearer ${chatterKey.key}` },
      });
      expect(spenders.statusCode, spenders.body).toBe(200);
    } finally {
      await gateServer.close();
    }
  });

  it("skips events with invalid completedAt per-event instead of failing the whole batch", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    const issuedKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const baseEvent = {
      feature: "fast-reply" as const,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      isCacheHit: false,
      isRegeneration: false,
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${issuedKey.key}`,
      },
      payload: {
        events: [
          { ...baseEvent, clientEventId: "evt-valid", completedAt: "2026-04-04T11:00:00.000Z" },
          { ...baseEvent, clientEventId: "evt-unparseable", completedAt: "not-a-timestamp" },
          // More than 5 minutes in the future relative to the fake clock.
          { ...baseEvent, clientEventId: "evt-future", completedAt: "2026-04-04T12:06:00.000Z" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      receivedCount: 3,
      insertedCount: 1,
      invalidCount: 2,
      dedupedCount: 0,
    });

    const rows = await testDb.pool.query<{ client_event_id: string }>(
      "select client_event_id from ai_usage_events order by client_event_id asc",
    );
    expect(rows.rows).toEqual([{ client_event_id: "evt-valid" }]);
  });

  it("validates ai usage batches and rejects invalid feature, negative tokens, empty batches, and oversized batches", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const issuedKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const headers = {
      authorization: `Bearer ${issuedKey.key}`,
    };

    const invalidFeature = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers,
      payload: {
        events: [{
          clientEventId: "evt-invalid-feature",
          feature: "wrong-feature",
          model: "gpt-4o",
          inputTokens: 1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          conversationId: null,
          durationMs: null,
          isCacheHit: false,
          isRegeneration: false,
          completedAt: "2026-04-04T10:00:00.000Z",
        }],
      },
    });
    expect(invalidFeature.statusCode).toBe(400);

    const negativeTokens = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers,
      payload: {
        events: [{
          clientEventId: "evt-negative",
          feature: "fast-reply",
          model: "gpt-4o",
          inputTokens: -1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          conversationId: null,
          durationMs: null,
          isCacheHit: false,
          isRegeneration: false,
          completedAt: "2026-04-04T10:00:00.000Z",
        }],
      },
    });
    expect(negativeTokens.statusCode).toBe(400);

    const emptyBatch = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers,
      payload: {
        events: [],
      },
    });
    expect(emptyBatch.statusCode).toBe(400);

    const oversizedBatch = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers,
      payload: {
        events: Array.from({ length: 101 }, (_, index) => ({
          clientEventId: `evt-${index + 1}`,
          feature: "fast-reply",
          model: "gpt-4o",
          inputTokens: 1,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          conversationId: null,
          durationMs: null,
          isCacheHit: false,
          isRegeneration: false,
          completedAt: "2026-04-04T10:00:00.000Z",
        })),
      },
    });
    expect(oversizedBatch.statusCode).toBe(400);

    const count = await testDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from ai_usage_events
    `);
    expect(count.rows[0]?.count).toBe("0");
  });

  it("aggregates chatter ai usage for owners with default Moscow ranges, zero-usage chatters, and warning flags", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    await createUser(appContext.db, {
      username: "boris",
      role: "chatter",
      passwordHash: null,
    });
    const antonKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const batch = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload: {
        events: [
          {
            clientEventId: "evt-agg-1",
            feature: "fast-reply",
            model: "gpt-4o",
            inputTokens: 100,
            outputTokens: 40,
            cacheWriteTokens: 5,
            cacheReadTokens: 2,
            conversationId: "conversation-101",
            durationMs: 300,
            isCacheHit: false,
            isRegeneration: false,
            completedAt: "2026-04-01T10:00:00.000Z",
          },
          {
            clientEventId: "evt-agg-2",
            feature: "fast-reply",
            model: "gpt-4o",
            inputTokens: 120,
            outputTokens: 60,
            cacheWriteTokens: 4,
            cacheReadTokens: 1,
            conversationId: "conversation-101",
            durationMs: 320,
            isCacheHit: false,
            isRegeneration: true,
            completedAt: "2026-04-02T10:00:00.000Z",
          },
          {
            clientEventId: "evt-agg-3",
            feature: "help-me",
            model: "gpt-4o-mini",
            inputTokens: 80,
            outputTokens: 20,
            cacheWriteTokens: 0,
            cacheReadTokens: 10,
            conversationId: null,
            durationMs: null,
            isCacheHit: false,
            isRegeneration: false,
            completedAt: "2026-04-03T10:00:00.000Z",
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);

    const anton = await findUserByUsername(appContext.db, "anton");
    if (!anton) {
      throw new Error("Expected anton to exist");
    }
    await insertAiUsageEvents(appContext.db, {
      userId: anton.id,
      events: [{
        clientEventId: "evt-agg-gateway-1",
        feature: "fast-reply",
        model: "anthropic:claude-sonnet-4-6",
        provider: "anthropic",
        providerResponseId: "msg_usage_report_1",
        inputTokens: 50,
        outputTokens: 25,
        cacheWriteTokens: 10,
        cacheReadTokens: 5,
        costMicroUsd: 1234,
        costApproximate: false,
        quotaAccepted: true,
        gatewayOutcome: "completed",
        conversationId: "conversation-101",
        durationMs: 450,
        isCacheHit: true,
        isRegeneration: true,
        completedAt: new Date("2026-04-03T11:00:00.000Z"),
      }],
    });

    const cookie = await loginOwnerCookie(server);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/usage/chatters",
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const expectedDefaultRange = resolveBusinessDateRange("7d", new Date(), undefined, MOSCOW_TIME_ZONE);
    expect(response.json()).toEqual({
      range: {
        from: expectedDefaultRange.from,
        to: previousBusinessDate(expectedDefaultRange.toExclusive!),
        timeZone: MOSCOW_TIME_ZONE,
      },
      rows: [
        {
          userId: expect.any(Number),
          username: "anton",
          totalGenerations: 4,
          tokenCounts: {
            input: 350,
            output: 145,
            cacheWrite: 19,
            cacheRead: 18,
            cacheTotal: 37,
          },
          cost: {
            microUsd: 1234,
            approximate: false,
          },
          gateway: {
            requestCount: 1,
            completedCount: 1,
            failedCount: 0,
            cancelledCount: 0,
            quotaDeniedCount: 0,
            openReservationCount: 0,
            providerBreakdown: [{
              provider: "anthropic",
              requestCount: 1,
              costMicroUsd: 1234,
            }],
          },
          topFeature: {
            feature: "fast-reply",
            requestCount: 3,
            sharePct: 75,
          },
          featureBreakdown: [
            {
              feature: "fast-reply",
              requestCount: 3,
              sharePct: 75,
              tokenCounts: {
                input: 270,
                output: 125,
                cacheWrite: 19,
                cacheRead: 8,
                cacheTotal: 27,
              },
              costMicroUsd: 1234,
              costApproximate: false,
              regenerateRatePct: 66.67,
            },
            {
              feature: "help-me",
              requestCount: 1,
              sharePct: 25,
              tokenCounts: {
                input: 80,
                output: 20,
                cacheWrite: 0,
                cacheRead: 10,
                cacheTotal: 10,
              },
              costMicroUsd: 0,
              costApproximate: false,
              regenerateRatePct: 0,
            },
          ],
          regenerateRatePct: 50,
          warning: true,
        },
        {
          userId: expect.any(Number),
          username: "boris",
          totalGenerations: 0,
          tokenCounts: {
            input: 0,
            output: 0,
            cacheWrite: 0,
            cacheRead: 0,
            cacheTotal: 0,
          },
          cost: {
            microUsd: 0,
            approximate: false,
          },
          gateway: {
            requestCount: 0,
            completedCount: 0,
            failedCount: 0,
            cancelledCount: 0,
            quotaDeniedCount: 0,
            openReservationCount: 0,
            providerBreakdown: [],
          },
          topFeature: null,
          featureBreakdown: [],
          regenerateRatePct: 0,
          warning: false,
        },
      ],
    });
  });

  it("filters admin chatter usage by completedAt across Moscow day boundaries instead of ingestion time", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-04T22:00:00.000Z"));

    const appContext = createTestAppContext(testDb);
    const antonKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const batch = await server.inject({
      method: "POST",
      url: "/api/v1/ai-usage/batch",
      headers: {
        authorization: `Bearer ${antonKey.key}`,
      },
      payload: {
        events: [
          {
            clientEventId: "evt-boundary-1",
            feature: "fast-reply",
            model: "gpt-4o",
            inputTokens: 10,
            outputTokens: 10,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            conversationId: "conversation-201",
            durationMs: 200,
            isCacheHit: false,
            isRegeneration: false,
            completedAt: "2026-04-03T20:59:59.000Z",
          },
          {
            clientEventId: "evt-boundary-2",
            feature: "help-me",
            model: "gpt-4o",
            inputTokens: 20,
            outputTokens: 20,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            conversationId: "conversation-202",
            durationMs: 240,
            isCacheHit: false,
            isRegeneration: false,
            completedAt: "2026-04-03T21:00:00.000Z",
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);

    const cookie = await loginOwnerCookie(server);
    const aprilThird = await server.inject({
      method: "GET",
      url: "/api/v1/admin/usage/chatters?from=2026-04-03&to=2026-04-03",
      headers: {
        cookie,
      },
    });
    expect(aprilThird.statusCode, aprilThird.body).toBe(200);
    expect(aprilThird.json()).toEqual({
      range: {
        from: "2026-04-03",
        to: "2026-04-03",
        timeZone: MOSCOW_TIME_ZONE,
      },
      rows: [
        expect.objectContaining({
          username: "anton",
          totalGenerations: 1,
          topFeature: {
            feature: "fast-reply",
            requestCount: 1,
            sharePct: 100,
          },
          featureBreakdown: [{
            feature: "fast-reply",
            requestCount: 1,
            sharePct: 100,
            tokenCounts: {
              input: 10,
              output: 10,
              cacheWrite: 0,
              cacheRead: 0,
              cacheTotal: 0,
            },
            costMicroUsd: 0,
            costApproximate: false,
            regenerateRatePct: 0,
          }],
        }),
      ],
    });

    const aprilFourth = await server.inject({
      method: "GET",
      url: "/api/v1/admin/usage/chatters?from=2026-04-04&to=2026-04-04",
      headers: {
        cookie,
      },
    });
    expect(aprilFourth.statusCode, aprilFourth.body).toBe(200);
    expect(aprilFourth.json()).toEqual({
      range: {
        from: "2026-04-04",
        to: "2026-04-04",
        timeZone: MOSCOW_TIME_ZONE,
      },
      rows: [
        expect.objectContaining({
          username: "anton",
          totalGenerations: 1,
          topFeature: {
            feature: "help-me",
            requestCount: 1,
            sharePct: 100,
          },
          featureBreakdown: [{
            feature: "help-me",
            requestCount: 1,
            sharePct: 100,
            tokenCounts: {
              input: 20,
              output: 20,
              cacheWrite: 0,
              cacheRead: 0,
              cacheTotal: 0,
            },
            costMicroUsd: 0,
            costApproximate: false,
            regenerateRatePct: 0,
          }],
        }),
      ],
    });
  });

  it("scopes chatter API keys to assigned pages", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const allowed = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items).toHaveLength(1);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const overview = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(overview.statusCode).toBe(403);
  });

  it("uses one chatter API key across current page assignments", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    await assignPageToUser(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    await assignPageToUser(appContext, {
      username: "anton",
      pageLabel: "lily1",
    }, { source: "cli" });

    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });

    const authMe = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(authMe.statusCode).toBe(200);
    expect(authMe.json().user.assignedPages.map((page: { label: string }) => page.label)).toEqual([
      "lana",
      "lily1",
    ]);

    const lana = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lana.statusCode).toBe(200);

    const lily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lily.statusCode).toBe(200);

    await unassignPageFromUser(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const lanaAfterUnassign = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lanaAfterUnassign.statusCode).toBe(403);

    const lilyAfterUnassign = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(lilyAfterUnassign.statusCode).toBe(200);
  });

  it("issues a user key without changing assignments when no page is provided", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const { key, assignedPages } = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });
    expect(assignedPages).toEqual([]);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.assignedPages).toEqual([]);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("matches page revenue service output with explicit revenue buckets", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-chargeback",
      rawType: 99901,
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: -1000n,
      sourceDestinationAmountMills: -1000n,
      creatorNetAmountMills: -1000n,
      occurredAt: new Date("2026-03-08T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-other",
      rawType: 18001,
      canonicalType: "other",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300n,
      sourceDestinationAmountMills: 300n,
      creatorNetAmountMills: 300n,
      occurredAt: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture.lanaPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getPageRevenueReport(createTestAppContext(testDb), "lana", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
    });
    expect(response.json().revenueMills).toBe(7000);
    expect(response.json().adjustmentMills).toBe(-1000);
    expect(response.json().unclassifiedMills).toBe(300);
    expect(response.json().netEarningsMills).toBe(6300);
    expect(response.json().totalNetMills).toBe(response.json().netEarningsMills);
    expect(response.json().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalType: "chargeback",
        bucket: "adjustment",
        netAmountMills: -1000,
      }),
      expect.objectContaining({
        canonicalType: "other",
        bucket: "unclassified",
        netAmountMills: 300,
      }),
    ]));
    expect(response.json().breakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
  });

  it("combines Fansly and OnlyFans revenue in model reports", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-acct-42",
      username: "lana_of",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 42,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "loading",
      grossAmountMills: 12000n,
      sourceDestinationAmountMills: 12000n,
      creatorNetAmountMills: 12000n,
      occurredAt: new Date("2026-03-05T15:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-cb-1",
      rawType: "Tip from",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -2000n,
      sourceDestinationAmountMills: -2000n,
      creatorNetAmountMills: -2000n,
      occurredAt: new Date("2026-03-06T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/models/lana-model/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getModelRevenueReport(createTestAppContext(testDb), "lana-model", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      revenueMills: expected.revenueMills,
      adjustmentMills: expected.adjustmentMills,
      unclassifiedMills: expected.unclassifiedMills,
      netEarningsMills: expected.netEarningsMills,
      totalNetMills: expected.totalNetMills,
      breakdown: expected.breakdown,
      pages: expect.arrayContaining([
        expect.objectContaining({
          pageLabel: "lana",
          netEarningsMills: 7000,
          totalNetMills: 7000,
        }),
        expect.objectContaining({
          pageLabel: "lana-of",
          netEarningsMills: 10000,
          totalNetMills: 10000,
        }),
      ]),
    });
  });

  it("discloses per-platform revenue windows on mixed-platform reports (audit B2)", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-acct-b2",
      username: "lana_of",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 42,
      },
      syncType: "light",
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue?period=7d",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const windows = body.platformWindows as Array<{
      platform: string;
      from: string;
      to: string;
      comparisonFrom: string;
      comparisonTo: string;
    }>;

    expect(windows.map((w) => w.platform)).toEqual(["fansly", "onlyfans"]);

    const dayCount = (from: string, to: string) =>
      Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);

    const fansly = windows[0];
    const onlyfans = windows[1];
    // The deliberate OnlyFans offset: 7d spans one more calendar day.
    expect(dayCount(fansly.from, fansly.to)).toBe(7);
    expect(dayCount(onlyfans.from, onlyfans.to)).toBe(8);
    expect(dayCount(fansly.comparisonFrom, fansly.comparisonTo)).toBe(7);
    expect(dayCount(onlyfans.comparisonFrom, onlyfans.comparisonTo)).toBe(8);

    // The top-level window stays the union of the per-platform windows.
    const fromTimes = windows.map((w) => new Date(w.from).getTime());
    const toTimes = windows.map((w) => new Date(w.to).getTime());
    expect(new Date(body.from).getTime()).toBe(Math.min(...fromTimes));
    expect(new Date(body.to).getTime()).toBe(Math.max(...toTimes));

    // Single-platform page reports disclose their one window too.
    const pageResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=7d",
      headers: {
        cookie,
      },
    });
    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.json().platformWindows).toHaveLength(1);
    expect(pageResponse.json().platformWindows[0]).toMatchObject({
      platform: "fansly",
      from: pageResponse.json().from,
      to: pageResponse.json().to,
    });
  });

  it("merges and sorts overview revenue daily rows across platforms", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-daily-of",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-daily-42",
      username: "lana_daily_of",
      displayName: "Lana Daily OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 44,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-daily-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4000n,
      sourceDestinationAmountMills: 4000n,
      creatorNetAmountMills: 4000n,
      occurredAt: new Date("2026-03-06T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const summarySeries = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue/daily?period=30d",
      headers: { cookie },
    });
    expect(summarySeries.statusCode).toBe(200);
    expect(summarySeries.json().series).toEqual([
      {
        businessDate: "2026-03-05",
        netAmountMills: 5000,
        transactionCount: 1,
      },
      {
        businessDate: "2026-03-06",
        netAmountMills: 9000,
        transactionCount: 3,
      },
    ]);

    const groupedSeries = await server.inject({
      method: "GET",
      url: "/api/v1/overview/revenue/daily?period=30d&groupByType=true",
      headers: { cookie },
    });
    expect(groupedSeries.statusCode).toBe(200);
    expect(groupedSeries.json().series).toEqual([
      {
        businessDate: "2026-03-05",
        canonicalType: "subscription",
        netAmountMills: 5000,
        transactionCount: 1,
      },
      {
        businessDate: "2026-03-06",
        canonicalType: "tip",
        netAmountMills: 9000,
        transactionCount: 3,
      },
    ]);
  });

  it("returns merged mixed-platform bounds in model reports", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-bounds",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-bounds-42",
      username: "lana_of_bounds",
      displayName: "Lana OF Bounds",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 43,
      },
      syncType: "light",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "of-bounds-tip-1",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "loading",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-03-05T15:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/models/lana-model/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(response.statusCode).toBe(200);

    const expected = await getModelRevenueReport(createTestAppContext(testDb), "lana-model", {
      period: "custom",
      custom: {
        from: "2026-03-01",
        to: "2026-03-31",
      },
    });

    expect(response.json()).toMatchObject({
      from: expected.from,
      to: expected.to,
      comparison: expected.comparison
        ? {
          from: expected.comparison.from,
          to: expected.comparison.to,
        }
        : null,
    });
  });

  it("uses UTC day boundaries for OnlyFans 30d revenue and rollups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "utc-boundary-model",
      name: "UTC Boundary Model",
    });
    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "utc-boundary-of",
    });

    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-boundary-1",
      username: "utc_boundary",
      displayName: "UTC Boundary",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {
        onlyMonsterAccountId: 404,
      },
      syncType: "light",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "before-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-02-06T23:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-0010",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-02-07T00:10:15.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-2059",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-02-07T20:59:59.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "utc-2100",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 3000n,
      sourceDestinationAmountMills: 3000n,
      creatorNetAmountMills: 3000n,
      occurredAt: new Date("2026-02-07T21:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: onlyFansPage.id,
      source: "onlymonster",
      transactionId: "after-window",
      rawType: "Tip from",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4000n,
      sourceDestinationAmountMills: 4000n,
      creatorNetAmountMills: 4000n,
      occurredAt: new Date("2026-03-10T00:00:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, onlyFansPage.id);

    const report = await getPageRevenueReport(createTestAppContext(testDb), onlyFansPage.label, {
      period: "30d",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    const rollupRows = await testDb.pool.query(`
      select business_date::text as business_date,
             creator_net_amount_mills as net_amount_mills
      from revenue_daily
      where platform_account_id = ${onlyFansPage.id}
      order by business_date asc
    `);

    expect(report.from).toBe("2026-02-07T00:00:00.000Z");
    expect(report.to).toBe("2026-03-10T00:00:00.000Z");
    expect(report.revenueMills).toBe(6000);
    expect(report.adjustmentMills).toBe(0);
    expect(report.unclassifiedMills).toBe(0);
    expect(report.netEarningsMills).toBe(6000);
    expect(report.totalNetMills).toBe(6000);
    expect(report.totalNetMills).toBe(report.netEarningsMills);
    expect(report.breakdown).toEqual([
      {
        canonicalType: "tip",
        bucket: "revenue",
        netAmountMills: 6000,
      },
    ]);
    expect(rollupRows.rows).toEqual([
      {
        business_date: "2026-02-06",
        net_amount_mills: 500n,
      },
      {
        business_date: "2026-02-07",
        net_amount_mills: 6000n,
      },
      {
        business_date: "2026-03-10",
        net_amount_mills: 4000n,
      },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const dailyResponse = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${onlyFansPage.label}/revenue/daily?period=30d`,
      headers: { cookie },
    });

    expect(dailyResponse.statusCode).toBe(200);
    expect(dailyResponse.json().series).toEqual([
      {
        businessDate: "2026-02-07",
        netAmountMills: 6000,
        transactionCount: 3,
      },
    ]);
  });

  it("uses UTC day boundaries for Fansly December 2025 revenue and spender reporting", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
      username: "buyer",
      displayName: "Buyer One",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: fixture.lilyPage.id,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lilyPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "lily-december-main",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 350376n,
      sourceDestinationAmountMills: 350376n,
      creatorNetAmountMills: 350376n,
      occurredAt: new Date("2025-12-15T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lilyPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "lily-boundary-january",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 19199n,
      sourceDestinationAmountMills: 19199n,
      creatorNetAmountMills: 19199n,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lilyPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "lily-boundary-november",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 8000n,
      sourceDestinationAmountMills: 8000n,
      creatorNetAmountMills: 8000n,
      occurredAt: new Date("2025-11-30T21:30:00.000Z"),
    });

    await rebuildRevenueRollups(testDb.db, fixture.lilyPage.id);
    await recalculateFanPageSpend(testDb.db, fixture.lilyPage.id);

    const report = await getPageRevenueReport(createTestAppContext(testDb), fixture.lilyPage.label, {
      period: "custom",
      custom: {
        from: "2025-12-01",
        to: "2026-01-01",
      },
    });
    const modelReport = await getModelRevenueReport(createTestAppContext(testDb), "lily-model", {
      period: "custom",
      custom: {
        from: "2025-12-01",
        to: "2026-01-01",
      },
    });
    const rollupRows = await testDb.pool.query(`
      select business_date::text as business_date,
             creator_net_amount_mills as net_amount_mills
      from revenue_daily
      where platform_account_id = ${fixture.lilyPage.id}
        and business_date between '2025-11-30'::date and '2026-01-01'::date
      order by business_date asc
    `);

    expect(report.from).toBe("2025-12-01T00:00:00.000Z");
    expect(report.to).toBe("2026-01-01T00:00:00.000Z");
    expect(report.revenueMills).toBe(350376);
    expect(report.netEarningsMills).toBe(350376);
    expect(report.totalNetMills).toBe(350376);
    expect(modelReport.netEarningsMills).toBe(350376);
    expect(modelReport.totalNetMills).toBe(350376);
    expect(rollupRows.rows).toEqual([
      {
        business_date: "2025-11-30",
        net_amount_mills: 8000n,
      },
      {
        business_date: "2025-12-15",
        net_amount_mills: 350376n,
      },
      {
        business_date: "2026-01-01",
        net_amount_mills: 19199n,
      },
    ]);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const spenderList = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lily1&period=custom&from=2025-12-01&to=2026-01-01&limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });
    const spenderSeries = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001/series?scope=page&pageLabel=lily1&period=custom&from=2025-11-30&to=2025-12-02&granularity=day",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(spenderList.statusCode).toBe(200);
    expect(spenderList.json()).toMatchObject({
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2025-12-01",
        toBusinessDateInclusive: "2025-12-31",
      },
      diagnostics: {
        totalCreatorNetAmountMills: 350376,
        attributedCreatorNetAmountMills: 350376,
        unattributedCreatorNetAmountMills: 0,
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
          },
          metrics: {
            window: {
              creatorNetAmountMills: 350376,
              grossAmountMills: 350376,
            },
          },
        },
      ],
    });

    expect(spenderSeries.statusCode).toBe(200);
    expect(spenderSeries.json()).toMatchObject({
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2025-11-30",
        toBusinessDateInclusive: "2025-12-01",
      },
      items: [
        {
          fromBusinessDate: "2025-11-30",
          toBusinessDateInclusive: "2025-11-30",
          metrics: {
            creatorNetAmountMills: 8000,
            grossAmountMills: 8000,
          },
        },
        {
          fromBusinessDate: "2025-12-01",
          toBusinessDateInclusive: "2025-12-01",
          metrics: {
            creatorNetAmountMills: 0,
            grossAmountMills: 0,
          },
        },
      ],
    });
  });

  it("uses occurred_at instead of transactions.created_at in revenue and page transaction reporting", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const createdAtPage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "created-at-check",
    });
    await updatePageMetadata(testDb.db, createdAtPage.id, {
      platformAccountIdValue: "acct-created-at-check",
      username: "created_at_check",
      displayName: "Created At Check",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-created-at",
      username: "created-at-fan",
      displayName: "Created At Fan",
    }]);
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: createdAtPage.id,
      isFollower: false,
      isSubscriber: false,
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "tx-newer-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2000n,
      sourceDestinationAmountMills: 2000n,
      creatorNetAmountMills: 2000n,
      occurredAt: new Date("2026-03-05T12:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: createdAtPage.id,
      source: "onlymonster",
      fanId: fan.id,
      transactionId: "tx-older-occurred",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 1000n,
      sourceDestinationAmountMills: 1000n,
      creatorNetAmountMills: 1000n,
      occurredAt: new Date("2026-01-15T12:00:00.000Z"),
    });

    await testDb.pool.query(
      `
        update transactions
        set created_at = $1
        where platform_account_id = $2
      `,
      [new Date("2026-04-01T00:00:00.000Z"), createdAtPage.id],
    );

    await rebuildRevenueRollups(testDb.db, createdAtPage.id);
    await recalculateFanPageSpend(testDb.db, createdAtPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const revenue = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/revenue?period=custom&from=2026-03-01&to=2026-03-31",
      headers: {
        cookie,
      },
    });
    expect(revenue.statusCode).toBe(200);
    expect(revenue.json().totalNetMills).toBe(2000);
    expect(revenue.json().breakdown).toEqual([
      {
        bucket: "revenue",
        canonicalType: "tip",
        netAmountMills: 2000,
      },
    ]);

    const transactions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/transactions?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(transactions.statusCode).toBe(200);
    expect(transactions.json().items.map((row: { transactionId: string }) => row.transactionId)).toEqual([
      "tx-newer-occurred",
      "tx-older-occurred",
    ]);

    const fans = await server.inject({
      method: "GET",
      url: "/api/v1/pages/created-at-check/fans?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(fans.statusCode).toBe(200);
    expect(fans.json().items[0]).toMatchObject({
      platformUserId: "fan-created-at",
      totalCreatorNetMills: 3000,
      lastTransactionAt: "2026-03-05T12:00:00.000Z",
    });
  });

  it("lists payout reversals in the transaction ledger", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const allTransactions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/transactions?limit=10&offset=0",
      headers: {
        cookie,
      },
    });
    expect(allTransactions.statusCode).toBe(200);
    expect(allTransactions.json().items.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(true);

    const reversalsOnly = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/transactions?limit=10&offset=0&type=payout_reversal",
      headers: {
        cookie,
      },
    });
    expect(reversalsOnly.statusCode).toBe(200);
    expect(reversalsOnly.json().items).toHaveLength(1);
    expect(reversalsOnly.json().items[0]?.transactionId).toBe("tx-reversal");
  });

  it("rejects invalid custom period requests with 400 responses", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const missingDates = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom",
      headers: {
        cookie,
      },
    });
    expect(missingDates.statusCode).toBe(400);

    const malformedDate = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-02-30&to=2026-03-01",
      headers: {
        cookie,
      },
    });
    expect(malformedDate.statusCode).toBe(400);

    const reversedRange = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/revenue?period=custom&from=2026-03-10&to=2026-03-01",
      headers: {
        cookie,
      },
    });
    expect(reversedRange.statusCode).toBe(400);
  });

  it("limits cross-page fan visibility for team leads and exposes full scope for owners", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const leadFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(leadFan.statusCode).toBe(200);
    expect(leadFan.json()).toMatchObject({
      platformTotalSpendMills: 7000,
    });
    expect(leadFan.json().pages).toHaveLength(1);
    expect(leadFan.json().pages[0]?.pageLabel).toBe("lana");

    const deniedPage = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans/fan-001",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(deniedPage.statusCode).toBe(403);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const ownerFan = await server.inject({
      method: "GET",
      url: "/api/v1/fans/fansly/fan-001",
      headers: {
        cookie: ownerCookie,
      },
    });
    expect(ownerFan.statusCode).toBe(200);
    expect(ownerFan.json().pages).toHaveLength(2);
  });

  it("stores fan profile versions via chatter API key and exposes latest plus history with page scoping", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const firstWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        body: "## First profile\n\n- warm\n- engaged",
      },
    });
    expect(firstWrite.statusCode).toBe(200);
    expect(firstWrite.json()).toMatchObject({
      version: 1,
      source: "chatmuse",
      createdByUserId: expect.any(Number),
    });

    const secondWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        body: "## Second profile\n\n**Closer-ready**",
      },
    });
    expect(secondWrite.statusCode).toBe(200);
    expect(secondWrite.json()).toMatchObject({
      version: 2,
      source: "chatmuse",
      body: "## Second profile\n\n**Closer-ready**",
    });

    const latestByBearer = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(latestByBearer.statusCode).toBe(200);
    expect(latestByBearer.json()).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      profile: {
        version: 2,
        body: "## Second profile\n\n**Closer-ready**",
      },
    });

    const latestByLead = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(latestByLead.statusCode).toBe(200);
    expect(latestByLead.json().profile?.version).toBe(2);

    const versions = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile/versions",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().items).toEqual([
      {
        version: 2,
        createdAt: expect.any(String),
        isCurrent: true,
      },
      {
        version: 1,
        createdAt: expect.any(String),
        isCurrent: false,
      },
    ]);

    const versionOne = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile/versions/1",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(versionOne.statusCode).toBe(200);
    expect(versionOne.json()).toMatchObject({
      version: 1,
      body: "## First profile\n\n- warm\n- engaged",
      source: "chatmuse",
    });

    const historyDeniedForBearer = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile/versions",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(historyDeniedForBearer.statusCode).toBe(403);

    const detailDeniedForBearer = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile/versions/1",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(detailDeniedForBearer.statusCode).toBe(403);

    const writeDeniedOnHiddenPage = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lily1/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        body: "## Wrong page",
      },
    });
    expect(writeDeniedOnHiddenPage.statusCode).toBe(403);

    const readDeniedOnHiddenPage = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(readDeniedOnHiddenPage.statusCode).toBe(403);
  });

  it("auto-creates OnlyFans fans with page memberships on profile PUT while keeping Fansly and reads strict", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const ofModel = await createModel(appContext.db, { slug: "lora-of-model", name: "Lora OF" });
    await createOnlyFansPage(appContext.db, { modelId: ofModel.id, label: "lora-of" });
    await assignPageToUser(appContext, { username: "anton", pageLabel: "lana" }, { source: "cli" });
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lora-of",
    }, { source: "cli" });

    // Reads stay strict: a fan core's sync has never seen still 404s on GET.
    const readUnknown = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lora-of/fans/999777/profile",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(readUnknown.statusCode).toBe(404);

    const firstWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lora-of/fans/999777/profile",
      headers: { authorization: `Bearer ${key}` },
      payload: { body: "## Fresh OnlyFans non-spender" },
    });
    expect(firstWrite.statusCode).toBe(200);
    expect(firstWrite.json()).toMatchObject({
      version: 1,
      source: "chatmuse",
      body: "## Fresh OnlyFans non-spender",
    });

    const secondWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lora-of/fans/999777/profile",
      headers: { authorization: `Bearer ${key}` },
      payload: { body: "## Updated" },
    });
    expect(secondWrite.statusCode).toBe(200);
    expect(secondWrite.json()).toMatchObject({ version: 2 });

    const created = await testDb.pool.query<{
      platform: string;
      username: string | null;
      membership_count: string;
    }>(`
      select f.platform::text,
             f.username,
             count(pf.id)::text as membership_count
      from fans f
      left join page_fans pf on pf.fan_id = f.id
      where f.platform = 'onlyfans' and f.platform_user_id = '999777'
      group by f.id
    `);
    expect(created.rows).toEqual([
      { platform: "onlyfans", username: null, membership_count: "1" },
    ]);

    const readAfterWrite = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lora-of/fans/999777/profile",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(readAfterWrite.statusCode).toBe(200);
    expect(readAfterWrite.json()).toMatchObject({
      fan: {
        platform: "onlyfans",
        platformUserId: "999777",
        username: null,
      },
      profile: { version: 2 },
    });

    // Fansly pages keep the strict 404 — their sync covers DM fans already.
    const fanslyWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lana/fans/fan-404/profile",
      headers: { authorization: `Bearer ${key}` },
      payload: { body: "## Should not be created" },
    });
    expect(fanslyWrite.statusCode).toBe(404);
    const fanslyFan = await testDb.pool.query(
      "select 1 from fans where platform = 'fansly' and platform_user_id = 'fan-404'",
    );
    expect(fanslyFan.rowCount).toBe(0);

    // Fans flagged deleted by sync stay 404 without side effects: no membership
    // row appears behind the not-found response.
    await upsertFans(appContext.db, [{
      platform: "onlyfans",
      platformUserId: "888666",
      deletedDetectedAt: new Date(),
    }]);
    const deletedWrite = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lora-of/fans/888666/profile",
      headers: { authorization: `Bearer ${key}` },
      payload: { body: "## Should not be created" },
    });
    expect(deletedWrite.statusCode).toBe(404);
    const deletedMemberships = await testDb.pool.query(`
      select 1
      from page_fans pf
      inner join fans f on f.id = pf.fan_id
      where f.platform = 'onlyfans' and f.platform_user_id = '888666'
    `);
    expect(deletedMemberships.rowCount).toBe(0);
  });

  it("returns null when no profile exists and resolves conversation-scoped profile reads", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await seedConversationApiFixture({
      testDb,
      pageId: fixture.lanaPage.id,
    });

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: null,
      platformConversationId: "conversation-unmapped",
      partnerPlatformUserId: "ghost-fan",
      partnerUsername: "ghost_fan",
      partnerDisplayName: "Ghost Fan",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "conversation-msg-unmapped",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T10:00:00.000Z"),
      lastMessageSenderId: "ghost-fan",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "still here?",
      lastFanMessageAt: new Date("2026-03-18T10:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const latestFanProfile = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(latestFanProfile.statusCode).toBe(200);
    expect(latestFanProfile.json()).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      profile: null,
    });

    const latestConversationProfile = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/profile",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(latestConversationProfile.statusCode).toBe(200);
    expect(latestConversationProfile.json()).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      profile: null,
    });

    const missingConversation = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/missing/profile",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(missingConversation.statusCode).toBe(404);

    const unmappedConversation = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-unmapped/profile",
      headers: {
        cookie: leadCookie,
      },
    });
    expect(unmappedConversation.statusCode).toBe(404);

    const writeProfile = await server.inject({
      method: "PUT",
      url: "/api/v1/pages/lana/fans/fan-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        body: "## Conversation-aware profile\n\n---\n\nOpen loop: last asked for a bundle.",
      },
    });
    expect(writeProfile.statusCode).toBe(200);
    expect(writeProfile.json().version).toBe(1);

    const conversationByBearer = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/profile",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(conversationByBearer.statusCode).toBe(200);
    expect(conversationByBearer.json()).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      profile: {
        version: 1,
        body: "## Conversation-aware profile\n\n---\n\nOpen loop: last asked for a bundle.",
      },
    });
  });

  it("lists v2 spenders with scoped diagnostics and no hidden-page leakage", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture!.lanaPage.id,
      source: "onlymonster",
      fanId: null,
      transactionId: "tx-unattributed-v2",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 500n,
      sourceDestinationAmountMills: 500n,
      creatorNetAmountMills: 500n,
      occurredAt: new Date("2026-03-06T18:00:00.000Z"),
    });
    await rebuildRevenueRollups(testDb.db, fixture!.lanaPage.id);
    await testDb.pool.query(`
      insert into revenue_daily (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state,
        transaction_count,
        gross_amount_mills,
        creator_net_amount_mills,
        updated_at
      )
      values (
        ${fixture!.lanaPage.id},
        '2026-03-06',
        'payout_reversal'::transaction_type,
        'posted'::transaction_state,
        1,
        2000,
        2000,
        now()
      )
    `);

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=agency&platform=fansly&period=30d&limit=10&offset=0",
      headers: {
        cookie: leadCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: {
        kind: "agency",
        platform: "fansly",
        pageCount: 1,
      },
      diagnostics: {
        totalGrossAmountMills: 7500,
        totalCreatorNetAmountMills: 7500,
        attributedGrossAmountMills: 7000,
        attributedCreatorNetAmountMills: 7000,
        unattributedGrossAmountMills: 500,
        unattributedCreatorNetAmountMills: 500,
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "buyer",
            displayName: "Buyer One",
          },
          metrics: {
            window: {
              grossAmountMills: 7000,
              creatorNetAmountMills: 7000,
              postedGrossAmountMills: 5000,
              pendingGrossAmountMills: 2000,
              unknownGrossAmountMills: 0,
              postedCreatorNetAmountMills: 5000,
              pendingCreatorNetAmountMills: 2000,
              unknownCreatorNetAmountMills: 0,
              transactionCount: 2,
            },
            lifetime: {
              scopeGrossAmountMills: 7000,
              scopeCreatorNetAmountMills: 7000,
              platformGrossAmountMills: 7000,
              platformCreatorNetAmountMills: 7000,
            },
          },
        },
      ],
      total: 1,
    });
    expect(response.json().period.timeZone).toBe("UTC");
    expect(response.json().period.asOf).toBeTruthy();
    expect(response.json().items[0].fan.fanId).toBeUndefined();
  });

  it("lists v2 spenders with page-scope lifetime totals and visible-platform lifetime totals", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&platform=fansly&period=30d&limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      fan: {
        platformUserId: "fan-001",
      },
      metrics: {
        lifetime: {
          scopeGrossAmountMills: 7000,
          scopeCreatorNetAmountMills: 7000,
          platformGrossAmountMills: 10000,
          platformCreatorNetAmountMills: 10000,
        },
      },
    });
  });

  it("lists page spender auto-list buckets from lifetime gross spend", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const [zeroFan, subCentFan, oneCentFan, nonFollowerFan, deletedFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-zero",
        username: "zero",
        displayName: "Zero Spend",
      },
      {
        platform: "fansly",
        platformUserId: "fan-sub-cent",
        username: "sub_cent",
        displayName: "Sub Cent",
      },
      {
        platform: "fansly",
        platformUserId: "fan-one-cent",
        username: "one_cent",
        displayName: "One Cent",
      },
      {
        platform: "fansly",
        platformUserId: "fan-non-follower",
        username: "non_follower",
        displayName: "Non Follower",
      },
      {
        platform: "fansly",
        platformUserId: "fan-deleted",
        username: "deleted_before",
        displayName: "Deleted Before",
      },
    ]);
    for (const fan of [zeroFan, subCentFan, oneCentFan, deletedFan]) {
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: fixture.lanaPage.id,
        isFollower: true,
        isSubscriber: false,
      });
    }
    await upsertFanPage(testDb.db, {
      fanId: nonFollowerFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: false,
      isSubscriber: false,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: subCentFan.id,
      transactionId: "tx-sub-cent-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 5n,
      sourceDestinationAmountMills: 5n,
      creatorNetAmountMills: 5n,
      occurredAt: new Date("2026-03-06T14:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: oneCentFan.id,
      transactionId: "tx-one-cent-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 10n,
      sourceDestinationAmountMills: 10n,
      creatorNetAmountMills: 10n,
      occurredAt: new Date("2026-03-06T14:01:00.000Z"),
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-non-follower-expired",
      platformAccountId: fixture.lanaPage.id,
      fanId: nonFollowerFan.id,
      rawStatus: 4,
      canonicalStatus: "expired",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: nonFollowerFan.id,
      transactionId: "tx-non-follower-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 20000n,
      sourceDestinationAmountMills: 20000n,
      creatorNetAmountMills: 20000n,
      occurredAt: new Date("2026-03-06T14:02:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: deletedFan.id,
      transactionId: "tx-deleted-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 15000n,
      sourceDestinationAmountMills: 15000n,
      creatorNetAmountMills: 15000n,
      occurredAt: new Date("2026-03-06T14:03:00.000Z"),
    });
    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-deleted",
      metadata: {},
      deletedDetectedAt: new Date("2026-03-07T10:00:00.000Z"),
    }]);
    await recalculateFanPageSpend(testDb.db, fixture.lanaPage.id);

    const ownerCookie = await loginOwnerCookie(server);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/spender-autolists",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: {
        label: "lana",
        platform: "fansly",
      },
      currency: "USD",
      metric: "lifetimeGrossAmountMills",
      totalEntries: 3,
      lists: [
        {
          key: "0-25",
          label: "[FB] $0-$25 Spenders",
          minAmountMills: 10,
          maxAmountMillsExclusive: 25000,
          entryCount: 3,
        },
        {
          key: "25-50",
          label: "[FB] $25-$50 Spenders",
          minAmountMills: 25000,
          maxAmountMillsExclusive: 50000,
          entryCount: 0,
        },
        {
          key: "50-150",
          label: "[FB] $50-$150 Spenders",
          minAmountMills: 50000,
          maxAmountMillsExclusive: 150000,
          entryCount: 0,
        },
        {
          key: "150-350",
          label: "[FB] $150-$350 Spenders",
          minAmountMills: 150000,
          maxAmountMillsExclusive: 350000,
          entryCount: 0,
        },
        {
          key: "350-600",
          label: "[FB] $350-$600 Spenders",
          minAmountMills: 350000,
          maxAmountMillsExclusive: 600000,
          entryCount: 0,
        },
        {
          key: "600-plus",
          label: "[FB] $600+ Spenders",
          minAmountMills: 600000,
          maxAmountMillsExclusive: null,
          entryCount: 0,
        },
      ],
    });
    expect(response.json().asOf).toBeTruthy();

    const detailResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/spender-autolists/0-25?limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      page: {
        label: "lana",
        platform: "fansly",
      },
      bucket: {
        key: "0-25",
        minAmountMills: 10,
        maxAmountMillsExclusive: 25000,
        entryCount: 3,
      },
      total: 3,
      limit: 10,
      offset: 0,
    });
    expect(detailResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId)).toEqual([
      "fan-non-follower",
      "fan-001",
      "fan-one-cent",
    ]);
    expect(detailResponse.json().items[0]).toMatchObject({
      fan: {
        platformUserId: "fan-non-follower",
      },
      isFollower: false,
      isSubscriber: false,
      subscriptionStatus: "expired",
      subscriptionExpiresAt: null,
      lastSubscriptionEndedAt: "2026-02-01T00:00:00.000Z",
    });

    const followerOnlyDetailResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/spender-autolists/0-25?limit=10&offset=0&excludeNonFollowers=true",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(followerOnlyDetailResponse.statusCode).toBe(200);
    expect(followerOnlyDetailResponse.json()).toMatchObject({
      bucket: {
        key: "0-25",
        entryCount: 2,
      },
      total: 2,
    });
    expect(followerOnlyDetailResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId)).toEqual([
      "fan-001",
      "fan-one-cent",
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    try {
      const todayBucketsResponse = await server.inject({
        method: "GET",
        url: "/api/v1/pages/lana/spender-autolists?period=today",
        headers: {
          cookie: ownerCookie,
        },
      });

      expect(todayBucketsResponse.statusCode).toBe(200);
      expect(todayBucketsResponse.json()).toMatchObject({
        metric: "grossAmountMills",
        totalEntries: 0,
        period: {
          fromBusinessDate: "2026-03-08",
          toBusinessDateInclusive: "2026-03-08",
        },
      });

      const todayDetailResponse = await server.inject({
        method: "GET",
        url: "/api/v1/pages/lana/spender-autolists/0-25?period=today&limit=10&offset=0",
        headers: {
          cookie: ownerCookie,
        },
      });

      expect(todayDetailResponse.statusCode).toBe(200);
      expect(todayDetailResponse.json()).toMatchObject({
        metric: "grossAmountMills",
        total: 0,
        items: [],
      });
    } finally {
      vi.useRealTimers();
    }

    const deletedFansResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/deleted-fans?limit=10&offset=0",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(deletedFansResponse.statusCode).toBe(200);
    expect(deletedFansResponse.json()).toMatchObject({
      total: 1,
      items: [{
        platformUserId: "fan-deleted",
        latestKnownLabel: "deleted_before",
        latestHistoricalUsername: "deleted_before",
        deletedDetectedAt: "2026-03-07T10:00:00.000Z",
      }],
    });
  });

  it("preserves spender totals when paginating past the last row", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const windowResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=10",
      headers: {
        cookie: ownerCookie,
      },
    });
    const lifetimeResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=10&offset=10",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(windowResponse.statusCode).toBe(200);
    expect(windowResponse.json()).toMatchObject({
      total: 1,
      items: [],
    });

    expect(lifetimeResponse.statusCode).toBe(200);
    expect(lifetimeResponse.json()).toMatchObject({
      total: 1,
      items: [],
    });
  });

  it("rejects invalid spender period combinations with 400 (audit B5)", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    // Audit repro 1: period=custom without bounds used to escape validation
    // and 500 in the period resolver.
    const missingBounds = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=custom&limit=10&offset=0",
      headers: { cookie: ownerCookie },
    });
    expect(missingBounds.statusCode).toBe(400);

    // Audit repro 2: stray from/to on a non-custom period used to return 200.
    const strayBounds = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=7d&from=2026-01-01&to=2026-01-31&limit=10&offset=0",
      headers: { cookie: ownerCookie },
    });
    expect(strayBounds.statusCode).toBe(400);

    // Scope cross-field rule, also dropped by the old merge chain.
    const missingPageLabel = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&period=30d&limit=10&offset=0",
      headers: { cookie: ownerCookie },
    });
    expect(missingPageLabel.statusCode).toBe(400);
  });

  it("filters v2 spenders by retention status and exposes activity timestamps", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const [activeFan, coolingFan, inactiveFan, reactivationFan, deletedFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-retention-active",
        username: "active_buyer",
        displayName: "Active Buyer",
      },
      {
        platform: "fansly",
        platformUserId: "fan-retention-cooling",
        username: "cooling_buyer",
        displayName: "Cooling Buyer",
      },
      {
        platform: "fansly",
        platformUserId: "fan-retention-inactive",
        username: "inactive_buyer",
        displayName: "Inactive Buyer",
      },
      {
        platform: "fansly",
        platformUserId: "fan-retention-reactivate",
        username: "reactivate_buyer",
        displayName: "Reactivate Buyer",
      },
      {
        platform: "fansly",
        platformUserId: "fan-retention-deleted",
        metadata: {},
        deletedDetectedAt: new Date("2026-05-20T12:00:00.000Z"),
      },
    ]);

    for (const fan of [activeFan, coolingFan, inactiveFan, reactivationFan, deletedFan]) {
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: fixture.lanaPage.id,
        isFollower: true,
        isSubscriber: false,
      });
    }

    // Active: bought 2 days ago, low value
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: activeFan.id,
      transactionId: "tx-retention-active",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 2_000n,
      sourceDestinationAmountMills: 2_000n,
      creatorNetAmountMills: 2_000n,
      occurredAt: new Date("2026-05-25T12:00:00.000Z"),
    });

    // Cooling: bought 30 days ago
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: coolingFan.id,
      transactionId: "tx-retention-cooling",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 3_000n,
      sourceDestinationAmountMills: 3_000n,
      creatorNetAmountMills: 3_000n,
      occurredAt: new Date("2026-04-27T12:00:00.000Z"),
    });

    // Inactive low-value: bought 90 days ago, < $100 lifetime
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: inactiveFan.id,
      transactionId: "tx-retention-inactive",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 4_000n,
      occurredAt: new Date("2026-02-15T12:00:00.000Z"),
    });

    // Needs reactivation: bought 90 days ago, > $100 lifetime
    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: reactivationFan.id,
      transactionId: "tx-retention-reactivate",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 150_000n,
      sourceDestinationAmountMills: 150_000n,
      creatorNetAmountMills: 150_000n,
      occurredAt: new Date("2026-02-15T12:00:00.000Z"),
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      source: "onlymonster",
      fanId: deletedFan.id,
      transactionId: "tx-retention-deleted",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 900_000n,
      sourceDestinationAmountMills: 900_000n,
      creatorNetAmountMills: 900_000n,
      occurredAt: new Date("2026-05-25T12:00:00.000Z"),
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: reactivationFan.id,
      platformConversationId: "conversation-retention-reactivate",
      partnerPlatformUserId: "fan-retention-reactivate",
      partnerUsername: "reactivate_buyer",
      partnerDisplayName: "Reactivate Buyer",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-retention-reactivate",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-05-26T18:54:00.000Z"),
      lastMessageSenderId: "fan-retention-reactivate",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "beach or hike - which one wins for you?",
      lastFanMessageAt: new Date("2026-05-26T18:54:00.000Z"),
      lastModelMessageAt: null,
      lastSeenGeneration: 1,
    });

    await recalculateFanPageSpend(testDb.db, fixture.lanaPage.id);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));

    try {
      const ownerCookie = await loginOwnerCookie(server);

      const allResponse = await server.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=50&offset=0",
        headers: { cookie: ownerCookie },
      });
      expect(allResponse.statusCode).toBe(200);
      const allBody = allResponse.json();
      const allIds = allBody.items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId).sort();
      expect(allIds).toContain("fan-retention-active");
      expect(allIds).toContain("fan-retention-cooling");
      expect(allIds).toContain("fan-retention-inactive");
      expect(allIds).toContain("fan-retention-reactivate");
      expect(allIds).not.toContain("fan-retention-deleted");
      const reactivateRow = allBody.items.find((item: { fan: { platformUserId: string } }) => item.fan.platformUserId === "fan-retention-reactivate");
      expect(reactivateRow.retentionStatus).toBe("needs_reactivation");
      expect(reactivateRow.lifetimeLastTransactionAt).toBe("2026-02-15T12:00:00.000Z");
      expect(reactivateRow.lastFanMessageAt).toBe("2026-05-26T18:54:00.000Z");
      expect(reactivateRow.conversation).toMatchObject({
        platformConversationId: "conversation-retention-reactivate",
        unreadCount: 0,
        lastMessageAt: "2026-05-26T18:54:00.000Z",
        lastFanMessageAt: "2026-05-26T18:54:00.000Z",
        lastModelMessageAt: null,
        lastMessagePreview: "beach or hike - which one wins for you?",
      });
      expect(reactivateRow.lastTransaction).toMatchObject({
        canonicalType: "tip",
        transactionState: "posted",
        creatorNetAmountMills: 150_000,
        occurredAt: "2026-02-15T12:00:00.000Z",
      });

      const activeResponse = await server.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=50&offset=0&retentionStatus=active",
        headers: { cookie: ownerCookie },
      });
      expect(activeResponse.statusCode).toBe(200);
      const activeIds = activeResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId);
      expect(activeIds).toEqual(["fan-retention-active"]);
      expect(activeResponse.json().total).toBe(1);

      const coolingResponse = await server.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=50&offset=0&retentionStatus=cooling",
        headers: { cookie: ownerCookie },
      });
      expect(coolingResponse.statusCode).toBe(200);
      const coolingIds = coolingResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId).sort();
      // fan-001 from the shared fixture last bought 2026-03-07 (~80 days ago) — not cooling.
      expect(coolingIds).toEqual(["fan-retention-cooling"]);

      const inactiveResponse = await server.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=50&offset=0&retentionStatus=inactive",
        headers: { cookie: ownerCookie },
      });
      expect(inactiveResponse.statusCode).toBe(200);
      const inactiveIds = inactiveResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId).sort();
      // fan-001 lifetime is $7 net (< $100), so it lands in inactive too.
      expect(inactiveIds).toEqual(["fan-001", "fan-retention-inactive"]);

      const reactivationResponse = await server.inject({
        method: "GET",
        url: "/api/v2/spenders?scope=page&pageLabel=lana&period=lifetime&limit=50&offset=0&retentionStatus=needs_reactivation",
        headers: { cookie: ownerCookie },
      });
      expect(reactivationResponse.statusCode).toBe(200);
      const reactivationIds = reactivationResponse.json().items.map((item: { fan: { platformUserId: string } }) => item.fan.platformUserId);
      expect(reactivationIds).toEqual(["fan-retention-reactivate"]);
      expect(reactivationResponse.json().total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves v2 spender detail with visible-platform totals and scoped page breakdowns", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    const expectedTypeBreakdown = [
      {
        canonicalType: "subscription",
        grossAmountMills: 5000,
        creatorNetAmountMills: 5000,
        transactionCount: 1,
      },
      {
        canonicalType: "tip",
        grossAmountMills: 2000,
        creatorNetAmountMills: 2000,
        transactionCount: 1,
      },
    ];

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001?scope=page&pageLabel=lana&period=30d",
      headers: {
        cookie: leadCookie,
      },
    });

    expect(leadResponse.statusCode).toBe(200);
    expect(leadResponse.json()).toMatchObject({
      scope: {
        kind: "page",
        platform: "fansly",
      },
      metrics: {
        lifetime: {
          scopeGrossAmountMills: 7000,
          scopeCreatorNetAmountMills: 7000,
          platformGrossAmountMills: 7000,
          platformCreatorNetAmountMills: 7000,
        },
      },
      typeBreakdown: expectedTypeBreakdown,
    });
    expect(leadResponse.json().pages).toHaveLength(1);
    expect(leadResponse.json().pages[0]).toMatchObject({
      pageLabel: "lana",
      inScope: true,
      creatorNetAmountMills: 7000,
    });
    expect(leadResponse.json().typeBreakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001?scope=page&pageLabel=lana&period=30d",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.json().metrics.lifetime).toMatchObject({
      scopeGrossAmountMills: 7000,
      scopeCreatorNetAmountMills: 7000,
      platformGrossAmountMills: 10000,
      platformCreatorNetAmountMills: 10000,
    });
    expect(ownerResponse.json().typeBreakdown).toEqual(expectedTypeBreakdown);
    expect(ownerResponse.json().pages).toHaveLength(2);
    expect(ownerResponse.json().pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pageLabel: "lana",
        inScope: true,
        creatorNetAmountMills: 7000,
      }),
      expect.objectContaining({
        pageLabel: "lily1",
        inScope: false,
        creatorNetAmountMills: 3000,
      }),
    ]));
    expect(ownerResponse.json().typeBreakdown.some((row: { canonicalType: string }) => row.canonicalType === "payout_reversal")).toBe(false);
    expect(ownerResponse.json().fan.fanId).toBeUndefined();
  });

  it("returns zero-filled v2 spender day series buckets", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);
    const response = await server.inject({
      method: "GET",
      url: "/api/v2/spenders/fansly/fan-001/series?scope=page&pageLabel=lana&period=custom&from=2026-03-04&to=2026-03-08&granularity=day",
      headers: {
        cookie: ownerCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      granularity: "day",
      period: {
        timeZone: "UTC",
        fromBusinessDate: "2026-03-04",
        toBusinessDateInclusive: "2026-03-07",
      },
    });
    expect(response.json().items).toEqual([
      {
        fromBusinessDate: "2026-03-04",
        toBusinessDateInclusive: "2026-03-04",
        metrics: {
          grossAmountMills: 0,
          creatorNetAmountMills: 0,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 0,
          lastTransactionAt: null,
        },
      },
      {
        fromBusinessDate: "2026-03-05",
        toBusinessDateInclusive: "2026-03-05",
        metrics: {
          grossAmountMills: 5000,
          creatorNetAmountMills: 5000,
          postedGrossAmountMills: 5000,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 5000,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 1,
          lastTransactionAt: "2026-03-05T12:00:00.000Z",
        },
      },
      {
        fromBusinessDate: "2026-03-06",
        toBusinessDateInclusive: "2026-03-06",
        metrics: {
          grossAmountMills: 2000,
          creatorNetAmountMills: 2000,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 2000,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 2000,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 1,
          lastTransactionAt: "2026-03-06T12:00:00.000Z",
        },
      },
      {
        fromBusinessDate: "2026-03-07",
        toBusinessDateInclusive: "2026-03-07",
        metrics: {
          grossAmountMills: 0,
          creatorNetAmountMills: 0,
          postedGrossAmountMills: 0,
          pendingGrossAmountMills: 0,
          unknownGrossAmountMills: 0,
          postedCreatorNetAmountMills: 0,
          pendingCreatorNetAmountMills: 0,
          unknownCreatorNetAmountMills: 0,
          transactionCount: 0,
          lastTransactionAt: null,
        },
      },
    ]);
  });

  it("supports alias-aware v2 fan search and page-scoped bearer batch lookups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-03T12:00:00.000Z"));

    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
      username: "spender-renamed",
      displayName: "Renamed Fan",
    }]);

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const search = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&query=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });

    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      scope: {
        kind: "page",
        platform: "fansly",
      },
      items: [
        {
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "spender-renamed",
            displayName: "Renamed Fan",
          },
          matchKind: "alias",
          matchedValue: "buyer",
        },
      ],
    });
    expect(search.json().items[0].fan.fanId).toBeUndefined();
    expect(search.json().items[0].metrics).toBeUndefined();

    const legacySearch = await server.inject({
      method: "GET",
      url: "/api/v2/fans/search?scope=page&pageLabel=lana&q=buyer&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(legacySearch.statusCode).toBe(200);
    expect(legacySearch.json().items).toEqual(search.json().items);

    const spenderList = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=lana&period=30d&limit=10&offset=0",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(spenderList.statusCode).toBe(200);
    expect(spenderList.json().scope).toMatchObject({
      kind: "page",
      platform: "fansly",
    });

    const batch = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "page",
        pageLabel: "lana",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
          { platform: "fansly", platformUserId: "fan-missing" },
        ],
      },
    });

    expect(batch.statusCode).toBe(200);
    expect(batch.json().items).toEqual([
      expect.objectContaining({
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-001",
        },
        found: true,
        metrics: expect.objectContaining({
          window: expect.objectContaining({
            creatorNetAmountMills: 7000,
          }),
          lifetime: {
            scopeGrossAmountMills: 7000,
            scopeCreatorNetAmountMills: 7000,
            platformGrossAmountMills: 7000,
            platformCreatorNetAmountMills: 7000,
          },
        }),
        typeBreakdown: expect.arrayContaining([
          expect.objectContaining({
            canonicalType: expect.any(String),
            grossAmountMills: expect.any(Number),
            creatorNetAmountMills: expect.any(Number),
            transactionCount: expect.any(Number),
          }),
        ]),
        lifetimeLastTransactionAt: expect.any(String),
        subscription: {
          status: "active",
          expiresAt: "2026-03-20T12:00:00.000Z",
          autoRenew: true,
          autoRenewOffDetectedAt: null,
        },
      }),
      {
        requestedFan: {
          platform: "fansly",
          platformUserId: "fan-missing",
        },
        found: false,
        fan: null,
        metrics: null,
        typeBreakdown: null,
        lifetimeLastTransactionAt: null,
        subscription: null,
      },
    ]);

    const forbidden = await server.inject({
      method: "POST",
      url: "/api/v2/spenders:batch",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        scope: "agency",
        platform: "fansly",
        period: "30d",
        fans: [
          { platform: "fansly", platformUserId: "fan-001" },
        ],
      },
    });

    expect(forbidden.statusCode).toBe(403);
  });

  it("treats wildcard characters literally in subscriber, follower, and fan wildcard searches", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const [targetFan, distractorFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-api-wildcard-target",
        username: "wild_100%buyer",
        displayName: "Wildcard Api Target",
      },
      {
        platform: "fansly",
        platformUserId: "fan-api-wildcard-distractor",
        username: "wildX100buyer",
        displayName: "Wildcard Api Distractor",
      },
    ]);

    await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: targetFan.platformUserId,
      username: "api-renamed",
      displayName: "Wildcard Api Target",
    }]);

    for (const [index, fan] of [targetFan, distractorFan].entries()) {
      const followedAt = new Date(`2026-03-0${index + 2}T12:00:00.000Z`);
      const subscriberSince = new Date(`2026-03-0${index + 1}T12:00:00.000Z`);
      const endsAt = new Date(`2026-03-2${index}T12:00:00.000Z`);
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: fixture.lanaPage.id,
        isFollower: true,
        followerSince: followedAt,
        isSubscriber: true,
        subscriberSince,
        subscriptionExpiresAt: endsAt,
        autoRenew: index === 0 ? false : true,
      });
      await upsertPageFollow(testDb.db, {
        platformAccountId: fixture.lanaPage.id,
        fanId: fan.id,
        platformFollowId: `follow-api-wildcard-${index}`,
        followedAt,
      });
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: `sub-api-wildcard-${index}`,
        platformAccountId: fixture.lanaPage.id,
        fanId: fan.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        autoRenew: index === 0 ? false : true,
        sourceCreatedAt: subscriberSince,
        endsAt,
      });
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);
    const encodedQuery = encodeURIComponent("wild_100%");

    const subscriberSearch = await server.inject({
      method: "GET",
      url: `/api/v1/pages/lana/subscribers?query=${encodedQuery}&limit=10&offset=0`,
      headers: { cookie },
    });

    expect(subscriberSearch.statusCode).toBe(200);
    expect(subscriberSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-api-wildcard-target",
        username: "api-renamed",
      }),
    ]);

    const followerSearch = await server.inject({
      method: "GET",
      url: `/api/v1/pages/lana/followers?query=${encodedQuery}&limit=10&offset=0`,
      headers: { cookie },
    });

    expect(followerSearch.statusCode).toBe(200);
    expect(followerSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-api-wildcard-target",
        username: "api-renamed",
      }),
    ]);

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const fanSearch = await server.inject({
      method: "GET",
      url: `/api/v2/fans/search?scope=page&pageLabel=lana&query=${encodedQuery}&limit=10&offset=0`,
      headers: {
        authorization: `Bearer ${key}`,
      },
    });

    expect(fanSearch.statusCode).toBe(200);
    expect(fanSearch.json()).toMatchObject({
      total: 1,
      items: [
        {
          fan: {
            platformUserId: "fan-api-wildcard-target",
            username: "api-renamed",
          },
          matchKind: "alias",
          matchedValue: "wild_100%buyer",
        },
      ],
    });
  });

  it("lists admin models including empty models and rejects non-owner access", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const emptyModel = await createModel(testDb.db, {
      slug: "empty-model",
      name: "Empty Model",
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/models",
      headers: { cookie: ownerCookie },
    });

    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.lanaModel.id,
        slug: "lana-model",
        name: "Lana Model",
        pageCount: 1,
      }),
      expect.objectContaining({
        id: emptyModel.id,
        slug: "empty-model",
        name: "Empty Model",
        pageCount: 0,
      }),
    ]));

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/admin/models",
      headers: { cookie: leadCookie },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: "forbidden",
      message: "Owner access required",
      statusCode: 403,
    });
  });

  it("updates and deletes models through admin CRUD", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "temp-model",
      name: "Temp Model",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const updateResponse = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/models/temp-model",
      headers: { cookie },
      payload: {
        slug: "temp-model-renamed",
        name: "Temp Model Renamed",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toEqual({
      id: expect.any(Number),
      slug: "temp-model-renamed",
      name: "Temp Model Renamed",
    });

    const deleteResponse = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/models/temp-model-renamed",
      headers: { cookie },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({
      deleted: true,
    });

    const rows = await testDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from models
      where slug = 'temp-model-renamed'
    `);
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("returns typed conflicts and not-found errors for admin model CRUD", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    await createModel(testDb.db, {
      slug: "spare-model",
      name: "Spare Model",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const duplicateCreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/models",
      headers: { cookie },
      payload: {
        slug: "lana-model",
        name: "Duplicate Lana",
      },
    });

    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" already exists',
      statusCode: 409,
    });

    const missingUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/models/missing-model",
      headers: { cookie },
      payload: {
        name: "Nope",
      },
    });

    expect(missingUpdate.statusCode).toBe(404);
    expect(missingUpdate.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" not found',
      statusCode: 404,
    });

    const duplicateUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/models/spare-model",
      headers: { cookie },
      payload: {
        slug: "lana-model",
      },
    });

    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateUpdate.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" already exists',
      statusCode: 409,
    });

    const missingDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/models/missing-model",
      headers: { cookie },
    });

    expect(missingDelete.statusCode).toBe(404);
    expect(missingDelete.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" not found',
      statusCode: 404,
    });

    const nonEmptyDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/models/lana-model",
      headers: { cookie },
    });

    expect(nonEmptyDelete.statusCode).toBe(409);
    expect(nonEmptyDelete.json()).toEqual({
      error: "conflict",
      message: 'Model "lana-model" cannot be deleted while it still has 1 page',
      statusCode: 409,
    });
  });

  it("orders admin models by sort_order and lets the owner reorder them", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    // Created in reverse-alphabetical creation order to prove ordering is driven
    // by sort_order (creation order), not the slug.
    await createModel(testDb.db, { slug: "reorder-z", name: "Reorder Z" });
    await createModel(testDb.db, { slug: "reorder-a", name: "Reorder A" });
    const cookie = await loginOwnerCookie(server);

    const before = await server.inject({
      method: "GET",
      url: "/api/v1/admin/models",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    const beforeList = before.json() as Array<{ slug: string; sortOrder: number }>;
    const z = beforeList.find((m) => m.slug === "reorder-z");
    const a = beforeList.find((m) => m.slug === "reorder-a");
    expect(z).toBeDefined();
    expect(a).toBeDefined();
    // New models receive an increasing sort_order, so the earlier-created sorts first.
    expect(z!.sortOrder).toBeLessThan(a!.sortOrder);
    expect(beforeList.findIndex((m) => m.slug === "reorder-z")).toBeLessThan(
      beforeList.findIndex((m) => m.slug === "reorder-a"),
    );

    // Swap their positions through the admin update endpoint.
    for (const update of [
      { slug: "reorder-z", sortOrder: a!.sortOrder },
      { slug: "reorder-a", sortOrder: z!.sortOrder },
    ]) {
      const res = await server.inject({
        method: "PATCH",
        url: `/api/v1/admin/models/${update.slug}`,
        headers: { cookie },
        payload: { sortOrder: update.sortOrder },
      });
      expect(res.statusCode).toBe(200);
    }

    const after = await server.inject({
      method: "GET",
      url: "/api/v1/admin/models",
      headers: { cookie },
    });
    const afterList = after.json() as Array<{ slug: string }>;
    expect(afterList.findIndex((m) => m.slug === "reorder-a")).toBeLessThan(
      afterList.findIndex((m) => m.slug === "reorder-z"),
    );

    for (const slug of ["reorder-a", "reorder-z"]) {
      await server.inject({
        method: "DELETE",
        url: `/api/v1/admin/models/${slug}`,
        headers: { cookie },
      });
    }
  });

  it("lists, updates, and deletes pages through admin CRUD", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const reassignedModel = await createModel(testDb.db, {
      slug: "target-model",
      name: "Target Model",
    });
    await storeFanslySession(
      testDb.db,
      fixture.lanaPage.id,
      JSON.stringify(encryptJson({
        platform: "fansly",
        session: {
          authorization: "seed-token",
        },
      }, Buffer.alloc(32, 7), 1)),
      1,
    );
    await saveProxy(createTestAppContext(testDb), fixture.lanaPage.id, {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const listResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/pages",
      headers: { cookie: ownerCookie },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.lanaPage.id,
        label: "lana",
        modelSlug: "lana-model",
      }),
      expect.objectContaining({
        label: "lily1",
        modelSlug: "lily-model",
      }),
    ]));

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const forbidden = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana",
      headers: { cookie: leadCookie },
      payload: {
        label: "blocked",
      },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      error: "forbidden",
      message: "Owner access required",
      statusCode: 403,
    });

    const updateResponse = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana",
      headers: { cookie: ownerCookie },
      payload: {
        label: "lana-renamed",
        modelSlug: reassignedModel.slug,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      page: {
        id: fixture.lanaPage.id,
        label: "lana-renamed",
        modelSlug: "target-model",
        modelName: "Target Model",
      },
    });

    const pageRows = await testDb.pool.query<{
      label: string;
      model_slug: string;
    }>(`
      select pa.label, m.slug as model_slug
      from pages pa
      join models m on m.id = pa.model_id
      where pa.id = $1
    `, [fixture.lanaPage.id]);

    expect(pageRows.rows[0]).toEqual({
      label: "lana-renamed",
      model_slug: "target-model",
    });

    // Stage 13 soft-delete standard: DELETE tombstones even a fact-bearing
    // page — no 409, no cascade, nothing destroyed. The tombstone is a
    // two-way door: the row, its facts, and its config all remain.
    const deleteResponse = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/lana-renamed",
      headers: { cookie: ownerCookie },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({
      deleted: true,
    });

    const [accountRows, transactionRows, credentialRows, assignmentRows] = await Promise.all([
      testDb.pool.query<{ count: number; status: string | null }>(`
        select count(*)::int as count, min(status) as status
        from pages
        where id = $1
      `, [fixture.lanaPage.id]),
      testDb.pool.query<{ count: number }>(`
        select count(*)::int as count
        from transactions
        where platform_account_id = $1
      `, [fixture.lanaPage.id]),
      testDb.pool.query<{ count: number }>(`
        select count(*)::int as count
        from page_credentials
        where platform_account_id = $1
      `, [fixture.lanaPage.id]),
      testDb.pool.query<{ count: number }>(`
        select count(*)::int as count
        from user_page_assignments
        where platform_account_id = $1
      `, [fixture.lanaPage.id]),
    ]);

    expect(accountRows.rows[0]?.count).toBe(1);
    expect(accountRows.rows[0]?.status).toBe("deleted");
    expect(transactionRows.rows[0]!.count).toBeGreaterThan(0);
    expect(credentialRows.rows[0]!.count).toBeGreaterThan(0);
    expect(assignmentRows.rows[0]!.count).toBeGreaterThan(0);
  });

  it("returns typed conflicts and not-found errors for admin page CRUD", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const missingUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/missing-page",
      headers: { cookie },
      payload: {
        label: "still-missing",
      },
    });

    expect(missingUpdate.statusCode).toBe(404);
    expect(missingUpdate.json()).toEqual({
      error: "not_found",
      message: 'Page "missing-page" not found',
      statusCode: 404,
    });

    const duplicateUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana",
      headers: { cookie },
      payload: {
        label: "lily1",
      },
    });

    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateUpdate.json()).toEqual({
      error: "conflict",
      message: 'Page "lily1" already exists',
      statusCode: 409,
    });

    const missingModelUpdate = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana",
      headers: { cookie },
      payload: {
        modelSlug: "missing-model",
      },
    });

    expect(missingModelUpdate.statusCode).toBe(404);
    expect(missingModelUpdate.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" not found',
      statusCode: 404,
    });

    const missingDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/missing-page",
      headers: { cookie },
    });

    expect(missingDelete.statusCode).toBe(404);
    expect(missingDelete.json()).toEqual({
      error: "not_found",
      message: 'Page "missing-page" not found',
      statusCode: 404,
    });

    await server.close();
    const appContext = createTestAppContext(testDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-duplicate-page",
        username: "duplicate_page_user",
        displayName: "Duplicate Page User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const refreshedLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const refreshedCookie = sessionCookieFrom(refreshedLogin);

    const duplicateCreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie: refreshedCookie },
      payload: {
        platform: "fansly",
        modelSlug: "lana-model",
        label: "lana",
        session: {
          authorization: "token",
        },
      },
    });

    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: "conflict",
      message: 'Page "lana" already exists',
      statusCode: 409,
    });
  });

  it("returns a typed 404 when onboarding references a missing model slug", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "fansly",
        modelSlug: "missing-model",
        label: "ghost-page",
        session: {
          authorization: "token",
        },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "not_found",
      message: 'Model "missing-model" does not exist',
      statusCode: 404,
    });
  });

  it("auto-queues and processes an initial full sync after page creation", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-auto-sync",
        username: "auto_sync_user",
        displayName: "Auto Sync User",
      }),
      syncSharedRateLimitEnabled: true,
    });
    server = await buildApiServer(appContext);
    await server.ready();

    workerBoss = new PgBoss({ connectionString: activeTestDb.connectionString });
    await workerBoss.start();
    await ensureSyncQueues(workerBoss);
    const abortController = new AbortController();
    const executorPromise = startSyncPageExecutor(appContext, workerBoss, {
      signal: abortController.signal,
    });

    try {
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "dima",
          password: "owner-secret",
        },
      });
      const cookie = sessionCookieFrom(login);

      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/pages",
        headers: { cookie },
        payload: {
          platform: "fansly",
          modelSlug: "lana-model",
          label: "auto-sync-page",
          session: {
            authorization: "token",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        page: {
          label: "auto-sync-page",
          platform: "fansly",
          username: "auto_sync_user",
        },
        verified: true,
        syncQueued: true,
        syncWarning: null,
        syncRetry: null,
      });

      const expectedStreams = [
        "light",
        "followers",
        "transactions",
        "subscribers",
        "followers_reconcile",
        "dm_conversations",
        "dm_messages",
        "fan_earnings",
        "purchase_history",
        "top_spenders",
      ] as const;

      await waitForCondition(async () => {
        const rows = await activeTestDb.pool.query<{
          stream: string;
          status: string;
        }>(`
          select sr.stream,
                 case when sr.outcome = 'succeeded' then 'success' else sr.outcome::text end as status
          from sync_runs sr
          join pages pa on pa.id = sr.page_id
          where pa.label = 'auto-sync-page'
          order by sr.stream asc
        `);

        return rows.rows.length === expectedStreams.length
          && rows.rows.every((row) => row.status === "success")
          && expectedStreams.every((stream) => rows.rows.some((row) => row.stream === stream));
      }, 15_000);

      const syncRunRows = await activeTestDb.pool.query<{
        stream: string;
        status: string;
        trigger: string;
      }>(`
        select sr.stream,
               case when sr.outcome = 'succeeded' then 'success' else sr.outcome::text end as status,
               coalesce(sr.source::text, 'scheduled') as trigger
        from sync_runs sr
        join pages pa on pa.id = sr.page_id
        where pa.label = 'auto-sync-page'
        order by sr.stream asc
      `);

      expect(syncRunRows.rows.map((row) => row.stream).sort()).toEqual([...expectedStreams].sort());
      expect(syncRunRows.rows.every((row) => row.status === "success")).toBe(true);
      expect(syncRunRows.rows.every((row) => row.trigger === "onboarding")).toBe(true);
    } finally {
      abortController.abort();
      await executorPromise;
    }
  }, 20_000);

  it("returns page creation success with a retry path when the initial sync cannot be queued", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-enqueue-fail",
        username: "enqueue_fail_user",
        displayName: "Enqueue Fail User",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await activeTestDb.pool.query("drop schema pgboss cascade");

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "fansly",
        modelSlug: "lana-model",
        label: "enqueue-fail-page",
        session: {
          authorization: "token",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: {
        label: "enqueue-fail-page",
        platform: "fansly",
        username: "enqueue_fail_user",
      },
      verified: true,
      syncQueued: false,
      syncWarning: {
        code: "initial_sync_enqueue_failed",
        message: 'Page "enqueue-fail-page" was created, but initial sync was not queued. Retry by triggering an all sync for this page.',
      },
      syncRetry: {
        method: "POST",
        path: "/api/v1/admin/sync/trigger",
        body: {
          pageLabel: "enqueue-fail-page",
          scope: "all",
        },
      },
    });

    const pageRows = await activeTestDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pages
      where label = 'enqueue-fail-page'
    `);
    expect(pageRows.rows[0]?.count).toBe("1");

    const duplicateCreate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages",
      headers: { cookie },
      payload: {
        platform: "fansly",
        modelSlug: "lana-model",
        label: "enqueue-fail-page",
        session: {
          authorization: "token",
        },
      },
    });

    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: "conflict",
      message: 'Page "enqueue-fail-page" already exists',
      statusCode: 409,
    });

    const pageRowsAfterRetry = await activeTestDb.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pages
      where label = 'enqueue-fail-page'
    `);
    expect(pageRowsAfterRetry.rows[0]?.count).toBe("1");
  });

  it("uses the latest light sync run for connection health", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const latestLightRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, latestLightRun.id, {
      status: "success",
      stats: {},
    });

    const followerRun = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "followers",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, followerRun.id, {
      status: "failed",
      stats: {},
      errorSummary: "Follower sync failed",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "lana",
        connectionStatus: "active",
        lastSyncError: null,
        proxyUrl: null,
        proxyHasAuth: false,
        syncUx: expect.objectContaining({
          state: expect.any(String),
          headline: expect.any(String),
          requiresAction: expect.any(Boolean),
        }),
      }),
    ]));
  });

  it("serves public system health without auth and degrades when the database probe fails", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const healthy = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({
      status: "ok",
      checks: {
        api: {
          status: "ok",
        },
        database: {
          status: "ok",
          error: null,
        },
      },
    });
    expect(typeof healthy.json().timestamp).toBe("string");
    expect(typeof healthy.json().checks.database.latencyMs).toBe("number");

    const querySpy = vi
      .spyOn(testDb.pool, "query")
      .mockRejectedValueOnce(new Error("db probe failed"));

    const degraded = await server.inject({
      method: "GET",
      url: "/api/v1/health",
    });

    querySpy.mockRestore();

    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({
      status: "degraded",
      checks: {
        api: {
          status: "ok",
        },
        database: {
          status: "error",
          error: "Database check failed",
        },
      },
    });
    expect(degraded.json().checks.database.error).not.toContain("db probe failed");
    expect(typeof degraded.json().checks.database.latencyMs).toBe("number");
  });

  it("requires dashboard auth or a monitoring token for detailed sync health", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await seedSyncMonitorScenario(testDb, fixture.lanaPage.id, new Date());

    const anonymous = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
    });

    expect(anonymous.statusCode).toBe(401);
    expect(JSON.stringify(anonymous.json())).not.toContain("lana");

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();

    expect(body).toMatchObject({
      status: "degraded",
      thresholds: {
        lightMaxAgeMinutes: 180,
        followerMaxAgeMinutes: 1080,
      },
      overall: {
        pageCount: 2,
        unhealthyPageCount: 2,
      },
    });
    expect(typeof body.timestamp).toBe("string");
    expect(body.overall.failedStreams).toBeGreaterThan(0);
    expect(body.overall.stalledStreams).toBeGreaterThan(0);
    expect(body.overall).toMatchObject({
      recentFailedRuns: 1,
      recent429s: 1,
      recent5xxs: 1,
    });

    expect(body.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pageLabel: "lana",
        platform: "fansly",
        status: "degraded",
        issues: expect.arrayContaining([
          "follower_sync_missing",
          "failed_streams",
          "stalled_streams",
        ]),
      }),
      expect.objectContaining({
        pageLabel: "lily1",
        platform: "fansly",
        status: "degraded",
        issues: expect.arrayContaining([
          "follower_sync_missing",
        ]),
      }),
    ]));

    await server.close();
    const monitoredContext = createTestAppContext(testDb, {
      healthSyncMonitoringToken: "health-monitor-secret",
    });
    server = await buildApiServer(monitoredContext);
    await server.ready();

    const badToken = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: {
        "x-monitoring-token": "wrong-token",
      },
    });
    expect(badToken.statusCode).toBe(401);

    const monitored = await server.inject({
      method: "GET",
      url: "/api/v1/health/sync",
      headers: {
        "x-monitoring-token": "health-monitor-secret",
      },
    });
    expect(monitored.statusCode).toBe(503);
    expect(monitored.json().pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pageLabel: "lana",
        platform: "fansly",
      }),
    ]));
  });

  it("reports whether a stored proxy is configured without exposing proxy secrets", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await saveProxy(createTestAppContext(testDb), fixture.lanaPage.id, {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const lanaConnection = response.json().find((connection: { label: string }) => connection.label === "lana");
    expect(lanaConnection).toEqual(expect.objectContaining({
      label: "lana",
      proxyUrl: "socks5://127.0.0.1:1080",
      proxyHasAuth: true,
    }));
    expect(JSON.stringify(lanaConnection)).not.toContain("proxy-user");
    expect(JSON.stringify(lanaConnection)).not.toContain("proxy-pass");
  });

  it("returns subscriber spend and last transaction metadata", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const subscribers = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?limit=10",
      headers: { cookie },
    });

    expect(subscribers.statusCode).toBe(200);
    expect(subscribers.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platformSubscriptionId: "sub-lana-1",
        totalSpentCents: 700,
        lastTransactionAt: "2026-03-06T12:00:00.000Z",
      }),
    ]));
  });

  it("applies subscriber and follower query filters before pagination", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date();
    const freshFollowedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const distractorFollowedAt = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const freshStartedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const distractorStartedAt = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const freshEndsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const distractorEndsAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    const [distractorFan, freshFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-101",
      username: "alpha",
      displayName: "Alpha Fan",
    }, {
      platform: "fansly",
      platformUserId: "fan-102",
      username: "freshfan",
      displayName: "Fresh Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: distractorFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: distractorFollowedAt,
      isSubscriber: true,
      subscriberSince: distractorStartedAt,
      subscriptionExpiresAt: distractorEndsAt,
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: distractorFan.id,
      platformFollowId: "follow-lana-alpha",
      followedAt: distractorFollowedAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-alpha",
      platformAccountId: fixture.lanaPage.id,
      fanId: distractorFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: distractorStartedAt,
      endsAt: distractorEndsAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: freshFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: freshFollowedAt,
      isSubscriber: true,
      subscriberSince: freshStartedAt,
      subscriptionExpiresAt: freshEndsAt,
      autoRenew: false,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      platformFollowId: "follow-lana-fresh",
      followedAt: freshFollowedAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-fresh",
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: freshStartedAt,
      endsAt: freshEndsAt,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const subscriberSearch = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?query=fresh&limit=1",
      headers: { cookie },
    });
    expect(subscriberSearch.statusCode).toBe(200);
    expect(subscriberSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-102",
        totalSpentCents: 0,
        lastTransactionAt: null,
      }),
    ]);

    const followerSearch = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?query=fresh&limit=1",
      headers: { cookie },
    });
    expect(followerSearch.statusCode).toBe(200);
    expect(followerSearch.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-102",
      }),
    ]);
  });

  it("applies subscriber and follower date-window filters", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date();
    const recentFollowAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oldFollowAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const recentSubscriberAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const oldSubscriberAt = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const expiringAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const nonExpiringAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const [existingFan, oldFan, freshFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-001",
    }, {
      platform: "fansly",
      platformUserId: "fan-201",
      username: "stalefan",
      displayName: "Stale Fan",
    }, {
      platform: "fansly",
      platformUserId: "fan-202",
      username: "freshfan",
      displayName: "Fresh Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: existingFan.id,
      platformAccountId: fixture.lanaPage.id,
      subscriptionExpiresAt: nonExpiringAt,
      autoRenew: true,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-1",
      platformAccountId: fixture.lanaPage.id,
      fanId: existingFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: oldSubscriberAt,
      endsAt: nonExpiringAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: oldFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: oldFollowAt,
      isSubscriber: true,
      subscriberSince: oldSubscriberAt,
      subscriptionExpiresAt: nonExpiringAt,
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: oldFan.id,
      platformFollowId: "follow-lana-stale",
      followedAt: oldFollowAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-stale",
      platformAccountId: fixture.lanaPage.id,
      fanId: oldFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: oldSubscriberAt,
      endsAt: nonExpiringAt,
    });

    await upsertFanPage(testDb.db, {
      fanId: freshFan.id,
      platformAccountId: fixture.lanaPage.id,
      isFollower: true,
      followerSince: recentFollowAt,
      isSubscriber: true,
      subscriberSince: recentSubscriberAt,
      subscriptionExpiresAt: expiringAt,
      autoRenew: false,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      platformFollowId: "follow-lana-recent",
      followedAt: recentFollowAt,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-lana-recent",
      platformAccountId: fixture.lanaPage.id,
      fanId: freshFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: recentSubscriberAt,
      endsAt: expiringAt,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const subscriberRecent = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?startedWithinHours=24&limit=50",
      headers: { cookie },
    });
    expect(subscriberRecent.statusCode).toBe(200);
    expect(subscriberRecent.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);

    const subscriberExpiring = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?expiringWithinDays=7&limit=50",
      headers: { cookie },
    });
    expect(subscriberExpiring.statusCode).toBe(200);
    expect(subscriberExpiring.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);

    const subscriberNoRenew = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?autoRenew=false&limit=50",
      headers: { cookie },
    });
    expect(subscriberNoRenew.statusCode).toBe(200);
    expect(subscriberNoRenew.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
        autoRenewOffDetectedAt: expect.any(String),
      }),
    ]);

    const followerRecent = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?followedWithinHours=24&limit=50",
      headers: { cookie },
    });
    expect(followerRecent.statusCode).toBe(200);
    expect(followerRecent.json().items).toEqual([
      expect.objectContaining({
        platformUserId: "fan-202",
      }),
    ]);
  });

  it("returns sync runs as a bare array for admin clients", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const run = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await finishSyncRun(testDb.db, run.id, {
      status: "success",
      stats: { synced: 1 },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/sync/runs?limit=1",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        runId: run.id,
        pageLabel: "lana",
        stream: "light",
      }),
    ]);
  });

  it("serializes raw-SQL admin endpoints without BigInt response failures", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const emittedAt = new Date(Date.now() - 60 * 60 * 1000);
    const run = await startSyncRun(testDb.db, {
      platformAccountId: fixture.lanaPage.id,
      stream: "light",
      trigger: "worker",
    });
    await insertSyncRunEvent(testDb.db, {
      syncRunId: run.id,
      platformAccountId: fixture.lanaPage.id,
      provider: "fansly",
      stream: "light",
      eventType: "anomaly",
      severity: "warn",
      message: "Observed an anomaly",
      details: {
        code: "TEST_WARN",
        context: "admin-endpoint-regression",
      },
      emittedAt,
    });
    await finishSyncRun(testDb.db, run.id, {
      status: "success",
      stats: { synced: 1 },
    });

    workerBoss = new PgBoss({ connectionString: testDb.connectionString });
    await workerBoss.start();
    await ensureSyncQueues(workerBoss);
    await workerBoss.send(SYNC_PAGE_EXECUTE_QUEUE, {
      platformAccountId: fixture.lanaPage.id,
    });
    const expectedMigrations = await testDb.pool.query<{
      name: string;
      appliedAt: Date | string;
    }>(`
      select id as name, applied_at as "appliedAt"
      from schema_migrations
      order by applied_at asc, id asc
    `);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const logsResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/logs?severity=warn&limit=10",
      headers: { cookie },
    });
    expect(logsResponse.statusCode).toBe(200);
    expect(logsResponse.json()).toEqual([
      expect.objectContaining({
        id: expect.any(Number),
        syncRunId: run.id,
        provider: "fansly",
        stream: "light",
        eventType: "anomaly",
        severity: "warn",
        message: "Observed an anomaly",
        details: {
          code: "TEST_WARN",
          context: "admin-endpoint-regression",
        },
        emittedAt: emittedAt.toISOString(),
        pageLabel: "lana",
      }),
    ]);

    const incidentsResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/incidents?code=TEST_WARN&limit=10",
      headers: { cookie },
    });
    expect(incidentsResponse.statusCode).toBe(200);
    expect(incidentsResponse.json()).toMatchObject({
      summary: [
        expect.objectContaining({
          code: "TEST_WARN",
          severity: "warn",
          count: 1,
        }),
      ],
      items: [
        expect.objectContaining({
          id: expect.any(Number),
          syncRunId: run.id,
          emittedAt: emittedAt.toISOString(),
          pageLabel: "lana",
        }),
      ],
    });

    const queueResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/queue/jobs?state=created&limit=10",
      headers: { cookie },
    });
    expect(queueResponse.statusCode).toBe(200);
    const queueJobs = queueResponse.json() as Array<Record<string, unknown>>;
    expect(queueJobs.length).toBeGreaterThan(0);
    expect(queueJobs).toContainEqual(expect.objectContaining({
      id: expect.any(String),
      name: SYNC_PAGE_EXECUTE_QUEUE,
      state: "created",
      data: { platformAccountId: fixture.lanaPage.id },
      createdOn: expect.any(String),
      startedOn: null,
      completedOn: null,
      output: null,
      retryLimit: expect.any(Number),
      retryCount: expect.any(Number),
    }));

    const dbStatsResponse = await server.inject({
      method: "GET",
      url: "/api/v1/admin/db/stats",
      headers: { cookie },
    });
    expect(dbStatsResponse.statusCode).toBe(200);
    const dbStats = dbStatsResponse.json() as {
      tables: Array<Record<string, unknown>>;
      migrations: Array<Record<string, unknown>>;
    };
    expect(dbStats.tables.length).toBeGreaterThan(0);
    expect(dbStats.tables[0]).toEqual(expect.objectContaining({
      schema: "public",
      table: expect.any(String),
      rowEstimate: expect.any(Number),
      totalBytes: expect.any(Number),
      indexBytes: expect.any(Number),
    }));
    expect(dbStats.migrations).toEqual(expectedMigrations.rows.map((row) => ({
      name: row.name,
      appliedAt: new Date(row.appliedAt).toISOString(),
    })));
  });

  it("rejects owner-only admin endpoints for team leads", async (context) => {
    if (!server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "lead",
        password: "lead-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/connections",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("updates stored page credentials via PATCH for owners", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-lana",
        username: "lana_page",
        displayName: "Lana",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await storeFanslySession(
      activeTestDb.db,
      fixture!.lanaPage.id,
      JSON.stringify(encryptJson({
        platform: "fansly",
        session: {
          authorization: "verify-token",
        },
      }, Buffer.alloc(32, 7), 1)),
      1,
    );
    await ensurePageSyncStates(activeTestDb.db, {
      pageId: fixture!.lanaPage.id,
    });
    await markPageSyncAuthBlocked(activeTestDb.db, {
      pageId: fixture!.lanaPage.id,
      errorCode: "auth_blocked",
      errorSummary: "Session expired",
    });
    await openNotificationIncident(activeTestDb.db, {
      incidentKey: `auth_blocked:${fixture!.lanaPage.id}`,
      kind: "auth_blocked",
      platformAccountId: fixture!.lanaPage.id,
      errorCode: "auth_blocked",
      errorSummary: "Session expired",
      metadata: {
        pageLabel: fixture!.lanaPage.label,
        platform: fixture!.lanaPage.platform,
      },
    });
    await openNotificationIncident(activeTestDb.db, {
      incidentKey: `proxy_failed:${fixture!.lanaPage.id}`,
      kind: "proxy_failed",
      platformAccountId: fixture!.lanaPage.id,
      errorCode: "transport",
      errorSummary: "Proxy unavailable",
      metadata: {
        pageLabel: fixture!.lanaPage.label,
        platform: fixture!.lanaPage.platform,
      },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      updated: true,
      verified: true,
    });

    const authBlockedRows = await activeTestDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from page_sync_states
      where page_id = $1
        and status = 'blocked'
        and blocker_kind = 'auth'
    `, [fixture!.lanaPage.id]);

    expect(authBlockedRows.rows[0]?.count).toBe(0);
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `auth_blocked:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `proxy_failed:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
  });

  it("clears auth_blocked state and resolves incidents when owners admin verify a page", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-lana",
        username: "lana_page",
        displayName: "Lana",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await storeFanslySession(
      activeTestDb.db,
      fixture!.lanaPage.id,
      JSON.stringify(encryptJson({
        platform: "fansly",
        session: {
          authorization: "verify-token",
        },
      }, Buffer.alloc(32, 7), 1)),
      1,
    );
    await ensurePageSyncStates(activeTestDb.db, {
      pageId: fixture!.lanaPage.id,
    });
    await markPageSyncAuthBlocked(activeTestDb.db, {
      pageId: fixture!.lanaPage.id,
      errorCode: "auth_blocked",
      errorSummary: "Session expired",
    });
    await openNotificationIncident(activeTestDb.db, {
      incidentKey: `auth_blocked:${fixture!.lanaPage.id}`,
      kind: "auth_blocked",
      platformAccountId: fixture!.lanaPage.id,
      errorCode: "auth_blocked",
      errorSummary: "Session expired",
      metadata: {
        pageLabel: fixture!.lanaPage.label,
        platform: fixture!.lanaPage.platform,
      },
    });
    await openNotificationIncident(activeTestDb.db, {
      incidentKey: `proxy_failed:${fixture!.lanaPage.id}`,
      kind: "proxy_failed",
      platformAccountId: fixture!.lanaPage.id,
      errorCode: "transport",
      errorSummary: "Proxy unavailable",
      metadata: {
        pageLabel: fixture!.lanaPage.label,
        platform: fixture!.lanaPage.platform,
      },
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/lana/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      verified: true,
      username: "lana_page",
      platform: "fansly",
    });

    const authBlockedRows = await activeTestDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from page_sync_states
      where page_id = $1
        and status = 'blocked'
        and blocker_kind = 'auth'
    `, [fixture!.lanaPage.id]);

    expect(authBlockedRows.rows[0]?.count).toBe(0);
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `auth_blocked:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
    expect(await getNotificationIncidentByKey(
      activeTestDb.db,
      `proxy_failed:${fixture!.lanaPage.id}`,
    )).toEqual(expect.objectContaining({
      status: "resolved",
    }));
  });

  it("returns 404 when owners admin verify a missing page", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/missing/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "not_found",
      message: 'Page "missing" not found',
      statusCode: 404,
    });
  });

  it("returns 500 when owners admin verify hits an unexpected runtime failure", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: {
        ...createAutoSyncFanslyAdapter({
          accountId: "acct-lana",
          username: "lana_page",
          displayName: "Lana",
        }),
        async getAccountMe() {
          throw new Error("metadata refresh exploded");
        },
      } as AppContext["adapter"],
    });
    server = await buildApiServer(appContext);
    await server.ready();

    await storeFanslySession(
      activeTestDb.db,
      fixture.lanaPage.id,
      JSON.stringify(encryptJson({
        platform: "fansly",
        session: {
          authorization: "verify-token",
        },
      }, Buffer.alloc(32, 7), 1)),
      1,
    );

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/pages/lana/verify",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "internal_error",
      message: "Internal Server Error",
      statusCode: 500,
    });
  });

  it("normalizes inline proxy credentials when updating page credentials via PATCH", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    const appContext = createTestAppContext(activeTestDb, {
      adapter: createAutoSyncFanslyAdapter({
        accountId: "acct-lana",
        username: "lana_page",
        displayName: "Lana",
      }),
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
        proxy: {
          url: "socks5://proxy-user:proxy-pass@proxy.example:1080",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const proxyRows = await activeTestDb.pool.query(`
      select url, encrypted_auth is not null as has_encrypted_auth
      from egress_endpoints
      where platform_account_id = (
        select id from pages where label = 'lana'
      )
    `);

    expect(proxyRows.rows[0]).toEqual({
      url: "socks5://proxy.example:1080",
      has_encrypted_auth: true,
    });
  });

  it("removes a stored proxy when owners explicitly clear it via PATCH", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await saveProxy(createTestAppContext(activeTestDb), fixture.lanaPage.id, {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    await server.close();
    let verifiedProxy: Record<string, unknown> | null | undefined;
    const appContext = createTestAppContext(activeTestDb, {
      adapter: {
        async verifySession(contextInput: { proxy?: Record<string, unknown> | null }) {
          verifiedProxy = contextInput.proxy;
          return {
            parsed: {
              account: {
                id: "acct-lana",
                username: "lana_page",
                displayName: "Lana",
                followCount: 0,
                subscriberCount: 0,
              },
            },
            raw: null,
          };
        },
      } as never,
    });
    server = await buildApiServer(appContext);
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/pages/lana/credentials",
      headers: { cookie },
      payload: {
        platform: "fansly",
        session: {
          authorization: "updated-token",
        },
        proxy: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifiedProxy).toBeNull();

    const proxyRows = await activeTestDb.pool.query<{ count: number }>(`
      select count(*)::int as count
      from egress_endpoints
      where platform_account_id = $1
    `, [fixture.lanaPage.id]);

    expect(proxyRows.rows[0]?.count).toBe(0);
  });

  it("serves follower and subscriber daily series plus protected swagger security schemes", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers/daily?period=custom&from=2026-03-01&to=2026-03-10",
      headers: { cookie },
    });
    expect(followersDaily.statusCode).toBe(200);
    expect(followersDaily.json().items).toEqual([
      expect.objectContaining({
        businessDate: "2026-03-02",
        newFollowers: 1,
      }),
    ]);

    const subscribersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers/daily?period=custom&from=2026-03-01&to=2026-03-10",
      headers: { cookie },
    });
    expect(subscribersDaily.statusCode).toBe(200);
    expect(subscribersDaily.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessDate: "2026-03-01",
          newSubscribers: 1,
        }),
      ]),
    );

    const anonymousSpec = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });
    expect(anonymousSpec.statusCode).toBe(401);

    const anonymousDocs = await server.inject({
      method: "GET",
      url: "/documentation/",
    });
    expect(anonymousDocs.statusCode).toBe(401);

    const specResponse = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { cookie },
    });
    expect(specResponse.statusCode).toBe(200);

    const docsResponse = await server.inject({
      method: "GET",
      url: "/documentation/",
      headers: { cookie },
    });
    expect(docsResponse.statusCode).toBe(200);

    const spec = server.swagger() as {
      components?: {
        securitySchemes?: Record<string, unknown>;
      };
    };
    expect(spec.components?.securitySchemes).toMatchObject({
      cookieAuth: expect.any(Object),
      bearerAuth: expect.any(Object),
      monitoringTokenAuth: expect.any(Object),
    });
  });

  it("uses UTC day boundaries for Fansly follower and subscriber daily rollups", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const model = await createModel(testDb.db, {
      slug: "utc-fansly-daily-model",
      name: "UTC Fansly Daily",
    });
    const page = await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "utc-fansly-daily",
    });
    await updatePageMetadata(testDb.db, page.id, {
      platformAccountIdValue: "acct-utc-fansly-daily",
      username: "utc_fansly_daily",
      displayName: "UTC Fansly Daily",
      followerCount: 1,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "utc-fansly-daily-fan",
      username: "utcfan",
      displayName: "UTC Fan",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isFollower: true,
      followerSince: new Date("2026-03-01T21:30:00.000Z"),
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T21:30:00.000Z"),
      subscriptionExpiresAt: new Date("2026-03-05T21:30:00.000Z"),
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformFollowId: "utc-fansly-follow-1",
      followedAt: new Date("2026-03-01T21:30:00.000Z"),
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "utc-fansly-sub-1",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: new Date("2026-03-01T21:30:00.000Z"),
      endsAt: new Date("2026-03-05T21:30:00.000Z"),
    });

    await rebuildFollowerRollups(testDb.db, page.id, 1);
    await rebuildSubscriberRollups(testDb.db, page.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/utc-fansly-daily/followers/daily?period=custom&from=2026-03-01&to=2026-03-02",
      headers: { cookie },
    });
    const subscribersDaily = await server.inject({
      method: "GET",
      url: "/api/v1/pages/utc-fansly-daily/subscribers/daily?period=custom&from=2026-03-01&to=2026-03-07",
      headers: { cookie },
    });

    expect(followersDaily.statusCode).toBe(200);
    expect(followersDaily.json().items).toEqual([
      expect.objectContaining({
        businessDate: "2026-03-01",
        newFollowers: 1,
      }),
    ]);

    expect(subscribersDaily.statusCode).toBe(200);
    expect(subscribersDaily.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        businessDate: "2026-03-01",
        newSubscribers: 1,
        activeSubscribers: 1,
      }),
      expect.objectContaining({
        businessDate: "2026-03-06",
        newSubscribers: 0,
        activeSubscribers: 0,
      }),
    ]));
    expect(
      subscribersDaily.json().items.some(
        (row: { businessDate: string; newSubscribers: number }) =>
          row.businessDate === "2026-03-02" && row.newSubscribers === 1,
      ),
    ).toBe(false);
  });

  it("paginates follower and subscriber list endpoints", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }
    const lanaPageId = fixture.lanaPage.id;

    const [fanTwo, fanThree] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-002",
        username: "buyer2",
        displayName: "Buyer Two",
      },
      {
        platform: "fansly",
        platformUserId: "fan-003",
        username: "buyer3",
        displayName: "Buyer Three",
      },
    ]);

    for (const [index, fan] of [fanTwo, fanThree].entries()) {
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: lanaPageId,
        isFollower: true,
        followerSince: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        isSubscriber: true,
        subscriberSince: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        subscriptionExpiresAt: new Date(`2026-03-2${index + 1}T12:00:00.000Z`),
        autoRenew: index % 2 === 0,
      });
      await upsertPageFollow(testDb.db, {
        platformAccountId: lanaPageId,
        fanId: fan.id,
        platformFollowId: `follow-lana-${index + 2}`,
        followedAt: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
      });
      await upsertPageSubscription(testDb.db, {
        platformSubscriptionId: `sub-lana-${index + 2}`,
        platformAccountId: lanaPageId,
        fanId: fan.id,
        rawStatus: 3,
        canonicalStatus: "active",
        priceMills: 5000n,
        renewPriceMills: 5000n,
        autoRenew: index % 2 === 0,
        sourceCreatedAt: new Date(`2026-03-0${index + 3}T12:00:00.000Z`),
        endsAt: new Date(`2026-03-2${index + 1}T12:00:00.000Z`),
      });
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "dima",
        password: "owner-secret",
      },
    });
    const cookie = sessionCookieFrom(login);

    const followers = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/followers?limit=1&offset=1",
      headers: { cookie },
    });
    expect(followers.statusCode).toBe(200);
    expect(followers.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 3,
    });
    expect(followers.json().items).toHaveLength(1);
    expect(followers.json().items[0]?.platformUserId).toBe("fan-002");

    const subscribers = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/subscribers?limit=1&offset=1",
      headers: { cookie },
    });
    expect(subscribers.statusCode).toBe(200);
    expect(subscribers.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 3,
    });
    expect(subscribers.json().items).toHaveLength(1);
    expect(subscribers.json().items[0]?.platformSubscriptionId).toBe("sub-lana-2");
  });

  it("includes newFollowersToday in overview for Fansly and zero for OnlyFans pages", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-followers",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-followers-42",
      username: "lana_of_followers",
      displayName: "Lana OF Followers",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: { onlyMonsterAccountId: 55 },
      syncType: "light",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const overview = await server.inject({
      method: "GET",
      url: "/api/v1/overview",
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);

    const body = overview.json();
    expect(body.overall.syncUx).toMatchObject({
      state: expect.any(String),
      headline: expect.any(String),
      requiresAction: expect.any(Boolean),
    });
    for (const page of body.pages) {
      expect(typeof page.newFollowersToday).toBe("number");
      expect(Number.isInteger(page.newFollowersToday)).toBe(true);
      expect(page.syncUx).toMatchObject({
        state: expect.any(String),
        headline: expect.any(String),
        requiresAction: expect.any(Boolean),
      });
    }

    const lanaOverview = body.pages.find((p: any) => p.label === "lana");
    expect(lanaOverview).toBeDefined();
    expect(lanaOverview.newFollowersToday).toBeGreaterThanOrEqual(0);

    const ofOverview = body.pages.find((p: any) => p.label === "lana-of-followers");
    expect(ofOverview).toBeDefined();
    expect(ofOverview.newFollowersToday).toBe(0);
  });

  it("reuses the overview sync snapshot instead of recomputing it for connection statuses", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);
    const querySpy = vi.spyOn(testDb.pool, "query");

    try {
      const overview = await server.inject({
        method: "GET",
        url: "/api/v1/overview",
        headers: { cookie },
      });

      expect(overview.statusCode).toBe(200);

      const statements = querySpy.mock.calls
        .map((call) => {
          const statement = call[0];
          if (typeof statement === "string") {
            return statement;
          }
          if (statement && typeof statement === "object" && "text" in statement) {
            const text = (statement as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .filter((statement) => statement.length > 0);
      const fullMonitorStatements = statements.filter((statement) =>
        /\bpage_streams\b/.test(statement) && /\bprovider_rate_limits\b/.test(statement));

      expect(fullMonitorStatements).toHaveLength(0);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("returns period-aware growth metrics from /api/v1/overview/growth", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

    // Seed an additional fansly page with follower/subscriber data on a different day
    const extraModel = await createModel(testDb.db, {
      slug: "extra-model",
      name: "Extra Model",
    });
    const extraPage = await createFanslyPage(testDb.db, {
      modelId: extraModel.id,
      label: "extra",
    });
    await updatePageMetadata(testDb.db, extraPage.id, {
      platformAccountIdValue: "acct-extra",
      username: "extra_page",
      displayName: "Extra",
      followerCount: 2,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });
    const [extraFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-extra-1",
      username: "extra_buyer",
      displayName: "Extra Buyer",
    }]);
    await upsertFanPage(testDb.db, {
      fanId: extraFan.id,
      platformAccountId: extraPage.id,
      isFollower: true,
      followerSince: new Date("2026-03-10T12:00:00.000Z"),
      isSubscriber: true,
      subscriberSince: new Date("2026-03-10T12:00:00.000Z"),
      subscriptionExpiresAt: new Date("2026-04-10T12:00:00.000Z"),
      autoRenew: true,
    });
    await upsertPageFollow(testDb.db, {
      platformAccountId: extraPage.id,
      fanId: extraFan.id,
      platformFollowId: "follow-extra-1",
      followedAt: new Date("2026-03-10T12:00:00.000Z"),
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-extra-1",
      platformAccountId: extraPage.id,
      fanId: extraFan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: new Date("2026-03-10T12:00:00.000Z"),
      endsAt: new Date("2026-04-10T12:00:00.000Z"),
    });
    await rebuildFollowerRollups(testDb.db, extraPage.id, 2);
    await rebuildSubscriberRollups(testDb.db, extraPage.id);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    // "today" period should show 0 for pages whose data is in the past
    const todayRes = await server.inject({
      method: "GET",
      url: "/api/v1/overview/growth?period=today",
      headers: { cookie },
    });
    expect(todayRes.statusCode).toBe(200);
    const todayBody = todayRes.json();
    expect(todayBody.pages).toBeInstanceOf(Array);
    // lana page: follower data on 2026-03-02, today is much later → 0
    const lanaToday = todayBody.pages.find((p: any) => p.pageId === fixture!.lanaPage.id);
    expect(lanaToday).toBeDefined();
    expect(lanaToday.newFollowers).toBe(0);
    expect(lanaToday.newSubscribers).toBe(0);

    // "30d" period should include data from the last 30 days
    const thirtyDayRes = await server.inject({
      method: "GET",
      url: "/api/v1/overview/growth?period=30d",
      headers: { cookie },
    });
    expect(thirtyDayRes.statusCode).toBe(200);
    const thirtyDayBody = thirtyDayRes.json();
    const lana30d = thirtyDayBody.pages.find((p: any) => p.pageId === fixture!.lanaPage.id);
    expect(lana30d).toBeDefined();
    expect(lana30d.newFollowers).toBeGreaterThanOrEqual(1);
    expect(lana30d.newSubscribers).toBeGreaterThanOrEqual(1);

    const extra30d = thirtyDayBody.pages.find((p: any) => p.pageId === extraPage.id);
    expect(extra30d).toBeDefined();
    expect(extra30d.newFollowers).toBeGreaterThanOrEqual(1);
    expect(extra30d.newSubscribers).toBeGreaterThanOrEqual(1);

    // Pages with no data in range return zeros (lily page has no follows/subs)
    const lily30d = thirtyDayBody.pages.find((p: any) => p.pageId === fixture!.lilyPage.id);
    expect(lily30d).toBeDefined();
    expect(lily30d.newFollowers).toBe(0);
    expect(lily30d.newSubscribers).toBe(0);
  });

  it("returns period-aware growth with OnlyFans pages reporting zero followers", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    // Create an OnlyFans page (no follower data available)
    const ofModel = await createModel(testDb.db, {
      slug: "of-growth-model",
      name: "OF Growth Model",
    });
    const ofPage = await createOnlyFansPage(testDb.db, {
      modelId: ofModel.id,
      label: "of-growth",
    });
    await updatePageMetadata(testDb.db, ofPage.id, {
      platformAccountIdValue: "of-acct-growth",
      username: "of_growth_page",
      displayName: "OF Growth",
      followerCount: 100,
      subscriberCount: 50,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/overview/growth?period=30d",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ofGrowth = body.pages.find((p: any) => p.pageId === ofPage.id);
    expect(ofGrowth).toBeDefined();
    expect(ofGrowth.newFollowers).toBe(0);
  });

  it("serves conversation previews and message history from stored Fansly DM data", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-17T12:00:00.000Z"));

    await seedConversationApiFixture({
      testDb,
      pageId: fixture.lanaPage.id,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const preview = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/preview?limit=3",
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      page: {
        label: "lana",
        platform: "fansly",
      },
      conversation: {
        platformConversationId: "conversation-001",
        storedMessageCount: 4,
        messageBackfillComplete: true,
        lastMessageSyncAt: "2026-03-17T11:45:00.000Z",
      },
      messageSyncUx: {
        state: "healthy",
        headline: "Conversation history is ready",
        requiresAction: false,
      },
    });
    expect(preview.json().messages.map((message: { platformMessageId: string }) => message.platformMessageId)).toEqual([
      "conversation-msg-002",
      "conversation-msg-003",
      "conversation-msg-004",
    ]);
    expect(preview.json().messages[2]).toMatchObject({
      platformMessageId: "conversation-msg-004",
      totalTipAmountCents: 2000,
    });

    const messages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/messages",
      headers: { cookie },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toMatchObject({
      page: {
        label: "lana",
        platform: "fansly",
      },
      conversationId: "conversation-001",
    });
    expect(messages.json().messages.map((message: { messageId: string }) => message.messageId)).toEqual([
      "conversation-msg-004",
      "conversation-msg-003",
      "conversation-msg-002",
      "conversation-msg-001",
    ]);
    expect(messages.json().messages[0]).toMatchObject({
      messageId: "conversation-msg-004",
      senderRole: "fan",
      tipAmountCents: 2000,
      createdAt: "2026-03-14T08:00:00.000Z",
    });

    const clampedMessages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/messages?limit=999",
      headers: { cookie },
    });
    expect(clampedMessages.statusCode).toBe(200);
    expect(clampedMessages.json().messages).toHaveLength(4);

    const missingPreview = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/missing/preview?limit=3",
      headers: { cookie },
    });
    expect(missingPreview.statusCode).toBe(404);

    const missingMessages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/missing/messages",
      headers: { cookie },
    });
    expect(missingMessages.statusCode).toBe(404);

    const removedSummary = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/crm/summary",
      headers: { cookie },
    });
    expect(removedSummary.statusCode).toBe(404);

    const removedRetention = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/crm/retention?limit=10&offset=0",
      headers: { cookie },
    });
    expect(removedRetention.statusCode).toBe(404);

    const removedReactivation = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/crm/reactivation?limit=10&offset=0",
      headers: { cookie },
    });
    expect(removedReactivation.statusCode).toBe(404);

    const removedPreview = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/crm/conversations/conversation-001/preview?limit=3",
      headers: { cookie },
    });
    expect(removedPreview.statusCode).toBe(404);
  });

  it("snoozes and unsnoozes workboard fans without hiding the rest of the queue", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

    const workboardPage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-workboard",
    });
    await updatePageMetadata(testDb.db, workboardPage.id, {
      platformAccountIdValue: "acct-lana-workboard",
      username: "lana_workboard",
      displayName: "Lana Workboard",
      followerCount: 0,
      subscriberCount: 2,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const seeded = await seedWorkboardApiFixture({
      testDb,
      pageId: workboardPage.id,
    });

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const beforeSnooze = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-workboard/workboard",
      headers: { cookie },
    });
    expect(beforeSnooze.statusCode).toBe(200);
    expect(beforeSnooze.json()).toMatchObject({
      subscribers: { total: 3 },
      activeSpenders: { total: 2 },
      inactiveSpenders: { total: 5 },
      snoozed: { total: 0 },
    });
    expect(beforeSnooze.json().inactiveSpenders.items.map((item: { fanId: number }) => item.fanId).sort()).toEqual([
      seeded.activeSpender.id,
      seeded.inactiveSpender.id,
      seeded.microSpender.id,
      seeded.deletedActiveSpender.id,
      seeded.deletedInactiveSpender.id,
    ].sort());
    const beforeSnoozeSubscriber = beforeSnooze.json().subscribers.items.find(
      (item: { fanId: number }) => item.fanId === seeded.visibleSubscriber.id,
    );
    expect(beforeSnoozeSubscriber?.subscription.subscriberSince).toBe("2026-03-01T12:00:00.000Z");

    const snooze = await server.inject({
      method: "POST",
      url: "/api/v1/pages/lana-workboard/workboard/snooze",
      headers: { cookie },
      payload: {
        fanId: seeded.snoozedSubscriber.id,
        days: 7,
      },
    });
    expect(snooze.statusCode).toBe(200);
    expect(snooze.json()).toMatchObject({
      fanId: seeded.snoozedSubscriber.id,
      snoozedUntil: expect.any(String),
    });

    const deletedSnooze = await server.inject({
      method: "POST",
      url: "/api/v1/pages/lana-workboard/workboard/snooze",
      headers: { cookie },
      payload: {
        fanId: seeded.deletedSubscriber.id,
        days: 30,
      },
    });
    expect(deletedSnooze.statusCode).toBe(200);

    const afterSnooze = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-workboard/workboard",
      headers: { cookie },
    });
    expect(afterSnooze.statusCode).toBe(200);
    expect(afterSnooze.json()).toMatchObject({
      subscribers: {
        total: 1,
        items: [expect.objectContaining({ fanId: seeded.visibleSubscriber.id })],
      },
      activeSpenders: {
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ fanId: seeded.activeSpender.id }),
          expect.objectContaining({ fanId: seeded.deletedActiveSpender.id }),
        ]),
      },
      inactiveSpenders: {
        total: 5,
        items: expect.arrayContaining([
          expect.objectContaining({ fanId: seeded.activeSpender.id, segment: "active" }),
          expect.objectContaining({ fanId: seeded.inactiveSpender.id, segment: "inactive" }),
          expect.objectContaining({ fanId: seeded.microSpender.id, segment: "active" }),
          expect.objectContaining({ fanId: seeded.deletedActiveSpender.id, segment: "active" }),
          expect.objectContaining({ fanId: seeded.deletedInactiveSpender.id, segment: "inactive" }),
        ]),
      },
      snoozed: {
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ fanId: seeded.snoozedSubscriber.id }),
          expect.objectContaining({ fanId: seeded.deletedSubscriber.id }),
        ]),
      },
    });

    const unsnooze = await server.inject({
      method: "DELETE",
      url: `/api/v1/pages/lana-workboard/workboard/snooze/${seeded.snoozedSubscriber.id}`,
      headers: { cookie },
    });
    expect(unsnooze.statusCode).toBe(200);
    expect(unsnooze.json()).toEqual({ ok: true });

    const afterUnsnooze = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-workboard/workboard",
      headers: { cookie },
    });
    expect(afterUnsnooze.statusCode).toBe(200);
    expect(afterUnsnooze.json()).toMatchObject({
      subscribers: { total: 2 },
      activeSpenders: { total: 2 },
      inactiveSpenders: { total: 5 },
      snoozed: { total: 1 },
    });
  });

  it("blocks chatter API keys from workboard read and write routes", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

    const workboardPage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-workboard-api-key",
    });
    await updatePageMetadata(testDb.db, workboardPage.id, {
      platformAccountIdValue: "acct-lana-workboard-api-key",
      username: "lana_workboard_api_key",
      displayName: "Lana Workboard API Key",
      followerCount: 0,
      subscriberCount: 2,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const seeded = await seedWorkboardApiFixture({
      testDb,
      pageId: workboardPage.id,
    });

    const appContext = createTestAppContext(testDb);
    await assignPageToUser(appContext, {
      username: "anton",
      pageLabel: "lana-workboard-api-key",
    }, { source: "cli" });
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
    }, { source: "cli" });

    const workboard = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-workboard-api-key/workboard",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(workboard.statusCode).toBe(403);
    expect(workboard.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });

    const snooze = await server.inject({
      method: "POST",
      url: "/api/v1/pages/lana-workboard-api-key/workboard/snooze",
      headers: {
        authorization: `Bearer ${key}`,
      },
      payload: {
        fanId: seeded.snoozedSubscriber.id,
        days: 7,
      },
    });
    expect(snooze.statusCode).toBe(403);
    expect(snooze.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });

    const unsnooze = await server.inject({
      method: "DELETE",
      url: `/api/v1/pages/lana-workboard-api-key/workboard/snooze/${seeded.snoozedSubscriber.id}`,
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(unsnooze.statusCode).toBe(403);
    expect(unsnooze.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });
  });

  it("returns inferred workboard presence for Fansly pages", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

    const presencePage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-presence",
    });

    const appContext = createTestAppContext(testDb);
    const encryptedSession = JSON.stringify(encryptJson(
      {
        platform: "fansly" as const,
        session: {
          authorization: "presence-token",
        },
      },
      appContext.config.encryptionKey,
      appContext.config.encryptionKeyVersion,
    ));
    await storeFanslySession(
      testDb.db,
      presencePage.id,
      encryptedSession,
      appContext.config.encryptionKeyVersion,
    );
    await updatePageMetadata(testDb.db, presencePage.id, {
      platformAccountIdValue: "acct-lana-presence",
      username: "lana_presence",
      displayName: "Lana Presence",
      followerCount: 2,
      subscriberCount: 1,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const [activeFan, recentFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "presence-fan-active",
        username: "presence_active",
        displayName: "Presence Active",
      },
      {
        platform: "fansly",
        platformUserId: "presence-fan-recent",
        username: "presence_recent",
        displayName: "Presence Recent",
      },
    ]);
    await upsertFanPage(testDb.db, {
      fanId: activeFan.id,
      platformAccountId: presencePage.id,
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
      pageAlias: "Presence Active Alias",
    });
    await upsertFanPage(testDb.db, {
      fanId: recentFan.id,
      platformAccountId: presencePage.id,
      pageAlias: "Presence Recent Alias",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: presencePage.id,
      source: "onlymonster",
      fanId: activeFan.id,
      transactionId: "presence-api-tip-active",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300000n,
      sourceDestinationAmountMills: 300000n,
      creatorNetAmountMills: 300000n,
      occurredAt: new Date("2026-03-30T11:00:00.000Z"),
    });
    await recalculateFanPageSpend(testDb.db, presencePage.id);

    const presenceAdapter: AppContext["adapter"] = {
      ...createAutoSyncFanslyAdapter({
        accountId: "acct-lana-presence",
        username: "lana_presence",
        displayName: "Lana Presence",
      }),
      async getFollowersPage(_context, accountId, params) {
        expect(accountId).toBe("acct-lana-presence");
        expect(params.lastSeenAfter).toBe(new Date("2026-03-30T10:00:00.000Z").getTime());

        return {
          total: 2,
          offset: params.offset ?? 0,
          done: true,
          items: [
            {
              id: "follow-presence-active",
              followerId: "presence-fan-active",
              lastSeenAt: new Date("2026-03-30T11:50:00.000Z").getTime(),
            },
            {
              id: "follow-presence-recent",
              followerId: "presence-fan-recent",
              lastSeenAt: new Date("2026-03-30T10:40:00.000Z").getTime(),
            },
          ],
          accounts: [
            {
              id: "presence-fan-active",
              username: "presence_active",
              displayName: "Presence Active",
              createdAt: 1_772_000_000_000,
              lastSeenAt: new Date("2026-03-30T11:50:00.000Z").getTime(),
            },
            {
              id: "presence-fan-recent",
              username: "presence_recent",
              displayName: "Presence Recent",
              createdAt: 1_772_000_000_000,
              lastSeenAt: new Date("2026-03-30T10:40:00.000Z").getTime(),
            },
          ],
          raw: {
            followers: [],
            aggregationData: {
              accounts: [],
            },
          },
        };
      },
    };

    if (server) {
      await server.close();
    }
    server = await buildApiServer(createTestAppContext(testDb, {
      adapter: presenceAdapter,
    }));
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-presence/workboard/presence",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bestEffort: true,
      activeNow: {
        total: 1,
        items: [expect.objectContaining({
          fanId: activeFan.id,
          isSubscriber: true,
          presence: expect.objectContaining({
            source: "fansly_followers_last_seen",
            lastSeenAt: "2026-03-30T11:50:00.000Z",
          }),
        })],
      },
      recentlyActive: {
        total: 1,
        items: [expect.objectContaining({
          fanId: recentFan.id,
          isSubscriber: false,
          presence: expect.objectContaining({
            source: "fansly_followers_last_seen",
            lastSeenAt: "2026-03-30T10:40:00.000Z",
          }),
        })],
      },
    });

    const workboard = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-presence/workboard",
      headers: { cookie },
    });
    expect(workboard.statusCode).toBe(200);
  });

  it("keeps the main workboard available when the presence endpoint fails", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const presencePage = await createFanslyPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-presence-failure",
    });

    const appContext = createTestAppContext(testDb);
    const encryptedSession = JSON.stringify(encryptJson(
      {
        platform: "fansly" as const,
        session: {
          authorization: "presence-token",
        },
      },
      appContext.config.encryptionKey,
      appContext.config.encryptionKeyVersion,
    ));
    await storeFanslySession(
      testDb.db,
      presencePage.id,
      encryptedSession,
      appContext.config.encryptionKeyVersion,
    );
    await updatePageMetadata(testDb.db, presencePage.id, {
      platformAccountIdValue: "acct-lana-presence-failure",
      username: "lana_presence_failure",
      displayName: "Lana Presence Failure",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    if (server) {
      await server.close();
    }
    server = await buildApiServer(createTestAppContext(testDb, {
      adapter: {
        ...createAutoSyncFanslyAdapter({
          accountId: "acct-lana-presence-failure",
          username: "lana_presence_failure",
          displayName: "Lana Presence Failure",
        }),
        async getFollowersPage() {
          throw new Error("presence transport failed");
        },
      },
    }));
    await server.ready();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const cookie = sessionCookieFrom(login);

    const presence = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-presence-failure/workboard/presence",
      headers: { cookie },
    });
    expect(presence.statusCode).toBe(500);

    const workboard = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-presence-failure/workboard",
      headers: { cookie },
    });
    expect(workboard.statusCode).toBe(200);
  });

  it("enforces conversation and workboard page access", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ofPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-workboard",
    });
    await updatePageMetadata(testDb.db, ofPage.id, {
      platformAccountIdValue: "of-workboard",
      username: "lana_of_workboard",
      displayName: "Lana OF Workboard",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/workboard",
      headers: { cookie: leadCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const forbiddenPresence = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/workboard/presence",
      headers: { cookie: leadCookie },
    });
    expect(forbiddenPresence.statusCode).toBe(403);

    const forbiddenMessages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lily1/conversations/conversation-001/messages",
      headers: { cookie: leadCookie },
    });
    expect(forbiddenMessages.statusCode).toBe(403);

    const forbiddenFlags = await server.inject({
      method: "PATCH",
      url: "/api/v1/fans/fansly/fan-001/flags",
      headers: { cookie: leadCookie },
      payload: { flags: ["vip"] },
    });
    expect(forbiddenFlags.statusCode).toBe(403);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerFlags = await server.inject({
      method: "PATCH",
      url: "/api/v1/fans/fansly/fan-001/flags",
      headers: { cookie: ownerCookie },
      payload: { flags: ["vip"] },
    });
    expect(ownerFlags.statusCode).toBe(200);
    expect(ownerFlags.json().flags).toEqual([
      expect.objectContaining({ flag: "vip" }),
    ]);

    // Decision #49 opened the workboard queue to OnlyFans pages (DM store is
    // platform-agnostic); pages without DM data simply serve an empty queue.
    const nonFansly = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-of-workboard/workboard",
      headers: { cookie: ownerCookie },
    });
    expect(nonFansly.statusCode).toBe(200);

    // Presence stays Fansly-only while the page is outside the OFAPI presence
    // pipeline (OFAPI_PRESENCE_PROJECTION_ENABLED off / unmapped page).
    const nonFanslyPresence = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-of-workboard/workboard/presence",
      headers: { cookie: ownerCookie },
    });
    expect(nonFanslyPresence.statusCode).toBe(400);
    expect(nonFanslyPresence.json()).toMatchObject({
      message: "Workboard presence is only supported for Fansly pages",
    });

    const nonFanslyMessages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana-of-workboard/conversations/any/messages",
      headers: { cookie: ownerCookie },
    });
    expect(nonFanslyMessages.statusCode).toBe(404);
    expect(nonFanslyMessages.json()).toMatchObject({
      message: "Conversation messages were not found",
    });

    const appContext = createTestAppContext(testDb);
    const { key } = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    const apiKeyMessages = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/messages",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(apiKeyMessages.statusCode).toBe(403);
    expect(apiKeyMessages.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });

    const apiKeyWorkboard = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/workboard",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(apiKeyWorkboard.statusCode).toBe(403);
    expect(apiKeyWorkboard.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });

    const apiKeyWorkboardPresence = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/workboard/presence",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(apiKeyWorkboardPresence.statusCode).toBe(403);
    expect(apiKeyWorkboardPresence.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });

    const apiKeyPreview = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/conversations/conversation-001/preview?limit=3",
      headers: {
        authorization: `Bearer ${key}`,
      },
    });
    expect(apiKeyPreview.statusCode).toBe(403);
    expect(apiKeyPreview.json()).toMatchObject({
      message: "Dashboard routes require a cookie session",
    });
  });

  it("returns scoped sync monitor snapshots with derived statuses, progress, and recent aggregates", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const seeded = await seedSyncMonitorScenario(testDb, fixture.lanaPage.id, new Date());

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status",
      headers: { cookie: ownerCookie },
    });

    expect(ownerResponse.statusCode).toBe(200);
    const ownerBody = ownerResponse.json();
    expect(typeof ownerBody.generatedAt).toBe("string");
    expect(ownerBody.window.hours).toBe(24);
    expect(ownerBody.pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana", "lily1"]);
    expect(ownerBody.overall.pages).toBe(2);
    expect(ownerBody.overall.syncUx).toMatchObject({
      state: "attention",
      requiresAction: true,
      headline: "Reconnect to resume sync",
    });
    expect(ownerBody.overall.recentRuns).toMatchObject({
      running: 1,
      success: 1,
      partial: 1,
      failed: 1,
      skipped: 0,
    });
    expect(ownerBody.overall.recentErrors).toMatchObject({
      total429s: 1,
      total5xxs: 1,
      failedRuns: 1,
      failedAttempts: 1,
      retryAttempts: 1,
      last429At: seeded.last429At.toISOString(),
      last5xxAt: seeded.last5xxAt.toISOString(),
    });
    expect(ownerBody.overall.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: "fansly",
        recent429s: 1,
        recent5xxs: 1,
        rateHealth: expect.objectContaining({
          state: "limited",
          nextAvailableAt: seeded.retryAt.toISOString(),
        }),
      }),
    ]));

    const lana = ownerBody.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana");
    expect(lana).toBeTruthy();
    expect(lana.syncUx).toMatchObject({
      state: "attention",
      requiresAction: true,
      headline: "Reconnect to resume sync",
    });
    expect(lana.summary).toMatchObject({
      runningStreams: 1,
      blockedStreams: 1,
      stalledStreams: 1,
      pendingStreams: 0,
      retryingStreams: 1,
    });
    expect(lana.counts).toMatchObject({
      fans: 5,
      followers: 1,
      subscribers: 1,
      transactions: 3,
      conversations: 4,
      messages: 2,
    });

    const streams = new Map(
      lana.streams.map((stream: { stream: string }) => [stream.stream, stream]),
    );

    expect(streams.get("light")).toMatchObject({
      status: "running",
      stalled: true,
      syncUx: expect.objectContaining({
        state: "attention",
        headline: "Sync needs attention",
      }),
      pending: false,
      activeRun: expect.objectContaining({
        startedAt: seeded.lightRunningStartedAt.toISOString(),
        lastActivityAt: seeded.lightRunningEventAt.toISOString(),
      }),
      recentRuns: expect.objectContaining({
        running: 1,
        success: 0,
      }),
      rateHealth: expect.objectContaining({
        state: "limited",
      }),
    });
    expect(streams.get("transactions")).toMatchObject({
      status: "retrying",
      pending: false,
      retryAt: seeded.retryAt.toISOString(),
      syncUx: expect.objectContaining({
        state: "retrying",
        headline: "Retrying automatically",
      }),
      progress: {
        label: "17 items backfilled",
        current: 17,
        total: null,
        unit: "items",
        percent: null,
      },
      recentRuns: expect.objectContaining({
        partial: 1,
      }),
      recentErrors: expect.objectContaining({
        total429s: 1,
        total5xxs: 0,
      }),
      rateHealth: expect.objectContaining({
        state: "limited",
        last429At: seeded.last429At.toISOString(),
      }),
    });
    expect(streams.get("subscribers")).toMatchObject({
      status: "paused",
      progress: {
        label: "2/5 subscribers",
        current: 2,
        total: 5,
        unit: "subscribers",
        percent: 40,
      },
    });
    expect(streams.get("dm_conversations")).toMatchObject({
      status: "blocked",
      lastErrorSummary: "Session expired",
      syncUx: expect.objectContaining({
        state: "attention",
        headline: "Reconnect to resume sync",
        requiresAction: true,
      }),
      progress: {
        label: "2/4 conversations",
        current: 2,
        total: 4,
        unit: "conversations",
        percent: 50,
      },
    });
    expect(streams.get("dm_messages")).toMatchObject({
      status: "idle",
      succeededAt: seeded.completedSyncAt.toISOString(),
      syncUx: expect.objectContaining({
        state: "healthy",
        headline: "Up to date",
      }),
      progress: {
        label: "1/3 conversations backfilled, 1 lagging",
        current: 1,
        total: 3,
        unit: "conversations",
        percent: 33.3,
      },
    });
    expect(streams.get("followers")).toMatchObject({
      status: "idle",
      failedAt: seeded.followersFailedAt.toISOString(),
      lastErrorSummary: "Followers sync failed",
      recentErrors: expect.objectContaining({
        total5xxs: 1,
        failedRuns: 1,
        failedAttempts: 1,
      }),
      progress: {
        label: "10/10 followers",
        current: 10,
        total: 10,
        unit: "followers",
        percent: 100,
      },
    });
    expect(streams.get("followers_reconcile")).toMatchObject({
      status: "idle",
      progress: {
        label: "10/10 followers",
        current: 10,
        total: 10,
        unit: "followers",
        percent: 100,
      },
    });

    expect(ownerBody.recentEvents.map((event: { message: string }) => event.message)).toEqual([
      "Followers sync failed",
      "DM message sync completed",
      "Light sync is active",
      "Transactions backfill slowed by 429s",
    ]);
    const dmMessagesStream = streams.get("dm_messages") as
      | { lastCompletion?: { durationMs?: number | null } }
      | undefined;
    expect(typeof dmMessagesStream?.lastCompletion?.durationMs).toBe("number");

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status",
      headers: { cookie: leadCookie },
    });

    expect(leadResponse.statusCode).toBe(200);
    const leadBody = leadResponse.json();
    expect(leadBody.pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana"]);
    expect(leadBody.overall.pages).toBe(1);
    expect(leadBody.overall.streams).toBe(7);
  }, 15_000);

  it("enforces sync monitor page scoping and missing-page handling", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await seedSyncMonitorScenario(testDb, fixture.lanaPage.id, new Date());

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);

    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=lily1",
      headers: { cookie: leadCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const missing = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=missing-page",
      headers: { cookie: ownerCookie },
    });
    expect(missing.statusCode).toBe(404);

    const filtered = await server.inject({
      method: "GET",
      url: "/api/v1/sync/status?pageLabel=lana",
      headers: { cookie: ownerCookie },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lana"]);
  }, 15_000);

  it("returns sync block overview rows and exposes supported OnlyFans message blocks", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-24T12:00:00.000Z");
    await seedSyncMonitorScenario(testDb, fixture.lanaPage.id, now);

    const onlyFansPage = await createOnlyFansPage(testDb.db, {
      modelId: fixture.lanaModel.id,
      label: "lana-of-sync",
    });
    await updatePageMetadata(testDb.db, onlyFansPage.id, {
      platformAccountIdValue: "of-sync-1",
      username: "lana_of_sync",
      displayName: "Lana OF",
      followerCount: 0,
      subscriberCount: 0,
      earningsBalanceMills: 0n,
      metadata: {},
      syncType: "light",
    });
    await ensurePageSyncStates(testDb.db, {
      pageId: onlyFansPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/sync/overview",
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const fanslyPage = body.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana");
    const onlyFansOverview = body.pages.find((page: { pageLabel: string }) => page.pageLabel === "lana-of-sync");

    expect(fanslyPage.blocks.messages_live.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_conversations", cadenceSeconds: 1800 }),
    ]));
    expect(fanslyPage.blocks.messages_history.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_messages", cadenceSeconds: 86400 }),
    ]));
    expect(fanslyPage.blocks.connection.connectionStatus).toBeDefined();
    expect(onlyFansOverview.blocks.connection.connectionStatus).toBeDefined();
    expect(onlyFansOverview.blocks.audience.state).toBe("not_available");
    expect(onlyFansOverview.blocks.messages_live.state).not.toBe("not_available");
    expect(onlyFansOverview.blocks.messages_live.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_conversations", cadenceSeconds: 1800 }),
    ]));
    expect(onlyFansOverview.blocks.messages_history.state).not.toBe("not_available");
    expect(onlyFansOverview.blocks.messages_history.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_messages", cadenceSeconds: 86400 }),
    ]));
  }, 15_000);

  it("returns page block detail and the combined Messages block response", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    await seedSyncMonitorScenario(testDb, fixture.lanaPage.id, new Date("2026-03-24T12:00:00.000Z"));

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const blocksResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/sync/blocks",
      headers: { cookie: ownerCookie },
    });
    expect(blocksResponse.statusCode).toBe(200);
    expect(blocksResponse.json().page.blocks.messages_live.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_conversations", cadenceSeconds: 1800 }),
    ]));
    expect(blocksResponse.json().page.blocks.messages_history.intervals).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "dm_messages", cadenceSeconds: 86400 }),
    ]));

    const messagesResponse = await server.inject({
      method: "GET",
      url: "/api/v1/pages/lana/sync/blocks/messages",
      headers: { cookie: ownerCookie },
    });
    expect(messagesResponse.statusCode).toBe(200);
    expect(messagesResponse.json()).toMatchObject({
      page: {
        pageLabel: "lana",
        platform: "fansly",
      },
      block: {
        block: "messages_history",
        intervals: [
          { stream: "dm_messages", cadenceSeconds: 86400 },
        ],
      },
    });
  }, 15_000);

  it("supports owner-only manual block controls for trigger, pause, resume, and reset", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const activeTestDb = testDb;
    await server.close();
    server = await buildApiServer(createTestAppContext(activeTestDb, {
      databaseUrl: activeTestDb.connectionString,
    }));
    await server.ready();

    const now = new Date("2026-03-24T12:00:00.000Z");
    await ensurePageSyncStates(activeTestDb.db, {
      pageId: fixture.lanaPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const trigger = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/trigger",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "financials",
      },
    });
    expect(trigger.statusCode).toBe(200);
    expect(trigger.json()).toMatchObject({
      accepted: true,
      action: "trigger",
      pageLabel: "lana",
      block: "financials",
    });

    const pause = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/pause",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "audience",
      },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({
      accepted: true,
      action: "pause",
      block: "audience",
    });

    const resume = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/resume",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "audience",
      },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      accepted: true,
      action: "resume",
      block: "audience",
    });

    // Stage 2 destruction-door guard: the messages_history reset would
    // hard-delete every stored DM for the page, so it refuses until the
    // message archive exists (Stage 10).
    const reset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "messages_history",
      },
    });
    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({ error: "conflict" });

    // Checkpoint and top-spender resets stay available.
    const audienceReset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "audience",
      },
    });
    expect(audienceReset.statusCode, audienceReset.body).toBe(200);
    expect(audienceReset.json()).toMatchObject({
      accepted: true,
      action: "reset",
      pageLabel: "lana",
      block: "audience",
    });

    const financialsReset = await server.inject({
      method: "POST",
      url: "/api/v1/admin/sync/blocks/reset",
      headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lana",
        block: "financials",
      },
    });
    expect(financialsReset.statusCode, financialsReset.body).toBe(200);
    expect(financialsReset.json()).toMatchObject({
      accepted: true,
      action: "reset",
      pageLabel: "lana",
      block: "financials",
    });
  }, 15_000);

  it("gates archive reads to dashboard roles and scopes results (Stage 10)", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role, text_plain, occurred_at)
       values ($1, 'fansly', 'conv-arch-1', 'am-1', 'fan-arch', 'fan', 'archived hello world', now())`,
      [fixture.lanaPage.id],
    );

    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/archive/conversations/conv-arch-1/messages",
      headers: { cookie: ownerCookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).toMatchObject({
      messageRef: "am-1",
      platform: "fansly",
      textPlain: "archived hello world",
    });

    const searched = await server.inject({
      method: "GET",
      url: "/api/v1/archive/search?q=hello%20world",
      headers: { cookie: ownerCookie },
    });
    expect(searched.statusCode, searched.body).toBe(200);
    expect(searched.json()).toHaveLength(1);

    // Chatter bearer keys are not a dashboard surface — 403 on both.
    const appContext = createTestAppContext(testDb);
    const chatterKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const chatterSearch = await server.inject({
      method: "GET",
      url: "/api/v1/archive/search?q=hello%20world",
      headers: { authorization: `Bearer ${chatterKey.key}` },
    });
    expect(chatterSearch.statusCode).toBe(403);
    const chatterList = await server.inject({
      method: "GET",
      url: "/api/v1/archive/conversations/conv-arch-1/messages",
      headers: { authorization: `Bearer ${chatterKey.key}` },
    });
    expect(chatterList.statusCode).toBe(403);
  });

  it("soft-deletes pages: tombstone keeps facts, RESTRICT blocks raw DELETE (Stage 13)", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    // A dedicated fact-bearing page (lana must stay live for later tests).
    const spareModel = await createModel(testDb.db, {
      slug: "stage13-model",
      name: "Stage 13 Model",
    });
    const factPage = await createFanslyPage(testDb.db, {
      modelId: spareModel.id,
      label: "stage13-facts",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: factPage.id,
      source: "fansly:rest",
      transactionId: "stage13-tx-1",
      rawType: "2110",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "1",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 8_000n,
      creatorNetAmountMills: 8_000n,
      occurredAt: new Date("2026-06-01T00:00:00Z"),
    });

    // DELETE route on a fact-bearing page tombstones — no 409, no data loss.
    const softDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-facts",
      headers: { cookie: ownerCookie },
    });
    expect(softDelete.statusCode, softDelete.body).toBe(200);
    expect(softDelete.json()).toEqual({ deleted: true });

    const tombstoned = await testDb.pool.query<{ status: string; deleted_at: Date | null }>(
      "select status, deleted_at from pages where label = 'stage13-facts'",
    );
    expect(tombstoned.rows[0]?.status).toBe("deleted");
    expect(tombstoned.rows[0]?.deleted_at).not.toBeNull();
    const factsRemain = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from transactions where platform_account_id = $1",
      [factPage.id],
    );
    expect(factsRemain.rows[0]?.count).toBe("1");

    // The 38-FK cascade door is closed: a raw DELETE refuses at the FK level.
    await expect(
      testDb.pool.query("delete from pages where label = 'stage13-facts'"),
    ).rejects.toThrow(/violates foreign key constraint/);

    // A tombstoned page is gone from operational surfaces: repeat delete 404s,
    // admin list omits it.
    const repeatDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-facts",
      headers: { cookie: ownerCookie },
    });
    expect(repeatDelete.statusCode).toBe(404);
    const adminPages = await server.inject({
      method: "GET",
      url: "/api/v1/admin/pages",
      headers: { cookie: ownerCookie },
    });
    expect(adminPages.statusCode).toBe(200);
    expect(JSON.stringify(adminPages.json())).not.toContain("stage13-facts");

    // An empty page tombstones the same way (row remains, status flips).
    await createFanslyPage(testDb.db, {
      modelId: spareModel.id,
      label: "stage13-empty",
    });
    const emptyDelete = await server.inject({
      method: "DELETE",
      url: "/api/v1/admin/pages/stage13-empty",
      headers: { cookie: ownerCookie },
    });
    expect(emptyDelete.statusCode, emptyDelete.body).toBe(200);
    expect(emptyDelete.json()).toEqual({ deleted: true });
    const emptyRow = await testDb.pool.query<{ status: string }>(
      "select status from pages where label = 'stage13-empty'",
    );
    expect(emptyRow.rows[0]?.status).toBe("deleted");
  });

  it("lists recent sync requests with field mapping, scope-aware proxy gaps, and since filtering", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const currentTestDb = testDb!;
    const currentFixture = fixture!;
    const now = new Date();
    const seeded = await seedSyncRequestsScenario(currentTestDb, {
      lanaPageId: currentFixture.lanaPage.id,
      lilyPageId: currentFixture.lilyPage.id,
      now,
    });

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const ownerResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: ownerCookie },
    });

    expect(ownerResponse.statusCode).toBe(200);
    const ownerBody = ownerResponse.json();
    expect(ownerBody).toHaveLength(5);
    expect(ownerBody.map((item: { timestamp: string }) => item.timestamp)).toEqual([
      seeded.lanaStartedAt.toISOString(),
      seeded.lilySharedAt.toISOString(),
      seeded.lilyGhostAt.toISOString(),
      seeded.lanaRetryAt.toISOString(),
      seeded.lanaFailedAt.toISOString(),
    ]);
    expect(ownerBody[0]).toMatchObject({
      timestamp: seeded.lanaStartedAt.toISOString(),
      pageLabel: "lana",
      platform: "fansly",
      stream: "dm_messages",
      operation: "messages",
      endpoint: "/message",
      method: "GET",
      attemptNumber: 1,
      status: "started",
      httpStatusCode: null,
      durationMs: null,
      rateLimitWaitMs: 1200,
      groupId: "group-live-1",
      partnerUsername: "fan_live",
      returnedItems: null,
      syncDone: null,
      proxyGapMs: null,
    });
    expect(ownerBody[1]).toMatchObject({
      timestamp: seeded.lilySharedAt.toISOString(),
      pageLabel: "lily1",
      platform: "fansly",
      stream: "followers",
      operation: "followers",
      endpoint: "/account/:accountId/followersnew",
      method: "GET",
      attemptNumber: 1,
      status: "success",
      httpStatusCode: 200,
      durationMs: 240,
      rateLimitWaitMs: null,
      groupId: null,
      proxyGapMs: 1000,
    });
    expect(ownerBody[2]).toMatchObject({
      timestamp: seeded.lilyGhostAt.toISOString(),
      pageLabel: "lily1",
      platform: "fansly",
      stream: "dm_messages",
      operation: "messages",
      endpoint: "/message",
      method: "GET",
      attemptNumber: 1,
      status: "success",
      httpStatusCode: 200,
      durationMs: 320,
      rateLimitWaitMs: null,
      groupId: "group-ghost-1",
      partnerUsername: null,
      returnedItems: 2,
      syncDone: true,
      proxyGapMs: null,
    });
    expect(ownerBody[3]).toMatchObject({
      timestamp: seeded.lanaRetryAt.toISOString(),
      pageLabel: "lana",
      platform: "fansly",
      stream: "transactions",
      operation: "earnings_transactions",
      endpoint: "/account/wallets/earnings/transactions",
      method: "GET",
      attemptNumber: 2,
      status: "retry",
      httpStatusCode: 429,
      durationMs: 650,
      rateLimitWaitMs: 2500,
      groupId: null,
      proxyGapMs: 4000,
    });
    expect(ownerBody[4]).toMatchObject({
      timestamp: seeded.lanaFailedAt.toISOString(),
      pageLabel: "lana",
      stream: "followers",
      status: "failed",
      httpStatusCode: 500,
      durationMs: 900,
      proxyGapMs: null,
    });

    const withOlderSince = await server.inject({
      method: "GET",
      url: `/api/v1/sync/requests?since=${encodeURIComponent(new Date(now.getTime() - 120_000).toISOString())}&limit=10`,
      headers: { cookie: ownerCookie },
    });
    expect(withOlderSince.statusCode).toBe(200);
    expect(withOlderSince.json()).toHaveLength(6);
    expect(withOlderSince.json().at(-1)).toMatchObject({
      timestamp: seeded.oldAttemptAt.toISOString(),
      endpoint: "/account/me",
      method: "GET",
      status: "success",
    });

    const leadLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "lead-secret" },
    });
    const leadCookie = sessionCookieFrom(leadLogin);
    const leadResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: leadCookie },
    });

    expect(leadResponse.statusCode).toBe(200);
    const leadBody = leadResponse.json();
    expect(leadBody.map((item: { pageLabel: string }) => item.pageLabel)).toEqual([
      "lana",
      "lana",
      "lana",
    ]);
    expect(leadBody[0]?.proxyGapMs).toBeNull();
    expect(leadBody[1]).toMatchObject({
      timestamp: seeded.lanaRetryAt.toISOString(),
      proxyGapMs: 5000,
    });

    await unassignPageFromUser(createTestAppContext(currentTestDb), {
      username: "lead",
      pageLabel: "lana",
    }, { source: "cli" });

    const noScopeResponse = await server.inject({
      method: "GET",
      url: "/api/v1/sync/requests?limit=10",
      headers: { cookie: leadCookie },
    });
    expect(noScopeResponse.statusCode).toBe(200);
    expect(noScopeResponse.json()).toEqual([]);
  }, 15_000);

  it("clamps sync request limits to 500 rows", async (context) => {
    if (!testDb || !server || !fixture) {
      context.skip();
      return;
    }

    const currentTestDb = testDb!;
    const currentFixture = fixture!;
    const now = new Date();
    const bulkRun = await seedMonitorRunningRun(currentTestDb, {
      pageId: currentFixture.lanaPage.id,
      stream: "light",
      startedAt: new Date(now.getTime() - 10_000),
    });

    await Promise.all(
      Array.from({ length: 510 }, (_, index) => seedMonitorAttempt(currentTestDb, {
        runId: bulkRun.id,
        pageId: currentFixture.lanaPage.id,
        stream: "light",
        operation: "account_me",
        startedAt: new Date(now.getTime() - index),
        state: "started",
        requestShape: {
          endpointTemplate: "/account/me",
          method: "GET",
          egressKey: "bulk-proxy",
        },
      })),
    );

    const ownerLogin = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" },
    });
    const ownerCookie = sessionCookieFrom(ownerLogin);

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/sync/requests?since=${encodeURIComponent(new Date(now.getTime() - 120_000).toISOString())}&limit=999`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(500);
    expect(body[0]).toMatchObject({
      timestamp: now.toISOString(),
      endpoint: "/account/me",
    });
    expect(body.at(-1)?.timestamp).toBe(new Date(now.getTime() - 499).toISOString());
  }, 30_000);

  it("ingests desktop client-capture batches idempotently on the Stage 11 lane", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const issuedKey = await issueChatterApiKey(appContext, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });
    const headers = {
      authorization: `Bearer ${issuedKey.key}`,
      "x-client-version": "0.1.29",
    };
    const batch = {
      events: [
        {
          clientEventId: "11111111-1111-4111-8111-111111111111",
          kind: "ai_acceptance",
          observedAt: "2026-07-05T12:00:00.000Z",
          payload: { suggestionId: "s1", outcome: "inserted" },
          pageLabel: "lana",
        },
        {
          // Unknown kind: journaled, never dropped (capture-first).
          clientEventId: "22222222-2222-4222-8222-222222222222",
          kind: "mystery_metric",
          observedAt: "2026-07-05T12:00:01.000Z",
          payload: { n: 1 },
        },
      ],
    };

    const first = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers,
      payload: batch,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 2, duplicates: 0 });

    const { rows } = await testDb.pool.query<{
      kind: string;
      producer: string;
      source: string;
      account_id: string | null;
      actor_principal_id: string;
      idempotency_key: string;
    }>(`
      select kind, producer, source, account_id::text, actor_principal_id::text,
             idempotency_key
      from observations where source = 'client_capture' order by kind
    `);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "desktop.ai_acceptance",
      producer: "desktop@0.1.29",
      source: "client_capture",
    });
    expect(rows[0]!.account_id).not.toBeNull();
    expect(rows[0]!.idempotency_key).toMatch(/^\d+:11111111-1111-4111-8111-111111111111$/);
    expect(rows[1]).toMatchObject({ kind: "desktop.unknown:mystery_metric", account_id: null });

    // Resend the drained batch verbatim: all duplicates, zero new rows.
    const second = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers,
      payload: batch,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: 0, duplicates: 2 });
    const { rows: countRows } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where source = 'client_capture'",
    );
    expect(countRows).toEqual([{ n: "2" }]);

    // Schema-invalid batch is all-or-nothing: 400, no partial writes.
    const invalid = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers,
      payload: {
        events: [
          {
            clientEventId: "33333333-3333-4333-8333-333333333333",
            kind: "send_audit",
            observedAt: "2026-07-05T12:00:02.000Z",
            payload: { ok: true },
          },
          {
            clientEventId: "44444444-4444-4444-8444-444444444444",
            kind: "send_audit",
            observedAt: "not-a-date",
            payload: { ok: false },
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_ingest_event" });
    const { rows: afterInvalid } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where source = 'client_capture'",
    );
    expect(afterInvalid).toEqual([{ n: "2" }]);

    // The version header is required; bearer keys are the only credential.
    const noVersion = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: { authorization: `Bearer ${issuedKey.key}` },
      payload: batch,
    });
    expect(noVersion.statusCode).toBe(400);
    expect(noVersion.json()).toMatchObject({ error: "missing_client_version" });

    const unauthenticated = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: { "x-client-version": "0.1.29" },
      payload: batch,
    });
    expect(unauthenticated.statusCode).toBe(401);

    // Stage 12: harvest kinds journal VERBATIM under the desktop-harvest
    // producer (x-client-version 'harvest-<app version>').
    const harvest = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: {
        authorization: `Bearer ${issuedKey.key}`,
        "x-client-version": "harvest-0.1.29",
      },
      payload: {
        events: [{
          clientEventId: "55555555-5555-4555-8555-555555555555",
          kind: "harvest.outbox",
          observedAt: "2026-05-01T09:00:00.000Z",
          payload: { table: "outbox", machineId: "m-1", row: { id: 7 } },
        }],
      },
    });
    expect(harvest.statusCode).toBe(200);
    expect(harvest.json()).toEqual({ accepted: 1, duplicates: 0 });
    const { rows: harvestRows } = await testDb.pool.query<{ kind: string; producer: string }>(
      "select kind, producer from observations where kind like 'harvest.%'",
    );
    expect(harvestRows).toEqual([{ kind: "harvest.outbox", producer: "desktop-harvest@0.1.29" }]);

    // Harvest account resolution: payload.ofapiAccountId → pages.ofapi_account_id
    // (harvest events carry no pageLabel — the desktop knows only its OFAPI id).
    // The uploader's key must be ASSIGNED to the page it attributes to.
    const harvestModel = await createModel(testDb.db, { slug: "hv-model", name: "HV" });
    const harvestPage = await createOnlyFansPage(testDb.db, {
      modelId: harvestModel.id,
      label: "hv-of",
    });
    await setPageOfapiAccountId(testDb.db, {
      pageId: harvestPage.id,
      ofapiAccountId: "acct_hv",
    });
    await createUserAccount(appContext, {
      username: "hv-uploader",
      role: "chatter",
    }, { source: "cli" });
    const harvestKey = await issueChatterApiKey(appContext, {
      username: "hv-uploader",
      pageLabel: "hv-of",
    }, { source: "cli" });
    const resolved = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: {
        authorization: `Bearer ${harvestKey.key}`,
        "x-client-version": "harvest-0.1.29",
      },
      payload: {
        events: [{
          clientEventId: "66666666-6666-4666-8666-666666666666",
          kind: "harvest.messages",
          observedAt: "2026-05-01T09:05:00.000Z",
          payload: {
            table: "messages",
            machineId: "m-1",
            ofapiAccountId: "acct_hv",
            row: { message_id: "1", chat_id: "9", created_at: "2026-05-01T09:05:00+00:00", is_sent_by_me: 0 },
          },
        }],
      },
    });
    expect(resolved.statusCode).toBe(200);
    const { rows: resolvedRows } = await testDb.pool.query<{ account_id: string | null }>(
      "select account_id::text from observations where kind = 'harvest.messages'",
    );
    expect(resolvedRows).toEqual([{ account_id: String(harvestPage.id) }]);

    // Page-scope gate: the lana-assigned key referencing acct_hv journals the
    // fact WITHOUT attribution — a key can never write into pages it is not
    // assigned to (NULL-account observations never canonicalize).
    const outOfScope = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: {
        authorization: `Bearer ${issuedKey.key}`,
        "x-client-version": "harvest-0.1.29",
      },
      payload: {
        events: [{
          clientEventId: "77777777-7777-4777-8777-777777777777",
          kind: "harvest.messages",
          observedAt: "2026-05-01T09:06:00.000Z",
          payload: {
            table: "messages",
            machineId: "m-2",
            ofapiAccountId: "acct_hv",
            row: { message_id: "2", chat_id: "9", created_at: "2026-05-01T09:06:00+00:00", is_sent_by_me: 0 },
          },
        }],
      },
    });
    expect(outOfScope.statusCode).toBe(200);
    const { rows: scopedRows } = await testDb.pool.query<{ account_id: string | null }>(
      `select account_id::text from observations
       where kind = 'harvest.messages' order by idempotency_key`,
    );
    expect(scopedRows.map((row) => row.account_id)).toContain(null);
    expect(scopedRows).toHaveLength(2);

    // Producer gate: a NON-harvest client version cannot journal into the
    // harvest namespace — the kind falls into the unknown bucket, which the
    // canonicalizer never turns into platform truth.
    const forged = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers,
      payload: {
        events: [{
          clientEventId: "88888888-8888-4888-8888-888888888888",
          kind: "harvest.messages",
          observedAt: "2026-05-01T09:07:00.000Z",
          payload: {
            table: "messages",
            machineId: "m-3",
            ofapiAccountId: "acct_hv",
            row: { message_id: "3", chat_id: "9", created_at: "2026-05-01T09:07:00+00:00", is_sent_by_me: 1 },
          },
        }],
      },
    });
    expect(forged.statusCode).toBe(200);
    const { rows: forgedRows } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where kind = 'desktop.unknown:harvest.messages'",
    );
    expect(forgedRows).toEqual([{ n: "1" }]);
  });
});
