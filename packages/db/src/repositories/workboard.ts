import { sql } from "drizzle-orm";
import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN,
  type ExternalPresenceSource,
} from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import type {
  DmSenderRole,
  MessageCoverageStatus,
  MessageSyncEligibility,
} from "./page-dm.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | string | bigint | null | undefined;

type TouchpointCode = "21d" | "14d" | "7d" | "5d" | "3d" | "1d";

function parseTimestamp(value: TimestampValue) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requireTimestamp(value: TimestampValue, field: string) {
  const parsed = parseTimestamp(value);
  if (!parsed) {
    throw new Error(`Expected ${field} to be a valid timestamp`);
  }
  return parsed;
}

function normalizeNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${field} to be present`);
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected ${field} to be numeric`);
  }

  return parsed;
}

function normalizeBigInt(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    return 0n;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  return BigInt(value);
}

function normalizeNullableJsonRecord(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected metadata to be an object");
  }

  return value as Record<string, unknown>;
}

function normalizeMessageCoverageStatus(value: unknown): MessageCoverageStatus {
  return value === "partial_window" || value === "complete"
    ? value
    : "pending_backfill";
}

function isMessageBackfillComplete(status: MessageCoverageStatus) {
  return status === "complete";
}

function getMessageSyncExcludedReason(metadata: Record<string, unknown> | null | undefined) {
  const rawValue = metadata?.[FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY];
  return typeof rawValue === "string" && rawValue.trim().length > 0
    ? rawValue
    : null;
}

function getMessageSyncEligibility(input: {
  fanId: number | null;
  metadata: Record<string, unknown>;
}): MessageSyncEligibility {
  if (getMessageSyncExcludedReason(input.metadata)) {
    return "excluded";
  }

  const unresolvedIdentity = input.metadata.unresolvedIdentity === true || input.fanId === null;
  return unresolvedIdentity ? "unresolved_identity" : "eligible";
}

function workboardSnoozeExclusionSql(platformAccountId: number, fanIdSql: ReturnType<typeof sql.raw>) {
  return sql`
    and not exists (
      select 1 from workboard_snoozes ws
      where ws.fan_id = ${fanIdSql}
        and ws.platform_account_id = ${platformAccountId}
        and ws.snoozed_until > now()
    )
  `;
}

