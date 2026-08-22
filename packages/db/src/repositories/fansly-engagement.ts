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
// Everything else follows the house shape: guarded upsert returning `applied`,
// `first_observed_at` only ever moves backwards, NULL is never coalesced to 0,
// and the raw type code is stored rather than a label (A22-2).

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

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
 */
export async function upsertPlatformNotification(
  db: Database,
  input: UpsertPlatformNotificationInput,
): Promise<{ applied: boolean }> {
  const current = sql.identifier("platform_notifications");
  // The head guard for this table compares `occurred_at` alone: the PK already
  // fixes `notification_ref`, so the ref tie-break can never discriminate here.
  const newerWins = sql`excluded.occurred_at > ${current}.occurred_at`;
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
  return { applied: (result.rowCount ?? 0) > 0 };
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
  const result = await db.execute(sql`
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
}

// ── subject_refresh_state (capture-plane operational state, §3.4) ────────────

export type SubjectRefreshPlane =
  | "media_stats"
  | "post_replies"
  | "post_engagement"
  | "of_post_stats";

export type SubjectRefreshClass = "fresh" | "mid" | "long_tail" | "dirty";

export interface MarkSubjectDirtyInput {
  pageId: number;
  plane: SubjectRefreshPlane;
  subjectRef: string;
  dirtyReason: string;
  /** When the lane should visit it. `now` for a commerce signal. */
  nextDueAt: Date;
}

/**
 * Mark a subject DIRTY so the lane that owns its plane visits it next.
 *
 * WP-F2's only write into this table, and it FETCHES NOTHING: a purchase
 * notification says the media's sale counters moved, WP-F4 is what acts on it.
 * The signal is idempotent — a second purchase on the same media re-marks the
 * same row rather than queueing twice.
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

export interface PostRepliesWalkCandidate {
  subjectRef: string;
  knownCount: number | null;
  dirtyReason: string | null;
  lastVisitedAt: Date | null;
  consecutiveFailures: number;
  /** 0 never-walked, 1 dirty, 2 round-robin re-walk. */
  priorityBand: number;
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
 * DUE-NESS IS `last_visited_at` AGAINST A CALLER-SUPPLIED CUTOFF, not
 * `next_due_at`, and that is deliberate. `fanslyRepliesRewalkCycleDays` is a
 * LIVE config key: reading `next_due_at` would freeze each row's cycle at the
 * value in force when it was last walked, so shortening the cycle would only
 * take effect on posts walked after the flip and lengthening it would never
 * take effect at all. The column is still maintained — it is the shared table's
 * contract and what its partial index covers — and the DIRTY path is read
 * through `dirty_reason`, which no cutoff can suppress.
 */
export async function listPostRepliesWalkChunk(
  db: Database,
  input: { pageId: number; limit: number; rewalkBefore: Date },
): Promise<PostRepliesWalkCandidate[]> {
  const band = sql`
    case
      when s.last_visited_at is null then 0
      when s.dirty_reason is not null then 1
      else 2
    end
  `;
  const result = await db.execute<{
    subject_ref: string;
    known_count: number | string | null;
    dirty_reason: string | null;
    last_visited_at: Date | string | null;
    consecutive_failures: number | string;
    priority_band: number | string;
  }>(sql`
    select s.subject_ref,
           s.known_count,
           s.dirty_reason,
           s.last_visited_at,
           s.consecutive_failures,
           ${band} as priority_band
      from subject_refresh_state s
      left join creator_posts p
        on p.account_id = s.page_id
       and p.platform_post_id = s.subject_ref
     where s.page_id = ${input.pageId}
       and s.plane = 'post_replies'
       and (
         s.last_visited_at is null
         or s.dirty_reason is not null
         or s.last_visited_at < ${input.rewalkBefore}
       )
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
