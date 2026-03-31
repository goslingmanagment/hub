import { describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  upsertFans,
  upsertPageDmMessages,
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

      const seededAt = new Date("2026-03-24T07:00:00.000Z");
      const fanslyConversation = await testDb.pool.query<{ id: number }>(`
        insert into page_dm_conversations (
          platform_account_id,
          fan_id,
          platform_conversation_id,
          partner_platform_user_id,
          partner_username,
          partner_display_name,
          conversation_flags,
          unread_count,
          subscription_tier_id,
          last_message_id,
          last_unread_message_id,
          last_message_at,
          last_message_sender_id,
          last_message_sender_role,
          last_message_preview,
          last_fan_message_at,
          last_model_message_at,
          stored_message_count,
          newest_stored_message_id,
          oldest_stored_message_id,
          message_backfill_complete,
          last_message_sync_at,
          is_visible,
          last_seen_generation,
          last_seen_at,
          metadata,
          updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb, $27
        )
        returning id
      `, [
        fanslyPage.id,
        fanslyFan.id,
        "fansly-conv",
        "fansly-fan-1",
        "fansly_fan",
        "Fansly Fan",
        0,
        0,
        null,
        "fansly-tip-positive",
        null,
        new Date("2026-03-24T05:00:00.000Z"),
        "fansly-fan-1",
        "fan",
        "thanks!",
        new Date("2026-03-24T05:00:00.000Z"),
        null,
        0,
        null,
        null,
        false,
        null,
        true,
        1,
        seededAt,
        JSON.stringify({}),
        seededAt,
      ]);
      const onlyFansConversation = await testDb.pool.query<{ id: number }>(`
        insert into page_dm_conversations (
          platform_account_id,
          fan_id,
          platform_conversation_id,
          partner_platform_user_id,
          partner_username,
          partner_display_name,
          conversation_flags,
          unread_count,
          subscription_tier_id,
          last_message_id,
          last_unread_message_id,
          last_message_at,
          last_message_sender_id,
          last_message_sender_role,
          last_message_preview,
          last_fan_message_at,
          last_model_message_at,
          stored_message_count,
          newest_stored_message_id,
          oldest_stored_message_id,
          message_backfill_complete,
          last_message_sync_at,
          is_visible,
          last_seen_generation,
          last_seen_at,
          metadata,
          updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb, $27
        )
        returning id
      `, [
        onlyFansPage.id,
        onlyFansFan.id,
        "onlyfans-conv",
        "onlyfans-fan-1",
        "onlyfans_fan",
        "OnlyFans Fan",
        0,
        0,
        null,
        "onlyfans-tip-positive",
        null,
        new Date("2026-03-24T06:00:00.000Z"),
        "onlyfans-fan-1",
        "fan",
        "thanks here too!",
        new Date("2026-03-24T06:00:00.000Z"),
        null,
        0,
        null,
        null,
        false,
        null,
        true,
        1,
        seededAt,
        JSON.stringify({}),
        seededAt,
      ]);

      await upsertPageDmMessages(testDb.db, [
        {
          conversationId: fanslyConversation.rows[0]!.id,
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
          conversationId: fanslyConversation.rows[0]!.id,
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
          conversationId: onlyFansConversation.rows[0]!.id,
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
      await testDb.pool.query(`
        insert into transactions (
          platform_account_id,
          fan_id,
          transaction_id,
          raw_type,
          canonical_type,
          transaction_state,
          raw_status,
          gross_amount_mills,
          source_destination_amount_mills,
          creator_net_amount_mills,
          occurred_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
      `, [
        fanslyPage.id,
        fanslyFan.id,
        "fansly-tip-tx",
        "20001",
        "tip",
        "pending",
        "1",
        20000,
        20000,
        16000,
        new Date("2026-03-24T05:00:00.000Z"),
      ]);

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
