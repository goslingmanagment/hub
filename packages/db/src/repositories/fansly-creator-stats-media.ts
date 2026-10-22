// Fansly creator statistics of 2026-10 (0293), the media plane: writers of
// the typed rows of `/account/stats/media/top` and `/account/stats/media`, and
// the `creator-stats.media` walk's queue (`subject_refresh_state` plane
// `creator_stats_media`, one row per media offer). The `creator-stats.*`
// resources call them from their apply, in the transaction that journaled the
// answer.
//
// A row is replaced only by an answer received at the same instant or later
// (`upsertRows`: `captured_at`, then `observation_id`). A null counter stays
// null.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { upsertRows, type CreatorStatsLineage } from "./fansly-creator-stats.ts";

/** The walk's queue plane in `subject_refresh_state`. */
export const CREATOR_STATS_MEDIA_PLANE = "creator_stats_media";

interface MediaCountersRow {
  views: number | null;
  impressions: number | null;
  videoViews: number | null;
  completedViews: number | null;
  watchMs: number | null;
  watchPctSum: string | null;
  replays: number | null;
}

export interface CreatorStatsMediaAnswerRows {
  mediaOfferId: string;
  /** The surface the request named (-1: every surface). */
  source: number;
  /** The served window's first and last UTC day (`YYYY-MM-DD`). */
  afterDay: string;
  beforeDay: string;
  /** The UTC day of the capture: the date of an all-time totals snapshot. */
  capturedDay: string;
  daily: readonly (MediaCountersRow & {
    mediaId: string; mediaType: number | null; source: number; day: string; uniqueViewers: number | null; durationMs: number | null;
  })[];
  hourly: readonly (MediaCountersRow & { mediaId: string; mediaType: number | null; source: number; hourStart: Date })[];
  totals: readonly (MediaCountersRow & {
    mediaId: string;
    mediaType: number | null;
    source: number;
    durationMs: number | null;
    retention: readonly { percent: number; stillWatching: number }[];
    retentionSampleSize: number | null;
  })[];
  tags: readonly {
    mediaId: string;
    mediaType: number | null;
    tagId: string;
    kind: number;
    tag: string | null;
    views: number | null;
    videoViews: number | null;
    completedViews: number | null;
    watchMs: number | null;
    watchPctSum: string | null;
  }[];
  tagSeries: readonly { tagId: string; kind: number; tag: string | null; day: string; views: number | null }[];
  likes: readonly { source: number; day: string; likes: number | null; unlikes: number | null }[];
}

/** Every typed row of one `/account/stats/media` answer; the counts written per table. */
export async function upsertCreatorStatsMediaAnswer(
  db: Database,
  lineage: CreatorStatsLineage,
  answer: CreatorStatsMediaAnswerRows,
): Promise<Record<string, number>> {
  const offer = answer.mediaOfferId;
  const counters = ["views", "impressions", "video_views", "completed_views", "watch_ms", "watch_pct_sum", "replays"] as const;
  const values = (r: MediaCountersRow) => [r.views, r.impressions, r.videoViews, r.completedViews, r.watchMs, r.watchPctSum, r.replays];
  return {
    daily: await upsertRows(db, "fansly_creator_stats_media_daily", ["media_offer_id", "media_id", "source", "day"], [
      "media_offer_id", "media_id", "source", "day", "media_type", ...counters, "unique_viewers", "duration_ms",
    ], lineage, answer.daily.map((r) => [offer, r.mediaId, r.source, r.day, r.mediaType, ...values(r), r.uniqueViewers, r.durationMs])),
    hourly: await upsertRows(db, "fansly_creator_stats_media_hourly", ["media_offer_id", "media_id", "source", "hour_start"], [
      "media_offer_id", "media_id", "source", "hour_start", "media_type", ...counters,
    ], lineage, answer.hourly.map((r) => [offer, r.mediaId, r.source, r.hourStart, r.mediaType, ...values(r)])),
    totals: await upsertRows(db, "fansly_creator_stats_media_totals", ["media_offer_id", "media_id", "source", "captured_day"], [
      "media_offer_id", "media_id", "source", "captured_day", "media_type", ...counters, "duration_ms", "retention",
      "retention_sample_size",
    ], lineage, answer.totals.map((r) => [
      offer, r.mediaId, r.source, answer.capturedDay, r.mediaType, ...values(r), r.durationMs, JSON.stringify(r.retention),
      r.retentionSampleSize,
    ])),
    tags: await upsertRows(db, "fansly_creator_stats_media_tags",
      ["media_offer_id", "media_id", "source", "tag_id", "kind", "after_day", "before_day"], [
        "media_offer_id", "media_id", "source", "tag_id", "kind", "after_day", "before_day", "tag", "media_type", "views",
        "video_views", "completed_views", "watch_ms", "watch_pct_sum",
      ], lineage, answer.tags.map((r) => [
        offer, r.mediaId, answer.source, r.tagId, r.kind, answer.afterDay, answer.beforeDay, r.tag, r.mediaType, r.views,
        r.videoViews, r.completedViews, r.watchMs, r.watchPctSum,
      ])),
    tag_series: await upsertRows(db, "fansly_creator_stats_media_tag_series", ["media_offer_id", "source", "tag_id", "kind", "day"], [
      "media_offer_id", "source", "tag_id", "kind", "day", "tag", "views",
    ], lineage, answer.tagSeries.map((r) => [offer, answer.source, r.tagId, r.kind, r.day, r.tag, r.views])),
    likes: await upsertRows(db, "fansly_creator_stats_media_likes", ["media_offer_id", "source", "day"], [
      "media_offer_id", "source", "day", "likes", "unlikes",
    ], lineage, answer.likes.map((r) => [offer, r.source, r.day, r.likes, r.unlikes])),
  };
}

