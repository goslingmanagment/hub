import { sql } from "drizzle-orm";

import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import type { DmSenderRole } from "../page-dm.ts";
import { jsonParam, textArrayParam, timestampParam, toDate, toRequiredDate } from "./values.ts";

// The Fansly Sync Engine's conversation list (plan §6.2 "Список чатов пишет
// только свои поля", design §5.3): the thread state its resource reads and
// the one writer it writes through.
//
// The list writer owns the list's fields of `page_dm_threads` — the partner
// and its fan, flags, unread count, tier, the `last_message_*` head block,
// visibility, the membership generation, the seen times — and the two list
// keys of `metadata` (`unresolvedIdentity`, `messageSyncExcludedReason`). It
// NEVER writes the stored window (`stored_*`, newest/oldest stored ids, last
// fan/model times), the coverage verdict, `last_message_sync_at` or the chain
// columns: those belong to the message reads (I9), so the legacy sweep's
// stale-snapshot write-back cannot happen here. It never nulls a partner or
// a fan it bound before: a pass that did not resolve the partner keeps them
// (dm map §14.2 item 3).

export interface PageDmThreadListState {
  id: number;
  platformConversationId: string;
  fanId: number | null;
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
  isVisible: boolean;
  lastSeenGeneration: number | null;
  metadata: Record<string, unknown>;
  /** The message reads' own position (read-only here): what a list head is
   *  compared with to decide whether the chat needs a read. */
  newestStoredMessageId: string | null;
  headConfirmedId: string | null;
  updatedAt: Date;
}

type ListStateSqlRow = {
  id: string;
  platformConversationId: string;
  fanId: string | null;
  partnerPlatformUserId: string | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  conversationFlags: number;
  unreadCount: number;
  subscriptionTierId: string | null;
  lastMessageId: string | null;
  lastUnreadMessageId: string | null;
  lastMessageAt: Date | string | null;
  lastMessageSenderId: string | null;
  lastMessageSenderRole: DmSenderRole;
  lastMessagePreview: string | null;
  isVisible: boolean;
  lastSeenGeneration: string | null;
  metadata: Record<string, unknown> | null;
  newestStoredMessageId: string | null;
  headConfirmedId: string | null;
  updatedAt: Date | string;
};

const listStateColumns = sql`
  t.id::text as id,
  t.platform_conversation_id as "platformConversationId",
  t.fan_id::text as "fanId",
  t.partner_platform_user_id as "partnerPlatformUserId",
  t.partner_username as "partnerUsername",
  t.partner_display_name as "partnerDisplayName",
  t.conversation_flags as "conversationFlags",
  t.unread_count as "unreadCount",
  t.subscription_tier_id as "subscriptionTierId",
  t.last_message_id as "lastMessageId",
  t.last_unread_message_id as "lastUnreadMessageId",
  t.last_message_at as "lastMessageAt",
  t.last_message_sender_id as "lastMessageSenderId",
  t.last_message_sender_role::text as "lastMessageSenderRole",
  t.last_message_preview as "lastMessagePreview",
  t.is_visible as "isVisible",
  t.last_seen_generation::text as "lastSeenGeneration",
  t.metadata,
  t.newest_stored_message_id as "newestStoredMessageId",
  t.head_confirmed_id as "headConfirmedId",
  t.updated_at as "updatedAt"
`;

function normalizeListState(row: ListStateSqlRow): PageDmThreadListState {
  return {
    id: Number(row.id),
    platformConversationId: row.platformConversationId,
    fanId: row.fanId === null ? null : Number(row.fanId),
    partnerPlatformUserId: row.partnerPlatformUserId,
    partnerUsername: row.partnerUsername,
    partnerDisplayName: row.partnerDisplayName,
    conversationFlags: Number(row.conversationFlags),
    unreadCount: Number(row.unreadCount),
    subscriptionTierId: row.subscriptionTierId,
    lastMessageId: row.lastMessageId,
    lastUnreadMessageId: row.lastUnreadMessageId,
    lastMessageAt: toDate(row.lastMessageAt),
    lastMessageSenderId: row.lastMessageSenderId,
    lastMessageSenderRole: row.lastMessageSenderRole,
    lastMessagePreview: row.lastMessagePreview,
    isVisible: row.isVisible,
    lastSeenGeneration: row.lastSeenGeneration === null ? null : Number(row.lastSeenGeneration),
    metadata: row.metadata ?? {},
    newestStoredMessageId: row.newestStoredMessageId,
    headConfirmedId: row.headConfirmedId,
    updatedAt: toDate(row.updatedAt)!,
  };
}

/** The list state of the page's threads among these group ids. */
export async function listPageDmThreadListStates(
  db: Database,
  input: { platformAccountId: number; platformConversationIds: readonly string[] },
): Promise<PageDmThreadListState[]> {
  const ids = [...new Set(input.platformConversationIds)];
  if (ids.length === 0) return [];
  const result = await db.execute<ListStateSqlRow>(sql`
    select ${listStateColumns}
      from page_dm_threads t
     where t.platform_account_id = ${input.platformAccountId}
       and t.platform_conversation_id = any(${textArrayParam(ids)})
     order by t.id
  `);
  return result.rows.map(normalizeListState);
}

