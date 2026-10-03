import {
  MEDIA_STATS_FRESH_SPAN_DAYS,
  MEDIA_STATS_LONG_TAIL_SPAN_DAYS,
  MEDIA_STATS_MID_SPAN_DAYS,
  type MediaStatsTier,
} from "@agency_hub_core/db";

import { fanslyUtcDayKey } from "./lane.ts";
import { classifyStatsWindow, parseWindowGuard, type BackfillWindowGuard } from "./stats-rules.ts";

// The per-media statistics rules of the Sync Engine's `media-stats.*`
// resources (resources/media-stats.ts): the `media_stats` cursor and the
// per-media backfill cursor, the steady windows of each tier and the refresh
// that closes a hole below them, the first-month probe and the creation floor,
// and the checks over a served window. Pure.

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEDIA_STATS_DAILY_PERIOD_MS = 86_400_000;
const DAILY_PERIOD_MS = MEDIA_STATS_DAILY_PERIOD_MS;

/**
 * THE STEADY WINDOW PER TIER — every tier reads DAILY buckets.
 *
 * Fresh items read the last 31 days: an item that young is covered from its
 * publication day on, so every visit restates the daily buckets the dashboard
 * reads — the partial launch-day bucket included — instead of leaving them as
 * the first-sight backfill wrote them. It is also the span the route is proven
 * to honour, and exactly the backfill's first window, which a first visit then
 * reuses rather than asks twice. The fresh tier used to read the last 24 hours
 * at HOURLY granularity; nothing reads per-media hourly buckets, and the daily
 * series behind the sparklines ended at an item's first visit. The hourly rows
 * already captured stay; none are produced any more.
 *
 * The spans are constants rather than config keys for the reason §6.1 gives:
 * they describe how traffic decays with an item's age, and the one thing an
 * operator should be turning is how much of that decay the lane can afford —
 * the daily cap — plus the long-tail cycle, which A6 names explicitly. They
 * live in the repository because the queue orders by them (the window's
 * edge, `listMediaStatsRefreshChunk`).
 */
const FRESH_TRAILING_DAYS = MEDIA_STATS_FRESH_SPAN_DAYS;
const MID_TRAILING_DAYS = MEDIA_STATS_MID_SPAN_DAYS;
export const LONG_TAIL_TRAILING_DAYS = MEDIA_STATS_LONG_TAIL_SPAN_DAYS;

/**
 * The span the provider is PROVEN to honour on this route (HAR 2026-08-19: a
 * historical `2026-07-01 → 2026-08-01` request came back `2026-06-30 →
 * 2026-07-31`, exact). Every backfill window and every split long-tail window is
 * this wide.
 */
export const BACKFILL_WINDOW_DAYS = 31;
export const BACKFILL_OVERLAP_DAYS = 1;
/**
 * Two consecutive all-empty windows, then ONE probe of the item's FIRST month.
 *
 * The walk runs BACKWARDS from today, so two empty windows prove only that the
 * item was idle recently — [E10], exactly as on the account lane — not that it
 * had no traffic before. The first month after publication is where most of an
 * item's views fall, so that is where the one probe looks. See `runBackfill`.
 */
export const BACKFILL_EMPTY_STREAK_LIMIT = 2;
/**
 * How far past an item's own creation the walk may still ask.
 *
 * ONE span, not zero: the creation instant is the platform's or ours, the
 * provider snaps windows to its bucket grid, and a window that straddles the
 * publication day is the last one that can carry anything. Past that there is
 * nothing to find — which the provider will happily confirm, one zero-valued
 * bucket at a time, all the way to 2006.
 */
const BACKFILL_CREATION_SLACK_DAYS = 31;
/** The six counters `/it/moie/statsnew` serves per `stats[]` row ([E5]: seven
 *  keys, six of them counters and one of them `type`). All zero — or absent —
 *  is NO TRAFFIC, which is what makes a floor reachable at all. */
