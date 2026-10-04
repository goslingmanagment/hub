import { classifyFanslyResponse } from "./lane.ts";

// The post-replies rules of the Sync Engine's `post-replies.*` resources
// (resources/post-replies.ts): the route's pagination modes and the reads of a
// served reply page. Pure.

/** What the lane has learned about this route's pagination. Durable, because
 *  the discovery is expensive and must be announced exactly once. */
export type RepliesPaginationMode = "unproven" | "before" | "single_page";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/**
 * The `posts[]` rows of a reply page.
 *
 * `null` means "this is not a reply page" — a shape the walk refuses to read as
 * an answer. An empty array means "no replies", which INCLUDES the adapter's
 * `{__empty: true}` marker for a 204 or a zero-length body. The live "no
 * replies" is a 200 with an empty `posts[]`; the marker has never been served,
 * so the walk flags it (`fansly_replies_empty_body`) and the parser never
 * marks a comment missing from it.
 */
export function replyRows(payload: unknown): Record<string, unknown>[] | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  if (record.__empty === true) {
    return [];
  }
  if (!Array.isArray(record.posts)) {
    return null;
  }
  return record.posts.filter((row): row is Record<string, unknown> => asRecord(row) !== null);
}

export function classifyPostRepliesResponse(payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => replyRows(value) !== null,
    isEmpty: (value) => replyRows(value)?.length === 0,
  });
}

/** The cursor the NEXT page would carry: the last reply's own id. Replies come
 *  back descending by id, which is what makes `before` the plausible form. */
export function nextRepliesCursor(rows: readonly Record<string, unknown>[]): string | null {
  const last = rows[rows.length - 1];
  return last === undefined ? null : asNullableString(last.id);
}

/**
 * The p99 of the observed page sizes, by nearest-rank.
 *
 * It is a NAMED criterion of the cap raise (100 → 300/day): "measured
 * `posts.length` p99 known". Reporting it from the lane is what makes that
 * criterion checkable without a bespoke query.
 */
export function p99PostsLength(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(sorted.length * 0.99);
  return sorted[Math.max(0, rank - 1)] ?? null;
}
