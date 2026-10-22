import { CREATOR_STATS_MAX_SPAN_DAYS, DAY_MS, utcDayStart, wholeNumber, type CreatorStatsWindow } from "./creator-stats.ts";

// Fansly's creator statistics of 2026-10, the media plane (map:
// reference/fansly-creator-stats §5.3–5.4): the typed rows of
// `/account/stats/media/top` and `/account/stats/media`, and which windows a
// visit of one media offer asks for.
//
// Wire (map §4, live answers): bounds echoed as numbers (`afterBucket`,
// `beforeBucket`), row buckets as decimal strings (`bucket`, `hourBucket`),
// ids as strings, counters and `source` as numbers. A counter the answer does
// not carry is null, never 0; a row exists only for a bucket with activity.

/** A surface of a media request: 0 For You, 1 Timeline, 4 Other; -1 asks for
 *  the daily rows of every surface at once (and `likes[]`), nothing else. */
export type MediaSurface = -1 | 0 | 1 | 4;

/** Media up to this old are read per named surface (0 and 1, and 4 when the
 *  top list showed them there): For You stops serving a video on its 91st day
 *  (map §8), so older media are read as `-1` (every surface's days) and `1`
 *  (Timeline's totals, retention, hours and tags). */
export const MEDIA_SURFACE_AGE_DAYS = 93;

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

