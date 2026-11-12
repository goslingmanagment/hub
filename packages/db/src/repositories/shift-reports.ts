import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { isOwnerLogin } from "./chatter-activity.ts";
import { listOnlyfansUnlockMatches } from "./onlyfans-unlocks.ts";

// The sales of a shift and their facts (Chat Memory week 4, 0311), and what the
// draft shift report's tables hold of them: the chatters' marks, the owner's
// splits and which marks a confirmed report held. Nothing writes those tables
// any more — what a shift pays is the chatter's posted report, which the agency
// ledger reads — but `agentTeamSales` still passes them to the ledger as they
// stand (the tables are kept, never dropped). Hub lists and counts.

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

/** Sales on the pages (every page: "all") in [from, to) (of `fanIds` only, when given): money a fan paid (no refund, chargeback or reversal), oldest first. */
export async function listShiftSales(
  db: Database,
  input: { pageIds: "all" | readonly number[]; from: Date; to: Date; fanIds?: readonly number[] },
): Promise<ShiftSale[]> {
  if ((input.pageIds !== "all" && input.pageIds.length === 0) || input.fanIds?.length === 0) return [];
  const pages = input.pageIds === "all" ? sql`true` : sql`t.platform_account_id = any(${sql.param(input.pageIds.map(String))}::bigint[])`;
  const fans = input.fanIds === undefined ? sql`` : sql`and t.fan_id = any(${sql.param(input.fanIds.map(String))}::bigint[])`;
  const result = await db.execute<{
    id: string | number; page_id: string | number; label: string; platform: string; fan_id: string | number | null;
    fan_ref: string | null; fan_name: string | null; kind: string; gross: string | number; net: string | number; occurred_at: Date | string;
  }>(sql`
    select t.id, t.platform_account_id as page_id, p.label, p.platform, t.fan_id, f.platform_user_id as fan_ref,
      coalesce(f.display_name, f.username) as fan_name, t.canonical_type::text as kind, t.gross_amount_mills as gross, t.creator_net_amount_mills as net, t.occurred_at
    from transactions t
    join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    where ${pages}
      and t.is_active and t.gross_amount_mills > 0
      and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
      and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz
      ${fans}
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
  /** When the PPV message the fan bought was sent; null — not a PPV, or its message not found. */
  ppvSentAt: Date | null;
  /** That PPV message's platform id; null — not a PPV, or its message not found. */
  ppvMessageRef: string | null;
  /** A tip under a wall post (Fansly: `creator_post_tips` by the tip's id), not in a chat. */
  postTip: boolean;
  /** An OnlyFans tip that is a contribution to the page's Campaign: the fan's message «… $X to your Campaign» with it. */
  campaign: boolean;
  /** Who wrote to the fan on the page in the 48 hours before the sale, most messages first. */
  writers: Array<{ userId: number; username: string; messages: number }>;
  /** Personal messages to the fan in those 48 hours with no author. */
  withoutAuthor: number;
}

/**
 * The facts of each sale. The PPV a purchase paid for: on Fansly the page's
 * message that carried the bought media or bundle to that fan (the latest
 * before the purchase); on OnlyFans the unlock paired with the purchase one to
 * one (onlyfans-unlocks.ts: two purchases never share a message). Its author
 * is week 1's (client_send_attributions). A tip under a wall post is the post's
 * (`creator_post_tips`); an OnlyFans Campaign contribution is a tip whose fan
 * wrote «… to your Campaign» within CAMPAIGN_TEXT_MINUTES of it.
 */
const CAMPAIGN_TEXT_MINUTES = 2;

export async function listSaleFacts(db: Database, input: { transactionIds: readonly number[] }): Promise<SaleFacts[]> {
  if (input.transactionIds.length === 0) return [];
  const ofPurchases = await db.execute<{ id: string | number; page_id: string | number; fan_ref: string; occurred_at: Date | string }>(sql`
    select t.id, t.platform_account_id as page_id, f.platform_user_id as fan_ref, t.occurred_at
    from transactions t
    join pages p on p.id = t.platform_account_id and p.platform = 'onlyfans'
    join fans f on f.id = t.fan_id
    where t.id = any(${sql.param(input.transactionIds.map(String))}::bigint[]) and t.canonical_type = 'message_purchase'`);
  const ofTimes = ofPurchases.rows.map((row) => new Date(row.occurred_at).getTime());
  const unlocks = ofPurchases.rows.length === 0 ? [] : await listOnlyfansUnlockMatches(db, {
    chats: ofPurchases.rows.map((row) => ({ pageId: Number(row.page_id), fanRef: row.fan_ref })),
    from: new Date(Math.min(...ofTimes)),
    to: new Date(Math.max(...ofTimes)),
  });
  const ofLinks = unlocks.filter((match) => input.transactionIds.includes(match.transactionId));
  const result = await db.execute<{
    id: string | number; ppv_user_id: string | number | null; ppv_username: string | null; ppv_message_ref: string | null;
    ppv_sent_at: Date | string | null; post_tip: boolean; campaign: boolean;
    writers: Array<{ user_id: number; username: string; messages: number }> | null; written: string | number; outgoing: string | number;
  }>(sql`
    with of_links as (
      select * from unnest(${sql.param(ofLinks.map((link) => String(link.transactionId)))}::bigint[],
        ${sql.param(ofLinks.map((link) => link.messageRef))}::text[]) as l(id, ref)
    ),
    sales as (
      select t.id, t.platform_account_id as page_id, p.platform, t.canonical_type::text as kind, t.correlation_id, t.occurred_at,
        t.gross_amount_mills as gross, f.platform_user_id as fan_ref, t.fan_id
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
          -- Fansly: the page's message that carried the bought media or bundle to
          -- the fan. Before the purchase the projection files the offer under the
          -- model's id, not the buyer's: the fan's chat finds it then. By the
          -- offer's media id (indexed) first; a bundle's id is its media id too in
          -- every row so far, so the bundle look-up (no index: the page's offers
          -- one by one, ~40k) runs only when the first finds nothing.
          when s.platform = 'fansly' then coalesce(
            (select mo.message_ref from message_media_offers mo
              where mo.page_id = s.page_id and mo.media_offer_ref = s.correlation_id
                and (mo.fan_platform_user_id = s.fan_ref or mo.conversation_ref = any(c.refs))
                and coalesce(mo.message_created_at, s.occurred_at) <= s.occurred_at
              order by (mo.fan_platform_user_id = s.fan_ref) desc, mo.message_created_at desc nulls last limit 1),
            (select mo.message_ref from message_media_offers mo
              where mo.page_id = s.page_id and mo.bundle_ref = s.correlation_id
                and (mo.fan_platform_user_id = s.fan_ref or mo.conversation_ref = any(c.refs))
                and coalesce(mo.message_created_at, s.occurred_at) <= s.occurred_at
              order by (mo.fan_platform_user_id = s.fan_ref) desc, mo.message_created_at desc nulls last limit 1))
          -- OnlyFans: the unlock paired with this purchase, one to one.
          else (select l.ref from of_links l where l.id = s.id)
        end as message_ref
      from sales s
      join chats c on c.id = s.id
    )
    select s.id, a.user_id as ppv_user_id, u.username as ppv_username, ppv.message_ref as ppv_message_ref,
      (select pm.occurred_at from message_archive pm
        where pm.account_id = s.page_id and pm.platform = s.platform and pm.message_ref = ppv.message_ref) as ppv_sent_at,
      (s.kind = 'tip' and s.correlation_id is not null and exists (select 1 from creator_post_tips pt
        where pt.account_id = s.page_id and pt.platform_tip_id = s.correlation_id)) as post_tip,
      (s.kind = 'tip' and s.platform = 'onlyfans' and exists (select 1 from message_archive m, chats c
        where c.id = s.id and m.account_id = s.page_id and m.conversation_ref = any(c.refs) and not m.is_sent_by_me
          and m.occurred_at between s.occurred_at - make_interval(mins => ${CAMPAIGN_TEXT_MINUTES})
            and s.occurred_at + make_interval(mins => ${CAMPAIGN_TEXT_MINUTES})
          and m.text_plain ~* '\\mto your campaign\\M')) as campaign,
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
    ppvSentAt: row.ppv_sent_at === null ? null : new Date(row.ppv_sent_at),
    ppvMessageRef: row.ppv_message_ref,
    postTip: row.post_tip === true,
    campaign: row.campaign === true,
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

/** The owner's split of each of these sales that has one (written while Hub still took splits): percent per person. */
export async function listShiftResolutions(
  db: Database,
  input: { transactionIds: readonly number[] },
): Promise<Map<number, Array<{ userId: number; percent: number }>>> {
  if (input.transactionIds.length === 0) return new Map();
  const result = await db.execute<{ transaction_id: string | number; shares: Array<{ userId: number; percent: number }> }>(sql`
    select transaction_id, shares from shift_report_resolutions
    where transaction_id = any(${sql.param(input.transactionIds.map(String))}::bigint[])`);
  return new Map(result.rows.map((row) => [
    Number(row.transaction_id),
    row.shares.map((share) => ({ userId: Number(share.userId), percent: Number(share.percent) })),
  ]));
}

/** Which chatters' marks of these sales their confirmed shift reports hold (`<userId>:<transactionId>`): only those are credited. */
export async function listConfirmedMarkKeys(db: Database, input: { transactionIds: readonly number[] }): Promise<Set<string>> {
  if (input.transactionIds.length === 0) return new Set();
  const result = await db.execute<{ user_id: string | number; transaction_id: string | number }>(sql`
    select r.user_id, l.transaction_id from shift_report_lines l join shift_reports r on r.id = l.report_id
    where l.transaction_id = any(${sql.param(input.transactionIds.map(String))}::bigint[])`);
  return new Set(result.rows.map((row) => `${Number(row.user_id)}:${Number(row.transaction_id)}`));
}

/** The role of each of these people: the owner's chatter login too is the owner's (`isOwnerLogin`). */
export async function listUserRoles(db: Database, userIds: readonly number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const result = await db.execute<{ id: string | number; role: string }>(sql`
    select u.id, case when ${isOwnerLogin(sql`u.id`)} then 'owner' else u.role::text end as role
    from users u where u.id = any(${sql.param(userIds.map(String))}::bigint[])`);
  return new Map(result.rows.map((row) => [Number(row.id), row.role]));
}
