import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Chat Memory week 6 «Продажи» (docs/plans/2026-10-24-chat-memory/week-6.md, А):
// every personal PPV of the window — a priced message the page sent that is not
// a Fansly mass message and not part of a burst (the same text, price and
// number of files to `burstMinFans` chats or more within one clock hour, as in
// message-authorship.ts) — with its author when one is recorded, whether the
// fan bought it and the net it brought. Database only.
//
// Bought: Fansly — an offer of the message `purchased` or a media order of it
// (as readShiftNumbers); OnlyFans — `page_dm_messages.purchased_at`. The net:
// Fansly — the purchased offers' `sales_net_mills`; OnlyFans — the creator net
// of the fan's message purchase closest to `purchased_at` (within 3 minutes,
// as listSaleFacts links a sale to its PPV). A bought PPV without a net found
// counts as bought with 0.
//
// «First PPV»: no earlier personal priced message in the conversation that Hub
// holds — the first one Hub knows of (a thread's history may be partial).
//
// B, reply time against purchases (listReplyDelayCounts): a reply is the
// page's first personal message after one or more messages of the fan; its
// delay runs from the first of them (a fan who waited more than 3 days is
// left out, as readShiftNumbers). Bought: the fan paid the page a tip or for
// a message, a post or a stream within 24 hours after the reply — a
// subscription renews by itself and does not count.

export interface PpvFactRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  priceMills: number;
  bought: boolean;
  netMills: number;
  firstPpv: boolean;
  userId: number | null;
  username: string | null;
}

export async function listPpvFacts(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[]; burstMinFans: number },
): Promise<PpvFactRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.account_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{
    page_id: string | number; page_label: string; platform: string; price_mills: string | number; bought: boolean;
    net_mills: string | number | null; first_ppv: boolean; user_id: string | number | null; username: string | null;
  }>(sql`
    with outgoing as (
      select m.account_id as page_id, m.platform, m.message_ref, m.occurred_at, m.conversation_ref, m.price_mills,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|'
          || jsonb_array_length(m.media_metadata)::text) as shape
      from message_archive m
      where m.is_sent_by_me and m.price_mills > 0 and coalesce(m.message_type, 1) <> 2
        and m.occurred_at >= ${input.from.toISOString()}::timestamptz and m.occurred_at < ${input.to.toISOString()}::timestamptz
        and ${pageFilter}
    ),
    bursts as (
      select page_id, shape, date_trunc('hour', occurred_at) as hour
      from outgoing
      group by 1, 2, 3
      having count(distinct conversation_ref) >= ${input.burstMinFans}
    ),
    ppv as (
      select o.* from outgoing o
      where not exists (
        select 1 from bursts b
        where b.page_id = o.page_id and b.shape = o.shape and b.hour = date_trunc('hour', o.occurred_at)
      )
    ),
    facts as (
      select x.*,
        case x.platform
          when 'fansly' then
            exists (select 1 from message_media_offers mo where mo.page_id = x.page_id and mo.message_ref = x.message_ref and mo.purchase_state = 'purchased')
            or exists (select 1 from media_orders o where o.page_id = x.page_id and o.message_ref = x.message_ref)
          else exists (
            select 1 from page_dm_messages d
            where d.platform_account_id = x.page_id and d.platform_message_id = x.message_ref and d.purchased_at is not null)
        end as bought,
        case x.platform
          when 'fansly' then (
            select sum(mo.sales_net_mills) from message_media_offers mo
            where mo.page_id = x.page_id and mo.message_ref = x.message_ref and mo.purchase_state = 'purchased')
          else (
            select t.creator_net_amount_mills
            from page_dm_messages d
            join page_dm_threads th on th.id = d.conversation_id
            join transactions t on t.platform_account_id = d.platform_account_id and t.canonical_type = 'message_purchase' and t.is_active
              and t.occurred_at between d.purchased_at - interval '3 minutes' and d.purchased_at + interval '3 minutes'
            join fans f on f.id = t.fan_id and f.platform_user_id = th.platform_conversation_id
            where d.platform_account_id = x.page_id and d.platform_message_id = x.message_ref and d.purchased_at is not null
            order by abs(extract(epoch from t.occurred_at - d.purchased_at))
            limit 1)
        end as net_mills,
        x.conversation_ref is not null and not exists (
          select 1 from message_archive e
          where e.account_id = x.page_id and e.conversation_ref = x.conversation_ref and e.is_sent_by_me and e.price_mills > 0
            and coalesce(e.message_type, 1) <> 2 and e.occurred_at < x.occurred_at
        ) as first_ppv
      from ppv x
    )
    select f.page_id, p.label as page_label, f.platform, f.price_mills, f.bought, f.net_mills, f.first_ppv, a.user_id, u.username
    from facts f
    join pages p on p.id = f.page_id
    left join client_send_attributions a on a.platform = f.platform and a.page_id = f.page_id and a.platform_message_id = f.message_ref
    left join users u on u.id = a.user_id`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    priceMills: Number(row.price_mills),
    bought: row.bought,
    netMills: row.bought && row.net_mills !== null ? Number(row.net_mills) : 0,
    firstPpv: row.first_ppv,
    userId: row.user_id === null ? null : Number(row.user_id),
    username: row.username,
  }));
}

