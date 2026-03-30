import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { buildContainsSearchPattern } from "./search.ts";
import {
  fanPages,
  fans,
  pageDmConversations,
  pageDmMessages,
  syncCheckpoints,
  syncStreamState,
} from "../schema.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | string | bigint | null | undefined;

export const PAGE_DM_MESSAGE_HISTORY_LIMIT = 25;

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

function normalizeJsonArray(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  throw new Error("Expected JSON array");
}

function normalizeCheckpointTimestamp(value: unknown) {
  return typeof value === "string" ? parseTimestamp(value) : null;
}

function dmMessageSyncEligibleSql(alias: string) {
  return sql`coalesce(${sql.raw(alias)}.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') = ''`;
}

export type DmSenderRole = "fan" | "model" | "system" | "unknown";

export interface UpsertPageDmConversationInput {
  platformAccountId: number;
  fanId: number | null;
  platformConversationId: string;
  partnerPlatformUserId: string | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  conversationFlags: number;
  unreadCount: number;
  subscriptionTierId: string | null;
  lastMessageId: string | null;
  lastUnreadMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSenderId: string | null;
  lastMessageSenderRole: DmSenderRole;
  lastMessagePreview: string | null;
  lastFanMessageAt?: Date | null;
  lastModelMessageAt?: Date | null;
  storedMessageCount?: number;
  newestStoredMessageId?: string | null;
  oldestStoredMessageId?: string | null;
  messageBackfillComplete?: boolean;
  lastMessageSyncAt?: Date | null;
  isVisible?: boolean;
  lastSeenGeneration: number | null;
  metadata?: Record<string, unknown>;
}

export async function upsertPageDmConversation(
  db: Database,
  input: UpsertPageDmConversationInput,
) {
  const now = new Date();
  const patch = {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    partnerPlatformUserId: input.partnerPlatformUserId,
    partnerUsername: input.partnerUsername,
    partnerDisplayName: input.partnerDisplayName,
    conversationFlags: input.conversationFlags,
    unreadCount: input.unreadCount,
    subscriptionTierId: input.subscriptionTierId,
    lastMessageId: input.lastMessageId,
    lastUnreadMessageId: input.lastUnreadMessageId,
    lastMessageAt: input.lastMessageAt,
    lastMessageSenderId: input.lastMessageSenderId,
    lastMessageSenderRole: input.lastMessageSenderRole,
    lastMessagePreview: input.lastMessagePreview,
    lastFanMessageAt: input.lastFanMessageAt ?? null,
    lastModelMessageAt: input.lastModelMessageAt ?? null,
    storedMessageCount: input.storedMessageCount ?? 0,
    newestStoredMessageId: input.newestStoredMessageId ?? null,
    oldestStoredMessageId: input.oldestStoredMessageId ?? null,
    messageBackfillComplete: input.messageBackfillComplete ?? false,
    lastMessageSyncAt: input.lastMessageSyncAt ?? null,
    isVisible: input.isVisible ?? true,
    lastSeenGeneration: input.lastSeenGeneration,
    lastSeenAt: now,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };

  const [row] = await db
    .insert(pageDmConversations)
    .values({
      platformConversationId: input.platformConversationId,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [pageDmConversations.platformAccountId, pageDmConversations.platformConversationId],
      set: patch,
    })
    .returning();

  return row;
}

export async function markPageDmConversationsInvisibleByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update page_dm_conversations
    set is_visible = false,
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and is_visible = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})
  `);
}

export interface PageDmConversationRow {
  id: number;
  platformAccountId: number;
  fanId: number | null;
  platformConversationId: string;
  partnerPlatformUserId: string | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  conversationFlags: number;
  unreadCount: number;
  subscriptionTierId: string | null;
  lastMessageId: string | null;
  lastUnreadMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSenderId: string | null;
  lastMessageSenderRole: DmSenderRole;
  lastMessagePreview: string | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  storedMessageCount: number;
  newestStoredMessageId: string | null;
  oldestStoredMessageId: string | null;
  messageBackfillComplete: boolean;
  lastMessageSyncAt: Date | null;
  isVisible: boolean;
  lastSeenGeneration: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

function normalizeConversationRow(row: typeof pageDmConversations.$inferSelect): PageDmConversationRow {
  return {
    id: row.id,
    platformAccountId: row.platformAccountId,
    fanId: row.fanId,
    platformConversationId: row.platformConversationId,
    partnerPlatformUserId: row.partnerPlatformUserId,
    partnerUsername: row.partnerUsername,
    partnerDisplayName: row.partnerDisplayName,
    conversationFlags: row.conversationFlags,
    unreadCount: row.unreadCount,
    subscriptionTierId: row.subscriptionTierId,
    lastMessageId: row.lastMessageId,
    lastUnreadMessageId: row.lastUnreadMessageId,
    lastMessageAt: row.lastMessageAt,
    lastMessageSenderId: row.lastMessageSenderId,
    lastMessageSenderRole: row.lastMessageSenderRole,
    lastMessagePreview: row.lastMessagePreview,
    lastFanMessageAt: row.lastFanMessageAt,
    lastModelMessageAt: row.lastModelMessageAt,
    storedMessageCount: row.storedMessageCount,
    newestStoredMessageId: row.newestStoredMessageId,
    oldestStoredMessageId: row.oldestStoredMessageId,
    messageBackfillComplete: row.messageBackfillComplete,
    lastMessageSyncAt: row.lastMessageSyncAt,
    isVisible: row.isVisible,
    lastSeenGeneration: row.lastSeenGeneration,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPageDmConversationById(
  db: Database,
  conversationId: number,
) {
  const row = await db.query.pageDmConversations.findFirst({
    where: eq(pageDmConversations.id, conversationId),
  });
  return row ? normalizeConversationRow(row) : null;
}

export async function listPageDmConversationsByPlatformConversationIds(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationIds: string[];
  },
) {
  if (input.platformConversationIds.length === 0) {
    return [] as PageDmConversationRow[];
  }

  const rows = await db.select()
    .from(pageDmConversations)
    .where(and(
      eq(pageDmConversations.platformAccountId, input.platformAccountId),
      inArray(pageDmConversations.platformConversationId, input.platformConversationIds),
    ));

  return rows.map((row) => normalizeConversationRow(row));
}

export async function findVisiblePageDmConversationByPlatformConversationId(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
  },
) {
  const row = await db.query.pageDmConversations.findFirst({
    where: and(
      eq(pageDmConversations.platformAccountId, input.platformAccountId),
      eq(pageDmConversations.platformConversationId, input.platformConversationId),
      eq(pageDmConversations.isVisible, true),
    ),
  });

  return row ? normalizeConversationRow(row) : null;
}

export interface UpsertPageDmMessageInput {
  conversationId: number;
  platformAccountId: number;
  platformMessageId: string;
  senderPlatformUserId: string | null;
  senderRole: DmSenderRole;
  createdAt: Date;
  content: string;
  totalTipAmountCents: number;
  inReplyToMessageId: string | null;
  inReplyToRootMessageId: string | null;
  syncedAt?: Date;
}

export async function upsertPageDmMessages(
  db: Database,
  inputs: UpsertPageDmMessageInput[],
) {
  if (inputs.length === 0) {
    return;
  }

  const syncedAt = new Date();
  await db
    .insert(pageDmMessages)
    .values(inputs.map((input) => ({
      conversationId: input.conversationId,
      platformAccountId: input.platformAccountId,
      platformMessageId: input.platformMessageId,
      senderPlatformUserId: input.senderPlatformUserId,
      senderRole: input.senderRole,
      createdAt: input.createdAt,
      content: input.content,
      totalTipAmountCents: input.totalTipAmountCents,
      inReplyToMessageId: input.inReplyToMessageId,
      inReplyToRootMessageId: input.inReplyToRootMessageId,
      syncedAt: input.syncedAt ?? syncedAt,
    })))
    .onConflictDoUpdate({
      target: [pageDmMessages.conversationId, pageDmMessages.platformMessageId],
      set: {
        senderPlatformUserId: sql`excluded.sender_platform_user_id`,
        senderRole: sql`excluded.sender_role`,
        createdAt: sql`excluded.created_at`,
        content: sql`excluded.content`,
        totalTipAmountCents: sql`excluded.total_tip_amount_cents`,
        inReplyToMessageId: sql`excluded.in_reply_to_message_id`,
        inReplyToRootMessageId: sql`excluded.in_reply_to_root_message_id`,
        syncedAt: sql`excluded.synced_at`,
      },
    });
}

export async function prunePageDmMessagesToLimit(
  db: Database,
  input: {
    conversationId: number;
    limit?: number;
  },
) {
  const limit = Math.min(
    input.limit ?? PAGE_DM_MESSAGE_HISTORY_LIMIT,
    PAGE_DM_MESSAGE_HISTORY_LIMIT,
  );
  const result = await db.execute<{ deletedCount: number }>(sql`
    with ranked as (
      select id,
             row_number() over (
               order by created_at desc, platform_message_id desc, id desc
             ) as rn
      from page_dm_messages
      where conversation_id = ${input.conversationId}
    ),
    deleted as (
      delete from page_dm_messages
      where id in (
        select id
        from ranked
        where rn > ${limit}
      )
      returning 1
    )
    select count(*)::int as "deletedCount"
    from deleted
  `);

  return result.rows[0]?.deletedCount ?? 0;
}

export interface PageDmMessageWindowSummary {
  storedMessageCount: number;
  newestStoredMessageId: string | null;
  oldestStoredMessageId: string | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
}

async function getPageDmMessageWindowSummary(
  db: Database,
  conversationId: number,
) {
  const result = await db.execute<{
    storedMessageCount: number;
    newestStoredMessageId: string | null;
    oldestStoredMessageId: string | null;
    lastFanMessageAt: Date | null;
    lastModelMessageAt: Date | null;
  }>(sql`
    with ordered as (
      select platform_message_id,
             sender_role,
             created_at,
             row_number() over (
               order by created_at desc, platform_message_id desc, id desc
             ) as rn_desc,
             row_number() over (
               order by created_at asc, platform_message_id asc, id asc
             ) as rn_asc
      from page_dm_messages
      where conversation_id = ${conversationId}
    )
    select count(*)::int as "storedMessageCount",
           max(case when rn_desc = 1 then platform_message_id end) as "newestStoredMessageId",
           max(case when rn_asc = 1 then platform_message_id end) as "oldestStoredMessageId",
           max(case when sender_role = 'fan' then created_at end) as "lastFanMessageAt",
           max(case when sender_role = 'model' then created_at end) as "lastModelMessageAt"
    from ordered
  `);

  const row = result.rows[0];
  return {
    storedMessageCount: row?.storedMessageCount ?? 0,
    newestStoredMessageId: row?.newestStoredMessageId ?? null,
    oldestStoredMessageId: row?.oldestStoredMessageId ?? null,
    lastFanMessageAt: parseTimestamp(row?.lastFanMessageAt),
    lastModelMessageAt: parseTimestamp(row?.lastModelMessageAt),
  } satisfies PageDmMessageWindowSummary;
}

export async function finalizePageDmConversationMessageSync(
  db: Database,
  input: {
    conversationId: number;
    messageBackfillComplete: boolean;
    lastMessageSyncAt?: Date;
  },
) {
  const lastMessageSyncAt = input.lastMessageSyncAt ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const deletedCount = await prunePageDmMessagesToLimit(database, {
      conversationId: input.conversationId,
      limit: PAGE_DM_MESSAGE_HISTORY_LIMIT,
    });
    const summary = await getPageDmMessageWindowSummary(database, input.conversationId);

    const [row] = await database
      .update(pageDmConversations)
      .set({
        storedMessageCount: summary.storedMessageCount,
        newestStoredMessageId: summary.newestStoredMessageId,
        oldestStoredMessageId: summary.oldestStoredMessageId,
        messageBackfillComplete: input.messageBackfillComplete,
        lastMessageSyncAt,
        lastFanMessageAt: summary.lastFanMessageAt,
        lastModelMessageAt: summary.lastModelMessageAt,
        updatedAt: new Date(),
      })
      .where(eq(pageDmConversations.id, input.conversationId))
      .returning();

    return {
      conversation: row ? normalizeConversationRow(row) : null,
      deletedCount,
      summary,
    };
  });
}

export async function resetPageDmSyncState(
  db: Database,
  platformAccountId: number,
) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.delete(pageDmMessages).where(eq(pageDmMessages.platformAccountId, platformAccountId));
    await database
      .update(pageDmConversations)
      .set({
        storedMessageCount: 0,
        newestStoredMessageId: null,
        oldestStoredMessageId: null,
        messageBackfillComplete: false,
        lastMessageSyncAt: null,
        lastFanMessageAt: null,
        lastModelMessageAt: null,
        updatedAt: new Date(),
      })
      .where(eq(pageDmConversations.platformAccountId, platformAccountId));
  });
}

export async function getExistingPageDmMessageIds(
  db: Database,
  input: {
    conversationId: number;
    platformMessageIds: string[];
  },
) {
  if (input.platformMessageIds.length === 0) {
    return new Set<string>();
  }

  const rows = await db.select({
    platformMessageId: pageDmMessages.platformMessageId,
  }).from(pageDmMessages)
    .where(and(
      eq(pageDmMessages.conversationId, input.conversationId),
      inArray(pageDmMessages.platformMessageId, input.platformMessageIds),
    ));

  return new Set(rows.map((row) => row.platformMessageId));
}

export interface PageDmMessageSyncCandidate {
  id: number;
  platformConversationId: string;
  fanId: number;
  partnerPlatformUserId: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessageId: string | null;
  newestStoredMessageId: string | null;
  storedMessageCount: number;
  messageBackfillComplete: boolean;
  lastMessageSyncAt: Date | null;
}

export async function selectNextPageDmMessageSyncCandidate(
  db: Database,
  input: {
    platformAccountId: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const staleHeadMismatchSql = sql`
    c.last_message_id is distinct from c.newest_stored_message_id
    and (
      c.last_message_sync_at is null
      or (c.last_message_at is not null and c.last_message_sync_at < c.last_message_at)
    )
  `;
  const result = await db.execute<{
    id: NumericValue;
    platformConversationId: string;
    fanId: NumericValue;
    partnerPlatformUserId: string | null;
    unreadCount: NumericValue;
    lastMessageAt: TimestampValue;
    lastMessageId: string | null;
    newestStoredMessageId: string | null;
    storedMessageCount: NumericValue;
    messageBackfillComplete: boolean;
    lastMessageSyncAt: TimestampValue;
  }>(sql`
    select c.id as "id",
           c.platform_conversation_id as "platformConversationId",
           c.fan_id as "fanId",
           c.partner_platform_user_id as "partnerPlatformUserId",
           c.unread_count as "unreadCount",
           c.last_message_at as "lastMessageAt",
           c.last_message_id as "lastMessageId",
           c.newest_stored_message_id as "newestStoredMessageId",
           c.stored_message_count as "storedMessageCount",
           c.message_backfill_complete as "messageBackfillComplete",
           c.last_message_sync_at as "lastMessageSyncAt"
    from page_dm_conversations c
    left join fan_pages fp
      on fp.platform_account_id = c.platform_account_id
     and fp.fan_id = c.fan_id
    left join spender_lifetime_page slp
      on slp.platform_account_id = c.platform_account_id
     and slp.fan_id = c.fan_id
    where c.platform_account_id = ${input.platformAccountId}
      and c.is_visible = true
      and c.fan_id is not null
      and ${dmMessageSyncEligibleSql("c")}
      and (
        ${staleHeadMismatchSql}
        or c.message_backfill_complete = false
      )
    order by
      case
        when ${staleHeadMismatchSql} then 0
        when c.message_backfill_complete = false then 1
        else 2
      end asc,
      c.unread_count desc,
      case
        when fp.is_subscriber = true
         and fp.subscription_expires_at > ${nowSql}
         and fp.subscription_expires_at <= ${nowPlus21Days} then 0
        else 1
      end asc,
      coalesce(slp.creator_net_amount_mills, 0)::bigint desc,
      c.last_message_at desc nulls last,
      c.last_message_sync_at asc nulls first,
      c.id asc
    limit 1
  `);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: normalizeNumber(row.id, "id"),
    platformConversationId: row.platformConversationId,
    fanId: normalizeNumber(row.fanId, "fanId"),
    partnerPlatformUserId: row.partnerPlatformUserId,
    unreadCount: normalizeNumber(row.unreadCount, "unreadCount"),
    lastMessageAt: parseTimestamp(row.lastMessageAt),
    lastMessageId: row.lastMessageId,
    newestStoredMessageId: row.newestStoredMessageId,
    storedMessageCount: normalizeNumber(row.storedMessageCount, "storedMessageCount"),
    messageBackfillComplete: row.messageBackfillComplete,
    lastMessageSyncAt: parseTimestamp(row.lastMessageSyncAt),
  } satisfies PageDmMessageSyncCandidate;
}

export interface CrmFreshnessCoverage {
  lastConversationChunkSucceededAt: Date | null;
  lastConversationFullSweepAt: Date | null;
  lastMessageChunkSucceededAt: Date | null;
  pendingMessageBackfillCount: number;
  previewReadyConversationCount: number;
}

export async function getCrmFreshnessCoverage(
  db: Database,
  platformAccountId: number,
) {
  const [conversationState, messageState, conversationCheckpoint, coverage] = await Promise.all([
    db.query.syncStreamState.findFirst({
      where: and(
        eq(syncStreamState.platformAccountId, platformAccountId),
        eq(syncStreamState.stream, "dm_conversations"),
      ),
    }),
    db.query.syncStreamState.findFirst({
      where: and(
        eq(syncStreamState.platformAccountId, platformAccountId),
        eq(syncStreamState.stream, "dm_messages"),
      ),
    }),
    db.query.syncCheckpoints.findFirst({
      where: and(
        eq(syncCheckpoints.platformAccountId, platformAccountId),
        eq(syncCheckpoints.stream, "dm_conversations"),
      ),
    }),
    db.execute<{
      pendingMessageBackfillCount: number;
      previewReadyConversationCount: number;
    }>(sql`
      select count(*) filter (
               where is_visible = true
                 and fan_id is not null
                 and ${dmMessageSyncEligibleSql("page_dm_conversations")}
                 and message_backfill_complete = false
             )::int as "pendingMessageBackfillCount",
             count(*) filter (
               where is_visible = true
                 and fan_id is not null
                 and stored_message_count > 0
             )::int as "previewReadyConversationCount"
      from page_dm_conversations
      where platform_account_id = ${platformAccountId}
    `),
  ]);

  const checkpointState = conversationCheckpoint?.state as Record<string, unknown> | undefined;
  return {
    lastConversationChunkSucceededAt: conversationState?.lastSucceededAt ?? null,
    lastConversationFullSweepAt: normalizeCheckpointTimestamp(checkpointState?.lastFullSweepCompletedAt),
    lastMessageChunkSucceededAt: messageState?.lastSucceededAt ?? null,
    pendingMessageBackfillCount: coverage.rows[0]?.pendingMessageBackfillCount ?? 0,
    previewReadyConversationCount: coverage.rows[0]?.previewReadyConversationCount ?? 0,
  } satisfies CrmFreshnessCoverage;
}

type CrmRetentionSortBy =
  | "touchpoint"
  | "subscriptionExpiresAt"
  | "lifetimeSpendUsd"
  | "lastContactAt"
  | "unreadCount";
type SortDir = "asc" | "desc";

function retentionSortSql(sortBy?: CrmRetentionSortBy, sortDir?: SortDir) {
  const dir = sortDir === "asc" ? sql.raw("asc") : sql.raw("desc");

  switch (sortBy) {
    case "subscriptionExpiresAt":
      return sql`order by subscription_expires_at ${dir} nulls last, fan_id asc`;
    case "lifetimeSpendUsd":
      return sql`order by creator_net_amount_mills ${dir} nulls last, fan_id asc`;
    case "lastContactAt":
      return sql`order by last_contact_at ${dir} nulls last, fan_id asc`;
    case "unreadCount":
      return sql`order by unread_count ${dir} nulls last, fan_id asc`;
    case "touchpoint":
    default:
      return sql`
        order by
          case touchpoint_code
            when '1d' then 1
            when '3d' then 2
            when '5d' then 3
            when '7d' then 4
            when '14d' then 5
            when '21d' then 6
            else 99
          end asc,
          case
            when auto_renew = false then 0
            when auto_renew is null then 1
            else 2
          end asc,
          creator_net_amount_mills desc,
          last_contact_at asc nulls first,
          fan_id asc
      `;
  }
}

export interface CrmRetentionListInput {
  platformAccountId: number;
  limit: number;
  offset: number;
  query?: string;
  touchpoint?: Array<"21d" | "14d" | "7d" | "5d" | "3d" | "1d">;
  autoRenew?: boolean;
  unreadOnly?: boolean;
  showHandled?: boolean;
  sortBy?: CrmRetentionSortBy;
  sortDir?: SortDir;
  now?: Date;
}

export interface CrmRetentionRow {
  fanId: number;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  subscriptionExpiresAt: Date;
  autoRenew: boolean | null;
  subscriptionTierName: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastContactAt: Date | null;
  platformConversationId: string | null;
  messageBackfillComplete: boolean;
  storedMessageCount: number;
  touchpointCode: "21d" | "14d" | "7d" | "5d" | "3d" | "1d";
  touchpointDueAt: Date;
  isSoftTouchpoint: boolean;
  isHandled: boolean;
  lastMessageSenderRole: DmSenderRole | null;
}

function retentionBaseQuery(input: CrmRetentionListInput) {
  const query = buildContainsSearchPattern(input.query);
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus1Day = sql`${now}::timestamptz + interval '1 day'`;
  const nowPlus3Days = sql`${now}::timestamptz + interval '3 days'`;
  const nowPlus5Days = sql`${now}::timestamptz + interval '5 days'`;
  const nowPlus7Days = sql`${now}::timestamptz + interval '7 days'`;
  const nowPlus14Days = sql`${now}::timestamptz + interval '14 days'`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const nowMinus48Hours = sql`${now}::timestamptz - interval '48 hours'`;
  const searchFilter = query
    ? sql`
      and (
        f.platform_user_id ilike ${query} escape '\\'
        or f.username ilike ${query} escape '\\'
        or f.display_name ilike ${query} escape '\\'
        or exists (
          select 1
          from fan_username_aliases fua
          where fua.fan_id = fp.fan_id
            and fua.username ilike ${query} escape '\\'
        )
      )
    `
    : sql``;
  const touchpointFilter = input.touchpoint?.length
    ? sql`and touchpoint_code = any(${input.touchpoint})`
    : sql``;
  const autoRenewFilter = input.autoRenew !== undefined
    ? sql`and auto_renew = ${input.autoRenew}`
    : sql``;
  const unreadOnlyFilter = input.unreadOnly
    ? sql`and unread_count > 0`
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
        from page_dm_conversations c
        where c.platform_account_id = ${input.platformAccountId}
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
        where ps.platform_account_id = ${input.platformAccountId}
      ) ranked
      where rn = 1
    ),
    retention_candidates as (
      select fp.fan_id as fan_id,
             f.platform_user_id as platform_user_id,
             f.username as username,
             f.display_name as display_name,
             fp.subscription_expires_at as subscription_expires_at,
             fp.auto_renew as auto_renew,
             fp.subscriber_since as subscriber_since,
             cs.subscription_tier_name as subscription_tier_name,
             coalesce(slp.creator_net_amount_mills, 0)::bigint as creator_net_amount_mills,
             slp.last_transaction_at as last_transaction_at,
             pc.platform_conversation_id as platform_conversation_id,
             coalesce(pc.unread_count, 0)::int as unread_count,
             pc.last_message_at as last_message_at,
             pc.last_fan_message_at as last_fan_message_at,
             pc.last_model_message_at as last_model_message_at,
             pc.last_message_preview as last_message_preview,
             coalesce(pc.message_backfill_complete, false) as message_backfill_complete,
             coalesce(pc.stored_message_count, 0)::int as stored_message_count,
             pc.last_message_sender_role as last_message_sender_role,
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
      from fan_pages fp
      inner join fans f on f.id = fp.fan_id
      left join current_subscription cs
        on cs.platform_account_id = fp.platform_account_id
       and cs.fan_id = fp.fan_id
      left join primary_conversation pc
        on pc.platform_account_id = fp.platform_account_id
       and pc.fan_id = fp.fan_id
      left join spender_lifetime_page slp
        on slp.platform_account_id = fp.platform_account_id
       and slp.fan_id = fp.fan_id
      where fp.platform_account_id = ${input.platformAccountId}
        and fp.is_subscriber = true
        and fp.subscription_expires_at > ${nowSql}
        and fp.subscription_expires_at <= ${nowPlus21Days}
        ${searchFilter}
    ),
    filtered as (
      select *,
             (touchpoint_code in ('21d', '14d')) as is_soft_touchpoint,
             (
               last_contact_at is not null
               and last_contact_at >= greatest(touchpoint_due_at, ${nowMinus48Hours})
             ) as is_handled
      from retention_candidates
      where touchpoint_code is not null
        ${touchpointFilter}
        ${autoRenewFilter}
        ${unreadOnlyFilter}
    )
  `;
}

