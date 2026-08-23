// WP-F5 — the `fansly-comments` canonicalizer family (v1, projection-only).
//
// ONE observation kind, `post_replies`, and two event types. The interesting
// part is not the row parsing — it is that this family reads an observation
// whose payload is an ENVELOPE, and why it has to.
//
// ── WHY THE OBSERVATION CARRIES THE REQUEST ─────────────────────────────────
//
// `GET /post/{postId}/replies` puts the post id in the PATH and returns a body
// that names it only through the replies' own `inReplyTo`. So the one response
// that matters most — the EMPTY one, "this post has no comments any more" — is
// a body with no way to tell which post it is about. A parser reading the body
// alone could store comments but could never mark one deleted, which is the
// whole `missing_since` half of this package.
//
// The lane therefore journals the verbatim (post-[A20]) body into
// `sync_raw_payloads.response_payload` as always, AND gives the OBSERVATION an
// envelope `{walk: {postId, before}, response: <that same body>}` through
// `persistRawPayload`'s `observationPayload` seam — the mechanism `posts.ts`
// already uses for a response a future parser needs request context to replay.
// Nothing is lost and nothing is invented: both halves are journaled.
//
// ── THE TWO EVENTS ──────────────────────────────────────────────────────────
//
// `post.comment_observed` per reply, dedup-keyed on the comment's CONTENT hash
// so an edit appends a new event (a revision) while a re-read of the same bytes
// appends nothing.
//
// `post.comment_list_observed` per walk — the ROSTER, and the same idea WP-F3
// arrived at: row events say what IS, and nothing in them says what ISN'T. A
// post whose comments were all deleted serves an EMPTY `posts[]` and produces
// no row events at all, so without a roster its stored comments would read as
// live forever. The roster carries the full ref set the walk served; the
// projector marks the complement `missing_since` and clears the mark on
// everything the roster still names. Keyed per LOOK (the observation id), for
// the reason F3 had to correct: a comment deleted and restored UNCHANGED hashes
// to the roster it had before it vanished, so a set-hash key dedupes the event
// and the row stays marked forever.
//
// ── TRUNCATION HONESTY, which is what makes the roster safe ─────────────────
//
// `/post/{id}/replies` has NO PROVEN PAGINATION. Five live responses carried
// 1, 1, 1, 1 and 4 replies; no cursor has ever been exercised. A page that
// comes back suspiciously full, or a page fetched WITH a cursor, is marked
// `possiblyTruncated` — and a truncated roster's complement is not knowable, so
// the projector is forbidden from marking anything missing from it. It may
// still CLEAR marks on the refs such a page names, because that direction is
// safe in both worlds.
//
// ── TIME, AND MONEY ─────────────────────────────────────────────────────────
//
// RECEIPT-TIME (§3.2b): `occurredAt` is the observation's `receivedAt` and the
// provider instant is typed in `data`. `createdAt` on this route is epoch
// SECONDS (verified across all five live responses). A receipt-time draft is by
// construction inside `clampDraftOccurredAt`'s window, so an event from this
// family can NEVER carry `occurredAtClamped` — a fixture asserts exactly that,
// because `domain_events` is monthly-partitioned and a 2023 comment dated at
// provider time would fail `ExecFindPartition` (23514) forever.
//
// `totalTipAmount` and `attachmentTipAmount` are already MILLS on the wire and
// travel as decimal strings built by the shared constructors (Stage 27). They
// are kept apart, never summed: a tip on the comment and a tip on the comment's
// attachment have different bases (§2.3).

