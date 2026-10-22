// Fansly creator statistics of 2026-10 (0293, 0294): the dashboard's reads of
// the media and audience planes over a window of UTC days. Window sums are
// sums of the daily rows as served (views add up over days and surfaces;
// uniques do not, so none are summed here). A media offer is tied to the post
// that carries it (directly or inside a bundle) for its date and caption.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function day(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function rows(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)).rows;
}

/** The post that first carried each offer of a page: directly or in a bundle. */
const OFFER_POSTS = (pageId: number) => sql`
  select distinct on (offer_ref) offer_ref, platform_post_id, published_at, text_plain
    from (
      select a.attachment->>'contentId' as offer_ref, cp.platform_post_id, cp.published_at, cp.text_plain
        from creator_posts cp
        cross join lateral jsonb_array_elements(coalesce(cp.attachment_refs, '[]'::jsonb)) as a(attachment)
       where cp.account_id = ${pageId}
      union all
      select member.ref, cp.platform_post_id, cp.published_at, cp.text_plain
        from creator_posts cp
        cross join lateral jsonb_array_elements(coalesce(cp.attachment_refs, '[]'::jsonb)) as a(attachment)
        join creator_media_bundles b on b.page_id = cp.account_id and b.bundle_ref = a.attachment->>'contentId'
        cross join lateral unnest(b.member_refs) as member(ref)
       where cp.account_id = ${pageId}
    ) carried
   where offer_ref is not null
   order by offer_ref, published_at
`;

export interface CreatorStatsContentRow {
  mediaOfferId: string;
  mediaType: number | null;
  durationMs: number | null;
  postId: string | null;
  postedAt: string | null;
  caption: string | null;
  views: number | null;
  forYouViews: number | null;
  timelineViews: number | null;
  otherViews: number | null;
  videoViews: number | null;
  completedViews: number | null;
  watchMs: number | null;
  watchPctSum: number | null;
  likes: number | null;
  /** All-time views of the surfaces read (the newest totals of each). */
  allTimeViews: number | null;
}

/** How far the media walk has got: offers in its queue, and those visited. */
export async function readCreatorStatsMediaWalk(db: Database, pageId: number): Promise<{ visited: number; queued: number }> {
  const row = (await rows(db, sql`
    select count(*) filter (where last_visited_at is not null) as visited, count(*) as queued
      from subject_refresh_state
     where page_id = ${pageId} and plane = 'creator_stats_media'
  `))[0];
  return { visited: num(row?.visited) ?? 0, queued: num(row?.queued) ?? 0 };
}