/**
 * One page of the page's visible threads in the list's own order (newest head
 * first): what a list read at this offset would serve, as far as the database
 * knows it. The shadow estimate of a list step reads it instead of the answer
 * it never gets.
 */
export async function listPageDmThreadListStatesByRecency(
  db: Database,
  input: { platformAccountId: number; offset: number; limit: number },
): Promise<PageDmThreadListState[]> {
  const result = await db.execute<ListStateSqlRow>(sql`
    select ${listStateColumns}
      from page_dm_threads t
     where t.platform_account_id = ${input.platformAccountId}
       and t.is_visible
     order by t.last_message_at desc nulls last, t.id desc
     limit ${Math.max(0, input.limit)}
    offset ${Math.max(0, input.offset)}
  `);
  return result.rows.map(normalizeListState);
}

/** The page's visible threads (the length of a full list walk). */
export async function countPageDmVisibleThreads(db: Database, platformAccountId: number): Promise<number> {
  const result = await db.execute<{ n: number | string }>(sql`
    select count(*)::int as n from page_dm_threads where platform_account_id = ${platformAccountId} and is_visible
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export interface PageDmConversationListFieldsInput {
  platformAccountId: number;
  platformConversationId: string;
  /** Null keeps the fan the row is bound to (never unbinds). */
  fanId: number | null;
  /** Null keeps the stored partner (never unbinds). */
  partnerPlatformUserId: string | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  /** The list row's own fields; absent (a group detail) keeps the stored ones. */
  list?: {
    conversationFlags: number;
    unreadCount: number;
    subscriptionTierId: string | null;
    lastUnreadMessageId: string | null;
  };
  /** The head block as the row should hold it; absent keeps the stored one. */
  head?: {
    lastMessageId: string | null;
    lastMessageAt: Date | null;
    lastMessageSenderId: string | null;
    lastMessageSenderRole: DmSenderRole;
    lastMessagePreview: string | null;
  };
  /** A full walk's membership generation; null keeps the stamp (monotonic). */
  lastSeenGeneration: number | null;
  /** The list's two metadata keys; every other key is kept. */
  unresolvedIdentity: boolean;
  messageSyncExcludedReason: string | null;
}

export interface PageDmConversationListFieldsResult {
  id: number;
  fanId: number | null;
  partnerPlatformUserId: string | null;
  metadata: Record<string, unknown>;
  /** The row did not exist before this write. */
  inserted: boolean;
}

/**
 * The conversation list's writer (design §5.3): insert the thread, or update
 * only the list's fields of it. A listed thread is visible. See the header of
 * this file for what it never writes.
 */
export async function upsertPageDmConversationListFields(
  db: Database,
  input: PageDmConversationListFieldsInput,
): Promise<PageDmConversationListFieldsResult> {
  const listMetadata: Record<string, unknown> = {};
  if (input.unresolvedIdentity) listMetadata.unresolvedIdentity = true;
  if (input.messageSyncExcludedReason !== null) {
    listMetadata[FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY] = input.messageSyncExcludedReason;
  }
  const list = input.list;
  const head = input.head;
  const listSet = list === undefined
    ? sql``
    : sql`,
           conversation_flags = excluded.conversation_flags,
           unread_count = excluded.unread_count,
           subscription_tier_id = excluded.subscription_tier_id,
           last_unread_message_id = excluded.last_unread_message_id`;
  const headSet = head === undefined
    ? sql``
    : sql`,
           last_message_id = excluded.last_message_id,
           last_message_at = excluded.last_message_at,
           last_message_sender_id = excluded.last_message_sender_id,
           last_message_sender_role = excluded.last_message_sender_role,
           last_message_preview = excluded.last_message_preview`;
  const result = await db.execute<{
    id: string;
    fanId: string | null;
    partnerPlatformUserId: string | null;
    metadata: Record<string, unknown> | null;
    inserted: boolean;
  }>(sql`
    insert into page_dm_threads as t (
      platform_account_id, platform_conversation_id, fan_id,
      partner_platform_user_id, partner_username, partner_display_name,
      conversation_flags, unread_count, subscription_tier_id, last_unread_message_id,
      last_message_id, last_message_at, last_message_sender_id, last_message_sender_role, last_message_preview,
      is_visible, last_seen_generation, metadata, last_seen_at, updated_at
    ) values (
      ${input.platformAccountId}, ${input.platformConversationId}, ${input.fanId}::bigint,
      ${input.partnerPlatformUserId}::text, ${input.partnerUsername}::text, ${input.partnerDisplayName}::text,
      ${list?.conversationFlags ?? 0}::int, ${list?.unreadCount ?? 0}::int, ${list?.subscriptionTierId ?? null}::text,
      ${list?.lastUnreadMessageId ?? null}::text,
      ${head?.lastMessageId ?? null}::text, ${timestampParam(head?.lastMessageAt)}, ${head?.lastMessageSenderId ?? null}::text,
      ${head?.lastMessageSenderRole ?? "unknown"}::dm_sender_role, ${head?.lastMessagePreview ?? null}::text,
      true, ${input.lastSeenGeneration}::bigint, ${jsonParam(listMetadata)}, clock_timestamp(), clock_timestamp()
    )
    on conflict (platform_account_id, platform_conversation_id) do update
       set fan_id = coalesce(excluded.fan_id, t.fan_id),
           partner_platform_user_id = coalesce(excluded.partner_platform_user_id, t.partner_platform_user_id),
           partner_username = coalesce(excluded.partner_username, t.partner_username),
           partner_display_name = coalesce(excluded.partner_display_name, t.partner_display_name)${listSet}${headSet},
           is_visible = true,
           last_seen_generation = case
             when excluded.last_seen_generation is null then t.last_seen_generation
             when t.last_seen_generation is null then excluded.last_seen_generation
             else greatest(t.last_seen_generation, excluded.last_seen_generation) end,
           metadata = (coalesce(t.metadata, '{}'::jsonb) - 'unresolvedIdentity' - ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text)
             || excluded.metadata,
           last_seen_at = clock_timestamp(),
           updated_at = clock_timestamp()
    returning t.id::text as id, t.fan_id::text as "fanId", t.partner_platform_user_id as "partnerPlatformUserId",
              t.metadata, (t.xmax = 0) as inserted
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`The conversation list writer returned no row for ${input.platformConversationId}`);
  return {
    id: Number(row.id),
    fanId: row.fanId === null ? null : Number(row.fanId),
    partnerPlatformUserId: row.partnerPlatformUserId,
    metadata: row.metadata ?? {},
    inserted: row.inserted,
  };
}

