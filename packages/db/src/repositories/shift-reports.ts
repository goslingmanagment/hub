import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The draft shift report (Chat Memory week 4, 0311,
// docs/plans/2026-10-24-chat-memory/week-4.md §2): the sales of a shift and
// their facts, the chatters' marks, confirmed reports, disputes and the payout
// export. Hub lists and counts; the marks are the people's.

export interface ShiftSale {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  fanId: number | null;
  fanRef: string | null;
  fanName: string | null;
  kind: string;
  grossMills: number;
  netMills: number;
  occurredAt: Date;
}

/** Sales on the pages in [from, to): money a fan paid (no refund, chargeback or reversal), oldest first. */
export async function listShiftSales(
  db: Database,
  input: { pageIds: readonly number[]; from: Date; to: Date },
): Promise<ShiftSale[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{
    id: string | number; page_id: string | number; label: string; platform: string; fan_id: string | number | null;
    fan_ref: string | null; fan_name: string | null; kind: string; gross: string | number; net: string | number; occurred_at: Date | string;
  }>(sql`
    select t.id, t.platform_account_id as page_id, p.label, p.platform, t.fan_id, f.platform_user_id as fan_ref,
      coalesce(f.display_name, f.username) as fan_name, t.canonical_type::text as kind, t.gross_amount_mills as gross, t.creator_net_amount_mills as net, t.occurred_at
    from transactions t
    join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    where t.platform_account_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      and t.is_active and t.gross_amount_mills > 0
      and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
      and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz
    order by t.occurred_at, t.id`);
  return result.rows.map((row) => ({
    transactionId: Number(row.id),
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    fanId: row.fan_id === null ? null : Number(row.fan_id),
    fanRef: row.fan_ref,
    fanName: row.fan_name,
    kind: row.kind,
    grossMills: Number(row.gross),
    netMills: Number(row.net),
    occurredAt: new Date(row.occurred_at),
  }));
}

export interface SaleFacts {
  transactionId: number;
  /** Who sent the PPV the fan bought, when Hub can tell (its message has an author). */
  ppvSender: { userId: number; username: string } | null;
  /** The PPV message was found but has no author (sent from a phone, another browser, an old client). */
  ppvWithoutAuthor: boolean;
  /** Who wrote to the fan on the page in the 48 hours before the sale, most messages first. */
  writers: Array<{ userId: number; username: string; messages: number }>;
  /** Personal messages to the fan in those 48 hours with no author. */
  withoutAuthor: number;
}

/**
 * The facts of each sale. The PPV a purchase paid for: on Fansly the page's
 * message that carried the bought media or bundle to that fan (the latest
 * before the purchase); on OnlyFans the message the fan unlocked within three
 * minutes of the purchase. Its author is week 1's (client_send_attributions).
 */
export async function listSaleFacts(db: Database, input: { transactionIds: readonly number[] }): Promise<SaleFacts[]> {
  if (input.transactionIds.length === 0) return [];
  const result = await db.execute<{
    id: string | number; ppv_user_id: string | number | null; ppv_username: string | null; ppv_message_ref: string | null;
    writers: Array<{ user_id: number; username: string; messages: number }> | null; written: string | number; outgoing: string | number;
  }>(sql`
    with sales as (
      select t.id, t.platform_account_id as page_id, p.platform, t.canonical_type::text as kind, t.correlation_id, t.occurred_at,
        f.platform_user_id as fan_ref, t.fan_id
      from transactions t
      join pages p on p.id = t.platform_account_id
      left join fans f on f.id = t.fan_id
      where t.id = any(${sql.param(input.transactionIds.map(String))}::bigint[])
    ),
    chats as (
      select s.id, coalesce(
        array_agg(th.platform_conversation_id) filter (where th.platform_conversation_id is not null),
        array[]::text[]
      ) || case when s.platform = 'onlyfans' and s.fan_ref is not null then array[s.fan_ref] else array[]::text[] end as refs
      from sales s
      left join page_dm_threads th on th.platform_account_id = s.page_id and th.fan_id = s.fan_id
      group by s.id, s.platform, s.fan_ref
    ),
    ppv as (
      select s.id,
        case
          when s.kind <> 'message_purchase' then null
          when s.platform = 'fansly' then (
            select mo.message_ref from message_media_offers mo
            where mo.page_id = s.page_id and mo.fan_platform_user_id = s.fan_ref
              and (mo.media_offer_ref = s.correlation_id or mo.bundle_ref = s.correlation_id)
              and coalesce(mo.message_created_at, s.occurred_at) <= s.occurred_at
            order by mo.message_created_at desc nulls last limit 1)
          else (
            select m.platform_message_id from page_dm_messages m
            join page_dm_threads th on th.id = m.conversation_id
            where th.platform_account_id = s.page_id and th.platform_conversation_id = s.fan_ref
              and m.purchased_at between s.occurred_at - interval '3 minutes' and s.occurred_at + interval '3 minutes'
            order by abs(extract(epoch from m.purchased_at - s.occurred_at)) limit 1)
        end as message_ref
      from sales s
    )
    select s.id, a.user_id as ppv_user_id, u.username as ppv_username, ppv.message_ref as ppv_message_ref,
      (
        select json_agg(json_build_object('user_id', w.user_id, 'username', w.username, 'messages', w.messages) order by w.messages desc)
        from (
          select x.user_id, xu.username, count(*)::int as messages
          from client_send_attributions x join users xu on xu.id = x.user_id
          where x.page_id = s.page_id and x.fan_ref = s.fan_ref
            and x.observed_at > s.occurred_at - interval '48 hours' and x.observed_at <= s.occurred_at
          group by 1, 2
        ) w
      ) as writers,
      (select count(*) from client_send_attributions x
        where x.page_id = s.page_id and x.fan_ref = s.fan_ref
          and x.observed_at > s.occurred_at - interval '48 hours' and x.observed_at <= s.occurred_at) as written,
      (select count(*) from message_archive m, chats c
        where c.id = s.id and m.account_id = s.page_id and m.conversation_ref = any(c.refs)
          and m.is_sent_by_me and coalesce(m.message_type, 1) <> 2
          and m.occurred_at > s.occurred_at - interval '48 hours' and m.occurred_at <= s.occurred_at) as outgoing
    from sales s
    left join ppv on ppv.id = s.id
    left join client_send_attributions a on a.page_id = s.page_id and a.platform = s.platform and a.platform_message_id = ppv.message_ref
    left join users u on u.id = a.user_id`);
  return result.rows.map((row) => ({
    transactionId: Number(row.id),
    ppvSender: row.ppv_user_id === null ? null : { userId: Number(row.ppv_user_id), username: row.ppv_username ?? "" },
    ppvWithoutAuthor: row.ppv_message_ref !== null && row.ppv_user_id === null,
    writers: (row.writers ?? []).map((writer) => ({ userId: Number(writer.user_id), username: writer.username, messages: Number(writer.messages) })),
    withoutAuthor: Math.max(0, Number(row.outgoing) - Number(row.written)),
  }));
}

export type ShiftMark = "mine" | "share" | "not_mine";

export interface ShiftMarkRow {
  userId: number;
  username: string;
  transactionId: number;
  mark: ShiftMark;
  shareWithUserId: number | null;
  shareWithUsername: string | null;
  amountMills: number | null;
  note: string | null;
}

/** Every chatter's marks on these sales. */
export async function listShiftMarks(db: Database, input: { transactionIds: readonly number[] }): Promise<ShiftMarkRow[]> {
  if (input.transactionIds.length === 0) return [];
  const result = await db.execute<{
    user_id: string | number; username: string; transaction_id: string | number; mark: ShiftMark; share_with_user_id: string | number | null;
    share_username: string | null; amount_mills: string | number | null; note: string | null;
  }>(sql`
    select m.user_id, u.username, m.transaction_id, m.mark, m.share_with_user_id, s.username as share_username, m.amount_mills, m.note
    from shift_report_marks m
    join users u on u.id = m.user_id
    left join users s on s.id = m.share_with_user_id
    where m.transaction_id = any(${sql.param(input.transactionIds.map(String))}::bigint[])`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    username: row.username,
    transactionId: Number(row.transaction_id),
    mark: row.mark,
    shareWithUserId: row.share_with_user_id === null ? null : Number(row.share_with_user_id),
    shareWithUsername: row.share_username,
    amountMills: row.amount_mills === null ? null : Number(row.amount_mills),
    note: row.note,
  }));
}

