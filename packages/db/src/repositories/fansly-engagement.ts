// WP-F2 engagement writers (migration 0134).
//
// THE ONE RULE THAT MAKES THIS FILE DIFFERENT FROM `fansly-stats.ts`:
// **head precedence is the PROVIDER's `occurred_at`, never `account_seq`, and
// never the observation instant.**
//
// `fansly-stats.ts` guards on `last_observed_at` because a statistics head
// means "the latest capture wins" — a restated bucket is a correction of what
// we looked at. A notification-fed head is a STATE MACHINE (like/undo,
// purchase) and must be ordered by when the EVENT happened. The two are not
// interchangeable, and the reason this lane cannot use the other rule is
// physical: WP-F2's deep backfill walks BACKWARDS, so it appends OLDER facts at
// HIGHER account_seq and at a LATER observation instant. Either of the other
// two guards would let a year-old like overwrite today's undo.
//
// `notification_ref` is the deterministic tie-break for two facts at the same
// instant. It is a snowflake id, so lexicographic order within one length is
// chronological — the tie-break only has to be STABLE, and it is.
//
// ONE EXCEPTION, `platform_notifications`: its row IS one notification
// (keyed by its ref), and two looks at the same `createdAt` are the same
// notification at two moments — the later look carries the platform's
// current read state (`acknowledgedAt`). There, and only there, the
// observation instant breaks the provider-instant tie. The backfill argument
// above is about DIFFERENT facts on one state machine (post_likes); it
// cannot apply within one notification's own read state, and an older look
// replayed later still loses on its older observation instant.
//
// Everything else follows the house shape: guarded upsert returning `applied`,
// `first_observed_at` only ever moves backwards, NULL is never coalesced to 0,
// and the raw type code is stored rather than a label (A22-2).

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";
import { MEDIA_STATS_QUEUE_ORIGINS } from "./media-plane.ts";

export type EngagementPlatform = "fansly" | "onlyfans";

export interface EngagementLineage {
  /** The observation instant. Lineage only — it is NEVER the precedence key. */
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

/**
 * The precedence guard, stated once. Excluded wins on a LATER PROVIDER instant,
 * or on the same instant with a higher notification ref.
 *
 * `coalesce(excluded.notification_ref, '')` keeps a NULL ref from making the
 * whole comparison NULL (which reads as false and would silently pin the head).
 */
function providerNewerWins(table: string) {
  const current = sql.identifier(table);
  return sql`
    excluded.occurred_at > ${current}.occurred_at
    or (
      excluded.occurred_at = ${current}.occurred_at
      and coalesce(excluded.notification_ref, '') > coalesce(${current}.notification_ref, '')
    )
  `;
}

function pickByProviderTime(table: string, column: string): SQL {
  const current = sql.identifier(table);
  const name = sql.identifier(column);
  return sql`case when ${providerNewerWins(table)} then excluded.${name} else ${current}.${name} end`;
}

// ── platform_notifications ───────────────────────────────────────────────────

export interface UpsertPlatformNotificationInput extends EngagementLineage {
  pageId: number;
  platform: EngagementPlatform;
  notificationRef: string;
  /** The RAW code. Never a label. */
  typeCode: number;
  correlationRef: string | null;
  correlationGroupRef: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  acknowledgedAt: Date | null;
}

/**
 * The verbatim archive row. Keyed by `(page_id, notification_ref)`, so the same
 * notification arriving on two overlapping pages of the forward poll updates
 * ONE row — that is the id dedupe the overlap walk depends on.
 *
 * The guard still matters on a single-keyed row: a restated `createdAt` is a
 * correction, and an older restatement replayed at a higher seq must not win.
 *
 * At the SAME `createdAt` the later look wins (the file header's one
 * exception): the platform serves a notification unread and then read, and
 * a guard on the provider instant alone froze the head at the first look, so
 * `acknowledged_at` stayed NULL forever. `>=` keeps a replay of the head's
 * own event idempotent.
 */
export async function upsertPlatformNotification(
  db: Database,
  input: UpsertPlatformNotificationInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged" | "deferred" | "erasure_fenced"; applied: false }
> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.pageId))) {
      return { status: "deferred", applied: false } as const;
    }
    if (await isPlatformNotificationErasureFenced(database, input)) {
      return { status: "erasure_fenced", applied: false } as const;
    }
    return upsertPlatformNotificationUnfenced(database, input);
  });
}

/**
 * The erasure scope fence `upsertPlatformNotification` applies: an erasure of
 * the notification's actor (or its page) that started after the notification
 * was material refuses the row. A read; exported so a dry-run can count what
 * the upsert would refuse.
 */
export async function isPlatformNotificationErasureFenced(
  db: Database,
  input: Pick<
    UpsertPlatformNotificationInput,
    "pageId" | "platform" | "typeCode" | "correlationRef" | "correlationGroupRef" | "occurredAt" | "observedAt"
  >,
): Promise<boolean> {
  const materialAt = input.occurredAt < input.observedAt
    ? input.occurredAt
    : input.observedAt;
  const actorRef = input.typeCode === 3002
    ? input.correlationRef
    : input.correlationGroupRef;
  return isDmArchiveScopeFenced(db, {
    pageId: input.pageId,
    platform: input.platform,
    refs: [actorRef],
    materialAt,
  });
}

async function upsertPlatformNotificationUnfenced(
  db: Database,
  input: UpsertPlatformNotificationInput,
): Promise<
  | { status: "applied"; applied: true }
  | { status: "unchanged"; applied: false }
> {
  const current = sql.identifier("platform_notifications");
  // The PK already fixes `notification_ref`, so the ref tie-break can never
  // discriminate here. The tie-break is the LOOK instant instead: `excluded.
  // last_observed_at` is this event's observation instant, and the row's is
  // the latest look seen so far. Every column goes through one guard, so
  // `acknowledged_at` never splits from its `content_hash` and lineage.
  const newerWins = sql`(
    excluded.occurred_at > ${current}.occurred_at
    or (
      excluded.occurred_at = ${current}.occurred_at
      and excluded.last_observed_at >= ${current}.last_observed_at
    )
  )`;
  const pick = (column: string) => {
    const name = sql.identifier(column);
    return sql`case when ${newerWins} then excluded.${name} else ${current}.${name} end`;
  };
  const result = await db.execute(sql`
    insert into platform_notifications (
      page_id, platform, notification_ref, type_code, correlation_ref,
      correlation_group_ref, metadata, occurred_at, acknowledged_at,
      first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.notificationRef}, ${input.typeCode},
      ${input.correlationRef}, ${input.correlationGroupRef},
      ${JSON.stringify(input.metadata)}::jsonb, ${input.occurredAt}, ${input.acknowledgedAt},
      ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, notification_ref) do update set
      type_code = ${pick("type_code")},
      correlation_ref = ${pick("correlation_ref")},
      correlation_group_ref = ${pick("correlation_group_ref")},
      metadata = ${pick("metadata")},
      occurred_at = ${pick("occurred_at")},
      acknowledged_at = ${pick("acknowledged_at")},
      content_hash = ${pick("content_hash")},
      source_event_id = ${pick("source_event_id")},
      source_observation_id = ${pick("source_observation_id")},
      source_account_seq = ${pick("source_account_seq")},
      first_observed_at =
        least(platform_notifications.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(platform_notifications.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return (result.rowCount ?? 0) > 0
    ? { status: "applied", applied: true }
    : { status: "unchanged", applied: false };
}

// ── post_likes ───────────────────────────────────────────────────────────────

export interface UpsertPostLikeInput extends EngagementLineage {
  pageId: number;
  platform: EngagementPlatform;
  subjectKind: "post" | "media" | "message";
  subjectRef: string;
  likerPlatformUserId: string;
  state: "active" | "undone";
  occurredAt: Date;
  notificationRef: string | null;
  discoveredVia: "notification" | "ofapi_webhook";
}

/**
 * The liker head. NOTHING in WP-F2 calls this: no Fansly like code is
 * live-confirmed ([E4]), and a test pins that a 2007 purchase writes nothing
 * here. It exists complete because the OF `posts.liked` webhook populates the
 * same table, and because a table that arrives later arrives without its
 * precedence rule tested.
 */
export async function upsertPostLike(
  db: Database,
  input: UpsertPostLikeInput,
): Promise<{ applied: boolean }> {
  return db.transaction(async tx => {
    const writer=tx as unknown as Database;
    if(!await tryAcquireDmArchiveWriterFenceLock(writer,input.pageId)) throw new Error("Post-like projection deferred by erasure");
    if(await isDmArchiveScopeFenced(writer,{pageId:input.pageId,platform:input.platform,refs:[input.likerPlatformUserId],materialAt:new Date(Math.min(input.occurredAt.getTime(),input.observedAt.getTime()))})) return {applied:false};
  const result = await writer.execute(sql`
    insert into post_likes (
      page_id, platform, subject_kind, subject_ref, liker_platform_user_id,
      state, occurred_at, notification_ref, discovered_via,
      first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.subjectKind}, ${input.subjectRef},
      ${input.likerPlatformUserId}, ${input.state}, ${input.occurredAt},
      ${input.notificationRef}, ${input.discoveredVia},
      ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, subject_kind, subject_ref, liker_platform_user_id) do update set
      state = ${pickByProviderTime("post_likes", "state")},
      occurred_at = ${pickByProviderTime("post_likes", "occurred_at")},
      notification_ref = ${pickByProviderTime("post_likes", "notification_ref")},
      discovered_via = ${pickByProviderTime("post_likes", "discovered_via")},
      content_hash = ${pickByProviderTime("post_likes", "content_hash")},
      source_event_id = ${pickByProviderTime("post_likes", "source_event_id")},
      source_observation_id = ${pickByProviderTime("post_likes", "source_observation_id")},
      source_account_seq = ${pickByProviderTime("post_likes", "source_account_seq")},
      first_observed_at = least(post_likes.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(post_likes.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
  });
}