const MEDIA_STAT_COUNTER_KEYS = [
  "views",
  "previewViews",
  "uniqueViewers",
  "previewUniqueViewers",
  "interactionTime",
  "previewInteractionTime",
] as const;
/** How many 31-day backfill windows ONE media may take in one visit. Bounded so
 *  a single item with years of history cannot spend a whole chunk, while a
 *  newest-first depth-first walk still finishes an item in a few dispatches. */
export const BACKFILL_WINDOWS_PER_VISIT = 4;
/** The three 31-day windows a long-tail refresh falls back to when the provider
 *  refuses the 90-day span. 3 × 31 = 93 ≥ 90. */
export const LONG_TAIL_SPLIT_WINDOWS = 3;
/** The most windows ONE steady refresh takes, the hole below its span
 *  included (`steadyRefreshPlan`). A refresh that closes a hole is reserved
 *  whole, so it has to fit a five-request chunk, with room for a retry: one
 *  that does not is clamped to the chunk, and its hole is left open, visit
 *  after visit. */
const REFRESH_WINDOWS_PER_VISIT = 4;
/**
 * What a FIRST visit costs, per tier: the first-sight walk it starts. A fresh
 * item's walk is its trailing window and the one below it, where the item's
 * creation ends it; a mid or long-tail walk takes the visit's whole allowance,
 * whose four windows reach 121 days back and so hold any steady plan. An upper
 * bound on the one visit — production 2026-09-30, a mid visit that walked spent
 * 2.6 calls on average, the chunk's five requests cutting some short — and the
 * rest of the walk is spent on the item's next visits anyway.
 */
export const FIRST_VISIT_REQUESTS = {
  fresh: 2,
  mid: BACKFILL_WINDOWS_PER_VISIT,
  longTail: BACKFILL_WINDOWS_PER_VISIT,
} as const;

/** Media seeded per dispatch on first enable. Bounded so a page with thousands
 *  of media does not hold a write lock, and keyset so the next batch resumes
 *  exactly where this one stopped. */
export const SEED_BATCH_SIZE = 500;
/** The platform's own top-N page size. */
export const TOP_MEDIA_MARK_LIMIT = 50;

// ── cursor state ─────────────────────────────────────────────────────────────

/**
 * What the lane has learned about the 90-day long-tail window.
 *
 * Durable and page-scoped, because the discovery costs a call and the answer is
 * a property of the ROUTE, not of one media item. `split_31` triples what a
 * long-tail visit costs, so the mode is reported in the progress block.
 */
export type LongTailWindowMode = "unproven" | "ninety" | "split_31";

export interface FanslyMediaStatsCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counters. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** Due items this lane could not reach today because the cap was spent.
   *  Reported, never acted on: they are simply first in tomorrow's queue. */
  deferredToday: number;
  /** Keyset cursor of the first-enable seeding sweep. */
  seedCursor: string | null;
  seedComplete: boolean;
  /** The UTC day the top-50 dirty marks were last refreshed. Zero calls. */
  topMarkedDay: string | null;
  longTailWindowMode: LongTailWindowMode;
  /** The narrow-answer discovery is announced ONCE, ever. A downgrade after an
   *  HTTP refusal of the 90-day window is announced when it happens. */
  longTailWindowAnnounced: boolean;
  /** The UTC day a 31-day probe after a refused 90-day window last FAILED on
   *  this page. One failed probe per page per day: an item that is simply gone
   *  fails on 31 days too, and must not buy a second failing request on every
   *  admission. */
  longTailProbeFailedDay: string | null;
}

/** The per-MEDIA first-sight backfill, stored in
 *  `subject_refresh_state.backfill_cursor`. */
