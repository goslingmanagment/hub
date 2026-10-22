// Fansly creator statistics of 2026-10 (0292): writers of the account plane's
// typed rows. The `creator-stats.*` resources call them from their apply, in
// the transaction that journaled the answer.
//
// A row is replaced only by an answer received at the same instant or later
// (`captured_at`, then `observation_id`): a re-apply of an older answer from
// the journal never overwrites a fresher one. A null counter stays null.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

/** What every typed row carries besides its own columns. */
export interface CreatorStatsLineage {
  pageId: number;
  observationId: number;
  capturedAt: Date;
}

type Cell = string | number | boolean | bigint | Date | null;

function cellKey(cell: Cell): string | number | boolean | null {
  if (cell instanceof Date) return cell.toISOString();
  return typeof cell === "bigint" ? cell.toString() : cell;
}

/** At most this many rows a statement (well under the 65 535 parameters). */
const CHUNK_ROWS = 400;

/**
 * Upsert `rows` into `table` keyed by `key` (with `page_id` first). Every
 * row has the same `columns`, in order; `page_id`, `observation_id` and
 * `captured_at` are added from the lineage.
 */
export async function upsertRows(
  db: Database,
  table: string,
  key: readonly string[],
  columns: readonly string[],
  lineage: CreatorStatsLineage,
  input: readonly (readonly Cell[])[],
): Promise<number> {
  let rows = input;
  if (rows.length === 0) return 0;
  // One statement may not touch a key twice: the last row of a key wins.
  const keyAt = key.map((name) => columns.indexOf(name));
  const unique = [...new Map(rows.map((row) => [JSON.stringify(keyAt.map((at) => cellKey(row[at] ?? null))), row])).values()];
  rows = unique;
  const all = ["page_id", ...columns, "observation_id", "captured_at"];
  const target = sql.identifier(table);
  const names = sql.join(all.map((name) => sql.identifier(name)), sql`, `);
  const updates = sql.join(
    all.filter((name) => !key.includes(name)).map((name) => sql`${sql.identifier(name)} = excluded.${sql.identifier(name)}`),
    sql`, `,
  );
  let written = 0;
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
    const chunk = rows.slice(start, start + CHUNK_ROWS);
    const values = sql.join(chunk.map((row) => {
      const cells: SQL[] = [
        sql`${lineage.pageId}`,
        ...row.map((cell) => cell === null ? sql`null` : typeof cell === "bigint" ? sql`${cell.toString()}::bigint` : sql`${cell}`),
        sql`${lineage.observationId}`,
        sql`${lineage.capturedAt}`,
      ];
      return sql`(${sql.join(cells, sql`, `)})`;
    }), sql`, `);
    const result = await db.execute(sql`
      insert into ${target} (${names}) values ${values}
      on conflict (${sql.join(["page_id", ...key.filter((name) => name !== "page_id")].map((name) => sql.identifier(name)), sql`, `)})
      do update set ${updates}
      where (excluded.captured_at, excluded.observation_id) >= (${target}.captured_at, ${target}.observation_id)
    `);
    written += result.rowCount ?? 0;
  }
  return written;
}

export interface CreatorStatsViewsRow {
  bucketStart: Date;
  source: number;
  views: number | null;
  impressions: number | null;
  uniqueViewers: number | null;
  videoViews: number | null;
  completedViews: number | null;
  watchMs: number | null;
  watchPctSum: string | null;
  replays: number | null;
  imageViews: number | null;
  imageImpressions: number | null;
  uniqueImageViewers: number | null;
  imageWatchMs: number | null;
}

export async function upsertCreatorStatsViews(
  db: Database,
  lineage: CreatorStatsLineage,
  granularity: "hour" | "day",
  rows: readonly CreatorStatsViewsRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_views", ["granularity", "bucket_start", "source"], [
    "granularity", "bucket_start", "source", "views", "impressions", "unique_viewers", "video_views", "completed_views",
    "watch_ms", "watch_pct_sum", "replays", "image_views", "image_impressions", "unique_image_viewers", "image_watch_ms",
  ], lineage, rows.map((r) => [
    granularity, r.bucketStart, r.source, r.views, r.impressions, r.uniqueViewers, r.videoViews, r.completedViews,
    r.watchMs, r.watchPctSum, r.replays, r.imageViews, r.imageImpressions, r.uniqueImageViewers, r.imageWatchMs,
  ]));
}

export interface CreatorStatsProfileRow {
  bucketStart: Date;
  source: number;
  profileVisits: number | null;
  uniqueVisitors: number | null;
  profileWatchMs: number | null;
}

export async function upsertCreatorStatsProfile(
  db: Database,
  lineage: CreatorStatsLineage,
  granularity: "hour" | "day" | "month",
  rows: readonly CreatorStatsProfileRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_profile", ["granularity", "bucket_start", "source"], [
    "granularity", "bucket_start", "source", "profile_visits", "unique_visitors", "profile_watch_ms",
  ], lineage, rows.map((r) => [granularity, r.bucketStart, r.source, r.profileVisits, r.uniqueVisitors, r.profileWatchMs]));
}

