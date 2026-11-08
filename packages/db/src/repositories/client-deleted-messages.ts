import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The fan's deleted messages of a page (deleted-messages-v1, 0348): the rows of
// the Fansly live overlay (dm_live_messages) that the page's socket saw the fan
// delete. A Fansly deletion is a fact about the message, not an erasure (owner,
// 2026-09-28): the row keeps its text, which this read serves. The route
// (apps/runtime services/client-deleted-messages.ts) decides who may read it.

export interface ClientDeletedMessageRow {
  platformMessageId: string;
  /** Fansly's group id; null when the frame named none. */
  conversationRef: string | null;
  /** The text the socket carried; null when its frame had none. */
  text: string | null;
  /** How many attachments the message had (media, a bundle). */
  attachments: number;
  sentAt: Date | null;
  deletedAt: Date;
}

/**
 * One fan's deleted messages on a page, the latest deleted first, and how many there are in all. Only the fan's own
 * (`is_sent_by_page` false); the partial index dm_live_messages_sender_deleted serves it.
 */
export async function listClientDeletedMessages(
  db: Database,
  input: { pageId: number; fanRef: string; limit: number },
): Promise<{ total: number; rows: ClientDeletedMessageRow[] }> {
  const result = await db.execute<{
    platform_message_id: string; platform_conversation_id: string | null; content: string | null;
    attachments: number | string; created_at: Date | string | null; deleted_at: Date | string; total: number | string;
  }>(sql`
    select l.platform_message_id, l.platform_conversation_id, l.content,
      case when jsonb_typeof(l.attachments) = 'array' then jsonb_array_length(l.attachments) else 0 end as attachments,
      l.created_at, l.deleted_at, count(*) over () as total
    from dm_live_messages l
    where l.page_id = ${input.pageId} and l.sender_platform_user_id = ${input.fanRef}
      and l.deleted_at is not null and l.is_sent_by_page is false
    order by l.deleted_at desc, l.platform_message_id desc
    limit ${input.limit}`);
  return {
    total: result.rows.length === 0 ? 0 : Number(result.rows[0]!.total),
    rows: result.rows.map((row) => ({
      platformMessageId: row.platform_message_id,
      conversationRef: row.platform_conversation_id,
      text: row.content,
      attachments: Number(row.attachments),
      sentAt: row.created_at === null ? null : new Date(row.created_at),
      deletedAt: new Date(row.deleted_at),
    })),
  };
}

export interface ClientChatLengthRow {
  /** The sync chain's state of the thread (`effectiveHistoryStateSql`): only `complete` proves the first message. */
  historyState: "none" | "unverified" | "partial" | "complete";
  /** The proven chain from its head down, and what the page's socket stored after that head. */
  chainCount: number;
  afterHead: number;
  /** When the chain's oldest message was sent. */
  oldestAt: Date | null;
}

/**
 * The length of one chat of a page (the chat header, 2026-11-08), when the page's thread of the group is this fan's;
 * null otherwise. The sync chain (0231, repositories/sync/thread-chain.ts) counts the messages from its head down to
 * its oldest, and `complete` proves the oldest is the chat's first; the live overlay holds what the socket brought
 * after the head before the chain took it in. Ids are snowflakes: after the head means a greater id. Two index reads
 * (the thread's unique key, dm_live_messages_thread).
 */
export async function readClientChatLength(
  db: Database,
  input: { pageId: number; conversationRef: string; fanRef: string },
): Promise<ClientChatLengthRow | null> {
  const result = await db.execute<{
    history_state: ClientChatLengthRow["historyState"]; contiguous_count: number | string;
    contiguous_oldest_at: Date | string | null; after_head: number | string;
  }>(sql`
    select (case when t.history_state = 'none' and t.stored_message_count > 0 then 'unverified' else t.history_state end) as history_state,
      t.contiguous_count, t.contiguous_oldest_at,
      (select count(*) from dm_live_messages l
        where l.page_id = t.platform_account_id and l.platform_conversation_id = t.platform_conversation_id
          and (t.head_confirmed_id is null or l.platform_message_id::numeric > t.head_confirmed_id::numeric)) as after_head
    from page_dm_threads t
    where t.platform_account_id = ${input.pageId} and t.platform_conversation_id = ${input.conversationRef}
      and t.partner_platform_user_id = ${input.fanRef}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    historyState: row.history_state,
    chainCount: Number(row.contiguous_count),
    afterHead: Number(row.after_head),
    oldestAt: row.contiguous_oldest_at === null ? null : new Date(row.contiguous_oldest_at),
  };
}
