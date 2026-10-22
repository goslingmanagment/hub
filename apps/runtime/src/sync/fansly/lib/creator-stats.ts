import { millsFromInteger, type Mills } from "@agency_hub_core/shared";

// Fansly's creator statistics of 2026-10 (`/account/stats/*`, map:
// reference/fansly-creator-stats): the windows the `creator-stats.*`
// resources ask for and the typed rows of the account plane's answers.
//
// Time (map §4): windows are whole UTC days in epoch ms, `before` inclusive;
// the server rounds both bounds to days (hour granularity too), shortens a
// span over 400 days without an error and echoes what it served
// (`afterBucket`, `beforeBucket`). Row buckets are decimal strings in
// `series`, numbers in `summary`. Money is mills. A counter the answer does
// not carry is null, never 0; a row exists only for a bucket with activity.

export const DAY_MS = 86_400_000;
/** The longest span `series` and `summary` serve (map §4). */
export const CREATOR_STATS_MAX_SPAN_DAYS = 400;
/** The oldest month `series` revenue reaches (map §4: 2019-06-25). */
export const CREATOR_STATS_REVENUE_FLOOR_MS = Date.UTC(2019, 5, 1);

export const CREATOR_STATS_FAMILIES = ["views", "profile", "follows", "subscriptions", "revenue"] as const;
export type CreatorStatsFamily = (typeof CREATOR_STATS_FAMILIES)[number];
export type CreatorStatsGranularity = "hour" | "day" | "month";

/** A window of whole UTC days, `beforeMs` the last day included. */
export interface CreatorStatsWindow {
  afterMs: number;
  beforeMs: number;
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The `days` UTC days ending with today's. */
export function trailingDays(now: Date, days: number): CreatorStatsWindow {
  const today = utcDayStart(now.getTime());
  return { afterMs: today - (days - 1) * DAY_MS, beforeMs: today };
}

/** The window of at most 400 days that ends the day before `afterMs` and
 *  starts no earlier than `floorMs`; null once the floor is passed. */
export function previousSpan(afterMs: number, floorMs: number): CreatorStatsWindow | null {
  const beforeMs = afterMs - DAY_MS;
  const floor = utcDayStart(floorMs);
  if (beforeMs < floor) return null;
  return { afterMs: Math.max(floor, beforeMs - (CREATOR_STATS_MAX_SPAN_DAYS - 1) * DAY_MS), beforeMs };
}

// ── values ───────────────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((row): row is Record<string, unknown> => row !== null) : [];
}

