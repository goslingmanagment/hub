// Fansly creator statistics of 2026-10 (0294): writers of the audience
// plane's typed rows — geo, tags, media benchmarks, media shown, active hours.
// The `creator-stats.audience*` and `creator-stats.media-shown` resources call
// them from their apply, in the transaction that journaled the answer.
//
// A window route answers for its whole window: its rows are kept under the
// window the server served (`after_day`, `before_day`). A row is replaced only
// by an answer received at the same instant or later (`upsertRows`).

import type { Database } from "../client.ts";
import { upsertRows, type CreatorStatsLineage } from "./fansly-creator-stats.ts";

/** One window of one surface, as the server served it (`YYYY-MM-DD`, both included). */
export interface CreatorStatsAudienceWindow {
  source: number;
  afterDay: string;
  beforeDay: string;
}

export interface CreatorStatsGeoRow {
  country: string;
  views: number | null;
  imageViews: number | null;
  videoViews: number | null;
  watchMs: number | null;
  watchPctSum: string | null;
  avgWatchPercent: string | null;
  avgWatchMs: string | null;
  profileVisits: number | null;
}

export async function upsertCreatorStatsGeo(
  db: Database,
  lineage: CreatorStatsLineage,
  window: CreatorStatsAudienceWindow,
  rows: readonly CreatorStatsGeoRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_geo", ["source", "after_day", "before_day", "country"], [
    "source", "after_day", "before_day", "country", "views", "image_views", "video_views", "watch_ms", "watch_pct_sum",
    "avg_watch_percent", "avg_watch_ms", "profile_visits",
  ], lineage, rows.map((r) => [
    window.source, window.afterDay, window.beforeDay, r.country, r.views, r.imageViews, r.videoViews, r.watchMs,
    r.watchPctSum, r.avgWatchPercent, r.avgWatchMs, r.profileVisits,
  ]));
}

export interface CreatorStatsTagsAnswerRows {
  kind: number;
  liftAvailable: boolean | null;
  rows: readonly {
    tagId: string;
    views: number | null;
    imageViews: number | null;
    videoViews: number | null;
    watchMs: number | null;
    imageWatchMs: number | null;
    completedViews: number | null;
    watchPctSum: string | null;
    liftPoints: string | null;
    liftVideoViews: number | null;
  }[];
  series: readonly { tagId: string; day: string; views: number | null; imageViews: number | null }[];
  names: readonly { tagId: string; tag: string }[];
}

/** Every typed row of one tags answer; the counts written per table. */
export async function upsertCreatorStatsTags(
  db: Database,
  lineage: CreatorStatsLineage,
  window: CreatorStatsAudienceWindow,
  answer: CreatorStatsTagsAnswerRows,
): Promise<Record<string, number>> {
  return {
    tags: await upsertRows(db, "fansly_creator_stats_tags", ["source", "kind", "after_day", "before_day", "tag_id"], [
      "source", "kind", "after_day", "before_day", "tag_id", "views", "image_views", "video_views", "watch_ms",
      "image_watch_ms", "completed_views", "watch_pct_sum", "lift_points", "lift_video_views", "lift_available",
    ], lineage, answer.rows.map((r) => [
      window.source, answer.kind, window.afterDay, window.beforeDay, r.tagId, r.views, r.imageViews, r.videoViews, r.watchMs,
      r.imageWatchMs, r.completedViews, r.watchPctSum, r.liftPoints, r.liftVideoViews, answer.liftAvailable,
    ])),
    tag_series: await upsertRows(db, "fansly_creator_stats_tag_series", ["source", "kind", "tag_id", "day"], [
      "source", "kind", "tag_id", "day", "views", "image_views",
    ], lineage, answer.series.map((r) => [window.source, answer.kind, r.tagId, r.day, r.views, r.imageViews])),
    tag_names: await upsertRows(db, "fansly_creator_stats_tag_names", ["tag_id"], ["tag_id", "tag"],
      lineage, answer.names.map((r) => [r.tagId, r.tag])),
  };
}

export interface CreatorStatsBenchmarkRow {
  lengthBucket: number;
  minMs: number | null;
  maxMs: number | null;
  mediaCount: number | null;
  views: number | null;
  videoViews: number | null;
  watchMs: number | null;
  completedViews: number | null;
  watchPctSum: string | null;
  avgWatchPercent: string | null;
  completionRate: string | null;
  avgWatchMs: string | null;
}

export async function upsertCreatorStatsBenchmarks(
  db: Database,
  lineage: CreatorStatsLineage,
  window: CreatorStatsAudienceWindow,
  rows: readonly CreatorStatsBenchmarkRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_benchmarks", ["source", "after_day", "before_day", "length_bucket"], [
    "source", "after_day", "before_day", "length_bucket", "min_ms", "max_ms", "media_count", "views", "video_views",
    "watch_ms", "completed_views", "watch_pct_sum", "avg_watch_percent", "completion_rate", "avg_watch_ms",
  ], lineage, rows.map((r) => [
    window.source, window.afterDay, window.beforeDay, r.lengthBucket, r.minMs, r.maxMs, r.mediaCount, r.views, r.videoViews,
    r.watchMs, r.completedViews, r.watchPctSum, r.avgWatchPercent, r.completionRate, r.avgWatchMs,
  ]));
}

export async function upsertCreatorStatsMediaShown(
  db: Database,
  lineage: CreatorStatsLineage,
  span: { endHour: Date; hours: number },
  rows: readonly { source: number; mediaShown: number | null; previousMediaShown: number | null }[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_media_shown", ["source", "end_hour", "hours"], [
    "source", "end_hour", "hours", "media_shown", "previous_media_shown",
  ], lineage, rows.map((r) => [r.source, span.endHour, span.hours, r.mediaShown, r.previousMediaShown]));
}

export async function upsertCreatorStatsActiveHours(
  db: Database,
  lineage: CreatorStatsLineage,
  window: CreatorStatsAudienceWindow,
  cells: readonly { weekday: number; hour: number; views: number | null; imageViews: number | null }[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_active_hours", ["source", "after_day", "before_day", "weekday", "hour"], [
    "source", "after_day", "before_day", "weekday", "hour", "views", "image_views",
  ], lineage, cells.map((r) => [window.source, window.afterDay, window.beforeDay, r.weekday, r.hour, r.views, r.imageViews]));
}
