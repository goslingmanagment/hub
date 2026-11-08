import { sql, type SQL } from "drizzle-orm";

// The SQL rules the shift reads share — «Разбор смены» (shift-review.ts), the
// numbers of «Смены» (chatter-numbers.ts), «Что продаёт» (team-sales.ts) — so
// all count one chat and one PPV alike.

function tableOf(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`);
  return sql.raw(alias);
}

/**
 * The message_archive row aliased `alias` is not one of a chat with another
 * page of this hub (loravie ↔ loravievip forwarding media to each other): that
 * side is ours, not a fan. On OnlyFans the conversation ref names the other
 * account; on Fansly the fan's messages carry its id. Known account ids are
 * unique among a platform's pages (pages_platform_external_id_uniq).
 */
export function notOwnAccountMessageSql(alias: string): SQL {
  const m = tableOf(alias);
  return sql`not exists (
    select 1 from pages own
    where own.platform = ${m}.platform and own.external_page_id in (${m}.conversation_ref, ${m}.fan_native_id)
  )`;
}

/**
 * The message_archive row aliased `alias` was there for the other side to see: not deleted, or deleted `unseenSeconds`
 * after it was sent or later (owner, 2026-11-08). One deleted sooner most likely nobody saw: a fan's starts no wait, a
 * page's answers none and is not the chatter's message. A Fansly deletion keeps the text (`deleted_at` alone). A
 * deletion that came before the message's content (a content_pending stub, no text) goes by the same rule: Fansly's
 * socket names the send time, and most such stubs are sends recalled within seconds (production, 2026-11-08).
 */
export function seenMessageSql(alias: string, unseenSeconds: number): SQL {
  const m = tableOf(alias);
  return sql`(${m}.deleted_at is null or ${m}.deleted_at >= ${m}.occurred_at + make_interval(secs => ${unseenSeconds}))`;
}

/**
 * The files of the page's message_archive row aliased `alias` as one key: their platform ids, sorted; '' — none, or not
 * the page's. Two sends of one file set carry one key (a Fansly or OnlyFans media id is the file's, not the message's).
 */
export function sentMediaKeySql(alias: string): SQL {
  const m = tableOf(alias);
  return sql`(case when ${m}.is_sent_by_me and jsonb_typeof(${m}.media_metadata) = 'array' and jsonb_array_length(${m}.media_metadata) > 0
    then coalesce((select string_agg(e->>'id', ',' order by e->>'id') from jsonb_array_elements(${m}.media_metadata) e), '')
    else '' end)`;
}

/**
 * A broadcast with names (owner, 2026-11-08): one file set at one price (none — 0) from one sender (the reported
 * author; no author — one unknown sender) to `minChats` chats of a page or more within an hour is a mass message, the
 * texts and names in it different or not. A message of it stays personal when it carries a live answer: `ownWords`
 * words or more of its own beyond the broadcast's template — words no other message of the broadcast within an hour
 * of it has (letters and digits, two or more). A Fansly mass message (type 2) is one already.
 *
 * The CTEs `broadcast_sends`, `broadcast_openers` and `broadcast_refs` (page_id, ref of each such mass message), to
 * follow a CTE `source` with page_id, platform, conv, ref, at, sent, message_type, text_plain, price_mills and
 * media_key (`sentMediaKeySql`). An hour is any 60 minutes: one opens at each send of the file set.
 */
export function broadcastCtesSql(source: string, input: { minChats: number; ownWords: number }): SQL {
  const pm = tableOf(source);
  const same = sql`o.page_id = s.page_id and o.media_key = s.media_key and o.price = s.price and o.author is not distinct from s.author`;
  return sql`
    broadcast_sends as materialized (
      select pm.page_id, pm.conv, pm.ref, pm.at, coalesce(pm.price_mills, 0) as price, pm.media_key, a.user_id as author,
        array(select distinct w from regexp_split_to_table(lower(coalesce(pm.text_plain, '')), '[^[:alnum:]]+') w where length(w) >= 2) as words
      from ${pm} pm
      left join client_send_attributions a on a.page_id = pm.page_id and a.platform = pm.platform and a.platform_message_id = pm.ref
      where pm.sent and pm.media_key <> '' and coalesce(pm.message_type, 1) <> 2
    ),
    broadcast_openers as materialized (
      select s.page_id, s.media_key, s.price, s.author, s.at
      from broadcast_sends s
      where (select count(distinct o.conv) from broadcast_sends o where ${same} and o.at >= s.at and o.at < s.at + interval '1 hour') >= ${input.minChats}
    ),
    broadcast_refs as materialized (
      select s.page_id, s.ref
      from broadcast_sends s
      where exists (
          select 1 from broadcast_openers o where ${same} and s.at >= o.at and s.at < o.at + interval '1 hour')
        and cardinality(array(
          select unnest(s.words)
          except
          select unnest(o.words) from broadcast_sends o
          where ${same} and o.ref <> s.ref and o.at > s.at - interval '1 hour' and o.at < s.at + interval '1 hour'
        )) < ${input.ownWords}
    )`;
}

function columnOf(column: string): SQL {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`Invalid SQL column: ${column}`);
  return sql.raw(column);
}

/**
 * A priced page message bought — the one rule of «Разбор смены», the numbers of «Смены», «Что продаёт» and the coverage
 * of mass messages; the columns name the message's page, platform, ref, chat and time. Fansly: its offer purchased, an
 * order of it, or — the offer's state stuck at 'unknown' — a purchase of its media or bundle by this chat's fan after it,
 * with no later message of the chat carrying the same offer before the purchase (an offer is sent to many fans, and again
 * to one). OnlyFans: the message unlocked.
 */
export function ppvBoughtSql(columns: { pageId: string; platform: string; ref: string; conv: string; at: string }): SQL {
  const [pageId, platform, ref, conv, at] = [columns.pageId, columns.platform, columns.ref, columns.conv, columns.at].map(columnOf);
  return sql`(case ${platform}
    when 'fansly' then
      exists (select 1 from message_media_offers mo where mo.page_id = ${pageId} and mo.message_ref = ${ref} and mo.purchase_state = 'purchased')
      or exists (select 1 from media_orders o where o.page_id = ${pageId} and o.message_ref = ${ref})
      or exists (
        select 1 from message_media_offers mo
        join page_dm_threads th on th.platform_account_id = mo.page_id and th.platform_conversation_id = ${conv}
        join transactions t on t.platform_account_id = mo.page_id and t.fan_id = th.fan_id
        where mo.page_id = ${pageId} and mo.message_ref = ${ref}
          and t.canonical_type = 'message_purchase' and t.is_active and t.occurred_at >= ${at}
          and t.correlation_id in (mo.media_offer_ref, mo.bundle_ref)
          and not exists (
            select 1 from message_archive later
            join message_media_offers lo on lo.page_id = later.account_id and lo.message_ref = later.message_ref
            where later.account_id = ${pageId} and later.conversation_ref = ${conv} and later.is_sent_by_me
              and later.occurred_at > ${at} and later.occurred_at <= t.occurred_at
              and (lo.media_offer_ref = t.correlation_id or lo.bundle_ref = t.correlation_id)))
    when 'onlyfans' then exists (
      select 1 from page_dm_messages d where d.platform_account_id = ${pageId} and d.platform_message_id = ${ref} and d.purchased_at is not null)
    else false
  end)`;
}
