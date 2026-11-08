import { sql, type SQL } from "drizzle-orm";

// The SQL rules the shift reads share — «Разбор смены» (shift-review.ts) and
// the numbers of «Смены» (chatter-numbers.ts) — so both count one chat alike.

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
