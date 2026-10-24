import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Win back (Chat Memory week 3, 0309, docs/plans/2026-10-24-chat-memory/week-3.md
// §2–3): who to win back on a page, the owner's approaches, a chatter's pick,
// and its results counted on read. Hub records and counts; it assigns nothing.

export type WinBackReason = "silent" | "expiring" | "new_unattended";

export interface WinBackRules {
  /** A payer whose last message is at least this old. */
  silentDays: number;
  /** A current subscription without renewal ending within this many days. */
  expiringDays: number;
  /** A subscription that started within this many days with no personal message since. */
  newDays: number;
  /** A fan someone picked an approach for within this many days is left out. */
  cooldownDays: number;
  /** A fan someone wrote to within this many minutes («в разговоре») is left out. */
  inConversationMinutes: number;
  limit: number;
}

export interface WinBackCandidate {
  fanId: number;
  fanRef: string;
  conversationRef: string | null;
  username: string | null;
  displayName: string | null;
  alias: string | null;
  lifetimeGrossMills: number;
  reason: WinBackReason;
  /** When the reason began: the fan's last message, the subscription's end, its start. */
  reasonAt: Date | null;
}

/**
 * The page's fans to win back now, most paid first, at most `limit`: one row
 * per fan with the most urgent reason (an ending subscription, then a new
 * subscriber nobody wrote to, then a silent payer). Fans «в разговоре» and fans
 * with an attempt within the cool-down are left out.
 */
export async function listWinBackCandidates(
  db: Database,
  input: { pageId: number; now: Date } & WinBackRules,
): Promise<WinBackCandidate[]> {
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const page = input.pageId;
  const result = await db.execute<{
    fan_id: string | number; fan_ref: string; conversation_ref: string | null; username: string | null;
    display_name: string | null; page_alias: string | null; gross: string | number; reason: WinBackReason; reason_at: Date | string | null;
  }>(sql`
    with fans_of_page as (
      select pf.fan_id, pf.page_alias, coalesce(l.gross_amount_mills, 0)::bigint as gross
      from page_fans pf
      join fans f on f.id = pf.fan_id and f.deleted_detected_at is null
      left join fan_spend_lifetime l on l.platform_account_id = pf.platform_account_id and l.fan_id = pf.fan_id
      where pf.platform_account_id = ${page}
    ),
    threads as (
      select distinct on (t.fan_id) t.fan_id, t.platform_conversation_id, t.last_fan_message_at
      from page_dm_threads t
      where t.platform_account_id = ${page} and t.is_visible and t.fan_id is not null
      order by t.fan_id, t.last_message_at desc nulls last
    ),
    expiring as (
      select s.fan_id, 'expiring'::text as reason, max(s.ends_at) as reason_at, 0 as urgency
      from page_subscriptions s
      where s.platform_account_id = ${page} and s.is_current and s.auto_renew = false
        and s.ends_at > ${now} and s.ends_at <= ${now} + make_interval(days => ${input.expiringDays})
      group by s.fan_id
    ),
    fresh as (
      select s.fan_id, 'new_unattended'::text as reason, min(s.source_created_at) as reason_at, 1 as urgency
      from page_subscriptions s
      join fans f on f.id = s.fan_id
      left join threads th on th.fan_id = s.fan_id
      where s.platform_account_id = ${page}
        and s.source_created_at > ${now} - make_interval(days => ${input.newDays})
        and not exists (
          select 1 from client_send_attributions a
          where a.page_id = ${page} and a.fan_ref = f.platform_user_id and a.observed_at > s.source_created_at
        )
        and not exists (
          select 1 from message_archive m
          where m.account_id = ${page} and m.conversation_ref = th.platform_conversation_id
            and m.is_sent_by_me and coalesce(m.message_type, 1) <> 2 and m.occurred_at > s.source_created_at
        )
      group by s.fan_id
    ),
    silent as (
      select th.fan_id, 'silent'::text as reason, th.last_fan_message_at as reason_at, 2 as urgency
      from threads th
      join fans_of_page fp on fp.fan_id = th.fan_id and fp.gross >= 10
      where th.last_fan_message_at < ${now} - make_interval(days => ${input.silentDays})
    ),
    reasons as (
      select distinct on (fan_id) fan_id, reason, reason_at
      from (select * from expiring union all select * from fresh union all select * from silent) r
      order by fan_id, urgency
    )
    select r.fan_id, f.platform_user_id as fan_ref, th.platform_conversation_id as conversation_ref,
      f.username, f.display_name, fp.page_alias, coalesce(fp.gross, 0) as gross, r.reason, r.reason_at
    from reasons r
    join fans f on f.id = r.fan_id and f.deleted_detected_at is null
    left join fans_of_page fp on fp.fan_id = r.fan_id
    left join threads th on th.fan_id = r.fan_id
    where not exists (
        select 1 from winback_attempts w
        where w.page_id = ${page} and w.fan_id = r.fan_id
          and w.picked_at > ${now} - make_interval(days => ${input.cooldownDays})
      )
      and not exists (
        select 1 from client_send_attributions a
        where a.page_id = ${page} and a.fan_ref = f.platform_user_id
          and a.observed_at > ${now} - make_interval(mins => ${input.inConversationMinutes})
      )
    order by coalesce(fp.gross, 0) desc, r.fan_id
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref,
    conversationRef: row.conversation_ref,
    username: row.username,
    displayName: row.display_name,
    alias: row.page_alias,
    lifetimeGrossMills: Number(row.gross),
    reason: row.reason,
    reasonAt: row.reason_at === null ? null : new Date(row.reason_at),
  }));
}

export interface WinBackApproach {
  id: number;
  label: string;
  sortOrder: number;
  active: boolean;
}

export async function listWinBackApproaches(db: Database, input: { activeOnly: boolean }): Promise<WinBackApproach[]> {
  const result = await db.execute<{ id: string | number; label: string; sort_order: number; active: boolean }>(sql`
    select id, label, sort_order, active from winback_approaches
    ${input.activeOnly ? sql`where active` : sql``}
    order by active desc, sort_order, id`);
  return result.rows.map((row) => ({ id: Number(row.id), label: row.label, sortOrder: Number(row.sort_order), active: row.active }));
}

/** The owner's edit of the list: a new approach (no id) or a change of one; retiring is `active: false`. */
export async function saveWinBackApproach(
  db: Database,
  input: { id: number | null; label: string; sortOrder: number; active: boolean; userId: number },
): Promise<WinBackApproach> {
  const result = input.id === null
    ? await db.execute<{ id: string | number; label: string; sort_order: number; active: boolean }>(sql`
        insert into winback_approaches (label, sort_order, active, created_by_user_id)
        values (${input.label}, ${input.sortOrder}, ${input.active}, ${input.userId})
        returning id, label, sort_order, active`)
    : await db.execute<{ id: string | number; label: string; sort_order: number; active: boolean }>(sql`
        update winback_approaches set label = ${input.label}, sort_order = ${input.sortOrder}, active = ${input.active}, updated_at = now()
        where id = ${input.id}
        returning id, label, sort_order, active`);
  const row = result.rows[0];
  if (!row) throw new Error("winback approach not found");
  return { id: Number(row.id), label: row.label, sortOrder: Number(row.sort_order), active: row.active };
}

export async function insertWinBackAttempt(
  db: Database,
  input: {
    pageId: number; fanId: number; fanRef: string; conversationRef: string | null; userId: number;
    approachId: number; reason: WinBackReason; pickedAt: Date; observationId: number;
  },
): Promise<number> {
  const result = await db.execute<{ id: string | number }>(sql`
    insert into winback_attempts (page_id, fan_id, fan_ref, conversation_ref, user_id, approach_id, reason, picked_at, observation_id)
    values (${input.pageId}, ${input.fanId}, ${input.fanRef}, ${input.conversationRef}, ${input.userId}, ${input.approachId},
      ${input.reason}, ${input.pickedAt.toISOString()}::timestamptz, ${input.observationId})
    returning id`);
  return Number(result.rows[0]!.id);
}

export interface WinBackResultRow {
  approachId: number;
  approachLabel: string;
  userId: number;
  username: string;
  attempts: number;
  /** Attempts followed by a message of the chatter to the fan within 48 hours. */
  sent: number;
  /** Of the sent, those 72 hours old or more, and of them the ones the fan answered within 72 hours. */
  matured72h: number;
  replied72h: number;
  /** Of the sent, those 7 days old or more, and of them the ones the fan paid within 7 days. */
  matured7d: number;
  bought7d: number;
  /** Of the sent, those 30 days old or more, and what those fans paid within 30 days. */
  matured30d: number;
  spent30dMills: number;
}

/**
 * The results of the attempts picked in [from, to) on the pages in scope, by
 * approach and chatter. An attempt counts from the chatter's first message to
 * the fan within 48 hours of the pick (their send attribution); a result is
 * counted only once its window is over.
 */
export async function listWinBackResults(
  db: Database,
  input: { from: Date; to: Date; now: Date; pages: "all" | readonly number[] },
): Promise<WinBackResultRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all" ? sql`true` : sql`w.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const result = await db.execute<{
    approach_id: string | number; label: string; user_id: string | number; username: string; attempts: string | number; sent: string | number;
    matured72h: string | number; replied72h: string | number; matured7d: string | number; bought7d: string | number;
    matured30d: string | number; spent30d: string | number;
  }>(sql`
    with att as (
      select w.*,
        (select min(a.observed_at) from client_send_attributions a
          where a.page_id = w.page_id and a.user_id = w.user_id and a.fan_ref = w.fan_ref
            and a.observed_at >= w.picked_at and a.observed_at < w.picked_at + interval '48 hours') as sent_at
      from winback_attempts w
      where w.picked_at >= ${input.from.toISOString()}::timestamptz and w.picked_at < ${input.to.toISOString()}::timestamptz
        and ${pageFilter}
    ),
    judged as (
      select att.*,
        att.sent_at is not null and att.sent_at <= ${now} - interval '72 hours' as m72,
        att.sent_at is not null and att.sent_at <= ${now} - interval '7 days' as m7,
        att.sent_at is not null and att.sent_at <= ${now} - interval '30 days' as m30,
        exists (
          select 1 from message_archive m
          where m.account_id = att.page_id and m.conversation_ref = coalesce(att.conversation_ref, att.fan_ref)
            and not m.is_sent_by_me and m.occurred_at > att.sent_at and m.occurred_at <= att.sent_at + interval '72 hours'
        ) as replied,
        exists (
          select 1 from transactions t
          where t.platform_account_id = att.page_id and t.fan_id = att.fan_id and t.is_active and t.gross_amount_mills > 0
            and t.canonical_type not in ('chargeback', 'refund', 'payout_reversal')
            and t.occurred_at > att.sent_at and t.occurred_at <= att.sent_at + interval '7 days'
        ) as bought,
        (
          select coalesce(sum(t.gross_amount_mills), 0) from transactions t
          where t.platform_account_id = att.page_id and t.fan_id = att.fan_id and t.is_active
            and t.occurred_at > att.sent_at and t.occurred_at <= att.sent_at + interval '30 days'
        ) as spent
      from att
    )
    select j.approach_id, ap.label, j.user_id, u.username,
      count(*) as attempts,
      count(j.sent_at) as sent,
      count(*) filter (where j.m72) as matured72h,
      count(*) filter (where j.m72 and j.replied) as replied72h,
      count(*) filter (where j.m7) as matured7d,
      count(*) filter (where j.m7 and j.bought) as bought7d,
      count(*) filter (where j.m30) as matured30d,
      coalesce(sum(j.spent) filter (where j.m30), 0) as spent30d
    from judged j
    join winback_approaches ap on ap.id = j.approach_id
    join users u on u.id = j.user_id
    group by 1, 2, 3, 4
    order by ap.label, u.username`);
  return result.rows.map((row) => ({
    approachId: Number(row.approach_id),
    approachLabel: row.label,
    userId: Number(row.user_id),
    username: row.username,
    attempts: Number(row.attempts),
    sent: Number(row.sent),
    matured72h: Number(row.matured72h),
    replied72h: Number(row.replied72h),
    matured7d: Number(row.matured7d),
    bought7d: Number(row.bought7d),
    matured30d: Number(row.matured30d),
    spent30dMills: Number(row.spent30d),
  }));
}
