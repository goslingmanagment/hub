import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// How many of a page's outgoing messages have an author (Chat Memory week 1,
// docs/plans/2026-10-24-chat-memory/plan.md §1, «Доля без автора»).
//
// A PERSONAL outgoing message: sent by the page (`message_archive.is_sent_by_me`),
// not a Fansly mass message (`message_type = 2`), and not part of a burst — the
// same text with the same price and the same number of files sent to
// `burstMinFans` or more chats of the page within one clock hour (how
// OnlyMonster's mass messages look: OnlyFans' webhook carries no mark of one).
// Its author is the client_send_attributions row under the archive's own key
// (platform, page, platform message id). «In a shift»: some chatter had the
// extension open on the page in the message's minute (chatter_activity_minutes).

export interface PageAuthorshipDayRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  /** The business day (Moscow), YYYY-MM-DD. */
  day: string;
  personal: number;
  authored: number;
  inShift: number;
  inShiftAuthored: number;
}

/** Personal outgoing messages per page and Moscow day in [from, to), with and without an author. */
export async function listPageAuthorshipDays(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[]; burstMinFans: number },
): Promise<PageAuthorshipDayRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  // "all" is every page's id, never no filter: the archive's (account_id, occurred_at) index then
  // serves the window instead of a scan of the whole archive (review 2026-10-25: ~1 s on 1M rows).
  const pageIds = input.pages === "all"
    ? (await db.execute<{ id: string | number }>(sql`select id from pages where deleted_at is null`)).rows.map((row) => String(row.id))
    : input.pages.map(String);
  if (pageIds.length === 0) return [];
  const pageFilter = sql`m.account_id = any(${sql.param(pageIds)}::bigint[])`;
  const result = await db.execute<{
    page_id: string | number; page_label: string; platform: string; day: string; personal: string | number; authored: string | number;
    in_shift: string | number; in_shift_authored: string | number;
  }>(sql`
    with outgoing as (
      select m.account_id as page_id, m.platform, m.message_ref, m.occurred_at, m.conversation_ref,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|'
          || jsonb_array_length(m.media_metadata)::text) as shape
      from message_archive m
      where m.is_sent_by_me
        and m.occurred_at >= ${input.from.toISOString()}::timestamptz and m.occurred_at < ${input.to.toISOString()}::timestamptz
        and coalesce(m.message_type, 1) <> 2
        and ${pageFilter}
    ),
    bursts as (
      select page_id, shape, date_trunc('hour', occurred_at) as hour
      from outgoing
      group by 1, 2, 3
      having count(distinct conversation_ref) >= ${input.burstMinFans}
    ),
    personal as (
      select o.*,
        exists (
          select 1 from client_send_attributions a
          where a.platform = o.platform and a.page_id = o.page_id and a.platform_message_id = o.message_ref
        ) as authored,
        exists (
          select 1 from chatter_activity_minutes c
          where c.page_id = o.page_id and c.minute = date_trunc('minute', o.occurred_at)
        ) as in_shift
      from outgoing o
      where not exists (
        select 1 from bursts b
        where b.page_id = o.page_id and b.shape = o.shape and b.hour = date_trunc('hour', o.occurred_at)
      )
    )
    select x.*, p.label as page_label, p.platform
    from (
      select page_id, to_char(occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day,
        count(*) as personal,
        count(*) filter (where authored) as authored,
        count(*) filter (where in_shift) as in_shift,
        count(*) filter (where in_shift and authored) as in_shift_authored
      from personal
      group by 1, 2
    ) x
    join pages p on p.id = x.page_id
    order by x.page_id, x.day`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    day: row.day,
    personal: Number(row.personal),
    authored: Number(row.authored),
    inShift: Number(row.in_shift),
    inShiftAuthored: Number(row.in_shift_authored),
  }));
}

/** Messages with an author per page and person in [from, to). */
export async function listPageAuthors(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<Array<{ pageId: number; pageLabel: string; platform: string; userId: number; username: string; messages: number }>> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`a.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{
    page_id: string | number; page_label: string; platform: string; user_id: string | number; username: string; messages: string | number;
  }>(sql`
    select a.page_id, p.label as page_label, p.platform, a.user_id, u.username, count(*) as messages
    from client_send_attributions a
    join users u on u.id = a.user_id
    join pages p on p.id = a.page_id
    where a.observed_at >= ${input.from.toISOString()}::timestamptz and a.observed_at < ${input.to.toISOString()}::timestamptz
      and ${pageFilter}
    group by 1, 2, 3, 4, 5
    order by 1, 6 desc`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    userId: Number(row.user_id),
    username: row.username,
    messages: Number(row.messages),
  }));
}

/** One login's authored messages to one fan on one page, in one shift of theirs (`shiftId` null: outside any). */
export interface FanAuthorshipShiftRow {
  userId: number;
  username: string;
  shiftId: number | null;
  /** The shift's bounds; outside a shift, the first and the last message. */
  startedAt: Date;
  endedAt: Date;
  firstAt: Date;
  lastAt: Date;
  messages: number;
  priced: number;
}

/**
 * «Кто с ним работал» (products package M): the authored outgoing messages to a fan on a page, by login and by the
 * login's shift they fell in. One range of `client_send_attributions_fan` (page_id, fan_ref) and, per message, one
 * probe of `shifts_user_start`; a fan's whole history is a few hundred rows (production 2026-11-15: at most ~1 200
 * messages to one fan on a page, 42 000 in all).
 */
export async function listFanAuthorshipShifts(
  db: Database,
  input: { pageId: number; fanRef: string },
): Promise<FanAuthorshipShiftRow[]> {
  const result = await db.execute<{
    user_id: string | number; username: string; shift_id: string | number | null; started_at: Date | string; ended_at: Date | string;
    first_at: Date | string; last_at: Date | string; messages: string | number; priced: string | number;
  }>(sql`
    with sent as (
      select a.user_id, a.observed_at, a.priced
      from client_send_attributions a
      where a.page_id = ${input.pageId} and a.fan_ref = ${input.fanRef}
    ),
    placed as (
      select s.user_id, s.observed_at, s.priced, x.id as shift_id, x.started_at, x.ended_at
      from sent s
      left join lateral (
        select h.id, h.started_at, h.ended_at
        from shifts h
        where h.user_id = s.user_id and h.state in ('going', 'closed')
          and h.started_at <= s.observed_at and h.ended_at >= s.observed_at
        order by h.started_at desc
        limit 1
      ) x on true
    )
    select p.user_id, u.username, p.shift_id,
      coalesce(min(p.started_at), min(p.observed_at)) as started_at,
      coalesce(max(p.ended_at), max(p.observed_at)) as ended_at,
      min(p.observed_at) as first_at, max(p.observed_at) as last_at,
      count(*) as messages, count(*) filter (where p.priced) as priced
    from placed p
    join users u on u.id = p.user_id
    group by p.user_id, u.username, p.shift_id
    order by max(p.observed_at) desc`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    username: row.username,
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    firstAt: new Date(row.first_at),
    lastAt: new Date(row.last_at),
    messages: Number(row.messages),
    priced: Number(row.priced),
  }));
}
