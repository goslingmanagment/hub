import { resolveCapturedFanslyDmHeads } from "./fansly-dm-head-debt.ts";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  fanPages,
  fans,
  pageDmConversations,
  pageDmMessages,
  pageDmMessageSyncHealth,
  pageSyncCursors,
  pageSyncStates,
} from "../schema.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | string | bigint | null | undefined;

export const PAGE_DM_PREVIEW_LIMIT = 25;
export const PAGE_DM_LIVE_BACKFILL_CAP = 25;
export const PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT = 200;
export const PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT = 1000;
export const PAGE_DM_MAX_MESSAGE_RETENTION_LIMIT = PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT;
export const PAGE_DM_MESSAGE_HISTORY_LIMIT = PAGE_DM_PREVIEW_LIMIT;

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
  // Audit B11 / decision #50 "heads only ever advance": when two writers race
  // on a row that did not exist at read time (so there was nothing to lock),
  // the conflict-update itself refuses to move the head block backwards. Only
  // the OFAPI writers set this — Fansly's REST sync stays authoritative for
  // its heads (it has no concurrent second writer and must be able to move a
  // head back when the platform deleted the head message).
  headForwardOnly?: boolean;
}

// Mirrors the OFAPI writers' headAdvances(): a head moves only to a strictly
// later timestamp, or to a greater message id (numeric when both ids are
// numeric strings) on an equal timestamp.
const headAdvanceCondition = sql`(
  excluded.last_message_at is not null and (
    ${pageDmConversations.lastMessageAt} is null
    or excluded.last_message_at > ${pageDmConversations.lastMessageAt}
    or (
      excluded.last_message_at = ${pageDmConversations.lastMessageAt}
      and case
        when ${pageDmConversations.lastMessageId} is null then true
        when excluded.last_message_id is null then false
        when excluded.last_message_id ~ '^[0-9]+$' and ${pageDmConversations.lastMessageId} ~ '^[0-9]+$'
          then excluded.last_message_id::numeric > ${pageDmConversations.lastMessageId}::numeric
        else excluded.last_message_id > ${pageDmConversations.lastMessageId}
      end
    )
  )
)`;

