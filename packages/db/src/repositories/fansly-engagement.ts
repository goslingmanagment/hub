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
