import { DAY_MS, utcDayStart, wholeNumber, type CreatorStatsWindow } from "./creator-stats.ts";

// Fansly's creator statistics of 2026-10, the audience plane (map:
// reference/fansly-creator-stats §5.5–5.9): the windows the
// `creator-stats.audience*` and `creator-stats.media-shown` resources ask for
// and the typed rows of `/account/stats/geo`, `/tags`, `/media/benchmarks`,
// `/media/shown` and `/activehours`.
//
// Each of these routes answers for one surface (`source` 0, 1 or 4) and one
// window as a whole: a geo or tag row is the window's total, not a day's, so
// the rows are kept under the window the server served (`afterBucket`,
// `beforeBucket`, both UTC days, `before` included). A counter the answer does
// not carry is null, never 0. Ratios and averages are kept as decimal text.

export const HOUR_MS = 3_600_000;

/** The surfaces the official client asks for (map §4: 0 For You, 1 Timeline, 4 Other). */
export const AUDIENCE_SOURCES = [0, 1, 4] as const;
export type AudienceSource = (typeof AUDIENCE_SOURCES)[number];

/** How long after a UTC day (or an hour) ends its read counts as final:
 *  Fansly's own counters settle after the bucket closes. */
export const AUDIENCE_SETTLE_MS = 2 * HOUR_MS;

/** The largest `limit` proven on the wire for `geo` and `tags` (map §5.7,
 *  §5.9: 198 countries and 112 tags came back under it). An answer that
 *  fills it may have been cut. */
export const AUDIENCE_ROWS_LIMIT = 200;

// ── windows ──────────────────────────────────────────────────────────────────

/** The last UTC day that ended at least the settle time ago. */
export function lastSettledDay(now: Date): number {
  return utcDayStart(now.getTime() - AUDIENCE_SETTLE_MS) - DAY_MS;
}

/** The start of the last hour that ended at least `lagMs` ago. */
export function lastFullHour(now: Date, lagMs: number): number {
  return Math.floor((now.getTime() - lagMs) / HOUR_MS) * HOUR_MS - HOUR_MS;
}

/** The `days` whole UTC days that end with `lastDayMs`. */
export function daysEndingWith(lastDayMs: number, days: number): CreatorStatsWindow {
  return { afterMs: lastDayMs - (days - 1) * DAY_MS, beforeMs: lastDayMs };
}

/**
 * The one-day windows a steady geo sweep reads: every day after the last one
 * read final (`finalThroughMs`) up to today, at most `maxDays` of them (an
 * older gap is the history walk's), and from yesterday on a first sweep.
 */
export function steadyGeoDays(now: Date, finalThroughMs: number | null, maxDays: number): { firstDayMs: number; todayMs: number } {
  const todayMs = utcDayStart(now.getTime());
  const oldest = todayMs - (maxDays - 1) * DAY_MS;
  const next = finalThroughMs === null ? todayMs - DAY_MS : finalThroughMs + DAY_MS;
  return { firstDayMs: Math.min(todayMs, Math.max(oldest, next)), todayMs };
}

/** The calendar month (UTC) that holds `lastDayMs`, from its first day (or
 *  the floor) to `lastDayMs`; null when `lastDayMs` is before the floor. */
export function monthEndingWith(lastDayMs: number, floorMs: number): CreatorStatsWindow | null {
  const floor = utcDayStart(floorMs);
  if (lastDayMs < floor) return null;
  const day = new Date(lastDayMs);
  const monthStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1);
  return { afterMs: Math.max(monthStart, floor), beforeMs: lastDayMs };
}

/** The calendar month before the one that starts at `afterMs`, clipped by the
 *  floor; null once the floor is passed. */
export function previousMonth(afterMs: number, floorMs: number): CreatorStatsWindow | null {
  return monthEndingWith(afterMs - DAY_MS, floorMs);
}