export interface CreatorStatsFollowsRow {
  bucketStart: Date;
  follows: number | null;
  unfollows: number | null;
}

export async function upsertCreatorStatsFollows(
  db: Database,
  lineage: CreatorStatsLineage,
  granularity: "hour" | "day" | "month",
  rows: readonly CreatorStatsFollowsRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_follows", ["granularity", "bucket_start"], [
    "granularity", "bucket_start", "follows", "unfollows",
  ], lineage, rows.map((r) => [granularity, r.bucketStart, r.follows, r.unfollows]));
}

export interface CreatorStatsSubscriptionsRow {
  bucketStart: Date;
  tierId: string;
  subscriptionsNew: number | null;
  subscriptionsRenewed: number | null;
  subscriptionsExpired: number | null;
  subscriptionsCancelled: number | null;
  subscriptionsMovedIn: number | null;
  subscriptionsMovedOut: number | null;
}

export async function upsertCreatorStatsSubscriptions(
  db: Database,
  lineage: CreatorStatsLineage,
  granularity: "hour" | "day" | "month",
  rows: readonly CreatorStatsSubscriptionsRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_subscriptions", ["granularity", "bucket_start", "tier_id"], [
    "granularity", "bucket_start", "tier_id", "subscriptions_new", "subscriptions_renewed", "subscriptions_expired",
    "subscriptions_cancelled", "subscriptions_moved_in", "subscriptions_moved_out",
  ], lineage, rows.map((r) => [
    granularity, r.bucketStart, r.tierId, r.subscriptionsNew, r.subscriptionsRenewed, r.subscriptionsExpired,
    r.subscriptionsCancelled, r.subscriptionsMovedIn, r.subscriptionsMovedOut,
  ]));
}

export interface CreatorStatsRevenueRow {
  bucketStart: Date;
  productType: number;
  transactions: number | null;
  grossMills: bigint | null;
  netMills: bigint | null;
  refunds: number | null;
  refundedGrossMills: bigint | null;
  refundedNetMills: bigint | null;
}

export async function upsertCreatorStatsRevenue(
  db: Database,
  lineage: CreatorStatsLineage,
  granularity: "hour" | "day" | "month",
  rows: readonly CreatorStatsRevenueRow[],
): Promise<number> {
  return upsertRows(db, "fansly_creator_stats_revenue", ["granularity", "bucket_start", "product_type"], [
    "granularity", "bucket_start", "product_type", "transactions", "gross_mills", "net_mills", "refunds",
    "refunded_gross_mills", "refunded_net_mills",
  ], lineage, rows.map((r) => [
    granularity, r.bucketStart, r.productType, r.transactions, r.grossMills, r.netMills, r.refunds,
    r.refundedGrossMills, r.refundedNetMills,
  ]));
}

export interface CreatorStatsSummaryRows {
  /** The asked-and-served window's first and last UTC day (`YYYY-MM-DD`). */
  afterDay: string;
  beforeDay: string;
  levels: readonly { day: string; followerCount: number | null; subscriberCount: number | null }[];
  tierLevels: readonly { tierId: string; day: string; subscriberCount: number | null }[];
  tiers: readonly { tierId: string; name: string | null; color: string | null; position: number | null; active: boolean | null }[];
  engagement: readonly { day: string; metric: string; source: number; value: number | null }[];
  windowTotals: readonly { scope: string; ref: string; metric: string; value: string | null; previous: string | null }[];
}

/** Every typed row of one summary answer; the counts written per table. */
export async function upsertCreatorStatsSummary(
  db: Database,
  lineage: CreatorStatsLineage,
  summary: CreatorStatsSummaryRows,
): Promise<Record<string, number>> {
  return {
    levels: await upsertRows(db, "fansly_creator_stats_levels", ["day"], ["day", "follower_count", "subscriber_count"],
      lineage, summary.levels.map((r) => [r.day, r.followerCount, r.subscriberCount])),
    tier_levels: await upsertRows(db, "fansly_creator_stats_tier_levels", ["tier_id", "day"], ["tier_id", "day", "subscriber_count"],
      lineage, summary.tierLevels.map((r) => [r.tierId, r.day, r.subscriberCount])),
    tiers: await upsertRows(db, "fansly_creator_stats_tiers", ["tier_id"], ["tier_id", "name", "color", "position", "active"],
      lineage, summary.tiers.map((r) => [r.tierId, r.name, r.color, r.position, r.active])),
    engagement: await upsertRows(db, "fansly_creator_stats_engagement", ["day", "metric", "source"], ["day", "metric", "source", "value"],
      lineage, summary.engagement.map((r) => [r.day, r.metric, r.source, r.value])),
    windows: await upsertRows(db, "fansly_creator_stats_windows", ["after_day", "before_day", "scope", "ref", "metric"],
      ["after_day", "before_day", "scope", "ref", "metric", "value", "previous"],
      lineage, summary.windowTotals.map((r) => [summary.afterDay, summary.beforeDay, r.scope, r.ref, r.metric, r.value, r.previous])),
  };
}
