// WP-F1 — the `stats_snapshot` capture handler.
//
// A DAILY sweep on a 6-hourly stream. The cadence is 21 600 s so a day that
// deferred at its cap resumes within six hours rather than at the next
// midnight; whether a sweep is actually DUE is decided here, from the cursor.
//
// SEVEN STEPS, each ONE journaled call with its own observation kind:
//
//   1  account_stats            trailing 30 d, period 86 400 000
//   2  account_stats            trailing 25 h, period 3 600 000 (gated)
//   3  earnings_stats_snapshot  trailing 30 d, offset-paginated at limit=100
//   4  earnings_monthlystats_snapshot
//   5  tracking_links
//   6  discovery_feed           × 2 pages
//   7  broadcast_stats · broadcast_stats_deleted · broadcast_scheduled ·
//      polls · recapstats                                          (A28-5)
//
// THE BUDGET RULE, stated once because getting it wrong loses data: the per-lane
// daily cap is counted in HTTP **ATTEMPTS** (retries included — a cap counted in
// logical calls would let a retry storm multiply real egress by up to 4), it is
// per page by construction, and crossing it **DEFERS THE LANE TO THE NEXT UTC
// DAY**. It never drops. A response already fetched is ALWAYS journaled before
// the cap is consulted again, so a lane crossed mid-chunk still keeps its bytes.
// This cap is the whole request-count enforcement in this design (A28-4 deleted
// the per-egress-key counter, the 2×-of-norm signal and the global page cap).
//
// THE BACKFILL, and the thing about it that took two production days to learn:
// `/it/amoie/stats` HAS NO HISTORICAL DATE BOUNDS. A14 said it did. It does not.
//
//   - 2026-08-22, first enable (ari-1, lilly-1): a 100-day window came back as
//     the provider's DEFAULT trailing 31 days, the walk derived its next window
//     from THAT, asked again, got the same body — 25 byte-identical responses,
//     the whole day's cap. The `BackfillWindowGuard` below ended that.
//   - 2026-08-22, with the guard live (lora-2): `afterDate 2026-06-21 /
//     beforeDate 2026-07-22` — 31 days, historical, exactly the span the HAR
//     shows honoured on the SISTER route — was served `dateAfter 2026-07-21 /
//     dateBefore 2026-08-21`. Halving to 15 days changed nothing. The guard
//     correctly stopped the lane with `window_not_honoured`; the walk it was
//     guarding was asking for something this route does not serve.
//
// So THE DATE BOUNDS WORK ONLY INSIDE THE TRAILING WINDOW, and history on this
// route is addressed the way the app itself addresses it: `year`/`month`, the
// UI's "Jul / Jun / May 2026" presets, with the trailing bounds riding along
// ignored (bundle `main.pretty.js` :280600, :196337). The daily backfill
// therefore captures the trailing window ONCE — the one window the bounds are
// honoured for, because it is the window the route would have served anyway —
// and then walks BACKWARDS BY CALENDAR MONTH, newest month first, one call per
// month. It stops after two consecutive empty months PLUS one probe about a
// year further back ([E10]: an empty month on a long-idle account proves
// inactivity, not a retention floor), and it journals every empty response,
// because an empty month IS the floor evidence.
//
// EVERY LANE STILL CHECKS WHAT CAME BACK AGAINST WHAT IT ASKED FOR, in the unit
// it asked in: the trailing and earnings windows against their bounds
// (`windowWasHonoured`, halve once then stop), the month walk against the month
// it named (`monthWasHonoured`, stop — there is no half of a month to retry).
// An unwalked span is a hole we know about; a loop is a day of egress spent
// proving nothing. The same rule catches a repeated request before it is issued.
//
// THE EARNINGS LANE IS UNTOUCHED BY ALL OF THIS: `/account/wallets/earnings/
// stats` DID honour historical windows on production (lora-1 walked back to
// 2024-11-29), so it keeps its date-bound walk and its derived-from-the-rows
// guard. Two routes, two behaviours, and the difference is measured rather than
// assumed.
//
// BURST SHAPE, not daily volume, is the real ban-risk surface: a chunk spends
// its 5 requests in ~13 s and is re-queued immediately, so a deep walk would
// otherwise run contiguously at ~23 req/min for as long as it has work. Backfill
// continuations therefore carry `fanslyBackfillContinuationDelayMs` ± 30 %
// jitter. Steady-state sweeps keep immediate continuation.

import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  listCaptureCoverage,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  advanceOffsetPage,
  classifyFanslyResponse,
  createFanslyLaneCoverageWriter,
  createFanslyLaneJournal,
  createFanslyLaneRuntime,
  fanslyUtcDayKey,
  FanslyLaneInvalidResponseError,
  isRepeatedRequest,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
  spreadFanslyContinuation,
} from "./fansly-lane.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { retentionDate } from "./shared.ts";