function subscribersBaseQuery(platformAccountId: number, now: Date) {
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus1Day = sql`${now}::timestamptz + interval '1 day'`;
  const nowPlus3Days = sql`${now}::timestamptz + interval '3 days'`;
  const nowPlus5Days = sql`${now}::timestamptz + interval '5 days'`;
  const nowPlus7Days = sql`${now}::timestamptz + interval '7 days'`;
  const nowPlus14Days = sql`${now}::timestamptz + interval '14 days'`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const nowMinus48Hours = sql`${now}::timestamptz - interval '48 hours'`;

  return sql`
    with primary_conversation as (
      select *
      from (
        select c.*,
               row_number() over (
                 partition by c.platform_account_id, c.fan_id
                 order by c.last_message_at desc nulls last,
                          c.platform_conversation_id desc
               ) as rn
        from page_dm_threads c
        where c.platform_account_id = ${platformAccountId}
          and c.is_visible = true
          and c.fan_id is not null
      ) ranked
      where rn = 1
    ),
    current_subscription as (
      select *
      from (
        select ps.*,
               row_number() over (
                 partition by ps.platform_account_id, ps.fan_id
                 order by (case when ps.is_current then 0 else 1 end) asc,
                          ps.ends_at desc nulls last,
                          ps.id desc
               ) as rn
        from page_subscriptions ps
        where ps.platform_account_id = ${platformAccountId}
      ) ranked
      where rn = 1
    ),
    subscriber_candidates as (
      select fp.fan_id as fan_id,
             f.platform_user_id as platform_user_id,
             fp.page_alias as page_alias,
             f.username as username,
             f.display_name as display_name,
             fp.subscription_expires_at as subscription_expires_at,
             fp.auto_renew as auto_renew,
             fp.auto_renew_off_detected_at as auto_renew_off_detected_at,
             fp.subscriber_since as subscriber_since,
             cs.subscription_tier_name as subscription_tier_name,
             coalesce(slp.creator_net_amount_mills, 0)::bigint as creator_net_amount_mills,
             slp.last_transaction_at as last_transaction_at,
             pc.platform_conversation_id as platform_conversation_id,
             pc.last_fan_message_at as last_fan_message_at,
             pc.last_model_message_at as last_model_message_at,
             pc.last_message_preview as last_message_preview,
             coalesce(
               pc.message_coverage_status,
               'pending_backfill'::dm_message_coverage_status
             ) as message_coverage_status,
             coalesce(pc.message_backfill_complete, false) as message_backfill_complete,
             coalesce(pc.stored_message_count, 0)::int as stored_message_count,
             coalesce(pc.metadata, '{}'::jsonb) as conversation_metadata,
             coalesce(
               case
                 when pc.last_fan_message_at is null and pc.last_model_message_at is null then null
                 else greatest(
                   coalesce(pc.last_fan_message_at, '-infinity'::timestamptz),
                   coalesce(pc.last_model_message_at, '-infinity'::timestamptz)
                 )
               end,
               pc.last_message_at
             ) as last_contact_at,
             case
               when fp.subscription_expires_at <= ${nowPlus1Day} then '1d'
               when fp.subscription_expires_at <= ${nowPlus3Days} then '3d'
               when fp.subscription_expires_at <= ${nowPlus5Days} then '5d'
               when fp.subscription_expires_at <= ${nowPlus7Days} then '7d'
               when fp.subscription_expires_at <= ${nowPlus14Days} then '14d'
               when fp.subscription_expires_at <= ${nowPlus21Days} then '21d'
               else null
             end as touchpoint_code,
             case
               when fp.subscription_expires_at <= ${nowPlus1Day} then fp.subscription_expires_at - interval '1 day'
               when fp.subscription_expires_at <= ${nowPlus3Days} then fp.subscription_expires_at - interval '3 days'
               when fp.subscription_expires_at <= ${nowPlus5Days} then fp.subscription_expires_at - interval '5 days'
               when fp.subscription_expires_at <= ${nowPlus7Days} then fp.subscription_expires_at - interval '7 days'
               when fp.subscription_expires_at <= ${nowPlus14Days} then fp.subscription_expires_at - interval '14 days'
               when fp.subscription_expires_at <= ${nowPlus21Days} then fp.subscription_expires_at - interval '21 days'
               else null
             end as touchpoint_due_at
      from page_fans fp
      inner join fans f on f.id = fp.fan_id
      left join current_subscription cs
        on cs.platform_account_id = fp.platform_account_id
       and cs.fan_id = fp.fan_id
      left join primary_conversation pc
        on pc.platform_account_id = fp.platform_account_id
       and pc.fan_id = fp.fan_id
      left join fan_spend_lifetime slp
        on slp.platform_account_id = fp.platform_account_id
       and slp.fan_id = fp.fan_id
      where fp.platform_account_id = ${platformAccountId}
        and fp.is_subscriber = true
        and f.deleted_detected_at is null
        and fp.subscription_expires_at > ${nowSql}
        and fp.subscription_expires_at <= ${nowPlus21Days}
    ),
    filtered as (
      select *,
             (touchpoint_code in ('21d', '14d')) as is_soft_touchpoint,
             (
               last_contact_at is not null
               and last_contact_at >= greatest(touchpoint_due_at, ${nowMinus48Hours})
             ) as is_handled
      from subscriber_candidates
      where touchpoint_code is not null
    )
  `;
}

