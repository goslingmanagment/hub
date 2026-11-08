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