export interface CreatorStatsMediaTopRows {
  source: number;
  /** 1 images, 2 videos, 0 both. */
  mediaType: number;
  orderBy: string;
  afterDay: string;
  beforeDay: string;
  rows: readonly (MediaCountersRow & {
    rank: number;
    mediaOfferId: string;
    mediaId: string;
    bestMediaId: string | null;
    offerLikes: number | null;
    offerUnlikes: number | null;
    mediaType: number | null;
    uniqueViewers: number | null;
    durationMs: number | null;
  })[];
}

/** One `/account/stats/media/top` ranking; the rows written. */
export async function upsertCreatorStatsMediaTop(
  db: Database,
  lineage: CreatorStatsLineage,
  top: CreatorStatsMediaTopRows,
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_media_top",
    ["source", "media_type", "order_by", "after_day", "before_day", "media_offer_id", "media_id"], [
      "source", "media_type", "order_by", "after_day", "before_day", "media_offer_id", "media_id", "rank", "best_media_id",
      "offer_likes", "offer_unlikes", "item_media_type", "views", "impressions", "unique_viewers", "video_views",
      "completed_views", "watch_ms", "watch_pct_sum", "replays", "duration_ms",
    ], lineage, top.rows.map((r) => [
      top.source, top.mediaType, top.orderBy, top.afterDay, top.beforeDay, r.mediaOfferId, r.mediaId, r.rank, r.bestMediaId,
      r.offerLikes, r.offerUnlikes, r.mediaType, r.views, r.impressions, r.uniqueViewers, r.videoViews, r.completedViews,
      r.watchMs, r.watchPctSum, r.replays, r.durationMs,
    ]));
}

// ── the walk's queue ─────────────────────────────────────────────────────────
//
// `backfill_cursor` of a row: `{ postedAtMs, other, through: { "<surface>": ms } }`
// — when the media was posted (the age basis), whether the top list showed it
// on surface 4, and the last UTC day read per surface. Only the walk writes
// `through`; the top poll writes `other` and inserts rows; the seed inserts
// rows. Each writes its own keys (`||`), never the whole object.

/** The posting instant of a queue row in ms, or null (SQL). */
const POSTED_MS = sql`case when s.backfill_cursor ->> 'postedAtMs' ~ '^[0-9]+$' then (s.backfill_cursor ->> 'postedAtMs')::bigint end`;

/**
 * Queue every media the page's `media_stats` queue holds (the post media
 * `upsertCreatorMedia` queued: Fansly, the page's own, shown outside DMs) that
 * this plane does not, due now; the age basis is the platform's posting date,
 * else when Hub first saw it. Idempotent; a row already queued is left alone.
 */
