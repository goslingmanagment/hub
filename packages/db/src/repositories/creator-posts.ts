// Current creator-post projection repository. Every raw response and material
// version lives upstream; this table keeps only the latest observed post head.
// account_seq orders ledger append, not provider observation time, so material
// freshness is observed_at first with account_seq only as the deterministic
// same-instant tie-break.

import type { Platform } from "@agency_hub_core/shared";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

type LatestObservedProjectionTable = "creator_posts" | "creator_post_tips";

function newerWins(tableName: LatestObservedProjectionTable) {
  const currentTable = sql.identifier(tableName);
  const excluded = sql.identifier("excluded");
  const lastObservedAt = sql.identifier("last_observed_at");
  const sourceAccountSeq = sql.identifier("source_account_seq");

  return (columnName: string): SQL => {
    const column = sql.identifier(columnName);
    return sql`case
      when ${excluded}.${lastObservedAt} > ${currentTable}.${lastObservedAt}
        or (
          ${excluded}.${lastObservedAt} = ${currentTable}.${lastObservedAt}
          and ${excluded}.${sourceAccountSeq} > ${currentTable}.${sourceAccountSeq}
        )
      then ${excluded}.${column}
      else ${currentTable}.${column}
    end`;
  };
}

const newerCreatorPostValue = newerWins("creator_posts");
const newerCreatorPostTipValue = newerWins("creator_post_tips");

