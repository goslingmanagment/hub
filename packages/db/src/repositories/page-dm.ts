import { and, eq, inArray, sql } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  fanPages,
  fans,
  pageDmConversations,
  pageDmMessages,
  pageSyncCursors,
  pageSyncStates,
} from "../schema.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | string | bigint | null | undefined;

export const PAGE_DM_MESSAGE_HISTORY_LIMIT = 25;

export type MessageCoverageStatus = "pending_backfill" | "partial_window" | "complete";
export type MessageSyncEligibility = "eligible" | "excluded" | "unresolved_identity";
export type DmSenderRole = "fan" | "model" | "system" | "unknown";

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

function normalizeCheckpointTimestamp(value: unknown) {
  return typeof value === "string" ? parseTimestamp(value) : null;
}

function normalizeMessageCoverageStatus(value: unknown): MessageCoverageStatus {
  return value === "partial_window" || value === "complete"
    ? value
    : "pending_backfill";
}

function isMessageBackfillComplete(status: MessageCoverageStatus) {
  return status === "complete";
}

function dmMessageSyncEligibleSql(alias: string) {
  return sql`coalesce(${sql.raw(alias)}.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') = ''`;
}

function unresolvedIdentitySql(alias: string) {
  return sql`coalesce((${sql.raw(alias)}.metadata ->> 'unresolvedIdentity')::boolean, false) = true`;
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
  messageCoverageStatus?: MessageCoverageStatus;
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
  const messageCoverageStatus = input.messageCoverageStatus ?? (
    input.messageBackfillComplete
      ? "complete"
      : "pending_backfill"
  );
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
    messageCoverageStatus,
    messageBackfillComplete: isMessageBackfillComplete(messageCoverageStatus),
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
    update page_dm_threads
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
  messageCoverageStatus: MessageCoverageStatus;
  messageBackfillComplete: boolean;
  messageSyncEligibility: MessageSyncEligibility;
  messageSyncExcludedReason: string | null;
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
  const metadata = row.metadata;
  const messageCoverageStatus = normalizeMessageCoverageStatus(row.messageCoverageStatus);
  const messageSyncExcludedReason = getMessageSyncExcludedReason(metadata);
  const messageSyncEligibility = getMessageSyncEligibility({
    fanId: row.fanId,
    metadata,
  });

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
    messageCoverageStatus,
    messageBackfillComplete: isMessageBackfillComplete(messageCoverageStatus),
    messageSyncEligibility,
    messageSyncExcludedReason,
    lastMessageSyncAt: row.lastMessageSyncAt,
    isVisible: row.isVisible,
    lastSeenGeneration: row.lastSeenGeneration,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    metadata,
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
    messageCoverageStatus: MessageCoverageStatus;
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
        messageCoverageStatus: input.messageCoverageStatus,
        messageBackfillComplete: isMessageBackfillComplete(input.messageCoverageStatus),
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
        messageCoverageStatus: "pending_backfill",
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
  messageCoverageStatus: MessageCoverageStatus;
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
    messageCoverageStatus: MessageCoverageStatus;
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
           c.message_coverage_status as "messageCoverageStatus",
           c.message_backfill_complete as "messageBackfillComplete",
           c.last_message_sync_at as "lastMessageSyncAt"
    from page_dm_threads c
    left join page_fans fp
      on fp.platform_account_id = c.platform_account_id
     and fp.fan_id = c.fan_id
    left join fan_spend_lifetime slp
      on slp.platform_account_id = c.platform_account_id
     and slp.fan_id = c.fan_id
    where c.platform_account_id = ${input.platformAccountId}
      and c.is_visible = true
      and c.fan_id is not null
      and ${dmMessageSyncEligibleSql("c")}
      and (
        ${staleHeadMismatchSql}
        or c.message_coverage_status = 'pending_backfill'::dm_message_coverage_status
      )
    order by
      case
        when ${staleHeadMismatchSql} then 0
        when c.message_coverage_status = 'pending_backfill'::dm_message_coverage_status then 1
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
    messageCoverageStatus: normalizeMessageCoverageStatus(row.messageCoverageStatus),
    messageBackfillComplete: isMessageBackfillComplete(
      normalizeMessageCoverageStatus(row.messageCoverageStatus),
    ),
    lastMessageSyncAt: parseTimestamp(row.lastMessageSyncAt),
  } satisfies PageDmMessageSyncCandidate;
}

export interface PageDmSyncCoverage {
  lastConversationChunkSucceededAt: Date | null;
  lastConversationFullSweepAt: Date | null;
  lastMessageChunkSucceededAt: Date | null;
  pendingMessageBackfillCount: number;
  partialWindowConversationCount: number;
  excludedConversationCount: number;
  unresolvedConversationCount: number;
  previewReadyConversationCount: number;
}