export async function listCrmRetention(
  db: Database,
  input: CrmRetentionListInput,
) {
  const base = retentionBaseQuery(input);
  const handledFilter = input.showHandled ? sql`` : sql`where is_handled = false`;
  const result = await db.execute<{
    totalCount: number;
    touchpointCounts: unknown;
    fanId: NumericValue | null;
    platformUserId: string | null;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue | null;
    subscriptionExpiresAt: TimestampValue | null;
    autoRenew: boolean | null;
    subscriptionTierName: string | null;
    unreadCount: NumericValue | null;
    lastMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    lastContactAt: TimestampValue;
    platformConversationId: string | null;
    messageBackfillComplete: boolean | null;
    storedMessageCount: NumericValue | null;
    lastMessageSenderRole: string | null;
    touchpointCode: CrmRetentionRow["touchpointCode"] | null;
    touchpointDueAt: TimestampValue | null;
    isSoftTouchpoint: boolean | null;
    isHandled: boolean | null;
  }>(sql`
    ${base},
    scoped as materialized (
      select *
      from filtered
      ${handledFilter}
    ),
    total_summary as (
      select count(*)::int as "totalCount"
      from scoped
    ),
    touchpoint_counts as (
      select touchpoint_code as "touchpointCode",
             count(*)::int as "total"
      from scoped
      group by touchpoint_code
    ),
    paged as (
      select fan_id as "fanId",
             platform_user_id as "platformUserId",
             username as "username",
             display_name as "displayName",
             creator_net_amount_mills as "creatorNetAmountMills",
             subscription_expires_at as "subscriptionExpiresAt",
             auto_renew as "autoRenew",
             subscription_tier_name as "subscriptionTierName",
             unread_count as "unreadCount",
             last_message_at as "lastMessageAt",
             last_message_preview as "lastMessagePreview",
             last_contact_at as "lastContactAt",
             platform_conversation_id as "platformConversationId",
             message_backfill_complete as "messageBackfillComplete",
             stored_message_count as "storedMessageCount",
             last_message_sender_role as "lastMessageSenderRole",
             touchpoint_code as "touchpointCode",
             touchpoint_due_at as "touchpointDueAt",
             is_soft_touchpoint as "isSoftTouchpoint",
             is_handled as "isHandled"
      from scoped
      ${retentionSortSql(input.sortBy, input.sortDir)}
      limit ${input.limit}
      offset ${input.offset}
    )
    select ts."totalCount",
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'touchpointCode', tc."touchpointCode",
               'total', tc."total"
             ))
             from touchpoint_counts tc
           ), '[]'::jsonb) as "touchpointCounts",
           p."fanId",
           p."platformUserId",
           p."username",
           p."displayName",
           p."creatorNetAmountMills",
           p."subscriptionExpiresAt",
           p."autoRenew",
           p."subscriptionTierName",
           p."unreadCount",
           p."lastMessageAt",
           p."lastMessagePreview",
           p."lastContactAt",
           p."platformConversationId",
           p."messageBackfillComplete",
           p."storedMessageCount",
           p."lastMessageSenderRole",
           p."touchpointCode",
           p."touchpointDueAt",
           p."isSoftTouchpoint",
           p."isHandled"
    from total_summary ts
    left join paged p on true
  `);

  const touchpointCounts = normalizeJsonArray(result.rows[0]?.touchpointCounts ?? []);

  return {
    total: result.rows[0]?.totalCount ?? 0,
    countsByTouchpoint: new Map(
      touchpointCounts.map((row) => {
        if (typeof row !== "object" || row === null) {
          throw new Error("Expected touchpoint count row to be an object");
        }

        const { touchpointCode, total } = row as {
          touchpointCode: CrmRetentionRow["touchpointCode"];
          total: number;
        };
        return [touchpointCode, total] as const;
      }),
    ),
    items: result.rows
      .filter((row): row is typeof row & {
        fanId: NumericValue;
        platformUserId: string;
        creatorNetAmountMills: NumericValue;
        subscriptionExpiresAt: TimestampValue;
        unreadCount: NumericValue;
        messageBackfillComplete: boolean;
        storedMessageCount: NumericValue;
        touchpointCode: CrmRetentionRow["touchpointCode"];
        touchpointDueAt: TimestampValue;
        isSoftTouchpoint: boolean;
        isHandled: boolean;
      } => row.fanId !== null)
      .map((row) => ({
      fanId: normalizeNumber(row.fanId, "fanId"),
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
      creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
      subscriptionExpiresAt: requireTimestamp(row.subscriptionExpiresAt, "subscriptionExpiresAt"),
      autoRenew: row.autoRenew,
      subscriptionTierName: row.subscriptionTierName,
      unreadCount: normalizeNumber(row.unreadCount, "unreadCount"),
      lastMessageAt: parseTimestamp(row.lastMessageAt),
      lastMessagePreview: row.lastMessagePreview,
      lastContactAt: parseTimestamp(row.lastContactAt),
      platformConversationId: row.platformConversationId,
      messageBackfillComplete: row.messageBackfillComplete,
      storedMessageCount: normalizeNumber(row.storedMessageCount, "storedMessageCount"),
      lastMessageSenderRole: (row.lastMessageSenderRole as DmSenderRole) ?? null,
      touchpointCode: row.touchpointCode,
      touchpointDueAt: requireTimestamp(row.touchpointDueAt, "touchpointDueAt"),
      isSoftTouchpoint: row.isSoftTouchpoint,
      isHandled: row.isHandled,
    }) satisfies CrmRetentionRow),
  };
}