// ── values ───────────────────────────────────────────────────────────────────

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function count(value: unknown): number | null {
  const parsed = wholeNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

/** A finite number kept as its decimal text (a ratio, an average, a lift). */
function decimal(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return null;
}

function id(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The window an answer echoes; null when it echoes none. */
function servedWindow(body: Record<string, unknown>): CreatorStatsWindow | null {
  const afterMs = wholeNumber(body.afterBucket);
  const beforeMs = wholeNumber(body.beforeBucket);
  return afterMs === null || beforeMs === null || afterMs > beforeMs ? null : { afterMs, beforeMs };
}

/** What every windowed answer echoes. */
export interface AudienceEcho {
  /** The surface the answer is for; null when not echoed. */
  source: number | null;
  /** The window the server served; null when it echoed none. */
  served: CreatorStatsWindow | null;
}

function echoOf(body: Record<string, unknown>): AudienceEcho {
  return { source: wholeNumber(body.source), served: servedWindow(body) };
}

// ── geo ──────────────────────────────────────────────────────────────────────

/** One country of a geo window: its views (`rows[]`) and its profile visits
 *  (`profileRows[]`), merged; a side the country is not among is null. */
export interface GeoRow {
  /** Upper-case ISO code as served; '' is Fansly's "Unknown". */
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

export interface GeoAnswer extends AudienceEcho {
  rows: GeoRow[];
  /** The lengths of the two arrays as served (one may hit the limit). */
  viewRows: number;
  profileRows: number;
  skipped: number;
}

export function parseGeoAnswer(response: unknown): GeoAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.rows)) return null;
  const byCountry = new Map<string, GeoRow>();
  const rowOf = (country: string): GeoRow => {
    let row = byCountry.get(country);
    if (row === undefined) {
      row = {
        country, views: null, imageViews: null, videoViews: null, watchMs: null, watchPctSum: null,
        avgWatchPercent: null, avgWatchMs: null, profileVisits: null,
      };
      byCountry.set(country, row);
    }
    return row;
  };
  let skipped = 0;
  const viewRows = records(body.rows);
  for (const served of viewRows) {
    if (typeof served.country !== "string") {
      skipped += 1;
      continue;
    }
    Object.assign(rowOf(served.country), {
      views: count(served.views),
      imageViews: count(served.imageViews),
      videoViews: count(served.videoViews),
      watchMs: count(served.watchMs),
      watchPctSum: decimal(served.watchPctSum),
      avgWatchPercent: decimal(served.avgWatchPercent),
      avgWatchMs: decimal(served.avgWatchMs),
    });
  }
  const profileRows = records(body.profileRows);
  for (const served of profileRows) {
    if (typeof served.country !== "string") {
      skipped += 1;
      continue;
    }
    rowOf(served.country).profileVisits = count(served.profileVisits);
  }
  return { ...echoOf(body), rows: [...byCountry.values()], viewRows: viewRows.length, profileRows: profileRows.length, skipped };
}

// ── tags ─────────────────────────────────────────────────────────────────────

/** One tag's totals over the window. */
export interface TagRow {
  tagId: string;
  views: number | null;
  imageViews: number | null;
  videoViews: number | null;
  watchMs: number | null;
  imageWatchMs: number | null;
  completedViews: number | null;
  watchPctSum: string | null;
  /** Percentage points over the page's other viewers; null when not served
   *  (a window over 120 days, or no other viewers to compare). */
  liftPoints: string | null;
  liftVideoViews: number | null;
}

/** One tag's views on one UTC day of the window. */
export interface TagSeriesRow {
  tagId: string;
  day: string;
  views: number | null;
  imageViews: number | null;
}

export interface TagsAnswer extends AudienceEcho {
  kind: number | null;
  liftAvailable: boolean | null;
  rows: TagRow[];
  series: TagSeriesRow[];
  names: { tagId: string; tag: string }[];
  skipped: number;
}

export function parseTagsAnswer(response: unknown): TagsAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.rows)) return null;
  let skipped = 0;
  const rows: TagRow[] = [];
  for (const served of records(body.rows)) {
    const tagId = id(served.tagId);
    if (tagId === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      tagId,
      views: count(served.views),
      imageViews: count(served.imageViews),
      videoViews: count(served.videoViews),
      watchMs: count(served.watchMs),
      imageWatchMs: count(served.imageWatchMs),
      completedViews: count(served.completedViews),
      watchPctSum: decimal(served.watchPctSum),
      liftPoints: decimal(served.liftPoints),
      liftVideoViews: count(served.liftVideoViews),
    });
  }
  const series: TagSeriesRow[] = [];
  for (const served of records(body.series)) {
    const tagId = id(served.tagId);
    const at = wholeNumber(served.bucket);
    if (tagId === null || at === null || at <= 0) {
      skipped += 1;
      continue;
    }
    series.push({ tagId, day: isoDay(at), views: count(served.views), imageViews: count(served.imageViews) });
  }
  const names: { tagId: string; tag: string }[] = [];
  for (const tag of records(recordOf(body.aggregationData)?.tags)) {
    const tagId = id(tag.id);
    if (tagId !== null && typeof tag.tag === "string") names.push({ tagId, tag: tag.tag });
  }
  return {
    ...echoOf(body),
    kind: wholeNumber(body.kind),
    liftAvailable: typeof body.liftAvailable === "boolean" ? body.liftAvailable : null,
    rows,
    series,
    names,
    skipped,
  };
}