import {
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";
import { contentHash, millsString, nonNegativeCount, recordArray } from "./sync-pull.ts";

export const FANSLY_COMMENTS_CANONICALIZER_VERSION = 1;
const SCHEMA_VERSION = 1;

/** The `observations.kind` this family claims. Registered in
 *  `observation-kinds.ts`; the ratchet fails otherwise. */
export const FANSLY_COMMENTS_CANONICALIZED_KINDS = ["post_replies"] as const;

const CANONICALIZED_KIND_SET: ReadonlySet<string> = new Set(FANSLY_COMMENTS_CANONICALIZED_KINDS);

/**
 * How many replies in one page make it SUSPICIOUSLY FULL.
 *
 * Not a server page size — nobody has observed one. The largest live response
 * carried FOUR replies, so a page of twenty is far outside anything the route
 * has ever done and is the first honest signal that a limit exists. It is the
 * threshold the walk uses to attempt a cursor, and the threshold this parser
 * uses to mark its rows `possiblyTruncated`; the two must be the same number,
 * which is why it lives here (the parser is the authority on what a body means)
 * and the lane imports it.
 */
export const REPLIES_FULL_PAGE_THRESHOLD = 20;

export const FANSLY_COMMENTS_EVENT_TYPES = [
  "post.comment_observed",
  "post.comment_list_observed",
] as const;

/** The walk context the lane journals beside the body. */
interface WalkEnvelope {
  postId: string;
  before: string | null;
}

function walkEnvelope(payload: unknown): WalkEnvelope | null {
  if (!isRecord(payload) || !isRecord(payload.walk)) {
    return null;
  }
  const postId = asString(payload.walk.postId);
  if (postId === null) {
    return null;
  }
  return { postId, before: asString(payload.walk.before) };
}

/**
 * The reply rows this response served.
 *
 * `null` means "this body is not a reply page at all" — refused by the shape
 * gate and left unstamped for a future parser. An EMPTY ARRAY means "no
 * replies", which is a legitimate, load-bearing answer: it is what marks a
 * post's stored comments missing.
 */
function replyRows(response: unknown): Record<string, unknown>[] | null {
  // The adapter's honest empty answer for a 204 or a zero-length body. Not
  // live-proven — no GET in the capture ever returned 204 — and treated as
  // "no replies" exactly like an empty `posts[]`.
  if (isRecord(response) && response.__empty === true) {
    return [];
  }
  if (!isRecord(response) || !Array.isArray(response.posts)) {
    return null;
  }
  return recordArray(response.posts);
}

/** The `accounts[]` sidecar, indexed by account ref. It was EMPTY in 2 of 5
 *  captured responses despite a comment existing, which is why every display
 *  field this family emits is optional and why the lane has a hydration
 *  fallback at all. */
function accountIndex(response: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  if (!isRecord(response)) {
    return index;
  }
  for (const account of recordArray(response.accounts)) {
    const ref = asString(account.id);
    if (ref !== null) {
      index.set(ref, account);
    }
  }
  return index;
}

function pageRefOf(observation: CanonicalizableObservation): string {
  return String(observation.accountId);
}

export function canParseFanslyCommentsObservation(
  observation: Pick<CanonicalizableObservation, "kind" | "payload" | "accountId">,
): boolean {
  if (!CANONICALIZED_KIND_SET.has(observation.kind) || observation.accountId === null) {
    return false;
  }
  if (!isRecord(observation.payload) || walkEnvelope(observation.payload) === null) {
    return false;
  }
  // A body we cannot recognize is left UNSTAMPED rather than consumed with zero
  // events — otherwise a drifted payload is indistinguishable from a post whose
  // comments were all deleted, and "capture now, parse later" quietly becomes
  // "capture now, mark everything missing".
  return replyRows(observation.payload.response) !== null;
}

export function canonicalizeFanslyCommentsObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (observation.accountId === null) {
    return [];
  }
  const walk = walkEnvelope(observation.payload);
  if (walk === null || !isRecord(observation.payload)) {
    return [];
  }
  const response = observation.payload.response;
  const rows = replyRows(response);
  if (rows === null) {
    return [];
  }

  const pageRef = pageRefOf(observation);
  const accounts = accountIndex(response);
  // A page fetched WITH a cursor is part of a walk whose extent this one
  // response cannot establish, so its rows carry the same doubt a full page
  // does. Over-marking here is deliberate: `possiblyTruncated` is a claim about
  // what we can PROVE, and one response can prove nothing about a second page
  // on a route whose pagination has never been observed.
  const possiblyTruncated = rows.length >= REPLIES_FULL_PAGE_THRESHOLD || walk.before !== null;

  const drafts: CanonicalEventDraft[] = [];
  const refs: string[] = [];

  for (const row of rows) {
    const commentRef = asString(row.id);
    const authorRef = asString(row.accountId);
    if (commentRef === null || authorRef === null) {
      continue;
    }
    // `inReplyTo` is the parent. It is absent from no observed reply, but the
    // walk's own post id is the honest fallback: we asked for THIS post's
    // replies and the platform answered.
    const parentPostRef = asString(row.inReplyTo) ?? walk.postId;
    const account = accounts.get(authorRef);
    const createdAtSeconds = asNumber(row.createdAt);
    const material = {
      parentPostRef,
      // Journaled SEPARATELY even though it equalled `parentPostRef` in every
      // observed reply: the day a nested reply arrives, the difference is what
      // reconstructs the thread, and no re-walk recovers it retroactively.
      rootRef: asString(row.inReplyToRoot),
      commentRef,
      authorRef,
      // Present only when the `accounts[]` sidecar was populated — it was EMPTY
      // in 2 of 5 live responses.
      authorUsername: account === undefined ? null : asString(account.username),
      authorDisplayName: account === undefined ? null : asString(account.displayName),
      // EMPTY-CONTENT REPLIES ARE KEPT. One of the four replies in the 18 KB
      // live capture has `content: ""`; a fan who replied with only an
      // attachment still replied, and dropping the row would make the reply
      // count disagree with the archive with no way to tell which is wrong.
      textPlain: typeof row.content === "string" ? row.content : "",
      // SECONDS on this route, typed here rather than guessed downstream.
      publishedAtSeconds: createdAtSeconds,
      publishedAt: createdAtSeconds === null || createdAtSeconds <= 0
        ? null
        : new Date(createdAtSeconds * 1000).toISOString(),
      likeCount: nonNegativeCount(row.likeCount),
      mediaLikeCount: nonNegativeCount(row.mediaLikeCount),
      // MILLS, through the shared constructor. Two bases, never summed.
      tipTotalMills: millsString(row.totalTipAmount),
      attachmentTipMills: millsString(row.attachmentTipAmount),
      attachmentCount: Array.isArray(row.attachments) ? row.attachments.length : null,
      pinned: typeof row.pinned === "boolean" ? row.pinned : null,
      possiblyTruncated,
    };
    const hash = contentHash(material);
    refs.push(commentRef);
    drafts.push({
      type: "post.comment_observed",
      // RECEIPT TIME (§3.2b) — the provider instant is `publishedAt` above.
      occurredAt: observation.receivedAt,
      postRef: parentPostRef,
      data: { ...material, contentHash: hash },
      schemaVersion: SCHEMA_VERSION,
      // AN EDIT IS A REVISION: the hash is over the comment's material, so an
      // edited body appends a new event and the head moves, while the fortieth
      // re-read of unchanged bytes appends nothing.
      dedupKey: `comment:v1:${pageRef}:${commentRef}:${hash}`,
    });
  }

  drafts.push(listDraft(observation, walk, refs, possiblyTruncated));
  return drafts;
}

