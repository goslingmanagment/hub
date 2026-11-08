import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notOwnAccountMessageSql, ppvBoughtSql, seenMessageSql } from "./shift-sql.ts";

// The numbers of one chatter's shift (Chat Memory week 5, 0305/0306/0311,
// docs/plans/2026-10-24-chat-memory/week-5.md §1). Only messages with this
// chatter as their author (client_send_attributions) count: a message without
// an author is nobody's. A PPV is a message with a price in the archive (the
// extension cannot see a Fansly price; the client's flag only stands in for a
// message the archive does not hold yet), as on «Продажи». A mass message
// answers nobody: a Fansly mass message, or one text with the same price and
// files sent to `burstMinChats` or more chats of the page in its clock hour
// (OnlyMonster's, as in «Авторы»). A message deleted within
// `deletedUnseenSeconds` of being sent nobody saw, as in «Разбор смены»: a
// page's is not the chatter's message and answers nobody, a fan's leaves the
// fan waiting on nothing. Database only.

export interface ShiftNumbersRow {
  messages: number;
  ppvSent: number;
  ppvBought: number;
  /** The archive's price of each bought PPV, mills. */
  boughtPrices: number[];
  /** The fans the chatter wrote to, as `<page id>:<fan ref>` (a week counts each once). */
  writtenFans: string[];
  /** Of them: paid on the page after the chatter's first message to them in the shift, before its end. */
  paidFans: string[];
  /** Seconds from the fan's first unanswered message (or the shift's start) to this chatter's reply. */
  replyDelays: number[];
  composed: { hand: number; reply: number; fix: number; other: number };
  /** Fans of the shift's pages whose last message, at the shift's end, is theirs and at most 3 days old. */
  waitingAtEnd: number;
}