type CrmReactivationSortBy =
  | "reactivationScore"
  | "lifetimeSpendUsd"
  | "silenceDays"
  | "lastContactAt";

function reactivationSortSql(sortBy?: CrmReactivationSortBy, sortDir?: SortDir) {
  const dir = sortDir === "asc" ? sql.raw("asc") : sql.raw("desc");

  switch (sortBy) {
    case "lifetimeSpendUsd":
      return sql`order by creator_net_amount_mills ${dir}, fan_id asc`;
    case "silenceDays":
      return sql`order by silence_days ${dir}, fan_id asc`;
    case "lastContactAt":
      return sql`order by silence_anchor ${dir} nulls last, fan_id asc`;
    case "reactivationScore":
    default:
      return sql`
        order by reactivation_score desc,
                 creator_net_amount_mills desc,
                 silence_days desc,
                 no_dm_history desc,
                 fan_id asc
      `;
  }
}

export interface CrmReactivationListInput {
  platformAccountId: number;
  limit: number;
  offset: number;
  query?: string;
  minSpendUsd?: number;
  minSilenceDays?: number;
  unreadOnly?: boolean;
  noDmHistoryOnly?: boolean;
  hideDeleted?: boolean;
  subscriberState?: "current" | "former" | "never";
  sortBy?: CrmReactivationSortBy;
  sortDir?: SortDir;
  now?: Date;
}