function instant(value: unknown): Date | null {
  const ms = wholeNumber(value);
  return ms === null || ms <= 0 ? null : new Date(ms);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function servedOf(body: Record<string, unknown>): CreatorStatsWindow | null {
  const afterMs = wholeNumber(body.afterBucket);
  const beforeMs = wholeNumber(body.beforeBucket);
  return afterMs === null || beforeMs === null || afterMs > beforeMs ? null : { afterMs, beforeMs };
}

/** The counters every media row of both routes shares. */
export interface MediaCounters {
  views: number | null;
  impressions: number | null;
  videoViews: number | null;
  completedViews: number | null;
  watchMs: number | null;
  watchPctSum: string | null;
  replays: number | null;
}

function countersOf(row: Record<string, unknown>): MediaCounters {
  return {
    views: count(row.views),
    impressions: count(row.impressions),
    videoViews: count(row.videoViews),
    completedViews: count(row.completedViews),
    watchMs: count(row.watchMs),
    watchPctSum: decimal(row.watchPctSum),
    replays: count(row.replays),
  };
}

// ── /account/stats/media ─────────────────────────────────────────────────────

export interface MediaDailyRow extends MediaCounters {
  mediaId: string;
  mediaType: number | null;
  source: number;
  day: string;
  uniqueViewers: number | null;
  durationMs: number | null;
}

export interface MediaHourlyRow extends MediaCounters {
  mediaId: string;
  mediaType: number | null;
  source: number;
  hourStart: Date;
}

export interface RetentionPoint {
  percent: number;
  stillWatching: number;
}

export interface MediaTotalsRow extends MediaCounters {
  mediaId: string;
  mediaType: number | null;
  source: number;
  durationMs: number | null;
  retention: RetentionPoint[];
  retentionSampleSize: number | null;
}

export interface MediaTagRow {
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
}

export interface MediaTagSeriesRow {
  tagId: string;
  kind: number;
  tag: string | null;
  day: string;
  views: number | null;
}

export interface MediaLikesRow {
  source: number;
  day: string;
  likes: number | null;
  unlikes: number | null;
}

export interface MediaAnswer {
  /** The offer the answer says it is about; null when it does not say. */
  mediaOfferId: string | null;
  /** The window the server served (echoed); null when it echoed none. */
  served: CreatorStatsWindow | null;
  daily: MediaDailyRow[];
  hourly: MediaHourlyRow[];
  totals: MediaTotalsRow[];
  /** A tag's totals over the served window (a named surface only). */
  tags: MediaTagRow[];
  tagSeries: MediaTagSeriesRow[];
  likes: MediaLikesRow[];
  /** Rows the answer carried that had no bucket, id or surface. */
  skipped: number;
}

function retentionOf(value: unknown): RetentionPoint[] {
  const out: RetentionPoint[] = [];
  for (const point of records(value)) {
    const percent = point.percent;
    const still = point.stillWatching;
    if (typeof percent === "number" && Number.isFinite(percent) && typeof still === "number" && Number.isFinite(still)) {
      out.push({ percent, stillWatching: still });
    }
  }
  return out;
}

/**
 * The typed rows of one `/account/stats/media` answer to a request for
 * `source`. A row's own `source` wins (a `-1` answer carries every surface's
 * days); tags, tag series and totals without one are the asked surface's.
 * Null when the body is not such an answer (no `media` array).
 */
export function parseMediaAnswer(response: unknown, source: MediaSurface): MediaAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.media)) return null;
  const tagNames = new Map<string, string>();
  for (const tag of records(recordOf(body.aggregationData)?.tags)) {
    const tagId = id(tag.id);
    if (tagId !== null && typeof tag.tag === "string") tagNames.set(tagId, tag.tag);
  }
  const answer: MediaAnswer = {
    mediaOfferId: id(body.mediaOfferId),
    served: servedOf(body),
    daily: [],
    hourly: [],
    totals: [],
    tags: [],
    tagSeries: [],
    likes: [],
    skipped: 0,
  };
  const surfaceOf = (row: Record<string, unknown>): number | null => {
    const own = wholeNumber(row.source);
    if (own !== null) return own;
    return source === -1 ? null : source;
  };

  for (const media of records(body.media)) {
    const mediaId = id(media.mediaId);
    if (mediaId === null) {
      answer.skipped += 1;
      continue;
    }
    const mediaType = wholeNumber(media.mediaType);
    for (const row of records(media.daily)) {
      const at = instant(row.bucket);
      const surface = surfaceOf(row);
      if (at === null || surface === null) {
        answer.skipped += 1;
        continue;
      }
      answer.daily.push({
        mediaId: id(row.mediaId) ?? mediaId,
        mediaType: wholeNumber(row.mediaType) ?? mediaType,
        source: surface,
        day: isoDay(at),
        ...countersOf(row),
        uniqueViewers: count(row.uniqueViewers),
        durationMs: count(row.durationMs),
      });
    }
    for (const row of records(media.hours)) {
      const at = instant(row.hourBucket);
      const surface = surfaceOf(row);
      if (at === null || surface === null) {
        answer.skipped += 1;
        continue;
      }
      answer.hourly.push({
        mediaId: id(row.mediaId) ?? mediaId,
        mediaType: wholeNumber(row.mediaType) ?? mediaType,
        source: surface,
        hourStart: at,
        ...countersOf(row),
      });
    }
    const totals = recordOf(media.totals);
    if (totals !== null) {
      const surface = surfaceOf(totals);
      if (surface === null || surface < 0) {
        answer.skipped += 1;
      } else {
        answer.totals.push({
          mediaId: id(totals.mediaId) ?? mediaId,
          mediaType: wholeNumber(totals.mediaType) ?? mediaType,
          source: surface,
          ...countersOf(totals),
          durationMs: count(totals.durationMs),
          retention: retentionOf(media.retention),
          retentionSampleSize: count(media.retentionSampleSize),
        });
      }
    }
    for (const row of records(media.tags)) {
      const tagId = id(row.tagId);
      const kind = wholeNumber(row.kind) ?? 1;
      if (tagId === null || source === -1) {
        answer.skipped += 1;
        continue;
      }
      answer.tags.push({
        mediaId: id(row.mediaId) ?? mediaId,
        mediaType: wholeNumber(row.mediaType) ?? mediaType,
        tagId,
        kind,
        tag: tagNames.get(tagId) ?? null,
        views: count(row.views),
        videoViews: count(row.videoViews),
        completedViews: count(row.completedViews),
        watchMs: count(row.watchMs),
        watchPctSum: decimal(row.watchPctSum),
      });
    }
  }

  for (const row of records(body.tagSeries)) {
    const tagId = id(row.tagId);
    const at = instant(row.bucket);
    if (tagId === null || at === null || source === -1) {
      answer.skipped += 1;
      continue;
    }
    answer.tagSeries.push({ tagId, kind: wholeNumber(row.kind) ?? 1, tag: tagNames.get(tagId) ?? null, day: isoDay(at), views: count(row.views) });
  }
  for (const row of records(body.likes)) {
    const at = instant(row.bucket);
    const surface = wholeNumber(row.source);
    if (at === null || surface === null) {
      answer.skipped += 1;
      continue;
    }
    answer.likes.push({ source: surface, day: isoDay(at), likes: count(row.likes), unlikes: count(row.unlikes) });
  }
  return answer;
}

