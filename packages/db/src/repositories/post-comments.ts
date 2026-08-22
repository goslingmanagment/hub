// WP-F5 comment writers (migration 0138).
//
// The house shape, with one thing that is specific to comments.
//
// THE SHAPE (unchanged from `fansly-catalog.ts`): guarded upsert returning
// `applied`; the newer OBSERVATION wins with `source_account_seq` as the
// same-instant tie-break, because ledger order is APPEND order and a replayed
// older capture must never overwrite a fresher head; `first_observed_at` only
// ever moves backwards; NULL is never coalesced to 0.
//
// Note the deliberate difference from `fansly-engagement.ts`, which orders its
// heads by the PROVIDER's `occurred_at`: a notification-fed head is a state
// machine (like/undo) and must be ordered by when the event happened, while a
// comment head means "the latest capture of this comment wins". A comment's
// `occurred_at` is its creation instant and never moves, so ordering heads by
// it would make an edit unrepresentable.
//
// THE SPECIFIC PART — `changed_at`. Comments are EDITABLE, and an edit is a new
// content hash on the same `comment_ref`: the canonicalizer's dedup key hashes
// the content, so an edit appends a NEW event and this upsert moves the head.
// `changed_at` records when the stored content last actually changed, which is
// what tells "we re-read the same comment 40 times" apart from "the fan edited
// it". Re-observing identical bytes moves `last_observed_at` and nothing else.
//
// AND `missing_since` — the deletion story. DP 7 forbids removing a row that
// captured a fact, so a comment a later walk stops naming is MARKED, not
// deleted. `reconcilePostCommentPresence` is driven by the
// `post.comment_list_observed` roster event, so the mark is derived from the
// ledger and survives truncate-and-replay; it is not a scheduled sweep and it
// issues no DELETE. Both halves run: mark the complement, and CLEAR the mark on
// everything the roster still names — a comment that disappears and comes back
// UNCHANGED emits no row event at all (its content hash is the one it had
// before), so only the roster can un-mark it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";

export type PostCommentPlatform = "fansly" | "onlyfans";

/** Where the row came from. A partial archive has to be able to answer this,
 *  and it must not be guessable from the row's shape. */
export type PostCommentOrigin = "replies_walk" | "notification" | "ofapi_list";

export interface PostCommentLineage {
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

/** Excluded wins on a newer observation instant, or on the same instant with a
 *  higher account_seq. */
function newerWins() {
  return sql`
    excluded.last_observed_at > post_comments.last_observed_at
    or (
      excluded.last_observed_at = post_comments.last_observed_at
      and excluded.source_account_seq > post_comments.source_account_seq
    )
  `;
}

function pick(column: string): SQL {
  const name = sql.identifier(column);
  return sql`case when ${newerWins()} then excluded.${name} else post_comments.${name} end`;
}

function millsParam(value: bigint | null): SQL {
  return value === null ? sql`null` : sql`${value.toString()}::bigint`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes a syntax error at runtime on exactly the common case. An empty roster
 * is not an edge case here: it is precisely what a post whose comments were all
 * deleted serves, and it is the case `missing_since` exists for.
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

export interface UpsertPostCommentInput extends PostCommentLineage {
  pageId: number;
  platform: PostCommentPlatform;
  commentRef: string;
  /** `inReplyTo`. */
  parentPostRef: string;
  /** `inReplyToRoot`. */
  rootPostRef: string | null;
  authorRef: string;
  /** From the `accounts[]` sidecar when it was populated; NULL otherwise. */
  authorUsername: string | null;
  authorDisplayName: string | null;
  /** Empty-content replies are STORED, never skipped. */
  textPlain: string;
  likeCount: number | null;
  mediaLikeCount: number | null;
  /** MILLS. Two bases, never summed (§2.3). */
  tipTotalMills: bigint | null;
  attachmentTipMills: bigint | null;
  attachmentCount: number | null;
  pinned: boolean | null;
  /** The provider's creation instant. */
  occurredAt: Date;
  discoveredVia: PostCommentOrigin;
  /** True when the page this row came from could not be proven complete. */
  possiblyTruncated: boolean;
}

export async function upsertPostComment(
  db: Database,
  input: UpsertPostCommentInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged" | "deferred" | "erasure_fenced"; applied: false }
> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.pageId))) {
      return { status: "deferred", applied: false } as const;
    }
    const materialAt = input.occurredAt < input.observedAt
      ? input.occurredAt
      : input.observedAt;
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.pageId,
        platform: input.platform,
        refs: [input.authorRef],
        materialAt,
      })
    ) {
      return { status: "erasure_fenced", applied: false } as const;
    }
    return upsertPostCommentUnfenced(database, input);
  });
}