export interface CrmReactivationRow {
  fanId: number;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  creatorNetAmountMills: bigint;
  lastTransactionAt: Date | null;
  isSubscriber: boolean | null;
  subscriberSince: Date | null;
  subscriptionExpiresAt: Date | null;
  autoRenew: boolean | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  platformConversationId: string | null;
  messageBackfillComplete: boolean;
  storedMessageCount: number;
  noDmHistory: boolean;
  silenceDays: number;
  reactivationScore: number;
  lastMessageSenderRole: DmSenderRole | null;
}

function reactivationBaseQuery(input: CrmReactivationListInput) {
  const query = buildContainsSearchPattern(input.query);
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const minSpendMills = input.minSpendUsd !== undefined
    ? BigInt(Math.trunc(input.minSpendUsd * 1000))
    : 0n;
  const searchFilter = query
    ? sql`
      and (
        f.platform_user_id ilike ${query} escape '\\'
        or f.username ilike ${query} escape '\\'
        or f.display_name ilike ${query} escape '\\'
        or exists (
          select 1
          from fan_username_aliases fua
          where fua.fan_id = slp.fan_id
            and fua.username ilike ${query} escape '\\'
        )
      )
    `
    : sql``;
  const unreadOnlyFilter = input.unreadOnly
    ? sql`and unread_count > 0`
    : sql``;
  const noDmHistoryOnlyFilter = input.noDmHistoryOnly
    ? sql`and no_dm_history = true`
    : sql``;
  const hideDeletedFilter = input.hideDeleted
    ? sql`and not (username is null and display_name is null)`
    : sql``;
  const subscriberStateFilter = input.subscriberState === "current"
    ? sql`and is_subscriber = true`
    : input.subscriberState === "former"
      ? sql`and coalesce(is_subscriber, false) = false and (subscriber_since is not null or subscription_expires_at is not null)`
      : input.subscriberState === "never"
        ? sql`and subscriber_since is null and subscription_expires_at is null`
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
        from page_dm_conversations c
        where c.platform_account_id = ${input.platformAccountId}
          and c.is_visible = true
          and c.fan_id is not null
      ) ranked
      where rn = 1
    ),
    retention_due as (
      select fp.fan_id
      from fan_pages fp
      where fp.platform_account_id = ${input.platformAccountId}
        and fp.is_subscriber = true
        and fp.subscription_expires_at > ${nowSql}
        and fp.subscription_expires_at <= ${nowPlus21Days}
    ),
    candidate_rows as (
      select slp.fan_id as fan_id,
             f.platform_user_id as platform_user_id,
             f.username as username,
             f.display_name as display_name,
             slp.creator_net_amount_mills as creator_net_amount_mills,
             slp.last_transaction_at as last_transaction_at,
             fp.is_subscriber as is_subscriber,
             fp.subscriber_since as subscriber_since,
             fp.subscription_expires_at as subscription_expires_at,
             fp.auto_renew as auto_renew,
             pc.platform_conversation_id as platform_conversation_id,
             coalesce(pc.unread_count, 0)::int as unread_count,
             pc.last_message_at as last_message_at,
             pc.last_message_preview as last_message_preview,
             coalesce(pc.message_backfill_complete, false) as message_backfill_complete,
             coalesce(pc.stored_message_count, 0)::int as stored_message_count,
             pc.last_message_sender_role as last_message_sender_role,
             (pc.id is null) as no_dm_history,
             coalesce(
               pc.last_message_at,
               slp.last_transaction_at,
               fp.subscription_expires_at,
               fp.subscriber_since
             ) as silence_anchor
      from spender_lifetime_page slp
      inner join fans f on f.id = slp.fan_id
      left join fan_pages fp
        on fp.platform_account_id = slp.platform_account_id
       and fp.fan_id = slp.fan_id
      left join primary_conversation pc
        on pc.platform_account_id = slp.platform_account_id
       and pc.fan_id = slp.fan_id
      where slp.platform_account_id = ${input.platformAccountId}
        and slp.creator_net_amount_mills > 0
        and slp.creator_net_amount_mills >= ${minSpendMills}
        and not exists (
          select 1
          from retention_due rd
          where rd.fan_id = slp.fan_id
        )
        ${searchFilter}
    ),
    filtered as (
      select *,
             least(
               90,
               floor(extract(epoch from (${nowSql} - silence_anchor)) / 86400)
             )::int as silence_days,
             ((creator_net_amount_mills::numeric / 1000.0) *
               least(
                 90,
                 floor(extract(epoch from (${nowSql} - silence_anchor)) / 86400)
               )
             )::double precision as reactivation_score
      from candidate_rows
      where silence_anchor is not null
        ${unreadOnlyFilter}
        ${noDmHistoryOnlyFilter}
        ${hideDeletedFilter}
        ${subscriberStateFilter}
        and least(
          90,
          floor(extract(epoch from (${nowSql} - silence_anchor)) / 86400)
        )::int >= ${input.minSilenceDays ?? 7}
    )
  `;
}

export async function listCrmReactivation(
  db: Database,
  input: CrmReactivationListInput,
) {
  const base = reactivationBaseQuery(input);
  const totalResult = await db.execute<{ total: number }>(sql`
    ${base}
    select count(*)::int as "total"
    from filtered
  `);
  const rowsResult = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    lastTransactionAt: TimestampValue;
    isSubscriber: boolean | null;
    subscriberSince: TimestampValue;
    subscriptionExpiresAt: TimestampValue;
    autoRenew: boolean | null;
    unreadCount: NumericValue;
    lastMessageAt: TimestampValue;
    lastMessagePreview: string | null;
    platformConversationId: string | null;
    messageBackfillComplete: boolean;
    storedMessageCount: NumericValue;
    lastMessageSenderRole: string | null;
    noDmHistory: boolean;
    silenceDays: NumericValue;
    reactivationScore: number;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
           username as "username",
           display_name as "displayName",
           creator_net_amount_mills as "creatorNetAmountMills",
           last_transaction_at as "lastTransactionAt",
           is_subscriber as "isSubscriber",
           subscriber_since as "subscriberSince",
           subscription_expires_at as "subscriptionExpiresAt",
           auto_renew as "autoRenew",
           unread_count as "unreadCount",
           last_message_at as "lastMessageAt",
           last_message_preview as "lastMessagePreview",
           platform_conversation_id as "platformConversationId",
           message_backfill_complete as "messageBackfillComplete",
           stored_message_count as "storedMessageCount",
           last_message_sender_role as "lastMessageSenderRole",
           no_dm_history as "noDmHistory",
           silence_days as "silenceDays",
           reactivation_score as "reactivationScore"
    from filtered
    ${reactivationSortSql(input.sortBy, input.sortDir)}
    limit ${input.limit}
    offset ${input.offset}
  `);

  return {
    total: totalResult.rows[0]?.total ?? 0,
    items: rowsResult.rows.map((row) => ({
      fanId: normalizeNumber(row.fanId, "fanId"),
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
      creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
      lastTransactionAt: parseTimestamp(row.lastTransactionAt),
      isSubscriber: row.isSubscriber,
      subscriberSince: parseTimestamp(row.subscriberSince),
      subscriptionExpiresAt: parseTimestamp(row.subscriptionExpiresAt),
      autoRenew: row.autoRenew,
      unreadCount: normalizeNumber(row.unreadCount, "unreadCount"),
      lastMessageAt: parseTimestamp(row.lastMessageAt),
      lastMessagePreview: row.lastMessagePreview,
      platformConversationId: row.platformConversationId,
      messageBackfillComplete: row.messageBackfillComplete,
      storedMessageCount: normalizeNumber(row.storedMessageCount, "storedMessageCount"),
      lastMessageSenderRole: (row.lastMessageSenderRole as DmSenderRole) ?? null,
      noDmHistory: row.noDmHistory,
      silenceDays: normalizeNumber(row.silenceDays, "silenceDays"),
      reactivationScore: row.reactivationScore,
    }) satisfies CrmReactivationRow),
  };
}

