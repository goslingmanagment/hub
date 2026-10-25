import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Chat Memory week 6, «Покрытие» (docs/plans/2026-10-24-chat-memory/week-6.md
// §В–Г): read-only analytics over what Hub already holds. Money is net
// (`creator_net_amount_mills`) of sales a fan paid, as in the shift report.

const SALE_TYPES = sql`('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')`;

export interface PageEmptyHoursRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  /** The page's first minute in the chat extension; null — nobody has worked on it in the extension yet. */
  shiftsSince: Date | null;
  /** Clock hours (from `shiftsSince`) in which fans wrote. */
  hoursWithFans: number;
  /** Of them: not a single chatter minute on the page in that hour. */
  emptyHours: number;
  /** `emptyHours` by Moscow hour of day, 0–23. */
  emptyByHour: number[];
  /** Fans (conversations) who wrote in an empty hour. */
  fans: number;
  /** Of them: paid on the page in the 30 days before `to`. */
  payers: number;
  /** Of them: waited more than an hour for a personal reply after a message in an empty hour (or still wait). */
  waitedOverHour: number;
  /** The 30-day net of those who waited. */
  waitedNetMills: number;
}

/**
 * Empty hours of each page in [from, to) (§В). An hour is empty when fans wrote
 * in it and no chatter had the extension open on the page in any of its
 * minutes (`chatter_activity_minutes`, week 1). Counting starts at the page's
 * first minute in the extension: before it Hub cannot tell an empty hour from
 * one worked outside the extension. A reply is the page's next message that is
 * not a Fansly mass message.
 */
export async function listEmptyHours(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<PageEmptyHoursRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all" ? sql`true` : sql`p.id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    page_id: string | number; label: string; platform: string; since: Date | string | null; hours_with_fans: string | number;
    empty_hours: string | number; by_hour: Array<string | number>; fans: string | number; payers: string | number;
    waited: string | number; waited_net: string | number;
  }>(sql`
    with scope as (
      select p.id, p.label, p.platform from pages p where ${pageFilter}
    ),
    since as (
      select c.page_id, min(c.minute) as since
      from chatter_activity_minutes c
      where c.page_id in (select id from scope)
      group by 1
    ),
    fan_msgs as (
      select m.account_id as page_id, m.conversation_ref as conv, m.occurred_at as at, date_trunc('hour', m.occurred_at) as hour
      from message_archive m
      join since x on x.page_id = m.account_id
      where not m.is_sent_by_me and m.conversation_ref is not null
        and m.occurred_at >= greatest(${from}, date_trunc('hour', x.since)) and m.occurred_at < ${to}
    ),
    hours as (
      select h.page_id, h.hour,
        not exists (
          select 1 from chatter_activity_minutes c
          where c.page_id = h.page_id and c.minute >= h.hour and c.minute < h.hour + interval '1 hour'
        ) as empty
      from (select distinct page_id, hour from fan_msgs) h
    ),
    waits as (
      select distinct on (f.page_id, f.conv, f.hour) f.page_id, f.conv, f.at
      from fan_msgs f
      join hours h on h.page_id = f.page_id and h.hour = f.hour
      where h.empty
      order by f.page_id, f.conv, f.hour, f.at
    ),
    fans as (
      select w.page_id, w.conv,
        bool_or(coalesce((
          select min(o.occurred_at) from message_archive o
          where o.account_id = w.page_id and o.conversation_ref = w.conv and o.is_sent_by_me
            and coalesce(o.message_type, 1) <> 2 and o.occurred_at > w.at
        ), ${to}) - w.at > interval '1 hour') as waited
      from waits w
      group by 1, 2
    ),
    spent as (
      select fa.page_id, fa.waited,
        coalesce((
          select sum(t.creator_net_amount_mills)
          from page_dm_threads th
          join transactions t on t.fan_id = th.fan_id and t.platform_account_id = th.platform_account_id
          where th.platform_account_id = fa.page_id and th.platform_conversation_id = fa.conv
            and t.is_active and t.gross_amount_mills > 0 and t.canonical_type in ${SALE_TYPES}
            and t.occurred_at >= ${to} - interval '30 days' and t.occurred_at < ${to}
        ), 0) as net
      from fans fa
    )
    select s.id as page_id, s.label, s.platform, x.since,
      (select count(*) from hours h where h.page_id = s.id) as hours_with_fans,
      (select count(*) from hours h where h.page_id = s.id and h.empty) as empty_hours,
      (select array_agg(z.n order by z.hod) from (
        select hod, (
          select count(*) from hours h
          where h.page_id = s.id and h.empty and extract(hour from h.hour at time zone 'Europe/Moscow') = hod
        ) as n
        from generate_series(0, 23) hod
      ) z) as by_hour,
      (select count(*) from spent sp where sp.page_id = s.id) as fans,
      (select count(*) from spent sp where sp.page_id = s.id and sp.net > 0) as payers,
      (select count(*) from spent sp where sp.page_id = s.id and sp.waited) as waited,
      (select coalesce(sum(sp.net), 0) from spent sp where sp.page_id = s.id and sp.waited) as waited_net
    from scope s
    left join since x on x.page_id = s.id
    where x.since is not null or exists (
      select 1 from message_archive m
      where m.account_id = s.id and not m.is_sent_by_me and m.occurred_at >= ${from} and m.occurred_at < ${to}
    )
    order by s.label`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    shiftsSince: row.since === null ? null : new Date(row.since),
    hoursWithFans: Number(row.hours_with_fans),
    emptyHours: Number(row.empty_hours),
    emptyByHour: row.by_hour.map(Number),
    fans: Number(row.fans),
    payers: Number(row.payers),
    waitedOverHour: Number(row.waited),
    waitedNetMills: Number(row.waited_net),
  }));
}