export interface MediaBackfillCursor {
  version: 1;
  /** Exclusive upper bound of the NEXT window, epoch ms. */
  nextBeforeMs: number;
  emptyStreak: number;
  /** The walk has reached its floor, or stopped on an unhonoured window. */
  done: boolean;
  /** ISO instant of the oldest bucket the provider ever served for this item. */
  floorAt: string | null;
  /** Why it stopped, when it stopped for a reason other than the floor. */
  stopReason: string | null;
  /** WHAT ended the walk: `created_at` (the item did not exist before this),
   *  `empty_window_probe` (two all-empty windows, then an all-empty first
   *  month), `empty_window` (two all-empty windows with no room or no basis for
   *  a probe), or null while it is still open. A floor with a name is a floor an
   *  operator can argue with. */
  floorBasis: string | null;
  /** The one first-month probe has been spent. */
  probeSpent: boolean;
  /** Where the ordinary walk resumes if the probe finds traffic: the window
   *  below the second empty one. Non-null only while the probe is pending. */
  probeResumeBeforeMs: number | null;
  /** The upper bound of a probe that FOUND traffic. The resumed walk fills the
   *  gap above it, no empty streak may end it there, and reaching it ends the
   *  walk at `created_at` — the probe window already covers the rest. */
  probeHitBeforeMs: number | null;
  guard: BackfillWindowGuard;
  /** The instant the item's series was last read DOWN FROM TODAY, epoch ms: a
   *  complete steady refresh, or a first walk's opening windows. Where the
   *  next refresh's hole starts (`steadyRefreshPlan`). `last_visited_at` is
   *  not that: a visit that only walked history, below it, stamps the item
   *  too. Kept here, beside the walk it outlives, so it needs no column. Null
   *  on a cursor from before it, and `last_visited_at` stands in. */
  refreshedThroughMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableSafeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function asLongTailMode(value: unknown): LongTailWindowMode {
  return value === "ninety" || value === "split_31" ? value : "unproven";
}

export function parseFanslyMediaStatsCursorState(
  value: unknown,
): FanslyMediaStatsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const utcDay = asNullableString(state.utcDay);
  if (utcDay === null) {
    return null;
  }
  return {
    version: 1,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    deferredToday: Math.max(0, asInt(state.deferredToday, 0)),
    seedCursor: asNullableString(state.seedCursor),
    seedComplete: state.seedComplete === true,
    topMarkedDay: asNullableString(state.topMarkedDay),
    longTailWindowMode: asLongTailMode(state.longTailWindowMode),
    longTailWindowAnnounced: state.longTailWindowAnnounced === true,
    longTailProbeFailedDay: asNullableString(state.longTailProbeFailedDay),
  };
}

export function emptyFanslyMediaStatsCursorState(now: Date): FanslyMediaStatsCursorState {
  return {
    version: 1,
    utcDay: fanslyUtcDayKey(now),
    callsToday: 0,
    deferredToday: 0,
    seedCursor: null,
    seedComplete: false,
    topMarkedDay: null,
    longTailWindowMode: "unproven",
    longTailWindowAnnounced: false,
    longTailProbeFailedDay: null,
  };
}

/** A cursor written before this lane existed parses as an item that has walked
 *  nothing yet, which is exactly what it is. */
export function parseMediaBackfillCursor(
  value: unknown,
  now: Date,
): MediaBackfillCursor {
  const record = asRecord(value);
  return {
    version: 1,
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    emptyStreak: Math.max(0, asInt(record?.emptyStreak, 0)),
    done: record?.done === true,
    floorAt: asNullableString(record?.floorAt),
    stopReason: asNullableString(record?.stopReason),
    floorBasis: asNullableString(record?.floorBasis),
    probeSpent: record?.probeSpent === true,
    probeResumeBeforeMs: asNullableSafeInt(record?.probeResumeBeforeMs),
    probeHitBeforeMs: asNullableSafeInt(record?.probeHitBeforeMs),
    guard: parseWindowGuard(record?.guard, BACKFILL_WINDOW_DAYS),
    refreshedThroughMs: asNullableSafeInt(record?.refreshedThroughMs),
  };
}