export interface UpsertCreatorPostInput {
  accountId: number;
  platform: Platform;
  platformPostId: string;
  textPlain: string;
  publishedAt: Date;
  observedAt: Date;
  contentHash: string;
  attachmentCount: number;
  tipAmountMills: bigint | null;
  attachmentTipAmountMills: bigint | null;
  postTipTotalMills: bigint | null;
  tipGoalLinked: boolean | null;
  tipGoalRef: string | null;
  tipGoalLabel: string | null;
  tipGoalTargetMills: bigint | null;
  tipGoalCurrentMills: bigint | null;
  tipGoalAmountsHidden: boolean | null;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export interface UpsertCreatorPostResult {
  applied: boolean;
  id: number | null;
}

export async function upsertCreatorPost(
  db: Database,
  input: UpsertCreatorPostInput,
): Promise<UpsertCreatorPostResult> {
  const result = await db.execute<{ id: string }>(sql`
    insert into creator_posts (
      account_id,
      platform,
      platform_post_id,
      text_plain,
      published_at,
      first_observed_at,
      last_observed_at,
      content_hash,
      attachment_count,
      tip_amount_mills,
      attachment_tip_amount_mills,
      post_tip_total_mills,
      tip_goal_linked,
      tip_goal_ref,
      tip_goal_label,
      tip_goal_target_mills,
      tip_goal_current_mills,
      tip_goal_amounts_hidden,
      source_event_id,
      source_observation_id,
      source_account_seq,
      created_at,
      updated_at
    ) values (
      ${input.accountId},
      ${input.platform},
      ${input.platformPostId},
      ${input.textPlain},
      ${input.publishedAt},
      ${input.observedAt},
      ${input.observedAt},
      ${input.contentHash},
      ${input.attachmentCount},
      ${input.tipAmountMills},
      ${input.attachmentTipAmountMills},
      ${input.postTipTotalMills},
      ${input.tipGoalLinked},
      ${input.tipGoalRef},
      ${input.tipGoalLabel},
      ${input.tipGoalTargetMills},
      ${input.tipGoalCurrentMills},
      ${input.tipGoalAmountsHidden},
      ${input.sourceEventId},
      ${input.sourceObservationId},
      ${input.sourceAccountSeq},
      now(),
      now()
    )
    on conflict (account_id, platform_post_id) do update set
      platform = ${newerCreatorPostValue("platform")},
      text_plain = ${newerCreatorPostValue("text_plain")},
      published_at = ${newerCreatorPostValue("published_at")},
      first_observed_at = least(creator_posts.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(creator_posts.last_observed_at, excluded.last_observed_at),
      content_hash = ${newerCreatorPostValue("content_hash")},
      attachment_count = ${newerCreatorPostValue("attachment_count")},
      tip_amount_mills = ${newerCreatorPostValue("tip_amount_mills")},
      attachment_tip_amount_mills = ${newerCreatorPostValue("attachment_tip_amount_mills")},
      post_tip_total_mills = ${newerCreatorPostValue("post_tip_total_mills")},
      tip_goal_linked = ${newerCreatorPostValue("tip_goal_linked")},
      tip_goal_ref = ${newerCreatorPostValue("tip_goal_ref")},
      tip_goal_label = ${newerCreatorPostValue("tip_goal_label")},
      tip_goal_target_mills = ${newerCreatorPostValue("tip_goal_target_mills")},
      tip_goal_current_mills = ${newerCreatorPostValue("tip_goal_current_mills")},
      tip_goal_amounts_hidden = ${newerCreatorPostValue("tip_goal_amounts_hidden")},
      source_event_id = ${newerCreatorPostValue("source_event_id")},
      source_observation_id = ${newerCreatorPostValue("source_observation_id")},
      source_account_seq = ${newerCreatorPostValue("source_account_seq")},
      updated_at = now()
    where excluded.first_observed_at < creator_posts.first_observed_at
      or excluded.last_observed_at > creator_posts.last_observed_at
      or (
        excluded.last_observed_at = creator_posts.last_observed_at
        and excluded.source_account_seq > creator_posts.source_account_seq
      )
    returning id::text as id
  `);
  const row = result.rows[0];
  return {
    applied: row !== undefined,
    id: row === undefined ? null : Number(row.id),
  };
}

export interface UpsertCreatorPostTipInput {
  accountId: number;
  platform: Platform;
  platformPostId: string;
  platformTipId: string;
  tipSenderPlatformUserId: string;
  postTipAmountMills: bigint;
  occurredAt: Date;
  observedAt: Date;
  receiverTransactionRef: string | null;
  senderTransactionRef: string | null;
  tipGoalRef: string | null;
  tipMessageText: string | null;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

export async function upsertCreatorPostTip(
  db: Database,
  input: UpsertCreatorPostTipInput,
): Promise<UpsertCreatorPostResult> {
  const result = await db.execute<{ id: string }>(sql`
    insert into creator_post_tips (
      account_id,
      platform,
      platform_post_id,
      platform_tip_id,
      tip_sender_platform_user_id,
      post_tip_amount_mills,
      occurred_at,
      receiver_transaction_ref,
      sender_transaction_ref,
      tip_goal_ref,
      tip_message_text,
      first_observed_at,
      last_observed_at,
      content_hash,
      source_event_id,
      source_observation_id,
      source_account_seq,
      created_at,
      updated_at
    ) values (
      ${input.accountId},
      ${input.platform},
      ${input.platformPostId},
      ${input.platformTipId},
      ${input.tipSenderPlatformUserId},
      ${input.postTipAmountMills},
      ${input.occurredAt},
      ${input.receiverTransactionRef},
      ${input.senderTransactionRef},
      ${input.tipGoalRef},
      ${input.tipMessageText},
      ${input.observedAt},
      ${input.observedAt},
      ${input.contentHash},
      ${input.sourceEventId},
      ${input.sourceObservationId},
      ${input.sourceAccountSeq},
      now(),
      now()
    )
    on conflict (account_id, platform_tip_id, platform_post_id) do update set
      platform = ${newerCreatorPostTipValue("platform")},
      tip_sender_platform_user_id = ${newerCreatorPostTipValue(
        "tip_sender_platform_user_id",
      )},
      post_tip_amount_mills = ${newerCreatorPostTipValue("post_tip_amount_mills")},
      occurred_at = ${newerCreatorPostTipValue("occurred_at")},
      receiver_transaction_ref = ${newerCreatorPostTipValue("receiver_transaction_ref")},
      sender_transaction_ref = ${newerCreatorPostTipValue("sender_transaction_ref")},
      tip_goal_ref = ${newerCreatorPostTipValue("tip_goal_ref")},
      tip_message_text = ${newerCreatorPostTipValue("tip_message_text")},
      first_observed_at = least(
        creator_post_tips.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = greatest(
        creator_post_tips.last_observed_at,
        excluded.last_observed_at
      ),
      content_hash = ${newerCreatorPostTipValue("content_hash")},
      source_event_id = ${newerCreatorPostTipValue("source_event_id")},
      source_observation_id = ${newerCreatorPostTipValue("source_observation_id")},
      source_account_seq = ${newerCreatorPostTipValue("source_account_seq")},
      updated_at = now()
    where excluded.first_observed_at < creator_post_tips.first_observed_at
      or excluded.last_observed_at > creator_post_tips.last_observed_at
      or (
        excluded.last_observed_at = creator_post_tips.last_observed_at
        and excluded.source_account_seq > creator_post_tips.source_account_seq
      )
    returning id::text as id
  `);
  const row = result.rows[0];
  return {
    applied: row !== undefined,
    id: row === undefined ? null : Number(row.id),
  };
}