export async function readShiftNumbers(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date; burstMinChats: number; deletedUnseenSeconds: number },
): Promise<ShiftNumbersRow> {
  const pages = sql`${sql.param(input.pageIds.map(String))}::bigint[]`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    messages: string | number; ppv_sent: string | number; ppv_bought: string | number; bought_prices: Array<string | number> | null;
    written_fans: string[] | null; paid_fans: string[] | null; reply_delays: Array<string | number> | null;
    hand: string | number; reply: string | number; fix: string | number; other: string | number; waiting_at_end: string | number;
  }>(sql`
    with mine as (
      select a.platform, a.page_id, a.platform_message_id as ref, a.fan_ref, a.composed_with, a.observed_at,
        coalesce(m.price_mills > 0, a.priced) as priced,
        m.conversation_ref as conv, m.occurred_at as at, m.price_mills
      from client_send_attributions a
      left join message_archive m on m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
      where a.user_id = ${input.userId} and a.page_id = any(${pages})
        and a.observed_at >= ${from} and a.observed_at < ${to}
        and ${seenMessageSql("m", input.deletedUnseenSeconds)}
    ),
    -- The shift's pages' messages from 3 days before it (a reply waits at most 3 days) to its end, the page's mass messages
    -- marked; a chat with another page of ours is no fan's.
    page_msgs as materialized (
      select m.account_id as page_id, m.conversation_ref as conv, m.message_ref as ref, m.occurred_at as at, m.is_sent_by_me as sent, m.message_type,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|' || jsonb_array_length(m.media_metadata)::text) as shape,
        ${seenMessageSql("m", input.deletedUnseenSeconds)} as seen
      from message_archive m
      where m.account_id = any(${pages}) and m.conversation_ref is not null
        and m.occurred_at > ${from} - interval '3 days' and m.occurred_at <= ${to}
        and ${notOwnAccountMessageSql("m")}
    ),
    bursts as materialized (
      select page_id, shape, date_trunc('hour', at) as hour
      from page_msgs
      where sent and coalesce(message_type, 1) <> 2
      group by 1, 2, 3
      having count(distinct conv) >= ${input.burstMinChats}
    ),
    flagged as materialized (
      select pm.*, pm.sent and (coalesce(pm.message_type, 1) = 2 or exists (
        select 1 from bursts b where b.page_id = pm.page_id and b.shape = pm.shape and b.hour = date_trunc('hour', pm.at))) as mass
      from page_msgs pm
    ),
    bought as (
      select x.ref, x.price_mills
      from mine x
      where x.priced and ${ppvBoughtSql({ pageId: "x.page_id", platform: "x.platform", ref: "x.ref", conv: "x.conv", at: "x.at" })}
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
    -- A reply looks only at its own chat, so only the chats of this shift are joined: scanning three days of the pages for
    -- every message took 8–11 s a shift on production. Each step is materialized: without it the planner, misjudging the
    -- rows, took minutes.
    chats_flagged as materialized (
      select f.* from flagged f
      where (f.page_id, f.conv) in (select page_id, conv from mine where conv is not null)
    ),
    -- The chatter's own mass message answers nobody either, author or not.
    answering as materialized (
      select row_number() over () as id, x.page_id, x.conv, x.at
      from mine x
      where x.conv is not null
        and not exists (select 1 from flagged f where f.page_id = x.page_id and f.ref = x.ref and f.sent and f.mass)
    ),
    own_before as materialized (
      select x.id, max(o.at) as at
      from answering x
      join chats_flagged o on o.page_id = x.page_id and o.conv = x.conv
      where o.sent and not o.mass and o.seen and o.at < x.at
      group by x.id
    ),
    since_own as materialized (
      select x.*, coalesce(o.at, '-infinity'::timestamptz) as own_at
      from answering x
      left join own_before o on o.id = x.id
    ),
    replies as (
      select x.at, min(f.at) as waited_from
      from since_own x
      join chats_flagged f on f.page_id = x.page_id and f.conv = x.conv
      where not f.sent and f.seen and f.at < x.at and f.at > x.at - interval '3 days' and f.at > x.own_at
      group by x.id, x.at
    ),
    last_messages as (
      select distinct on (f.page_id, f.conv) f.sent
      from flagged f
      where f.at > ${to} - interval '3 days' and not f.mass and f.seen
      order by f.page_id, f.conv, f.at desc
    )
    select
      (select count(*) from mine) as messages,
      (select count(*) from mine where priced) as ppv_sent,
      (select count(*) from bought) as ppv_bought,
      (select array_agg(price_mills) from bought where price_mills is not null) as bought_prices,
      (select array_agg(page_id::text || ':' || fan_ref) from written) as written_fans,
      (select array_agg(page_id::text || ':' || fan_ref) from paid) as paid_fans,
      (select array_agg(extract(epoch from at - greatest(waited_from, ${from}))::bigint) from replies where waited_from is not null) as reply_delays,
      (select count(*) from mine where composed_with = 'hand') as hand,
      (select count(*) from mine where composed_with = 'reply') as reply,
      (select count(*) from mine where composed_with = 'fix') as fix,
      (select count(*) from mine where composed_with is null or composed_with not in ('hand', 'reply', 'fix')) as other,
      (select count(*) from last_messages where not sent) as waiting_at_end`);
  const row = result.rows[0]!;
  return {
    messages: Number(row.messages),
    ppvSent: Number(row.ppv_sent),
    ppvBought: Number(row.ppv_bought),
    boughtPrices: (row.bought_prices ?? []).map(Number),
    writtenFans: row.written_fans ?? [],
    paidFans: row.paid_fans ?? [],
    replyDelays: (row.reply_delays ?? []).map(Number),
    composed: { hand: Number(row.hand), reply: Number(row.reply), fix: Number(row.fix), other: Number(row.other) },
    waitingAtEnd: Number(row.waiting_at_end),
  };
}

export interface ConfirmedShiftCreditRow {
  startedAt: Date;
  endedAt: Date;
  /** The report's credited net; for a page scope, only its lines on those pages. */
  creditedMills: number;
}

/**
 * A chatter's confirmed shift reports that started since `since` (week 4),
 * with what they credit. A team lead's scope sees only the lines of its pages:
 * a report of a shift on several pages credits the others too.
 */
export async function listConfirmedShiftCredits(
  db: Database,
  input: { userId: number; since: Date; pageIds: "all" | readonly number[] },
): Promise<ConfirmedShiftCreditRow[]> {
  const credited = input.pageIds === "all"
    ? sql`r.credited_net_mills`
    : sql`coalesce((
        select sum(l.credited_mills) from shift_report_lines l
        where l.report_id = r.id and l.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      ), 0)`;
  const result = await db.execute<{ started_at: Date | string; ended_at: Date | string; credited: string | number }>(sql`
    select r.started_at, r.ended_at, ${credited} as credited
    from shift_reports r
    where r.user_id = ${input.userId} and r.started_at >= ${input.since.toISOString()}::timestamptz
    order by r.started_at`);
  return result.rows.map((row) => ({
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    creditedMills: Number(row.credited),
  }));
}