/**
 * The instant an item's history CANNOT reach past: its own creation, less one
 * window span.
 *
 * The basis is `created_at_platform` and, when the platform never served one,
 * first sight — the SAME `coalesce` the queue computes the item's tier from, so
 * an item cannot be classed by one age and walked by another. Neither ⇒ null,
 * and null means no creation floor: we never invent a publication date, and the
 * empty-window rule owns the item instead.
 */
export function mediaBackfillCreationFloorMs(
  candidate: { createdAtPlatform: Date | null; firstSeenAt: Date | null },
): number | null {
  const basis = candidate.createdAtPlatform ?? candidate.firstSeenAt;
  return basis === null ? null : basis.getTime() - BACKFILL_CREATION_SLACK_DAYS * DAY_MS;
}

/**
 * THE ONE PROBE a walk may spend after two empty windows, or null when it may
 * not — and then the two empty windows end the walk, as they always did.
 *
 * The probe asks for the item's FIRST month: a window that opens a day before
 * the creation basis (the same `coalesce` as the creation floor) and spans the
 * walk's current window. The bookmark is the window BELOW the second empty one
 * — that one is journaled — so a probe that finds traffic resumes exactly where
 * the ordinary walk would have gone next.
 *
 * No basis: nothing to aim at. No ROOM: the ordinary walk's next window already
 * reaches the creation basis, so there is no gap for a probe to jump — the
 * remaining span is less than one window above it.
 *
 * Still a heuristic, and named as one: vault media can be created long before
 * it is posted, so an empty first month is not proof the item never had
 * traffic. It is a far better one than "the last two months were quiet".
 */
export function mediaBackfillFirstMonthProbe(
  cursor: Pick<MediaBackfillCursor, "nextBeforeMs" | "guard">,
  candidate: { createdAtPlatform: Date | null; firstSeenAt: Date | null },
): { probeBeforeMs: number; resumeBeforeMs: number } | null {
  const basis = candidate.createdAtPlatform ?? candidate.firstSeenAt;
  if (basis === null) {
    return null;
  }
  const spanMs = cursor.guard.spanDays * DAY_MS;
  const resumeBeforeMs = cursor.nextBeforeMs - spanMs;
  if (resumeBeforeMs <= basis.getTime() + spanMs) {
    return null;
  }
  return { probeBeforeMs: basis.getTime() - DAY_MS + spanMs, resumeBeforeMs };
}

/**
 * Did this window carry any traffic at all?
 *
 * `/it/moie/statsnew` answers a window from 2006 with a datapoint row whose
 * counters are all zero, so "the array is non-empty" is not evidence of
 * anything. Any non-zero counter in any `stats[]` row is; nothing else is.
 *
 * The response is journaled verbatim either way — capture-first is not a floor
 * rule, and the zero-valued row IS the evidence the coverage claim rests on.
 */
export function mediaStatsWindowIsEmpty(payload: unknown): boolean {
  const classification = classifyStatsWindow(payload);
  if (classification === "invalid") {
    return false;
  }
  if (classification === "empty") {
    return true;
  }
  const record = asRecord(payload);
  const dataset = record === null ? null : asRecord(record.dataset);
  const points = dataset !== null && Array.isArray(dataset.datapoints) ? dataset.datapoints : [];
  for (const point of points) {
    const row = asRecord(point);
    for (const stat of row !== null && Array.isArray(row.stats) ? row.stats : []) {
      const values = asRecord(stat);
      if (values === null) {
        continue;
      }
      for (const key of MEDIA_STAT_COUNTER_KEYS) {
        const value = values[key];
        if (typeof value === "number" && value !== 0) {
          return false;
        }
      }
    }
  }
  return true;
}