/** What a page's reads of the conversation list since one `.find`'s first
 *  demand tell it about its chat (step 3b, the shared list-head read). */
export interface DmFindSharedRead {
  /** The chat's thread was written by the list's writer (a list page or a
   *  group detail applied: `last_seen_at`) since the find's first demand — a
   *  read served the chat. Always false on a shadow page, which writes no
   *  thread. */
  found: boolean;
  /** The first read of the list head (offset 0) by one of the list's keys
   *  admitted since the find's first demand whose answer was applied (on a
   *  shadow page: whose estimate settled); null while there is none. An
   *  admission without its applied answer proves nothing. */
  headRead: { attemptId: number; resource: string; subject: string; admittedAt: Date } | null;
}

/**
 * The shared list-head read of one `dm-conversations.find` row (`workId`):
 * by the database clock, from the attempt journal and the thread row — a read
 * admitted before the find's first demand may have been served before the
 * chat existed, so only the later ones count as its head read.
 */
export async function readDmFindSharedRead(
  db: Database,
  input: {
    workId: number;
    pageId: number;
    shadow: boolean;
    platformConversationId: string;
    /** The list's operation (`messaging.groups`). */
    listOperation: string;
    /** The keys whose list reads write the threads they serve. */
    listKeys: readonly string[];
  },
): Promise<DmFindSharedRead> {
  const result = await db.execute<{
    found: boolean;
    attemptId: string | null;
    resource: string | null;
    subject: string | null;
    admittedAt: Date | string | null;
  }>(sql`
    with demand as (
      select w.first_demand_at from sync_work w where w.id = ${input.workId}
    )
    select exists (
             select 1
               from page_dm_threads t
              where not ${input.shadow}::boolean
                and t.platform_account_id = ${input.pageId}
                and t.platform_conversation_id = ${input.platformConversationId}
                and t.last_seen_at >= d.first_demand_at
           ) as found,
           r.id::text as "attemptId", r.resource, r.subject, r.admitted_at as "admittedAt"
      from demand d
      left join lateral (
        select a.id, a.resource, a.subject, a.admitted_at
          from sync_attempts a
         where a.page_id = ${input.pageId}
           and a.shadow = ${input.shadow}::boolean
           and a.admitted_at >= d.first_demand_at
           and a.operation = ${input.listOperation}
           and a.resource = any(${textArrayParam(input.listKeys)})
           and a.request -> 'params' ->> 'offset' = '0'
           and case when a.shadow then a.outcome = 'shadow' else a.apply_state = 'applied' end
         order by a.admitted_at, a.id
         limit 1
      ) r on true
  `);
  const row = result.rows[0];
  if (row === undefined) return { found: false, headRead: null };
  const read = row.attemptId === null || row.resource === null || row.admittedAt === null
    ? null
    : { attemptId: Number(row.attemptId), resource: row.resource, subject: row.subject ?? "", admittedAt: toRequiredDate(row.admittedAt) };
  return { found: row.found === true, headRead: read };
}