const STREAM = "stats_snapshot" as const;
const MAPPER_VERSION = "fansly-stats-v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The two periods this lane polls. 300 000 (5-minute) buckets are a DELIBERATE
 *  non-goal: they are reachable (the UI's "Last Hour" proves it) and they would
 *  multiply the lane's calls and rows for a granularity nothing asks for. */
const DAILY_PERIOD_MS = 86_400_000;
const HOURLY_PERIOD_MS = 3_600_000;

/** The steady-state trailing windows. Fansly restates recent buckets, so the
 *  30-day daily window is re-compared every day; unchanged buckets dedup to
 *  zero events, which is exactly the granularity D-1 was chosen for. */
const DAILY_TRAILING_DAYS = 30;
const HOURLY_TRAILING_HOURS = 25;
const EARNINGS_TRAILING_DAYS = 30;
const EARNINGS_PAGE_LIMIT = 100;
const DISCOVERY_PAGE_LIMIT = 10;
const DISCOVERY_PAGES_PER_SWEEP = 2;

/**
 * THE TRAILING WINDOW'S SPAN, in days — and the ONE window this route's date
 * bounds are honoured for, because it is the window the route serves by default.
 *
 * Three measurements, so the next person does not re-infer any of them:
 *
 *   - PROD 2026-08-22 04:16 UTC (ari-1, first enable): `afterDate 2026-05-14 /
 *     beforeDate 2026-08-22` (100 d) came back `dataset.dateAfter 2026-07-21 /
 *     dateBefore 2026-08-22` — the DEFAULT trailing 31 days, our bounds ignored.
 *   - PROD 2026-08-22 (lora-2, with the guard live): `afterDate 2026-06-21 /
 *     beforeDate 2026-07-22` — 31 days, HISTORICAL — came back `2026-07-21 →
 *     2026-08-21`. Halved to 15 days: the same answer. So it is not the span.
 *   - HAR `/it/moie/statsnew` (the SISTER route, per media) DOES honour a
 *     historical 31-day window exactly. Two routes, two behaviours.
 *
 * Everything older than this window is asked for by CALENDAR MONTH, which is how
 * the app asks for it. Ten years is ~120 month calls; at the 25-attempts/day
 * lane cap that is ~5 days of first enable per page — the accepted price (A29)
 * and NOT a reason to raise the cap.
 */
const BACKFILL_DAILY_WINDOW_DAYS = 31;
const BACKFILL_HOURLY_STEP_DAYS = 4;
/**
 * The bounds the MONTH form carries, which the server ignores.
 *
 * The app sends `beforeDate = now`, `afterDate = now − 30 d`, `period =
 * 86 400 000` with EVERY month preset and lets `year`/`month` decide the window
 * (bundle `main.pretty.js` :280600). We send the same thing: a request the
 * client never makes is a request nothing has ever seen answered.
 */
const MONTH_FORM_TRAILING_DAYS = 30;
/** Two consecutive empty MONTHS, then ONE probe this many months further back —
 *  [E10] in the unit this walk actually steps in. */
const BACKFILL_PROBE_JUMP_MONTHS = 12;
const BACKFILL_PROBE_JUMP_DAYS = 365;
/** The same 31 days for `/account/wallets/earnings/stats`, chosen on LESS
 *  evidence: the one observed call carried a 30-day window and nothing anywhere
 *  shows this route answering a longer one. The unhonoured-window guard below is
 *  what makes being wrong here cost one extra request instead of a day's cap. */
const BACKFILL_EARNINGS_WINDOW_DAYS = 31;
/** A window the provider did not honour is halved ONCE before its lane gives
 *  up — and never below this floor, because a span this short buys nothing that
 *  a stopped lane and a `capture_coverage` row do not say more honestly. */
const BACKFILL_NARROW_FLOOR_DAYS = 7;
/** Two consecutive empty windows (or months), then ONE probe further back. */
const BACKFILL_EMPTY_STREAK_LIMIT = 2;
/** Pages of mass-DM history the first-enable walk takes per daily sweep. */
const BROADCAST_BACKFILL_PAGES_PER_SWEEP = 3;
/** `recapstats` — the step that completes the sweep and stamps `lastSweepDay`. */
const LAST_SWEEP_STEP = 10;

// ── cursor state ─────────────────────────────────────────────────────────────

/**
 * The unhonoured-window guard's DURABLE half, one per backfill lane.
 *
 * All of it has to survive a chunk boundary: the loop that burned a day's cap on
 * prod spanned five chunks, so a guard that lived only inside one chunk would
 * have watched it happen five times and said nothing.
 *
 * EXPORTED because WP-F4's per-media backfill needs exactly this, per media,
 * inside `subject_refresh_state.backfill_cursor`. A second copy of the same
 * three fields is a second place for the halve-once rule to drift.
 */
export interface BackfillWindowGuard {
  /** Span of the NEXT request, in days. Halved once when a window comes back
   *  unhonoured, never below `BACKFILL_NARROW_FLOOR_DAYS`, and never restored:
   *  a narrower window that works is worth more than a wider one that might. */
  spanDays: number;
  /** The one halve-and-retry has been spent. */
  narrowed: boolean;
  /** The window this lane last ASKED for. The identical `(after, before)` is
   *  never issued twice in a walk — that repeat IS the loop, seen early. */
  lastAfterMs: number | null;
  lastBeforeMs: number | null;
  /** The observation that journaled this lane's last response, so a lane that
   *  stops on an unhonoured window can point its coverage row at the bytes that
   *  prove it rather than restating them. */
  lastObservationId: number | null;
}

interface DailyBackfillState {
  /** Exclusive upper bound of the TRAILING window, in epoch ms. Read once, for
   *  the one window whose date bounds this route honours. */
  nextBeforeMs: number;
  /** That window has been captured; everything older is a calendar month. */
  trailingCaptured: boolean;
  /**
   * The month the walk asks for NEXT, as `year * 12 + (month - 1)`.
   *
   * ONE INTEGER because every operation on it is arithmetic: one month back is
   * −1 and the [E10] probe is −12, with no month-length or year-boundary cases
   * to get wrong. `null` until the trailing window lands.
   */
  nextMonthIndex: number | null;
  /** The month this walk last ASKED for. The same `(year, month)` twice IS the
   *  loop, seen before any egress. */
  lastMonthIndex: number | null;
  emptyStreak: number;
  /** The one extra probe ~12 months further back has been spent. */
  probeSpent: boolean;
  /**
   * Where the ORDINARY walk was when the probe jumped over it, so a probe that
   * finds data resumes at the gap instead of continuing from the probe.
   * Otherwise a probe that proved "there IS older history" would leave the
   * eleven months it jumped over unwalked — a hole nobody would notice for a
   * year.
   */
  probeResumeMonthIndex: number | null;
  done: boolean;
  /** ISO instant of the oldest bucket the provider ever served. */
  floorAt: string | null;
  guard: BackfillWindowGuard;
}

interface HourlyBackfillState {
  nextBeforeMs: number;
  daysWalked: number;
  done: boolean;
  guard: BackfillWindowGuard;
}

interface EarningsBackfillState {
  nextBeforeMs: number;
  /** Offset within the current date window. A full page holds the window and
   * resumes at the next offset instead of skipping the remaining rows. */
  offset: number;
  lastOffset: number | null;
  windowRows: number;
  emptyStreak: number;
  probeSpent: boolean;
  probeResumeBeforeMs: number | null;
  done: boolean;
  guard: BackfillWindowGuard;
}

export interface FanslyStatsCursorState {
  version: 1;
  mode: "backfill" | "steady";
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** The last UTC day a full daily sweep completed. */
  lastSweepDay: string | null;
  /** Which of the seven steps to resume at within today's sweep. */
  stepIndex: number;
  earningsOffset: number;
  /** Repeat-cursor guard: the offset the previous page was fetched at. */
  earningsPreviousOffset: number | null;
  discoveryPage: number;
  /** `before` cursor for the first-enable broadcast walk; null once at the floor. */
  broadcastBefore: string | null;
  broadcastFloorReached: boolean;
  /** Pages the broadcast walk has taken in THIS sweep. Bounded so the
   *  first-enable walk cannot hold the sweep at step 6 for days and starve the
   *  daily traffic capture behind it. */
  broadcastPagesInSweep: number;
  backfill: {
    daily: DailyBackfillState;
    hourly: HourlyBackfillState;
    earnings: EarningsBackfillState;
  } | null;
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

function asNullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** A cursor written before the guard existed parses as a lane that has asked
 *  for nothing yet at the full span — which is exactly what it is. */
export function parseWindowGuard(value: unknown, defaultSpanDays: number): BackfillWindowGuard {
  const record = asRecord(value);
  const spanDays = asInt(record?.spanDays, defaultSpanDays);
  return {
    spanDays: Math.min(defaultSpanDays, Math.max(1, spanDays)),
    narrowed: record?.narrowed === true,
    lastAfterMs: asNullableInt(record?.lastAfterMs),
    lastBeforeMs: asNullableInt(record?.lastBeforeMs),
    lastObservationId: asNullableInt(record?.lastObservationId),
  };
}

export function emptyWindowGuard(spanDays: number): BackfillWindowGuard {
  return {
    spanDays,
    narrowed: false,
    lastAfterMs: null,
    lastBeforeMs: null,
    lastObservationId: null,
  };
}

/**
 * The narrowed span for a lane whose window was not honoured: half, floored, and
 * never above what it already was. A lane whose span is ALREADY at or below the
 * floor gets its own span back — the caller reads that as "no retry left" and
 * stops, because retrying the same span would re-issue the same request.
 */
export function narrowedSpanDays(spanDays: number): number {
  return Math.min(spanDays, Math.max(BACKFILL_NARROW_FLOOR_DAYS, Math.floor(spanDays / 2)));
}

function parseDailyBackfill(value: unknown, now: Date): DailyBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    // A cursor written by the DATE-BOUND walk carries neither field: it parses
    // as a lane that has not captured its trailing window and has named no
    // month, which is what the month walk has to start from anyway.
    trailingCaptured: record?.trailingCaptured === true,
    nextMonthIndex: asNullableInt(record?.nextMonthIndex),
    lastMonthIndex: asNullableInt(record?.lastMonthIndex),
    emptyStreak: asInt(record?.emptyStreak, 0),
    probeSpent: record?.probeSpent === true,
    probeResumeMonthIndex: asNullableInt(record?.probeResumeMonthIndex),
    done: record?.done === true,
    floorAt: asNullableString(record?.floorAt),
    guard: parseWindowGuard(record?.guard, BACKFILL_DAILY_WINDOW_DAYS),
  };
}

function parseHourlyBackfill(value: unknown, now: Date): HourlyBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    daysWalked: asInt(record?.daysWalked, 0),
    done: record?.done === true,
    guard: parseWindowGuard(record?.guard, BACKFILL_HOURLY_STEP_DAYS),
  };
}

function parseEarningsBackfill(value: unknown, now: Date): EarningsBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    offset: Math.max(0, asInt(record?.offset, 0)),
    lastOffset: asNullableInt(record?.lastOffset),
    windowRows: Math.max(0, asInt(record?.windowRows, 0)),
    emptyStreak: asInt(record?.emptyStreak, 0),
    probeSpent: record?.probeSpent === true,
    probeResumeBeforeMs: asNullableInt(record?.probeResumeBeforeMs),
    done: record?.done === true,
    guard: parseWindowGuard(record?.guard, BACKFILL_EARNINGS_WINDOW_DAYS),
  };
}