/** A whole number as served: a JSON number or a decimal string. */
export function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** A count: a whole number that is not negative. */
function count(value: unknown): number | null {
  const parsed = wholeNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function mills(value: unknown): Mills | null {
  const parsed = wholeNumber(value);
  return parsed === null ? null : millsFromInteger(parsed);
}

/** A finite number kept as its decimal text (a sum of percentages, a ratio). */
function decimal(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** An instant of a bucket: epoch ms, a day or an hour start. */
function bucket(value: unknown): Date | null {
  const ms = wholeNumber(value);
  return ms === null || ms <= 0 ? null : new Date(ms);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── series ───────────────────────────────────────────────────────────────────

export interface ViewsRow {
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

export interface ProfileRow {
  bucketStart: Date;
  source: number;
  profileVisits: number | null;
  uniqueVisitors: number | null;
  profileWatchMs: number | null;
}

export interface FollowsRow {
  bucketStart: Date;
  follows: number | null;
  unfollows: number | null;
}

export interface SubscriptionsRow {
  bucketStart: Date;
  tierId: string;
  subscriptionsNew: number | null;
  subscriptionsRenewed: number | null;
  subscriptionsExpired: number | null;
  subscriptionsCancelled: number | null;
  subscriptionsMovedIn: number | null;
  subscriptionsMovedOut: number | null;
}

export interface RevenueRow {
  bucketStart: Date;
  productType: number;
  transactions: number | null;
  grossMills: Mills | null;
  netMills: Mills | null;
  refunds: number | null;
  refundedGrossMills: Mills | null;
  refundedNetMills: Mills | null;
}

export type SeriesRows =
  | { family: "views"; rows: ViewsRow[] }
  | { family: "profile"; rows: ProfileRow[] }
  | { family: "follows"; rows: FollowsRow[] }
  | { family: "subscriptions"; rows: SubscriptionsRow[] }
  | { family: "revenue"; rows: RevenueRow[] };

export type SeriesAnswer = SeriesRows & {
  granularity: CreatorStatsGranularity;
  /** The window the server served (echoed); null when it echoed none. */
  served: CreatorStatsWindow | null;
  /** Rows the answer carried that had no bucket or no dimension. */
  skipped: number;
};

function served(response: Record<string, unknown>): CreatorStatsWindow | null {
  const afterMs = wholeNumber(response.afterBucket);
  const beforeMs = wholeNumber(response.beforeBucket);
  return afterMs === null || beforeMs === null ? null : { afterMs, beforeMs };
}

/** One row of a family, or null when it lacks its bucket or dimension. */
type RowBuilder<R> = (row: Record<string, unknown>, bucketStart: Date) => R | null;

const SERIES_BUILDERS: { [F in CreatorStatsFamily]: RowBuilder<Extract<SeriesRows, { family: F }>["rows"][number]> } = {
  views: (row, bucketStart) => {
    const source = wholeNumber(row.source);
    return source === null ? null : {
      bucketStart,
      source,
      views: count(row.views),
      impressions: count(row.impressions),
      uniqueViewers: count(row.uniqueViewers),
      videoViews: count(row.videoViews),
      completedViews: count(row.completedViews),
      watchMs: count(row.watchMs),
      watchPctSum: decimal(row.watchPctSum),
      replays: count(row.replays),
      imageViews: count(row.imageViews),
      imageImpressions: count(row.imageImpressions),
      uniqueImageViewers: count(row.uniqueImageViewers),
      imageWatchMs: count(row.imageWatchMs),
    };
  },
  profile: (row, bucketStart) => {
    const source = wholeNumber(row.source);
    return source === null ? null : {
      bucketStart,
      source,
      profileVisits: count(row.profileVisits),
      uniqueVisitors: count(row.uniqueVisitors),
      profileWatchMs: count(row.profileWatchMs),
    };
  },
  follows: (row, bucketStart) => ({ bucketStart, follows: count(row.follows), unfollows: count(row.unfollows) }),
  subscriptions: (row, bucketStart) => {
    const tierId = text(row.tierId);
    return tierId === null ? null : {
      bucketStart,
      tierId,
      subscriptionsNew: count(row.subscriptionsNew),
      subscriptionsRenewed: count(row.subscriptionsRenewed),
      subscriptionsExpired: count(row.subscriptionsExpired),
      subscriptionsCancelled: count(row.subscriptionsCancelled),
      subscriptionsMovedIn: count(row.subscriptionsMovedIn),
      subscriptionsMovedOut: count(row.subscriptionsMovedOut),
    };
  },
  revenue: (row, bucketStart) => {
    const productType = wholeNumber(row.productType);
    return productType === null ? null : {
      bucketStart,
      productType,
      transactions: count(row.transactions),
      grossMills: mills(row.grossMills),
      netMills: mills(row.netMills),
      refunds: count(row.refunds),
      refundedGrossMills: mills(row.refundedGrossMills),
      refundedNetMills: mills(row.refundedNetMills),
    };
  },
};

/**
 * The typed rows of one `/account/stats/series` answer to a request for
 * `family` at `granularity`. An answer that names another family or
 * granularity, or has no `rows` array, is not this request's: null.
 */
export function parseSeriesAnswer(
  response: unknown,
  family: CreatorStatsFamily,
  granularity: CreatorStatsGranularity,
): SeriesAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.rows)) return null;
  if (body.family !== undefined && body.family !== family) return null;
  if (body.granularity !== undefined && body.granularity !== granularity) return null;
  const field = granularity === "hour" ? "hourBucket" : "bucket";
  const build = SERIES_BUILDERS[family] as RowBuilder<SeriesRows["rows"][number]>;
  const rows: SeriesRows["rows"][number][] = [];
  let skipped = 0;
  for (const row of records(body.rows)) {
    const at = bucket(row[field] ?? row.bucket);
    const built = at === null ? null : build(row, at);
    if (built === null) skipped += 1;
    else rows.push(built);
  }
  return { family, rows, granularity, served: served(body), skipped } as SeriesAnswer;
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface LevelsRow {
  day: string;
  followerCount: number | null;
  subscriberCount: number | null;
}

export interface TierLevelsRow {
  tierId: string;
  day: string;
  subscriberCount: number | null;
}

export interface TierRow {
  tierId: string;
  name: string | null;
  color: string | null;
  position: number | null;
  active: boolean | null;
}

export type EngagementMetric = "comments" | "post_likes" | "media_likes";

export interface EngagementRow {
  day: string;
  metric: EngagementMetric;
  /** The surface of a media like; -1 for comments and post likes. */
  source: number;
  value: number | null;
}

export interface WindowTotalRow {
  scope: string;
  ref: string;
  metric: string;
  value: string | null;
  previous: string | null;
}

export interface SummaryAnswer {
  /** The window the server served (echoed); null when it echoed none. */
  served: CreatorStatsWindow | null;
  /** Where Fansly's collection starts (ms); null when not said. */
  dataSince: number | null;
  levels: LevelsRow[];
  tierLevels: TierLevelsRow[];
  tiers: TierRow[];
  engagement: EngagementRow[];
  windowTotals: WindowTotalRow[];
}

/** `{ value, previous }` pairs and flags of one section object, flattened:
 *  every key whose value is such a pair, a number or a boolean. */
function totalsOf(section: Record<string, unknown>, scope: string, ref: string, skip: ReadonlySet<string>): WindowTotalRow[] {
  const out: WindowTotalRow[] = [];
  for (const [metric, value] of Object.entries(section)) {
    if (skip.has(metric)) continue;
    const pair = recordOf(value);
    if (pair !== null && ("value" in pair || "previous" in pair)) {
      out.push({ scope, ref, metric, value: decimal(pair.value), previous: decimal(pair.previous) });
    } else if (typeof value === "number") {
      out.push({ scope, ref, metric, value: decimal(value), previous: null });
    } else if (typeof value === "boolean") {
      out.push({ scope, ref, metric, value: value ? "1" : "0", previous: null });
    }
  }
  return out;
}

function pointsOf(value: unknown): { day: string; value: number | null }[] {
  const out: { day: string; value: number | null }[] = [];
  for (const point of records(value)) {
    const at = bucket(point.bucket);
    if (at !== null) out.push({ day: isoDay(at), value: count(point.value) });
  }
  return out;
}

const DIMENSION_KEYS = new Set(["source", "productType", "tierId", "series", "levels", "bySource", "byProductType", "byTier",
  "tierName", "tierColor", "tierPos", "tierActive"]);

/** The typed rows of one `/account/stats/summary` answer; null when it is not one. */
export function parseSummaryAnswer(response: unknown): SummaryAnswer | null {
  const body = recordOf(response);
  if (body === null || (!Array.isArray(body.levels) && !Array.isArray(body.views) && recordOf(body.revenue) === null)) return null;
  const levels: LevelsRow[] = [];
  for (const point of records(body.levels)) {
    const at = bucket(point.bucket);
    if (at !== null) levels.push({ day: isoDay(at), followerCount: count(point.followerCount), subscriberCount: count(point.subscriberCount) });
  }

  const windowTotals: WindowTotalRow[] = [];
  for (const metric of ["followerCount", "subscriberCount"]) {
    const pair = recordOf(body[metric]);
    if (pair !== null) windowTotals.push({ scope: "account", ref: "", metric, value: decimal(pair.value), previous: decimal(pair.previous) });
  }

  for (const row of records(body.views)) {
    const source = wholeNumber(row.source);
    if (source !== null) windowTotals.push(...totalsOf(row, "views", String(source), DIMENSION_KEYS));
  }

  const profile = recordOf(body.profile);
  if (profile !== null) {
    windowTotals.push(...totalsOf(profile, "profile", "", DIMENSION_KEYS));
    for (const row of records(profile.bySource)) {
      const source = wholeNumber(row.source);
      if (source !== null) windowTotals.push(...totalsOf(row, "profile", String(source), DIMENSION_KEYS));
    }
  }

  const follows = recordOf(body.follows);
  if (follows !== null) windowTotals.push(...totalsOf(follows, "follows", "", DIMENSION_KEYS));

  const revenue = recordOf(body.revenue);
  if (revenue !== null) {
    windowTotals.push(...totalsOf(revenue, "revenue", "", DIMENSION_KEYS));
    for (const row of records(revenue.byProductType)) {
      const productType = wholeNumber(row.productType);
      if (productType !== null) windowTotals.push(...totalsOf(row, "revenue", String(productType), DIMENSION_KEYS));
    }
  }

  const tiers: TierRow[] = [];
  const tierLevels: TierLevelsRow[] = [];
  const subscriptions = recordOf(body.subscriptions);
  if (subscriptions !== null) {
    windowTotals.push(...totalsOf(subscriptions, "subscriptions", "", DIMENSION_KEYS));
    for (const row of records(subscriptions.byTier)) {
      const tierId = text(row.tierId);
      if (tierId === null) continue;
      tiers.push({
        tierId,
        name: typeof row.tierName === "string" ? row.tierName : null,
        color: typeof row.tierColor === "string" ? row.tierColor : null,
        position: wholeNumber(row.tierPos),
        active: typeof row.tierActive === "boolean" ? row.tierActive : null,
      });
      windowTotals.push(...totalsOf(row, "subscriptions", tierId, DIMENSION_KEYS));
      for (const point of records(row.levels)) {
        const at = bucket(point.bucket);
        if (at !== null) tierLevels.push({ tierId, day: isoDay(at), subscriberCount: count(point.subscriberCount) });
      }
    }
  }

  const engagement: EngagementRow[] = [];
  const engage = recordOf(body.engagement);
  if (engage !== null) {
    windowTotals.push(...totalsOf(engage, "engagement", "", DIMENSION_KEYS));
    const series = recordOf(engage.series);
    for (const point of pointsOf(series?.comments)) engagement.push({ ...point, metric: "comments", source: -1 });
    for (const point of pointsOf(series?.postLikes)) engagement.push({ ...point, metric: "post_likes", source: -1 });
    for (const row of records(engage.mediaLikes)) {
      const source = wholeNumber(row.source);
      if (source === null) continue;
      windowTotals.push(...totalsOf(row, "engagement", String(source), DIMENSION_KEYS));
      for (const point of pointsOf(recordOf(row.series)?.likes)) engagement.push({ ...point, metric: "media_likes", source });
    }
  }

  const dataSince = wholeNumber(body.dataSince);
  return {
    served: served(body),
    dataSince: dataSince !== null && dataSince > 0 ? dataSince : null,
    levels,
    tierLevels,
    tiers,
    engagement,
    windowTotals,
  };
}
