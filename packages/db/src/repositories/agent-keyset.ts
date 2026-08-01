import { sql, type SQL } from "drizzle-orm";

/**
 * Keyset pagination for the Agent Read Plane, done ONE way.
 *
 * THE GOVERNING RULE, learned the expensive way in review round 1: the keyset
 * predicate must mirror the ORDER BY expression EXACTLY — same expression, same
 * cast, same NULL policy, same precision. Every one of the five paging bugs found
 * came from a mismatch:
 *
 *   - the transcript compared `message_ref` lexically while ORDER BY cast
 *     numeric-looking refs to bigint, so "10" sorted before "2" in one and after
 *     it in the other;
 *   - threads rendered the boundary timestamp with SIX fractional digits in SQL
 *     and stored THREE in the cursor (JavaScript's `toISOString`), so a row on the
 *     boundary was reselected or skipped;
 *   - `stored_message_count` was cast to text and therefore sorted "10" < "9";
 *   - datasets cast the cursor bound to text while ORDER BY used the native type;
 *   - ascending NULLS LAST never reached the trailing NULL rows at all, and a NULL
 *     boundary reintroduced every non-NULL row.
 *
 * The fix is structural rather than five separate patches: SQL renders ONE text
 * column `k_sort` that is order-isomorphic to the intended ordering, ORDER BY uses
 * `k_sort`, the cursor carries `k_sort` verbatim, and the predicate below compares
 * `k_sort`. There is no second expression that could drift.
 *
 * Order-isomorphic renderings (all fixed-width, so lexical order == native order):
 *   instants  `to_char(x at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')` — full
 *             microsecond precision, which is what the database actually stores;
 *   integers  biased and zero-padded, so negatives (refunds, chargebacks) keep
 *             their order — sign-magnitude padding does NOT, and money is signed;
 *   text/bool the value itself, compared under the same collation on both sides.
 */

/** Full-precision, fixed-width instant rendering. */
export function renderInstant(expression: SQL | string): SQL {
  const inner = typeof expression === "string" ? sql.raw(expression) : expression;
  return sql`to_char(${inner} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/**
 * Fixed-width numeric rendering that survives negatives.
 *
 * The bias is what makes it work: `-2` and `-10` padded as `-0…02` / `-0…10`
 * compare in the WRONG order lexically, because '0' < '1'. Shifting into the
 * positive range first removes the sign entirely.
 */
export function renderNumeric(expression: SQL | string): SQL {
  const inner = typeof expression === "string" ? sql.raw(expression) : expression;
  return sql`lpad(((${inner})::numeric + 1000000000000000000000)::text, 24, '0')`;
}

export function renderText(expression: SQL | string): SQL {
  const inner = typeof expression === "string" ? sql.raw(expression) : expression;
  return sql`(${inner})::text`;
}

export type KeysetDirection = "asc" | "desc";

export interface KeysetBoundary {
  /** The rendered sort value of the last row of the previous page; null is a real
   *  position (the trailing NULL block), not "no boundary". */
  readonly sortValue: string | null;
  /** The rendered tiebreak key of that same row. Never null. */
  readonly key: string;
}

/**
 * ORDER BY for a keyset walk. NULLS LAST in BOTH directions, deliberately: a
 * single policy is one less thing for the predicate to disagree with.
 */
export function keysetOrderBy(direction: KeysetDirection): SQL {
  return direction === "desc"
    ? sql`order by k_sort desc nulls last, k_key desc`
    : sql`order by k_sort asc nulls last, k_key asc`;
}

/**
 * The predicate that resumes exactly where `keysetOrderBy` left off.
 *
 * Three arms, and the third is the one that was missing: with NULLS LAST, every
 * NULL-sorted row still lies AHEAD of a non-NULL boundary, so it must be admitted.
 * Once the boundary is itself NULL we are inside that trailing block and only the
 * tiebreak applies.
 */
export function keysetPredicate(
  direction: KeysetDirection,
  boundary: KeysetBoundary | undefined,
): SQL {
  if (boundary === undefined) {
    return sql`true`;
  }
  const tie = direction === "desc"
    ? sql`k_key < ${boundary.key}`
    : sql`k_key > ${boundary.key}`;
  if (boundary.sortValue === null) {
    return sql`(k_sort is null and ${tie})`;
  }
  const ahead = direction === "desc"
    ? sql`k_sort < ${boundary.sortValue}`
    : sql`k_sort > ${boundary.sortValue}`;
  return sql`(${ahead} or (k_sort = ${boundary.sortValue} and ${tie}) or k_sort is null)`;
}