// G2 (checkpoint cutover prerequisite): last_seen_generation only ever moves
// forward. Four writers share this upsert, and the OFAPI ones write back a
// stamp they read OUTSIDE the write (ofapi-dm-projection, ofapi-dm-sync) — an
// unconditional `excluded` assignment let a stale reader regress or blank a
// newer stamp, and a regressed stamp makes the next destructive finalization
// (markPageDmConversationsInvisibleByGeneration) hide a LIVE thread. The guard
// is platform-neutral by construction, so it takes no platform argument:
// Fansly generations only grow (max(checkpoint, stored) + 1), and the
// OnlyFans paths write back what they just read, so greatest() is a no-op for
// them except in exactly the race it exists to lose safely. A null `excluded`
// keeps the current stamp — the writers that pass null never intended to
// change it.
const monotonicGenerationSet = sql`case
  when excluded.last_seen_generation is null then ${pageDmConversations.lastSeenGeneration}
  when ${pageDmConversations.lastSeenGeneration} is null then excluded.last_seen_generation
  else greatest(${pageDmConversations.lastSeenGeneration}, excluded.last_seen_generation)
end`;

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

  const headGuardedSet = input.headForwardOnly === true
    ? {
      lastMessageId: sql`case when ${headAdvanceCondition} then excluded.last_message_id else ${pageDmConversations.lastMessageId} end`,
      lastMessageAt: sql`case when ${headAdvanceCondition} then excluded.last_message_at else ${pageDmConversations.lastMessageAt} end`,
      lastMessageSenderId: sql`case when ${headAdvanceCondition} then excluded.last_message_sender_id else ${pageDmConversations.lastMessageSenderId} end`,
      lastMessageSenderRole: sql`case when ${headAdvanceCondition} then excluded.last_message_sender_role else ${pageDmConversations.lastMessageSenderRole} end`,
      lastMessagePreview: sql`case when ${headAdvanceCondition} then excluded.last_message_preview else ${pageDmConversations.lastMessagePreview} end`,
    }
    : {};

  const [row] = await db
    .insert(pageDmConversations)
    .values({
      platformConversationId: input.platformConversationId,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [pageDmConversations.platformAccountId, pageDmConversations.platformConversationId],
      set: { ...patch, ...headGuardedSet, lastSeenGeneration: monotonicGenerationSet },
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

/**
 * How many threads `markPageDmConversationsInvisibleByGeneration` WOULD hide
 * for this generation — the same predicate, counted instead of applied.
 *
 * The Fansly dm_conversations empty-sweep guard is its only caller, and only
 * on a sweep that observed nothing at all: a provider response that lists zero
 * conversations while the page still shows threads is the one shape where the
 * destructive pass would empty a whole inbox off a single bad answer. Keeping
 * the two statements' where-clauses identical is the point — this must count
 * exactly the rows that pass would blank, or the guard measures the wrong set.
 */
export async function countPageDmVisibleThreadsBelowGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  const result = await db.execute<{ count: string | number }>(sql`
    select count(*)::bigint as count
    from page_dm_threads
    where platform_account_id = ${input.platformAccountId}
      and is_visible = true
      and (last_seen_generation is null or last_seen_generation < ${input.generation})
  `);

  const count = Number(result.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Expected page_dm_threads visible-below-generation count to be a non-negative safe integer");
  }
  return count;
}

export async function maxPageDmThreadGeneration(db: Database, platformAccountId: number) {
  const result = await db.execute(sql`
    select coalesce(max(last_seen_generation), 0)::bigint as generation
    from page_dm_threads
    where platform_account_id = ${platformAccountId}
  `);
  const generation = Number(result.rows[0]?.generation ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Expected page_dm_threads generation high-water to be a non-negative safe integer");
  }
  return generation;
}

// G3 (checkpoint cutover): these readers ARE the Fansly dm_conversations
// sweep's membership record. The cumulative `snapshotConversationIds` array
// that used to hold it inside page_sync_cursors.state (O(N²) bytes across a
// sweep) is gone; the rows the sweep stamped are the same set, readable off
// page_dm_threads_generation_idx (platform_account_id, last_seen_generation)
// in constant state. G2 slice 1 made the stamp monotonic under races and G2
// slice 2 proved the two representations equal in production before the
// authority moved here.

export async function countPageDmThreadsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  const result = await db.execute<{ count: string | number }>(sql`
    select count(*)::bigint as count
    from page_dm_threads
    where platform_account_id = ${input.platformAccountId}
      and last_seen_generation = ${input.generation}
  `);

  const count = Number(result.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Expected page_dm_threads generation-set count to be a non-negative safe integer");
  }
  return count;
}

/**
 * G3 per-page overlap check: which of THESE conversation ids are already
 * stamped with the running sweep's generation. A non-empty result means the
 * provider handed the sweep an id it already applied on an earlier offset page
 * — the condition the retired cumulative array used to detect in memory.
 *
 * Called inside the page's write transaction and BEFORE its upserts: after
 * them every id would trivially carry the generation. Bounded by the provider
 * page size (100 ids) and served by the unique (platform_account_id,
 * platform_conversation_id) index.
 */
export async function listPageDmThreadIdsStampedWithGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
    platformConversationIds: readonly string[];
  },
) {
  const platformConversationIds = [...new Set(input.platformConversationIds)];
  if (platformConversationIds.length === 0) {
    return [] as string[];
  }

  const result = await db.execute<{ platform_conversation_id: string }>(sql`
    select t.platform_conversation_id
    from page_dm_threads t
    where t.platform_account_id = ${input.platformAccountId}
      and t.last_seen_generation = ${input.generation}
      and t.platform_conversation_id in (${
    sql.join(platformConversationIds.map((id) => sql`${id}`), sql`, `)
  })
    order by t.platform_conversation_id asc
  `);

  return result.rows.map((row) => String(row.platform_conversation_id));
}

/** The whole generation set as ids. G2 slice 2 read it once per completed
 *  sweep to digest against the array; with the array gone the live sweep needs
 *  only the count, and this stays as the ops/replay reader for asking WHICH
 *  threads a generation holds. Ordered by the qualified column so the ORDER BY
 *  cannot bind to a select alias (the trap that shipped twice here). */
