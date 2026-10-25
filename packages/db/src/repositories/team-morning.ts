import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { AWAITING_MASS_MIN_CHATS } from "./spender-stats.ts";

// The morning report's team block (Chat Memory week 5,
// docs/plans/2026-10-24-chat-memory/week-5.md §3): what waits for the owner.

export interface PageWaitingRow {
  pageLabel: string;
  /** Chats whose last message (a mass message is not one) is the fan's, between `maxDays` and `minWaitHours` old. */
  waiting: number;
  /** Of them, fans who ever paid on the page. */
  payers: number;
}

export async function listFansWaitingSince(
  db: Database,
  input: { now: Date; minWaitHours: number; maxDays: number },
): Promise<PageWaitingRow[]> {
  const now = sql`${input.now.toISOString()}::timestamptz`;
  // Every page's id: the archive's (account_id, occurred_at) index serves the window, not a scan of it.
  const pageIds = (await db.execute<{ id: string | number }>(sql`select id from pages where deleted_at is null`)).rows.map((row) => String(row.id));
  if (pageIds.length === 0) return [];
  // A mass message answers nobody: a Fansly one, or one text (with its price and files) to
  // AWAITING_MASS_MIN_CHATS or more chats of the page in its clock hour — how OnlyMonster's look
  // (review 2026-10-25: an OnlyFans mass message took a fan off the night's list).
  const result = await db.execute<{ label: string; waiting: string | number; payers: string | number }>(sql`
    with window_messages as (
      select m.account_id, m.conversation_ref, m.is_sent_by_me, m.occurred_at, m.fan_native_id,
        coalesce(m.message_type, 1) = 2 as fansly_mass,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|'
          || jsonb_array_length(m.media_metadata)::text) as shape
      from message_archive m
      where m.account_id = any(${sql.param(pageIds)}::bigint[])
        and m.occurred_at > ${now} - make_interval(days => ${input.maxDays}) and m.occurred_at <= ${now}
        and m.deleted_at is null
    ),
    bursts as (
      select account_id, shape, date_trunc('hour', occurred_at) as hour
      from window_messages
      where is_sent_by_me and not fansly_mass
      group by 1, 2, 3
      having count(distinct conversation_ref) >= ${AWAITING_MASS_MIN_CHATS}
    ),
    last_message as (
      select distinct on (w.account_id, w.conversation_ref) w.account_id, w.is_sent_by_me, w.occurred_at, w.fan_native_id
      from window_messages w
      where not w.is_sent_by_me
        or (not w.fansly_mass and not exists (
          select 1 from bursts b
          where b.account_id = w.account_id and b.shape = w.shape and b.hour = date_trunc('hour', w.occurred_at)
        ))
      order by w.account_id, w.conversation_ref, w.occurred_at desc
    )
    select p.label, count(*) as waiting,
      count(*) filter (where exists (
        select 1 from fans f join fan_spend_lifetime s on s.fan_id = f.id and s.platform_account_id = l.account_id
        where f.platform = p.platform and f.platform_user_id = l.fan_native_id and s.gross_amount_mills > 0)) as payers
    from last_message l
    join pages p on p.id = l.account_id
    where not l.is_sent_by_me and l.occurred_at <= ${now} - make_interval(hours => ${input.minWaitHours})
    group by p.label
    order by 2 desc, 1`);
  return result.rows.map((row) => ({ pageLabel: row.label, waiting: Number(row.waiting), payers: Number(row.payers) }));
}