export async function seedCreatorStatsMediaQueue(db: Database, input: { pageId: number; now: Date }): Promise<number> {
  const result = await db.execute(sql`
    insert into subject_refresh_state (page_id, plane, subject_ref, next_due_at, backfill_cursor)
    select s.page_id, ${CREATOR_STATS_MEDIA_PLANE}, s.subject_ref, ${input.now},
           jsonb_build_object('postedAtMs',
             floor(extract(epoch from coalesce(m.created_at_platform, m.first_observed_at)) * 1000)::bigint)
      from subject_refresh_state s
      join creator_media m
        on m.page_id = s.page_id
       and m.platform = 'fansly'
       and m.media_offer_ref = s.subject_ref
     where s.page_id = ${input.pageId}
       and s.plane = 'media_stats'
       and m.deleted_at_platform is null
    on conflict (page_id, plane, subject_ref) do nothing
  `);
  return result.rowCount ?? 0;
}

/**
 * The offers a top list named: queued when new (due now, posted at the
 * offer's placement, else now), and marked `other` when the list was surface
 * 4's. Returns how many were queued and how many newly marked.
 */
export async function queueCreatorStatsMediaOffers(
  db: Database,
  input: { pageId: number; now: Date; other: boolean; offers: readonly { mediaOfferId: string; postedAtMs: number | null }[] },
): Promise<{ queued: number; marked: number }> {
  const offers = [...new Map(input.offers.map((offer) => [offer.mediaOfferId, offer])).values()];
  if (offers.length === 0) return { queued: 0, marked: 0 };
  const rows = sql.join(offers.map((offer) => sql`(${offer.mediaOfferId}::text, ${offer.postedAtMs ?? input.now.getTime()}::bigint)`), sql`, `);
  const result = await db.execute<{ inserted: boolean }>(sql`
    insert into subject_refresh_state (page_id, plane, subject_ref, next_due_at, backfill_cursor)
    select ${input.pageId}, ${CREATOR_STATS_MEDIA_PLANE}, x.ref, ${input.now},
           jsonb_build_object('postedAtMs', x.posted, 'other', ${input.other}::boolean)
      from (values ${rows}) as x(ref, posted)
    on conflict (page_id, plane, subject_ref) do update
      set backfill_cursor = subject_refresh_state.backfill_cursor || jsonb_build_object('other', true),
          updated_at = now()
      where ${input.other}::boolean
        and coalesce(subject_refresh_state.backfill_cursor ->> 'other', 'false') <> 'true'
    returning (xmax = 0) as inserted
  `);
  const queued = result.rows.filter((row) => row.inserted === true).length;
  return { queued, marked: result.rows.length - queued };
}

export interface CreatorStatsMediaCandidate {
  subjectRef: string;
  backfillCursor: Record<string, unknown>;
  lastVisitedAt: Date | null;
}

/**
 * The next due offer, or null with the earliest instant one falls due (null:
 * the queue is empty). Order: the youngest age tier first (`maxAgeDays` of the
 * walk's tiers, youngest first: a fresh media's hours live two days, so a
 * first pass over the back catalogue never starves it), then the longest
 * overdue, then the newest post.
 */
export async function pickCreatorStatsMediaDue(
  db: Database,
  input: { pageId: number; now: Date; tierMaxAgeDays: readonly (number | null)[] },
): Promise<{ candidate: CreatorStatsMediaCandidate | null; earliestDueAt: Date | null }> {
  const bounds = input.tierMaxAgeDays.filter((days): days is number => days !== null);
  const tierOrder: SQL = bounds.length === 0
    ? sql`0`
    : sql`case ${sql.join(bounds.map((days, index) =>
      sql`when ${POSTED_MS} >= ${input.now.getTime() - days * 86_400_000}::bigint then ${index}::int`), sql` `)} else ${bounds.length}::int end`;
  const picked = await db.execute<{ subject_ref: string; backfill_cursor: Record<string, unknown> | null; last_visited_at: Date | string | null }>(sql`
    select s.subject_ref, s.backfill_cursor, s.last_visited_at
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
       and (s.next_due_at is null or s.next_due_at <= ${input.now})
     order by ${tierOrder} asc, s.next_due_at asc nulls first, ${POSTED_MS} desc nulls last, s.subject_ref desc
     limit 1
  `);
  const row = picked.rows[0];
  if (row !== undefined) {
    return {
      candidate: {
        subjectRef: row.subject_ref,
        backfillCursor: row.backfill_cursor ?? {},
        lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at),
      },
      earliestDueAt: input.now,
    };
  }
  const next = await db.execute<{ due: Date | string | null }>(sql`
    select min(s.next_due_at) as due
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
  `);
  const due = next.rows[0]?.due ?? null;
  return { candidate: null, earliestDueAt: due === null ? null : new Date(due) };
}