export interface CrmSummary {
  retentionTotal: number;
  retentionCountsByTouchpoint: Record<string, number>;
  reactivationTotal: number;
  freshness: CrmFreshnessCoverage;
}

export async function getCrmSummary(
  db: Database,
  input: {
    platformAccountId: number;
    now?: Date;
  },
) {
  const [retention, reactivation, freshness] = await Promise.all([
    listCrmRetention(db, {
      platformAccountId: input.platformAccountId,
      limit: 1,
      offset: 0,
      showHandled: false,
      now: input.now,
    }),
    listCrmReactivation(db, {
      platformAccountId: input.platformAccountId,
      limit: 1,
      offset: 0,
      now: input.now,
    }),
    getCrmFreshnessCoverage(db, input.platformAccountId),
  ]);

  return {
    retentionTotal: retention.total,
    retentionCountsByTouchpoint: {
      "21d": retention.countsByTouchpoint.get("21d") ?? 0,
      "14d": retention.countsByTouchpoint.get("14d") ?? 0,
      "7d": retention.countsByTouchpoint.get("7d") ?? 0,
      "5d": retention.countsByTouchpoint.get("5d") ?? 0,
      "3d": retention.countsByTouchpoint.get("3d") ?? 0,
      "1d": retention.countsByTouchpoint.get("1d") ?? 0,
    },
    reactivationTotal: reactivation.total,
    freshness,
  } satisfies CrmSummary;
}

