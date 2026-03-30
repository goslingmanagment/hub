import { sql, type SQLWrapper } from "drizzle-orm";

import { fanPageAliases, fanPages } from "../schema.ts";

export function escapeLikePattern(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function buildContainsSearchPattern(query?: string | null) {
  const trimmed = query?.trim();
  return trimmed ? `%${escapeLikePattern(trimmed)}%` : null;
}

export function ilikeEscaped(column: SQLWrapper, pattern: string) {
  return sql`${column} ilike ${pattern} escape '\\'`;
}

export function pageAliasMatchSql(input: {
  fanId: SQLWrapper;
  platformAccountId: SQLWrapper;
  pattern: string;
}) {
  return sql`exists (
    select 1
    from ${fanPages} fp_alias
    where fp_alias.fan_id = ${input.fanId}
      and fp_alias.platform_account_id = ${input.platformAccountId}
      and fp_alias.page_alias ilike ${input.pattern} escape '\\'
  )`;
}

export function pageAliasHistoryMatchSql(input: {
  fanId: SQLWrapper;
  platformAccountId: SQLWrapper;
  pattern: string;
}) {
  return sql`exists (
    select 1
    from ${fanPageAliases} fpa
    where fpa.fan_id = ${input.fanId}
      and fpa.platform_account_id = ${input.platformAccountId}
      and fpa.alias ilike ${input.pattern} escape '\\'
  )`;
}

export function pageAliasMatchedValueSql(input: {
  fanId: SQLWrapper;
  platformAccountId: SQLWrapper;
  pattern: string;
}) {
  return sql`(
    select fp_alias.page_alias
    from ${fanPages} fp_alias
    where fp_alias.fan_id = ${input.fanId}
      and fp_alias.platform_account_id = ${input.platformAccountId}
      and fp_alias.page_alias ilike ${input.pattern} escape '\\'
    order by fp_alias.page_alias asc
    limit 1
  )`;
}

export function pageAliasHistoryMatchedValueSql(input: {
  fanId: SQLWrapper;
  platformAccountId: SQLWrapper;
  pattern: string;
}) {
  return sql`(
    select fpa.alias
    from ${fanPageAliases} fpa
    where fpa.fan_id = ${input.fanId}
      and fpa.platform_account_id = ${input.platformAccountId}
      and fpa.alias ilike ${input.pattern} escape '\\'
    order by fpa.last_seen_at desc, fpa.alias asc
    limit 1
  )`;
}
