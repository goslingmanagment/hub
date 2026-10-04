import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT,
  PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT,
  clearConversationSyncHealth,
  countConversationSyncFailuresByAccount,
  countPageDmThreadsByGeneration,
  createFanslyPage,
  createModel,
  deletePageDmMessageByPlatformMessageId,
  excludePageDmConversationMessageSync,
  finalizePageDmConversationMessageSync,
  getConversationSyncHealth,
  getPageDmMessageIdsAtOrBefore,
  getPageDmSyncCoverage,
  getPageConversationPreview,
  getPageConversationMessages,
  listPageDmThreadIdsByGeneration,
  listPageDmThreadIdsStampedWithGeneration,
  maxPageDmThreadGeneration,
  recordConversationSyncFailure,
  refreshPageDmConversationWindow,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  type Database,
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
import { hasSettled, waitForRowLockWait } from "./helpers/lock-waits.ts";

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

async function createGenerationPage(testDb: StartedTestDatabase, label: string) {
  const page = await createTestPage(testDb, label);
  if (!page) {
    throw new Error("test setup: page creation failed");
  }
  return page;
}

function generationThreadInput(
  platformAccountId: number,
  platformConversationId: string,
  lastSeenGeneration: number | null,
) {
  return {
    platformAccountId,
    fanId: null,
    platformConversationId,
    partnerPlatformUserId: `partner-${platformConversationId}`,
    partnerUsername: null,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: null,
    lastUnreadMessageId: null,
    lastMessageAt: null,
    lastMessageSenderId: null,
    lastMessageSenderRole: "unknown" as const,
    lastMessagePreview: null,
    isVisible: true,
    lastSeenGeneration,
    metadata: {},
  };
}