// ── subject_refresh_state (capture-plane operational state, §3.4) ────────────

export type LegacySubjectRefreshPlane =
  | "media_stats"
  | "post_replies"
  | "post_engagement"
  | "of_post_stats";

export type SubjectRefreshPlane = LegacySubjectRefreshPlane
  | "fan_earnings_lifetime" | "fan_earnings_monthly" | "fan_earnings_attribution";

export type SubjectRefreshClass = "fresh" | "mid" | "long_tail" | "dirty";

export interface MarkSubjectDirtyInput {
  pageId: number;
  plane: LegacySubjectRefreshPlane;
  subjectRef: string;
  dirtyReason: string;
  /** When the lane should visit it. `now` for a commerce signal. */
  nextDueAt: Date;
}

/**
 * Mark a subject DIRTY so the lane that owns its plane visits it next.
 *
 * The unconditional mark, and it FETCHES NOTHING. WP-F2's purchase signal goes
 * through `markMediaStatsPurchaseDirty`, which adds the guards a purchase needs
 * (too old, already answered, a bundle ref). The mark is idempotent — a second
 * signal on the same subject re-marks the same row rather than queueing twice.
 *
 * `next_due_at` moves EARLIER only. A row already due sooner is not pushed back
 * by a later signal: dirty means "visit it", and the earliest claim wins.
 * `consecutive_failures` is deliberately untouched — it belongs to the lane
 * that does the fetching.
 */
export async function markSubjectRefreshDirty(
  db: Database,
  input: MarkSubjectDirtyInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at, dirty_reason
    ) values (
      ${input.pageId}, ${input.plane}, ${input.subjectRef}, 'dirty',
      ${input.nextDueAt}, ${input.dirtyReason}
    )
    on conflict (page_id, plane, subject_ref) do update set
      refresh_class = 'dirty',
      next_due_at = least(
        coalesce(subject_refresh_state.next_due_at, excluded.next_due_at),
        excluded.next_due_at
      ),
      dirty_reason = excluded.dirty_reason,
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface SubjectRefreshStateRow {
  pageId: number;
  plane: string;
  subjectRef: string;
  refreshClass: string | null;
  nextDueAt: Date | null;
  lastVisitedAt: Date | null;
  consecutiveFailures: number;
  dirtyReason: string | null;
  knownCount: number | null;
  backfillCursor: Record<string, unknown>;
}

/** Read side, for the lanes that consume the queue and for the tests that
 *  prove a rebuild never truncates it. */
export async function listSubjectRefreshState(
  db: Database,
  input: { pageId: number; plane?: SubjectRefreshPlane },
): Promise<SubjectRefreshStateRow[]> {
  const planeFilter = input.plane === undefined
    ? sql``
    : sql` and plane = ${input.plane}`;
  const result = await db.execute<{
    page_id: string | number;
    plane: string;
    subject_ref: string;
    refresh_class: string | null;
    next_due_at: Date | string | null;
    last_visited_at: Date | string | null;
    consecutive_failures: number | string;
    dirty_reason: string | null;
    known_count: number | string | null;
    backfill_cursor: Record<string, unknown> | null;
  }>(sql`
    select page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at,
           consecutive_failures, dirty_reason, known_count, backfill_cursor
      from subject_refresh_state
     where page_id = ${input.pageId}${planeFilter}
     order by subject_refresh_state.plane, subject_refresh_state.subject_ref
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    plane: row.plane,
    subjectRef: row.subject_ref,
    refreshClass: row.refresh_class,
    nextDueAt: row.next_due_at === null ? null : new Date(row.next_due_at),
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at),
    consecutiveFailures: Number(row.consecutive_failures),
    dirtyReason: row.dirty_reason,
    knownCount: row.known_count === null ? null : Number(row.known_count),
    backfillCursor: row.backfill_cursor ?? {},
  }));
}

// ── the post_replies walk queue (WP-F5) ──────────────────────────────────────
//
// SAME TABLE, SECOND PLANE. WP-F2 writes `plane='media_stats'` dirty marks and
// fetches nothing; WP-F5 writes and reads `plane='post_replies'`, where one row
// = one root post and `known_count` = the reply count that walk last saw.
//
// It lives here rather than in a twin table for the reason §3.4 gives: a queue
// column riding on the rebuildable `creator_posts` would be wiped by an ordinary
// `projection:rebuild`, resetting every walk to never-visited and re-releasing a
// full first-pass crawl of the whole back-catalogue. This table is capture-plane
// operational state and no rebuild truncates it.
//
// It is a QUEUE, not a scheduler: no reservations, no leases, no settlement.
// The stream lease the executor already holds is what makes one page's walk
// single-threaded, and these rows only remember where it got to.

/** ONE bound parameter carrying a Postgres array literal, then cast. Drizzle
 *  expands a bare array into a parameter LIST, so an EMPTY one becomes a syntax
 *  error at runtime — which is exactly the case a first seeding hits when the
 *  page has no posts yet. */
function subjectRefArrayParam(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

export interface SeedPostRepliesWalkQueueInput {
  pageId: number;
  /** Keyset cursor: only posts whose ref sorts ABOVE this are considered. */
  afterSubjectRef: string | null;
  /** Bounded batch — a page with 8 000 posts seeds over several dispatches
   *  rather than in one statement that holds a lock for a second. */
  limit: number;
  /** When the newly seeded rows first become due. */
  dueAt: Date;
}

/**
 * Seed one bounded batch of walk rows from `creator_posts`.
 *
 * KEYSET, not offset: the post ref is a snowflake and therefore both unique and
 * monotonic, so `> cursor` resumes exactly where the last batch stopped even
 * though rows are being inserted underneath it. An OFFSET walk over a growing
 * table skips rows silently, which on this lane means posts that are never
 * walked and nothing that ever notices.
 *
 * The cursor returned is the LAST REF SCANNED, not the last ref inserted: a
 * batch that hits only rows already queued still advances, or the seeding
 * re-reads the same prefix forever.
 */
export async function seedPostRepliesWalkQueue(
  db: Database,
  input: SeedPostRepliesWalkQueueInput,
): Promise<{ scanned: number; inserted: number; cursor: string | null }> {
  const after = input.afterSubjectRef ?? "";
  const scan = await db.execute<{ platform_post_id: string }>(sql`
    select p.platform_post_id
      from creator_posts p
     where p.account_id = ${input.pageId}
       and p.platform = 'fansly'
       and p.platform_post_id > ${after}
     order by p.platform_post_id asc
     limit ${input.limit}
  `);
  const refs = scan.rows.map((row) => row.platform_post_id);
  if (refs.length === 0) {
    return { scanned: 0, inserted: 0, cursor: input.afterSubjectRef };
  }
  const inserted = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at
    )
    select ${input.pageId}, 'post_replies', ref, 'fresh', ${input.dueAt}
      from unnest(${subjectRefArrayParam(refs)}) as ref
    on conflict (page_id, plane, subject_ref) do nothing
  `);
  return {
    scanned: refs.length,
    inserted: inserted.rowCount ?? 0,
    cursor: refs[refs.length - 1] ?? input.afterSubjectRef,
  };
}

/**
 * Seed ONE walk row, idempotently — the same-transaction hook the creator-posts
 * projector calls for every post it upserts.
 *
 * Why in the projector's transaction and not on a timer: a post that appears
 * between two seeding sweeps would otherwise wait a whole sweep to become
 * walkable, and a sweep that is itself bounded by a daily call budget may be
 * days away. A newly projected post is queued the instant its row exists or it
 * is not queued at all.
 */
export async function ensurePostRepliesWalkRow(
  db: Database,
  input: { pageId: number; subjectRef: string; dueAt: Date },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at
    ) values (
      ${input.pageId}, 'post_replies', ${input.subjectRef}, 'fresh', ${input.dueAt}
    )
    on conflict (page_id, plane, subject_ref) do nothing
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * A position in a subject-queue walk's own order (Fansly Sync Engine, design
 * §4.3): the ordering keys of the last subject a walk took, exactly as the
 * database computed them (timestamps as epoch text, so a microsecond is never
 * rounded away and a subject is never taken twice). Opaque to callers: a
 * chunk function hands one out with every candidate and takes one back as
 * `after`, which returns only the subjects that sort after it. The shadow
 * engine steps through the due subjects this way without writing the queue.
 */
export type SubjectQueueKeyset = string;

type KeysetPart = number | string;

function encodeSubjectQueueKeyset(parts: readonly KeysetPart[]): SubjectQueueKeyset {
  return JSON.stringify(parts);
}

/** The parts of a keyset this file handed out, checked against the layout of
 *  the function it is given back to. */
function decodeSubjectQueueKeyset(token: SubjectQueueKeyset, layout: readonly ("int" | "numeric" | "text")[]): KeysetPart[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    parsed = null;
  }
  const valid = Array.isArray(parsed) && parsed.length === layout.length && parsed.every((part, index) => {
    switch (layout[index]) {
      case "int":
        return typeof part === "number" && Number.isSafeInteger(part);
      case "numeric":
        return typeof part === "string" && /^(-?Infinity|-?\d+(\.\d+)?)$/.test(part);
      default:
        return typeof part === "string";
    }
  });
  if (!valid) throw new RangeError(`Not a subject-queue keyset of this walk: ${token}`);
  return parsed as KeysetPart[];
}

/** `(k1, …, kn) > (a1, …, an)` in a walk's order, as nested comparisons: each
 *  key with its own direction, the last one (the subject ref) descending. */
function keysetAfter(keys: readonly { expr: SQL; value: SQL }[], subjectRef: SQL, after: SQL): SQL {
  let predicate = sql`${subjectRef} < ${after}`;
  for (const key of [...keys].reverse()) {
    predicate = sql`(${key.expr} > ${key.value} or (${key.expr} = ${key.value} and ${predicate}))`;
  }
  return predicate;
}

