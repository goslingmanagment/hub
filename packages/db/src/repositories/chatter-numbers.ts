import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notOwnAccountChatSql, seenMessageSql } from "./shift-sql.ts";

// The fans of one chatter's shift for «Смены» (Chat Memory week 5, 0305/0306,
// docs/plans/2026-10-24-chat-memory/week-5.md §1): whom the chatter wrote to,
// and who of them paid. Only messages with this chatter as their author
// (client_send_attributions) count, and only ones the fan could see (a message
// deleted within `deletedUnseenSeconds` of being sent nobody saw). A chat with
// another page of ours is no fan's (`notOwnAccountChatSql`). The shift's other
// numbers — messages, replies, the fans left without an answer, PPV — are the
// review's (apps/runtime services/chatter-numbers.ts). Database only.

export interface ShiftFansRow {
  /** The fans the chatter wrote to, as `<page id>:<fan ref>` (a week counts each once). */
  writtenFans: string[];
  /** Of them: paid on the page after the chatter's first message to them in the shift, before its end. */
  paidFans: string[];
}

export async function readShiftFans(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date; deletedUnseenSeconds: number },
): Promise<ShiftFansRow> {
  if (input.pageIds.length === 0) return { writtenFans: [], paidFans: [] };
  const pages = sql`${sql.param(input.pageIds.map(String))}::bigint[]`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{ written_fans: string[] | null; paid_fans: string[] | null }>(sql`
    with written as (
      select a.page_id, a.fan_ref, min(a.observed_at) as first_at
      from client_send_attributions a
      left join message_archive m on m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
      where a.user_id = ${input.userId} and a.page_id = any(${pages})
        and a.observed_at >= ${from} and a.observed_at < ${to} and a.fan_ref is not null
        and ${seenMessageSql("m", input.deletedUnseenSeconds)}
        and ${notOwnAccountChatSql({ pageId: "a.page_id", platform: "a.platform", conv: "a.conversation_ref", fan: "a.fan_ref" })}
      group by 1, 2
    ),
    paid as (
      select w.* from written w
      where exists (
        select 1 from transactions t join fans fp on fp.id = t.fan_id
        where t.platform_account_id = w.page_id and fp.platform_user_id = w.fan_ref
          and t.is_active and t.gross_amount_mills > 0
          and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
          and t.occurred_at >= w.first_at and t.occurred_at < ${to})
    )
    select
      (select array_agg(page_id::text || ':' || fan_ref) from written) as written_fans,
      (select array_agg(page_id::text || ':' || fan_ref) from paid) as paid_fans`);
  const row = result.rows[0]!;
  return { writtenFans: row.written_fans ?? [], paidFans: row.paid_fans ?? [] };
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