/** The page's media with views in the window, most viewed first. */
export async function readCreatorStatsContent(
  db: Database,
  input: { pageId: number; fromDay: string; toDay: string; limit: number },
): Promise<CreatorStatsContentRow[]> {
  const { pageId, fromDay, toDay } = input;
  return (await rows(db, sql`
    with window_rows as (
      select media_offer_id,
             sum(views) as views,
             sum(views) filter (where source = 0) as for_you_views,
             sum(views) filter (where source = 1) as timeline_views,
             sum(views) filter (where source not in (0, 1)) as other_views,
             sum(video_views) as video_views,
             sum(completed_views) as completed_views,
             sum(watch_ms) as watch_ms,
             sum(watch_pct_sum)::float8 as watch_pct_sum,
             max(media_type) as media_type,
             max(duration_ms) as duration_ms
        from fansly_creator_stats_media_daily
       where page_id = ${pageId} and day between ${fromDay}::date and ${toDay}::date
       group by media_offer_id
    ), likes as (
      select media_offer_id, sum(likes) as likes
        from (select distinct on (media_offer_id, day) media_offer_id, day, likes
                from fansly_creator_stats_media_likes
               where page_id = ${pageId} and day between ${fromDay}::date and ${toDay}::date
               order by media_offer_id, day, captured_at desc) per_day
       group by media_offer_id
    ), totals as (
      select media_offer_id, sum(views) as all_time_views
        from (select distinct on (media_offer_id, media_id, source) media_offer_id, views
                from fansly_creator_stats_media_totals
               where page_id = ${pageId}
               order by media_offer_id, media_id, source, captured_day desc) newest
       group by media_offer_id
    ), posts as (${OFFER_POSTS(pageId)})
    select w.*, l.likes, t.all_time_views, p.platform_post_id, p.published_at, left(p.text_plain, 200) as caption,
           m.duration_ms as catalog_duration_ms, m.media_type as catalog_media_type, m.created_at_platform
      from window_rows w
      left join likes l using (media_offer_id)
      left join totals t using (media_offer_id)
      left join posts p on p.offer_ref = w.media_offer_id
      left join creator_media m on m.page_id = ${pageId} and m.platform = 'fansly' and m.media_offer_ref = w.media_offer_id
     order by w.views desc nulls last, w.media_offer_id
     limit ${input.limit}
  `)).map((r) => ({
    mediaOfferId: String(r.media_offer_id),
    mediaType: num(r.media_type) ?? num(r.catalog_media_type),
    durationMs: num(r.duration_ms) ?? num(r.catalog_duration_ms),
    postId: text(r.platform_post_id),
    postedAt: instant(r.published_at) ?? instant(r.created_at_platform),
    caption: text(r.caption),
    views: num(r.views),
    forYouViews: num(r.for_you_views),
    timelineViews: num(r.timeline_views),
    otherViews: num(r.other_views),
    videoViews: num(r.video_views),
    completedViews: num(r.completed_views),
    watchMs: num(r.watch_ms),
    watchPctSum: num(r.watch_pct_sum),
    likes: num(r.likes),
    allTimeViews: num(r.all_time_views),
  }));
}

export interface CreatorStatsMediaDetail {
  daily: { day: string; source: number; views: number | null; videoViews: number | null; completedViews: number | null;
    watchMs: number | null; uniqueViewers: number | null }[];
  hourly: { hour: string; source: number; views: number | null }[];
  retention: { source: number; sampleSize: number | null; capturedDay: string; points: { percent: number; stillWatching: number }[] }[];
  tags: { tag: string; source: number; views: number | null }[];
}

/** One offer: its days in the window by surface, its last hours, the newest
 *  retention curve of each surface and the tags it was found by. */
export async function readCreatorStatsMediaDetail(
  db: Database,
  input: { pageId: number; mediaOfferId: string; fromDay: string; toDay: string },
): Promise<CreatorStatsMediaDetail> {
  const { pageId, mediaOfferId, fromDay, toDay } = input;
  const daily = (await rows(db, sql`
    select day, source, sum(views) as views, sum(video_views) as video_views, sum(completed_views) as completed_views,
           sum(watch_ms) as watch_ms, sum(unique_viewers) as unique_viewers
      from fansly_creator_stats_media_daily
     where page_id = ${pageId} and media_offer_id = ${mediaOfferId} and day between ${fromDay}::date and ${toDay}::date
     group by day, source
     order by day, source
  `)).map((r) => ({
    day: day(r.day), source: Number(r.source), views: num(r.views), videoViews: num(r.video_views),
    completedViews: num(r.completed_views), watchMs: num(r.watch_ms), uniqueViewers: num(r.unique_viewers),
  }));
  const hourly = (await rows(db, sql`
    select hour_start, source, sum(views) as views
      from fansly_creator_stats_media_hourly
     where page_id = ${pageId} and media_offer_id = ${mediaOfferId}
     group by hour_start, source
     order by hour_start, source
  `)).map((r) => ({ hour: instant(r.hour_start)!, source: Number(r.source), views: num(r.views) }));
  const retention = (await rows(db, sql`
    select distinct on (source) source, retention, retention_sample_size, captured_day
      from fansly_creator_stats_media_totals
     where page_id = ${pageId} and media_offer_id = ${mediaOfferId}
     order by source, captured_day desc, retention_sample_size desc nulls last
  `)).map((r) => ({
    source: Number(r.source),
    sampleSize: num(r.retention_sample_size),
    capturedDay: day(r.captured_day),
    points: (Array.isArray(r.retention) ? r.retention : [])
      .map((point: unknown) => {
        const p = point as Record<string, unknown>;
        return { percent: Number(p.percent), stillWatching: Number(p.stillWatching) };
      })
      .filter((point) => Number.isFinite(point.percent) && Number.isFinite(point.stillWatching)),
  }));
  const tags = (await rows(db, sql`
    select coalesce(tag, tag_id) as tag, source, sum(views) as views
      from fansly_creator_stats_media_tag_series
     where page_id = ${pageId} and media_offer_id = ${mediaOfferId} and day between ${fromDay}::date and ${toDay}::date
     group by 1, 2
     order by views desc nulls last
     limit 30
  `)).map((r) => ({ tag: String(r.tag), source: Number(r.source), views: num(r.views) }));
  return { daily, hourly, retention, tags };
}

