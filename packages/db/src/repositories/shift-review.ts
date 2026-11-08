import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notOwnAccountMessageSql } from "./shift-sql.ts";

// The reads of Команда → «Разбор смены» (apps/runtime services/shift-review.ts):
// the chats a chatter's shift touched with their messages, who sent each page
// message, the fans, their money, and the AI texts of the shift. Read-only,
// database only; the shift itself is services/chatter-shifts.ts's.
//
// A mass message is the one of chatter-numbers.ts: a Fansly mass message
// (message_type 2), or one text with the same price and files sent to
// `burstMinChats` chats of the page or more in its clock hour.

export interface ShiftReviewMessageRow {
  pageId: number;
  platform: string;
  conv: string;
  ref: string;
  at: Date;
  sent: boolean;
  text: string;
  priceMills: number | null;
  tipMills: number | null;
  media: number;
  fanNativeId: string | null;
  /** A Fansly mass message or a burst. */
  mass: boolean;
  /** The reported author (client_send_attributions); null — none. */
  authorId: number | null;
  authorName: string | null;
  /** A priced page message: bought; null for the rest. */
  bought: boolean | null;
}

/**
 * Every message, from `horizonHours` before the shift to its end, of the chats of
 * the shift's pages where, within [from, to), `userId` sent, and — on the pages
 * the shift worked (`workedPageIds`) — where the fan wrote or the fan's message
 * was the last one before `from`. A tab only looked at brings in the chats the
 * person wrote in, not the whole page a colleague kept. A chat with another page
 * of ours is no fan's and is left out. Oldest first.
 */
export async function listShiftReviewMessages(
  db: Database,
  input: {
    userId: number; pageIds: readonly number[]; workedPageIds: readonly number[]; from: Date; to: Date; horizonHours: number; burstMinChats: number;
  },
): Promise<ShiftReviewMessageRow[]> {
  if (input.pageIds.length === 0) return [];
  const pages = sql`${sql.param(input.pageIds.map(String))}::bigint[]`;
  const worked = sql`${sql.param(input.workedPageIds.map(String))}::bigint[]`;
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const horizon = sql`${from} - make_interval(hours => ${input.horizonHours})`;
  const result = await db.execute<{
    page_id: string | number; platform: string; conv: string; ref: string; at: Date | string; sent: boolean; text: string | null;
    price_mills: string | number | null; tip_mills: string | number | null; media: string | number; fan_native_id: string | null;
    mass: boolean; author_id: string | number | null; author_name: string | null; bought: boolean | null;
  }>(sql`
    with page_msgs as materialized (
      select m.account_id as page_id, m.platform, m.conversation_ref as conv, m.message_ref as ref, m.occurred_at as at,
        m.is_sent_by_me as sent, m.message_type, m.text_plain, m.price_mills, m.is_tip, m.tip_amount_mills, m.fan_native_id,
        case when jsonb_typeof(m.media_metadata) = 'array' then jsonb_array_length(m.media_metadata) else 0 end as media
      from message_archive m
      where m.account_id = any(${pages}) and m.conversation_ref is not null and m.deleted_at is null
        and m.occurred_at > ${horizon} and m.occurred_at < ${to}
        and ${notOwnAccountMessageSql("m")}
    ),
    mine as materialized (
      select a.page_id, a.platform, a.platform_message_id as ref
      from client_send_attributions a
      where a.user_id = ${input.userId} and a.page_id = any(${pages})
        and a.observed_at >= ${from} and a.observed_at < ${to}
    ),
    chats as materialized (
      select page_id, conv from page_msgs where at >= ${from} and not sent and page_id = any(${worked})
      union
      select pm.page_id, pm.conv from page_msgs pm
      join mine x on x.page_id = pm.page_id and x.platform = pm.platform and x.ref = pm.ref
      union
      select page_id, conv from (
        select distinct on (page_id, conv) page_id, conv, sent
        from page_msgs where at < ${from}
        order by page_id, conv, at desc
      ) last where not last.sent and last.page_id = any(${worked})
    ),
    shaped as materialized (
      select pm.*, md5(coalesce(pm.text_plain, '') || '|' || coalesce(pm.price_mills, 0)::text || '|' || pm.media::text) as shape
      from page_msgs pm
      where pm.sent
    ),
    bursts as materialized (
      select page_id, shape, date_trunc('hour', at) as hour
      from shaped
      where coalesce(message_type, 1) <> 2
      group by 1, 2, 3
      having count(distinct conv) >= ${input.burstMinChats}
    ),
    picked as materialized (
      select pm.* from page_msgs pm
      where (pm.page_id, pm.conv) in (select page_id, conv from chats)
    )
    select p.page_id, p.platform, p.conv, p.ref, p.at, p.sent, left(p.text_plain, 2000) as text,
      case when p.sent and p.price_mills > 0 then p.price_mills end as price_mills,
      case when not p.sent and p.is_tip and p.tip_amount_mills > 0 then p.tip_amount_mills end as tip_mills,
      p.media, p.fan_native_id,
      p.sent and (coalesce(p.message_type, 1) = 2 or exists (
        select 1 from bursts b
        where b.page_id = p.page_id and b.hour = date_trunc('hour', p.at)
          and b.shape = md5(coalesce(p.text_plain, '') || '|' || coalesce(p.price_mills, 0)::text || '|' || p.media::text))) as mass,
      a.user_id as author_id, u.username as author_name,
      case when not (p.sent and coalesce(p.price_mills, 0) > 0) then null
        when p.platform = 'fansly' then (
          exists (select 1 from message_media_offers mo where mo.page_id = p.page_id and mo.message_ref = p.ref and mo.purchase_state = 'purchased')
          or exists (select 1 from media_orders o where o.page_id = p.page_id and o.message_ref = p.ref))
        else exists (
          select 1 from page_dm_messages d where d.platform_account_id = p.page_id and d.platform_message_id = p.ref and d.purchased_at is not null)
      end as bought
    from picked p
    left join client_send_attributions a on p.sent and a.page_id = p.page_id and a.platform = p.platform and a.platform_message_id = p.ref
    left join users u on u.id = a.user_id
    order by p.page_id, p.conv, p.at, p.ref`);
  const num = (value: string | number | null) => (value === null ? null : Number(value));
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    platform: row.platform,
    conv: row.conv,
    ref: row.ref,
    at: new Date(row.at),
    sent: row.sent,
    text: row.text ?? "",
    priceMills: num(row.price_mills),
    tipMills: num(row.tip_mills),
    media: Number(row.media),
    fanNativeId: row.fan_native_id,
    mass: row.mass,
    authorId: num(row.author_id),
    authorName: row.author_name,
    bought: row.bought,
  }));
}

