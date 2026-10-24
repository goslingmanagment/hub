import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The numbers of one chatter's shift (Chat Memory week 5, 0305/0306/0311,
// docs/plans/2026-10-24-chat-memory/week-5.md §1). Only messages with this
// chatter as their author (client_send_attributions) count: a message without
// an author is nobody's. Database only.

export interface ShiftNumbersRow {
  messages: number;
  ppvSent: number;
  ppvBought: number;
  /** The archive's price of each bought PPV, mills. */
  boughtPrices: number[];
  fansWritten: number;
  fansPaid: number;
  /** Seconds from the fan's first unanswered message (or the shift's start) to this chatter's reply. */
  replyDelays: number[];
  composed: { hand: number; reply: number; fix: number; other: number };
  /** Fans of the shift's pages whose last message, at the shift's end, is theirs and at most 3 days old. */
  waitingAtEnd: number;
}

export async function readShiftNumbers(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date },
): Promise<ShiftNumbersRow> {
  const pages = sql`${sql.param(input.pageIds.map(String))}::bigint[]`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    messages: string | number; ppv_sent: string | number; ppv_bought: string | number; bought_prices: Array<string | number> | null;
    fans_written: string | number; fans_paid: string | number; reply_delays: Array<string | number> | null;
    hand: string | number; reply: string | number; fix: string | number; other: string | number; waiting_at_end: string | number;
  }>(sql`
    with mine as (
      select a.platform, a.page_id, a.platform_message_id as ref, a.fan_ref, a.priced, a.composed_with, a.observed_at,
        m.conversation_ref as conv, m.occurred_at as at, m.price_mills
      from client_send_attributions a
      left join message_archive m on m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
      where a.user_id = ${input.userId} and a.page_id = any(${pages})
        and a.observed_at >= ${from} and a.observed_at < ${to}
    ),
    bought as (
      select x.ref, x.price_mills
      from mine x
      where x.priced and (
        (x.platform = 'fansly' and (
          exists (select 1 from message_media_offers mo where mo.page_id = x.page_id and mo.message_ref = x.ref and mo.purchase_state = 'purchased')
          or exists (select 1 from media_orders o where o.page_id = x.page_id and o.message_ref = x.ref)))
        or (x.platform = 'onlyfans' and exists (
          select 1 from page_dm_messages d where d.platform_account_id = x.page_id and d.platform_message_id = x.ref and d.purchased_at is not null))
      )
    ),
    written as (
      select page_id, fan_ref, min(observed_at) as first_at from mine where fan_ref is not null group by 1, 2
    ),
    paid as (
      select w.* from written w
      where exists (
        select 1 from transactions t join fans fp on fp.id = t.fan_id
        where t.platform_account_id = w.page_id and fp.platform_user_id = w.fan_ref
          and t.is_active and t.gross_amount_mills > 0
          and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
          and t.occurred_at >= w.first_at and t.occurred_at < ${to})
    ),
    replies as (
      select x.at,
        (select min(f.occurred_at) from message_archive f
          where f.account_id = x.page_id and f.conversation_ref = x.conv and not f.is_sent_by_me
            and f.occurred_at < x.at and f.occurred_at > x.at - interval '3 days'
            and f.occurred_at > coalesce((
              select max(o.occurred_at) from message_archive o
              where o.account_id = x.page_id and o.conversation_ref = x.conv and o.is_sent_by_me
                and coalesce(o.message_type, 1) <> 2 and o.occurred_at < x.at), '-infinity'::timestamptz)
        ) as waited_from
      from mine x
      where x.conv is not null
    ),
    last_messages as (
      select distinct on (m.account_id, m.conversation_ref) m.is_sent_by_me
      from message_archive m
      where m.account_id = any(${pages})
        and m.occurred_at <= ${to} and m.occurred_at > ${to} - interval '3 days'
        and (not m.is_sent_by_me or coalesce(m.message_type, 1) <> 2)
      order by m.account_id, m.conversation_ref, m.occurred_at desc
    )
    select
      (select count(*) from mine) as messages,
      (select count(*) from mine where priced) as ppv_sent,
      (select count(*) from bought) as ppv_bought,
      (select array_agg(price_mills) from bought where price_mills is not null) as bought_prices,
      (select count(*) from written) as fans_written,
      (select count(*) from paid) as fans_paid,
      (select array_agg(extract(epoch from at - greatest(waited_from, ${from}))::bigint) from replies where waited_from is not null) as reply_delays,
      (select count(*) from mine where composed_with = 'hand') as hand,
      (select count(*) from mine where composed_with = 'reply') as reply,
      (select count(*) from mine where composed_with = 'fix') as fix,
      (select count(*) from mine where composed_with is null or composed_with not in ('hand', 'reply', 'fix')) as other,
      (select count(*) from last_messages where not is_sent_by_me) as waiting_at_end`);
  const row = result.rows[0]!;
  return {
    messages: Number(row.messages),
    ppvSent: Number(row.ppv_sent),
    ppvBought: Number(row.ppv_bought),
    boughtPrices: (row.bought_prices ?? []).map(Number),
    fansWritten: Number(row.fans_written),
    fansPaid: Number(row.fans_paid),
    replyDelays: (row.reply_delays ?? []).map(Number),
    composed: { hand: Number(row.hand), reply: Number(row.reply), fix: Number(row.fix), other: Number(row.other) },
    waitingAtEnd: Number(row.waiting_at_end),
  };
}