function spenderBaseQuery(
  input: { platformAccountId: number; now?: Date },
  opts: {
    recentSpend: boolean | null;
    rhythmDays: number | null;
    minimumSpendMills?: number;
    actionableOnly?: boolean;
    excludeSubscribers?: boolean;
  },
) {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const minimumSpendMills = opts.minimumSpendMills ?? 100000;
  const spendWindow = opts.recentSpend === null
    ? sql``
    : opts.recentSpend
      ? sql`and slp.last_transaction_at > ${nowSql} - interval '30 days'`
      : sql`and (slp.last_transaction_at is null or slp.last_transaction_at <= ${nowSql} - interval '30 days')`;
  const excludeSubscribers = opts.excludeSubscribers ?? true;
  const subscriberExclusion = excludeSubscribers
    ? sql`
        and not coalesce(fp.is_subscriber, false)
        and not exists (
          select 1 from retention_due rd where rd.fan_id = slp.fan_id
        )
      `
    : sql``;
  const contactFilter = opts.actionableOnly !== false && opts.rhythmDays !== null
    ? sql`
        where last_contact_at is null
           or last_contact_at < ${sql`${now}::timestamptz - (${opts.rhythmDays} || ' days')::interval`}
      `
    : sql``;

  return sql`
    with primary_conversation as (
      select *
      from (
        select c.*,
               row_number() over (
                 partition by c.platform_account_id, c.fan_id
                 order by c.last_message_at desc nulls last,
                          c.platform_conversation_id desc
               ) as rn
        from page_dm_threads c
        where c.platform_account_id = ${input.platformAccountId}
          and c.is_visible = true
          and c.fan_id is not null
      ) ranked
      where rn = 1
    ),
    retention_due as (
      select fp.fan_id
      from page_fans fp
      where fp.platform_account_id = ${input.platformAccountId}
        and fp.is_subscriber = true
        and fp.subscription_expires_at > ${nowSql}
        and fp.subscription_expires_at <= ${nowPlus21Days}
    ),
    candidate_rows as (
      select slp.fan_id as fan_id,
             f.platform_user_id as platform_user_id,
             fp.page_alias as page_alias,
             f.username as username,
             f.display_name as display_name,
             slp.creator_net_amount_mills as creator_net_amount_mills,
             slp.last_transaction_at as last_transaction_at,
             coalesce(fp.is_subscriber, false) as is_subscriber,
             fp.subscription_expires_at as subscription_expires_at,
             pc.platform_conversation_id as platform_conversation_id,
             pc.last_fan_message_at as last_fan_message_at,
             pc.last_model_message_at as last_model_message_at,
             pc.last_message_preview as last_message_preview,
             coalesce(
               pc.message_coverage_status,
               'pending_backfill'::dm_message_coverage_status
             ) as message_coverage_status,
             coalesce(pc.stored_message_count, 0)::int as stored_message_count,
             coalesce(pc.message_backfill_complete, false) as message_backfill_complete,
             coalesce(pc.metadata, '{}'::jsonb) as conversation_metadata,
             coalesce(
               case
                 when pc.last_fan_message_at is null and pc.last_model_message_at is null then null
                 else greatest(
                   coalesce(pc.last_fan_message_at, '-infinity'::timestamptz),
                   coalesce(pc.last_model_message_at, '-infinity'::timestamptz)
                 )
               end,
               pc.last_message_at
             ) as last_contact_at
      from fan_spend_lifetime slp
      inner join fans f on f.id = slp.fan_id
      left join page_fans fp
        on fp.platform_account_id = slp.platform_account_id
       and fp.fan_id = slp.fan_id
      left join primary_conversation pc
        on pc.platform_account_id = slp.platform_account_id
       and pc.fan_id = slp.fan_id
      where slp.platform_account_id = ${input.platformAccountId}
        and f.deleted_detected_at is null
        and slp.creator_net_amount_mills >= ${minimumSpendMills}
        ${subscriberExclusion}
        ${spendWindow}
        ${workboardSnoozeExclusionSql(input.platformAccountId, sql.raw("slp.fan_id"))}
    ),
    filtered as (
      select *,
             case
               when last_contact_at is null then 90
               else least(90,
                 floor(extract(epoch from (${nowSql} - last_contact_at)) / 86400)
               )::int
             end as silence_days,
             case
               when is_subscriber and coalesce(subscription_expires_at > ${nowSql}, false) then 'active'
               when subscription_expires_at is not null then 'expired'
               else 'never'
             end as subscription_status
      from candidate_rows
      ${contactFilter}
    )
  `;
}