export async function getPageDmSyncCoverage(
  db: Database,
  platformAccountId: number,
) {
  const [conversationState, messageState, conversationCheckpoint, coverage] = await Promise.all([
    db.query.pageSyncStates.findFirst({
      where: and(
        eq(pageSyncStates.pageId, platformAccountId),
        eq(pageSyncStates.stream, "dm_conversations"),
      ),
    }),
    db.query.pageSyncStates.findFirst({
      where: and(
        eq(pageSyncStates.pageId, platformAccountId),
        eq(pageSyncStates.stream, "dm_messages"),
      ),
    }),
    db.query.pageSyncCursors.findFirst({
      where: and(
        eq(pageSyncCursors.pageId, platformAccountId),
        eq(pageSyncCursors.stream, "dm_conversations"),
      ),
    }),
    db.execute<{
      pendingMessageBackfillCount: number;
      partialWindowConversationCount: number;
      excludedConversationCount: number;
      unresolvedConversationCount: number;
      previewReadyConversationCount: number;
    }>(sql`
      select count(*) filter (
               where is_visible = true
                 and fan_id is not null
                 and ${dmMessageSyncEligibleSql("page_dm_threads")}
                 and message_coverage_status = 'pending_backfill'::dm_message_coverage_status
             )::int as "pendingMessageBackfillCount",
             count(*) filter (
               where is_visible = true
                 and fan_id is not null
                 and message_coverage_status = 'partial_window'::dm_message_coverage_status
             )::int as "partialWindowConversationCount",
             count(*) filter (
               where is_visible = true
                 and coalesce(page_dm_threads.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') <> ''
             )::int as "excludedConversationCount",
             count(*) filter (
               where is_visible = true
                 and coalesce(page_dm_threads.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') = ''
                 and (
                   fan_id is null
                   or ${unresolvedIdentitySql("page_dm_threads")}
                 )
             )::int as "unresolvedConversationCount",
             count(*) filter (
               where is_visible = true
                 and fan_id is not null
                 and stored_message_count > 0
             )::int as "previewReadyConversationCount"
      from page_dm_threads
      where platform_account_id = ${platformAccountId}
    `),
  ]);

  const checkpointState = conversationCheckpoint?.state as Record<string, unknown> | undefined;
  return {
    lastConversationChunkSucceededAt: conversationState?.succeededAt ?? null,
    lastConversationFullSweepAt: normalizeCheckpointTimestamp(checkpointState?.lastFullSweepCompletedAt),
    lastMessageChunkSucceededAt: messageState?.succeededAt ?? null,
    pendingMessageBackfillCount: coverage.rows[0]?.pendingMessageBackfillCount ?? 0,
    partialWindowConversationCount: coverage.rows[0]?.partialWindowConversationCount ?? 0,
    excludedConversationCount: coverage.rows[0]?.excludedConversationCount ?? 0,
    unresolvedConversationCount: coverage.rows[0]?.unresolvedConversationCount ?? 0,
    previewReadyConversationCount: coverage.rows[0]?.previewReadyConversationCount ?? 0,
  } satisfies PageDmSyncCoverage;
}

export interface PageConversationPreviewMessageRow {
  platformMessageId: string;
  senderPlatformUserId: string | null;
  senderRole: DmSenderRole;
  createdAt: Date;
  content: string;
  totalTipAmountCents: number;
}

export interface PageConversationPreview {
  fan: {
    id: number;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
  } | null;
  conversation: {
    id: number;
    platformConversationId: string;
    storedMessageCount: number;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    messageSyncEligibility: MessageSyncEligibility;
    messageSyncExcludedReason: string | null;
    lastMessageSyncAt: Date | null;
    unreadCount: number;
    lastMessageAt: Date | null;
  };
  messages: PageConversationPreviewMessageRow[];
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
  conversation: {
    platformConversationId: string;
    storedMessageCount: number;
    messageCoverageStatus: MessageCoverageStatus;
    messageBackfillComplete: boolean;
    messageSyncEligibility: MessageSyncEligibility;
    messageSyncExcludedReason: string | null;
    lastMessageSyncAt: Date | null;
    unreadCount: number;
    lastMessageAt: Date | null;
  };
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
    conversation: {
      platformConversationId: conversation.platformConversationId,
      storedMessageCount: conversation.storedMessageCount,
      messageCoverageStatus: conversation.messageCoverageStatus,
      messageBackfillComplete: conversation.messageBackfillComplete,
      messageSyncEligibility: conversation.messageSyncEligibility,
      messageSyncExcludedReason: conversation.messageSyncExcludedReason,
      lastMessageSyncAt: conversation.lastMessageSyncAt,
      unreadCount: conversation.unreadCount,
      lastMessageAt: conversation.lastMessageAt,
    },
    messages: messagesResult.rows.map((row) => ({
      messageId: row.messageId,
      senderRole: row.senderRole,
      content: row.content,
      createdAt: requireTimestamp(row.createdAt, "createdAt"),
      tipAmountCents: normalizeNumber(row.tipAmountCents, "tipAmountCents"),
    })),
  } satisfies PageConversationMessages;
}

export async function getPageConversationPreview(
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
      ? db.select({
        id: fans.id,
        platformUserId: fans.platformUserId,
        pageAlias: fanPages.pageAlias,
        username: fans.username,
        displayName: fans.displayName,
      }).from(fans)
        .leftJoin(fanPages, and(
          eq(fanPages.platformAccountId, input.platformAccountId),
          eq(fanPages.fanId, fans.id),
        ))
        .where(and(
          eq(fans.id, conversation.fanId),
          sql`${fans.deletedDetectedAt} is null`,
        ))
        .limit(1)
      : Promise.resolve([]),
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
    fan: fanRow[0]
      ? {
        id: fanRow[0].id,
        platformUserId: fanRow[0].platformUserId,
        pageAlias: fanRow[0].pageAlias,
        username: fanRow[0].username,
        displayName: fanRow[0].displayName,
      }
      : null,
    conversation: {
      id: conversation.id,
      platformConversationId: conversation.platformConversationId,
      storedMessageCount: conversation.storedMessageCount,
      messageCoverageStatus: conversation.messageCoverageStatus,
      messageBackfillComplete: conversation.messageBackfillComplete,
      messageSyncEligibility: conversation.messageSyncEligibility,
      messageSyncExcludedReason: conversation.messageSyncExcludedReason,
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
  } satisfies PageConversationPreview;
}