export function backfillCursorJson(cursor: MediaBackfillCursor): Record<string, unknown> {
  return { ...cursor } as unknown as Record<string, unknown>;
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/**
 * The media offer this body is about.
 *
 * `dataset.datasetMediaOfferId` is the key the route actually serves (HAR
 * 2026-08-19, 6/6). The other two spellings are accepted because a payload that
 * cannot be attributed is a payload whose buckets are unusable, and tolerating a
 * rename costs nothing. Every window checks it against the item it asked for.
 */
export function servedMediaOfferRef(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  const dataset = asRecord(record.dataset);
  return asNullableString(dataset?.datasetMediaOfferId)
    ?? asNullableString(dataset?.mediaOfferId)
    ?? asNullableString(record.mediaOfferId);
}

/** How many `datapoints[].stats[]` rows this body carried — the `known_count`
 *  the queue stores, and the only honest measure of "what did this look see". */
export function countMediaStatBuckets(payload: unknown): number {
  const record = asRecord(payload);
  const dataset = record === null ? null : asRecord(record.dataset);
  if (dataset === null || !Array.isArray(dataset.datapoints)) {
    return 0;
  }
  let count = 0;
  for (const point of dataset.datapoints) {
    const row = asRecord(point);
    if (row !== null && Array.isArray(row.stats)) {
      count += row.stats.length;
    }
  }
  return count;
}

/**
 * Did the served window actually COVER the span we asked for?
 *
 * `windowWasHonoured` is the loop guard, and it is the right one everywhere a
 * walk DERIVES its next window from what came back: it catches a served window
 * reaching materially newer than the request, or missing it entirely — the
 * production signature where the provider answers with its own default trailing
 * window and the walk re-issues the same request forever.
 *
 * It cannot catch THIS case, and the difference is worth stating rather than
 * discovering: the 90-day long-tail refresh is a TRAILING window, so a provider
 * that answers it with its default trailing 31 days returns a window with the
 * SAME END and a nearer start. Nothing reaches newer than we asked, nothing is
 * disjoint, and `windowWasHonoured` correctly says "no contradiction" — there
 * is none. What there is, is 59 days we asked for and did not get.
 *
 * So the 90-day probe checks coverage as well: the served start must be within
 * a day of the requested one. Served bounds we did not get are no evidence and
 * no contradiction — the empty-window rule owns that case, here as everywhere.
 */
export function servedWindowCoversRequest(
  requested: { afterMs: number; beforeMs: number },
  served: { afterMs: number | null; beforeMs: number | null },
): boolean {
  if (served.afterMs === null) {
    return true;
  }
  return served.afterMs - requested.afterMs <= DAY_MS;
}

/**
 * Did the served window span a HOLE window end to end?
 *
 * A hole window is history, like a backfill window, and it is read to close
 * the days between two refreshes: a day it did not serve is a day still
 * missing. So both ends are checked, each within the day of slack the route's
 * snapping needs — it serves each bound as the start of its day, so the last
 * bucket starts under a day below what was asked. The start as the 90-day
 * probe checks it (`servedWindowCoversRequest`), and the end, which a window
 * ending in the past can fall short of too. The route's default trailing
 * window fails the start by weeks; `windowWasHonoured` fails it as well.
 * Served bounds we did not get are no evidence and no contradiction.
 */
export function servedWindowSpansRequest(
  requested: { afterMs: number; beforeMs: number },
  served: { afterMs: number | null; beforeMs: number | null },
): boolean {
  return servedWindowCoversRequest(requested, served)
    && (served.beforeMs === null || requested.beforeMs - served.beforeMs <= DAY_MS);
}

/** What a failed window was failed WITH: the provider's HTTP status when it
 *  answered at all, and whether it asked us to come back later. */
export interface WindowFailure {
  httpStatus: number | null;
  retryAfter: boolean;
}

/** Gateway and availability statuses: the service in front of the route was
 *  down, which says nothing about the request. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Did the provider REFUSE the request, rather than the wire fail it?
 *
 * An HTTP error status the route itself answered with — the 500 `error getting
 * graph` is the production case, which the adapter fails on its first attempt
 * because Fansly's error envelope makes it final on this route. Not a 429 and
 * not a `Retry-After` (pacing, which says nothing about the window), not a
 * gateway status, not a transport or proxy failure (no status at all), and not
 * a journaled body we could not read. Only a refusal can be evidence about what
 * the ROUTE honours.
 */
export function isProviderRefusal(failure: WindowFailure): boolean {
  return failure.httpStatus !== null
    && failure.httpStatus >= 400
    && failure.httpStatus !== 429
    && !GATEWAY_STATUSES.has(failure.httpStatus)
    && !failure.retryAfter;
}

/** The per-visit repeat guard's key: the identical `(period, after, before)`. */
export function windowKey(window: { periodMs: number; afterMs: number; beforeMs: number }): string {
  return `${window.periodMs}:${window.afterMs}:${window.beforeMs}`;
}

/**
 * Do the windows a visit has already journaled answer `window`?
 *
 * They do when their union covers it end to end, to within a day at either end
 * — the slack `windowWasHonoured` gives the provider's bucket snapping, and no
 * more: the route serves a trailing window to its last day boundary, so a
 * refresh asked a minute later would be served the very same buckets. Inside
 * the window the union must be unbroken; a gap is buckets nobody read.
 *
 * The slack EXTENDS what was read and never stands in for it: a span must
 * hold the window's top. On a window two days wide or less the day at the top
 * and the day at the bottom meet, and with nothing read at all the window read
 * as answered — a mid item's hole of a day or two, skipped for good.
 */
export function windowAnsweredBy(
  window: { afterMs: number; beforeMs: number },
  answered: ReadonlyArray<{ afterMs: number; beforeMs: number }>,
): boolean {
  const topMs = window.beforeMs - DAY_MS;
  if (!answered.some((span) => span.afterMs <= topMs && span.beforeMs >= topMs)) {
    return false;
  }
  return answeredFloor(topMs, answered) <= window.afterMs + DAY_MS;
}

/**
 * How far down the spans a visit holds reach from `fromMs`, unbroken: the
 * lowest start of a run of spans that covers `fromMs`, or `fromMs` itself when
 * none does. Everything between the two was read this visit.
 */
export function answeredFloor(
  fromMs: number,
  answered: ReadonlyArray<{ afterMs: number; beforeMs: number }>,
): number {
  let reached = fromMs;
  // Newest first: a span that ends below the point still to cover is a gap,
  // and nothing after it in this order ends any higher.
  for (const span of [...answered].sort((left, right) => right.beforeMs - left.beforeMs)) {
    if (span.beforeMs < reached) {
      break;
    }
    reached = Math.min(reached, span.afterMs);
  }
  return reached;
}

/** A hole window the refresh did not close: the day's budget or the chunk's
 *  ran out first, the visit had asked for it already, or the route served
 *  something other than the window asked for. */
export interface HoleLeftOpen {
  reason: "daily_call_budget" | "chunk_budget" | "repeat_request" | "window_not_honoured";
  requested: { afterMs: number; beforeMs: number };
  served: { afterMs: number | null; beforeMs: number | null } | null;
}

/**
 * The steady windows for a tier, newest first.
 *
 * Fresh reads the last 31 days daily, mid the last 30 days daily, long tail the
 * last 90 days daily — as ONE window where the route honours 90 days, and as
 * three 31-day windows where it does not. The split TRIPLES what a long-tail
 * visit costs, which is why the mode is durable, is announced once, and is
 * reported in the progress block rather than discovered silently on every visit.
 */
export function steadyWindows(
  tier: MediaStatsTier,
  now: Date,
  longTailMode: LongTailWindowMode,
): Array<{ periodMs: number; afterMs: number; beforeMs: number }> {
  const end = now.getTime();
  if (tier === "fresh") {
    return [{
      periodMs: DAILY_PERIOD_MS,
      beforeMs: end,
      afterMs: end - FRESH_TRAILING_DAYS * DAY_MS,
    }];
  }
  if (tier === "mid") {
    return [{
      periodMs: DAILY_PERIOD_MS,
      beforeMs: end,
      afterMs: end - MID_TRAILING_DAYS * DAY_MS,
    }];
  }
  if (longTailMode === "split_31") {
    return Array.from({ length: LONG_TAIL_SPLIT_WINDOWS }, (_unused, index) => {
      const beforeMs = end - index * BACKFILL_WINDOW_DAYS * DAY_MS;
      return {
        periodMs: DAILY_PERIOD_MS,
        beforeMs,
        afterMs: beforeMs - BACKFILL_WINDOW_DAYS * DAY_MS,
      };
    });
  }
  return [{
    periodMs: DAILY_PERIOD_MS,
    beforeMs: end,
    afterMs: end - LONG_TAIL_TRAILING_DAYS * DAY_MS,
  }];
}

export interface SteadyRefreshPlan {
  /** The tier's steady windows, then any hole windows below them. */
  windows: Array<{ periodMs: number; afterMs: number; beforeMs: number }>;
  /** Of `windows`, the ones below the tier's span: the hole being read. */
  holeWindows: number;
  /** The oldest part of the hole, which one visit cannot carry; null when the
   *  plan reaches the last visit. */
  unreadHole: { afterMs: number; beforeMs: number } | null;
}

/**
 * THE REFRESH ONE VISIT READS: the tier's steady windows and, when the item's
 * last visit is OLDER than their far end, the hole between the two.
 *
 * The steady span is fixed — 30 days for mid — so an item revisited later
 * than that skips the days between its last visit and the span's far end, and
 * skips them for good: the stamp moves to today, and the next visit reads from
 * there (production 2026-09-30: 56 mid items on lora-1 and 68 on lora-2 already
 * past their 30 days). So the plan reaches on down to a day before the last
 * visit — the backfill's own overlap, which also restates that visit's partial
 * last day — in 31-day windows, contiguous with the steady ones, newest first.
 *
 * `REFRESH_WINDOWS_PER_VISIT` in all: mid closes a hole of 93 days, a split
 * long tail one of 31. What does not fit is `unreadHole`, the oldest part, which
 * the visit names rather than skips in silence. The queue visits an item at the
 * edge of its window before any first look (`listMediaStatsRefreshChunk`), so a
 * hole at all means the lane has fallen behind its tier's cadence.
 *
 * The last visit is the last one that read the series DOWN FROM TODAY — the
 * cursor's `refreshedThroughMs`, which a visit that only walked history
 * carries forward — so that is what the caller passes.
 *
 * `lastVisitedAt` null — never visited, or a walk that reads everything under
 * today anyway — is the tier's plan as it is.
 */
export function steadyRefreshPlan(
  tier: MediaStatsTier,
  now: Date,
  longTailMode: LongTailWindowMode,
  lastVisitedAt: Date | null,
): SteadyRefreshPlan {
  const windows = steadyWindows(tier, now, longTailMode);
  const spanFloorMs = Math.min(...windows.map((window) => window.afterMs));
  if (lastVisitedAt === null || lastVisitedAt.getTime() >= spanFloorMs) {
    return { windows, holeWindows: 0, unreadHole: null };
  }
  const reachMs = lastVisitedAt.getTime() - BACKFILL_OVERLAP_DAYS * DAY_MS;
  let beforeMs = spanFloorMs;
  let holeWindows = 0;
  while (beforeMs > reachMs && windows.length < REFRESH_WINDOWS_PER_VISIT) {
    const afterMs = Math.max(reachMs, beforeMs - BACKFILL_WINDOW_DAYS * DAY_MS);
    windows.push({ periodMs: DAILY_PERIOD_MS, afterMs, beforeMs });
    holeWindows += 1;
    beforeMs = afterMs;
  }
  return {
    windows,
    holeWindows,
    unreadHole: beforeMs > reachMs ? { afterMs: reachMs, beforeMs } : null,
  };
}