export interface PostRepliesWalkCandidate {
  subjectRef: string;
  knownCount: number | null;
  dirtyReason: string | null;
  lastVisitedAt: Date | null;
  consecutiveFailures: number;
  /** 0 never-walked, 1 dirty, 2 round-robin re-walk. */
  priorityBand: number;
  /** This subject's position in the walk order (pass it back as `after`). */
  keyset: SubjectQueueKeyset;
}

/**
 * The chunk's work list, in the priority order WP-F5 declares:
 *
 *   (1) NEVER-WALKED, newest post first — a comment archive that starts with
 *       the posts nobody remembers is useless for a year.
 *   (2) DIRTY — a head `reply_count` change or a comment-signal notification
 *       said this post's replies moved.
 *   (3) ROUND-ROBIN RE-WALK of rows whose last visit is older than the cycle,
 *       oldest first.
 *
 * The band is recomputed in ORDER BY rather than read back as a SELECT alias:
 * a bare column name in ORDER BY resolves to the alias, a trap that has shipped
 * twice in this tree, so every ordering key here is either a qualified column
 * or the expression itself.
 *
 * SUCCESS DUE-NESS is `last_visited_at` against a caller-supplied cutoff, not
 * `next_due_at`, and that is deliberate. `fanslyRepliesRewalkCycleDays` is a
 * LIVE config key: reading the success row's stored due time would freeze its
 * cycle at the value in force when it was last walked. Failure rows are the
 * exception: success resets `consecutive_failures` to zero, while a failure
 * must wait for its stored `next_due_at` backoff so dead posts cannot keep band
 * zero and starve healthy subjects.
 *
 * `after` (optional, the Fansly Sync Engine's shadow walk): only the subjects
 * that sort after that keyset, in the same order. Without it the statement
 * selects exactly what it always did.
 */
export async function listPostRepliesWalkChunk(
  db: Database,
  input: { pageId: number; limit: number; rewalkBefore: Date; now?: Date; after?: SubjectQueueKeyset | null },
): Promise<PostRepliesWalkCandidate[]> {
  const band = sql`
    case
      when s.last_visited_at is null then 0
      when s.dirty_reason is not null then 1
      else 2
    end
  `;
  // The ordering keys as ascending numerics (a NULL where ORDER BY puts it).
  const publishedKey = sql`coalesce(-extract(epoch from case when s.last_visited_at is null then p.published_at end), 'Infinity'::numeric)`;
  const visitedKey = sql`coalesce(extract(epoch from s.last_visited_at), '-Infinity'::numeric)`;
  let afterPredicate = sql``;
  if (input.after !== undefined && input.after !== null) {
    const [afterBand, afterPublished, afterVisited, afterRef] = decodeSubjectQueueKeyset(input.after, ["int", "numeric", "numeric", "text"]);
    afterPredicate = sql`and ${keysetAfter([
      { expr: band, value: sql`${afterBand}::int` },
      { expr: publishedKey, value: sql`${afterPublished}::numeric` },
      { expr: visitedKey, value: sql`${afterVisited}::numeric` },
    ], sql`s.subject_ref`, sql`${afterRef}::text`)}`;
  }
  const result = await db.execute<{
    subject_ref: string;
    known_count: number | string | null;
    dirty_reason: string | null;
    last_visited_at: Date | string | null;
    consecutive_failures: number | string;
    priority_band: number | string;
    published_key: string;
    visited_key: string;
  }>(sql`
    select s.subject_ref,
           s.known_count,
           s.dirty_reason,
           s.last_visited_at,
           s.consecutive_failures,
           ${band} as priority_band,
           ${publishedKey}::text as published_key,
           ${visitedKey}::text as visited_key
      from subject_refresh_state s
      left join creator_posts p
        on p.account_id = s.page_id
       and p.platform_post_id = s.subject_ref
     where s.page_id = ${input.pageId}
       and s.plane = 'post_replies'
       and (
         s.consecutive_failures = 0
         or s.next_due_at <= ${input.now ?? new Date()}
       )
       and (
         s.last_visited_at is null
         or s.dirty_reason is not null
         or s.last_visited_at < ${input.rewalkBefore}
       )
       ${afterPredicate}
     order by ${band} asc,
              case when s.last_visited_at is null then p.published_at end desc nulls last,
              s.last_visited_at asc nulls first,
              s.subject_ref desc
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    subjectRef: row.subject_ref,
    knownCount: row.known_count === null ? null : Number(row.known_count),
    dirtyReason: row.dirty_reason,
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at),
    consecutiveFailures: Number(row.consecutive_failures),
    priorityBand: Number(row.priority_band),
    keyset: encodeSubjectQueueKeyset([Number(row.priority_band), row.published_key, row.visited_key, row.subject_ref]),
  }));
}

/**
 * Record a completed walk. The visit is what clears the dirty mark — nothing
 * else does, so a signal can never be lost between "marked" and "fetched".
 */
export async function recordPostRepliesWalkVisit(
  db: Database,
  input: {
    pageId: number;
    subjectRef: string;
    knownCount: number;
    visitedAt: Date;
    nextDueAt: Date;
  },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at,
      known_count, dirty_reason, consecutive_failures
    ) values (
      ${input.pageId}, 'post_replies', ${input.subjectRef}, 'long_tail',
      ${input.nextDueAt}, ${input.visitedAt}, ${input.knownCount}, null, 0
    )
    on conflict (page_id, plane, subject_ref) do update set
      refresh_class = 'long_tail',
      next_due_at = excluded.next_due_at,
      last_visited_at = excluded.last_visited_at,
      known_count = excluded.known_count,
      dirty_reason = null,
      consecutive_failures = 0,
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Record a walk that did NOT produce an answer.
 *
 * `last_visited_at` deliberately does NOT move: a failed look is not a look, and
 * moving it would retire the post from the never-walked band on the strength of
 * an error. What moves is the failure counter, which is what a later operator
 * reads to tell "this post is unreachable" from "we have not got to it yet".
 */
export async function recordPostRepliesWalkFailure(
  db: Database,
  input: { pageId: number; subjectRef: string; nextDueAt: Date },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at, consecutive_failures
    ) values (
      ${input.pageId}, 'post_replies', ${input.subjectRef}, 'fresh',
      ${input.nextDueAt}, 1
    )
    on conflict (page_id, plane, subject_ref) do update set
      next_due_at = excluded.next_due_at,
      consecutive_failures = subject_refresh_state.consecutive_failures + 1,
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/** Coverage arithmetic for the lane's progress block: how many roots the queue
 *  holds, how many have ever been walked, and how many are waiting on a dirty
 *  signal. `rootsKnown` counts the QUEUE, not `creator_posts`, so a seeding that
 *  has not finished reads as incomplete rather than as complete-and-small. */
export async function countPostRepliesWalkProgress(
  db: Database,
  pageId: number,
): Promise<{ rootsKnown: number; rootsWalked: number; rootsDirty: number; postsKnown: number }> {
  const result = await db.execute<{
    roots: string;
    walked: string;
    dirty: string;
    posts: string;
  }>(sql`
    select
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_replies') as roots,
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_replies'
          and s.last_visited_at is not null) as walked,
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_replies'
          and s.dirty_reason is not null) as dirty,
      (select count(*)::text from creator_posts p
        where p.account_id = ${pageId} and p.platform = 'fansly') as posts
  `);
  const row = result.rows[0];
  return {
    rootsKnown: Number(row?.roots ?? 0),
    rootsWalked: Number(row?.walked ?? 0),
    rootsDirty: Number(row?.dirty ?? 0),
    postsKnown: Number(row?.posts ?? 0),
  };
}

// ── the post_engagement refresh queue (WP-F6) ────────────────────────────────
//
// SAME TABLE, THIRD PLANE. Where `post_replies` walks a post's comments once and
// re-walks on a cycle, this plane RE-READS a post's own counters on a DECAY: the
// numbers on a post published this morning move all day, and the numbers on a
// post from two years ago move once a quarter. A flat re-read cycle would spend
// the day's calls proving that the back catalogue did not change.
//
// The tier boundaries below are CONSTANTS, not config keys, and deliberately so:
// they describe how engagement on a post decays with its age, which is a
// property of the platform rather than a knob an operator should be turning. The
// one number that IS tunable is the daily call budget, which decides how much of
// the decay the lane can afford — exactly the split §6.1 asks for.

/** Fresh: published within 30 days — re-read DAILY. */
export const POST_ENGAGEMENT_FRESH_DAYS = 30;
/** Mid: 31–180 days — re-read WEEKLY. */
export const POST_ENGAGEMENT_MID_DAYS = 180;
/** Long tail: older than 180 days — re-read every 30 days, round-robin by
 *  `last_visited_at ASC`. "Monthly" is honest only while the queue is smaller
 *  than 30 days of batches; the lane reports its own due backlog rather than
 *  claiming a cycle it cannot fund. */
export const POST_ENGAGEMENT_FRESH_INTERVAL_DAYS = 1;
export const POST_ENGAGEMENT_MID_INTERVAL_DAYS = 7;
export const POST_ENGAGEMENT_LONG_TAIL_INTERVAL_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

export type PostEngagementTier = "fresh" | "mid" | "long_tail";

/** The tier a post sits in, from its publication age. Exported because the
 *  handler needs it to compute the row's next due date after a visit, and
 *  because a boundary that lives in two places drifts. */
export function postEngagementTier(publishedAt: Date | null, now: Date): PostEngagementTier {
  if (publishedAt === null) {
    // Publication date unknown ⇒ treat it as fresh rather than inventing an age.
    // The same rule WP-F4 states for media first seen in stats aggregation.
    return "fresh";
  }
  const ageDays = (now.getTime() - publishedAt.getTime()) / DAY_MS;
  if (ageDays <= POST_ENGAGEMENT_FRESH_DAYS) return "fresh";
  if (ageDays <= POST_ENGAGEMENT_MID_DAYS) return "mid";
  return "long_tail";
}

export function postEngagementIntervalDays(tier: PostEngagementTier): number {
  return tier === "fresh"
    ? POST_ENGAGEMENT_FRESH_INTERVAL_DAYS
    : tier === "mid"
      ? POST_ENGAGEMENT_MID_INTERVAL_DAYS
      : POST_ENGAGEMENT_LONG_TAIL_INTERVAL_DAYS;
}

/**
 * Seed one bounded batch of engagement rows from `creator_posts`.
 *
 * The `post_replies` seeding's twin, and keyset for the same reason: the post
 * ref is a snowflake, so `> cursor` resumes exactly where the last batch stopped
 * even as posts are inserted underneath it, and the cursor returned is the last
 * ref SCANNED rather than the last inserted — a batch that hits only rows
 * already queued still has to advance or the sweep re-reads the same prefix
 * forever. Costs ZERO platform calls.
 */
export async function seedPostEngagementQueue(
  db: Database,
  input: {
    pageId: number;
    afterSubjectRef: string | null;
    limit: number;
    dueAt: Date;
  },
): Promise<{ scanned: number; inserted: number; cursor: string | null }> {
  const after = input.afterSubjectRef ?? "";
  const scan = await db.execute<{ platform_post_id: string }>(sql`
    select p.platform_post_id
      from creator_posts p
     where p.account_id = ${input.pageId}
       and p.platform = 'fansly'
       and p.platform_post_id > ${after}
     order by p.platform_post_id asc
     limit ${input.limit}
  `);
  const refs = scan.rows.map((row) => row.platform_post_id);
  if (refs.length === 0) {
    return { scanned: 0, inserted: 0, cursor: input.afterSubjectRef };
  }
  const inserted = await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at
    )
    select ${input.pageId}, 'post_engagement', ref, 'fresh', ${input.dueAt}
      from unnest(${subjectRefArrayParam(refs)}) as ref
    on conflict (page_id, plane, subject_ref) do nothing
  `);
  return {
    scanned: refs.length,
    inserted: inserted.rowCount ?? 0,
    cursor: refs[refs.length - 1] ?? input.afterSubjectRef,
  };
}