export interface WorkboardSubscriberRow {
  fanId: number;
  platformUserId: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  touchpointCode: TouchpointCode;
  touchpointDueAt: Date;
  isSoftTouchpoint: boolean;
  overdueDays: number;
  platformConversationId: string | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  lastMessagePreview: string | null;
  storedMessageCount: number;
  messageCoverageStatus: MessageCoverageStatus;
  messageBackfillComplete: boolean;
  messageSyncEligibility: MessageSyncEligibility;
  subscriptionExpiresAt: Date;
  autoRenew: boolean | null;
  autoRenewOffDetectedAt: Date | null;
  subscriberSince: Date | null;
  subscriptionTierName: string | null;
  lastTransactionAt: Date | null;
}

export async function listWorkboardSubscribers(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<WorkboardSubscriberRow[]> {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const base = subscribersBaseQuery(input.platformAccountId, now);

  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    touchpointCode: TouchpointCode;
    touchpointDueAt: TimestampValue;
    isSoftTouchpoint: boolean;
    overdueDays: NumericValue;
    platformConversationId: string | null;
    lastFanMessageAt: TimestampValue;
    lastModelMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    storedMessageCount: NumericValue;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    conversationMetadata: unknown;
    subscriptionExpiresAt: TimestampValue;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: TimestampValue;
    subscriberSince: TimestampValue;
    subscriptionTierName: string | null;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base},
    workboard_subscribers as (
      select *,
             greatest(0,
               floor(extract(epoch from (${nowSql} - touchpoint_due_at)) / 86400)
             )::int as overdue_days
      from filtered
      where is_handled = false
        ${workboardSnoozeExclusionSql(input.platformAccountId, sql.raw("filtered.fan_id"))}
    )
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
           page_alias as "pageAlias",
           username as "username",
           display_name as "displayName",
           creator_net_amount_mills as "creatorNetAmountMills",
           touchpoint_code as "touchpointCode",
           touchpoint_due_at as "touchpointDueAt",
           is_soft_touchpoint as "isSoftTouchpoint",
           overdue_days as "overdueDays",
           platform_conversation_id as "platformConversationId",
           last_fan_message_at as "lastFanMessageAt",
           last_model_message_at as "lastModelMessageAt",
           last_message_preview as "lastMessagePreview",
           stored_message_count as "storedMessageCount",
           message_coverage_status as "messageCoverageStatus",
           message_backfill_complete as "messageBackfillComplete",
           conversation_metadata as "conversationMetadata",
           subscription_expires_at as "subscriptionExpiresAt",
           auto_renew as "autoRenew",
           auto_renew_off_detected_at as "autoRenewOffDetectedAt",
           subscriber_since as "subscriberSince",
           subscription_tier_name as "subscriptionTierName",
           last_transaction_at as "lastTransactionAt"
    from workboard_subscribers
    order by
      case touchpoint_code
        when '1d' then 1 when '3d' then 2 when '5d' then 3
        when '7d' then 4 when '14d' then 5 when '21d' then 6
        else 99
      end asc,
      case when auto_renew = false then 0 when auto_renew is null then 1 else 2 end asc,
      creator_net_amount_mills desc,
      fan_id asc
  `);

  return result.rows.map((row) => ({
    fanId: normalizeNumber(row.fanId, "fanId"),
    platformUserId: row.platformUserId,
    pageAlias: row.pageAlias,
    username: row.username,
    displayName: row.displayName,
    creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
    touchpointCode: row.touchpointCode,
    touchpointDueAt: requireTimestamp(row.touchpointDueAt, "touchpointDueAt"),
    isSoftTouchpoint: row.isSoftTouchpoint,
    overdueDays: normalizeNumber(row.overdueDays, "overdueDays"),
    platformConversationId: row.platformConversationId,
    lastFanMessageAt: parseTimestamp(row.lastFanMessageAt),
    lastModelMessageAt: parseTimestamp(row.lastModelMessageAt),
    lastMessagePreview: row.lastMessagePreview,
    storedMessageCount: normalizeNumber(row.storedMessageCount, "storedMessageCount"),
    messageCoverageStatus: normalizeMessageCoverageStatus(row.messageCoverageStatus),
    messageBackfillComplete: isMessageBackfillComplete(
      normalizeMessageCoverageStatus(row.messageCoverageStatus),
    ),
    messageSyncEligibility: getMessageSyncEligibility({
      fanId: normalizeNumber(row.fanId, "fanId"),
      metadata: normalizeNullableJsonRecord(row.conversationMetadata) ?? {},
    }),
    subscriptionExpiresAt: requireTimestamp(row.subscriptionExpiresAt, "subscriptionExpiresAt"),
    autoRenew: row.autoRenew,
    autoRenewOffDetectedAt: parseTimestamp(row.autoRenewOffDetectedAt),
    subscriberSince: parseTimestamp(row.subscriberSince),
    subscriptionTierName: row.subscriptionTierName,
    lastTransactionAt: parseTimestamp(row.lastTransactionAt),
  }));
}

export interface WorkboardSpenderRow {
  fanId: number;
  platformUserId: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  silenceDays: number;
  overdueDays: number;
  platformConversationId: string | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  lastMessagePreview: string | null;
  storedMessageCount: number;
  messageCoverageStatus: MessageCoverageStatus;
  messageBackfillComplete: boolean;
  messageSyncEligibility: MessageSyncEligibility;
  subscriptionStatus: "active" | "expired" | "never";
  subscriptionExpiresAt: Date | null;
  lastTransactionAt: Date | null;
}

function normalizeSpenderRows(rows: Array<{
  fanId: NumericValue;
  platformUserId: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: NumericValue;
  silenceDays: NumericValue;
  overdueDays: NumericValue;
  platformConversationId: string | null;
  lastFanMessageAt: TimestampValue;
  lastModelMessageAt: TimestampValue;
  lastMessagePreview: string | null;
  storedMessageCount: NumericValue;
  messageCoverageStatus: MessageCoverageStatus;
  messageBackfillComplete: boolean;
  conversationMetadata: unknown;
  subscriptionStatus: string;
  subscriptionExpiresAt: TimestampValue;
  lastTransactionAt: TimestampValue;
}>): WorkboardSpenderRow[] {
  return rows.map((row) => ({
    fanId: normalizeNumber(row.fanId, "fanId"),
    platformUserId: row.platformUserId,
    pageAlias: row.pageAlias,
    username: row.username,
    displayName: row.displayName,
    creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
    silenceDays: normalizeNumber(row.silenceDays, "silenceDays"),
    overdueDays: normalizeNumber(row.overdueDays, "overdueDays"),
    platformConversationId: row.platformConversationId,
    lastFanMessageAt: parseTimestamp(row.lastFanMessageAt),
    lastModelMessageAt: parseTimestamp(row.lastModelMessageAt),
    lastMessagePreview: row.lastMessagePreview,
    storedMessageCount: normalizeNumber(row.storedMessageCount, "storedMessageCount"),
    messageCoverageStatus: normalizeMessageCoverageStatus(row.messageCoverageStatus),
    messageBackfillComplete: isMessageBackfillComplete(
      normalizeMessageCoverageStatus(row.messageCoverageStatus),
    ),
    messageSyncEligibility: getMessageSyncEligibility({
      fanId: normalizeNumber(row.fanId, "fanId"),
      metadata: normalizeNullableJsonRecord(row.conversationMetadata) ?? {},
    }),
    subscriptionStatus: row.subscriptionStatus as "active" | "expired" | "never",
    subscriptionExpiresAt: parseTimestamp(row.subscriptionExpiresAt),
    lastTransactionAt: parseTimestamp(row.lastTransactionAt),
  }));
}

export async function listWorkboardActiveSpenders(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<WorkboardSpenderRow[]> {
  const base = spenderBaseQuery(input, { recentSpend: true, rhythmDays: 7 });

  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    silenceDays: NumericValue;
    overdueDays: NumericValue;
    platformConversationId: string | null;
    lastFanMessageAt: TimestampValue;
    lastModelMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    storedMessageCount: NumericValue;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    conversationMetadata: unknown;
    subscriptionStatus: string;
    subscriptionExpiresAt: TimestampValue;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
           page_alias as "pageAlias",
           username as "username",
           display_name as "displayName",
           creator_net_amount_mills as "creatorNetAmountMills",
           silence_days as "silenceDays",
           greatest(0, silence_days - 7) as "overdueDays",
           platform_conversation_id as "platformConversationId",
           last_fan_message_at as "lastFanMessageAt",
           last_model_message_at as "lastModelMessageAt",
           last_message_preview as "lastMessagePreview",
           stored_message_count as "storedMessageCount",
           message_coverage_status as "messageCoverageStatus",
           message_backfill_complete as "messageBackfillComplete",
           conversation_metadata as "conversationMetadata",
           subscription_status as "subscriptionStatus",
           subscription_expires_at as "subscriptionExpiresAt",
           last_transaction_at as "lastTransactionAt"
    from filtered
    order by creator_net_amount_mills desc, fan_id asc
  `);

  return normalizeSpenderRows(result.rows);
}