export function parseFanslyStatsCursorState(
  value: unknown,
  now = new Date(),
): FanslyStatsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const mode = state.mode === "backfill" || state.mode === "steady" ? state.mode : null;
  const utcDay = asNullableString(state.utcDay);
  if (mode === null || utcDay === null) {
    return null;
  }
  const backfillRecord = asRecord(state.backfill);
  return {
    version: 1,
    mode,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    lastSweepDay: asNullableString(state.lastSweepDay),
    // Clamped to the real step range. A stored value past the last step would
    // otherwise wedge the lane: the sweep loop would fall straight through to
    // its `break` and return "not satisfied, nothing done" on every dispatch,
    // forever, with no call and no error to show for it.
    stepIndex: Math.min(LAST_SWEEP_STEP, Math.max(0, asInt(state.stepIndex, 0))),
    earningsOffset: Math.max(0, asInt(state.earningsOffset, 0)),
    earningsPreviousOffset: typeof state.earningsPreviousOffset === "number"
      ? state.earningsPreviousOffset
      : null,
    discoveryPage: Math.max(0, asInt(state.discoveryPage, 0)),
    broadcastBefore: asNullableString(state.broadcastBefore),
    broadcastFloorReached: state.broadcastFloorReached === true,
    broadcastPagesInSweep: Math.max(0, asInt(state.broadcastPagesInSweep, 0)),
    backfill: backfillRecord === null ? null : {
      daily: parseDailyBackfill(backfillRecord.daily, now),
      hourly: parseHourlyBackfill(backfillRecord.hourly, now),
      earnings: parseEarningsBackfill(backfillRecord.earnings, now),
    },
  };
}

function emptyDailyBackfill(now: Date): DailyBackfillState {
  return {
    nextBeforeMs: now.getTime(),
    trailingCaptured: false,
    nextMonthIndex: null,
    lastMonthIndex: null,
    emptyStreak: 0,
    probeSpent: false,
    probeResumeMonthIndex: null,
    done: false,
    floorAt: null,
    guard: emptyWindowGuard(BACKFILL_DAILY_WINDOW_DAYS),
  };
}

/** `year * 12 + (month - 1)` for an instant, in UTC — the unit the daily
 *  history walk steps in. */
export function monthIndexOf(instant: Date): number {
  return instant.getUTCFullYear() * 12 + instant.getUTCMonth();
}

/** The `year`/`month` (1–12) pair the request carries. */
export function monthFromIndex(index: number): { year: number; month: number } {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** `2026-06`, for a log line, an anomaly and a coverage cursor. */
export function monthLabel(index: number): string {
  const { year, month } = monthFromIndex(index);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Did the provider answer the MONTH we named?
 *
 * The failure this exists for is the one the date-bound walk kept hitting: the
 * response is the DEFAULT TRAILING WINDOW, 200 and all. Against a named month
 * that is visible in one number — the served `dateAfter` lands nowhere near the
 * month's start — so the served start is what is checked, with a day of slack
 * for the provider's own bucket snapping.
 *
 * There is no halve-and-retry here and there could not be: a month is not a span
 * we chose, so there is no narrower one to ask for. A month that comes back
 * wrong stops the walk.
 *
 * NOTE the one case this cannot catch, because nothing can: the FIRST month the
 * walk asks for is the month before the trailing window, and the trailing
 * window's own `dateAfter` usually falls inside it. A server ignoring `year`/
 * `month` therefore passes that one check and fails the next — one extra request
 * before the lane stops, and no loop.
 *
 * Served bounds we did not get are no evidence, and no evidence is no
 * contradiction: the empty-month rule owns that case.
 */
export function monthWasHonoured(
  index: number,
  served: { afterMs: number | null; beforeMs: number | null },
): boolean {
  if (served.afterMs === null) {
    return true;
  }
  const { year, month } = monthFromIndex(index);
  const startMs = Date.UTC(year, month - 1, 1);
  const endMs = Date.UTC(year, month, 1);
  return served.afterMs >= startMs - DAY_MS && served.afterMs < endMs + DAY_MS;
}

/** Identity, not traffic. Everything else in a `stats[]` row is a counter. */
const STAT_IDENTITY_KEYS = new Set(["type", "timestamp", "period"]);

function pointCarriesTraffic(point: unknown): boolean {
  const row = asRecord(point);
  if (row === null) {
    return false;
  }
  const carries = (values: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(values)) {
      if (STAT_IDENTITY_KEYS.has(key)) {
        continue;
      }
      if (typeof value === "number" && value !== 0) {
        return true;
      }
    }
    return false;
  };
  // Both shapes: the served bodies nest counters under `stats[]`, and the
  // fixtures the walk is pinned against carry them on the point itself.
  if (carries(row)) {
    return true;
  }
  for (const stat of Array.isArray(row.stats) ? row.stats : []) {
    const values = asRecord(stat);
    if (values !== null && carries(values)) {
      return true;
    }
  }
  return false;
}

/**
 * Is this MONTH empty — the floor signal the month walk reads?
 *
 * Wider than `isEmptyStatsWindow` on purpose: a month can come back with rows
 * that are all zeros, and a walk that treated a zero-valued bucket as evidence
 * of traffic would never find a floor (which is exactly what WP-F4's per-media
 * walk did on production — 240 windows back to 2006 on one zero-valued row).
 * ANY non-zero counter anywhere in the body is traffic; nothing else is.
 *
 * The response is journaled either way — capture first; only the floor decision
 * reads this.
 */
export function isEmptyStatsMonth(payload: unknown): boolean {
  if (isEmptyStatsWindow(payload)) {
    return true;
  }
  const dataset = statsDataset(payload);
  if (dataset === null) {
    return false;
  }
  for (const key of ["datapoints", "profileDatapoints"] as const) {
    const points = Array.isArray(dataset[key]) ? dataset[key] as unknown[] : [];
    for (const point of points) {
      if (pointCarriesTraffic(point)) {
        return false;
      }
    }
  }
  return true;
}

export function emptyFanslyStatsCursorState(now: Date): FanslyStatsCursorState {
  return {
    version: 1,
    // FIRST ENABLE walks history before it settles into the daily sweep. That is
    // the only chance to reach the provider's floor cheaply — ten years of daily
    // buckets is ~118 windows at the 31-day span the provider actually honours,
    // which the 25/day lane cap spreads over ~5 days.
    mode: "backfill",
    utcDay: utcDayKey(now),
    callsToday: 0,
    lastSweepDay: null,
    stepIndex: 0,
    earningsOffset: 0,
    earningsPreviousOffset: null,
    discoveryPage: 0,
    broadcastBefore: null,
    broadcastFloorReached: false,
    broadcastPagesInSweep: 0,
    backfill: {
      daily: emptyDailyBackfill(now),
      hourly: {
        nextBeforeMs: now.getTime(),
        daysWalked: 0,
        done: false,
        guard: emptyWindowGuard(BACKFILL_HOURLY_STEP_DAYS),
      },
      earnings: {
        nextBeforeMs: now.getTime(),
        offset: 0,
        lastOffset: null,
        windowRows: 0,
        emptyStreak: 0,
        probeSpent: false,
        probeResumeBeforeMs: null,
        done: false,
        guard: emptyWindowGuard(BACKFILL_EARNINGS_WINDOW_DAYS),
      },
    },
  };
}

export const utcDayKey = fanslyUtcDayKey;

/** A new UTC day resets the attempt counter. Nothing else about the cursor
 *  changes: a sweep that deferred mid-step resumes at exactly that step. */
export const rollUtcDay = rollFanslyUtcDay;

// ── shape helpers over the journaled bodies ──────────────────────────────────

function statsDataset(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  return record === null ? null : asRecord(record.dataset);
}

/** True when the response carried no datapoints at all — the empty-window
 *  signal the backfill's stop rule reads. Journaled either way: an empty
 *  window IS the retention-floor evidence. */
export function isEmptyStatsWindow(payload: unknown): boolean {
  return classifyStatsWindow(payload) === "empty";
}

export function classifyStatsWindow(payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => statsDataset(value) !== null,
    isEmpty: (value) => {
      const dataset = statsDataset(value)!;
      const datapoints = Array.isArray(dataset.datapoints) ? dataset.datapoints : [];
      const profile = Array.isArray(dataset.profileDatapoints) ? dataset.profileDatapoints : [];
      return datapoints.length === 0 && profile.length === 0;
    },
  });
}

