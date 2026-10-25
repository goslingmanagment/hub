import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

// Chat Memory week 6, «Покрытие» (docs/plans/2026-10-24-chat-memory/week-6.md
// §В–Г): read-only analytics over what Hub already holds. Money is net
// (`creator_net_amount_mills`) of sales a fan paid, as in the shift report.

const SALE_TYPES = sql`('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')`;
/** A purchase after a greeting or a broadcast: anything but a subscription. */
const PURCHASE_TYPES = sql`('tip', 'message_purchase', 'post_purchase', 'stream_tip')`;

function pageFilterOf(pages: "all" | readonly number[]): SQL {
  return pages === "all" ? sql`true` : sql`p.id = any(${sql.param(pages.map(String))}::bigint[])`;
}

/**
 * CTEs over the pages in `scope`: their outgoing messages in [from, to) with a
 * shape (text, price, number of files), the bursts among them — one shape to
 * `burstMinFans` or more chats of the page within a clock hour, how
 * OnlyMonster's mass messages look, as in «Авторы» (message-authorship.ts) —
 * and the ids of the burst messages.
 */
function outgoingCtes(input: { from: SQL; to: SQL; burstMinFans: number }): SQL {
  return sql`
    outgoing as materialized (
      select m.id, m.account_id as page_id, m.platform, m.message_ref, m.conversation_ref as conv, m.occurred_at as at,
        m.message_type, m.price_mills, jsonb_array_length(m.media_metadata) as files,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|' || jsonb_array_length(m.media_metadata)::text) as shape
      from message_archive m
      join scope s on s.id = m.account_id
      where m.is_sent_by_me and m.occurred_at >= ${input.from} and m.occurred_at < ${input.to}
    ),
    bursts as materialized (
      select page_id, shape, date_trunc('hour', at) as hour
      from outgoing
      where coalesce(message_type, 1) <> 2
      group by 1, 2, 3
      having count(distinct conv) >= ${input.burstMinFans}
    ),
    burst_rows as materialized (
      select o.id from outgoing o
      join bursts b on b.page_id = o.page_id and b.shape = o.shape and b.hour = date_trunc('hour', o.at)
    )`;
}

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
  const pageFilter = pageFilterOf(input.pages);
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

export interface PageGreetingsRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  /** Subscriptions that started in [from, to) (the start Hub holds for the fan's subscription on the page). */
  newSubscribers: number;
  /** Of them: the page wrote within 2 minutes of the subscription — an automatic welcome, not a person. */
  autoWelcomed: number;
  /** Of them: a personal message (not a mass message, not a burst) 2 minutes to 24 hours after the subscription. */
  greeted: number;
  /** Median seconds from the subscription to that greeting. */
  greetingMedianSeconds: number | null;
  /** Of `greeted`: the fan wrote within an hour after the greeting. */
  repliedWithinHour: number;
  /** Bought anything but a subscription on the page within 7 days of subscribing: greeted, not greeted. */
  boughtGreeted: number;
  boughtNotGreeted: number;
  /** Subscribed less than 7 days before `to`: their 7 days are not over yet. */
  recent: number;
}

/**
 * Greetings of new subscribers (§Г). The fan's conversation is the page's DM
 * thread with them; a message within 2 minutes of the subscription is the
 * page's automatic welcome (no person answers that fast), so the greeting is
 * the first personal message from 2 minutes to 24 hours after it.
 */
