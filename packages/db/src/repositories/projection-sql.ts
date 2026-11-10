// The rebuildable projections' upsert guards and parameter helpers, one copy
// (W4-05, A11-04). Not on the barrel: repositories import it directly.
//
// Bodies are verbatim from the copies `fansly-catalog.ts`, `fansly-stats.ts`
// and `media-plane.ts` carried (and, for `millsParam` / the array literal,
// `page-payouts.ts`, `post-comments.ts`, `fansly-insights.ts` and
// `fansly-engagement.ts`). Variants that differ in any token keep their own
// local copy: `page-payouts.ts` and `post-comments.ts` (`newerWins`, `pick`),
// `creator-posts.ts` (curried `newerWins`, null-aware array helper),
// `fansly-engagement.ts` (inline `newerWins` / `pick`), and
// `sync/values.ts:textArrayParam` (binds a real array, a different mechanism).

import { sql, type SQL } from "drizzle-orm";

/** Excluded wins on a newer observation instant, or on the same instant with a
 *  higher account_seq. */
export function newerWins(table: string) {
  const current = sql.identifier(table);
  return sql`
    excluded.last_observed_at > ${current}.last_observed_at
    or (
      excluded.last_observed_at = ${current}.last_observed_at
      and excluded.source_account_seq > ${current}.source_account_seq
    )
  `;
}

export function pick(table: string, column: string): SQL {
  const current = sql.identifier(table);
  const name = sql.identifier(column);
  return sql`case when ${newerWins(table)} then excluded.${name} else ${current}.${name} end`;
}

export function millsParam(value: bigint | null): SQL {
  return value === null ? sql`null` : sql`${value.toString()}::bigint`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes a syntax error at runtime on exactly the common case. An empty roster
 * is not an edge case here: it is what a page with no gift codes left serves,
 * and what a post whose comments were all deleted serves.
 */
export function textArrayLiteralParam(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}