async function readThreadState(testDb: StartedTestDatabase, platformAccountId: number) {
  const { rows } = await testDb.pool.query<{
    platform_conversation_id: string;
    last_seen_generation: string | null;
    is_visible: boolean;
  }>(
    `select platform_conversation_id, last_seen_generation, is_visible
     from page_dm_threads
     where platform_account_id = $1
     order by platform_conversation_id`,
    [platformAccountId],
  );

  return Object.fromEntries(rows.map((row) => [
    row.platform_conversation_id,
    {
      generation: row.last_seen_generation === null ? null : Number(row.last_seen_generation),
      isVisible: row.is_visible,
    },
  ]));
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

  it(`prunes regular message history to ${PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT} and returns preview rows oldest-to-newest`, async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const messageCount = PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT + 30;
    const latestMessageId = `msg-${String(messageCount).padStart(4, "0")}`;
    const expectedPreviewIds = Array.from({ length: 10 }, (_value, index) => {
      const sequence = messageCount - 9 + index;
      return `msg-${String(sequence).padStart(4, "0")}`;
    });

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
      lastMessageId: latestMessageId,
      lastUnreadMessageId: latestMessageId,
      lastMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastMessageSenderId: "fan-preview",
      lastMessageSenderRole: "fan",
      lastMessagePreview: `message ${messageCount}`,
      lastFanMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: messageCount }, (_value, index) => {
      const sequence = index + 1;
      const messageId = `msg-${String(sequence).padStart(4, "0")}`;
      return {
        conversationId: conversation.id,
        platformAccountId: page.id,
        platformMessageId: messageId,
        senderPlatformUserId: sequence % 2 === 0 ? "fan-preview" : "acct-preview",
        senderRole: sequence % 2 === 0 ? "fan" : "model",
        createdAt: new Date(Date.UTC(2026, 2, 17, 12, sequence, 0, 0)),
        content: `message ${sequence}`,
        totalTipAmountCents: sequence === messageCount ? 500 : 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      };
    }));

    await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: conversation.id,
      messageCoverageStatus: "complete",
      headReadAt: new Date("2026-03-17T13:30:00.000Z"),
    });

    const storedMessages = await testDb.pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from page_dm_messages
        where conversation_id = $1
          and deleted_at is null
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
    expect(preview?.messages.map((message) => message.platformMessageId)).toEqual(expectedPreviewIds);
    expect(preview?.messages[0]?.content).toBe(`message ${messageCount - 9}`);
    expect(preview?.messages[9]?.totalTipAmountCents).toBe(500);
    expect(newestFirst?.messages.map((message) => message.messageId)).toEqual([...expectedPreviewIds].reverse());
    expect(newestFirst?.messages[0]?.tipAmountCents).toBe(500);
  });

  it("keeps every stored message when enforceRetention is false (Stage 1 stand-down)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const messageCount = PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT + 30;
    const latestMessageId = `msg-${String(messageCount).padStart(4, "0")}`;

    const page = await createTestPage(testDb, "page-dm-standdown");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-standdown",
      username: "fan_standdown",
      displayName: "Fan Standdown",
    }]);

    const conversation = await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "standdown-conversation",
      partnerPlatformUserId: "fan-standdown",
      partnerUsername: "fan_standdown",
      partnerDisplayName: "Fan Standdown",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: latestMessageId,
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastMessageSenderId: "fan-standdown",
      lastMessageSenderRole: "fan",
      lastMessagePreview: `message ${messageCount}`,
      lastFanMessageAt: new Date("2026-03-17T14:10:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: messageCount }, (_value, index) => {
      const sequence = index + 1;
      return {
        conversationId: conversation.id,
        platformAccountId: page.id,
        platformMessageId: `msg-${String(sequence).padStart(4, "0")}`,
        senderPlatformUserId: sequence % 2 === 0 ? "fan-standdown" : "acct-standdown",
        senderRole: sequence % 2 === 0 ? "fan" : "model",
        createdAt: new Date(Date.UTC(2026, 2, 17, 12, sequence, 0, 0)),
        content: `message ${sequence}`,
        totalTipAmountCents: 0,
        inReplyToMessageId: null,
        inReplyToRootMessageId: null,
      };
    }));

    const finalized = await finalizePageDmConversationMessageSync(testDb.db, {
      conversationId: conversation.id,
      messageCoverageStatus: "complete",
      headReadAt: new Date("2026-03-17T13:30:00.000Z"),
      enforceRetention: false,
    });
    expect(finalized.deletedCount).toBe(0);
    expect(finalized.summary.storedMessageCount).toBe(messageCount);

    // The live-ingest recompute without enforceRetention must not prune either.
    const refreshed = await refreshPageDmConversationWindow(testDb.db, {
      conversationId: conversation.id,
    });
    expect(refreshed.deletedCount).toBe(0);
    expect(refreshed.summary.storedMessageCount).toBe(messageCount);

    const storedMessages = await testDb.pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from page_dm_messages
        where conversation_id = $1
          and deleted_at is null
      `,
      [conversation.id],
    );
    expect(Number(storedMessages.rows[0]?.count ?? "0")).toBe(messageCount);
  });

  it("keeps a hot tombstone from being resurrected by a later message upsert", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createTestPage(testDb, "page-dm-tombstone");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-tombstone",
      username: "fan_tombstone",
      displayName: "Fan Tombstone",
    }]);
    const conversation = await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "tombstone-conversation",
      partnerPlatformUserId: "fan-tombstone",
      partnerUsername: "fan_tombstone",
      partnerDisplayName: "Fan Tombstone",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "msg-deleted",
      lastUnreadMessageId: "msg-deleted",
      lastMessageAt: new Date("2026-03-17T15:00:00.000Z"),
      lastMessageSenderId: "fan-tombstone",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "delete me",
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, [{
      conversationId: conversation.id,
      platformAccountId: page.id,
      platformMessageId: "msg-deleted",
      senderPlatformUserId: "fan-tombstone",
      senderRole: "fan",
      createdAt: new Date("2026-03-17T15:00:00.000Z"),
      content: "delete me",
      totalTipAmountCents: 100,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    }]);
    await refreshPageDmConversationWindow(testDb.db, { conversationId: conversation.id });

    expect(await deletePageDmMessageByPlatformMessageId(testDb.db, {
      platformAccountId: page.id,
      platformMessageId: "msg-deleted",
    })).toMatchObject({ conversationId: conversation.id });
    await refreshPageDmConversationWindow(testDb.db, {
      conversationId: conversation.id,
      rebuildHeadForDeletedMessageId: "msg-deleted",
    });

    await upsertPageDmMessages(testDb.db, [{
      conversationId: conversation.id,
      platformAccountId: page.id,
      platformMessageId: "msg-deleted",
      senderPlatformUserId: "fan-tombstone",
      senderRole: "fan",
      createdAt: new Date("2026-03-17T15:00:00.000Z"),
      content: "resurrected content",
      totalTipAmountCents: 500,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    }]);
    const refreshed = await refreshPageDmConversationWindow(testDb.db, {
      conversationId: conversation.id,
    });
    const rows = await testDb.pool.query<{
      live_count: string;
      tombstone_count: string;
      content: string | null;
      deleted_at: Date | null;
    }>(`
      select count(*) filter (where deleted_at is null)::text as live_count,
             count(*) filter (where deleted_at is not null)::text as tombstone_count,
             max(content) as content,
             max(deleted_at) as deleted_at
      from page_dm_messages
      where conversation_id = $1
        and platform_message_id = 'msg-deleted'
    `, [conversation.id]);

    expect(refreshed.summary.storedMessageCount).toBe(0);
    expect(rows.rows[0]).toMatchObject({
      live_count: "0",
      tombstone_count: "1",
      content: "",
      deleted_at: expect.any(Date),
    });
  });

  it(`prunes spender message history to ${PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT}`, async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const messageCount = PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT + 30;
    const latestMessageId = `msg-${String(messageCount).padStart(4, "0")}`;
    const oldestRetainedMessageId = `msg-${
      String(messageCount - PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT + 1).padStart(4, "0")
    }`;

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
      lastMessageId: latestMessageId,
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T08:50:00.000Z"),
      lastMessageSenderId: "fan-spender-retention",
      lastMessageSenderRole: "fan",
      lastMessagePreview: `message ${messageCount}`,
      lastFanMessageAt: new Date("2026-03-18T08:50:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });

    await upsertPageDmMessages(testDb.db, Array.from({ length: messageCount }, (_value, index) => {
      const sequence = index + 1;
      const messageId = `msg-${String(sequence).padStart(4, "0")}`;
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
      headReadAt: new Date("2026-03-18T09:00:00.000Z"),
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
          and deleted_at is null
      `,
      [conversation.id],
    );

    expect(Number(storedMessages.rows[0]?.count ?? "0")).toBe(PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT);
    expect(storedMessages.rows[0]?.oldest).toBe(oldestRetainedMessageId);
    expect(storedMessages.rows[0]?.newest).toBe(latestMessageId);
  });

  it("moves last_message_sync_at only for a head read, and never backwards", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "page-dm-head-read");
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "fan-head-read" }]);
    if (!fan) throw new Error("test setup: fan creation failed");
    const headReadAt = new Date("2026-09-22T00:11:00.000Z");
    const thread = await upsertPageDmConversation(testDb.db, {
      ...generationThreadInput(page.id, "head-read", 1), fanId: fan.id, lastMessageSyncAt: headReadAt,
    });
    const fresh = await upsertPageDmConversation(testDb.db, {
      ...generationThreadInput(page.id, "head-read-fresh", 1), fanId: fan.id,
    });
    if (!thread || !fresh) throw new Error("test setup: thread creation failed");
    const finalize = async (conversationId: number, at: Date | null) => (await finalizePageDmConversationMessageSync(
      testDb!.db, { conversationId, messageCoverageStatus: "complete", headReadAt: at, enforceRetention: false },
    )).conversation?.lastMessageSyncAt;

    // A history walk or a summary repair leaves the watermark alone.
    expect(await finalize(thread.id, null)).toEqual(headReadAt);
    expect(await finalize(fresh.id, null)).toBeNull();
    // An older head read cannot hide a head a newer read already certified.
    expect(await finalize(thread.id, new Date("2026-09-20T00:00:00.000Z"))).toEqual(headReadAt);
    const later = new Date("2026-09-28T02:07:00.000Z");
    expect(await finalize(thread.id, later)).toEqual(later);
    expect(await finalize(fresh.id, headReadAt)).toEqual(headReadAt);
  });

  it("counts only stored rows at or below the recorded boundary as known ground", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "page-dm-known-ground");
    const thread = await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "known-ground", 1));
    if (!thread) throw new Error("test setup: thread creation failed");
    const at = (second: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, second));
    await upsertPageDmMessages(testDb.db, [["m-1", 1], ["m-2", 2], ["m-3", 2], ["m-4", 3]].map(([id, second]) => ({
      conversationId: thread.id, platformAccountId: page.id, platformMessageId: id as string,
      senderPlatformUserId: "fan", senderRole: "fan" as const, createdAt: at(second as number),
      content: "body", totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
    })));
    const knownGround = async (boundaryMessageId: string) => [...await getPageDmMessageIdsAtOrBefore(testDb!.db, {
      conversationId: thread.id, platformMessageIds: ["m-1", "m-2", "m-3", "m-4", "unstored"], boundaryMessageId,
    })].sort();

    // Same created_at breaks the tie on the id, as the window summary does.
    expect(await knownGround("m-2")).toEqual(["m-1", "m-2"]);
    expect(await knownGround("m-3")).toEqual(["m-1", "m-2", "m-3"]);
    // An unstored boundary cannot place anything above it: every stored id counts.
    expect(await knownGround("unstored")).toEqual(["m-1", "m-2", "m-3", "m-4"]);
  });

  it("backs a failing thread off 5/10/20 minutes up to 6h, quarantines it on the 4th failure, and clears it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "page-dm-breaker");
    const [fan] = await upsertFans(testDb.db, [{ platform: "fansly", platformUserId: "fan-breaker" }]);
    if (!fan) throw new Error("test setup: fan creation failed");
    const thread = await upsertPageDmConversation(testDb.db, {
      ...generationThreadInput(page.id, "breaker", 1), fanId: fan.id,
    });
    if (!thread) throw new Error("test setup: thread creation failed");
    const now = new Date("2026-03-20T12:00:00.000Z");
    const minutes = (value: number) => new Date(now.getTime() + value * 60_000);
    const fail = () => recordConversationSyncFailure(testDb!.db, {
      conversationId: thread.id, platformAccountId: page.id, errorClass: "fansly_500",
      errorMessage: "error getting group messages", now,
    });

    expect(await fail()).toEqual({ failureCount: 1, nextRetryAt: minutes(5), quarantineUntil: null });
    expect(await fail()).toEqual({ failureCount: 2, nextRetryAt: minutes(10), quarantineUntil: null });
    expect(await fail()).toEqual({ failureCount: 3, nextRetryAt: minutes(20), quarantineUntil: null });
    expect(await fail()).toEqual({ failureCount: 4, nextRetryAt: minutes(40), quarantineUntil: minutes(360) });
    expect(await getConversationSyncHealth(testDb.db, thread.id)).toMatchObject({
      failureCount: 4, errorClass: "fansly_500", lastError: "error getting group messages",
    });
    expect(await countConversationSyncFailuresByAccount(testDb.db, { platformAccountIds: [page.id] }))
      .toEqual([{ platformAccountId: page.id, failingConversationCount: 1 }]);
    // The backoff holds at the 6h cap; 5min * 2^35 once overflowed interval
    // and rolled the 36th write back.
    for (let failureCount = 5; failureCount < 40; failureCount += 1) await fail();
    expect(await fail()).toEqual({ failureCount: 40, nextRetryAt: minutes(360), quarantineUntil: minutes(360) });

    await clearConversationSyncHealth(testDb.db, thread.id);
    expect(await getConversationSyncHealth(testDb.db, thread.id)).toBeNull();

    // A learned page limit (0087) outlives the failure bookkeeping.
    await fail();
    await testDb.pool.query(
      "update page_dm_message_sync_health set preferred_page_limit = 5 where conversation_id = $1", [thread.id],
    );
    await clearConversationSyncHealth(testDb.db, thread.id);
    expect(await getConversationSyncHealth(testDb.db, thread.id)).toMatchObject({
      failureCount: 0, nextRetryAt: null, quarantineUntil: null, preferredPageLimit: 5,
    });
    expect(await countConversationSyncFailuresByAccount(testDb.db, { platformAccountIds: [page.id] })).toEqual([]);
  });

  it("stops counting a breakered thread as coverage debt once the lane no longer selects it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createGenerationPage(testDb, "page-dm-breaker-retired");
    const groups = ["live", "excluded", "hidden", "unbound"] as const;
    const fans = await upsertFans(testDb.db, groups.map((group) => ({
      platform: "fansly" as const, platformUserId: `fan-breaker-${group}`,
    })));
    const threads = new Map<string, number>();
    for (const [index, group] of groups.entries()) {
      const thread = await upsertPageDmConversation(testDb.db, {
        ...generationThreadInput(page.id, `breaker-${group}`, 1), fanId: fans[index]!.id,
      });
      if (!thread) throw new Error("test setup: thread creation failed");
      threads.set(group, thread.id);
      await recordConversationSyncFailure(testDb.db, {
        conversationId: thread.id, platformAccountId: page.id, errorClass: "fansly_500",
        errorMessage: "error getting group messages",
      });
    }
    const debt = () => countConversationSyncFailuresByAccount(testDb!.db, { platformAccountIds: [page.id] });
    expect(await debt()).toEqual([{ platformAccountId: page.id, failingConversationCount: 4 }]);

    // The partner-unresolvable exclusion retires a thread after its 5xx
    // streak; the list sweep hides a vanished group; a thread can lose its fan.
    expect(await excludePageDmConversationMessageSync(testDb.db, {
      conversationId: threads.get("excluded")!, platformAccountId: page.id,
      partnerPlatformUserId: "partner-breaker-excluded",
      reason: FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
    })).toBe(true);
    await testDb.pool.query("update page_dm_threads set is_visible = false where id = $1", [threads.get("hidden")]);
    await testDb.pool.query("update page_dm_threads set fan_id = null where id = $1", [threads.get("unbound")]);

    // Before, every such row kept the page's /health/sync degraded for good.
    expect(await debt()).toEqual([{ platformAccountId: page.id, failingConversationCount: 1 }]);
    expect(await getConversationSyncHealth(testDb.db, threads.get("hidden")!)).toMatchObject({ failureCount: 1 });
    await clearConversationSyncHealth(testDb.db, threads.get("live")!);
    expect(await debt()).toEqual([]);
    // A thread that returns to the lane carries its failures again.
    await testDb.pool.query("update page_dm_threads set is_visible = true where id = $1", [threads.get("hidden")]);
    expect(await debt()).toEqual([{ platformAccountId: page.id, failingConversationCount: 1 }]);
  });

  // G2: last_seen_generation is the sweep-membership set the destructive
  // finalization reads, so a regressed stamp hides a LIVE thread. The upsert is
  // shared by four writers, two of which write back a stamp they read outside
  // the write — the conflict update has to be monotonic on its own.
  describe("last_seen_generation monotonicity", () => {
    it("never regresses a stored stamp on a sequential upsert", async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }

      const page = await createGenerationPage(testDb, "generation-monotonic");

      // (i) an older generation does not regress a newer stored stamp.
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "older-loses", 7));
      const regressed = await upsertPageDmConversation(
        testDb.db,
        generationThreadInput(page.id, "older-loses", 3),
      );
      expect(regressed?.lastSeenGeneration).toBe(7);

      // (ii) a null incoming stamp keeps the current one. This is a DELIBERATE
      // semantic change: the pre-G2 conflict set let any writer blank the stamp
      // with the null it had read before the sweep stamped the row.
      const blanked = await upsertPageDmConversation(
        testDb.db,
        generationThreadInput(page.id, "older-loses", null),
      );
      expect(blanked?.lastSeenGeneration).toBe(7);

      // (iii) a null stored stamp accepts the incoming value.
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "null-current", null));
      const adopted = await upsertPageDmConversation(
        testDb.db,
        generationThreadInput(page.id, "null-current", 4),
      );
      expect(adopted?.lastSeenGeneration).toBe(4);

      // A genuinely newer stamp still advances.
      const advanced = await upsertPageDmConversation(
        testDb.db,
        generationThreadInput(page.id, "older-loses", 9),
      );
      expect(advanced?.lastSeenGeneration).toBe(9);

      expect(await readThreadState(testDb, page.id)).toEqual({
        "older-loses": { generation: 9, isVisible: true },
        "null-current": { generation: 4, isVisible: true },
      });
    });

    it("converges on the max when two writers race the same thread", async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }

      const page = await createGenerationPage(testDb, "generation-race");
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "newer-first", 1));
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "older-first", 1));

      // Both orderings of the same race: whoever commits second re-evaluates
      // the conflict set against the freshly committed row, so the guard — not
      // the commit order — decides the stamp.
      for (const race of [
        { conversationId: "newer-first", holder: 12, contender: 9 },
        { conversationId: "older-first", holder: 9, contender: 12 },
      ]) {
        let releaseHolder = () => {};
        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let holderLocked = () => {};
        const holderLockAcquired = new Promise<void>((resolve) => {
          holderLocked = resolve;
        });

        // The holder locks the row inside an open transaction (a slow sweep
        // batch); the contender's conflict update must wait behind it. The
        // contender starts only after the holder's upsert has COMPLETED (row
        // lock provably held) — a timing sleep here was flaky on slow runners
        // and, on assertion failure before the gate release, hung pool.end().
        const holderTransaction = testDb.db.transaction(async (tx) => {
          await upsertPageDmConversation(
            tx as unknown as Database,
            generationThreadInput(page.id, race.conversationId, race.holder),
          );
          holderLocked();
          await holderGate;
        });

        let contender: ReturnType<typeof upsertPageDmConversation> | undefined;
        try {
          await holderLockAcquired;
          contender = upsertPageDmConversation(
            testDb.db,
            generationThreadInput(page.id, race.conversationId, race.contender),
          );
          // Observed, not assumed: the contender's upsert is parked on the
          // holder's row lock, and it has not written before the holder commits.
          await waitForRowLockWait(testDb.pool, ["%page_dm_threads%"], {
            blocked: contender,
            timeoutMs: 5_000,
          });
          expect(await hasSettled(contender)).toBe(false);
        } finally {
          // Release the gate no matter what, or a failed assertion leaves the
          // holder transaction (and the pool) waiting until the suite timeout.
          releaseHolder();
          await holderTransaction;
        }
        const contended = await contender;
        expect(contended?.lastSeenGeneration).toBe(Math.max(race.holder, race.contender));
      }

      expect(await readThreadState(testDb, page.id)).toEqual({
        "newer-first": { generation: 12, isVisible: true },
        "older-first": { generation: 12, isVisible: true },
      });
    });

    it("reads the generation set as a count and as an ordered id list", async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }

      // G2 slice 2: the second representation of a sweep's membership. Scoped
      // to (account, generation) and ordered by the qualified id column so the
      // digest built on top of it is reproducible.
      const page = await createGenerationPage(testDb, "generation-set");
      const other = await createGenerationPage(testDb, "generation-set-other");
      for (const conversationId of ["c-30", "c-10", "c-20"]) {
        await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, conversationId, 5));
      }
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "c-old", 4));
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "c-null", null));
      await upsertPageDmConversation(testDb.db, generationThreadInput(other.id, "c-10", 5));

      expect(await countPageDmThreadsByGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 5,
      })).toBe(3);
      expect(await listPageDmThreadIdsByGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 5,
      })).toEqual(["c-10", "c-20", "c-30"]);
      expect(await countPageDmThreadsByGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 6,
      })).toBe(0);
      expect(await listPageDmThreadIdsByGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 6,
      })).toEqual([]);
    });

    it("reads back only the incoming ids a sweep has already stamped", async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }

      // G3: the per-page overlap check. Scoped three ways at once — the
      // account, the generation, and the ids on THIS provider page — because
      // an id stamped by an earlier generation, or by another page's sweep, is
      // not an overlap.
      const page = await createGenerationPage(testDb, "generation-stamped");
      const other = await createGenerationPage(testDb, "generation-stamped-other");
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "c-seen", 5));
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "c-earlier", 4));
      await upsertPageDmConversation(testDb.db, generationThreadInput(page.id, "c-null", null));
      await upsertPageDmConversation(testDb.db, generationThreadInput(other.id, "c-fresh", 5));

      expect(await listPageDmThreadIdsStampedWithGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 5,
        platformConversationIds: ["c-fresh", "c-seen", "c-earlier", "c-null"],
      })).toEqual(["c-seen"]);
      // An empty page asks the database nothing.
      expect(await listPageDmThreadIdsStampedWithGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 5,
        platformConversationIds: [],
      })).toEqual([]);
      // The next sweep's generation has stamped nothing yet.
      expect(await listPageDmThreadIdsStampedWithGeneration(testDb.db, {
        platformAccountId: page.id,
        generation: 6,
        platformConversationIds: ["c-seen"],
      })).toEqual([]);
    });

    it("reads a generation high-water above the int4 ceiling", async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }

      // last_seen_generation is a bigint column and the stamp is now
      // load-bearing, so the high-water read must not narrow it to int4.
      const page = await createGenerationPage(testDb, "generation-bigint");
      await testDb.pool.query(
        `insert into page_dm_threads (
           platform_account_id, platform_conversation_id, is_visible, last_seen_generation
         ) values ($1, 'bigint-thread', true, 3000000000)`,
        [page.id],
      );

      expect(await maxPageDmThreadGeneration(testDb.db, page.id)).toBe(3_000_000_000);
    });
  });
});