export async function upsertShiftMark(
  db: Database,
  input: { userId: number; transactionId: number; pageId: number; mark: ShiftMark; shareWithUserId: number | null; amountMills: number | null; note: string | null },
): Promise<void> {
  await db.execute(sql`
    insert into shift_report_marks (user_id, transaction_id, page_id, mark, share_with_user_id, amount_mills, note)
    values (${input.userId}, ${input.transactionId}, ${input.pageId}, ${input.mark}, ${input.shareWithUserId}, ${input.amountMills}, ${input.note})
    on conflict (user_id, transaction_id) do update set
      mark = excluded.mark, share_with_user_id = excluded.share_with_user_id, amount_mills = excluded.amount_mills,
      note = excluded.note, marked_at = now()`);
}

export interface ConfirmedReportRow {
  id: number;
  startedAt: Date;
  endedAt: Date;
  confirmedAt: Date;
  creditedNetMills: number;
}

export async function listConfirmedReports(db: Database, input: { userId: number; since: Date }): Promise<ConfirmedReportRow[]> {
  const result = await db.execute<{ id: string | number; started_at: Date | string; ended_at: Date | string; confirmed_at: Date | string; credited_net_mills: string | number }>(sql`
    select id, started_at, ended_at, confirmed_at, credited_net_mills from shift_reports
    where user_id = ${input.userId} and started_at >= ${input.since.toISOString()}::timestamptz`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    confirmedAt: new Date(row.confirmed_at),
    creditedNetMills: Number(row.credited_net_mills),
  }));
}