/**
 * The roster: "this walk of THIS post served exactly these comment refs".
 *
 * `refs` is what makes `missing_since` computable — the plan's field list names
 * only `{parentPostRef, count}`, and a count cannot identify a complement. It
 * is sorted so a provider that reorders its replies produces the same hash.
 *
 * ONE ROSTER PER LOOK (the observation id is in the key), which is WP-F3's
 * correction applied here: a comment deleted and restored unchanged produces a
 * roster identical to the one before it vanished, so a set-hash key would
 * dedupe the event and leave the row marked forever.
 */
function listDraft(
  observation: CanonicalizableObservation,
  walk: WalkEnvelope,
  refs: readonly string[],
  possiblyTruncated: boolean,
): CanonicalEventDraft {
  const pageRef = pageRefOf(observation);
  const sorted = [...new Set(refs)].sort();
  const material = {
    parentPostRef: walk.postId,
    refs: sorted,
    count: sorted.length,
    // The projector may only mark a complement missing when this is FALSE. A
    // truncated page's complement is unknowable, and guessing it would delete
    // an archive one page at a time.
    possiblyTruncated,
    cursor: walk.before,
  };
  const hash = contentHash(material);
  return {
    type: "post.comment_list_observed",
    occurredAt: observation.receivedAt,
    postRef: walk.postId,
    data: { ...material, contentHash: hash },
    schemaVersion: SCHEMA_VERSION,
    dedupKey: `commentlist:v1:${pageRef}:${walk.postId}:${observation.id}:${hash}`,
  };
}
