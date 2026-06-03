import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT,
  PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT,
  createFanslyPage,
  createModel,
  finalizePageDmConversationMessageSync,
  getPageDmSyncCoverage,
  getPageConversationPreview,
  getPageConversationMessages,
  selectNextPageDmMessageDeepBackfillCandidate,
  selectNextPageDmMessageSyncCandidate,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
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

async function createTestPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

describe("page DM repository integration", () => {
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

  it("skips stale mismatched heads and falls through to pending backfill conversations", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-20T12:00:00.000Z");
    const page = await createTestPage(testDb, "page-dm-sync-stale");
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
    const page = await createTestPage(testDb, "page-dm-sync-fresh");
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
    const page = await createTestPage(testDb, "page-dm-sync-excluded");
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
    const page = await createTestPage(testDb, "page-dm-sync-empty-complete");
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
    const page = await createTestPage(testDb, "page-dm-sync-null-last-message-at");
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

  it("does not count message-sync-excluded conversations in pending conversation backfill coverage", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createTestPage(testDb, "page-dm-freshness-excluded");
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

    const freshness = await getPageDmSyncCoverage(testDb.db, page.id);

    expect(freshness.pendingMessageBackfillCount).toBe(1);
  });

  it("selects deep backfill candidates from partial windows and prioritizes spenders", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createTestPage(testDb, "page-dm-deep-backfill");
    const [spenderFan, regularFan, pendingFan, freshFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-deep-spender",
        username: "fan_deep_spender",
        displayName: "Fan Deep Spender",
      },
      {
        platform: "fansly",
        platformUserId: "fan-deep-regular",
        username: "fan_deep_regular",
        displayName: "Fan Deep Regular",
      },
      {
        platform: "fansly",
        platformUserId: "fan-deep-pending",
        username: "fan_deep_pending",
        displayName: "Fan Deep Pending",
      },
      {
        platform: "fansly",
        platformUserId: "fan-deep-fresh",
        username: "fan_deep_fresh",
        displayName: "Fan Deep Fresh",
      },
    ]);
    await testDb.pool.query(
      `
        insert into fan_spend_lifetime (
          platform_account_id,
          fan_id,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at,
          updated_at
        )
        values ($1, $2, 100000, 80000, $3, now())
      `,
      [page.id, spenderFan.id, new Date("2026-03-01T00:00:00.000Z")],
    );

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: spenderFan.id,
      platformConversationId: "deep-spender",
      partnerPlatformUserId: "fan-deep-spender",
      partnerUsername: "fan_deep_spender",
      partnerDisplayName: "Fan Deep Spender",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-500",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T08:00:00.000Z"),
      lastMessageSenderId: "fan-deep-spender",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "spender",
      storedMessageCount: 25,
      newestStoredMessageId: "msg-500",
      oldestStoredMessageId: "msg-476",
      messageCoverageStatus: "partial_window",
      messageBackfillComplete: false,
      lastMessageSyncAt: new Date("2026-03-18T08:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: regularFan.id,
      platformConversationId: "deep-regular",
      partnerPlatformUserId: "fan-deep-regular",
      partnerUsername: "fan_deep_regular",
      partnerDisplayName: "Fan Deep Regular",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-300",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T08:00:00.000Z"),
      lastMessageSenderId: "fan-deep-regular",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "regular",
      storedMessageCount: 25,
      newestStoredMessageId: "msg-300",
      oldestStoredMessageId: "msg-276",
      messageCoverageStatus: "partial_window",
      messageBackfillComplete: false,
      lastMessageSyncAt: new Date("2026-03-18T08:05:00.000Z"),
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: pendingFan.id,
      platformConversationId: "normal-pending",
      partnerPlatformUserId: "fan-deep-pending",
      partnerUsername: "fan_deep_pending",
      partnerDisplayName: "Fan Deep Pending",
      conversationFlags: 0,
      unreadCount: 50,
      subscriptionTierId: null,
      lastMessageId: null,
      lastUnreadMessageId: null,
      lastMessageAt: null,
      lastMessageSenderId: null,
      lastMessageSenderRole: "unknown",
      lastMessagePreview: null,
      storedMessageCount: 0,
      newestStoredMessageId: null,
      oldestStoredMessageId: null,
      messageCoverageStatus: "pending_backfill",
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: freshFan.id,
      platformConversationId: "normal-fresh",
      partnerPlatformUserId: "fan-deep-fresh",
      partnerUsername: "fan_deep_fresh",
      partnerDisplayName: "Fan Deep Fresh",
      conversationFlags: 0,
      unreadCount: 100,
      subscriptionTierId: null,
      lastMessageId: "msg-901",
      lastUnreadMessageId: "msg-901",
      lastMessageAt: new Date("2026-03-18T09:00:00.000Z"),
      lastMessageSenderId: "fan-deep-fresh",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "fresh",
      storedMessageCount: 25,
      newestStoredMessageId: "msg-900",
      oldestStoredMessageId: "msg-876",
      messageCoverageStatus: "partial_window",
      messageBackfillComplete: false,
      lastMessageSyncAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const normalCandidate = await selectNextPageDmMessageSyncCandidate(testDb.db, {
      platformAccountId: page.id,
      now: new Date("2026-03-18T10:00:00.000Z"),
    });
    const deepCandidate = await selectNextPageDmMessageDeepBackfillCandidate(testDb.db, {
      platformAccountId: page.id,
    });

    expect(normalCandidate?.platformConversationId).toBe("normal-fresh");
    expect(deepCandidate?.platformConversationId).toBe("deep-spender");
    expect(deepCandidate?.retentionLimit).toBe(PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT);
    expect(deepCandidate?.isSpender).toBe(true);
  });

  it(`prunes regular message history to ${PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT} and returns preview rows oldest-to-newest`, async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createTestPage(testDb, "page-dm-preview");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-preview",
      username: "fan_preview",
      displayName: "Fan Preview",
    }]);

    const conversation = await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "preview-conversation",
      partnerPlatformUserId: "fan-preview",
      partnerUsername: "fan_preview",
      partnerDisplayName: "Fan Preview",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-130",
      lastUnreadMessageId: "msg-130",
      lastMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastMessageSenderId: "fan-preview",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "message 130",
      lastFanMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: 130 }, (_value, index) => {
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
        totalTipAmountCents: sequence === 130 ? 500 : 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      };
    }));

    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: conversation.id,
      messageCoverageStatus: "complete",
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
    const preview = await getPageConversationPreview(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "preview-conversation",
      limit: 10,
    });
    const newestFirst = await getPageConversationMessages(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "preview-conversation",
      limit: 10,
    });

    expect(Number(storedMessages.rows[0]?.count ?? "0")).toBe(PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT);
    expect(preview).not.toBeNull();
    expect(newestFirst).not.toBeNull();
    expect(preview?.conversation.storedMessageCount).toBe(PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT);
    expect(preview?.conversation.messageBackfillComplete).toBe(true);
    expect(preview?.messages.map((message) => message.platformMessageId)).toEqual([
      "msg-121",
      "msg-122",
      "msg-123",
      "msg-124",
      "msg-125",
      "msg-126",
      "msg-127",
      "msg-128",
      "msg-129",
      "msg-130",
    ]);
    expect(preview?.messages[0]?.content).toBe("message 121");
    expect(preview?.messages[9]?.totalTipAmountCents).toBe(500);
    expect(newestFirst?.messages.map((message) => message.messageId)).toEqual([
      "msg-130",
      "msg-129",
      "msg-128",
      "msg-127",
      "msg-126",
      "msg-125",
      "msg-124",
      "msg-123",
      "msg-122",
      "msg-121",
    ]);
    expect(newestFirst?.messages[0]?.tipAmountCents).toBe(500);
  });

  it(`prunes spender message history to ${PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT}`, async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createTestPage(testDb, "page-dm-spender-retention");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-spender-retention",
      username: "fan_spender_retention",
      displayName: "Fan Spender Retention",
    }]);
    await testDb.pool.query(
      `
        insert into fan_spend_lifetime (
          platform_account_id,
          fan_id,
          gross_amount_mills,
          creator_net_amount_mills,
          last_transaction_at,
          updated_at
        )
        values ($1, $2, 100000, 80000, $3, now())
      `,
      [page.id, fan.id, new Date("2026-03-01T00:00:00.000Z")],
    );

    const conversation = await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "spender-retention-conversation",
      partnerPlatformUserId: "fan-spender-retention",
      partnerUsername: "fan_spender_retention",
      partnerDisplayName: "Fan Spender Retention",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-530",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T08:50:00.000Z"),
      lastMessageSenderId: "fan-spender-retention",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "message 530",
      lastFanMessageAt: new Date("2026-03-18T08:50:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: 530 }, (_value, index) => {
      const sequence = index + 1;
      const messageId = `msg-${String(sequence).padStart(3, "0")}`;
      return {
        conversationId: conversation.id,
        platformAccountId: page.id,
        platformMessageId: messageId,
        senderPlatformUserId: sequence % 2 === 0 ? "fan-spender-retention" : "acct-spender-retention",
        senderRole: sequence % 2 === 0 ? "fan" : "model",
        createdAt: new Date(Date.UTC(2026, 2, 18, 8, sequence, 0, 0)),
        content: `message ${sequence}`,
        totalTipAmountCents: 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      };
    }));

    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: conversation.id,
      messageCoverageStatus: "partial_window",
      lastMessageSyncAt: new Date("2026-03-18T09:00:00.000Z"),
    });

    const storedMessages = await testDb.pool.query<{
      count: string;
      oldest: string | null;
      newest: string | null;
    }>(
      `
        select count(*)::text as count,
               min(platform_message_id) as oldest,
               max(platform_message_id) as newest
        from page_dm_messages
        where conversation_id = $1
      `,
      [conversation.id],
    );

    expect(Number(storedMessages.rows[0]?.count ?? "0")).toBe(PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT);
    expect(storedMessages.rows[0]?.oldest).toBe("msg-031");
    expect(storedMessages.rows[0]?.newest).toBe("msg-530");
  });
});
