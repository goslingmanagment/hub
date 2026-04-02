import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  createFanslyPage,
  createModel,
  finalizePageDmConversationMessageSync,
  getPageDmSyncCoverage,
  getPageConversationPreview,
  getPageConversationMessages,
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

  it(`prunes message history to ${PAGE_DM_MESSAGE_HISTORY_LIMIT} and returns preview rows oldest-to-newest`, async (context) => {
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