/** Records a confirmed report with its lines as they stand; a shift confirmed before keeps its first report. */
export async function insertShiftReport(
  db: Database,
  input: {
    userId: number; startedAt: Date; endedAt: Date;
    lines: ReadonlyArray<{ transactionId: number; pageId: number; mark: ShiftMark; shareWithUserId: number | null; netMills: number; creditedMills: number; occurredAt: Date }>;
  },
): Promise<{ recorded: boolean; reportId: number | null }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const credited = input.lines.reduce((sum, line) => sum + line.creditedMills, 0);
    const inserted = await tx.execute<{ id: string | number }>(sql`
      insert into shift_reports (user_id, started_at, ended_at, credited_net_mills)
      values (${input.userId}, ${input.startedAt.toISOString()}::timestamptz, ${input.endedAt.toISOString()}::timestamptz, ${credited})
      on conflict (user_id, started_at) do nothing
      returning id`);
    const id = inserted.rows[0] ? Number(inserted.rows[0].id) : null;
    if (id === null) return { recorded: false, reportId: null };
    for (const line of input.lines) {
      await tx.execute(sql`
        insert into shift_report_lines (report_id, transaction_id, page_id, mark, share_with_user_id, net_mills, credited_mills, occurred_at)
        values (${id}, ${line.transactionId}, ${line.pageId}, ${line.mark}, ${line.shareWithUserId}, ${line.netMills},
          ${line.creditedMills}, ${line.occurredAt.toISOString()}::timestamptz)`);
    }
    return { recorded: true, reportId: id };
  });
}

export type ShiftDisputeReason = "two_mine" | "share_not_agreed";