export async function listWorkboardInactiveSpenders(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<WorkboardSpenderRow[]> {
  const base = spenderBaseQuery(input, { recentSpend: false, rhythmDays: 14 });

  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    silenceDays: NumericValue;
    overdueDays: NumericValue;
    platformConversationId: string | null;
    lastFanMessageAt: TimestampValue;
    lastModelMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    storedMessageCount: NumericValue;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    conversationMetadata: unknown;
    subscriptionStatus: string;
    subscriptionExpiresAt: TimestampValue;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
           page_alias as "pageAlias",
           username as "username",
           display_name as "displayName",
           creator_net_amount_mills as "creatorNetAmountMills",
           silence_days as "silenceDays",
           greatest(0, silence_days - 14) as "overdueDays",
           platform_conversation_id as "platformConversationId",
           last_fan_message_at as "lastFanMessageAt",
           last_model_message_at as "lastModelMessageAt",
           last_message_preview as "lastMessagePreview",
           stored_message_count as "storedMessageCount",
           message_coverage_status as "messageCoverageStatus",
           message_backfill_complete as "messageBackfillComplete",
           conversation_metadata as "conversationMetadata",
           subscription_status as "subscriptionStatus",
           subscription_expires_at as "subscriptionExpiresAt",
           last_transaction_at as "lastTransactionAt"
    from filtered
    order by creator_net_amount_mills desc, fan_id asc
  `);

  return normalizeSpenderRows(result.rows);
}

export async function listWorkboardAllSpenders(
  db: Database,
  input: { platformAccountId: number; now?: Date },
): Promise<WorkboardSpenderRow[]> {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const base = spenderBaseQuery(input, {
    recentSpend: null,
    rhythmDays: null,
    minimumSpendMills: 100,
    actionableOnly: false,
    excludeSubscribers: false,
  });

  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    silenceDays: NumericValue;
    overdueDays: NumericValue;
    platformConversationId: string | null;
    lastFanMessageAt: TimestampValue;
    lastModelMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    storedMessageCount: NumericValue;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    conversationMetadata: unknown;
    subscriptionStatus: string;
    subscriptionExpiresAt: TimestampValue;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
           page_alias as "pageAlias",
           username as "username",
           display_name as "displayName",
           creator_net_amount_mills as "creatorNetAmountMills",
           silence_days as "silenceDays",
           greatest(
             0,
             case
               when last_transaction_at is not null
                 and last_transaction_at > ${nowSql} - interval '30 days'
                 then silence_days - 7
               else silence_days - 14
             end
           ) as "overdueDays",
           platform_conversation_id as "platformConversationId",
           last_fan_message_at as "lastFanMessageAt",
           last_model_message_at as "lastModelMessageAt",
           last_message_preview as "lastMessagePreview",
           stored_message_count as "storedMessageCount",
           message_coverage_status as "messageCoverageStatus",
           message_backfill_complete as "messageBackfillComplete",
           conversation_metadata as "conversationMetadata",
           subscription_status as "subscriptionStatus",
           subscription_expires_at as "subscriptionExpiresAt",
           last_transaction_at as "lastTransactionAt"
    from filtered
    order by creator_net_amount_mills desc, fan_id asc
  `);

  return normalizeSpenderRows(result.rows);
}