async function upsertPostCommentUnfenced(
  db: Database,
  input: UpsertPostCommentInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged"; applied: false }
> {
  const result = await db.execute(sql`
    insert into post_comments (
      page_id, platform, comment_ref, parent_post_ref, root_post_ref, author_ref,
      author_username, author_display_name, text_plain, like_count, media_like_count,
      tip_total_mills, attachment_tip_mills, attachment_count, pinned, occurred_at,
      changed_at, discovered_via, possibly_truncated, missing_since,
      first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.commentRef}, ${input.parentPostRef},
      ${input.rootPostRef}, ${input.authorRef}, ${input.authorUsername},
      ${input.authorDisplayName}, ${input.textPlain}, ${input.likeCount},
      ${input.mediaLikeCount}, ${millsParam(input.tipTotalMills)},
      ${millsParam(input.attachmentTipMills)}, ${input.attachmentCount}, ${input.pinned},
      ${input.occurredAt}, ${input.observedAt}, ${input.discoveredVia},
      ${input.possiblyTruncated}, null, ${input.observedAt}, ${input.observedAt},
      ${input.contentHash}, ${input.sourceEventId}, ${input.sourceObservationId},
      ${input.sourceAccountSeq}
    )
    on conflict (page_id, comment_ref) do update set
      platform = ${pick("platform")},
      parent_post_ref = ${pick("parent_post_ref")},
      root_post_ref = ${pick("root_post_ref")},
      author_ref = ${pick("author_ref")},
      author_username = ${pick("author_username")},
      author_display_name = ${pick("author_display_name")},
      text_plain = ${pick("text_plain")},
      like_count = ${pick("like_count")},
      media_like_count = ${pick("media_like_count")},
      tip_total_mills = ${pick("tip_total_mills")},
      attachment_tip_mills = ${pick("attachment_tip_mills")},
      attachment_count = ${pick("attachment_count")},
      pinned = ${pick("pinned")},
      occurred_at = ${pick("occurred_at")},
      discovered_via = ${pick("discovered_via")},
      possibly_truncated = ${pick("possibly_truncated")},
      -- AN EDIT MOVES THIS; A RE-READ DOES NOT. The hash is over the comment's
      -- material, so identical bytes re-observed for the fortieth time leave
      -- changed_at where it was and only last_observed_at advances.
      changed_at = case
        when ${newerWins()} and excluded.content_hash <> post_comments.content_hash
          then excluded.changed_at
        else post_comments.changed_at
      end,
      -- A comment that comes BACK is not missing any more. "Gone" is a state,
      -- never a tombstone.
      missing_since = case
        when ${newerWins()} then null
        else post_comments.missing_since
      end,
      content_hash = ${pick("content_hash")},
      source_event_id = ${pick("source_event_id")},
      source_observation_id = ${pick("source_observation_id")},
      source_account_seq = ${pick("source_account_seq")},
      first_observed_at = least(post_comments.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(post_comments.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning id
  `);
  return (result.rowCount ?? 0) > 0
    ? { status: "applied", applied: true }
    : { status: "unchanged", applied: false };
}

/**
 * Reconcile ONE post's comments against the roster a walk served: mark what it
 * did NOT name, clear the mark on what it did. NEVER a delete (DP 7).
 *
 * Scoped to `parent_post_ref` on purpose. The roster describes one post's reply
 * list and nothing else; a page-wide reconcile driven by one post's walk would
 * mark every other post's comments missing on the first dispatch.
 *
 * `missing_since is null` on the mark is what makes it STICKY: the instant a
 * comment FIRST went missing is the interesting one, and a second empty walk
 * must not move the timestamp forward.
 */
export async function reconcilePostCommentPresence(
  db: Database,
  input: {
    pageId: number;
    parentPostRef: string;
    presentRefs: readonly string[];
    missingSince: Date;
    /**
     * FALSE when the roster came from a page that could not be proven complete.
     *
     * A truncated page's complement is not knowable, and marking it would
     * delete an archive one page at a time. The CLEAR half still runs: a ref the
     * page DID name is present in both worlds, so un-marking it is safe whether
     * or not more pages exist.
     */
    markMissing: boolean;
  },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = input.markMissing
    ? await db.execute(sql`
    update post_comments
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and parent_post_ref = ${input.parentPostRef}
       and missing_since is null
       and not (comment_ref = any(${present}))
  `)
    : { rowCount: 0 };
  const cleared = await db.execute(sql`
    update post_comments
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and parent_post_ref = ${input.parentPostRef}
       and missing_since is not null
       and comment_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

/** How many comments this page has stored, and how many of them are marked
 *  missing — the two halves of the lane's `commentsSeen` progress figure. */
export async function countPostComments(
  db: Database,
  pageId: number,
): Promise<{ total: number; missing: number; possiblyTruncated: number }> {
  const result = await db.execute<{ total: string; missing: string; truncated: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where missing_since is not null)::text as missing,
           count(*) filter (where possibly_truncated)::text as truncated
      from post_comments
     where page_id = ${pageId}
  `);
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    missing: Number(row?.missing ?? 0),
    possiblyTruncated: Number(row?.truncated ?? 0),
  };
}

/** The author refs this page's comments name that no `fans` row covers yet —
 *  the hydration queue the walk drains through `/account?ids=`. */
export async function listUnnamedPostCommentAuthorRefs(
  db: Database,
  input: { pageId: number; limit: number },
): Promise<string[]> {
  const result = await db.execute<{ author_ref: string }>(sql`
    select distinct c.author_ref
      from post_comments c
     where c.page_id = ${input.pageId}
       and c.author_username is null
     order by c.author_ref
     limit ${input.limit}
  `);
  return result.rows.map((row) => row.author_ref);
}