// ── /account/stats/media/top ─────────────────────────────────────────────────

export interface MediaTopRow extends MediaCounters {
  rank: number;
  mediaOfferId: string;
  mediaId: string;
  bestMediaId: string | null;
  offerLikes: number | null;
  offerUnlikes: number | null;
  mediaType: number | null;
  uniqueViewers: number | null;
  durationMs: number | null;
}

export interface MediaTopOffer {
  mediaOfferId: string;
  /** When the offer was placed (`creatorMediaOfferLocations[].createdAt`). */
  postedAtMs: number | null;
}

export interface MediaTopAnswer {
  /** The surface the server answered for (echoed); null when not said. */
  source: number | null;
  /** The media type it answered for: null = both. */
  mediaType: number | null;
  served: CreatorStatsWindow | null;
  rows: MediaTopRow[];
  /** Every offer the ranking names, once, in rank order. */
  offers: MediaTopOffer[];
  skipped: number;
}

/** The typed ranking of one `/account/stats/media/top` answer; null when the
 *  body is not one (no `offers` array). */
export function parseMediaTopAnswer(response: unknown): MediaTopAnswer | null {
  const body = recordOf(response);
  if (body === null || !Array.isArray(body.offers)) return null;
  const placed = new Map<string, number>();
  for (const location of records(recordOf(body.aggregationData)?.creatorMediaOfferLocations)) {
    const offerId = id(location.mediaOfferId);
    const createdAt = wholeNumber(location.createdAt);
    if (offerId === null || createdAt === null || createdAt <= 0) continue;
    placed.set(offerId, Math.min(placed.get(offerId) ?? createdAt, createdAt));
  }
  const rows: MediaTopRow[] = [];
  const offers = new Map<string, MediaTopOffer>();
  let skipped = 0;
  body.offers.forEach((value, index) => {
    const offer = recordOf(value);
    const mediaOfferId = offer === null ? null : id(offer.mediaOfferId);
    if (offer === null || mediaOfferId === null) {
      skipped += 1;
      return;
    }
    if (!offers.has(mediaOfferId)) offers.set(mediaOfferId, { mediaOfferId, postedAtMs: placed.get(mediaOfferId) ?? null });
    for (const media of records(offer.media)) {
      const mediaId = id(media.mediaId);
      if (mediaId === null) {
        skipped += 1;
        continue;
      }
      rows.push({
        rank: index + 1,
        mediaOfferId,
        mediaId,
        bestMediaId: id(offer.bestMediaId),
        offerLikes: count(offer.likes),
        offerUnlikes: count(offer.unlikes),
        mediaType: wholeNumber(media.mediaType),
        ...countersOf(media),
        uniqueViewers: count(media.uniqueViewers),
        durationMs: count(media.durationMs),
      });
    }
  });
  return {
    source: wholeNumber(body.source),
    mediaType: wholeNumber(body.mediaType),
    served: servedOf(body),
    rows,
    offers: [...offers.values()],
    skipped,
  };
}