/** An offer's queue row as the walk reads it mid-visit; null when gone. */
export async function readCreatorStatsMediaQueueRow(
  db: Database,
  input: { pageId: number; subjectRef: string },
): Promise<{ consecutiveFailures: number; nextDueAt: Date | null } | null> {
  const result = await db.execute<{ consecutive_failures: number | string; next_due_at: Date | string | null }>(sql`
    select s.consecutive_failures, s.next_due_at
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
       and s.subject_ref = ${input.subjectRef}
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { consecutiveFailures: Number(row.consecutive_failures), nextDueAt: row.next_due_at === null ? null : new Date(row.next_due_at) };
}

/** One surface read through `throughMs` (a UTC day): `through` only moves forward. */
export async function recordCreatorStatsMediaRead(
  db: Database,
  input: { pageId: number; subjectRef: string; source: number; throughMs: number },
): Promise<boolean> {
  const key = String(input.source);
  const result = await db.execute(sql`
    update subject_refresh_state s
       set backfill_cursor = s.backfill_cursor || jsonb_build_object('through',
             coalesce(s.backfill_cursor -> 'through', '{}'::jsonb) || jsonb_build_object(${key}::text, greatest(
               case when s.backfill_cursor -> 'through' ->> ${key}::text ~ '^[0-9]+$'
                 then (s.backfill_cursor -> 'through' ->> ${key}::text)::bigint else 0 end,
               ${input.throughMs}::bigint))),
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
       and s.subject_ref = ${input.subjectRef}
  `);
  return (result.rowCount ?? 0) > 0;
}

/** A visit that read every surface it asked for: due again at `nextDueAt`,
 *  its failures forgotten. `refreshClass` is the age tier's name. */
export async function recordCreatorStatsMediaVisit(
  db: Database,
  input: { pageId: number; subjectRef: string; visitedAt: Date; nextDueAt: Date; refreshClass: "fresh" | "mid" | "long_tail" },
): Promise<boolean> {
  const result = await db.execute(sql`
    update subject_refresh_state s
       set last_visited_at = ${input.visitedAt},
           next_due_at = ${input.nextDueAt},
           refresh_class = ${input.refreshClass},
           consecutive_failures = 0,
           dirty_reason = null,
           refresh_visits = s.refresh_visits + 1,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
       and s.subject_ref = ${input.subjectRef}
  `);
  return (result.rowCount ?? 0) > 0;
}

export interface CreatorStatsMediaQueueCensus {
  queueSize: number;
  neverVisited: number;
  dueNow: number;
  /** Rows whose breaker is open (a failed read, waiting out its ladder). */
  failing: number;
}

/** The queue's census: what the plane's coverage row reports. */
export async function countCreatorStatsMediaQueue(
  db: Database,
  input: { pageId: number; now: Date },
): Promise<CreatorStatsMediaQueueCensus> {
  const result = await db.execute<{ queue_size: string; never_visited: string; due_now: string; failing: string }>(sql`
    select count(*)::text as queue_size,
           count(*) filter (where s.last_visited_at is null)::text as never_visited,
           count(*) filter (where s.next_due_at is null or s.next_due_at <= ${input.now})::text as due_now,
           count(*) filter (where s.consecutive_failures > 0)::text as failing
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${CREATOR_STATS_MEDIA_PLANE}
  `);
  const row = result.rows[0];
  return {
    queueSize: Number(row?.queue_size ?? 0),
    neverVisited: Number(row?.never_visited ?? 0),
    dueNow: Number(row?.due_now ?? 0),
    failing: Number(row?.failing ?? 0),
  };
}
