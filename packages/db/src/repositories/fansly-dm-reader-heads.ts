import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export type FanslyDmReaderHead = { conversationRef: string; messageId: string };
export type FanslyDmReaderHeadReceipt = {
  state: "materialized" | "content_pending" | "deleted" | "missing" | null;
  source: "message_archive" | "dm_message_archive" | "hot" | null;
  liveHotCopy: boolean;
};

export function fanslyDmReaderHeadKey(head: FanslyDmReaderHead): string {
  return JSON.stringify([head.conversationRef, head.messageId]);
}

/** Agent transcript precedence and tombstones for exact advertised IDs only.
 * This has no transcript window, pagination or history-completeness meaning. */
export async function queryFanslyDmReaderHeads(
  db: Pick<Database, "execute">,
  pageId: number,
  heads: readonly FanslyDmReaderHead[],
): Promise<Map<string, FanslyDmReaderHeadReceipt>> {
  if (heads.length === 0) return new Map();
  if (heads.length > 100) throw new Error("DM reader check exceeds one list page");
  const values = sql.join(heads.map((head, ordinal) => sql`(
    ${ordinal}::integer, ${head.conversationRef}::text, ${head.messageId}::text
  )`), sql`, `);
  const result = await db.execute<{
    ordinal: number; state: FanslyDmReaderHeadReceipt["state"];
    source: FanslyDmReaderHeadReceipt["source"]; live_hot_copy: boolean;
  }>(sql`
    with page as (
      select p.id, p.ofapi_account_id from pages p
      where p.id = ${pageId}::bigint and p.platform = 'fansly'
    ), targets(ordinal, group_ref, message_id) as (values ${values}),
    candidates as materialized (
      select h.ordinal, ma.deleted_at, ma.content_pending,
        1 as source_rank, 'message_archive'::text as source
      from targets h cross join page p
      join message_archive ma on ma.account_id = p.id and ma.platform = 'fansly'
        and ma.conversation_ref = h.group_ref and ma.message_ref = h.message_id
      union all
      select h.ordinal, d.deleted_at, d.message_created_at is null,
        2, 'dm_message_archive'::text
      from targets h cross join page p
      join dm_message_archive d on d.platform_account_id = p.id and d.platform = 'fansly'
        and d.platform_conversation_id = h.group_ref and d.platform_message_id = h.message_id
      union all
      select h.ordinal, m.deleted_at, false, 0, 'hot'::text
      from targets h cross join page p
      join page_dm_threads t on t.platform_account_id = p.id
        and t.platform_conversation_id = h.group_ref
      join page_dm_messages m on m.conversation_id = t.id and m.platform_message_id = h.message_id
    ), tombstoned as (
      select c.ordinal from candidates c where c.deleted_at is not null
      union
      select h.ordinal from targets h cross join page p
      join dm_message_archive d on d.ofapi_account_id = p.ofapi_account_id
        and d.platform = 'fansly' and d.platform_message_id = h.message_id
        and d.deleted_at is not null
      where exists (select 1 from candidates c where c.ordinal = h.ordinal)
    ), best as (
      select distinct on (c.ordinal) c.* from candidates c
      order by c.ordinal, c.source_rank desc
    )
    select h.ordinal, case
      when not exists (select 1 from page) then null
      when b.ordinal is null then 'missing'
      when exists (select 1 from tombstoned t where t.ordinal = h.ordinal) then 'deleted'
      when b.content_pending then 'content_pending'
      else 'materialized' end as state,
      b.source, exists (select 1 from candidates c where c.ordinal = h.ordinal
        and c.source_rank = 0 and c.deleted_at is null) as live_hot_copy
    from targets h left join best b on b.ordinal = h.ordinal
    order by h.ordinal
  `);
  return new Map(result.rows.map(row => [fanslyDmReaderHeadKey(heads[row.ordinal]!), {
    state: row.state, source: row.source, liveHotCopy: row.live_hot_copy,
  }]));
}