// ── one visit's windows ──────────────────────────────────────────────────────

/** What the walk's queue row remembers of an offer (`backfill_cursor`). */
export interface MediaQueueState {
  /** When the media was posted (the age basis); null when never said. */
  postedAtMs: number | null;
  /** When the model deleted it; null while it is up. */
  deletedAtMs: number | null;
  /** The top list showed it on surface 4 (Other). */
  other: boolean;
  /** Per surface (`"-1"`, `"0"`, `"1"`, `"4"`): the last UTC day read. */
  through: Partial<Record<string, number>>;
}

export function parseMediaQueueState(value: unknown): MediaQueueState {
  const record = recordOf(value) ?? {};
  const posted = wholeNumber(record.postedAtMs);
  const deleted = wholeNumber(record.deletedAtMs);
  const through: Partial<Record<string, number>> = {};
  for (const [surface, day] of Object.entries(recordOf(record.through) ?? {})) {
    const ms = wholeNumber(day);
    if (ms !== null && ms > 0) through[surface] = ms;
  }
  return {
    postedAtMs: posted !== null && posted > 0 ? posted : null,
    deletedAtMs: deleted !== null && deleted > 0 ? deleted : null,
    other: record.other === true,
    through,
  };
}

/** One request of a visit: a surface over a window of whole UTC days. */
export interface MediaAsk extends CreatorStatsWindow {
  source: MediaSurface;
}

/** The media's age in days at `now`; a media that never said when it was
 *  posted counts as old (the cheapest cadence, read as `-1` and `1`). */
export function mediaAgeDays(postedAtMs: number | null, now: Date): number {
  if (postedAtMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - postedAtMs) / DAY_MS);
}

/** The surfaces a visit reads, in order. */
export function mediaVisitSurfaces(ageDays: number, other: boolean): MediaSurface[] {
  return ageDays <= MEDIA_SURFACE_AGE_DAYS ? [0, 1, ...(other ? [4 as const] : [])] : [-1, 1];
}

/**
 * Every request of one visit, in order: per surface, from the day before the
 * last day read (Fansly corrects the recent days) — or from the posting day
 * when the surface was never read — to today, in spans of at most 400 days,
 * oldest first (an interrupted walk goes on from the last span it read).
 */
export function mediaVisitAsks(state: MediaQueueState, now: Date): MediaAsk[] {
  const today = utcDayStart(now.getTime());
  const ageDays = mediaAgeDays(state.postedAtMs, now);
  const floor = state.postedAtMs === null
    ? today - (CREATOR_STATS_MAX_SPAN_DAYS - 1) * DAY_MS
    : Math.min(today, utcDayStart(state.postedAtMs));
  const asks: MediaAsk[] = [];
  for (const source of mediaVisitSurfaces(ageDays, state.other)) {
    const read = state.through[String(source)];
    let afterMs = read === undefined ? floor : Math.min(today, Math.max(floor, utcDayStart(read) - DAY_MS));
    while (afterMs <= today) {
      const beforeMs = Math.min(today, afterMs + (CREATOR_STATS_MAX_SPAN_DAYS - 1) * DAY_MS);
      asks.push({ source, afterMs, beforeMs });
      afterMs = beforeMs + DAY_MS;
    }
  }
  return asks;
}

/** One age tier of the walk: media up to `maxAgeDays` old (null: older) are
 *  due again `everyMs` after a visit. */
export interface MediaTier {
  maxAgeDays: number | null;
  everyMs: number;
}

/** The tier a media of this age is in (the last tier for anything older). */
export function mediaTierIndex(tiers: readonly MediaTier[], ageDays: number): number {
  const index = tiers.findIndex((tier) => tier.maxAgeDays === null || ageDays <= tier.maxAgeDays);
  return index === -1 ? tiers.length - 1 : index;
}
