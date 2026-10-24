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
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.account_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
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