export interface ShiftDisputeRow {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  fanRef: string | null;
  occurredAt: Date;
  netMills: number;
  /** Every chatter's mark on the sale. */
  marks: Array<{
    userId: number; username: string; mark: ShiftMark; shareWithUserId: number | null; shareWith: string | null; amountMills: number | null;
  }>;
  /** Why it is a dispute: two «моё», or a «делим с X» X did not answer with «делим» back. */
  reason: ShiftDisputeReason;
  /** The owner's decision, when made. */
  resolution: Array<{ userId: number; percent: number }> | null;
}

/**
 * Sales in [from, to) whose marks do not agree: two or more «моё», or «делим
 * с X» while X marked it otherwise or not at all. Resolved ones come too, with
 * the owner's decision.
 */
export async function listShiftDisputes(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<ShiftDisputeRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all" ? sql`true` : sql`m.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{
    transaction_id: string | number; page_id: string | number; label: string; platform: string; fan_ref: string | null;
    occurred_at: Date | string; net: string | number; reason: ShiftDisputeReason;
    marks: Array<{
      user_id: number; username: string; mark: ShiftMark; share_with_user_id: number | null; share_with: string | null; amount_mills: number | null;
    }>;
    shares: Array<{ userId: number; percent: number }> | null;
  }>(sql`
    with marked as (
      select m.transaction_id, m.user_id, m.mark, m.share_with_user_id
      from shift_report_marks m
      join transactions t on t.id = m.transaction_id
      where t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz
        and ${pageFilter}
    ),
    judged as (
      select a.transaction_id,
        case
          when count(*) filter (where a.mark = 'mine') >= 2 then 'two_mine'
          when bool_or(a.mark = 'share' and not exists (
            select 1 from marked b
            where b.transaction_id = a.transaction_id and b.user_id = a.share_with_user_id
              and b.mark = 'share' and b.share_with_user_id = a.user_id
          )) then 'share_not_agreed'
        end as reason
      from marked a
      group by a.transaction_id
    )
    select j.transaction_id, t.platform_account_id as page_id, p.label, p.platform, f.platform_user_id as fan_ref,
      t.occurred_at, t.creator_net_amount_mills as net, j.reason, r.shares,
      (select json_agg(json_build_object('user_id', m.user_id, 'username', u.username, 'mark', m.mark,
          'share_with_user_id', m.share_with_user_id, 'share_with', su.username, 'amount_mills', m.amount_mills) order by u.username)
        from shift_report_marks m join users u on u.id = m.user_id left join users su on su.id = m.share_with_user_id
        where m.transaction_id = j.transaction_id) as marks
    from judged j
    join transactions t on t.id = j.transaction_id
    join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    left join shift_report_resolutions r on r.transaction_id = j.transaction_id
    where j.reason is not null
    order by (r.transaction_id is null) desc, t.occurred_at desc`);
  return result.rows.map((row) => ({
    transactionId: Number(row.transaction_id),
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    fanRef: row.fan_ref,
    occurredAt: new Date(row.occurred_at),
    netMills: Number(row.net),
    marks: row.marks.map((mark) => ({
      userId: Number(mark.user_id), username: mark.username, mark: mark.mark,
      shareWithUserId: mark.share_with_user_id === null ? null : Number(mark.share_with_user_id), shareWith: mark.share_with,
      amountMills: mark.amount_mills === null ? null : Number(mark.amount_mills),
    })),
    reason: row.reason,
    resolution: row.shares === null ? null : row.shares.map((share) => ({ userId: Number(share.userId), percent: Number(share.percent) })),
  }));
}

export async function upsertShiftResolution(
  db: Database,
  input: { transactionId: number; pageId: number; shares: ReadonlyArray<{ userId: number; percent: number }>; userId: number },
): Promise<void> {
  await db.execute(sql`
    insert into shift_report_resolutions (transaction_id, page_id, shares, decided_by_user_id)
    values (${input.transactionId}, ${input.pageId}, ${JSON.stringify(input.shares)}::jsonb, ${input.userId})
    on conflict (transaction_id) do update set shares = excluded.shares, decided_by_user_id = excluded.decided_by_user_id, decided_at = now()`);
}

