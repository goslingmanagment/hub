import { classifyFanslyResponse } from "./lane.ts";

// The post-replies rules of the Sync Engine's `post-replies.*` resources
// (resources/post-replies.ts): the `post_replies` cursor (the route's
// pagination discovery, the author lookups it remembers, the page-size
// samples) and the reads of a served reply page. Pure. The legacy
// `post_replies` lane (fansly-post-replies.ts) imports them from here until
// step 4 deletes it.

/**
 * How many looked-up author refs the cursor remembers.
 *
 * The hydration is journal-only (nothing parses `account_lookup`), so the queue
 * cannot be derived from a projection and has to live here. The cap keeps the
 * checkpoint small; eviction means a re-lookup of an old author much later,
 * which costs one call out of a hundred and captures the identity again.
 */
export const HYDRATED_AUTHOR_MEMORY = 1_000;

/** Page-size samples kept for the `p99PostsLength` progress figure. The plan
 *  asks for the p99 of `posts.length` to be MEASURED before the cap is raised;
 *  this is where the measurement comes from. */
export const POSTS_LENGTH_SAMPLE_LIMIT = 200;

// ── cursor state ─────────────────────────────────────────────────────────────

/** What the lane has learned about this route's pagination. Durable, because
 *  the discovery is expensive and must be announced exactly once. */
export type RepliesPaginationMode = "unproven" | "before" | "single_page";

export interface FanslyPostRepliesCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** Keyset cursor of the first-enable seeding sweep. */
  seedCursor: string | null;
  seedComplete: boolean;
  paginationMode: RepliesPaginationMode;
  /** The discovery anomaly is raised ONCE, ever. */
  paginationAnnounced: boolean;
  /** Author refs already looked up through `/account?ids=`. */
  hydratedAuthorRefs: string[];
  /** Observed `posts.length` values, newest last. */
  postsLengthSamples: number[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      .slice(-limit)
    : [];
}

function asPaginationMode(value: unknown): RepliesPaginationMode {
  return value === "before" || value === "single_page" ? value : "unproven";
}

export function parseFanslyPostRepliesCursorState(
  value: unknown,
): FanslyPostRepliesCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const utcDay = asNullableString(state.utcDay);
  if (utcDay === null) {
    return null;
  }
  return {
    version: 1,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    seedCursor: asNullableString(state.seedCursor),
    seedComplete: state.seedComplete === true,
    paginationMode: asPaginationMode(state.paginationMode),
    paginationAnnounced: state.paginationAnnounced === true,
    hydratedAuthorRefs: asStringList(state.hydratedAuthorRefs, HYDRATED_AUTHOR_MEMORY),
    postsLengthSamples: Array.isArray(state.postsLengthSamples)
      ? state.postsLengthSamples
        .filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item))
        .slice(-POSTS_LENGTH_SAMPLE_LIMIT)
      : [],
  };
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