export interface ReplyDelayCountRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  userId: number | null;
  username: string | null;
  /** 0 below the first bound of `delayBounds`, i below its i-th (from 1). */
  bucket: number;
  replies: number;
  bought: number;
}

/** Replies sent in [from, to) per page, author and delay bucket; `delayBounds` ascending, seconds. */
export async function listReplyDelayCounts(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[]; burstMinFans: number; delayBounds: readonly number[] },
): Promise<ReplyDelayCountRow[]> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.account_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<{
    page_id: string | number; page_label: string; platform: string; user_id: string | number | null; username: string | null;
    bucket: string | number; replies: string | number; bought: string | number;
  }>(sql`
    with raw as (
      select m.account_id as page_id, m.platform, m.conversation_ref as conv, m.message_ref, m.occurred_at as at, m.is_sent_by_me as mine,
        m.fan_native_id, m.message_type,
        md5(coalesce(m.text_plain, '') || '|' || coalesce(m.price_mills, 0)::text || '|'
          || jsonb_array_length(m.media_metadata)::text) as shape
      from message_archive m
      where m.conversation_ref is not null
        and m.occurred_at >= ${from} - interval '3 days' and m.occurred_at < ${to}
        and ${pageFilter}
    ),
    bursts as (
      select page_id, shape, date_trunc('hour', at) as hour
      from raw where mine
      group by 1, 2, 3
      having count(distinct conv) >= ${input.burstMinFans}
    ),
    msgs as (
      select r.* from raw r
      where not r.mine or (coalesce(r.message_type, 1) <> 2 and not exists (
        select 1 from bursts b where b.page_id = r.page_id and b.shape = r.shape and b.hour = date_trunc('hour', r.at)))
    ),
    -- g: the page's personal messages so far in the chat; the fan's messages after the k-th one wait for the (k+1)-th.
    ordered as (
      select *, count(*) filter (where mine) over (
        partition by page_id, conv order by at, message_ref rows between unbounded preceding and current row) as g
      from msgs
    ),
    waits as (
      select page_id, conv, g, min(at) as waited_from, max(fan_native_id) as fan_ref
      from ordered where not mine
      group by 1, 2, 3
    ),
    replies as (
      select r.page_id, r.platform, r.message_ref, r.at, w.waited_from, w.fan_ref
      from ordered r
      join waits w on w.page_id = r.page_id and w.conv = r.conv and w.g = r.g - 1
      where r.mine and r.at >= ${from} and w.waited_from > r.at - interval '3 days'
    ),
    facts as (
      select x.page_id, x.platform, a.user_id,
        width_bucket(extract(epoch from x.at - x.waited_from)::bigint, ${sql.param(input.delayBounds.map(String))}::bigint[]) as bucket,
        exists (
          select 1 from transactions t join fans fp on fp.id = t.fan_id
          where t.platform_account_id = x.page_id and fp.platform_user_id = x.fan_ref
            and t.is_active and t.gross_amount_mills > 0
            and t.canonical_type in ('tip', 'message_purchase', 'post_purchase', 'stream_tip')
            and t.occurred_at > x.at and t.occurred_at <= x.at + interval '24 hours'
        ) as bought
      from replies x
      left join client_send_attributions a on a.platform = x.platform and a.page_id = x.page_id and a.platform_message_id = x.message_ref
    )
    select f.page_id, p.label as page_label, p.platform, f.user_id, u.username, f.bucket,
      count(*) as replies, count(*) filter (where f.bought) as bought
    from facts f
    join pages p on p.id = f.page_id
    left join users u on u.id = f.user_id
    group by 1, 2, 3, 4, 5, 6`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    userId: row.user_id === null ? null : Number(row.user_id),
    username: row.username,
    bucket: Number(row.bucket),
    replies: Number(row.replies),
    bought: Number(row.bought),
  }));
}