// ── media/benchmarks ─────────────────────────────────────────────────────────

/** One video-length bucket of the creator's own averages over the window. */
export interface BenchmarkRow {
  lengthBucket: number;
  /** The length range in ms as served; `maxMs` 0 is the open last bucket. */
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

export interface BenchmarksAnswer extends AudienceEcho {
  rows: BenchmarkRow[];
  skipped: number;
}

export function parseBenchmarksAnswer(response: unknown): BenchmarksAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.buckets)) return null;
  let skipped = 0;
  const rows: BenchmarkRow[] = [];
  for (const served of records(body.buckets)) {
    const lengthBucket = wholeNumber(served.lengthBucket);
    if (lengthBucket === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      lengthBucket,
      minMs: count(served.minMs),
      maxMs: count(served.maxMs),
      mediaCount: count(served.mediaCount),
      views: count(served.views),
      videoViews: count(served.videoViews),
      watchMs: count(served.watchMs),
      completedViews: count(served.completedViews),
      watchPctSum: decimal(served.watchPctSum),
      avgWatchPercent: decimal(served.avgWatchPercent),
      completionRate: decimal(served.completionRate),
      avgWatchMs: decimal(served.avgWatchMs),
    });
  }
  return { ...echoOf(body), rows, skipped };
}

// ── media/shown ──────────────────────────────────────────────────────────────

/** The number of different videos a surface put in front of someone over
 *  the answer's hours, and over the equally long span before. */
export interface MediaShownRow {
  source: number;
  mediaShown: number | null;
  previousMediaShown: number | null;
}

export interface MediaShownAnswer {
  /** The last hour of the span (its start, ms), as served; null when not echoed. */
  endHourMs: number | null;
  hours: number | null;
  rows: MediaShownRow[];
  skipped: number;
}

export function parseMediaShownAnswer(response: unknown): MediaShownAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.rows)) return null;
  let skipped = 0;
  const rows: MediaShownRow[] = [];
  for (const served of records(body.rows)) {
    const source = wholeNumber(served.source);
    if (source === null) {
      skipped += 1;
      continue;
    }
    rows.push({ source, mediaShown: count(served.mediaShown), previousMediaShown: count(served.previousMediaShown) });
  }
  const endHourMs = wholeNumber(body.endHour);
  const hours = wholeNumber(body.hours);
  return { endHourMs: endHourMs !== null && endHourMs > 0 ? endHourMs : null, hours: hours !== null && hours > 0 ? hours : null, rows, skipped };
}

// ── activehours ──────────────────────────────────────────────────────────────

/** One weekday-hour cell; weekday 0 is Sunday. */
export interface ActiveHourCell {
  weekday: number;
  hour: number;
  views: number | null;
  imageViews: number | null;
}

export interface ActiveHoursAnswer extends AudienceEcho {
  /** Minutes east of UTC the matrix is laid out in; null when not echoed. */
  timezoneOffsetMinutes: number | null;
  cells: ActiveHourCell[];
}

function matrix(value: unknown): unknown[][] | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const days = value.filter((day): day is unknown[] => Array.isArray(day) && day.length === 24);
  return days.length === 7 ? days : null;
}

/** The 7 × 24 matrices of views and image views; null when `views` is not one. */
export function parseActiveHoursAnswer(response: unknown): ActiveHoursAnswer | null {
  const body = recordOf(response);
  const views = body === null ? null : matrix(body.views);
  if (body === null || views === null) return null;
  const imageViews = matrix(body.imageViews);
  const cells: ActiveHourCell[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({ weekday, hour, views: count(views[weekday]![hour]), imageViews: imageViews === null ? null : count(imageViews[weekday]![hour]) });
    }
  }
  return { ...echoOf(body), timezoneOffsetMinutes: wholeNumber(body.timezoneOffsetMinutes), cells };
}