/** The provider's OWN returned bounds. The next window is derived from these,
 *  never from what we asked for (§7) — the provider snaps to its bucket grid
 *  and a self-derived walk would drift a bucket per chunk. */
export function servedWindow(payload: unknown): { afterMs: number | null; beforeMs: number | null } {
  const dataset = statsDataset(payload);
  if (dataset === null) {
    return { afterMs: null, beforeMs: null };
  }
  const after = typeof dataset.dateAfter === "number" ? dataset.dateAfter : null;
  const before = typeof dataset.dateBefore === "number" ? dataset.dateBefore : null;
  return { afterMs: after, beforeMs: before };
}

/**
 * §7's contiguity assertion, over two ADJACENT served windows.
 *
 * With a one-day overlap the older window must end at or after the newer
 * window's start; a gap means the walk skipped buckets. On live data this only
 * LOGS an anomaly — it never throws away a response that has already been
 * journaled — and the fixture test is where it is asserted properly.
 */
export function windowsAreContiguous(
  olderServed: { afterMs: number | null; beforeMs: number | null },
  newerServed: { afterMs: number | null; beforeMs: number | null },
): boolean {
  if (olderServed.beforeMs === null || newerServed.afterMs === null) {
    // Nothing served means nothing to contradict.
    return true;
  }
  return olderServed.beforeMs >= newerServed.afterMs;
}

/**
 * Did the provider actually answer the window we ASKED for?
 *
 * The failure this exists for is not subtle once it is named: `/it/amoie/stats`
 * answers a span it does not like with its own DEFAULT trailing window, 200 and
 * all. Deriving the next window from THAT reproduces the same request, forever
 * — 25 identical bodies on prod, one dedup object id, a day of cap spent.
 *
 * A day of slack absorbs the provider's bucket snapping (§7's whole premise is
 * that served bounds do not equal requested ones). What it does not absorb is a
 * served window reaching materially NEWER than we asked, or missing our request
 * entirely — either way the response describes a window that is not ours.
 *
 * Served bounds we did not get are no evidence, and no evidence is no
 * contradiction: the empty-window rule owns that case.
 */
export function windowWasHonoured(
  requested: { afterMs: number; beforeMs: number },
  served: { afterMs: number | null; beforeMs: number | null },
): boolean {
  const tolerance = DAY_MS;
  if (served.beforeMs !== null) {
    // The production signature: the default trailing window, ending today.
    if (served.beforeMs - requested.beforeMs > tolerance) {
      return false;
    }
    // Disjoint the other way — everything served is older than what we asked.
    if (requested.afterMs - served.beforeMs > tolerance) {
      return false;
    }
  }
  if (served.afterMs !== null && served.afterMs - requested.beforeMs > tolerance) {
    return false;
  }
  return true;
}

function payloadRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function rowCount(payload: unknown): number {
  return payloadRows(payload).length;
}

/**
 * `/account/wallets/earnings/stats` describes no window of its own, so its ROWS
 * are the only evidence of what was served: `{type, totalGross, totalNet,
 * accountId, timestamp}` in epoch ms, one row per revenue type per business day.
 * No rows is no evidence — again, the empty-window rule owns that.
 */
export function servedEarningsWindow(
  payload: unknown,
): { afterMs: number | null; beforeMs: number | null } {
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const row of payloadRows(payload)) {
    const timestamp = asNullableInt(asRecord(row)?.timestamp);
    if (timestamp === null) {
      continue;
    }
    oldest = oldest === null || timestamp < oldest ? timestamp : oldest;
    newest = newest === null || timestamp > newest ? timestamp : newest;
  }
  return { afterMs: oldest, beforeMs: newest };
}

// ── the handler ──────────────────────────────────────────────────────────────

function statsSkip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
}

/** Backfill continuation spacing: the configured delay ± 30 % jitter, so a deep
 *  walk cannot run 30+ contiguous minutes at ~23 requests/minute. */
export function backfillContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  return spreadFanslyContinuation(now, delayMs, random);
}

export async function fanslyStatsSnapshotChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return statsSkip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.fanslyStatsSnapshotSyncEnabled !== true) {
    return statsSkip("flag_off");
  }
  // FAIL-CLOSED (S4): empty = NO pages. Deliberately NOT `fanslyNewStreamAllowed`,
  // whose empty CSV means every page — using it here would open the lane
  // fleet-wide on the deploy that ships it.
  if (!isPageAllowlisted(effective.fanslyStatsSnapshotPageAllowlist, input.pageContext.page.label)) {
    return statsSkip("not_allowlisted");
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyStatsSnapshotDailyCallBudget ?? 25);
  const hourlyEnabled = effective.fanslyStatsHourlyEnabled !== false;
  const hourlyBackfillMaxDays = Math.max(0, effective.fanslyStatsHourlyBackfillMaxDays ?? 30);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollUtcDay(
    parseFanslyStatsCursorState(checkpoint?.state, now) ?? emptyFanslyStatsCursorState(now),
    now,
  );

  const lane = createFanslyLaneRuntime({
    db: app.db,
    pageId,
    stream: STREAM,
    cursorText: () => state.lastSweepDay,
    dailyCap,
    telemetry: input.telemetry,
    downstreamObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
    ),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
  });
  const { attemptBudget, complete: completeLane, requestContext, saveProgress } = lane;

  let journaled = 0;
  let deferred: string | null = null;

  const persist = createFanslyLaneJournal({
    db: app.db,
    pageId,
    syncRunId: input.syncRunId,
    mapperVersion: MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
    onJournal: () => { journaled += 1; },
  });

  /** Room for one more call today? The chunk budget is the per-chunk guard;
   *  this is the per-DAY one, and crossing it defers rather than fails. */
  const hasDayCapacity = attemptBudget.hasCapacity;

  const coverage = createFanslyLaneCoverageWriter({
    db: app.db,
    pageId,
    scopeRef: "",
    acquisitionMode: "retroactive",
  });

  /**
   * THE UNHONOURED-WINDOW ACTION, shared by all three backfill lanes.
   *
   * First disagreement: halve the span and try once more from the SAME upper
   * bound — a provider that refuses 31 days may well answer 15, and one extra
   * request is cheap next to an unwalked decade.
   *
   * Second disagreement (or a lane already at the narrowing floor): STOP the
   * walk. Not "retry tomorrow", not "derive from what came back" — both of those
   * are the loop. A stopped lane costs the history it did not walk; the loop
   * cost the whole day's cap AND the history, every day, silently.
   *
   * The lane is marked done in the durable cursor, so the coverage row and the
   * anomaly happen exactly ONCE per (page, plane).
   */
  const handleUnhonouredWindow = async (
    lane: { done: boolean; guard: BackfillWindowGuard },
    plane: string,
    requested: { afterMs: number; beforeMs: number },
    detail: {
      trigger: "served_window" | "repeat_request";
      served?: { afterMs: number | null; beforeMs: number | null };
      oldestCapturedAt?: Date | null;
    },
  ): Promise<"narrowed" | "stopped"> => {
    const narrower = narrowedSpanDays(lane.guard.spanDays);
    if (!lane.guard.narrowed && narrower < lane.guard.spanDays) {
      lane.guard.spanDays = narrower;
      lane.guard.narrowed = true;
      return "narrowed";
    }
    lane.done = true;
    const proofObservationId = lane.guard.lastObservationId;
    await coverage(
      plane,
      // Bounded by the PROVIDER's behaviour, not by us and not by exhaustion:
      // there is older history, and this surface will not serve it in windows
      // this lane can ask for.
      "partial_provider_surface",
      // The response that ignored our window is itself the terminal evidence,
      // and it is journaled. With no journaled response to point at (a repeat
      // caught before any egress on a fresh cursor) the honest proof is none.
      proofObservationId === null ? "none" : "terminal_response",
      {
        oldestCapturedAt: detail.oldestCapturedAt ?? null,
        newestCapturedAt: now,
        proofObservationId,
        reasonCode: "window_not_honoured",
        cursor: {
          requestedAfterMs: requested.afterMs,
          requestedBeforeMs: requested.beforeMs,
          spanDays: lane.guard.spanDays,
          servedAfterMs: detail.served?.afterMs ?? null,
          servedBeforeMs: detail.served?.beforeMs ?? null,
        },
      },
    );
    await input.telemetry.addAnomaly({
      code: "fansly_stats_window_not_honoured",
      severity: "warn",
      message: "Fansly stats provider did not honour the requested window; backfill walk stopped",
      details: {
        plane,
        trigger: detail.trigger,
        spanDays: lane.guard.spanDays,
        requestedAfter: new Date(requested.afterMs).toISOString(),
        requestedBefore: new Date(requested.beforeMs).toISOString(),
        servedAfter: detail.served?.afterMs == null
          ? null
          : new Date(detail.served.afterMs).toISOString(),
        servedBefore: detail.served?.beforeMs == null
          ? null
          : new Date(detail.served.beforeMs).toISOString(),
      },
    });
    return "stopped";
  };

  // ── RECOVERY: the lanes the DATE-BOUND walk stopped (Defect A) ─────────────
  //
  // `window_not_honoured` on the daily plane is a claim about a walk that no
  // longer exists. That walk was asking `/it/amoie/stats` for historical DATE
  // BOUNDS; this route serves history only by MONTH. So the claim is SUPERSEDED
  // rather than left standing: the row is replaced with the month walk's own
  // status and the lane reopens at the month before the trailing window.
  //
  // ONCE, and self-limiting: the reopen writes the new coverage row immediately,
  // so the reason code that triggers it is gone before the next dispatch reads
  // it. A lane that stops again stops with `month_form_not_honoured`, which this
  // never reopens — the month form failing is a different fact about a different
  // request, and reopening on it would be the loop this whole file is about.
  const dailyNeedsMonthWalk = state.backfill === null
    || (state.backfill.daily.done && state.backfill.daily.nextMonthIndex === null);
  if (dailyNeedsMonthWalk) {
    const stopped = (await listCaptureCoverage(app.db, {
      pageId,
      plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    })).find((row) => row.reasonCode === "window_not_honoured");
    if (stopped !== undefined) {
      const resumeAt = monthIndexOf(now) - 1;
      const reopened = state.backfill ?? {
        daily: emptyDailyBackfill(now),
        // The other two lanes are NOT reopened. Their walks finished or stopped
        // on their own evidence, and restarting the earnings walk would re-spend
        // a decade of requests it has already made.
        hourly: {
          nextBeforeMs: now.getTime(),
          daysWalked: 0,
          done: true,
          guard: emptyWindowGuard(BACKFILL_HOURLY_STEP_DAYS),
        },
        earnings: {
          nextBeforeMs: now.getTime(),
          offset: 0,
          lastOffset: null,
          windowRows: 0,
          emptyStreak: 0,
          probeSpent: false,
          probeResumeBeforeMs: null,
          done: true,
          guard: emptyWindowGuard(BACKFILL_EARNINGS_WINDOW_DAYS),
        },
      };
      reopened.daily = {
        ...reopened.daily,
        done: false,
        // The trailing window is what that walk DID capture — it was its first
        // call, and the steady sweep re-captures it every day regardless.
        trailingCaptured: true,
        nextMonthIndex: resumeAt,
        lastMonthIndex: null,
        emptyStreak: 0,
      };
      state = { ...state, mode: "backfill", backfill: reopened };
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsAccountDaily,
        "in_progress",
        "none",
        {
          newestCapturedAt: now,
          reasonCode: "month_form_supersedes_window_not_honoured",
          cursor: { mode: "backfill_month", nextMonth: monthLabel(resumeAt) },
        },
      );
      await saveProgress();
      await input.telemetry.addAnomaly({
        code: "fansly_stats_month_walk_resumed",
        severity: "info",
        message:
          "Fansly daily statistics history resumes by calendar month; the date-bound stop is "
          + "superseded",
        details: {
          plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
          nextMonth: monthLabel(resumeAt),
        },
      });
    }
  }

  // ── BACKFILL (first enable) ────────────────────────────────────────────────
  if (state.mode === "backfill" && state.backfill !== null) {
    const backfill = state.backfill;

    /**
     * THE MONTH FORM REFUSED — the end of this lane's history walk.
     *
     * No halve-and-retry, because there is no half of a month to ask for: a
     * month either came back or something else did. The stop is durable in the
     * cursor, so the coverage row and the anomaly happen exactly ONCE.
     */
    const stopMonthWalk = async (detail: {
      trigger: "served_window" | "repeat_request";
      monthIndex: number;
      served?: { afterMs: number | null; beforeMs: number | null };
      proofObservationId?: number | null;
    }): Promise<void> => {
      backfill.daily.done = true;
      const proofObservationId = detail.proofObservationId
        ?? backfill.daily.guard.lastObservationId;
      const { year, month } = monthFromIndex(detail.monthIndex);
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsAccountDaily,
        // Bounded by the PROVIDER's behaviour, not by us and not by exhaustion:
        // there is older history, and this surface will not serve it in any form
        // this lane knows how to ask for.
        "partial_provider_surface",
        proofObservationId === null ? "none" : "terminal_response",
        {
          oldestCapturedAt: backfill.daily.floorAt === null
            ? null
            : new Date(backfill.daily.floorAt),
          newestCapturedAt: now,
          proofObservationId,
          reasonCode: "month_form_not_honoured",
          cursor: {
            mode: "backfill_month",
            requestedYear: year,
            requestedMonth: month,
            servedAfterMs: detail.served?.afterMs ?? null,
            servedBeforeMs: detail.served?.beforeMs ?? null,
          },
        },
      );
      await input.telemetry.addAnomaly({
        code: "fansly_stats_month_form_not_honoured",
        severity: "warn",
        message:
          "Fansly stats did not answer the calendar month it was asked for; the history walk "
          + "stopped",
        details: {
          plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
          trigger: detail.trigger,
          requestedMonth: monthLabel(detail.monthIndex),
          servedAfter: detail.served?.afterMs == null
            ? null
            : new Date(detail.served.afterMs).toISOString(),
          servedBefore: detail.served?.beforeMs == null
            ? null
            : new Date(detail.served.beforeMs).toISOString(),
        },
      });
    };

    while (
      input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
      && hasDayCapacity()
    ) {
      if (!backfill.daily.done) {
        const guard = backfill.daily.guard;

        // ── STEP 1: THE TRAILING WINDOW ────────────────────────────────────
        //
        // The one window whose DATE BOUNDS this route honours — because it is
        // the window the route would have served anyway.
        if (!backfill.daily.trailingCaptured) {
          const requested = {
            beforeMs: backfill.daily.nextBeforeMs,
            afterMs: backfill.daily.nextBeforeMs - guard.spanDays * DAY_MS,
          };
          // REPEAT-REQUEST GUARD, spent before any egress: the identical
          // `(afterDate, beforeDate, period)` twice in one walk is the loop's
          // first visible step, and there is nothing to learn from issuing it.
          if (
            guard.lastBeforeMs === requested.beforeMs && guard.lastAfterMs === requested.afterMs
          ) {
            await handleUnhonouredWindow(
              backfill.daily,
              CAPTURE_COVERAGE_PLANES.statsAccountDaily,
              requested,
              {
                trigger: "repeat_request",
                oldestCapturedAt: backfill.daily.floorAt === null
                  ? null
                  : new Date(backfill.daily.floorAt),
              },
            );
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            continue;
          }
          const beforeDate = new Date(requested.beforeMs);
          const afterDate = new Date(requested.afterMs);
          guard.lastBeforeMs = requested.beforeMs;
          guard.lastAfterMs = requested.afterMs;
          await assertOwnedPageSyncLease(app.db);
          const response = await app.adapter.getAccountStats(requestContext, {
            beforeDate,
            afterDate,
            periodMs: DAILY_PERIOD_MS,
          });
          const persisted = await persist("account_stats", {
            mode: "backfill",
            periodMs: DAILY_PERIOD_MS,
            beforeDate: beforeDate.toISOString(),
            afterDate: afterDate.toISOString(),
          }, response.raw);
          guard.lastObservationId = persisted.observationId ?? guard.lastObservationId;
          if (classifyStatsWindow(response.raw) === "invalid") {
            guard.lastBeforeMs = null;
            guard.lastAfterMs = null;
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            throw new FanslyLaneInvalidResponseError("account_stats");
          }

          const served = servedWindow(response.raw);
          // Journal first, THEN judge: the bytes are already durable, and what
          // follows only decides whether this walk has anywhere left to go.
          if (!windowWasHonoured(requested, served)) {
            await handleUnhonouredWindow(
              backfill.daily,
              CAPTURE_COVERAGE_PLANES.statsAccountDaily,
              requested,
              {
                trigger: "served_window",
                served,
                oldestCapturedAt: backfill.daily.floorAt === null
                  ? null
                  : new Date(backfill.daily.floorAt),
              },
            );
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            continue;
          }
          if (served.afterMs !== null) {
            const servedFloor = new Date(served.afterMs).toISOString();
            backfill.daily.floorAt = backfill.daily.floorAt === null
              || servedFloor < backfill.daily.floorAt
              ? servedFloor
              : backfill.daily.floorAt;
          }
          // EVERYTHING OLDER IS A CALENDAR MONTH. The first one is the month
          // BEFORE the trailing window: the trailing window covers this month
          // and only part of the previous one, so the previous month is the
          // first that the month form can complete.
          backfill.daily.trailingCaptured = true;
          backfill.daily.nextMonthIndex = monthIndexOf(now) - 1;
          await coverage(
            CAPTURE_COVERAGE_PLANES.statsAccountDaily,
            "in_progress",
            "none",
            {
              oldestCapturedAt: backfill.daily.floorAt === null
                ? null
                : new Date(backfill.daily.floorAt),
              newestCapturedAt: now,
              cursor: {
                mode: "backfill_month",
                nextMonth: monthLabel(backfill.daily.nextMonthIndex),
              },
            },
          );
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }

        // ── STEP 2: THE MONTH WALK, newest month first ─────────────────────
        const monthIndex = backfill.daily.nextMonthIndex ?? monthIndexOf(now) - 1;
        // The same repeat guard, in the unit this walk steps in: the same
        // `(year, month)` twice is the loop, and it costs nothing to see it
        // before the request rather than after 24 identical bodies.
        if (backfill.daily.lastMonthIndex === monthIndex) {
          await stopMonthWalk({ trigger: "repeat_request", monthIndex });
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        backfill.daily.lastMonthIndex = monthIndex;
        const { year, month } = monthFromIndex(monthIndex);
        // THE APP'S OWN REQUEST: the trailing bounds ride along and the server
        // ignores them; `year`/`month` are what select the window.
        const monthBefore = now;
        const monthAfter = new Date(now.getTime() - MONTH_FORM_TRAILING_DAYS * DAY_MS);
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getAccountStats(requestContext, {
          beforeDate: monthBefore,
          afterDate: monthAfter,
          periodMs: DAILY_PERIOD_MS,
          year,
          month,
        });
        const persisted = await persist("account_stats", {
          mode: "backfill_month",
          year,
          month,
          periodMs: DAILY_PERIOD_MS,
          beforeDate: monthBefore.toISOString(),
          afterDate: monthAfter.toISOString(),
        }, response.raw);
        guard.lastObservationId = persisted.observationId ?? guard.lastObservationId;
        if (classifyStatsWindow(response.raw) === "invalid") {
          backfill.daily.lastMonthIndex = null;
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          throw new FanslyLaneInvalidResponseError("account_stats");
        }

        const served = servedWindow(response.raw);
        if (!monthWasHonoured(monthIndex, served)) {
          await stopMonthWalk({
            trigger: "served_window",
            monthIndex,
            served,
            proofObservationId: persisted.observationId,
          });
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        if (isEmptyStatsMonth(response.raw)) {
          const streak = backfill.daily.emptyStreak + 1;
          backfill.daily.emptyStreak = streak;
          if (streak >= BACKFILL_EMPTY_STREAK_LIMIT && !backfill.daily.probeSpent) {
            // [E10]: an empty month on a long-idle account proves INACTIVITY,
            // not a retention floor. Spend one probe a year further back before
            // calling it a floor, and remember where the ordinary walk was so a
            // probe that finds data can come back and fill what it jumped over.
            backfill.daily.probeSpent = true;
            backfill.daily.probeResumeMonthIndex = monthIndex - 1;
            backfill.daily.nextMonthIndex = monthIndex - BACKFILL_PROBE_JUMP_MONTHS;
          } else if (streak >= BACKFILL_EMPTY_STREAK_LIMIT) {
            backfill.daily.done = true;
            // The empty response IS the proof, and it is journaled: the
            // coverage row points at the observation rather than restating it.
            await coverage(
              CAPTURE_COVERAGE_PLANES.statsAccountDaily,
              "provider_exhausted",
              "empty_window",
              {
                oldestCapturedAt: backfill.daily.floorAt === null
                  ? null
                  : new Date(backfill.daily.floorAt),
                proofObservationId: persisted.observationId,
                reasonCode: "empty_window_streak",
                cursor: { mode: "backfill_month", lastMonth: monthLabel(monthIndex) },
              },
            );
          } else {
            backfill.daily.nextMonthIndex = monthIndex - 1;
          }
        } else {
          backfill.daily.emptyStreak = 0;
          // The floor only ever moves BACKWARDS: a probe month that reached
          // further than the ordinary walk must not be undone by the next
          // ordinary month, which is nearer to today.
          if (served.afterMs !== null) {
            const servedFloor = new Date(served.afterMs).toISOString();
            backfill.daily.floorAt = backfill.daily.floorAt === null
              || servedFloor < backfill.daily.floorAt
              ? servedFloor
              : backfill.daily.floorAt;
          }
          if (backfill.daily.probeResumeMonthIndex !== null) {
            // The probe PROVED there is older history, so the eleven months it
            // jumped over are unexamined rather than absent. Resume at the gap;
            // the walk will reach the probe month again on its own.
            backfill.daily.nextMonthIndex = backfill.daily.probeResumeMonthIndex;
            backfill.daily.probeResumeMonthIndex = null;
          } else {
            backfill.daily.nextMonthIndex = monthIndex - 1;
          }
          await coverage(
            CAPTURE_COVERAGE_PLANES.statsAccountDaily,
            "in_progress",
            "none",
            {
              oldestCapturedAt: backfill.daily.floorAt === null
                ? null
                : new Date(backfill.daily.floorAt),
              newestCapturedAt: now,
              cursor: {
                mode: "backfill_month",
                nextMonth: monthLabel(backfill.daily.nextMonthIndex),
              },
            },
          );
        }
        state = { ...state, backfill: { ...backfill } };
        await saveProgress();
        continue;
      }

      // ── THE HOURLY LANE HAS NO HISTORY WALK ──────────────────────────────
      //
      // It used to step backwards in 4-day windows. It cannot: those are DATE
      // BOUNDS on the same route the month walk above exists because of, and the
      // month form has no hourly granularity to offer — `period` is a bucket
      // size, and a month of hourly buckets is not something this route has ever
      // been seen serving. So the hourly plane is the TRAILING 25 HOURS and
      // nothing else, and it says so in `capture_coverage` rather than walking
      // to prove it every day. `fanslyStatsHourlyBackfillMaxDays` is kept, and
      // reported here, as the depth this lane WOULD have taken.
      if (hourlyEnabled && !backfill.hourly.done) {
        backfill.hourly.done = true;
        await coverage(
          CAPTURE_COVERAGE_PLANES.statsAccountHourly,
          // Bounded by the PROVIDER's surface: hourly buckets exist only inside
          // the trailing window, and we captured that window.
          "partial_provider_surface",
          "none",
          {
            reasonCode: "hourly_trailing_window_only",
            newestCapturedAt: now,
            cursor: {
              trailingHours: HOURLY_TRAILING_HOURS,
              configuredBackfillMaxDays: hourlyBackfillMaxDays,
            },
          },
        );
        state = { ...state, backfill: { ...backfill } };
        await saveProgress();
        continue;
      }
      if (!hourlyEnabled) {
        backfill.hourly.done = true;
      }

      if (!backfill.earnings.done) {
        const earningsGuard = backfill.earnings.guard;
        const offset = backfill.earnings.offset;
        const requested = {
          beforeMs: backfill.earnings.nextBeforeMs,
          afterMs: backfill.earnings.nextBeforeMs - earningsGuard.spanDays * DAY_MS,
        };
        if (
          earningsGuard.lastBeforeMs === requested.beforeMs
          && earningsGuard.lastAfterMs === requested.afterMs
          && isRepeatedRequest(backfill.earnings.lastOffset, offset)
        ) {
          await handleUnhonouredWindow(
            backfill.earnings,
            CAPTURE_COVERAGE_PLANES.statsEarnings,
            requested,
            { trigger: "repeat_request" },
          );
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        const before = new Date(requested.beforeMs);
        const after = new Date(requested.afterMs);
        earningsGuard.lastBeforeMs = requested.beforeMs;
        earningsGuard.lastAfterMs = requested.afterMs;
        backfill.earnings.lastOffset = offset;
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getEarningsStatsWindow(requestContext, {
          before,
          after,
          limit: EARNINGS_PAGE_LIMIT,
          offset,
        });
        const persisted = await persist("earnings_stats_snapshot", {
          mode: "backfill",
          before: before.toISOString(),
          after: after.toISOString(),
          limit: EARNINGS_PAGE_LIMIT,
          offset,
        }, response.raw);
        earningsGuard.lastObservationId = persisted.observationId
          ?? earningsGuard.lastObservationId;
        const served = servedEarningsWindow(response.raw);
        if (!windowWasHonoured(requested, served)) {
          // This lane walks by ITS OWN bounds, so it cannot spin the way the
          // daily one did — but rows from outside the window we asked for mean
          // the provider is answering something else, and walking further back
          // on that basis would write a decade of coverage claims for windows
          // nobody served.
          await handleUnhonouredWindow(
            backfill.earnings,
            CAPTURE_COVERAGE_PLANES.statsEarnings,
            requested,
            { trigger: "served_window", served },
          );
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        const rows = rowCount(response.raw);
        backfill.earnings.windowRows += rows;
        const page = advanceOffsetPage({
          offset,
          pageSize: EARNINGS_PAGE_LIMIT,
          rowCount: rows,
        });
        if (!page.done) {
          backfill.earnings.offset = page.nextOffset;
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }

        const windowRows = backfill.earnings.windowRows;
        backfill.earnings.nextBeforeMs = after.getTime();
        backfill.earnings.offset = 0;
        backfill.earnings.lastOffset = null;
        backfill.earnings.windowRows = 0;
        earningsGuard.lastBeforeMs = null;
        earningsGuard.lastAfterMs = null;
        if (windowRows === 0) {
          backfill.earnings.emptyStreak += 1;
          if (
            backfill.earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT
            && !backfill.earnings.probeSpent
          ) {
            // Empty windows prove inactivity, not a retention floor. Bookmark
            // the ordinary walk and spend one probe substantially further
            // back, matching the daily month walk's probe-and-resume rule.
            backfill.earnings.probeSpent = true;
            backfill.earnings.probeResumeBeforeMs = backfill.earnings.nextBeforeMs;
            backfill.earnings.nextBeforeMs -= BACKFILL_PROBE_JUMP_DAYS * DAY_MS;
          } else if (backfill.earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT) {
            backfill.earnings.done = true;
            await coverage(
              CAPTURE_COVERAGE_PLANES.statsEarnings,
              "provider_exhausted",
              "empty_window",
              {
                proofObservationId: persisted.observationId,
                reasonCode: "empty_window_streak",
              },
            );
          }
        } else {
          backfill.earnings.emptyStreak = 0;
          if (backfill.earnings.probeResumeBeforeMs !== null) {
            backfill.earnings.nextBeforeMs = backfill.earnings.probeResumeBeforeMs;
            backfill.earnings.probeResumeBeforeMs = null;
          }
          await coverage(
            CAPTURE_COVERAGE_PLANES.statsEarnings,
            "in_progress",
            "none",
            { oldestCapturedAt: after, newestCapturedAt: now },
          );
        }
        state = { ...state, backfill: { ...backfill } };
        await saveProgress();
        continue;
      }

      break;
    }

    const backfillComplete = backfill.daily.done && backfill.hourly.done
      && backfill.earnings.done;
    if (backfillComplete) {
      state = { ...state, mode: "steady", backfill: null };
      await saveProgress();
    } else {
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
      }
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(1),
        // Burst-shape mitigation: a backfill continuation waits, a steady sweep
        // does not.
        continuationRetryAt: deferred === null
          ? backfillContinuationAt(now, continuationDelayMs)
          : nextFanslyUtcDayStart(now),
        stats: {
          mode: "backfill",
          journaled,
          callsToday: state.callsToday,
          dailyCap,
          deferred,
          dailyFloorAt: backfill.daily.floorAt,
          dailyDone: backfill.daily.done,
          // Where the daily history walk actually IS, in the unit it walks in —
          // "nextBeforeMs: 1750000000000" told an operator nothing.
          dailyTrailingCaptured: backfill.daily.trailingCaptured,
          dailyNextMonth: backfill.daily.nextMonthIndex === null
            ? null
            : monthLabel(backfill.daily.nextMonthIndex),
          hourlyDone: backfill.hourly.done,
          earningsDone: backfill.earnings.done,
        },
      };
    }
  }

  // ── STEADY DAILY SWEEP ────────────────────────────────────────────────────
  const today = utcDayKey(now);
  if (state.lastSweepDay === today && state.stepIndex === 0) {
    return {
      satisfied: true,
      yieldReason: null,
      stats: { skipped: "sweep_not_due", lastSweepDay: state.lastSweepDay },
    };
  }

  while (input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()) {
    if (!hasDayCapacity()) {
      // DEFER, never drop. The step index is durable, so tomorrow resumes here.
      deferred = "daily_call_budget";
      break;
    }
    await assertOwnedPageSyncLease(app.db);

    if (state.stepIndex === 0) {
      const beforeDate = now;
      const afterDate = new Date(now.getTime() - DAILY_TRAILING_DAYS * DAY_MS);
      const response = await app.adapter.getAccountStats(requestContext, {
        beforeDate,
        afterDate,
        periodMs: DAILY_PERIOD_MS,
      });
      const persisted = await persist("account_stats", {
        mode: "steady",
        periodMs: DAILY_PERIOD_MS,
        beforeDate: beforeDate.toISOString(),
        afterDate: afterDate.toISOString(),
      }, response.raw);
      if (classifyStatsWindow(response.raw) === "invalid") {
        throw new FanslyLaneInvalidResponseError("account_stats");
      }
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsAccountDaily,
        "window_captured",
        "none",
        {
          newestCapturedAt: now,
          proofObservationId: persisted.observationId,
        },
      );
      state = { ...state, stepIndex: 1 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 1) {
      if (!hourlyEnabled) {
        state = { ...state, stepIndex: 2 };
        await saveProgress();
        continue;
      }
      const beforeDate = now;
      const afterDate = new Date(now.getTime() - HOURLY_TRAILING_HOURS * HOUR_MS);
      const response = await app.adapter.getAccountStats(requestContext, {
        beforeDate,
        afterDate,
        periodMs: HOURLY_PERIOD_MS,
      });
      const persisted = await persist("account_stats", {
        mode: "steady_hourly",
        periodMs: HOURLY_PERIOD_MS,
        beforeDate: beforeDate.toISOString(),
        afterDate: afterDate.toISOString(),
      }, response.raw);
      if (classifyStatsWindow(response.raw) === "invalid") {
        throw new FanslyLaneInvalidResponseError("account_stats");
      }
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsAccountHourly,
        "window_captured",
        "none",
        {
          newestCapturedAt: now,
          proofObservationId: persisted.observationId,
        },
      );
      state = { ...state, stepIndex: 2 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 2) {
      const before = now;
      const after = new Date(now.getTime() - EARNINGS_TRAILING_DAYS * DAY_MS);
      const offset = state.earningsOffset;
      // REPEAT-CURSOR GUARD: a server that ignores `offset` would otherwise
      // serve page 1 forever and this loop would spend the whole daily cap on
      // one page. Refusing to re-fetch the same offset turns that into a
      // completed step with the pages we did get.
      if (state.earningsPreviousOffset === offset && offset > 0) {
        await input.telemetry.addAnomaly({
          code: "fansly_stats_earnings_cursor_repeat",
          severity: "warn",
          message: "Fansly earnings-stats pagination did not advance; step completed early",
          details: { offset },
        });
        state = { ...state, stepIndex: 3, earningsOffset: 0, earningsPreviousOffset: null };
        await saveProgress();
        continue;
      }
      const response = await app.adapter.getEarningsStatsWindow(requestContext, {
        before,
        after,
        limit: EARNINGS_PAGE_LIMIT,
        offset,
      });
      await persist("earnings_stats_snapshot", {
        mode: "steady",
        before: before.toISOString(),
        after: after.toISOString(),
        limit: EARNINGS_PAGE_LIMIT,
        offset,
      }, response.raw);
      const rows = rowCount(response.raw);
      const exhausted = rows < EARNINGS_PAGE_LIMIT;
      state = exhausted
        ? { ...state, stepIndex: 3, earningsOffset: 0, earningsPreviousOffset: null }
        : {
          ...state,
          earningsOffset: offset + EARNINGS_PAGE_LIMIT,
          earningsPreviousOffset: offset,
        };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 3) {
      // All-time in one call. `after` is set below any plausible account
      // creation date rather than left off: the observed live call carried both
      // bounds, and an unbounded form has never been seen answering.
      const response = await app.adapter.getEarningsMonthlyStats(requestContext, {
        before: now,
        after: new Date(Date.UTC(2015, 0, 1)),
      });
      await persist("earnings_monthlystats_snapshot", {
        before: now.toISOString(),
        after: new Date(Date.UTC(2015, 0, 1)).toISOString(),
      }, response.raw);
      state = { ...state, stepIndex: 4 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 4) {
      const response = await app.adapter.getTrackingLinks(requestContext);
      await persist("tracking_links", {}, response.raw);
      state = { ...state, stepIndex: 5 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 5) {
      const page = state.discoveryPage;
      const response = await app.adapter.getDiscoveryMediaSuggestions(requestContext, {
        limit: DISCOVERY_PAGE_LIMIT,
        offset: page * DISCOVERY_PAGE_LIMIT,
      });
      await persist("discovery_feed", {
        page,
        limit: DISCOVERY_PAGE_LIMIT,
        offset: page * DISCOVERY_PAGE_LIMIT,
        // The rows are a SAMPLE of the discovery feed. Labelled here so nothing
        // downstream can read them as "the global FYP corpus".
        sampling: "sampled",
      }, response.raw);
      const nextPage = page + 1;
      state = nextPage >= DISCOVERY_PAGES_PER_SWEEP
        ? { ...state, stepIndex: 6, discoveryPage: 0 }
        : { ...state, discoveryPage: nextPage };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 6) {
      // A28-5 extras, one call each per sweep. The FIRST enable walks the
      // broadcast `before` cursor to the floor — every page journaled — because
      // mass-DM performance before today is otherwise unrecoverable; afterwards
      // only the first page is polled.
      const response = await app.adapter.getBroadcastStatsPage(requestContext, {
        before: state.broadcastFloorReached ? null : state.broadcastBefore,
        limit: null,
        deleted: false,
      });
      await persist("broadcast_stats", {
        before: state.broadcastFloorReached ? null : state.broadcastBefore,
        walk: state.broadcastFloorReached ? "head" : "first_enable_backfill",
      }, response.raw);
      const rows = rowCount(response.raw);
      const pagesInSweep = state.broadcastPagesInSweep + 1;
      if (state.broadcastFloorReached) {
        state = { ...state, stepIndex: 7, broadcastPagesInSweep: 0 };
      } else if (rows === 0) {
        state = {
          ...state,
          broadcastFloorReached: true,
          broadcastBefore: null,
          stepIndex: 7,
          broadcastPagesInSweep: 0,
        };
      } else {
        const nextBefore = oldestBroadcastRef(response.raw);
        // A cursor that does not advance is a walk that would never end.
        state = nextBefore === null || nextBefore === state.broadcastBefore
          ? {
            ...state,
            broadcastFloorReached: true,
            broadcastBefore: null,
            stepIndex: 7,
            broadcastPagesInSweep: 0,
          }
          // BOUNDED PER SWEEP. Without this the first-enable walk would hold the
          // sweep at step 6 until the whole broadcast history was read — and
          // `lastSweepDay` only advances at the last step, so the DAILY traffic
          // capture behind it would stall for as many days as the walk took.
          // Three pages a day finishes any realistic history in under a fortnight
          // and never blocks the head poll.
          : pagesInSweep >= BROADCAST_BACKFILL_PAGES_PER_SWEEP
          ? { ...state, broadcastBefore: nextBefore, stepIndex: 7, broadcastPagesInSweep: 0 }
          : { ...state, broadcastBefore: nextBefore, broadcastPagesInSweep: pagesInSweep };
      }
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 7) {
      const response = await app.adapter.getBroadcastStatsPage(requestContext, {
        before: null,
        limit: null,
        deleted: true,
      });
      await persist("broadcast_stats_deleted", {}, response.raw);
      state = { ...state, stepIndex: 8 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 8) {
      const response = await app.adapter.getBroadcastScheduled(requestContext);
      await persist("broadcast_scheduled", {}, response.raw);
      state = { ...state, stepIndex: 9 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 9) {
      const response = await app.adapter.getPolls(requestContext);
      await persist("polls", {}, response.raw);
      state = { ...state, stepIndex: 10 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === LAST_SWEEP_STEP) {
      const response = await app.adapter.getRecapStats(requestContext);
      await persist("recapstats", {}, response.raw);
      state = { ...state, stepIndex: 0, lastSweepDay: today };
      await completeLane(input.syncRunId);
      return {
        satisfied: true,
        yieldReason: null,
        stats: { mode: "steady", journaled, callsToday: state.callsToday, dailyCap },
      };
    }

    break;
  }

  await saveProgress();
  return {
    satisfied: false,
    yieldReason: deferred === null ? input.budget.resolveYieldReason(1) : null,
    ...(deferred === null ? {} : {
      // Deferred at the cap: come back after the UTC roll, not sooner.
      continuationRetryAt: nextFanslyUtcDayStart(now),
    }),
    stats: {
      mode: "steady",
      journaled,
      stepIndex: state.stepIndex,
      callsToday: state.callsToday,
      dailyCap,
      deferred,
    },
  };
}

/** The `before` cursor for the next broadcast page: the oldest id this page
 *  served. Returns null when the shape carries none — which ends the walk
 *  rather than repeating it. */
function oldestBroadcastRef(payload: unknown): string | null {
  const record = asRecord(payload);
  const rows = record === null
    ? (Array.isArray(payload) ? payload : [])
    : Array.isArray(record.messages)
    ? record.messages
    : [];
  let oldest: string | null = null;
  for (const row of rows) {
    const item = asRecord(row);
    const id = item === null ? null : asNullableString(item.id);
    if (id === null) {
      continue;
    }
    // Snowflake ids sort lexicographically within one length; compare on length
    // first so a shorter (older) id wins.
    if (
      oldest === null || id.length < oldest.length
      || (id.length === oldest.length && id < oldest)
    ) {
      oldest = id;
    }
  }
  return oldest;
}
