// Fansly creator statistics of 2026-10 (0292): the dashboard's read of one
// page's account plane over a window of UTC days — the daily rows of every
// series family, the levels, the engagement, the last hours, and the summary
// totals of the window Fansly itself computed (uniques and paying fans are not
// sums of days). Nothing is summed across products or sources here: the
// dashboard groups what it draws.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface CreatorStatsOverviewInput {
  pageId: number;
  /** First and last UTC day of the window, `YYYY-MM-DD`. */
  fromDay: string;
  toDay: string;
  /** The hourly rows from this instant on. */
  hourlyFrom: Date;
}

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function day(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

async function rows(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)).rows;
}

export interface CreatorStatsOverviewRows {
  /** The summary window the totals are of (null: none captured for this length). */
  totalsWindow: { fromDay: string; toDay: string; capturedAt: string } | null;
  totals: { scope: string; ref: string; metric: string; value: number | null; previous: number | null }[];
  views: { day: string; source: number; views: number | null; uniqueViewers: number | null; videoViews: number | null;
    completedViews: number | null; watchMs: number | null; watchPctSum: number | null; imageViews: number | null }[];
  profile: { day: string; source: number; profileVisits: number | null; uniqueVisitors: number | null; profileWatchMs: number | null }[];
  follows: { day: string; follows: number | null; unfollows: number | null }[];
  subscriptions: { day: string; tierId: string; subscriptionsNew: number | null; subscriptionsRenewed: number | null;
    subscriptionsExpired: number | null; subscriptionsCancelled: number | null }[];
  revenue: { day: string; productType: number; transactions: number | null; grossMills: number | null; netMills: number | null;
    refunds: number | null; refundedNetMills: number | null }[];
  levels: { day: string; followerCount: number | null; subscriberCount: number | null }[];
  tierLevels: { day: string; tierId: string; subscriberCount: number | null }[];
  engagement: { day: string; metric: string; source: number; value: number | null }[];
  hourlyViews: { hour: string; source: number; views: number | null; watchMs: number | null }[];
  hourlyRevenue: { hour: string; netMills: number | null; transactions: number | null }[];
  tiers: { tierId: string; name: string | null; color: string | null; position: number | null; active: boolean | null }[];
  coverage: { scopeRef: string; oldestCapturedAt: string | null; newestCapturedAt: string | null; updatedAt: string }[];
}