export interface CreatorStatsAudienceRows {
  countries: { country: string; source: number; views: number | null; watchMs: number | null; profileVisits: number | null }[];
  /** How many days of the window the countries cover. */
  countriesCoveredDays: number;
  tags: { fromDay: string; toDay: string; rows: { tag: string; source: number; views: number | null; videoViews: number | null;
    completedViews: number | null; liftPoints: number | null; liftAvailable: boolean | null }[] } | null;
  activeHours: { fromDay: string; toDay: string; cells: { source: number; weekday: number; hour: number; views: number | null }[] } | null;
  benchmarks: { fromDay: string; toDay: string; rows: { source: number; lengthBucket: number; minMs: number | null; maxMs: number | null;
    mediaCount: number | null; avgWatchPercent: number | null; completionRate: number | null; videoViews: number | null }[] } | null;
  mediaShown: { hour: string; source: number; mediaShown: number | null }[];
}

/** The window of `table` with the newest end on or before `toDay` among those
 *  `spanDays` long (or the newest one when none is). */
async function newestWindow(db: Database, table: string, pageId: number, toDay: string, spanDays: number) {
  const row = (await rows(db, sql`
    select after_day, before_day
      from ${sql.identifier(table)}
     where page_id = ${pageId} and before_day <= ${toDay}::date
     group by after_day, before_day
     order by (before_day - after_day = ${spanDays - 1}) desc, before_day desc, after_day
     limit 1
  `))[0];
  return row === undefined ? null : { fromDay: day(row.after_day), toDay: day(row.before_day) };
}