export interface ShiftReviewSendRow {
  pageId: number;
  ref: string;
  composedWith: string | null;
  edited: boolean | null;
  observedAt: Date;
  inArchive: boolean;
  /** In the archive, deleted after it was sent. */
  deleted: boolean;
}

/** `userId`'s reported sends on the pages in [from, to). */
export async function listShiftReviewSends(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date },
): Promise<ShiftReviewSendRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{
    page_id: string | number; ref: string; composed_with: string | null; edited: boolean | null; observed_at: Date | string; in_archive: boolean; deleted: boolean;
  }>(sql`
    select a.page_id, a.platform_message_id as ref, a.composed_with, a.edited, a.observed_at,
      exists (select 1 from message_archive m where m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id) as in_archive,
      exists (select 1 from message_archive m where m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
        and m.deleted_at is not null) as deleted
    from client_send_attributions a
    where a.user_id = ${input.userId} and a.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      and a.observed_at >= ${input.from.toISOString()}::timestamptz and a.observed_at < ${input.to.toISOString()}::timestamptz`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    ref: row.ref,
    composedWith: row.composed_with,
    edited: row.edited,
    observedAt: new Date(row.observed_at),
    inArchive: row.in_archive,
    deleted: row.deleted,
  }));
}

export interface ShiftReviewFanRow {
  pageId: number;
  conv: string;
  fanId: number | null;
  fanRef: string | null;
  username: string | null;
  displayName: string | null;
  lifetimeNetMills: number | null;
  shiftNetMills: number;
}

/** The fan of each chat: the thread's partner, their all-time net on the page and their net within [from, to). */
export async function listShiftReviewFans(
  db: Database,
  input: { chats: ReadonlyArray<{ pageId: number; conv: string }>; from: Date; to: Date },
): Promise<ShiftReviewFanRow[]> {
  if (input.chats.length === 0) return [];
  const pageIds = sql.param(input.chats.map((chat) => String(chat.pageId)));
  const convs = sql.param(input.chats.map((chat) => chat.conv));
  const result = await db.execute<{
    page_id: string | number; conv: string; fan_id: string | number | null; fan_ref: string | null; username: string | null;
    display_name: string | null; lifetime_net: string | number | null; shift_net: string | number | null;
  }>(sql`
    with wanted as (
      select * from unnest(${pageIds}::bigint[], ${convs}::text[]) as w(page_id, conv)
    )
    select w.page_id, w.conv, t.fan_id, coalesce(t.partner_platform_user_id, f.platform_user_id) as fan_ref,
      coalesce(f.username, t.partner_username) as username, coalesce(f.display_name, t.partner_display_name) as display_name,
      l.creator_net_amount_mills as lifetime_net,
      (select sum(x.creator_net_amount_mills) from transactions x
        where x.platform_account_id = w.page_id and x.fan_id = t.fan_id and x.is_active and x.gross_amount_mills > 0
          and x.occurred_at >= ${input.from.toISOString()}::timestamptz and x.occurred_at < ${input.to.toISOString()}::timestamptz) as shift_net
    from wanted w
    left join page_dm_threads t on t.platform_account_id = w.page_id and t.platform_conversation_id = w.conv
    left join fans f on f.id = t.fan_id
    left join fan_spend_lifetime l on l.platform_account_id = w.page_id and l.fan_id = t.fan_id`);
  const num = (value: string | number | null) => (value === null ? null : Number(value));
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    conv: row.conv,
    fanId: num(row.fan_id),
    fanRef: row.fan_ref,
    username: row.username,
    displayName: row.display_name,
    lifetimeNetMills: num(row.lifetime_net),
    shiftNetMills: num(row.shift_net) ?? 0,
  }));
}