export async function snoozeWorkboardFan(
  db: Database,
  input: { platformAccountId: number; fanId: number; days: 7 | 14 | 30 },
): Promise<{ fanId: number; snoozedUntil: Date } | null> {
  const result = await db.execute<{
    fanId: NumericValue;
    snoozedUntil: TimestampValue;
  }>(sql`
    insert into workboard_snoozes (platform_account_id, fan_id, snoozed_until)
    select fp.platform_account_id,
           fp.fan_id,
           now() + (${input.days} || ' days')::interval
    from page_fans fp
    inner join fans f on f.id = fp.fan_id
    where fp.platform_account_id = ${input.platformAccountId}
      and fp.fan_id = ${input.fanId}
      and f.deleted_detected_at is null
    on conflict (platform_account_id, fan_id)
    do update set snoozed_until = excluded.snoozed_until,
                  created_at = now()
    returning fan_id as "fanId", snoozed_until as "snoozedUntil"
  `);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    fanId: normalizeNumber(row.fanId, "fanId"),
    snoozedUntil: requireTimestamp(row.snoozedUntil, "snoozedUntil"),
  };
}

export async function unsnoozeWorkboardFan(
  db: Database,
  input: { platformAccountId: number; fanId: number },
): Promise<void> {
  await db.execute(sql`
    delete from workboard_snoozes ws
    using page_fans fp
    where ws.platform_account_id = ${input.platformAccountId}
      and ws.fan_id = ${input.fanId}
      and fp.platform_account_id = ws.platform_account_id
      and fp.fan_id = ws.fan_id
  `);
}

