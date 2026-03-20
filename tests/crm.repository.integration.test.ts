import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  createFanslyPage,
  createModel,
  finalizePageDmConversationMessageSync,
  getCrmFreshnessCoverage,
  getCrmConversationPreview,
  getPageConversationMessages,
  listCrmReactivation,
  listCrmRetention,
  recalculateFanPageSpend,
  selectNextPageDmMessageSyncCandidate,
  upsertFanPage,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
} from "@agency_hub_core/shared";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createCrmPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

describe("crm repository integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("selects the primary visible conversation by visibility, recency, then conversation id", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-17T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-retention-primary");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-primary",
      username: "fan_primary",
      displayName: "Fan Primary",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isSubscriber: true,
      subscriberSince: new Date("2026-02-01T00:00:00.000Z"),
      subscriptionExpiresAt: new Date("2026-03-22T12:00:00.000Z"),
      autoRenew: false,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-primary",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: false,
      sourceCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
      endsAt: new Date("2026-03-22T12:00:00.000Z"),
      subscriptionTierName: "VIP",
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "tx-primary",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 9000n,
      sourceDestinationAmountMills: 9000n,
      creatorNetAmountMills: 9000n,
      occurredAt: new Date("2026-03-10T12:00:00.000Z"),
    });
    await recalculateFanPageSpend(testDb.db, page.id);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "visible-1",
      partnerPlatformUserId: "fan-primary",
      partnerUsername: "fan_primary",
      partnerDisplayName: "Fan Primary",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-visible-1",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-14T00:00:00.000Z"),
      lastMessageSenderId: "fan-primary",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "visible one",
      lastFanMessageAt: new Date("2026-03-14T00:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "visible-2",
      partnerPlatformUserId: "fan-primary",
      partnerUsername: "fan_primary",
      partnerDisplayName: "Fan Primary",
      conversationFlags: 0,
      unreadCount: 3,
      subscriptionTierId: null,
      lastMessageId: "msg-visible-2",
      lastUnreadMessageId: "msg-visible-2",
      lastMessageAt: new Date("2026-03-14T00:00:00.000Z"),
      lastMessageSenderId: "fan-primary",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "visible two",
      lastFanMessageAt: new Date("2026-03-14T00:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "hidden-newer",
      partnerPlatformUserId: "fan-primary",
      partnerUsername: "fan_primary",
      partnerDisplayName: "Fan Primary",
      conversationFlags: 0,
      unreadCount: 9,
      subscriptionTierId: null,
      lastMessageId: "msg-hidden",
      lastUnreadMessageId: "msg-hidden",
      lastMessageAt: new Date("2026-03-16T00:00:00.000Z"),
      lastMessageSenderId: "fan-primary",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hidden newer",
      lastFanMessageAt: new Date("2026-03-16T00:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: false,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const retention = await listCrmRetention(testDb.db, {
      platformAccountId: page.id,
      limit: 10,
      offset: 0,
      showHandled: false,
      now,
    });

    expect(retention.items).toHaveLength(1);
    expect(retention.items[0]).toMatchObject({
      platformConversationId: "visible-2",
      unreadCount: 3,
      touchpointCode: "5d",
      isSoftTouchpoint: false,
      isHandled: false,
      subscriptionTierName: "VIP",
    });
  });

  it("suppresses handled retention rows unless showHandled=true", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-17T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-retention-handled");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-handled",
      username: "fan_handled",
      displayName: "Fan Handled",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isSubscriber: true,
      subscriberSince: new Date("2026-02-01T00:00:00.000Z"),
      subscriptionExpiresAt: new Date("2026-03-20T12:00:00.000Z"),
      autoRenew: true,
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: "sub-handled",
      platformAccountId: page.id,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: true,
      sourceCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
      endsAt: new Date("2026-03-20T12:00:00.000Z"),
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "handled-conv",
      partnerPlatformUserId: "fan-handled",
      partnerUsername: "fan_handled",
      partnerDisplayName: "Fan Handled",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "handled-msg",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-17T12:30:00.000Z"),
      lastMessageSenderId: "acct",
      lastMessageSenderRole: "model",
      lastMessagePreview: "recent touch",
      lastFanMessageAt: null,
      lastModelMessageAt: new Date("2026-03-17T12:30:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const hidden = await listCrmRetention(testDb.db, {
      platformAccountId: page.id,
      limit: 10,
      offset: 0,
      showHandled: false,
      now,
    });
    const shown = await listCrmRetention(testDb.db, {
      platformAccountId: page.id,
      limit: 10,
      offset: 0,
      showHandled: true,
      now,
    });

    expect(hidden.items).toHaveLength(0);
    expect(shown.items).toHaveLength(1);
    expect(shown.items[0]?.isHandled).toBe(true);
    expect(shown.items[0]?.touchpointCode).toBe("3d");
  });

  it("computes reactivation score from mills and ignores fan_pages.last_seen_at", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-17T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-reactivation");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-reactivation",
      username: "fan_reactivation",
      displayName: "Fan Reactivation",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      isSubscriber: false,
      subscriberSince: new Date("2026-01-01T00:00:00.000Z"),
      subscriptionExpiresAt: new Date("2026-02-01T00:00:00.000Z"),
      autoRenew: false,
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      transactionId: "tx-reactivation",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 12000n,
      sourceDestinationAmountMills: 12000n,
      creatorNetAmountMills: 12000n,
      occurredAt: new Date("2026-02-15T12:00:00.000Z"),
    });
    await recalculateFanPageSpend(testDb.db, page.id);
    await testDb.pool.query(
      `
        update fan_pages
        set last_seen_at = $1
        where platform_account_id = $2
          and fan_id = $3
      `,
      [new Date("2026-03-17T11:59:59.000Z"), page.id, fan.id],
    );

    const reactivation = await listCrmReactivation(testDb.db, {
      platformAccountId: page.id,
      limit: 10,
      offset: 0,
      now,
    });

    expect(reactivation.items).toHaveLength(1);
    expect(reactivation.items[0]).toMatchObject({
      platformConversationId: null,
      noDmHistory: true,
      silenceDays: 30,
    });
    expect(reactivation.items[0]?.reactivationScore).toBe(360);
  });

  it("skips stale mismatched heads and falls through to pending backfill conversations", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-dm-sync-stale");
    const [staleFan, backlogFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-stale",
        username: "fan_stale",
        displayName: "Fan Stale",
      },
      {
        platform: "fansly",
        platformUserId: "fan-backlog",
        username: "fan_backlog",
        displayName: "Fan Backlog",
      },
    ]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: staleFan.id,
      platformConversationId: "stale-mismatch",
      partnerPlatformUserId: "fan-stale",
      partnerUsername: "fan_stale",
      partnerDisplayName: "Fan Stale",
      conversationFlags: 0,
      unreadCount: 99,
      subscriptionTierId: null,
      lastMessageId: "msg-101",
      lastUnreadMessageId: "msg-101",
      lastMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastMessageSenderId: "fan-stale",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "stale mismatch",
      lastFanMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 25,
      newestStoredMessageId: "msg-100",
      oldestStoredMessageId: "msg-076",
      messageBackfillComplete: true,
      lastMessageSyncAt: new Date("2026-03-19T12:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: backlogFan.id,
      platformConversationId: "pending-backfill",
      partnerPlatformUserId: "fan-backlog",
      partnerUsername: "fan_backlog",
      partnerDisplayName: "Fan Backlog",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: null,
      lastUnreadMessageId: null,
      lastMessageAt: null,
      lastMessageSenderId: null,
      lastMessageSenderRole: "unknown",
      lastMessagePreview: null,
      lastFanMessageAt: null,
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const candidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now,
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platformConversationId).toBe("pending-backfill");
  });

  it("prioritizes fresh mismatched heads ahead of first-time backfills", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-dm-sync-fresh");
    const [freshFan, backlogFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-fresh",
        username: "fan_fresh",
        displayName: "Fan Fresh",
      },
      {
        platform: "fansly",
        platformUserId: "fan-backlog-priority",
        username: "fan_backlog_priority",
        displayName: "Fan Backlog Priority",
      },
    ]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: freshFan.id,
      platformConversationId: "fresh-mismatch",
      partnerPlatformUserId: "fan-fresh",
      partnerUsername: "fan_fresh",
      partnerDisplayName: "Fan Fresh",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-201",
      lastUnreadMessageId: "msg-201",
      lastMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastMessageSenderId: "fan-fresh",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "fresh mismatch",
      lastFanMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 25,
      newestStoredMessageId: "msg-200",
      oldestStoredMessageId: "msg-176",
      messageBackfillComplete: true,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: backlogFan.id,
      platformConversationId: "backfill-secondary",
      partnerPlatformUserId: "fan-backlog-priority",
      partnerUsername: "fan_backlog_priority",
      partnerDisplayName: "Fan Backlog Priority",
      conversationFlags: 0,
      unreadCount: 999,
      subscriptionTierId: null,
      lastMessageId: null,
      lastUnreadMessageId: null,
      lastMessageAt: null,
      lastMessageSenderId: null,
      lastMessageSenderRole: "unknown",
      lastMessagePreview: null,
      lastFanMessageAt: null,
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const candidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now,
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platformConversationId).toBe("fresh-mismatch");
  });

  it("excludes conversations marked out of message sync from candidate selection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-dm-sync-excluded");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-excluded",
      username: "fan_excluded",
      displayName: "Fan Excluded",
    }]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "excluded-conversation",
      partnerPlatformUserId: "fan-excluded",
      partnerUsername: "fan_excluded",
      partnerDisplayName: "Fan Excluded",
      conversationFlags: 0,
      unreadCount: 3,
      subscriptionTierId: null,
      lastMessageId: "msg-401",
      lastUnreadMessageId: "msg-401",
      lastMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastMessageSenderId: "fan-excluded",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "excluded conversation",
      lastFanMessageAt: new Date("2026-03-19T12:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      },
    });

    const candidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now,
    });

    expect(candidate).toBeNull();
  });

  it("does not reselect empty conversations once backfill is complete", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-dm-sync-empty-complete");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-empty-complete",
      username: "fan_empty_complete",
      displayName: "Fan Empty Complete",
    }]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "empty-complete",
      partnerPlatformUserId: "fan-empty-complete",
      partnerUsername: "fan_empty_complete",
      partnerDisplayName: "Fan Empty Complete",
      conversationFlags: 0,
      unreadCount: 5,
      subscriptionTierId: null,
      lastMessageId: null,
      lastUnreadMessageId: null,
      lastMessageAt: null,
      lastMessageSenderId: null,
      lastMessageSenderRole: "unknown",
      lastMessagePreview: null,
      lastFanMessageAt: null,
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: true,
      lastMessageSyncAt: new Date("2026-03-19T12:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const candidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now,
    });

    expect(candidate).toBeNull();
  });

  it("keeps null-last-message-at mismatches eligible before the first message sync", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createCrmPage(testDb, "crm-dm-sync-null-last-message-at");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-null-last-message-at",
      username: "fan_null_last_message_at",
      displayName: "Fan Null Last Message At",
    }]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "null-last-message-at",
      partnerPlatformUserId: "fan-null-last-message-at",
      partnerUsername: "fan_null_last_message_at",
      partnerDisplayName: "Fan Null Last Message At",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-301",
      lastUnreadMessageId: "msg-301",
      lastMessageAt: null,
      lastMessageSenderId: null,
      lastMessageSenderRole: "unknown",
      lastMessagePreview: null,
      lastFanMessageAt: null,
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: true,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const candidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now,
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platformConversationId).toBe("null-last-message-at");
  });

  it("does not count message-sync-excluded conversations in pending CRM backfill coverage", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createCrmPage(testDb, "crm-freshness-excluded");
    const [includedFan, excludedFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-included",
        username: "fan_included",
        displayName: "Fan Included",
      },
      {
        platform: "fansly",
        platformUserId: "fan-excluded-freshness",
        username: "fan_excluded_freshness",
        displayName: "Fan Excluded Freshness",
      },
    ]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: includedFan.id,
      platformConversationId: "freshness-included",
      partnerPlatformUserId: "fan-included",
      partnerUsername: "fan_included",
      partnerDisplayName: "Fan Included",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-501",
      lastUnreadMessageId: "msg-501",
      lastMessageAt: new Date("2026-03-20T10:00:00.000Z"),
      lastMessageSenderId: "fan-included",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "included",
      lastFanMessageAt: new Date("2026-03-20T10:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: excludedFan.id,
      platformConversationId: "freshness-excluded",
      partnerPlatformUserId: "fan-excluded-freshness",
      partnerUsername: "fan_excluded_freshness",
      partnerDisplayName: "Fan Excluded Freshness",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-601",
      lastUnreadMessageId: "msg-601",
      lastMessageAt: new Date("2026-03-20T11:00:00.000Z"),
      lastMessageSenderId: "fan-excluded-freshness",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "excluded",
      lastFanMessageAt: new Date("2026-03-20T11:00:00.000Z"),
      lastModelMessageAt: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {
        [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]:
          FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
      },
    });

    const freshness = await getCrmFreshnessCoverage(testDb.db, page.id);

    expect(freshness.pendingMessageBackfillCount).toBe(1);
  });

  it(`prunes message history to ${PAGE_DM_MESSAGE_HISTORY_LIMIT} and returns preview rows oldest-to-newest`, async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createCrmPage(testDb, "crm-preview");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-preview",
      username: "fan_preview",
      displayName: "Fan Preview",
    }]);

    const conversation = await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "preview-conv",
      partnerPlatformUserId: "fan-preview",
      partnerUsername: "fan_preview",
      partnerDisplayName: "Fan Preview",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-080",
      lastUnreadMessageId: "msg-080",
      lastMessageAt: new Date("2026-03-17T13:20:00.000Z"),
      lastMessageSenderId: "fan-preview",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "message 80",
      lastFanMessageAt: new Date("2026-03-17T13:20:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: 80 }, (_value, index) => {
      const sequence = index + 1;
      const messageId = `msg-${String(sequence).padStart(3, "0")}`;
      return {
        conversationId: conversation.id,
        platformAccountId: page.id,
        platformMessageId: messageId,
        senderPlatformUserId: sequence % 2 === 0 ? "fan-preview" : "acct-preview",
        senderRole: sequence % 2 === 0 ? "fan" : "model",
        createdAt: new Date(Date.UTC(2026, 2, 17, 12, sequence, 0, 0)),
        content: `message ${sequence}`,
        totalTipAmountCents: sequence === 80 ? 500 : 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      };
    }));

    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: conversation.id,
      messageBackfillComplete: true,
      lastMessageSyncAt: new Date("2026-03-17T13:30:00.000Z"),
    });

    const storedMessages = await testDb.pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from page_dm_messages
        where conversation_id = $1
      `,
      [conversation.id],
    );
    const preview = await getCrmConversationPreview(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "preview-conv",
      limit: 10,
    });
    const newestFirst = await getPageConversationMessages(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "preview-conv",
      limit: 10,
    });

    expect(Number(storedMessages.rows[0]?.count ?? "0")).toBe(PAGE_DM_MESSAGE_HISTORY_LIMIT);
    expect(preview).not.toBeNull();
    expect(newestFirst).not.toBeNull();
    expect(preview?.conversation.storedMessageCount).toBe(PAGE_DM_MESSAGE_HISTORY_LIMIT);
    expect(preview?.conversation.messageBackfillComplete).toBe(true);
    expect(preview?.messages.map((message) => message.platformMessageId)).toEqual([
      "msg-071",
      "msg-072",
      "msg-073",
      "msg-074",
      "msg-075",
      "msg-076",
      "msg-077",
      "msg-078",
      "msg-079",
      "msg-080",
    ]);
    expect(preview?.messages[0]?.content).toBe("message 71");
    expect(preview?.messages[9]?.totalTipAmountCents).toBe(500);
    expect(newestFirst?.messages.map((message) => message.messageId)).toEqual([
      "msg-080",
      "msg-079",
      "msg-078",
      "msg-077",
      "msg-076",
      "msg-075",
      "msg-074",
      "msg-073",
      "msg-072",
      "msg-071",
    ]);
    expect(newestFirst?.messages[0]?.tipAmountCents).toBe(500);
  });
});
