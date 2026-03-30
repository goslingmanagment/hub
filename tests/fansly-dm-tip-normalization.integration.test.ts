import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertTransaction,
} from "@agency_hub_core/db";

import { applyTestMigrations, startTestDatabase } from "./helpers/db.ts";
import { acquireTestPrerequisite } from "./helpers/prerequisites.ts";

describe("Fansly DM tip normalization migration", () => {
  it("backfills stored Fansly DM tip amounts from mills to cents without touching other rows", async () => {
    const testDb = await acquireTestPrerequisite(
      () => startTestDatabase({
        through: "0027_workboard_snoozes.sql",
      }),
      {
        prerequisite: "Docker-backed Postgres for migration tests",
        reason: "This test validates the Fansly DM tip backfill against a pre-migration schema snapshot.",
      },
    );
    if (!testDb) {
      return;
    }

    try {
      const model = await createModel(testDb.db, {
        slug: "tip-normalization",
        name: "Tip Normalization",
      });
      const fanslyPage = await createFanslyPage(testDb.db, {
        modelId: model.id,
        label: "fansly-tip-page",
      });
      const onlyFansPage = await createOnlyFansPage(testDb.db, {
        modelId: model.id,
        label: "onlyfans-tip-page",
      });
      const [fanslyFan, onlyFansFan] = await upsertFans(testDb.db, [
        {
          platform: "fansly",
          platformUserId: "fansly-fan-1",
          username: "fansly_fan",
          displayName: "Fansly Fan",
        },
        {
          platform: "onlyfans",
          platformUserId: "onlyfans-fan-1",
          username: "onlyfans_fan",
          displayName: "OnlyFans Fan",
        },
      ]);

      const fanslyConversation = await upsertPageDmConversation(testDb.db, {
        platformAccountId: fanslyPage.id,
        fanId: fanslyFan.id,
        platformConversationId: "fansly-conv",
        partnerPlatformUserId: "fansly-fan-1",
        partnerUsername: "fansly_fan",
        partnerDisplayName: "Fansly Fan",
        conversationFlags: 0,
        unreadCount: 0,
        subscriptionTierId: null,
        lastMessageId: "fansly-tip-positive",
        lastUnreadMessageId: null,
        lastMessageAt: new Date("2026-03-24T05:00:00.000Z"),
        lastMessageSenderId: "fansly-fan-1",
        lastMessageSenderRole: "fan",
        lastMessagePreview: "thanks!",
        lastFanMessageAt: new Date("2026-03-24T05:00:00.000Z"),
        lastModelMessageAt: null,
        isVisible: true,
        lastSeenGeneration: 1,
        metadata: {},
      });
      const onlyFansConversation = await upsertPageDmConversation(testDb.db, {
        platformAccountId: onlyFansPage.id,
        fanId: onlyFansFan.id,
        platformConversationId: "onlyfans-conv",
        partnerPlatformUserId: "onlyfans-fan-1",
        partnerUsername: "onlyfans_fan",
        partnerDisplayName: "OnlyFans Fan",
        conversationFlags: 0,
        unreadCount: 0,
        subscriptionTierId: null,
        lastMessageId: "onlyfans-tip-positive",
        lastUnreadMessageId: null,
        lastMessageAt: new Date("2026-03-24T06:00:00.000Z"),
        lastMessageSenderId: "onlyfans-fan-1",
        lastMessageSenderRole: "fan",
        lastMessagePreview: "thanks here too!",
        lastFanMessageAt: new Date("2026-03-24T06:00:00.000Z"),
        lastModelMessageAt: null,
        isVisible: true,
        lastSeenGeneration: 1,
        metadata: {},
      });

      await upsertPageDmMessages(testDb.db, [
        {
          conversationId: fanslyConversation.id,
          platformAccountId: fanslyPage.id,
          platformMessageId: "fansly-tip-positive",
          senderPlatformUserId: "fansly-fan-1",
          senderRole: "fan",
          createdAt: new Date("2026-03-24T05:00:00.000Z"),
          content: "tip event",
          totalTipAmountCents: 20000,
          inReplyToMessageId: null,
          inReplyToRootMessageId: null,
        },
        {
          conversationId: fanslyConversation.id,
          platformAccountId: fanslyPage.id,
          platformMessageId: "fansly-tip-zero",
          senderPlatformUserId: "fansly-fan-1",
          senderRole: "fan",
          createdAt: new Date("2026-03-24T05:01:00.000Z"),
          content: "regular message",
          totalTipAmountCents: 0,
          inReplyToMessageId: null,
          inReplyToRootMessageId: null,
        },
        {
          conversationId: onlyFansConversation.id,
          platformAccountId: onlyFansPage.id,
          platformMessageId: "onlyfans-tip-positive",
          senderPlatformUserId: "onlyfans-fan-1",
          senderRole: "fan",
          createdAt: new Date("2026-03-24T06:00:00.000Z"),
          content: "tip event",
          totalTipAmountCents: 20000,
          inReplyToMessageId: null,
          inReplyToRootMessageId: null,
        },
      ]);
      await upsertTransaction(testDb.db, {
        platformAccountId: fanslyPage.id,
        fanId: fanslyFan.id,
        transactionId: "fansly-tip-tx",
        rawType: 20001,
        canonicalType: "tip",
        transactionState: "pending",
        rawStatus: 1,
        grossAmountMills: 20000n,
        sourceDestinationAmountMills: 20000n,
        creatorNetAmountMills: 16000n,
        occurredAt: new Date("2026-03-24T05:00:00.000Z"),
      });

      await applyTestMigrations(testDb.pool, {
        from: "0028_fansly_dm_tip_amount_cents_fix.sql",
        through: "0028_fansly_dm_tip_amount_cents_fix.sql",
      });

      const rows = await testDb.pool.query<{
        platformMessageId: string;
        platform: string;
        totalTipAmountCents: number;
      }>(`
        select
          pdm.platform_message_id as "platformMessageId",
          pa.platform,
          pdm.total_tip_amount_cents as "totalTipAmountCents"
        from page_dm_messages pdm
        join platform_accounts pa on pa.id = pdm.platform_account_id
        where pdm.platform_message_id in (
          'fansly-tip-positive',
          'fansly-tip-zero',
          'onlyfans-tip-positive'
        )
        order by pdm.platform_message_id asc
      `);

      expect(rows.rows).toEqual([
        {
          platformMessageId: "fansly-tip-positive",
          platform: "fansly",
          totalTipAmountCents: 2000,
        },
        {
          platformMessageId: "fansly-tip-zero",
          platform: "fansly",
          totalTipAmountCents: 0,
        },
        {
          platformMessageId: "onlyfans-tip-positive",
          platform: "onlyfans",
          totalTipAmountCents: 20000,
        },
      ]);

      const validation = await testDb.pool.query<{
        messageTipAmountCents: number;
        grossAmountMills: number;
      }>(`
        select
          pdm.total_tip_amount_cents as "messageTipAmountCents",
          t.gross_amount_mills::integer as "grossAmountMills"
        from page_dm_messages pdm
        join page_dm_conversations pdc on pdc.id = pdm.conversation_id
        join transactions t
          on t.platform_account_id = pdm.platform_account_id
         and t.fan_id = pdc.fan_id
         and t.canonical_type = 'tip'
         and t.occurred_at = pdm.created_at
        where pdm.platform_message_id = 'fansly-tip-positive'
        limit 1
      `);

      expect(validation.rows[0]).toEqual({
        messageTipAmountCents: 2000,
        grossAmountMills: 20000,
      });
    } finally {
      await testDb.stop();
    }
  }, 30_000);
});