export interface WorkboardSnoozedRow {
  fanId: number;
  platformUserId: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  snoozedUntil: Date;
}

export async function listWorkboardSnoozed(
  db: Database,
  input: { platformAccountId: number },
): Promise<WorkboardSnoozedRow[]> {
  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    snoozedUntil: TimestampValue;
  }>(sql`
    select ws.fan_id as "fanId",
           f.platform_user_id as "platformUserId",
           fp.page_alias as "pageAlias",
           f.username as "username",
           f.display_name as "displayName",
           coalesce(slp.creator_net_amount_mills, 0)::bigint as "creatorNetAmountMills",
           ws.snoozed_until as "snoozedUntil"
    from workboard_snoozes ws
    inner join fans f on f.id = ws.fan_id
    inner join page_fans fp
      on fp.platform_account_id = ws.platform_account_id
     and fp.fan_id = ws.fan_id
    left join fan_spend_lifetime slp
      on slp.platform_account_id = ws.platform_account_id
     and slp.fan_id = ws.fan_id
    where ws.platform_account_id = ${input.platformAccountId}
      and ws.snoozed_until > now()
      and f.deleted_detected_at is null
    order by ws.snoozed_until asc
  `);

  return result.rows.map((row) => ({
    fanId: normalizeNumber(row.fanId, "fanId"),
    platformUserId: row.platformUserId,
    pageAlias: row.pageAlias,
    username: row.username,
    displayName: row.displayName,
    creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
    snoozedUntil: requireTimestamp(row.snoozedUntil, "snoozedUntil"),
  }));
}

export type WorkboardPresenceBucket = "active_now" | "recently_active";

export interface WorkboardPresenceRow {
  fanId: number;
  platformUserId: string;
  pageAlias: string | null;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  isSubscriber: boolean;
  platformConversationId: string | null;
  lastTransactionAt: Date | null;
  externalPresenceAt: Date;
  externalPresenceObservedAt: Date;
  externalPresenceSource: ExternalPresenceSource;
}