export interface PostEngagementRefreshCandidate {
  subjectRef: string;
  publishedAt: Date | null;
  lastVisitedAt: Date | null;
  dirtyReason: string | null;
  consecutiveFailures: number;
  tier: PostEngagementTier;
  /** 0 never refreshed, 1 dirty, 2 due by its tier's decay. */
  priorityBand: number;
  /** This subject's position in the refresh order (pass it back as `after`). */
  keyset: SubjectQueueKeyset;
}

/**
 * The chunk's refresh list, in the decay order WP-F6 declares.
 *
 * SUCCESS DUE-NESS IS COMPUTED FROM `published_at` AND `last_visited_at` AGAINST
 * `now`, not read from `next_due_at`. Same reasoning as the replies walk: the
 * tier a post belongs to changes as the post AGES, so a stored due date freezes
 * each row's cadence at the tier it was in when it was last visited — a post that
 * crossed from fresh into mid would keep being re-read daily forever. The column
 * is still maintained (it is the shared table's contract and what its partial
 * index covers) and the DIRTY path is read through `dirty_reason`, which no
 * cutoff can suppress. Failure rows are the exception, as in the replies walk:
 * success resets `consecutive_failures` to zero, while a failure waits for its
 * stored `next_due_at` backoff, so an unserved or failing batch cannot hold band
 * zero — or the head of the due band — and re-send the same ids until the cap.
 *
 * Every ordering key is a qualified column or the expression itself: a bare
 * column name in ORDER BY resolves to a SELECT alias, a trap that has shipped
 * twice in this tree.
 *
 * `after` (optional, the Fansly Sync Engine's shadow walk): only the posts
 * that sort after that keyset, in the same order. Without it the statement
 * selects exactly what it always did.
 */
