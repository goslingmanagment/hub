import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The morning report's team block (Chat Memory week 5,
// docs/plans/2026-10-24-chat-memory/week-5.md §3): what waits for the owner.

export interface PageWaitingRow {
  pageLabel: string;
  /** Chats whose last message (a Fansly mass message is not one) is the fan's, between `maxDays` and `minWaitHours` old. */
  waiting: number;
  /** Of them, fans who ever paid on the page. */
  payers: number;
}

export async function listFansWaitingSince(
  db: Database,
  input: { now: Date; minWaitHours: number; maxDays: number },
): Promise<PageWaitingRow[]> {
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const result = await db.execute<{ label: string; waiting: string | number; payers: string | number }>(sql`
    with last_message as (
      select distinct on (m.account_id, m.conversation_ref) m.account_id, m.is_sent_by_me, m.occurred_at, m.fan_native_id
      from message_archive m
      where m.occurred_at > ${now} - make_interval(days => ${input.maxDays}) and m.occurred_at <= ${now}
        and (not m.is_sent_by_me or coalesce(m.message_type, 1) <> 2) and m.deleted_at is null
      order by m.account_id, m.conversation_ref, m.occurred_at desc
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