export interface ConfirmedLineRow {
  userId: number;
  username: string;
  pageId: number;
  pageLabel: string;
  platform: string;
  /** The Moscow date the shift started on: the payout sheet's column. */
  shiftDate: string;
  transactionId: number;
  netMills: number;
  creditedMills: number;
}

/** The lines of the reports confirmed for shifts that started in [from, to). */
export async function listConfirmedLines(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] },
): Promise<ConfirmedLineRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all" ? sql`true` : sql`l.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{
    user_id: string | number; username: string; page_id: string | number; label: string; platform: string; shift_date: string;
    transaction_id: string | number; net_mills: string | number; credited_mills: string | number;
  }>(sql`
    select r.user_id, u.username, l.page_id, p.label, p.platform,
      to_char(r.started_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as shift_date,
      l.transaction_id, l.net_mills, l.credited_mills
    from shift_reports r
    join shift_report_lines l on l.report_id = r.id
    join users u on u.id = r.user_id
    join pages p on p.id = l.page_id
    where r.started_at >= ${input.from.toISOString()}::timestamptz and r.started_at < ${input.to.toISOString()}::timestamptz
      and ${pageFilter}
    order by u.username, r.started_at, p.label`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    username: row.username,
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    shiftDate: row.shift_date,
    transactionId: Number(row.transaction_id),
    netMills: Number(row.net_mills),
    creditedMills: Number(row.credited_mills),
  }));
}

/** Who worked these pages (activity minutes) in [from, to): the people a sale can be shared with. */
export async function listPageWorkers(db: Database, input: { pageIds: readonly number[]; from: Date; to: Date }): Promise<Array<{ userId: number; username: string }>> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{ user_id: string | number; username: string }>(sql`
    select distinct m.user_id, u.username
    from chatter_activity_minutes m join users u on u.id = m.user_id
    where m.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      and m.minute >= ${input.from.toISOString()}::timestamptz and m.minute < ${input.to.toISOString()}::timestamptz
    order by u.username`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), username: row.username }));
}

/** Sales someone marked «делим с» this person, in [from, to). */
export async function listSharedWithMe(db: Database, input: { userId: number; from: Date; to: Date }): Promise<number[]> {
  const result = await db.execute<{ transaction_id: string | number }>(sql`
    select distinct m.transaction_id
    from shift_report_marks m join transactions t on t.id = m.transaction_id
    where m.share_with_user_id = ${input.userId}
      and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz`);
  return result.rows.map((row) => Number(row.transaction_id));
}

/** The sales by id, the same rows `listShiftSales` gives. */
export async function listSalesByIds(db: Database, transactionIds: readonly number[]): Promise<ShiftSale[]> {
  if (transactionIds.length === 0) return [];
  const result = await db.execute<{
    id: string | number; page_id: string | number; label: string; platform: string; fan_id: string | number | null;
    fan_ref: string | null; fan_name: string | null; kind: string; gross: string | number; net: string | number; occurred_at: Date | string;
  }>(sql`
    select t.id, t.platform_account_id as page_id, p.label, p.platform, t.fan_id, f.platform_user_id as fan_ref,
      coalesce(f.display_name, f.username) as fan_name, t.canonical_type::text as kind, t.gross_amount_mills as gross, t.creator_net_amount_mills as net, t.occurred_at
    from transactions t
    join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    where t.id = any(${sql.param(transactionIds.map(String))}::bigint[])
    order by t.occurred_at, t.id`);
  return result.rows.map((row) => ({
    transactionId: Number(row.id),
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    fanId: row.fan_id === null ? null : Number(row.fan_id),
    fanRef: row.fan_ref,
    fanName: row.fan_name,
    kind: row.kind,
    grossMills: Number(row.gross),
    netMills: Number(row.net),
    occurredAt: new Date(row.occurred_at),
  }));
}