export async function listPostEngagementRefreshChunk(
  db: Database,
  input: { pageId: number; limit: number; now: Date; after?: SubjectQueueKeyset | null },
): Promise<PostEngagementRefreshCandidate[]> {
  const tier = sql`
    case
      when p.published_at is null then 'fresh'
      when p.published_at >= ${new Date(input.now.getTime() - POST_ENGAGEMENT_FRESH_DAYS * DAY_MS)}
        then 'fresh'
      when p.published_at >= ${new Date(input.now.getTime() - POST_ENGAGEMENT_MID_DAYS * DAY_MS)}
        then 'mid'
      else 'long_tail'
    end
  `;
  const dueCutoff = sql`
    case ${tier}
      when 'fresh' then ${
    new Date(input.now.getTime() - POST_ENGAGEMENT_FRESH_INTERVAL_DAYS * DAY_MS)
  }::timestamptz
      when 'mid' then ${
    new Date(input.now.getTime() - POST_ENGAGEMENT_MID_INTERVAL_DAYS * DAY_MS)
  }::timestamptz
      else ${
    new Date(input.now.getTime() - POST_ENGAGEMENT_LONG_TAIL_INTERVAL_DAYS * DAY_MS)
  }::timestamptz
    end
  `;
  const band = sql`
    case
      when s.last_visited_at is null then 0
      when s.dirty_reason is not null then 1
      else 2
    end
  `;
  const tierRank = sql`case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end`;
  // The ordering keys as ascending numerics (a NULL where ORDER BY puts it).
  const visitedKey = sql`coalesce(extract(epoch from s.last_visited_at), '-Infinity'::numeric)`;
  const publishedKey = sql`coalesce(-extract(epoch from p.published_at), 'Infinity'::numeric)`;
  let afterPredicate = sql``;
  if (input.after !== undefined && input.after !== null) {
    const [afterBand, afterTier, afterVisited, afterPublished, afterRef] = decodeSubjectQueueKeyset(
      input.after,
      ["int", "int", "numeric", "numeric", "text"],
    );
    afterPredicate = sql`and ${keysetAfter([
      { expr: band, value: sql`${afterBand}::int` },
      { expr: tierRank, value: sql`${afterTier}::int` },
      { expr: visitedKey, value: sql`${afterVisited}::numeric` },
      { expr: publishedKey, value: sql`${afterPublished}::numeric` },
    ], sql`s.subject_ref`, sql`${afterRef}::text`)}`;
  }
  const result = await db.execute<{
    subject_ref: string;
    published_at: Date | string | null;
    last_visited_at: Date | string | null;
    dirty_reason: string | null;
    consecutive_failures: number | string;
    tier: string;
    priority_band: number | string;
    tier_rank: number | string;
    visited_key: string;
    published_key: string;
  }>(sql`
    select s.subject_ref,
           p.published_at,
           s.last_visited_at,
           s.dirty_reason,
           s.consecutive_failures,
           ${tier} as tier,
           ${band} as priority_band,
           ${tierRank} as tier_rank,
           ${visitedKey}::text as visited_key,
           ${publishedKey}::text as published_key
      from subject_refresh_state s
      join creator_posts p
        on p.account_id = s.page_id
       and p.platform_post_id = s.subject_ref
     where s.page_id = ${input.pageId}
       and s.plane = 'post_engagement'
       and (
         s.consecutive_failures = 0
         or s.next_due_at <= ${input.now}
       )
       and (
         s.last_visited_at is null
         or s.dirty_reason is not null
         or s.last_visited_at < ${dueCutoff}
       )
       ${afterPredicate}
     order by ${band} asc,
              case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end asc,
              s.last_visited_at asc nulls first,
              p.published_at desc nulls last,
              s.subject_ref desc
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    subjectRef: row.subject_ref,
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at),
    dirtyReason: row.dirty_reason,
    consecutiveFailures: Number(row.consecutive_failures),
    tier: row.tier === "mid" ? "mid" : row.tier === "long_tail" ? "long_tail" : "fresh",
    priorityBand: Number(row.priority_band),
    keyset: encodeSubjectQueueKeyset([
      Number(row.priority_band),
      Number(row.tier_rank),
      row.visited_key,
      row.published_key,
      row.subject_ref,
    ]),
  }));
}

/**
 * Record a completed engagement refresh for one batch of posts.
 *
 * ONE statement for the whole batch: a `GET /post?ids=` call answers for up to a
 * hundred posts at once, and a per-row round trip would make the bookkeeping
 * cost more than the egress. The visit is what clears the dirty mark — nothing
 * else does, so a signal can never be lost between "marked" and "fetched".
 *
 * `refresh_class` is written as the tier the post is in TODAY, which is how a
 * post ages out of `fresh` without anything sweeping it.
 */
export async function recordPostEngagementRefreshVisits(
  db: Database,
  input: {
    pageId: number;
    visits: ReadonlyArray<{
      subjectRef: string;
      tier: PostEngagementTier;
      nextDueAt: Date;
    }>;
    visitedAt: Date;
  },
): Promise<{ applied: number }> {
  if (input.visits.length === 0) {
    return { applied: 0 };
  }
  const refs = subjectRefArrayParam(input.visits.map((visit) => visit.subjectRef));
  const tiers = subjectRefArrayParam(input.visits.map((visit) => visit.tier));
  const dueLiteral = subjectRefArrayParam(
    input.visits.map((visit) => visit.nextDueAt.toISOString()),
  );
  const result = await db.execute(sql`
    update subject_refresh_state s
       set refresh_class = v.tier,
           next_due_at = v.next_due_at,
           last_visited_at = ${input.visitedAt},
           dirty_reason = null,
           consecutive_failures = 0,
           updated_at = now()
      from (
        select ref, tier, next_due_at::timestamptz as next_due_at
          from unnest(${refs}, ${tiers}, ${dueLiteral}) as t(ref, tier, next_due_at)
      ) as v
     where s.page_id = ${input.pageId}
       and s.plane = 'post_engagement'
       and s.subject_ref = v.ref
  `);
  return { applied: result.rowCount ?? 0 };
}

/**
 * Record a batch whose call did NOT produce an answer.
 *
 * `last_visited_at` deliberately does NOT move: a failed look is not a look, and
 * moving it would retire the post from the never-refreshed band on the strength
 * of an error. What moves is the failure counter — the number an operator reads
 * to tell "this post is unreachable" from "we have not got to it yet" — and
 * `next_due_at`, which is the backoff the chunk query enforces.
 */
export async function recordPostEngagementRefreshFailures(
  db: Database,
  input: { pageId: number; subjectRefs: readonly string[]; nextDueAt: Date },
): Promise<{ applied: number }> {
  if (input.subjectRefs.length === 0) {
    return { applied: 0 };
  }
  const result = await db.execute(sql`
    update subject_refresh_state s
       set next_due_at = ${input.nextDueAt},
           consecutive_failures = s.consecutive_failures + 1,
           updated_at = now()
      from unnest(${subjectRefArrayParam(input.subjectRefs)}) as ref
     where s.page_id = ${input.pageId}
       and s.plane = 'post_engagement'
       and s.subject_ref = ref
  `);
  return { applied: result.rowCount ?? 0 };
}

/** Coverage arithmetic for the phase's progress block. `postsKnown` counts
 *  `creator_posts` so a seeding that has not finished reads as incomplete
 *  rather than as complete-and-small. */
export async function countPostEngagementRefreshProgress(
  db: Database,
  pageId: number,
): Promise<{
  subjectsKnown: number;
  subjectsRefreshed: number;
  subjectsDirty: number;
  postsKnown: number;
}> {
  const result = await db.execute<{
    subjects: string;
    refreshed: string;
    dirty: string;
    posts: string;
  }>(sql`
    select
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_engagement') as subjects,
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_engagement'
          and s.last_visited_at is not null) as refreshed,
      (select count(*)::text from subject_refresh_state s
        where s.page_id = ${pageId} and s.plane = 'post_engagement'
          and s.dirty_reason is not null) as dirty,
      (select count(*)::text from creator_posts p
        where p.account_id = ${pageId} and p.platform = 'fansly') as posts
  `);
  const row = result.rows[0];
  return {
    subjectsKnown: Number(row?.subjects ?? 0),
    subjectsRefreshed: Number(row?.refreshed ?? 0),
    subjectsDirty: Number(row?.dirty ?? 0),
    postsKnown: Number(row?.posts ?? 0),
  };
}

// ── the media_stats refresh queue (WP-F4) ────────────────────────────────────
//
// SAME TABLE, FOURTH PLANE, and the one with the widest fan-out: one row per
// MEDIA OFFER, over the whole catalogue, re-read on a cadence that decays with
// the item's age. `known_count` is the number of buckets the last visit saw and
// `backfill_cursor` carries the per-media first-sight walk.
//
// WP-F2 has been writing rows into this plane since it shipped — a purchase
// notification marks the bought media `refresh_class='dirty'` with
// `dirty_reason='purchase_notification'` and fetches nothing. This is the
// consumer those marks were waiting for, and the FIRST priority band below is
// exactly them.
//
// The tier boundaries are CONSTANTS, not config keys, and deliberately so:
// they describe how a media item's traffic decays with its age, which is a
// property of the platform rather than a knob an operator should be turning.
// TWO numbers are tunable and only two — the daily call budget, which decides
// how much of the decay the lane can afford, and the long-tail cycle, which A6
// explicitly asks to be a tunable rather than a constant.

/** Fresh: published (or first seen) within 30 days — re-read DAILY. */
export const MEDIA_STATS_FRESH_DAYS = 30;
/** Mid: 31–180 days — re-read WEEKLY. */
export const MEDIA_STATS_MID_DAYS = 180;
export const MEDIA_STATS_FRESH_INTERVAL_DAYS = 1;
export const MEDIA_STATS_MID_INTERVAL_DAYS = 7;
/** The DEFAULT long-tail cycle. The live value is
 *  `fanslyMediaStatsLongTailCycleDays` and every query below takes it as an
 *  argument — a stored cadence would freeze each row at whatever the cycle was
 *  when it was last visited. */
export const MEDIA_STATS_DEFAULT_LONG_TAIL_CYCLE_DAYS = 30;
/** How far back each tier's steady refresh reads: the lane's trailing windows
 *  (`steadyWindows`), stated here because the queue orders by them. A split
 *  long tail reads 3 × 31 = 93 days, never less than these 90. */
export const MEDIA_STATS_FRESH_SPAN_DAYS = 31;
export const MEDIA_STATS_MID_SPAN_DAYS = 30;
export const MEDIA_STATS_LONG_TAIL_SPAN_DAYS = 90;
/** An overdue item whose last visit is within this many days of its span's far
 *  end is AT THE EDGE of its window, and goes ahead of the never-visited ones. */
export const MEDIA_STATS_WINDOW_EDGE_MARGIN_DAYS = 7;

export type MediaStatsTier = "fresh" | "mid" | "long_tail";

/**
 * The instant before which an item's last visit is at the EDGE of its tier's
 * window: seven days short of the span its next refresh reads. `tier` is the
 * item's tier as the calling query computes it.
 */
function mediaStatsWindowEdge(tier: SQL, now: Date): SQL {
  const edge = (spanDays: number) =>
    new Date(now.getTime() - Math.max(0, spanDays - MEDIA_STATS_WINDOW_EDGE_MARGIN_DAYS) * DAY_MS);
  return sql`
    case ${tier}
      when 'fresh' then ${edge(MEDIA_STATS_FRESH_SPAN_DAYS)}::timestamptz
      when 'mid' then ${edge(MEDIA_STATS_MID_SPAN_DAYS)}::timestamptz
      else ${edge(MEDIA_STATS_LONG_TAIL_SPAN_DAYS)}::timestamptz
    end
  `;
}

/**
 * Where the age came from, carried through to the handler and its journal.
 *
 * `first_seen` is not a worse `platform` — it is a DIFFERENT claim, and the one
 * rule that governs it is that we never invent a publication date. Every live
 * `creator_media` row carries `created_at_platform` today (0 NULL across the
 * fleet, 2026-08-22); media first seen only in a statistics aggregation may not,
 * and those are classed FRESH for 30 days from first sight.
 */
export type MediaStatsPublicationBasis = "platform" | "first_seen";

/** The tier an item sits in, from its publication age. Exported because the
 *  handler needs it to compute the next due date after a visit, and because a
 *  boundary that lives in two places drifts. */
export function mediaStatsTier(
  publicationAt: Date | null,
  now: Date,
): MediaStatsTier {
  if (publicationAt === null) {
    // No date at all ⇒ treat it as fresh rather than inventing an age.
    return "fresh";
  }
  const ageDays = (now.getTime() - publicationAt.getTime()) / DAY_MS;
  if (ageDays <= MEDIA_STATS_FRESH_DAYS) return "fresh";
  if (ageDays <= MEDIA_STATS_MID_DAYS) return "mid";
  return "long_tail";
}

export function mediaStatsIntervalDays(
  tier: MediaStatsTier,
  longTailCycleDays: number,
): number {
  return tier === "fresh"
    ? MEDIA_STATS_FRESH_INTERVAL_DAYS
    : tier === "mid"
      ? MEDIA_STATS_MID_INTERVAL_DAYS
      : Math.max(1, longTailCycleDays);
}

/**
 * Seed one bounded batch of media rows from `creator_media`.
 *
 * The `post_replies`/`post_engagement` seeding's twin, keyset for the same
 * reason: the media offer ref is a snowflake, so `> cursor` resumes exactly
 * where the last batch stopped even as rows are inserted underneath it, and the
 * cursor returned is the last ref SCANNED rather than the last inserted — a
 * batch that hits only rows already queued, or only heads the origin rule below
 * skips, still has to advance or the sweep re-reads the same prefix forever.
 * Costs ZERO platform calls.
 *
 * `refresh_class` is seeded `fresh` and then RECOMPUTED at read time from the
 * item's age (see the chunk query): a class stored at seed time would freeze
 * every item in the tier it happened to be in on the day the lane was enabled.
 *
 * ONLY HEADS FIRST SEEN FROM AN ORIGIN THE ENQUEUE QUEUES
 * (`MEDIA_STATS_QUEUE_ORIGINS`) — the rule `upsertCreatorMedia` applies to an
 * observation, read here from the head's `first_origin`. A head first
 * seen in a DM, the vault or the purchase history is skipped: the page's own
 * DM PPV, whose per-media views are not wanted (owner decision 2026-09-29), and
 * the media fans sent in DMs. Seeding them would put a fresh never-visited row
 * ahead of every overdue post item until someone re-ran the prunes. Such a
 * head that a post ALSO shows needs no seed: the media plane projects every
 * post observation whether or not this lane is enabled, and
 * `upsertCreatorMedia` queues it there. So what the sweep inserts is a subset
 * of what `fansly:media-stats-prune-dm-only` keeps, and a re-seed after that
 * prune adds nothing back.
 *
 * Known gap: `creator_media` keeps no owner, so a head another account owns
 * that was first seen on a post would still be seeded (production: none; every
 * foreign-only head was first seen in a DM). `fansly:media-stats-prune-foreign`
 * removes it.
 */
export async function seedMediaStatsQueue(
  db: Database,
  input: {
    pageId: number;
    afterSubjectRef: string | null;
    limit: number;
    dueAt: Date;
  },
): Promise<{ scanned: number; inserted: number; cursor: string | null }> {
  const after = input.afterSubjectRef ?? "";
  const scan = await db.execute<{ media_offer_ref: string; first_origin: string }>(sql`
    select m.media_offer_ref, m.first_origin
      from creator_media m
     where m.page_id = ${input.pageId}
       and m.platform = 'fansly'
       and m.media_offer_ref > ${after}
     order by m.media_offer_ref asc
     limit ${input.limit}
  `);
  const refs = scan.rows.map((row) => row.media_offer_ref);
  if (refs.length === 0) {
    return { scanned: 0, inserted: 0, cursor: input.afterSubjectRef };
  }
  const queued = scan.rows
    .filter((row) => MEDIA_STATS_QUEUE_ORIGINS.has(row.first_origin))
    .map((row) => row.media_offer_ref);
  const inserted = queued.length === 0 ? null : await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, refresh_class, next_due_at
    )
    select ${input.pageId}, 'media_stats', ref, 'fresh', ${input.dueAt}
      from unnest(${subjectRefArrayParam(queued)}) as ref
    on conflict (page_id, plane, subject_ref) do nothing
  `);
  return {
    scanned: refs.length,
    inserted: inserted?.rowCount ?? 0,
    cursor: refs[refs.length - 1] ?? input.afterSubjectRef,
  };
}