export async function listWorkboardPresence(
  db: Database,
  input: {
    platformAccountId: number;
    bucket: WorkboardPresenceBucket;
    now?: Date;
    limit?: number;
  },
): Promise<{ total: number; items: WorkboardPresenceRow[] }> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 20;
  const activeNowCutoff = sql`${new Date(now.getTime() - 30 * 60 * 1000)}::timestamptz`;
  const recentlyActiveCutoff = sql`${new Date(now.getTime() - 120 * 60 * 1000)}::timestamptz`;
  const presenceFilter = input.bucket === "active_now"
    ? sql`
        fp.external_presence_at is not null
        and fp.external_presence_at >= ${activeNowCutoff}
      `
    : sql`
        fp.external_presence_at is not null
        and fp.external_presence_at < ${activeNowCutoff}
        and fp.external_presence_at >= ${recentlyActiveCutoff}
      `;

  const result = await db.execute<{
    total: NumericValue;
    fanId: NumericValue;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    isSubscriber: boolean;
    platformConversationId: string | null;
    lastTransactionAt: TimestampValue;
    externalPresenceAt: TimestampValue;
    externalPresenceObservedAt: TimestampValue;
    externalPresenceSource: string | null;
  }>(sql`
    with primary_conversation as (
      select *
      from (
        select c.*,
               row_number() over (
                 partition by c.platform_account_id, c.fan_id
                 order by c.last_message_at desc nulls last,
                          c.platform_conversation_id desc
               ) as rn
        from page_dm_threads c
        where c.platform_account_id = ${input.platformAccountId}
          and c.is_visible = true
          and c.fan_id is not null
      ) ranked
      where rn = 1
    )
    select count(*) over()::int as total,
           fp.fan_id as "fanId",
           f.platform_user_id as "platformUserId",
           fp.page_alias as "pageAlias",
           f.username as "username",
           f.display_name as "displayName",
           coalesce(slp.creator_net_amount_mills, 0)::bigint as "creatorNetAmountMills",
           coalesce(fp.is_subscriber, false) as "isSubscriber",
           pc.platform_conversation_id as "platformConversationId",
           slp.last_transaction_at as "lastTransactionAt",
           fp.external_presence_at as "externalPresenceAt",
           fp.external_presence_observed_at as "externalPresenceObservedAt",
           fp.external_presence_source as "externalPresenceSource"
    from page_fans fp
    inner join fans f on f.id = fp.fan_id
    left join primary_conversation pc
      on pc.platform_account_id = fp.platform_account_id
     and pc.fan_id = fp.fan_id
    left join fan_spend_lifetime slp
      on slp.platform_account_id = fp.platform_account_id
     and slp.fan_id = fp.fan_id
    where fp.platform_account_id = ${input.platformAccountId}
      and ${presenceFilter}
      and f.deleted_detected_at is null
    order by fp.external_presence_at desc,
             coalesce(slp.creator_net_amount_mills, 0) desc,
             fp.fan_id asc
    limit ${limit}
  `);

  return {
    total: normalizeNumber(result.rows[0]?.total ?? 0, "total"),
    items: result.rows.map((row) => ({
      fanId: normalizeNumber(row.fanId, "fanId"),
      platformUserId: row.platformUserId,
      pageAlias: row.pageAlias,
      username: row.username,
      displayName: row.displayName,
      creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
      isSubscriber: row.isSubscriber,
      platformConversationId: row.platformConversationId,
      lastTransactionAt: parseTimestamp(row.lastTransactionAt),
      externalPresenceAt: requireTimestamp(row.externalPresenceAt, "externalPresenceAt"),
      externalPresenceObservedAt: requireTimestamp(
        row.externalPresenceObservedAt,
        "externalPresenceObservedAt",
      ),
      externalPresenceSource: (
        row.externalPresenceSource ?? FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN
      ) as ExternalPresenceSource,
    })),
  };
}
