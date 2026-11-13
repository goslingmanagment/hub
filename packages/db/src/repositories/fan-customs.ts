import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// What is left of the old customs' reads (Chat Memory week 4): two look-ups in a fan's chat that the custom orders
// use. Neither reads the table `fan_customs` (0310), which has no reader or writer left — a custom is a custom order
// (`custom-orders.ts`). It stays in the database, empty; only erasure still goes over it (services/erasure).

const num = (value: string | number | null) => (value === null ? null : Number(value));

export interface CustomDeliverySuggestion {
  messageRef: string;
  at: Date;
  mediaCount: number;
  priceMills: number | null;
}

/** Messages with media the page sent in the custom's chat since its payment (or creation), the newest first. */
export async function listCustomDeliverySuggestions(
  db: Database,
  input: { pageId: number; conversationRef: string; since: Date; limit: number },
): Promise<CustomDeliverySuggestion[]> {
  const result = await db.execute<{ message_ref: string; occurred_at: Date | string; media: number; price_mills: string | number | null }>(sql`
    select m.message_ref, m.occurred_at, jsonb_array_length(m.media_metadata) as media, m.price_mills
    from message_archive m
    where m.account_id = ${input.pageId} and m.conversation_ref = ${input.conversationRef}
      and m.is_sent_by_me and m.deleted_at is null and coalesce(m.message_type, 1) <> 2
      and jsonb_array_length(m.media_metadata) > 0
      and m.occurred_at >= ${input.since.toISOString()}::timestamptz
    order by m.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    messageRef: row.message_ref,
    at: new Date(row.occurred_at),
    mediaCount: Number(row.media),
    priceMills: num(row.price_mills),
  }));
}

/** The fan's chat on the page: the thread with the newest message (on Fansly the group). */
export async function findFanConversationRef(db: Database, pageId: number, fanId: number): Promise<string | null> {
  const result = await db.execute<{ conversation: string }>(sql`
    select platform_conversation_id as conversation from page_dm_threads
    where platform_account_id = ${pageId} and fan_id = ${fanId}
    order by last_message_at desc nulls last limit 1`);
  return result.rows[0]?.conversation ?? null;
}