/**
 * Mark the page's CURRENT top-50 media dirty, once per sweep day.
 *
 * "Which content performs" is answered for free by the account response's
 * `topMediaOffers`/`topFypMediaOffers`, which WP-F1 projects into
 * `stats_top_media`. An item that has just ENTERED that top-50 is the one whose
 * per-media series is worth having today rather than on its class cadence — so
 * it jumps to the front of this lane's queue exactly the way a purchase signal
 * does.
 *
 * ONLY items whose visit is not already fresher than the window that named
 * them: re-marking an item visited an hour ago would spend a call to re-read
 * numbers we already have, every single day, for fifty items.
 */
export async function markMediaStatsTopMediaDirty(
  db: Database,
  input: {
    pageId: number;
    /** The most recent top-N window to read. 50 is the platform's own page. */
    limit: number;
    dueAt: Date;
    /** Items visited at or after this instant are left alone. */
    visitedSince: Date;
  },
): Promise<{ marked: number }> {
  const result = await db.execute(sql`
    with latest as (
      select t.media_offer_ref
        from stats_top_media t
       where t.page_id = ${input.pageId}
         and t.requested_end = (
           select max(inner_top.requested_end)
             from stats_top_media inner_top
            where inner_top.page_id = ${input.pageId}
         )
       order by t.rank asc
       limit ${input.limit}
    )
    update subject_refresh_state s
       set refresh_class = 'dirty',
           dirty_reason = 'top_media',
           next_due_at = least(
             coalesce(s.next_due_at, ${input.dueAt}),
             ${input.dueAt}
           ),
           updated_at = now()
      from latest
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = latest.media_offer_ref
       and s.dirty_reason is null
       and (s.last_visited_at is null or s.last_visited_at < ${input.visitedSince})
  `);
  return { marked: result.rowCount ?? 0 };
}

/**
 * How old a purchase may be, measured at RECEIPT, and still mark its media
 * dirty: the widest steady window the media lane reads (the 90-day long-tail
 * refresh). A refresh the mark triggers cannot reach a purchase older than
 * that, and the deep notification backfill delivers year-old purchases every
 * week. Measured against receipt, not `now`, so a replay decides the same way.
 */
export const MEDIA_STATS_PURCHASE_SIGNAL_HORIZON_DAYS = 90;

/**
 * WP-F2's purchase signal: "somebody bought this, its counters moved — worth a
 * call TODAY". Mark the bought media DIRTY in the `media_stats` plane, due at
 * the purchase instant. It FETCHES NOTHING.
 *
 * Only a signal that can still move a number the lane has not read:
 *
 * - A purchase more than `MEDIA_STATS_PURCHASE_SIGNAL_HORIZON_DAYS` older than
 *   its receipt marks nothing (no row is created either).
 * - A row VISITED AT OR AFTER the purchase is not re-marked: its numbers already
 *   include it. The top-50 mark has the same guard, for the same reason. This
 *   is also what keeps a truncate-and-replay of the engagement projection from
 *   re-dirtying every answered item.
 * - A ref the page already knows as a BUNDLE is not a media subject — the route
 *   reads media offers — so it is not marked. Its members are not marked either.
 *
 * AND IT ONLY EVER MARKS A ROW THAT IS ALREADY QUEUED. Deciding what is queued
 * is `upsertCreatorMedia`'s job, and a purchase of a ref it has not queued
 * cannot tell a post's media from a DM PPV — whose per-media views are not
 * wanted (owner decision 2026-09-29), and which is most of what is bought: in
 * production 181 of 194 media purchases in 30 days were not on a post. So such
 * a purchase marks nothing. The one case that costs something is a post's
 * media bought before its head is projected: the post's head queues it later
 * WITHOUT the mark, and it is visited as a never-visited fresh item — the first
 * thing after the dirty rows anyway. `next_due_at` moves EARLIER only, and
 * `consecutive_failures` is left to the lane that fetches.
 */