export interface CrmPreviewMessageRow {
  platformMessageId: string;
  senderPlatformUserId: string | null;
  senderRole: DmSenderRole;
  createdAt: Date;
  content: string;
  totalTipAmountCents: number;
}

export interface CrmConversationPreview {
  fan: {
    id: number;
    platformUserId: string;
    username: string | null;
    displayName: string | null;
  } | null;
  conversation: {
    id: number;
    platformConversationId: string;
    storedMessageCount: number;
    messageBackfillComplete: boolean;
    lastMessageSyncAt: Date | null;
    unreadCount: number;
    lastMessageAt: Date | null;
  };
  messages: CrmPreviewMessageRow[];
}

export interface PageConversationMessageRow {
  messageId: string;
  senderRole: DmSenderRole;
  content: string;
  createdAt: Date;
  tipAmountCents: number;
}

export interface PageConversationMessages {
  conversationId: string;
  messages: PageConversationMessageRow[];
}

export async function getPageConversationMessages(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
    limit?: number;
  },
) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(db, {
    platformAccountId: input.platformAccountId,
    platformConversationId: input.platformConversationId,
  });
  if (!conversation) {
    return null;
  }

  const messagesResult = await db.execute<{
    messageId: string;
    senderRole: DmSenderRole;
    createdAt: TimestampValue;
    content: string;
    tipAmountCents: NumericValue;
  }>(sql`
    select platform_message_id as "messageId",
           sender_role as "senderRole",
           created_at as "createdAt",
           content as "content",
           total_tip_amount_cents as "tipAmountCents"
    from page_dm_messages
    where conversation_id = ${conversation.id}
    order by created_at desc, platform_message_id desc, id desc
    limit ${limit}
  `);

  return {
    conversationId: conversation.platformConversationId,
    messages: messagesResult.rows.map((row) => ({
      messageId: row.messageId,
      senderRole: row.senderRole,
      content: row.content,
      createdAt: requireTimestamp(row.createdAt, "createdAt"),
      tipAmountCents: normalizeNumber(row.tipAmountCents, "tipAmountCents"),
    })),
  } satisfies PageConversationMessages;
}

export async function getCrmConversationPreview(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
    limit?: number;
  },
) {
  const limit = Math.min(
    input.limit ?? PAGE_DM_MESSAGE_HISTORY_LIMIT,
    PAGE_DM_MESSAGE_HISTORY_LIMIT,
  );
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(db, {
    platformAccountId: input.platformAccountId,
    platformConversationId: input.platformConversationId,
  });
  if (!conversation) {
    return null;
  }

  const [fanRow, messagesResult] = await Promise.all([
    conversation.fanId
      ? db.query.fans.findFirst({
        where: eq(fans.id, conversation.fanId),
      })
      : Promise.resolve(null),
    db.execute<{
      platformMessageId: string;
      senderPlatformUserId: string | null;
      senderRole: DmSenderRole;
      createdAt: TimestampValue;
      content: string;
      totalTipAmountCents: NumericValue;
    }>(sql`
      select platform_message_id as "platformMessageId",
             sender_platform_user_id as "senderPlatformUserId",
             sender_role as "senderRole",
             created_at as "createdAt",
             content as "content",
             total_tip_amount_cents as "totalTipAmountCents"
      from (
        select *
        from page_dm_messages
        where conversation_id = ${conversation.id}
        order by created_at desc, platform_message_id desc, id desc
        limit ${limit}
      ) newest
      order by created_at asc, platform_message_id asc
    `),
  ]);

  return {
    fan: fanRow
      ? {
        id: fanRow.id,
        platformUserId: fanRow.platformUserId,
        username: fanRow.username,
        displayName: fanRow.displayName,
      }
      : null,
    conversation: {
      id: conversation.id,
      platformConversationId: conversation.platformConversationId,
      storedMessageCount: conversation.storedMessageCount,
      messageBackfillComplete: conversation.messageBackfillComplete,
      lastMessageSyncAt: conversation.lastMessageSyncAt,
      unreadCount: conversation.unreadCount,
      lastMessageAt: conversation.lastMessageAt,
    },
    messages: messagesResult.rows.map((row) => ({
      platformMessageId: row.platformMessageId,
      senderPlatformUserId: row.senderPlatformUserId,
      senderRole: row.senderRole,
      createdAt: requireTimestamp(row.createdAt, "createdAt"),
      content: row.content,
      totalTipAmountCents: normalizeNumber(row.totalTipAmountCents, "totalTipAmountCents"),
    })),
  } satisfies CrmConversationPreview;
}

// ---------------------------------------------------------------------------
// Workboard
// ---------------------------------------------------------------------------

type TouchpointCode = "21d" | "14d" | "7d" | "5d" | "3d" | "1d";

function workboardSnoozeExclusionSql(platformAccountId: number, fanIdSql: SQL) {
  return sql`
    and not exists (
      select 1 from workboard_snoozes ws
      where ws.fan_id = ${fanIdSql}
        and ws.platform_account_id = ${platformAccountId}
        and ws.snoozed_until > now()
    )
  `;
}

// -- Subscribers (tab 1) ---------------------------------------------------

export interface WorkboardSubscribersInput {
  platformAccountId: number;
  now?: Date;
}

export interface WorkboardSubscriberRow {
  fanId: number;
  platformUserId: string;
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
  messageBackfillComplete: boolean;
  subscriptionExpiresAt: Date;
  autoRenew: boolean | null;
  subscriberSince: Date | null;
  subscriptionTierName: string | null;
  lastTransactionAt: Date | null;
}

export async function listWorkboardSubscribers(
  db: Database,
  input: WorkboardSubscribersInput,
): Promise<WorkboardSubscriberRow[]> {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;

  const base = retentionBaseQuery({
    platformAccountId: input.platformAccountId,
    limit: 10000,
    offset: 0,
    showHandled: false,
    now,
  });

  const result = await db.execute<{
    fanId: NumericValue;
    platformUserId: string;
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
    messageBackfillComplete: boolean;
    subscriptionExpiresAt: TimestampValue;
    autoRenew: boolean | null;
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
           message_backfill_complete as "messageBackfillComplete",
           subscription_expires_at as "subscriptionExpiresAt",
           auto_renew as "autoRenew",
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
    messageBackfillComplete: row.messageBackfillComplete,
    subscriptionExpiresAt: requireTimestamp(row.subscriptionExpiresAt, "subscriptionExpiresAt"),
    autoRenew: row.autoRenew,
    subscriberSince: parseTimestamp(row.subscriberSince),
    subscriptionTierName: row.subscriptionTierName,
    lastTransactionAt: parseTimestamp(row.lastTransactionAt),
  }));
}