export async function readCreatorStatsOverview(db: Database, input: CreatorStatsOverviewInput): Promise<CreatorStatsOverviewRows> {
  const { pageId, fromDay, toDay } = input;
  const from = sql`${fromDay}::date::timestamptz`;
  const until = sql`(${toDay}::date + 1)::timestamptz`;
  const spanDays = sql`(${toDay}::date - ${fromDay}::date)`;

  // The summary window of this length ending on the last day, or the newest
  // one of this length before it (the hourly poll reads 7, 30 and 90 days).
  const windowRow = (await rows(db, sql`
    select after_day, before_day, max(captured_at) as captured_at
      from fansly_creator_stats_windows
     where page_id = ${pageId}
       and before_day - after_day = ${spanDays}
       and before_day <= ${toDay}::date
     group by after_day, before_day
     order by before_day desc
     limit 1
  `))[0];
  const totalsWindow = windowRow === undefined
    ? null
    : { fromDay: day(windowRow.after_day), toDay: day(windowRow.before_day), capturedAt: instant(windowRow.captured_at) };
  const totals = totalsWindow === null ? [] : (await rows(db, sql`
    select scope, ref, metric, value::float8 as value, previous::float8 as previous
      from fansly_creator_stats_windows
     where page_id = ${pageId} and after_day = ${totalsWindow.fromDay}::date and before_day = ${totalsWindow.toDay}::date
     order by scope, ref, metric
  `)).map((r) => ({ scope: String(r.scope), ref: String(r.ref), metric: String(r.metric), value: num(r.value), previous: num(r.previous) }));

  const views = (await rows(db, sql`
    select bucket_start, source, views, unique_viewers, video_views, completed_views, watch_ms,
           watch_pct_sum::float8 as watch_pct_sum, image_views
      from fansly_creator_stats_views
     where page_id = ${pageId} and granularity = 'day' and bucket_start >= ${from} and bucket_start < ${until}
     order by bucket_start, source
  `)).map((r) => ({
    day: day(r.bucket_start), source: Number(r.source), views: num(r.views), uniqueViewers: num(r.unique_viewers),
    videoViews: num(r.video_views), completedViews: num(r.completed_views), watchMs: num(r.watch_ms),
    watchPctSum: num(r.watch_pct_sum), imageViews: num(r.image_views),
  }));

  const profile = (await rows(db, sql`
    select bucket_start, source, profile_visits, unique_visitors, profile_watch_ms
      from fansly_creator_stats_profile
     where page_id = ${pageId} and granularity = 'day' and bucket_start >= ${from} and bucket_start < ${until}
     order by bucket_start, source
  `)).map((r) => ({
    day: day(r.bucket_start), source: Number(r.source), profileVisits: num(r.profile_visits),
    uniqueVisitors: num(r.unique_visitors), profileWatchMs: num(r.profile_watch_ms),
  }));

  const follows = (await rows(db, sql`
    select bucket_start, follows, unfollows
      from fansly_creator_stats_follows
     where page_id = ${pageId} and granularity = 'day' and bucket_start >= ${from} and bucket_start < ${until}
     order by bucket_start
  `)).map((r) => ({ day: day(r.bucket_start), follows: num(r.follows), unfollows: num(r.unfollows) }));

  const subscriptions = (await rows(db, sql`
    select bucket_start, tier_id, subscriptions_new, subscriptions_renewed, subscriptions_expired, subscriptions_cancelled
      from fansly_creator_stats_subscriptions
     where page_id = ${pageId} and granularity = 'day' and bucket_start >= ${from} and bucket_start < ${until}
     order by bucket_start, tier_id
  `)).map((r) => ({
    day: day(r.bucket_start), tierId: String(r.tier_id), subscriptionsNew: num(r.subscriptions_new),
    subscriptionsRenewed: num(r.subscriptions_renewed), subscriptionsExpired: num(r.subscriptions_expired),
    subscriptionsCancelled: num(r.subscriptions_cancelled),
  }));

  const revenue = (await rows(db, sql`
    select bucket_start, product_type, transactions, gross_mills, net_mills, refunds, refunded_net_mills
      from fansly_creator_stats_revenue
     where page_id = ${pageId} and granularity = 'day' and bucket_start >= ${from} and bucket_start < ${until}
     order by bucket_start, product_type
  `)).map((r) => ({
    day: day(r.bucket_start), productType: Number(r.product_type), transactions: num(r.transactions),
    grossMills: num(r.gross_mills), netMills: num(r.net_mills), refunds: num(r.refunds), refundedNetMills: num(r.refunded_net_mills),
  }));

  const levels = (await rows(db, sql`
    select day, follower_count, subscriber_count
      from fansly_creator_stats_levels
     where page_id = ${pageId} and day between ${fromDay}::date and ${toDay}::date
     order by day
  `)).map((r) => ({ day: day(r.day), followerCount: num(r.follower_count), subscriberCount: num(r.subscriber_count) }));

  const tierLevels = (await rows(db, sql`
    select day, tier_id, subscriber_count
      from fansly_creator_stats_tier_levels
     where page_id = ${pageId} and day between ${fromDay}::date and ${toDay}::date
     order by day, tier_id
  `)).map((r) => ({ day: day(r.day), tierId: String(r.tier_id), subscriberCount: num(r.subscriber_count) }));

  const engagement = (await rows(db, sql`
    select day, metric, source, value
      from fansly_creator_stats_engagement
     where page_id = ${pageId} and day between ${fromDay}::date and ${toDay}::date
     order by day, metric, source
  `)).map((r) => ({ day: day(r.day), metric: String(r.metric), source: Number(r.source), value: num(r.value) }));

  const hourlyViews = (await rows(db, sql`
    select bucket_start, source, views, watch_ms
      from fansly_creator_stats_views
     where page_id = ${pageId} and granularity = 'hour' and bucket_start >= ${input.hourlyFrom}
     order by bucket_start, source
  `)).map((r) => ({ hour: instant(r.bucket_start), source: Number(r.source), views: num(r.views), watchMs: num(r.watch_ms) }));

  const hourlyRevenue = (await rows(db, sql`
    select bucket_start, sum(net_mills) as net_mills, sum(transactions) as transactions
      from fansly_creator_stats_revenue
     where page_id = ${pageId} and granularity = 'hour' and bucket_start >= ${input.hourlyFrom}
     group by bucket_start
     order by bucket_start
  `)).map((r) => ({ hour: instant(r.bucket_start), netMills: num(r.net_mills), transactions: num(r.transactions) }));

  const tiers = (await rows(db, sql`
    select tier_id, name, color, position, active
      from fansly_creator_stats_tiers
     where page_id = ${pageId}
     order by position nulls last, tier_id
  `)).map((r) => ({
    tierId: String(r.tier_id), name: text(r.name), color: text(r.color), position: num(r.position),
    active: r.active === null || r.active === undefined ? null : Boolean(r.active),
  }));

  const coverage = (await rows(db, sql`
    select scope_ref, oldest_captured_at, newest_captured_at, updated_at
      from capture_coverage
     where page_id = ${pageId} and plane = 'creator_stats_account'
     order by scope_ref
  `)).map((r) => ({
    scopeRef: String(r.scope_ref),
    oldestCapturedAt: r.oldest_captured_at === null ? null : instant(r.oldest_captured_at),
    newestCapturedAt: r.newest_captured_at === null ? null : instant(r.newest_captured_at),
    updatedAt: instant(r.updated_at),
  }));

  return { totalsWindow, totals, views, profile, follows, subscriptions, revenue, levels, tierLevels, engagement, hourlyViews, hourlyRevenue, tiers, coverage };
}