/**
 * The texts of every page's automated messages (a welcome after a follow, a renewal): such a message answers nobody.
 * Every page's, as the shift audit does: an OnlyFans page has no rows of its own and sends the Fansly page's welcome.
 */
export async function listAllAutomatedTexts(db: Database): Promise<string[]> {
  const result = await db.execute<{ message_text: string }>(sql`
    select distinct message_text from page_automated_messages where parse_ok and message_text is not null`);
  return result.rows.map((row) => String(row.message_text));
}

/** The pages by label: id and platform. */
export async function listPagesByLabels(db: Database, labels: readonly string[]): Promise<Array<{ id: number; label: string; platform: string }>> {
  if (labels.length === 0) return [];
  const result = await db.execute<{ id: string | number; label: string; platform: string }>(sql`
    select id, label, platform from pages where label = any(${sql.param([...labels])}::text[])`);
  return result.rows.map((row) => ({ id: Number(row.id), label: row.label, platform: row.platform }));
}

export interface ShiftReviewGenerationRow {
  generationRef: string;
  feature: string;
  pageId: number | null;
  conv: string | null;
  fanRef: string | null;
  createdAt: Date;
  completion: string;
  /** A Fix's draft (`<current_draft>` of its prompt); null for the rest. */
  draft: string | null;
}

/** The person's AI texts on the pages in [from, to) of the features a chatter sends from. */
export async function listShiftReviewGenerations(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date; features: readonly string[] },
): Promise<ShiftReviewGenerationRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{
    generation_ref: string; feature: string; page_id: string | number | null; conversation_ref: string | null; fan_ref: string | null;
    created_at: Date | string; completion: string; draft: string | null;
  }>(sql`
    select g.generation_ref, g.feature::text as feature, g.page_id, g.conversation_ref, g.fan_ref, g.created_at, g.completion,
      case when g.feature::text = 'improve-draft' then (
        select substring(string_agg(bl->>'text', E'\n') from '<current_draft>\\s*(.*?)\\s*</current_draft>')
        from jsonb_array_elements(g.prompt_blocks) b, jsonb_array_elements(b->'blocks') bl
        where b->>'role' = 'user') end as draft
    from ai_generation_content g
    where g.user_id = ${input.userId} and g.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      and g.created_at >= ${input.from.toISOString()}::timestamptz and g.created_at < ${input.to.toISOString()}::timestamptz
      and g.feature::text = any(${sql.param([...input.features])}::text[])
    order by g.created_at`);
  return result.rows.map((row) => ({
    generationRef: row.generation_ref,
    feature: row.feature,
    pageId: row.page_id === null ? null : Number(row.page_id),
    conv: row.conversation_ref,
    fanRef: row.fan_ref,
    createdAt: new Date(row.created_at),
    completion: row.completion,
    draft: row.draft,
  }));
}

/**
 * The generation each sent message came from, as the extension's acceptance
 * telemetry says (`desktop.ai_acceptance`, lifecycle `sent`; only from
 * browsers whose data consent is on). By the platform message id.
 */
export async function listSentGenerationLinks(
  db: Database,
  input: { refs: readonly string[]; from: Date; to: Date },
): Promise<Map<string, string>> {
  if (input.refs.length === 0) return new Map();
  const result = await db.execute<{ ref: string; generation_ref: string }>(sql`
    select distinct on (o.payload->>'platformMessageId') o.payload->>'platformMessageId' as ref, o.payload->>'generationRef' as generation_ref
    from observations o
    where o.kind = 'desktop.ai_acceptance'
      and o.received_at >= ${input.from.toISOString()}::timestamptz and o.received_at < ${input.to.toISOString()}::timestamptz
      and o.payload->>'lifecycle' = 'sent' and o.payload->>'generationRef' is not null
      and o.payload->>'platformMessageId' = any(${sql.param([...input.refs])}::text[])
    order by o.payload->>'platformMessageId', o.id`);
  return new Map(result.rows.map((row) => [row.ref, row.generation_ref]));
}