// -- Spenders (tabs 2 & 3) -------------------------------------------------

export interface WorkboardSpenderRow {
  fanId: number;
  platformUserId: string;
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
  messageBackfillComplete: boolean;
  subscriptionStatus: "expired" | "never";
  subscriptionExpiresAt: Date | null;
  lastTransactionAt: Date | null;
}

function spenderBaseQuery(
  input: { platformAccountId: number; now?: Date },
  opts: {
    recentSpend: boolean;
    rhythmDays: number;
  },
) {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const contactThreshold = sql`${now}::timestamptz - (${opts.rhythmDays} || ' days')::interval`;

  const spendWindow = opts.recentSpend
    ? sql`and slp.last_transaction_at > ${nowSql} - interval '30 days'`
    : sql`and (slp.last_transaction_at is null or slp.last_transaction_at <= ${nowSql} - interval '30 days')`;

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
        from page_dm_conversations c
        where c.platform_account_id = ${input.platformAccountId}
          and c.is_visible = true
          and c.fan_id is not null
      ) ranked
      where rn = 1
    ),
    retention_due as (
      select fp.fan_id
      from fan_pages fp
      where fp.platform_account_id = ${input.platformAccountId}
        and fp.is_subscriber = true
        and fp.subscription_expires_at > ${nowSql}
        and fp.subscription_expires_at <= ${nowPlus21Days}
    ),
    candidate_rows as (
      select slp.fan_id as fan_id,
             f.platform_user_id as platform_user_id,
             f.username as username,
             f.display_name as display_name,
             slp.creator_net_amount_mills as creator_net_amount_mills,
             slp.last_transaction_at as last_transaction_at,
             fp.subscription_expires_at as subscription_expires_at,
             pc.platform_conversation_id as platform_conversation_id,
             pc.last_fan_message_at as last_fan_message_at,
             pc.last_model_message_at as last_model_message_at,
             pc.last_message_preview as last_message_preview,
             coalesce(pc.stored_message_count, 0)::int as stored_message_count,
             coalesce(pc.message_backfill_complete, false) as message_backfill_complete,
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
      from spender_lifetime_page slp
      inner join fans f on f.id = slp.fan_id
      left join fan_pages fp
        on fp.platform_account_id = slp.platform_account_id
       and fp.fan_id = slp.fan_id
      left join primary_conversation pc
        on pc.platform_account_id = slp.platform_account_id
       and pc.fan_id = slp.fan_id
      where slp.platform_account_id = ${input.platformAccountId}
        and slp.creator_net_amount_mills >= 100000
        and not coalesce(fp.is_subscriber, false)
        and not exists (
          select 1 from retention_due rd where rd.fan_id = slp.fan_id
        )
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
               when subscription_expires_at is not null then 'expired'
               else 'never'
             end as subscription_status
      from candidate_rows
      where last_contact_at is null
         or last_contact_at < ${contactThreshold}
    )
  `;
}

function normalizeSpenderRows(rows: Array<{
  fanId: NumericValue;
  platformUserId: string;
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
  messageBackfillComplete: boolean;
  subscriptionStatus: string;
  subscriptionExpiresAt: TimestampValue;
  lastTransactionAt: TimestampValue;
}>): WorkboardSpenderRow[] {
  return rows.map((row) => ({
    fanId: normalizeNumber(row.fanId, "fanId"),
    platformUserId: row.platformUserId,
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
    messageBackfillComplete: row.messageBackfillComplete,
    subscriptionStatus: row.subscriptionStatus as "expired" | "never",
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
    messageBackfillComplete: boolean;
    subscriptionStatus: string;
    subscriptionExpiresAt: TimestampValue;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
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
           message_backfill_complete as "messageBackfillComplete",
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
    messageBackfillComplete: boolean;
    subscriptionStatus: string;
    subscriptionExpiresAt: TimestampValue;
    lastTransactionAt: TimestampValue;
  }>(sql`
    ${base}
    select fan_id as "fanId",
           platform_user_id as "platformUserId",
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
           message_backfill_complete as "messageBackfillComplete",
           subscription_status as "subscriptionStatus",
           subscription_expires_at as "subscriptionExpiresAt",
           last_transaction_at as "lastTransactionAt"
    from filtered
    order by creator_net_amount_mills desc, fan_id asc
  `);

  return normalizeSpenderRows(result.rows);
}

// -- Snooze / Unsnooze ------------------------------------------------------

export async function snoozeWorkboardFan(
  db: Database,
  input: { platformAccountId: number; fanId: number; days: 7 | 14 | 30 },
): Promise<{ fanId: number; snoozedUntil: Date }> {
  const result = await db.execute<{
    fanId: NumericValue;
    snoozedUntil: TimestampValue;
  }>(sql`
    insert into workboard_snoozes (platform_account_id, fan_id, snoozed_until)
    values (${input.platformAccountId}, ${input.fanId}, now() + (${input.days} || ' days')::interval)
    on conflict (platform_account_id, fan_id)
    do update set snoozed_until = excluded.snoozed_until,
                  created_at = now()
    returning fan_id as "fanId", snoozed_until as "snoozedUntil"
  `);

  const row = result.rows[0]!;
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
    delete from workboard_snoozes
    where platform_account_id = ${input.platformAccountId}
      and fan_id = ${input.fanId}
  `);
}

// -- Snoozed list -----------------------------------------------------------

export interface WorkboardSnoozedRow {
  fanId: number;
  platformUserId: string;
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
    username: string | null;
    displayName: string | null;
    creatorNetAmountMills: NumericValue;
    snoozedUntil: TimestampValue;
  }>(sql`
    select ws.fan_id as "fanId",
           f.platform_user_id as "platformUserId",
           f.username as "username",
           f.display_name as "displayName",
           coalesce(slp.creator_net_amount_mills, 0)::bigint as "creatorNetAmountMills",
           ws.snoozed_until as "snoozedUntil"
    from workboard_snoozes ws
    inner join fans f on f.id = ws.fan_id
    left join spender_lifetime_page slp
      on slp.platform_account_id = ws.platform_account_id
     and slp.fan_id = ws.fan_id
    where ws.platform_account_id = ${input.platformAccountId}
      and ws.snoozed_until > now()
    order by ws.snoozed_until asc
  `);

  return result.rows.map((row) => ({
    fanId: normalizeNumber(row.fanId, "fanId"),
    platformUserId: row.platformUserId,
    username: row.username,
    displayName: row.displayName,
    creatorNetAmountMills: normalizeBigInt(row.creatorNetAmountMills, "creatorNetAmountMills"),
    snoozedUntil: requireTimestamp(row.snoozedUntil, "snoozedUntil"),
  }));
}