export async function listGreetings(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[]; burstMinFans: number },
): Promise<PageGreetingsRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    page_id: string | number; label: string; platform: string; subs: string | number; auto: string | number; greeted: string | number;
    median_s: string | number | null; replied: string | number; bought_greeted: string | number; bought_not: string | number; recent: string | number;
  }>(sql`
    with scope as (
      select p.id, p.label, p.platform from pages p where ${pageFilterOf(input.pages)}
    ),
    ${outgoingCtes({ from, to, burstMinFans: input.burstMinFans })},
    subs as (
      select s.platform_account_id as page_id, s.fan_id, s.source_created_at as sub_at, (
        select th.platform_conversation_id from page_dm_threads th
        where th.platform_account_id = s.platform_account_id and th.fan_id = s.fan_id
        order by th.last_message_at desc nulls last limit 1
      ) as conv
      from page_subscriptions s
      join scope sc on sc.id = s.platform_account_id
      where s.source_created_at >= ${from} and s.source_created_at < ${to}
    ),
    greetings as (
      select su.*,
        exists (
          select 1 from message_archive m
          where m.account_id = su.page_id and m.conversation_ref = su.conv and m.is_sent_by_me
            and m.occurred_at >= su.sub_at - interval '10 seconds' and m.occurred_at < su.sub_at + interval '2 minutes'
        ) as auto,
        (
          select min(m.occurred_at) from message_archive m
          where m.account_id = su.page_id and m.conversation_ref = su.conv and m.is_sent_by_me and coalesce(m.message_type, 1) <> 2
            and m.occurred_at >= su.sub_at + interval '2 minutes' and m.occurred_at < su.sub_at + interval '24 hours'
            and m.id not in (select id from burst_rows)
        ) as greet_at
      from subs su
    ),
    facts as (
      select g.*,
        g.greet_at is not null and exists (
          select 1 from message_archive f
          where f.account_id = g.page_id and f.conversation_ref = g.conv and not f.is_sent_by_me
            and f.occurred_at > g.greet_at and f.occurred_at <= g.greet_at + interval '1 hour'
        ) as replied,
        exists (
          select 1 from transactions t
          where t.fan_id = g.fan_id and t.platform_account_id = g.page_id and t.is_active and t.gross_amount_mills > 0
            and t.canonical_type in ${PURCHASE_TYPES}
            and t.occurred_at >= g.sub_at and t.occurred_at < g.sub_at + interval '7 days'
        ) as bought
      from greetings g
    )
    select s.id as page_id, s.label, s.platform,
      count(*) as subs,
      count(*) filter (where f.auto) as auto,
      count(f.greet_at) as greeted,
      percentile_disc(0.5) within group (order by extract(epoch from f.greet_at - f.sub_at)::bigint) as median_s,
      count(*) filter (where f.replied) as replied,
      count(*) filter (where f.bought and f.greet_at is not null) as bought_greeted,
      count(*) filter (where f.bought and f.greet_at is null) as bought_not,
      count(*) filter (where f.sub_at > ${to} - interval '7 days') as recent
    from facts f
    join scope s on s.id = f.page_id
    group by s.id, s.label, s.platform
    order by s.label`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    newSubscribers: Number(row.subs),
    autoWelcomed: Number(row.auto),
    greeted: Number(row.greeted),
    greetingMedianSeconds: row.median_s === null ? null : Number(row.median_s),
    repliedWithinHour: Number(row.replied),
    boughtGreeted: Number(row.bought_greeted),
    boughtNotGreeted: Number(row.bought_not),
    recent: Number(row.recent),
  }));
}

export interface BroadcastRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  /** The first delivery of this text on this Moscow day. */
  sentAt: Date;
  /** The start of the text. */
  preview: string;
  priceMills: number | null;
  files: number;
  /** A Fansly mass message; otherwise one text to many chats within an hour. */
  massMessage: boolean;
  /** Chats it went to (a chat that got it twice counts twice). */
  deliveries: number;
  /** The fan wrote within 24 hours after it. */
  replied: number;
  /** The fan bought anything but a subscription on the page within 7 days after it. */
  bought: number;
  /** A priced one: the fan bought it (Hub links the purchase to the message, or a message purchase at its price within 7 days). */
  ppvBought: number;
}

/**
 * Broadcasts in [from, to) (§Г): Fansly mass messages and bursts, one row per
 * page, text and Moscow day, newest first.
 */