export async function listPageDmThreadIdsByGeneration(
  db: Database,
  input: {
    platformAccountId: number;
    generation: number;
  },
) {
  const result = await db.execute<{ platform_conversation_id: string }>(sql`
    select t.platform_conversation_id
    from page_dm_threads t
    where t.platform_account_id = ${input.platformAccountId}
      and t.last_seen_generation = ${input.generation}
    order by t.platform_conversation_id asc
  `);

  return result.rows.map((row) => String(row.platform_conversation_id));
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
    // Audit B11: the OFAPI webhook projection and the REST reconcile both
    // read-then-full-row-upsert these rows; callers that go on to write must
    // lock the read inside their transaction so a concurrent writer cannot
    // regress a fresher head with a stale snapshot. Rows are locked in id
    // order so multi-row lockers cannot deadlock each other.
    forUpdate?: boolean;
  },
) {
  if (input.platformConversationIds.length === 0) {
    return [] as PageDmConversationRow[];
  }

  const query = db.select()
    .from(pageDmConversations)
    .where(and(
      eq(pageDmConversations.platformAccountId, input.platformAccountId),
      inArray(pageDmConversations.platformConversationId, input.platformConversationIds),
    ))
    .orderBy(asc(pageDmConversations.id));
  const rows = input.forUpdate === true ? await query.for("update") : await query;

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
      setWhere: isNull(pageDmMessages.deletedAt),
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

export interface PageDmMessageLookupRow {
  id: number;
  conversationId: number;
  platformMessageId: string;
  senderRole: DmSenderRole;
  totalTipAmountCents: number;
  purchasedAt: Date | null;
}

/**
 * Looks up a stored DM message by platform message id within one page. Used by
 * the OFAPI projection for by-message events (messages.deleted, ppv.unlocked,
 * tips.received) whose payloads do not carry the conversation id.
 */
export async function findPageDmMessageByPlatformMessageId(
  db: Database,
  input: {
    platformAccountId: number;
    platformMessageId: string;
  },
): Promise<PageDmMessageLookupRow | null> {
  const row = await db.query.pageDmMessages.findFirst({
    where: and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      eq(pageDmMessages.platformMessageId, input.platformMessageId),
      isNull(pageDmMessages.deletedAt),
    ),
  });

  return row
    ? {
      id: row.id,
      conversationId: row.conversationId,
      platformMessageId: row.platformMessageId,
      senderRole: row.senderRole,
      totalTipAmountCents: row.totalTipAmountCents,
      purchasedAt: row.purchasedAt,
    }
    : null;
}

/** Tombstones a stored DM message; returns its conversation id when a live row was removed. */
export async function deletePageDmMessageByPlatformMessageId(
  db: Database,
  input: {
    platformAccountId: number;
    platformMessageId: string;
  },
) {
  const [deleted] = await db
    .update(pageDmMessages)
    .set({
      deletedAt: new Date(),
      content: "",
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
      purchasedAt: null,
      syncedAt: new Date(),
    })
    .where(and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      eq(pageDmMessages.platformMessageId, input.platformMessageId),
      isNull(pageDmMessages.deletedAt),
    ))
    .returning({ conversationId: pageDmMessages.conversationId });

  return deleted ?? null;
}

export async function markPageDmMessagePurchased(
  db: Database,
  input: {
    platformAccountId: number;
    platformMessageId: string;
    purchasedAt?: Date;
  },
) {
  const updated = await db
    .update(pageDmMessages)
    .set({ purchasedAt: input.purchasedAt ?? new Date() })
    .where(and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      eq(pageDmMessages.platformMessageId, input.platformMessageId),
      sql`${pageDmMessages.purchasedAt} is null`,
      isNull(pageDmMessages.deletedAt),
    ))
    .returning({ conversationId: pageDmMessages.conversationId });

  return updated.length > 0;
}

/**
 * Raises a stored message's tip total to at least the given amount (tip events
 * are at-least-once and can race the message upsert, so this is monotonic
 * rather than additive).
 */
export async function raisePageDmMessageTipAmount(
  db: Database,
  input: {
    platformAccountId: number;
    platformMessageId: string;
    tipAmountCents: number;
  },
) {
  const updated = await db
    .update(pageDmMessages)
    .set({
      totalTipAmountCents: sql`greatest(${pageDmMessages.totalTipAmountCents}, ${input.tipAmountCents})`,
    })
    .where(and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      eq(pageDmMessages.platformMessageId, input.platformMessageId),
      isNull(pageDmMessages.deletedAt),
    ))
    .returning({ conversationId: pageDmMessages.conversationId });

  return updated.length > 0;
}