export async function markMediaStatsPurchaseDirty(
  db: Database,
  input: {
    pageId: number;
    subjectRef: string;
    /** The provider's purchase instant, or the receipt when it served none. */
    purchasedAt: Date;
    /** When the notification was received — the event's own instant. */
    receivedAt: Date;
  },
): Promise<{ applied: boolean }> {
  const horizon = new Date(
    input.receivedAt.getTime() - MEDIA_STATS_PURCHASE_SIGNAL_HORIZON_DAYS * DAY_MS,
  );
  if (input.purchasedAt.getTime() < horizon.getTime()) {
    return { applied: false };
  }
  const result = await db.execute(sql`
    update subject_refresh_state s
       set refresh_class = 'dirty',
           next_due_at = least(
             coalesce(s.next_due_at, ${input.purchasedAt}),
             ${input.purchasedAt}
           ),
           dirty_reason = 'purchase_notification',
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = ${input.subjectRef}
       and (s.last_visited_at is null or s.last_visited_at < ${input.purchasedAt})
       and not exists (
         select 1 from creator_media_bundles b
          where b.page_id = ${input.pageId}
            and b.bundle_ref = ${input.subjectRef}
       )
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface MediaStatsRefreshCandidate {
  subjectRef: string;
  /** The platform's own publication instant, or null when it never served one. */
  createdAtPlatform: Date | null;
  /** When this system first saw the media. The fallback age basis. */
  firstSeenAt: Date | null;
  publicationBasis: MediaStatsPublicationBasis;
  tier: MediaStatsTier;
  lastVisitedAt: Date | null;
  dirtyReason: string | null;
  consecutiveFailures: number;
  knownCount: number | null;
  backfillCursor: Record<string, unknown>;
  /** 0 dirty, 1 never visited, 2 due by its tier's decay. A label for the
   *  journal: outside the dirty rows the TIER orders the chunk, not this, and
   *  within a tier a band-2 item at the edge of its window goes before band 1. */
  priorityBand: number;
  /** This item's position in the chunk order (pass it back as `after`). */
  keyset: SubjectQueueKeyset;
}

/**
 * The age tiers of the media-stats queue: an item published within
 * `freshDays` is due `freshEveryMs` after its last visit, within `midDays`
 * `midEveryMs`, older `oldEveryMs`. The default is the legacy lane's code
 * values (30 d daily, 180 d weekly, the long-tail cycle); the Fansly Sync
 * Engine passes the owner's decision №6 (30 d daily, 90 d weekly, monthly).
 */
export interface MediaStatsTiers {
  freshDays: number;
  midDays: number;
  freshEveryMs: number;
  midEveryMs: number;
  oldEveryMs: number;
}

/** The legacy lane's tiers at a long-tail cycle (`fanslyMediaStatsLongTailCycleDays`). */
export function legacyMediaStatsTiers(longTailCycleDays: number): MediaStatsTiers {
  return {
    freshDays: MEDIA_STATS_FRESH_DAYS,
    midDays: MEDIA_STATS_MID_DAYS,
    freshEveryMs: MEDIA_STATS_FRESH_INTERVAL_DAYS * DAY_MS,
    midEveryMs: MEDIA_STATS_MID_INTERVAL_DAYS * DAY_MS,
    oldEveryMs: Math.max(1, longTailCycleDays) * DAY_MS,
  };
}

/**
 * The chunk's work list, in this order:
 *
 *   (1) DIRTY — WP-F2's purchase signals and the current top-50. A purchase is
 *       the strongest evidence this system gets that an item's numbers moved,
 *       and it is the one signal that is worth a call TODAY.
 *   (2) BY TIER — fresh, then mid, then the long tail. What the creator asks
 *       about is this month's content, and a fresh item's daily read is the
 *       one a late visit turns into a hole.
 *   (3) WITHIN A TIER, AN OVERDUE ITEM AT THE EDGE OF ITS WINDOW, then NEVER
 *       VISITED, then the rest of the overdue — each by the OLDEST VISIT, the
 *       round-robin — and among first looks the NEWEST publication first.
 *
 * THE EDGE is a last visit within `MEDIA_STATS_WINDOW_EDGE_MARGIN_DAYS` of the
 * far end of the span the tier's refresh reads: 23 days for mid's 30, 24 for
 * fresh's 31, 83 for the long tail's 90 (the split plan's 93 is never less).
 * Past that span the next visit either reads the days between — more calls —
 * or, when they do not fit one visit, loses them. A never-visited item loses
 * nothing by waiting: its first visit walks its history back from that day.
 * The rest of the overdue stay BEHIND the first looks, as they were: their
 * next read still reaches their last visit, and putting every overdue item
 * first would leave a first look waiting for as long as the tier stays late —
 * production 2026-09-30 had 399 never-visited mid items on lora-1, 140 overdue
 * and 56 of those already past their 30 days. For the fresh tier the rule is
 * symmetry only: its 31 days span an item's whole life.
 *
 * Tier used to rank BELOW first sight: every never-visited item came before
 * every overdue one, whatever their ages. Production 2026-09-29 is what that
 * cost: 16 288 never-visited rows (86 % of the queue) sat in front of 247
 * overdue fresh post items, waiting a median 4.8 days for a DAILY read, and 411
 * overdue mid ones, a median 23.8 days for a WEEKLY one — 419 mid items were
 * already past the 30-day window their next read covers. The eligibility is
 * unchanged: only a dirty, never-visited or due row is admitted, which is what
 * `dueNow` counts.
 *
 * SUCCESS DUE-NESS IS COMPUTED FROM THE AGE AND `last_visited_at` AGAINST `now`,
 * not read from `next_due_at`. Same reasoning as the two post planes: the tier an
 * item belongs to changes as the item AGES and the long-tail cycle is a LIVE
 * config key, so a stored due date freezes each row's cadence at the tier and
 * the cycle in force when it was last visited. The column is still maintained —
 * it is the shared table's contract and what its partial index covers — and the
 * DIRTY path is read through `dirty_reason`, which no cutoff can suppress.
 *
 * Failure rows are the exception, the replies walk's rule: success resets
 * `consecutive_failures` to zero, while a failure waits for its stored
 * `next_due_at` backoff — in EVERY band, dirty included — so an item that fails
 * on every look cannot lead each chunk and spend the day's cap on itself. A new
 * dirty signal moves `next_due_at` earlier and so re-admits it once.
 *
 * Every ordering key is a qualified column or the expression itself: a bare
 * column name in ORDER BY resolves to a SELECT alias, a trap that has shipped
 * twice in this tree.
 *
 * Two optional inputs, for the Fansly Sync Engine (design §4.3, §5.18), both
 * absent on the legacy lane's call, which then selects exactly what it always
 * did: `tiers` replaces the age tiers and their intervals (`longTailCycleDays`
 * is then not read), and `after` returns only the items that sort after that
 * keyset, in the same order — the shadow walk's pass over the due items
 * without writing the queue.
 */
export async function listMediaStatsRefreshChunk(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    now: Date;
    longTailCycleDays: number;
    tiers?: MediaStatsTiers;
    after?: SubjectQueueKeyset | null;
  },
): Promise<MediaStatsRefreshCandidate[]> {
  const tiers = input.tiers ?? legacyMediaStatsTiers(input.longTailCycleDays);
  if (
    !(tiers.freshDays > 0 && tiers.midDays >= tiers.freshDays)
    || ![tiers.freshEveryMs, tiers.midEveryMs, tiers.oldEveryMs].every((ms) => Number.isFinite(ms) && ms > 0)
  ) {
    throw new RangeError("Media-stats tiers need 0 < freshDays <= midDays and positive intervals");
  }
  // The age basis, stated once: the platform's date when it served one, and
  // otherwise when we FIRST SAW the item. `first_observed_at` is replayed from
  // the event ledger, so it survives a `creator_media` rebuild — using the
  // queue row's own `created_at` would make a re-seed look like a fresh item.
  const publicationAt = sql`coalesce(m.created_at_platform, m.first_observed_at)`;
  const tier = sql`
    case
      when ${publicationAt} is null then 'fresh'
      when ${publicationAt} >= ${new Date(input.now.getTime() - tiers.freshDays * DAY_MS)}
        then 'fresh'
      when ${publicationAt} >= ${new Date(input.now.getTime() - tiers.midDays * DAY_MS)}
        then 'mid'
      else 'long_tail'
    end
  `;
  const dueCutoff = sql`
    case ${tier}
      when 'fresh' then ${new Date(input.now.getTime() - tiers.freshEveryMs)}::timestamptz
      when 'mid' then ${new Date(input.now.getTime() - tiers.midEveryMs)}::timestamptz
      else ${new Date(input.now.getTime() - tiers.oldEveryMs)}::timestamptz
    end
  `;
  const band = sql`
    case
      when s.dirty_reason is not null then 0
      when s.last_visited_at is null then 1
      else 2
    end
  `;
  const windowEdge = mediaStatsWindowEdge(tier, input.now);
  // The ordering keys as ascending values (a NULL where ORDER BY puts it).
  const dirtyRank = sql`case when s.dirty_reason is not null then 0 else 1 end`;
  const tierRank = sql`case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end`;
  const edgeRank = sql`
    case
      when s.last_visited_at < ${windowEdge} then 0
      when s.last_visited_at is null then 1
      else 2
    end
  `;
  const visitedKey = sql`coalesce(extract(epoch from s.last_visited_at), '-Infinity'::numeric)`;
  const publishedKey = sql`coalesce(-extract(epoch from ${publicationAt}), 'Infinity'::numeric)`;
  let afterPredicate = sql``;
  if (input.after !== undefined && input.after !== null) {
    const [afterDirty, afterTier, afterEdge, afterVisited, afterPublished, afterRef] = decodeSubjectQueueKeyset(
      input.after,
      ["int", "int", "int", "numeric", "numeric", "text"],
    );
    afterPredicate = sql`and ${keysetAfter([
      { expr: dirtyRank, value: sql`${afterDirty}::int` },
      { expr: tierRank, value: sql`${afterTier}::int` },
      { expr: edgeRank, value: sql`${afterEdge}::int` },
      { expr: visitedKey, value: sql`${afterVisited}::numeric` },
      { expr: publishedKey, value: sql`${afterPublished}::numeric` },
    ], sql`s.subject_ref`, sql`${afterRef}::text`)}`;
  }
  const result = await db.execute<{
    subject_ref: string;
    created_at_platform: Date | string | null;
    first_observed_at: Date | string | null;
    publication_at: Date | string | null;
    last_visited_at: Date | string | null;
    dirty_reason: string | null;
    consecutive_failures: number | string;
    known_count: number | string | null;
    backfill_cursor: Record<string, unknown> | null;
    tier: string;
    priority_band: number | string;
    dirty_rank: number | string;
    tier_rank: number | string;
    edge_rank: number | string;
    visited_key: string;
    published_key: string;
  }>(sql`
    select s.subject_ref,
           m.created_at_platform,
           m.first_observed_at,
           ${publicationAt} as publication_at,
           s.last_visited_at,
           s.dirty_reason,
           s.consecutive_failures,
           s.known_count,
           s.backfill_cursor,
           ${tier} as tier,
           ${band} as priority_band,
           ${dirtyRank} as dirty_rank,
           ${tierRank} as tier_rank,
           ${edgeRank} as edge_rank,
           ${visitedKey}::text as visited_key,
           ${publishedKey}::text as published_key
      from subject_refresh_state s
      join creator_media m
        on m.page_id = s.page_id
       and m.platform = 'fansly'
       and m.media_offer_ref = s.subject_ref
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and (
         s.consecutive_failures = 0
         or s.next_due_at <= ${input.now}
       )
       and (
         s.dirty_reason is not null
         or s.last_visited_at is null
         or s.last_visited_at < ${dueCutoff}
       )
       ${afterPredicate}
     order by case when s.dirty_reason is not null then 0 else 1 end asc,
              case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end asc,
              case
                when s.last_visited_at < ${windowEdge} then 0
                when s.last_visited_at is null then 1
                else 2
              end asc,
              s.last_visited_at asc nulls first,
              ${publicationAt} desc nulls last,
              s.subject_ref desc
     limit ${input.limit}
  `);
  return result.rows.map((row) => {
    // Read into a local first. `row.created_at_platform` compared inline reads
    // to the Stage 18 platform-branch ratchet as a platform comparison — it
    // greps for the literal, and a column name that ENDS in `platform` matches
    // it even though nothing here branches on one. Cheaper to name the value.
    const publishedRaw = row.created_at_platform;
    return {
      subjectRef: row.subject_ref,
    createdAtPlatform: publishedRaw === null ? null : new Date(publishedRaw),
    firstSeenAt: row.first_observed_at === null ? null : new Date(row.first_observed_at),
    publicationBasis: publishedRaw === null ? "first_seen" : "platform",
    tier: row.tier === "mid" ? "mid" : row.tier === "long_tail" ? "long_tail" : "fresh",
    lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at),
    dirtyReason: row.dirty_reason,
    consecutiveFailures: Number(row.consecutive_failures),
    knownCount: row.known_count === null ? null : Number(row.known_count),
    backfillCursor: row.backfill_cursor ?? {},
    priorityBand: Number(row.priority_band),
    keyset: encodeSubjectQueueKeyset([
      Number(row.dirty_rank),
      Number(row.tier_rank),
      Number(row.edge_rank),
      row.visited_key,
      row.published_key,
      row.subject_ref,
    ]),
    } satisfies MediaStatsRefreshCandidate;
  });
}

/**
 * Record backfill progress WITHOUT recording a visit.
 *
 * The narrow case this is still for: a walk that journaled NOTHING this visit —
 * it stopped on the repeat guard, or at the creation floor, before any egress.
 * There is no look to record, but the cursor moved and that has to be durable.
 *
 * A visit that DID fetch something goes through `recordMediaStatsVisit`, which
 * writes the same cursor and stamps `last_visited_at` besides. This function
 * used to be the only path a backfill took, and production 2026-08-22 is what
 * that cost: 1 198 calls landed on 8 media items while 5 507 queue rows still
 * read "never visited", because nothing retires an item from that band until
 * its whole history is walked.
 *
 * It resets `consecutive_failures`, so it is for a visit that did NOT fail. A
 * failed visit keeps its cursor through `recordMediaStatsBackfillCursor`, which
 * leaves the failure and its backoff standing.
 */
export async function recordMediaStatsBackfillProgress(
  db: Database,
  input: {
    pageId: number;
    subjectRef: string;
    backfillCursor: Record<string, unknown>;
  },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    update subject_refresh_state s
       set backfill_cursor = ${JSON.stringify(input.backfillCursor)}::jsonb,
           consecutive_failures = 0,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = ${input.subjectRef}
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Keep the backfill cursor of a visit that FAILED part way — and nothing else.
 *
 * A visit can journal several backfill windows and then fail: on a later
 * window, or on the tier's steady window. Those windows are captured facts, and
 * a cursor that forgot them re-read the same history on every admission
 * (production 2026-09: one backfill window re-read 32 times). So the cursor moves.
 *
 * NOTHING ELSE DOES. `consecutive_failures` and `next_due_at` are the backoff
 * `recordMediaStatsFailure` has just written; `last_visited_at` stays put
 * because a failed look is not a look; `dirty_reason` stays because a purchase
 * signal survives a failed fetch.
 */
export async function recordMediaStatsBackfillCursor(
  db: Database,
  input: {
    pageId: number;
    subjectRef: string;
    backfillCursor: Record<string, unknown>;
  },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    update subject_refresh_state s
       set backfill_cursor = ${JSON.stringify(input.backfillCursor)}::jsonb,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = ${input.subjectRef}
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Record a visit — a look that produced at least one journaled response.
 *
 * `last_visited_at` moves on EVERY such visit, a first-sight backfill window
 * included. That is what retires an item from the never-visited band, and it is
 * the whole of the round-robin's fairness: while backfill visits did not stamp
 * it, the priority re-picked the same newest items every day and 5 507 of a
 * page's 5 515 queue rows had never been looked at (production 2026-08-22).
 *
 * `refresh_class` is written as the tier the item is in TODAY, which is how an
 * item ages out of `fresh` without anything sweeping it.
 *
 * `clearDirty` is false for a visit that walked BACKFILL windows but had no
 * budget left for the tier's steady window: the dirty mark means "read this
 * item's numbers today", and old windows are not that. Clearing it there would
 * lose a purchase signal in exchange for history.
 */
export async function recordMediaStatsVisit(
  db: Database,
  input: {
    pageId: number;
    subjectRef: string;
    tier: MediaStatsTier;
    /** Buckets the visit saw — the `known_count` this plane stores. */
    knownCount: number;
    visitedAt: Date;
    nextDueAt: Date;
    backfillCursor: Record<string, unknown>;
    /** Default true: the steady refresh ran, so the mark is answered. */
    clearDirty?: boolean;
  },
): Promise<{ applied: boolean }> {
  const clearDirty = input.clearDirty !== false;
  const result = await db.execute(sql`
    update subject_refresh_state s
       set refresh_class = ${input.tier},
           next_due_at = ${input.nextDueAt},
           last_visited_at = ${input.visitedAt},
           known_count = ${input.knownCount},
           backfill_cursor = ${JSON.stringify(input.backfillCursor)}::jsonb,
           dirty_reason = ${clearDirty ? sql`null` : sql`s.dirty_reason`},
           consecutive_failures = 0,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = ${input.subjectRef}
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Record a look that did NOT produce an answer.
 *
 * `last_visited_at` deliberately does NOT move: a failed look is not a look, and
 * moving it would retire the item from the never-visited band on the strength of
 * an error. What moves is the failure counter — the number an operator reads to
 * tell "this media is unreachable" from "we have not got to it yet" — and
 * `next_due_at`, which is the backoff the chunk query enforces. The dirty mark
 * stays, so a purchase signal survives a failed fetch.
 */
export async function recordMediaStatsFailure(
  db: Database,
  input: { pageId: number; subjectRef: string; nextDueAt: Date },
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    update subject_refresh_state s
       set next_due_at = ${input.nextDueAt},
           consecutive_failures = s.consecutive_failures + 1,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and s.subject_ref = ${input.subjectRef}
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface MediaStatsRefreshProgress {
  /** M — the queue size, which is what the cadence is sized against. */
  queueSize: number;
  /** `creator_media` rows for this page. Ahead of `queueSize` while a first
   *  seeding is still running, which is what makes an unfinished seed read as
   *  incomplete rather than as complete-and-small — and ahead for good by the
   *  media seen only in DMs (a fan's, or the page's own DM PPV), which are
   *  kept but never queued. */
  mediaKnown: number;
  fresh: number;
  mid: number;
  longTail: number;
  dirty: number;
  neverVisited: number;
  /** `neverVisited` by tier, from the item's age like the classes above: what
   *  the cycle estimate prices at a first visit's cost. */
  neverVisitedByTier: { fresh: number; mid: number; longTail: number };
  /** Items whose class says they are due right now (dirty included) and that
   *  are not waiting out a failure backoff — what the chunk query admits. */
  dueNow: number;
  /** Of `dueNow`, the items whose last visit is at the edge of their tier's
   *  window — the ones the chunk puts ahead of the never-visited. */
  dueAtWindowEdge: number;
  /** Items whose first-sight backfill has reached its floor or stopped. */
  backfillComplete: number;
  /** Items whose backfill stopped because the provider would not honour the
   *  window — a hole we KNOW about, which is the point of stopping rather than
   *  looping. Surfaced so it is visible without a bespoke query. */
  backfillStopped: number;
}

/**
 * The class census the lane reports and the cycle estimate is computed from.
 *
 * The classes are recomputed here from the item's AGE, exactly as the chunk
 * query does — not read from `refresh_class`, which is only ever the tier of the
 * LAST visit and is `dirty` for anything WP-F2 marked. `dueNow` applies the
 * chunk query's failure backoff too: an item the lane will not touch today is
 * not due today.
 */
export async function countMediaStatsRefreshProgress(
  db: Database,
  input: { pageId: number; now: Date; longTailCycleDays: number },
): Promise<MediaStatsRefreshProgress> {
  const longTailDays = Math.max(1, input.longTailCycleDays);
  const freshFrom = new Date(input.now.getTime() - MEDIA_STATS_FRESH_DAYS * DAY_MS);
  const midFrom = new Date(input.now.getTime() - MEDIA_STATS_MID_DAYS * DAY_MS);
  const freshDue = new Date(input.now.getTime() - MEDIA_STATS_FRESH_INTERVAL_DAYS * DAY_MS);
  const midDue = new Date(input.now.getTime() - MEDIA_STATS_MID_INTERVAL_DAYS * DAY_MS);
  const longDue = new Date(input.now.getTime() - longTailDays * DAY_MS);
  const publicationAt = sql`coalesce(m.created_at_platform, m.first_observed_at)`;
  const tier = sql`
    case
      when ${publicationAt} is null then 'fresh'
      when ${publicationAt} >= ${freshFrom} then 'fresh'
      when ${publicationAt} >= ${midFrom} then 'mid'
      else 'long_tail'
    end
  `;
  const dueNow = sql`
    (q.consecutive_failures = 0 or q.next_due_at <= ${input.now})
    and (
      q.dirty_reason is not null
      or q.last_visited_at is null
      or (q.tier = 'fresh' and q.last_visited_at < ${freshDue})
      or (q.tier = 'mid' and q.last_visited_at < ${midDue})
      or (q.tier = 'long_tail' and q.last_visited_at < ${longDue})
    )
  `;
  const windowEdge = mediaStatsWindowEdge(sql`q.tier`, input.now);
  const result = await db.execute<{
    queue_size: string;
    fresh: string;
    mid: string;
    long_tail: string;
    dirty: string;
    never_visited: string;
    never_visited_fresh: string;
    never_visited_mid: string;
    never_visited_long_tail: string;
    due_now: string;
    due_at_window_edge: string;
    backfill_complete: string;
    backfill_stopped: string;
    media_known: string;
  }>(sql`
    with q as (
      select s.subject_ref,
             s.last_visited_at,
             s.dirty_reason,
             s.backfill_cursor,
             s.consecutive_failures,
             s.next_due_at,
             ${tier} as tier
        from subject_refresh_state s
        join creator_media m
          on m.page_id = s.page_id
         and m.platform = 'fansly'
         and m.media_offer_ref = s.subject_ref
       where s.page_id = ${input.pageId}
         and s.plane = 'media_stats'
    )
    select count(*)::text as queue_size,
           count(*) filter (where q.tier = 'fresh')::text as fresh,
           count(*) filter (where q.tier = 'mid')::text as mid,
           count(*) filter (where q.tier = 'long_tail')::text as long_tail,
           count(*) filter (where q.dirty_reason is not null)::text as dirty,
           count(*) filter (where q.last_visited_at is null)::text as never_visited,
           count(*) filter (where q.last_visited_at is null and q.tier = 'fresh')::text
             as never_visited_fresh,
           count(*) filter (where q.last_visited_at is null and q.tier = 'mid')::text
             as never_visited_mid,
           count(*) filter (where q.last_visited_at is null and q.tier = 'long_tail')::text
             as never_visited_long_tail,
           count(*) filter (where ${dueNow})::text as due_now,
           count(*) filter (
             where ${dueNow} and q.last_visited_at < ${windowEdge}
           )::text as due_at_window_edge,
           count(*) filter (where q.backfill_cursor ->> 'done' = 'true')::text
             as backfill_complete,
           count(*) filter (
             where q.backfill_cursor ->> 'stopReason' = 'window_not_honoured'
           )::text as backfill_stopped,
           (select count(*)::text from creator_media cm
             where cm.page_id = ${input.pageId} and cm.platform = 'fansly') as media_known
      from q
  `);
  const row = result.rows[0];
  return {
    queueSize: Number(row?.queue_size ?? 0),
    mediaKnown: Number(row?.media_known ?? 0),
    fresh: Number(row?.fresh ?? 0),
    mid: Number(row?.mid ?? 0),
    longTail: Number(row?.long_tail ?? 0),
    dirty: Number(row?.dirty ?? 0),
    neverVisited: Number(row?.never_visited ?? 0),
    neverVisitedByTier: {
      fresh: Number(row?.never_visited_fresh ?? 0),
      mid: Number(row?.never_visited_mid ?? 0),
      longTail: Number(row?.never_visited_long_tail ?? 0),
    },
    dueNow: Number(row?.due_now ?? 0),
    dueAtWindowEdge: Number(row?.due_at_window_edge ?? 0),
    backfillComplete: Number(row?.backfill_complete ?? 0),
    backfillStopped: Number(row?.backfill_stopped ?? 0),
  };
}