export async function listBroadcasts(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[]; burstMinFans: number },
): Promise<BroadcastRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    page_id: string | number; label: string; platform: string; sent_at: Date | string; preview: string | null; price_mills: string | number | null;
    files: string | number; mass: boolean; deliveries: string | number; replied: string | number; bought: string | number; ppv_bought: string | number;
  }>(sql`
    with scope as (
      select p.id, p.label, p.platform from pages p where ${pageFilterOf(input.pages)}
    ),
    ${outgoingCtes({ from, to, burstMinFans: input.burstMinFans })},
    casts as materialized (
      select o.*, coalesce(o.message_type, 1) = 2 as mass
      from outgoing o
      where o.message_type = 2 or o.id in (select id from burst_rows)
    ),
    deliveries as (
      select c.*,
        exists (
          select 1 from message_archive f
          where f.account_id = c.page_id and f.conversation_ref = c.conv and not f.is_sent_by_me
            and f.occurred_at > c.at and f.occurred_at <= c.at + interval '24 hours'
        ) as replied,
        exists (
          select 1 from page_dm_threads th
          join transactions t on t.fan_id = th.fan_id and t.platform_account_id = th.platform_account_id
          where th.platform_account_id = c.page_id and th.platform_conversation_id = c.conv
            and t.is_active and t.gross_amount_mills > 0 and t.canonical_type in ${PURCHASE_TYPES}
            and t.occurred_at >= c.at and t.occurred_at < c.at + interval '7 days'
        ) as bought,
        coalesce(c.price_mills, 0) > 0 and (
          (c.platform = 'fansly' and (
            exists (select 1 from message_media_offers mo where mo.page_id = c.page_id and mo.message_ref = c.message_ref and mo.purchase_state = 'purchased')
            or exists (select 1 from media_orders mo where mo.page_id = c.page_id and mo.message_ref = c.message_ref)))
          or (c.platform = 'onlyfans' and exists (
            select 1 from page_dm_messages d
            where d.platform_account_id = c.page_id and d.platform_message_id = c.message_ref and d.purchased_at is not null))
          or exists (
            select 1 from page_dm_threads th
            join transactions t on t.fan_id = th.fan_id and t.platform_account_id = th.platform_account_id
            where th.platform_account_id = c.page_id and th.platform_conversation_id = c.conv
              and t.is_active and t.canonical_type = 'message_purchase' and t.gross_amount_mills = c.price_mills
              and t.occurred_at >= c.at and t.occurred_at < c.at + interval '7 days')
        ) as ppv_bought
      from casts c
    ),
    groups as (
      select page_id, shape, (at at time zone 'Europe/Moscow')::date as day,
        min(at) as sent_at, (array_agg(id order by at))[1] as first_id,
        max(price_mills) as price_mills, max(files) as files, bool_or(mass) as mass,
        count(*) as deliveries,
        count(*) filter (where replied) as replied,
        count(*) filter (where bought) as bought,
        count(*) filter (where ppv_bought) as ppv_bought
      from deliveries
      group by 1, 2, 3
    )
    select g.page_id, s.label, s.platform, g.sent_at, left(m.text_plain, 120) as preview, g.price_mills, g.files, g.mass,
      g.deliveries, g.replied, g.bought, g.ppv_bought
    from groups g
    join scope s on s.id = g.page_id
    join message_archive m on m.id = g.first_id
    order by g.sent_at desc`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    sentAt: new Date(row.sent_at),
    preview: row.preview ?? "",
    priceMills: row.price_mills === null || Number(row.price_mills) === 0 ? null : Number(row.price_mills),
    files: Number(row.files),
    massMessage: row.mass,
    deliveries: Number(row.deliveries),
    replied: Number(row.replied),
    bought: Number(row.bought),
    ppvBought: Number(row.ppv_bought),
  }));
}