export async function readCreatorStatsAudience(
  db: Database,
  input: { pageId: number; fromDay: string; toDay: string; hourlyFrom: Date },
): Promise<CreatorStatsAudienceRows> {
  const { pageId, fromDay, toDay } = input;
  // Countries: geo is stored per served window (single days from the poll,
  // calendar months from the history). The window is covered by windows that
  // lie inside it and do not overlap, the longest first; the days they cover
  // are said, so a part never reads as the whole.
  const candidates = (await rows(db, sql`
    select after_day, before_day
      from fansly_creator_stats_geo
     where page_id = ${pageId} and after_day >= ${fromDay}::date and before_day <= ${toDay}::date
     group by after_day, before_day
  `)).map((r) => ({ fromDay: day(r.after_day), toDay: day(r.before_day) }));
  const spanDays = (w: { fromDay: string; toDay: string }) => (Date.parse(w.toDay) - Date.parse(w.fromDay)) / 86_400_000 + 1;
  const chosen: { fromDay: string; toDay: string }[] = [];
  for (const window of candidates.sort((a, b) => spanDays(b) - spanDays(a) || b.toDay.localeCompare(a.toDay))) {
    if (chosen.every((taken) => window.toDay < taken.fromDay || window.fromDay > taken.toDay)) chosen.push(window);
  }
  const countriesCoveredDays = chosen.reduce((sum, window) => sum + spanDays(window), 0);
  const countries = chosen.length === 0 ? [] : (await rows(db, sql`
    select country, source, sum(views) as views, sum(watch_ms) as watch_ms, sum(profile_visits) as profile_visits
      from fansly_creator_stats_geo
     where page_id = ${pageId}
       and (after_day, before_day) in (${sql.join(chosen.map((w) => sql`(${w.fromDay}::date, ${w.toDay}::date)`), sql`, `)})
     group by country, source
     order by sum(views) desc nulls last
  `)).map((r) => ({
    country: String(r.country), source: Number(r.source), views: num(r.views), watchMs: num(r.watch_ms), profileVisits: num(r.profile_visits),
  }));

  const tagWindow = await newestWindow(db, "fansly_creator_stats_tags", pageId, toDay, 30);
  const tags = tagWindow === null ? null : {
    ...tagWindow,
    rows: (await rows(db, sql`
      select coalesce(n.tag, t.tag_id) as tag, t.source, t.views, t.video_views, t.completed_views,
             t.lift_points::float8 as lift_points, t.lift_available
        from fansly_creator_stats_tags t
        left join fansly_creator_stats_tag_names n on n.page_id = t.page_id and n.tag_id = t.tag_id
       where t.page_id = ${pageId} and t.kind = 1 and t.after_day = ${tagWindow.fromDay}::date and t.before_day = ${tagWindow.toDay}::date
       order by t.views desc nulls last
    `)).map((r) => ({
      tag: String(r.tag), source: Number(r.source), views: num(r.views), videoViews: num(r.video_views),
      completedViews: num(r.completed_views), liftPoints: num(r.lift_points),
      liftAvailable: r.lift_available === null || r.lift_available === undefined ? null : Boolean(r.lift_available),
    })),
  };

  const hoursWindow = await newestWindow(db, "fansly_creator_stats_active_hours", pageId, toDay, 90);
  const activeHours = hoursWindow === null ? null : {
    ...hoursWindow,
    cells: (await rows(db, sql`
      select source, weekday, hour, views
        from fansly_creator_stats_active_hours
       where page_id = ${pageId} and after_day = ${hoursWindow.fromDay}::date and before_day = ${hoursWindow.toDay}::date
       order by source, weekday, hour
    `)).map((r) => ({ source: Number(r.source), weekday: Number(r.weekday), hour: Number(r.hour), views: num(r.views) })),
  };

  const benchWindow = await newestWindow(db, "fansly_creator_stats_benchmarks", pageId, toDay, 30);
  const benchmarks = benchWindow === null ? null : {
    ...benchWindow,
    rows: (await rows(db, sql`
      select source, length_bucket, min_ms, max_ms, media_count, avg_watch_percent::float8 as avg_watch_percent,
             completion_rate::float8 as completion_rate, video_views
        from fansly_creator_stats_benchmarks
       where page_id = ${pageId} and after_day = ${benchWindow.fromDay}::date and before_day = ${benchWindow.toDay}::date
       order by source, length_bucket
    `)).map((r) => ({
      source: Number(r.source), lengthBucket: Number(r.length_bucket), minMs: num(r.min_ms), maxMs: num(r.max_ms),
      mediaCount: num(r.media_count), avgWatchPercent: num(r.avg_watch_percent), completionRate: num(r.completion_rate),
      videoViews: num(r.video_views),
    })),
  };

  const mediaShown = (await rows(db, sql`
    select end_hour, source, media_shown
      from fansly_creator_stats_media_shown
     where page_id = ${pageId} and hours = 1 and end_hour >= ${input.hourlyFrom}
     order by end_hour, source
  `)).map((r) => ({ hour: instant(r.end_hour)!, source: Number(r.source), mediaShown: num(r.media_shown) }));

  return { countries, countriesCoveredDays, tags, activeHours, benchmarks, mediaShown };
}