export async function prunePageDmMessagesToLimit(
  db: Database,
  input: {
    conversationId: number;
    limit?: number;
  },
) {
  const requestedLimit = input.limit ?? PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT;
  const limit = Math.min(
    Math.max(0, requestedLimit),
    PAGE_DM_MAX_MESSAGE_RETENTION_LIMIT,
  );
  const result = await db.execute<{ deletedCount: number }>(sql`
    with ranked as (
      select id,
             row_number() over (
               order by created_at desc, platform_message_id desc, id desc
             ) as rn
      from page_dm_messages
      where conversation_id = ${input.conversationId}
        and deleted_at is null
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

export async function getPageDmMessageRetentionLimit(
  db: Database,
  conversationId: number,
) {
  const result = await db.execute<{ retentionLimit: NumericValue }>(sql`
    select case
             when coalesce(slp.creator_net_amount_mills, 0)::bigint > 0
               then ${PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT}
             else ${PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT}
           end::int as "retentionLimit"
    from page_dm_threads c
    left join fan_spend_lifetime slp
      on slp.platform_account_id = c.platform_account_id
     and slp.fan_id = c.fan_id
    where c.id = ${conversationId}
    limit 1
  `);

  return normalizeNumber(
    result.rows[0]?.retentionLimit ?? PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT,
    "retentionLimit",
  );
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
        and deleted_at is null
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

// Matches the OFAPI DM projection's preview rule (truncatePreview).
const PAGE_DM_HEAD_PREVIEW_MAX_LENGTH = 280;

function truncateHeadPreview(content: string | null): string | null {
  if (!content) {
    return null;
  }

  return content.length <= PAGE_DM_HEAD_PREVIEW_MAX_LENGTH
    ? content
    : `${content.slice(0, PAGE_DM_HEAD_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

async function getNewestStoredPageDmMessage(db: Database, conversationId: number) {
  const [row] = await db
    .select({
      platformMessageId: pageDmMessages.platformMessageId,
      createdAt: pageDmMessages.createdAt,
      senderPlatformUserId: pageDmMessages.senderPlatformUserId,
      senderRole: pageDmMessages.senderRole,
      content: pageDmMessages.content,
    })
    .from(pageDmMessages)
    .where(and(
      eq(pageDmMessages.conversationId, conversationId),
      isNull(pageDmMessages.deletedAt),
    ))
    .orderBy(
      desc(pageDmMessages.createdAt),
      desc(pageDmMessages.platformMessageId),
      desc(pageDmMessages.id),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Recomputes a conversation's stored-window bookkeeping (count, newest/oldest
 * ids, last fan/model timestamps) from the rows on disk, optionally pruning to
 * the retention tier first. Unlike finalizePageDmConversationMessageSync this
 * deliberately leaves message_coverage_status and last_message_sync_at alone —
 * it serves live ingest (OFAPI webhook projection) and deletions, which are not
 * sync runs.
 */
export async function refreshPageDmConversationWindow(
  db: Database,
  input: {
    conversationId: number;
    enforceRetention?: boolean;
    /**
     * Platform message id that was just deleted. When it was the conversation
     * head, the head fields (last message id/at/sender/preview, unread state)
     * are rebuilt from the newest remaining stored row instead of previewing
     * deleted content forever (pre-deploy audit B10). The head is only
     * rebuilt on an exact id match, so heads legitimately ahead of the stored
     * window (pending backfill) are never regressed.
     */
    rebuildHeadForDeletedMessageId?: string;
  },
) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    let deletedCount = 0;
    if (input.enforceRetention) {
      const retentionLimit = await getPageDmMessageRetentionLimit(database, input.conversationId);
      deletedCount = await prunePageDmMessagesToLimit(database, {
        conversationId: input.conversationId,
        limit: retentionLimit,
      });
    }
    const summary = await getPageDmMessageWindowSummary(database, input.conversationId);

    let headRepair: Partial<typeof pageDmConversations.$inferInsert> = {};
    if (input.rebuildHeadForDeletedMessageId) {
      const [current] = await database
        .select({
          lastMessageId: pageDmConversations.lastMessageId,
          lastUnreadMessageId: pageDmConversations.lastUnreadMessageId,
          unreadCount: pageDmConversations.unreadCount,
        })
        .from(pageDmConversations)
        .where(eq(pageDmConversations.id, input.conversationId));

      if (current?.lastMessageId === input.rebuildHeadForDeletedMessageId) {
        const newest = await getNewestStoredPageDmMessage(database, input.conversationId);
        headRepair = {
          lastMessageId: newest?.platformMessageId ?? null,
          lastMessageAt: newest?.createdAt ?? null,
          lastMessageSenderId: newest?.senderPlatformUserId ?? null,
          lastMessageSenderRole: newest?.senderRole ?? "unknown",
          lastMessagePreview: truncateHeadPreview(newest?.content ?? null),
        };
        if (current.lastUnreadMessageId === input.rebuildHeadForDeletedMessageId) {
          // The deleted head was the latest unread fan message; drop it from
          // the unread state (the Phase 2 reconcile corrects residual drift).
          const remainingUnread = Math.max(0, current.unreadCount - 1);
          headRepair.unreadCount = remainingUnread;
          headRepair.lastUnreadMessageId =
            remainingUnread > 0 && newest?.senderRole === "fan"
              ? newest.platformMessageId
              : null;
        }
      }
    }

    const [row] = await database
      .update(pageDmConversations)
      .set({
        storedMessageCount: summary.storedMessageCount,
        newestStoredMessageId: summary.newestStoredMessageId,
        oldestStoredMessageId: summary.oldestStoredMessageId,
        lastFanMessageAt: summary.lastFanMessageAt,
        lastModelMessageAt: summary.lastModelMessageAt,
        ...headRepair,
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

export async function finalizePageDmConversationMessageSync(
  db: Database,
  input: {
    conversationId: number;
    messageCoverageStatus: MessageCoverageStatus;
    lastMessageSyncAt?: Date;
    /**
     * When false, the per-conversation retention prune is skipped and only the
     * window bookkeeping is recomputed. Stage 1 retention stand-down: sync
     * callers pass the PAGE_DM_PRUNE_ENABLED kill-switch here (default off),
     * so stored DM history is nondecreasing until Stage 28 re-scopes the prune
     * as a cache policy. Defaults to true to keep the repo function's
     * standalone semantics unchanged.
     */
    enforceRetention?: boolean;
  },
) {
  const lastMessageSyncAt = input.lastMessageSyncAt ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await resolveCapturedFanslyDmHeads(database, input.conversationId);
    let deletedCount = 0;
    if (input.enforceRetention !== false) {
      const retentionLimit = await getPageDmMessageRetentionLimit(database, input.conversationId);
      deletedCount = await prunePageDmMessagesToLimit(database, {
        conversationId: input.conversationId,
        limit: retentionLimit,
      });
    }
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

export interface PageDmMessageDeepBackfillCandidate extends PageDmMessageSyncCandidate {
  retentionLimit: number;
  isSpender: boolean;
}

export async function selectNextPageDmMessageSyncCandidate(
  db: Database,
  input: {
    platformAccountId: number;
    includeHeadDebt?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const nowPlus21Days = sql`${now}::timestamptz + interval '21 days'`;
  const staleHeadMismatchSql = input.includeHeadDebt ? sql`exists (
    select 1 from fansly_dm_head_debt d
    where d.conversation_id = c.id and d.captured_at is null
      and d.attempts < 5 and d.next_retry_at <= ${nowSql}
  )` : sql`
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
    left join page_dm_message_sync_health h
      on h.conversation_id = c.id
    where c.platform_account_id = ${input.platformAccountId}
      and c.is_visible = true
      and c.fan_id is not null
      and ${dmMessageSyncEligibleSql("c")}
      -- Circuit breaker (0086): conversations inside a failure-backoff or
      -- quarantine window are not offered; re-admission is implicit once the
      -- window lapses.
      and (
        h.conversation_id is null
        or (
          (h.next_retry_at is null or h.next_retry_at <= ${nowSql})
          and (h.quarantine_until is null or h.quarantine_until <= ${nowSql})
        )
      )
      and (
        ${staleHeadMismatchSql}
        or (c.message_coverage_status = 'pending_backfill'::dm_message_coverage_status
          and ${input.includeHeadDebt ? sql`not exists (
            select 1 from fansly_dm_head_debt d
            where d.conversation_id = c.id and d.captured_at is null
          )` : sql`true`})
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

export async function selectNextPageDmMessageDeepBackfillCandidate(
  db: Database,
  input: {
    platformAccountId: number;
    now?: Date;
    /** Stage 17: lift the depth cap so the crawl walks to platform exhaustion. */
    ignoreRetentionLimit?: boolean;
  },
) {
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
    retentionLimit: NumericValue;
    isSpender: boolean;
  }>(sql`
    with candidates as (
      select c.id,
             c.platform_conversation_id,
             c.fan_id,
             c.partner_platform_user_id,
             c.unread_count,
             c.last_message_at,
             c.last_message_id,
             c.newest_stored_message_id,
             c.stored_message_count,
             c.message_coverage_status,
             c.message_backfill_complete,
             c.last_message_sync_at,
             coalesce(slp.creator_net_amount_mills, 0)::bigint as creator_net_amount_mills,
             case
               when coalesce(slp.creator_net_amount_mills, 0)::bigint > 0
                 then ${PAGE_DM_SPENDER_MESSAGE_RETENTION_LIMIT}
               else ${PAGE_DM_REGULAR_MESSAGE_RETENTION_LIMIT}
             end::int as retention_limit
      from page_dm_threads c
      left join fan_spend_lifetime slp
        on slp.platform_account_id = c.platform_account_id
       and slp.fan_id = c.fan_id
      where c.platform_account_id = ${input.platformAccountId}
        and c.is_visible = true
        and c.fan_id is not null
        and ${dmMessageSyncEligibleSql("c")}
        and c.message_coverage_status = 'partial_window'::dm_message_coverage_status
        and c.stored_message_count > 0
        and not (
          c.last_message_id is distinct from c.newest_stored_message_id
          and (
            c.last_message_sync_at is null
            or (c.last_message_at is not null and c.last_message_sync_at < c.last_message_at)
          )
        )
    )
    select id as "id",
           platform_conversation_id as "platformConversationId",
           fan_id as "fanId",
           partner_platform_user_id as "partnerPlatformUserId",
           unread_count as "unreadCount",
           last_message_at as "lastMessageAt",
           last_message_id as "lastMessageId",
           newest_stored_message_id as "newestStoredMessageId",
           stored_message_count as "storedMessageCount",
           message_coverage_status as "messageCoverageStatus",
           message_backfill_complete as "messageBackfillComplete",
           last_message_sync_at as "lastMessageSyncAt",
           retention_limit as "retentionLimit",
           (creator_net_amount_mills > 0)::boolean as "isSpender"
    from candidates
    where (${input.ignoreRetentionLimit === true} or stored_message_count < retention_limit)
    order by
      case when creator_net_amount_mills > 0 then 0 else 1 end asc,
      creator_net_amount_mills desc,
      stored_message_count asc,
      last_message_sync_at asc nulls first,
      last_message_at desc nulls last,
      id asc
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
    retentionLimit: normalizeNumber(row.retentionLimit, "retentionLimit"),
    isSpender: row.isSpender,
  } satisfies PageDmMessageDeepBackfillCandidate;
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

  // A raw read of the dm_conversations checkpoint document. Its shape is
  // defined by apps/runtime/src/services/sync/cursor-state.ts (the completed
  // form of DmConversationSweepState); `lastFullSweepCompletedAt` is the one
  // field this coverage view takes from it, and only a certified sweep sets it.
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
      and platform_account_id = ${input.platformAccountId}
      and deleted_at is null
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
    input.limit ?? PAGE_DM_PREVIEW_LIMIT,
    PAGE_DM_PREVIEW_LIMIT,
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
          and platform_account_id = ${input.platformAccountId}
          and deleted_at is null
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

// ─── Per-conversation DM message-sync circuit breaker (0086) ───────────────
// One poison chat (vendor-side scrape timeout, no HTTP status) must not wedge
// a page's whole dm_messages stream. Failures accrue exponential backoff
// (next_retry_at) and, from the 4th failure, a quarantine window; candidate
// selection above skips excluded conversations, re-admission is implicit once
// the windows lapse. Rows are operational sync state — cleared on a
// successful sync of the conversation, cascaded away with their thread.

export const PAGE_DM_SYNC_FAILURE_QUARANTINE_THRESHOLD = 4;
const PAGE_DM_SYNC_FAILURE_BACKOFF_BASE_MINUTES = 5;
const PAGE_DM_SYNC_FAILURE_BACKOFF_CAP_HOURS = 6;
const PAGE_DM_SYNC_QUARANTINE_HOURS = 6;
const PAGE_DM_SYNC_LAST_ERROR_MAX_LENGTH = 500;

export interface PageDmConversationSyncHealth {
  conversationId: number;
  platformAccountId: number;
  failureCount: number;
  errorClass: string | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  quarantineUntil: Date | null;
  preferredPageLimit: number | null;
}

export function isConversationSyncHealthExcluded(
  health: Pick<PageDmConversationSyncHealth, "nextRetryAt" | "quarantineUntil"> | null,
  now: Date = new Date(),
) {
  if (!health) {
    return false;
  }
  const nowMs = now.getTime();
  return (health.nextRetryAt !== null && health.nextRetryAt.getTime() > nowMs) ||
    (health.quarantineUntil !== null && health.quarantineUntil.getTime() > nowMs);
}

export async function getConversationSyncHealth(
  db: Database,
  conversationId: number,
): Promise<PageDmConversationSyncHealth | null> {
  const [row] = await db.select()
    .from(pageDmMessageSyncHealth)
    .where(eq(pageDmMessageSyncHealth.conversationId, conversationId))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    conversationId: row.conversationId,
    platformAccountId: row.platformAccountId,
    failureCount: row.failureCount,
    errorClass: row.errorClass,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt,
    nextRetryAt: row.nextRetryAt,
    quarantineUntil: row.quarantineUntil,
    preferredPageLimit: row.preferredPageLimit,
  };
}

/**
 * Upserts one failure observation: failure_count++, backoff
 * next_retry_at = now + min(5min * 2^(failure_count - 1), 6h), and from the
 * 4th failure a 6h quarantine window. One atomic statement — concurrent
 * writers cannot lose an increment.
 */
export async function recordConversationSyncFailure(
  db: Database,
  input: {
    conversationId: number;
    platformAccountId: number;
    errorClass: string;
    errorMessage: string;
    now?: Date;
  },
): Promise<{ failureCount: number; nextRetryAt: Date | null; quarantineUntil: Date | null }> {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const lastError = input.errorMessage.slice(0, PAGE_DM_SYNC_LAST_ERROR_MAX_LENGTH);
  // Module-level integer literals, inlined so make_interval needs no
  // parameter-type inference.
  const backoffBaseSql = sql.raw(String(PAGE_DM_SYNC_FAILURE_BACKOFF_BASE_MINUTES));
  const backoffCapSql = sql.raw(String(PAGE_DM_SYNC_FAILURE_BACKOFF_CAP_HOURS));
  const quarantineHoursSql = sql.raw(String(PAGE_DM_SYNC_QUARANTINE_HOURS));
  const quarantineThresholdSql = sql.raw(String(PAGE_DM_SYNC_FAILURE_QUARANTINE_THRESHOLD));

  const result = await db.execute<{
    failureCount: NumericValue;
    nextRetryAt: TimestampValue;
    quarantineUntil: TimestampValue;
  }>(sql`
    insert into page_dm_message_sync_health (
      conversation_id, platform_account_id, failure_count, error_class,
      last_error, last_attempt_at, next_retry_at, quarantine_until, updated_at
    )
    values (
      ${input.conversationId}, ${input.platformAccountId}, 1, ${input.errorClass},
      ${lastError}, ${nowSql},
      ${nowSql} + make_interval(mins => ${backoffBaseSql}),
      null, ${nowSql}
    )
    on conflict (conversation_id) do update set
      failure_count = page_dm_message_sync_health.failure_count + 1,
      error_class = excluded.error_class,
      last_error = excluded.last_error,
      last_attempt_at = excluded.last_attempt_at,
      next_retry_at = excluded.last_attempt_at + least(
        make_interval(mins => ${backoffBaseSql})
          * power(2, page_dm_message_sync_health.failure_count),
        make_interval(hours => ${backoffCapSql})
      ),
      quarantine_until = case
        when page_dm_message_sync_health.failure_count + 1 >= ${quarantineThresholdSql}
          then excluded.last_attempt_at + make_interval(hours => ${quarantineHoursSql})
        else page_dm_message_sync_health.quarantine_until
      end,
      updated_at = excluded.updated_at
    returning
      failure_count as "failureCount",
      next_retry_at as "nextRetryAt",
      quarantine_until as "quarantineUntil"
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error("recordConversationSyncFailure returned no row");
  }
  return {
    failureCount: normalizeNumber(row.failureCount, "failureCount"),
    nextRetryAt: parseTimestamp(row.nextRetryAt),
    quarantineUntil: parseTimestamp(row.quarantineUntil),
  };
}

/** Successful sync of the conversation resets its failure bookkeeping. The
 * learned preferred_page_limit survives (0087) — a giant chat's incremental
 * head fetches need the small limit too; the row is dropped only when there
 * is nothing sticky to keep. */
export async function clearConversationSyncHealth(db: Database, conversationId: number) {
  await db.execute(sql`
    with kept as (
      update page_dm_message_sync_health
      set failure_count = 0,
          error_class = null,
          last_error = null,
          next_retry_at = null,
          quarantine_until = null,
          updated_at = now()
      where conversation_id = ${conversationId}
        and preferred_page_limit is not null
      returning conversation_id
    )
    delete from page_dm_message_sync_health
    where conversation_id = ${conversationId}
      and not exists (select 1 from kept)
  `);
}

/** 0087: a successful adaptive probe records the working page limit so later
 * runs start there instead of re-paying the default-limit timeouts. Never
 * touches failure bookkeeping. */
export async function recordConversationPreferredPageLimit(
  db: Database,
  input: { conversationId: number; platformAccountId: number; pageLimit: number },
) {
  await db.execute(sql`
    insert into page_dm_message_sync_health (conversation_id, platform_account_id, preferred_page_limit)
    values (${input.conversationId}, ${input.platformAccountId}, ${input.pageLimit})
    on conflict (conversation_id)
    do update set preferred_page_limit = excluded.preferred_page_limit, updated_at = now()
  `);
}

/**
 * How many of the page's conversations are currently excluded by the breaker
 * (backoff or quarantine window still open). Keeps the dm_messages last_ok
 * stamp honest: exhaustion can complete while poison chats sit out, and this
 * count says so in the run stats.
 */
/** Conversation-level coverage debt per account: breaker rows still carrying
 * failures. Unlike the page-level failure streak (reset to 0 by every
 * partial yield), these rows clear only when THEIR conversation actually
 * syncs — the honest health signal while poison chats sit out. Rows kept
 * only for preferred_page_limit (failure_count = 0) don't count. */
export async function countConversationSyncFailuresByAccount(
  db: Database,
  input?: { platformAccountIds?: readonly number[] },
): Promise<Array<{ platformAccountId: number; failingConversationCount: number }>> {
  const accountFilter = input?.platformAccountIds && input.platformAccountIds.length > 0
    ? sql`where h.platform_account_id in (${sql.join(input.platformAccountIds.map((id) => sql`${id}`), sql`, `)}) and h.failure_count > 0`
    : sql`where h.failure_count > 0`;
  const result = await db.execute<{ platformAccountId: NumericValue; count: NumericValue }>(sql`
    select h.platform_account_id as "platformAccountId", count(*)::bigint as "count"
    from page_dm_message_sync_health h
    ${accountFilter}
    group by h.platform_account_id
  `);
  return result.rows.map((row) => ({
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    failingConversationCount: normalizeNumber(row.count, "count"),
  }));
}

export async function countExcludedConversationSyncHealth(
  db: Database,
  input: { platformAccountId: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const nowSql = sql`${now}::timestamptz`;
  const result = await db.execute<{ count: NumericValue }>(sql`
    select count(*)::bigint as "count"
    from page_dm_message_sync_health h
    where h.platform_account_id = ${input.platformAccountId}
      and (h.next_retry_at > ${nowSql} or h.quarantine_until > ${nowSql})
  `);
  return normalizeNumber(result.rows[0]?.count ?? 0, "count");
}
