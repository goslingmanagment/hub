// WP-F1 — the `stats_snapshot` capture handler.
//
// A DAILY sweep on a 6-hourly stream. The cadence is 21 600 s so a day that
// deferred at its cap resumes within six hours rather than at the next
// midnight; whether a sweep is actually DUE is decided here, from the cursor.
//
// SEVEN STEPS, each ONE journaled call with its own observation kind:
//
//   1  account_stats            trailing 30 d, period 86 400 000
//   2  account_stats            trailing 25 h, period 3 600 000 (gated) — NOT
//                               bound to the daily sweep: it runs on its own
//                               clock ("THE HOURLY PLANE" in the handler)
//   3  earnings_stats_snapshot  trailing 30 d, bounded UTC-day window walk
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
// month. Where the account's own creation date is known, THAT is the floor and
// the walk steps to it month by month. Where it is not, the walk stops after two
// consecutive empty months PLUS one probe about a year further back ([E10]: an
// empty month on a long-idle account proves inactivity, not a retention floor),
// and it journals every empty response, because an empty month IS the floor
// evidence. The earnings walk below follows the same two rules.
//
// Every lane checks the served bounds. Daily/monthly capture keeps its own
// provider-specific guard. Earnings uses a durable UTC-day window walk: a full
// response is split, never offset-paginated (the provider ignores offset).
// An unwalked span is a hole we know about; a loop is a day of egress spent
// proving nothing. The same rule catches a repeated request before it is issued.
//
// `/account/wallets/earnings/
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
  SYNC_STREAM_POLICY,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  fanslyStatsDatasetHasDatapointArrays,
  isExactTerminalNullAccountStatsPayload,
} from "../canonicalize/fansly-stats.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { parseFanslyMetadataAccountCreatedAt } from "../fansly.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  classifyFanslyResponse,
  createFanslyLaneCoverageWriter,
  createFanslyLaneJournal,
  createFanslyLaneRuntime,
  fanslyUtcDayKey,
  FanslyLaneInvalidResponseError,
  type FanslyResponseClass,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
  spreadFanslyContinuation,
} from "./fansly-lane.ts";
import {
  advanceEarningsWindow,
  FANSLY_EARNINGS_ROW_LIMIT,
  parseEarningsWindow,
  startEarningsWindow,
  type EarningsWindowWalk,
} from "./fansly-earnings-window.ts";
import { evaluateFanslyStreamGate } from "./fansly-stream-gate.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { retentionDate } from "./shared.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

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
/** The route serves hourly buckets only inside this window, so two hourly
 *  captures further apart than it leave hours that no window will reach again. */
const HOURLY_WINDOW_MS = HOURLY_TRAILING_HOURS * HOUR_MS;
/** The furthest apart two hourly captures may be. A served window is 25
 *  buckets, dateAfter to dateBefore inclusive, and ends 0–2 h short of the
 *  hour asked for, varying from call to call (production 2026-09). Two windows
 *  whose request hours are Δ apart meet while Δ ≤ 25 h − (older lag − newer
 *  lag): a day apart, a lag going 2 h -> 0 h leaves one bucket in neither; at
 *  23 h they meet even then. */
const HOURLY_CAPTURE_SPACING_MS = 23 * HOUR_MS;
/** The furthest a scheduled dispatch of this lane can be from the one before. */
const STATS_CADENCE_MS = SYNC_STREAM_POLICY.stats_snapshot.cadenceSeconds * 1000;
const EARNINGS_TRAILING_DAYS = 30;
const EARNINGS_PAGE_LIMIT = FANSLY_EARNINGS_ROW_LIMIT;
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
 *  [E10] in the unit this walk actually steps in. Only where the account's
 *  creation date is unknown: a known one is the floor, and nothing is probed. */
const BACKFILL_PROBE_JUMP_MONTHS = 12;
const BACKFILL_PROBE_JUMP_DAYS = 365;
/**
 * The oldest account creation date the walks BELIEVE.
 *
 * With a known creation date the daily and earnings walks step all the way to
 * it and never stop on empty windows, so a garbage or epoch value in page
 * metadata would walk to 1970. Anything older than this or later than now is
 * treated as unknown, and the [E10] probe rule applies instead. The bound sits
 * before the platform itself existed, not at the 2015 instant the all-time
 * monthly call below sends: every month between the two would be a
 * guaranteed-empty request on first enable, and a Fansly creation date older
 * than Fansly is not a floor, it is bad metadata.
 */
const PLAUSIBLE_ACCOUNT_CREATED_AFTER_MS = Date.UTC(2019, 0, 1);
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
/** Pages of mass-DM history each first-enable walk (live, deleted) takes per
 *  daily sweep. */
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
  /**
   * The probe month that FOUND data, while the resumed walk fills the gap above
   * it. Empty months in that gap are unexamined history, not a floor: two of
   * them in a row must not end the walk before it reaches the month the probe
   * already proved. Reaching it skips it (it is journaled) and clears this.
   */
  probeHitMonthIndex: number | null;
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
  walk: EarningsWindowWalk | null;
  emptyStreak: number;
  probeSpent: boolean;
  probeResumeBeforeMs: number | null;
  /** The probe window that FOUND rows, while the resumed walk fills the gap
   *  above it — the daily walk's `probeHitMonthIndex`, in this walk's unit. */
  probeHitAfterMs: number | null;
  probeHitBeforeMs: number | null;
  done: boolean;
  guard: BackfillWindowGuard;
}

export interface FanslyStatsCursorState {
  version: 2;
  mode: "backfill" | "steady";
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** The last UTC day a full daily sweep completed. */
  lastSweepDay: string | null;
  /** The UTC day the in-progress steady sweep belongs to. It survives a UTC
   *  rollover so finishing yesterday's tail cannot masquerade as today's full
   *  sweep. Null when no steady sweep is in progress. */
  sweepDay: string | null;
  /** Which step to resume at within `sweepDay`. */
  stepIndex: number;
  // Additive fields keep the v2 envelope readable during image rollback:
  // old readers may re-read this window, but retain the day budget/history.
  earningsWalk: EarningsWindowWalk | null;
  discoveryPage: number;
  /** `before` cursor for the first-enable broadcast walk; null once at the floor. */
  broadcastBefore: string | null;
  broadcastFloorReached: boolean;
  /** Pages the broadcast walk has taken in THIS sweep. Bounded so the
   *  first-enable walk cannot hold the sweep at step 6 for days and starve the
   *  daily traffic capture behind it. */
  broadcastPagesInSweep: number;
  /** Why the live walk reached its floor; null while it is open, or when it
   *  got there before the reason was kept. */
  broadcastWalkStop: BroadcastWalkStop | null;
  /** The same walk over the DELETED list (step 7), with the same bound. A
   *  cursor from before it existed starts it once. */
  deletedBroadcastBefore: string | null;
  deletedBroadcastFloorReached: boolean;
  deletedBroadcastPagesInSweep: number;
  deletedBroadcastWalkStop: BroadcastWalkStop | null;
  /** When the hourly plane's trailing window was last captured — that
   *  request's window end, ISO. The hourly capture keeps its own clock, not
   *  the daily sweep's. Null until the first capture; a cursor from before
   *  this field derives it once from the steady coverage row. */
  lastHourlyCapturedAt: string | null;
  /** The newest bucket that capture was SERVED — the body's `dateBefore`,
   *  ISO — which is where the next capture's window has to reach back to.
   *  Null when the body carried no bounds; derived like the field above. */
  lastHourlyServedBefore: string | null;
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

function asNullableInstant(value: unknown): string | null {
  const text = asNullableString(value);
  const ms = text === null ? Number.NaN : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function previousUtcDayKey(day: string, fallbackNow: Date): string {
  const midnightMs = Date.parse(`${day}T00:00:00.000Z`);
  const baseMs = Number.isNaN(midnightMs) ? fallbackNow.getTime() : midnightMs;
  return fanslyUtcDayKey(new Date(baseMs - DAY_MS));
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
    probeHitMonthIndex: asNullableInt(record?.probeHitMonthIndex),
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
    walk: parseEarningsWindow(record?.walk),
    emptyStreak: asInt(record?.emptyStreak, 0),
    probeSpent: record?.probeSpent === true,
    probeResumeBeforeMs: asNullableInt(record?.probeResumeBeforeMs),
    probeHitAfterMs: asNullableInt(record?.probeHitAfterMs),
    probeHitBeforeMs: asNullableInt(record?.probeHitBeforeMs),
    done: record?.done === true,
    guard: parseWindowGuard(record?.guard, BACKFILL_EARNINGS_WINDOW_DAYS),
  };
}

export function parseFanslyStatsCursorState(
  value: unknown,
  now = new Date(),
): FanslyStatsCursorState | null {
  const state = asRecord(value);
  if (!state || (state.version !== 1 && state.version !== 2)) {
    return null;
  }
  const mode = state.mode === "backfill" || state.mode === "steady" ? state.mode : null;
  const utcDay = asNullableString(state.utcDay);
  if (mode === null || utcDay === null) {
    return null;
  }
  const backfillRecord = asRecord(state.backfill);
  const stepIndex = Math.min(LAST_SWEEP_STEP, Math.max(0, asInt(state.stepIndex, 0)));
  const lastSweepDay = asNullableString(state.lastSweepDay);
  const legacySweepDay = mode === "steady" && stepIndex > 0
    // A v1 cursor cannot prove whether this tail already crossed midnight. Treat
    // it as belonging to the last completed day (or yesterday on first enable),
    // finish it, then force one bounded current-day sweep. That one-time repeat
    // is safer than preserving the exact stale-head failure this migration fixes.
    ? lastSweepDay ?? previousUtcDayKey(utcDay, now)
    : null;
  return {
    version: 2,
    mode,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    // A completed v1 cursor also cannot prove that step 0 ran on this UTC day.
    // Clearing the completion marker makes the upgrade self-heal with one
    // ordinary capped sweep; v2 checkpoints never take this branch again.
    lastSweepDay: state.version === 1 && mode === "steady" && stepIndex === 0
      ? null
      : lastSweepDay,
    sweepDay: state.version === 1 ? legacySweepDay : asNullableString(state.sweepDay),
    // Clamped to the real step range. A stored value past the last step would
    // otherwise wedge the lane: the sweep loop would fall straight through to
    // its `break` and return "not satisfied, nothing done" on every dispatch,
    // forever, with no call and no error to show for it.
    stepIndex,
    // Legacy offsets never proved progress. Re-read the current root window;
    // completed history and all physical-attempt accounting remain unchanged.
    earningsWalk: parseEarningsWindow(state.earningsWalk),
    discoveryPage: Math.max(0, asInt(state.discoveryPage, 0)),
    broadcastBefore: asNullableString(state.broadcastBefore),
    broadcastFloorReached: state.broadcastFloorReached === true,
    broadcastPagesInSweep: Math.max(0, asInt(state.broadcastPagesInSweep, 0)),
    broadcastWalkStop: parseBroadcastWalkStop(state.broadcastWalkStop),
    deletedBroadcastBefore: asNullableString(state.deletedBroadcastBefore),
    deletedBroadcastFloorReached: state.deletedBroadcastFloorReached === true,
    deletedBroadcastPagesInSweep: Math.max(0, asInt(state.deletedBroadcastPagesInSweep, 0)),
    deletedBroadcastWalkStop: parseBroadcastWalkStop(state.deletedBroadcastWalkStop),
    lastHourlyCapturedAt: asNullableInstant(state.lastHourlyCapturedAt),
    lastHourlyServedBefore: asNullableInstant(state.lastHourlyServedBefore),
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
    probeHitMonthIndex: null,
    done: false,
    floorAt: null,
    guard: emptyWindowGuard(BACKFILL_DAILY_WINDOW_DAYS),
  };
}

/** An earnings walk that has asked for nothing yet, starting below `nextBeforeMs`. */
function emptyEarningsBackfill(nextBeforeMs: number, done: boolean): EarningsBackfillState {
  return {
    nextBeforeMs,
    walk: null,
    emptyStreak: 0,
    probeSpent: false,
    probeResumeBeforeMs: null,
    probeHitAfterMs: null,
    probeHitBeforeMs: null,
    done,
    guard: emptyWindowGuard(BACKFILL_EARNINGS_WINDOW_DAYS),
  };
}

/**
 * The account creation date, when it is one the walks can stand on — or null.
 *
 * A known creation date is a HARD floor: nothing about this account predates
 * it. An unknown one leaves the walks on the [E10] probe rule, which is a
 * heuristic about inactivity. See `PLAUSIBLE_ACCOUNT_CREATED_AFTER_MS` for why
 * an implausible value counts as unknown rather than as a floor.
 */
export function trustedAccountCreatedAt(value: Date | null, now: Date): Date | null {
  return value !== null
    && value.getTime() >= PLAUSIBLE_ACCOUNT_CREATED_AFTER_MS
    && value.getTime() <= now.getTime()
    ? value
    : null;
}

/** `year * 12 + (month - 1)` for an instant, in UTC — the unit the daily
 *  history walk steps in. */
export function monthIndexOf(instant: Date): number {
  return instant.getUTCFullYear() * 12 + instant.getUTCMonth();
}

/** A monthly stats request cannot contain account data before the month in
 *  which the account itself was created. The creation month remains eligible:
 *  it can contain a partial month of real activity. */
export function monthPredatesAccountCreation(
  monthIndex: number,
  accountCreatedAt: Date | null,
): boolean {
  return accountCreatedAt !== null && monthIndex < monthIndexOf(accountCreatedAt);
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
 * What did the provider say about this MONTH — the one reading the month walk
 * decides on?
 *
 * "empty" is wider than `classifyStatsWindow`'s on purpose: a month can come
 * back with rows that are all zeros, and a walk that treated a zero-valued
 * bucket as evidence of traffic would never find a floor (which is exactly what
 * WP-F4's per-media walk did on production — 240 windows back to 2006 on one
 * zero-valued row). ANY non-zero counter anywhere in the body is traffic;
 * nothing else is.
 *
 * It also covers the provider's TERMINAL-NULL month, `{"dataset": null,
 * "aggregationData": null}` exactly — the canonicalizer's own predicate, so the
 * body it stamps as a window without facts is the body read here as an empty
 * month. On production it answers months with no statistics at all: pre-creation
 * probes (lora-2, lora-3, lilly-2), ari-1's creation month 2026-03, AND lilly-1's
 * 2025-05, a year after creation, with 2024-05 traffic below it. So it is an
 * empty month, never a floor by itself: the ordinary rules end the walk — the
 * creation floor, or [E10]'s streak and probe. Any other body without a dataset
 * object stays invalid.
 *
 * The response is journaled either way — capture first; only the walk's
 * decision reads this.
 */
export function classifyStatsMonth(payload: unknown): FanslyResponseClass {
  if (isExactTerminalNullAccountStatsPayload(payload)) {
    return "empty";
  }
  const classification = classifyStatsWindow(payload);
  const dataset = statsDataset(payload);
  if (classification !== "nonempty" || dataset === null) {
    return classification;
  }
  for (const key of ["datapoints", "profileDatapoints"] as const) {
    const points = Array.isArray(dataset[key]) ? dataset[key] as unknown[] : [];
    for (const point of points) {
      if (pointCarriesTraffic(point)) {
        return "nonempty";
      }
    }
  }
  return "empty";
}

/** Is this MONTH empty — the floor signal the month walk reads? */
export function isEmptyStatsMonth(payload: unknown): boolean {
  return classifyStatsMonth(payload) === "empty";
}

export function emptyFanslyStatsCursorState(now: Date): FanslyStatsCursorState {
  return {
    version: 2,
    // History remains resumable background work. Each day's fresh sweep gets
    // first use of the same physical-attempt budget, including on first enable.
    mode: "backfill",
    utcDay: utcDayKey(now),
    callsToday: 0,
    lastSweepDay: null,
    sweepDay: null,
    stepIndex: 0,
    earningsWalk: null,
    discoveryPage: 0,
    broadcastBefore: null,
    broadcastFloorReached: false,
    broadcastPagesInSweep: 0,
    broadcastWalkStop: null,
    deletedBroadcastBefore: null,
    deletedBroadcastFloorReached: false,
    deletedBroadcastPagesInSweep: 0,
    deletedBroadcastWalkStop: null,
    lastHourlyCapturedAt: null,
    lastHourlyServedBefore: null,
    backfill: {
      daily: emptyDailyBackfill(now),
      hourly: {
        nextBeforeMs: now.getTime(),
        daysWalked: 0,
        done: false,
        guard: emptyWindowGuard(BACKFILL_HOURLY_STEP_DAYS),
      },
      earnings: emptyEarningsBackfill(now.getTime(), false),
    },
  };
}

export const utcDayKey = fanslyUtcDayKey;

/** A new UTC day resets the attempt counter. Nothing else about the cursor
 *  changes: a sweep that deferred mid-step resumes at exactly that step and
 *  keeps the day on which it started. */
export const rollUtcDay = rollFanslyUtcDay;

// ── the hourly plane's clock ─────────────────────────────────────────────────

/**
 * Is the hourly window due NOW — would the next dispatch this lane can count
 * on already be too late?
 *
 * Asked against the NEXT dispatch, not this one: `nextDispatchBy − lastCaptured
 * > 23 h` (HOURLY_CAPTURE_SPACING_MS). Asked on every 6-hourly slot, that is
 * every third slot, 18 h apart — four calls in three days where a once-a-day
 * capture made three — and a capture that ran off its slot is caught up on the
 * last slot that keeps the two within 23 h. A lane that has never captured is
 * due.
 *
 * Never again within the hour of the last capture: that moves the window by
 * at most one bucket, and a next dispatch more than 23 h out even from NOW (a
 * history walk between 00:05 and 01:05, asked against the next 00:05) would
 * otherwise take it on every chunk.
 */
export function hourlyCaptureDue(
  lastCapturedMs: number | null,
  nowMs: number,
  nextDispatchByMs: number,
): boolean {
  return lastCapturedMs === null || (
    nextDispatchByMs - lastCapturedMs > HOURLY_CAPTURE_SPACING_MS
    && nowMs - lastCapturedMs >= HOURLY_PERIOD_MS
  );
}

/**
 * The hourly buckets between two captures that neither window carries, or null
 * when the windows meet.
 *
 * Counted in SERVED buckets. A window's datapoints run from its `dateAfter` to
 * its `dateBefore` INCLUSIVE, keyed by bucket start — 25 of them (production:
 * 25 distinct `account_media` bucket starts per window). So a newer window
 * that starts one hour after the older one's `dateBefore` has missed nothing,
 * and the missing buckets are [older dateBefore + 1 h, newer dateAfter). The
 * provider snaps both ends to its hour grid and ends a window 0–2 h short of
 * the hour asked for, varying from call to call, so this is NOT the requested
 * windows' gap: those can touch while a bucket is missed (lilly-1, 2026-09-21
 * 02:50 -> 09-22 03:37, the 01:00 bucket) or be minutes apart while the served
 * windows still meet. When either body carried no bounds, the requested
 * windows stand in: the newer one's start against the older capture.
 */
export function hourlyCaptureGap(
  previous: { capturedMs: number; servedBeforeMs: number | null } | null,
  current: { capturedMs: number; servedAfterMs: number | null },
): { fromMs: number; toMs: number; basis: "served" | "requested" } | null {
  if (previous === null) {
    return null;
  }
  if (previous.servedBeforeMs !== null && current.servedAfterMs !== null) {
    const fromMs = previous.servedBeforeMs + HOURLY_PERIOD_MS;
    return current.servedAfterMs > fromMs
      ? { fromMs, toMs: current.servedAfterMs, basis: "served" }
      : null;
  }
  const windowStartMs = current.capturedMs - HOURLY_WINDOW_MS;
  return windowStartMs > previous.capturedMs
    ? { fromMs: previous.capturedMs, toMs: windowStartMs, basis: "requested" }
    : null;
}

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

/**
 * Valid only with the datapoints as ARRAYS — the canonicalizer's own gate
 * predicate. A dataset whose `datapoints` is missing or drifted used to read
 * as "no datapoints", i.e. EMPTY, and two of those are a floor claim: false
 * completeness from a body nothing can parse. Now it is invalid, which every
 * caller already handles loudly, after journaling.
 */
export function classifyStatsWindow(payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const dataset = statsDataset(value);
      return dataset !== null && fanslyStatsDatasetHasDatapointArrays(dataset);
    },
    isEmpty: (value) => {
      const dataset = statsDataset(value)!;
      const profile = Array.isArray(dataset.profileDatapoints) ? dataset.profileDatapoints : [];
      return (dataset.datapoints as unknown[]).length === 0 && profile.length === 0;
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
  const gate = evaluateFanslyStreamGate(effective, STREAM, input.pageContext.page.label);
  if (gate.state !== "ramped") {
    return statsSkip(gate.state);
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const accountCreatedAt = trustedAccountCreatedAt(
    parseFanslyMetadataAccountCreatedAt(input.pageContext.page.metadata),
    now,
  );
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
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  });
  const {
    attemptBudget, complete: completeLane, holdingBack, requestContext, saveProgress,
  } = lane;

  let journaled = 0;
  let deferred: string | null = null;
  /** What this chunk did about the hourly window (see "THE HOURLY PLANE"). */
  let hourly: "disabled" | "not_due" | "deferred" | "captured" = "disabled";

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
        earnings: emptyEarningsBackfill(now.getTime(), true),
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

  // ── RECOVERY: earnings floors claimed from two empty windows ──────────────
  //
  // `provider_exhausted` / `empty_window_streak` on the earnings plane was
  // written by a walk that had no creation floor: two empty windows and one
  // empty probe a year back, on an account that may simply have been quiet for
  // a while. Where the account's creation date is known and lies more than one
  // window below what that walk reached, the claim is SUPERSEDED: only the
  // earnings walk reopens, where it stopped, and walks to creation. Production
  // 2026-09-28: lilly-1 was floored at 2025-11-16 with 2024-05..06 earnings
  // (created 2024-05-05) outside the walked span.
  //
  // ONCE, and self-limiting like the recovery above: the reopen overwrites the
  // row immediately, and with a known creation date the walk never ends on an
  // empty streak again, so the reason code that triggers this cannot come back.
  const earningsClosed = state.backfill === null || state.backfill.earnings.done;
  if (earningsClosed && accountCreatedAt !== null) {
    const claimed = (await listCaptureCoverage(app.db, {
      pageId,
      plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
    })).find((row) => row.scopeRef === "" && row.reasonCode === "empty_window_streak");
    const unwalkedBelow = claimed !== undefined && (
      claimed.oldestCapturedAt === null
      || claimed.oldestCapturedAt.getTime() - accountCreatedAt.getTime()
        > BACKFILL_EARNINGS_WINDOW_DAYS * DAY_MS
    );
    if (claimed !== undefined && unwalkedBelow) {
      // Where the old walk would have asked next: just below the oldest window
      // that carried rows, or — when none ever did — below the two empty
      // windows it walked before its probe, which ended no later than the
      // claim was written.
      const resumeBeforeMs = claimed.oldestCapturedAt === null
        ? claimed.updatedAt.getTime() - BACKFILL_EMPTY_STREAK_LIMIT
          * BACKFILL_EARNINGS_WINDOW_DAYS * DAY_MS
        : claimed.oldestCapturedAt.getTime() - 1;
      const reopened = state.backfill ?? {
        // Nothing else reopens: the daily and hourly planes finished on their
        // own evidence.
        daily: { ...emptyDailyBackfill(now), done: true },
        hourly: {
          nextBeforeMs: now.getTime(),
          daysWalked: 0,
          done: true,
          guard: emptyWindowGuard(BACKFILL_HOURLY_STEP_DAYS),
        },
        earnings: emptyEarningsBackfill(now.getTime(), true),
      };
      reopened.earnings = emptyEarningsBackfill(resumeBeforeMs, false);
      state = { ...state, mode: "backfill", backfill: reopened };
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsEarnings,
        "in_progress",
        "none",
        {
          oldestCapturedAt: claimed.oldestCapturedAt,
          newestCapturedAt: now,
          reasonCode: "account_creation_floor_supersedes_empty_window",
          cursor: {
            resumeBefore: new Date(resumeBeforeMs).toISOString(),
            accountCreatedAt: accountCreatedAt.toISOString(),
          },
        },
      );
      await saveProgress();
      await input.telemetry.addAnomaly({
        code: "fansly_stats_earnings_walk_resumed",
        severity: "info",
        message:
          "Fansly earnings history resumes toward the account creation date; the empty-window "
          + "floor is superseded",
        details: {
          plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
          resumeBefore: new Date(resumeBeforeMs).toISOString(),
          accountCreatedAt: accountCreatedAt.toISOString(),
        },
      });
    }
  }

  const recordEarningsPartial = async (
    reason: "window_not_honoured" | "saturated_day",
    requested: { afterMs: number; beforeMs: number },
    observationId: number | null,
    scopeRef = "",
  ): Promise<void> => {
    await coverage(CAPTURE_COVERAGE_PLANES.statsEarnings, "partial_provider_surface",
      "terminal_response", {
        scopeRef, replaceWindowBounds: scopeRef === "steady",
        reasonCode: `earnings_${reason}`, proofObservationId: observationId,
        cursor: requested,
      });
    await input.telemetry.addAnomaly({
      code: `fansly_stats_earnings_${reason}`, severity: "warn",
      message: "Fansly earnings window could not be captured completely; other statistics continue",
      details: { ...requested, observationId },
    });
  };

  // ── BACKFILL (first enable) ────────────────────────────────────────────────
  const runBackfill = async (): Promise<StreamChunkResult | null> => {
    if (state.mode !== "backfill" || state.backfill === null) return null;
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
        // THE GAP ABOVE A PROBE THAT FOUND DATA IS WALKED: the probe month
        // itself is already journaled, so step past it. From here the walk is
        // an ordinary one again, with a fresh streak — and its one probe spent.
        const probeHit = backfill.daily.probeHitMonthIndex;
        if (probeHit !== null && monthIndex <= probeHit) {
          backfill.daily.probeHitMonthIndex = null;
          backfill.daily.emptyStreak = 0;
          if (monthIndex === probeHit) {
            backfill.daily.nextMonthIndex = probeHit - 1;
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            continue;
          }
        }
        // Do not spend the probe on a month in which the account did not yet
        // exist. This is a hard, page-local floor already captured from the
        // account response, and it also heals cursors that were previously
        // left retrying the same pre-creation probe every day.
        if (monthPredatesAccountCreation(monthIndex, accountCreatedAt)) {
          backfill.daily.done = true;
          await coverage(
            CAPTURE_COVERAGE_PLANES.statsAccountDaily,
            "provider_exhausted",
            // The floor comes from page metadata rather than this lane's
            // journal, so there is no observation id to claim as lineage.
            "none",
            {
              oldestCapturedAt: backfill.daily.floorAt === null
                ? null
                : new Date(backfill.daily.floorAt),
              newestCapturedAt: now,
              reasonCode: "account_creation_floor",
              cursor: {
                mode: "backfill_month",
                requestedMonth: monthLabel(monthIndex),
                accountCreatedAt: accountCreatedAt!.toISOString(),
              },
            },
          );
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
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
        const monthClass = classifyStatsMonth(response.raw);
        if (monthClass === "invalid") {
          if (backfill.daily.probeResumeMonthIndex !== null) {
            // A malformed answer to the one-off deep probe is evidence only
            // about that probe surface. Retrying it tomorrow cannot advance
            // the walk and was the production hot loop; stop conservatively
            // without converting it into a false empty-window claim.
            backfill.daily.done = true;
            await coverage(
              CAPTURE_COVERAGE_PLANES.statsAccountDaily,
              "partial_provider_surface",
              "terminal_response",
              {
                oldestCapturedAt: backfill.daily.floorAt === null
                  ? null
                  : new Date(backfill.daily.floorAt),
                newestCapturedAt: now,
                proofObservationId: persisted.observationId,
                reasonCode: "probe_response_invalid",
                cursor: {
                  mode: "backfill_month_probe",
                  requestedMonth: monthLabel(monthIndex),
                  resumeMonth: monthLabel(backfill.daily.probeResumeMonthIndex),
                },
              },
            );
            await input.telemetry.addAnomaly({
              code: "fansly_stats_probe_response_invalid",
              severity: "warn",
              message:
                "Fansly stats returned an invalid response to the deep month probe; "
                + "the history walk stopped",
              details: {
                plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
                requestedMonth: monthLabel(monthIndex),
                resumeMonth: monthLabel(backfill.daily.probeResumeMonthIndex),
              },
            });
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            continue;
          }
          backfill.daily.lastMonthIndex = null;
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          throw new FanslyLaneInvalidResponseError("account_stats");
        }

        // A terminal-null month serves no bounds, and no bounds are no
        // contradiction: it reaches the empty-month rules below.
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
        if (monthClass === "empty") {
          const streak = backfill.daily.emptyStreak + 1;
          backfill.daily.emptyStreak = streak;
          if (accountCreatedAt !== null || backfill.daily.probeHitMonthIndex !== null) {
            // EMPTY MONTHS PROVE INACTIVITY, NOT A FLOOR, and here there is a
            // better floor to walk to: the account's own creation month, which
            // `monthPredatesAccountCreation` ends the walk at — or the month a
            // probe already proved has data. No streak ends this walk, and no
            // probe jumps over months it would then have to come back for.
            backfill.daily.nextMonthIndex = monthIndex - 1;
          } else if (streak >= BACKFILL_EMPTY_STREAK_LIMIT && !backfill.daily.probeSpent) {
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
            // the walk will reach the probe month again on its own, and no
            // empty streak in the gap may end it before it does.
            backfill.daily.probeHitMonthIndex = monthIndex;
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
        // Both checks sit between windows only: a window split across chunks
        // (`continue` below) is finished before the walk decides anything.
        if (backfill.earnings.walk === null) {
          // THE GAP ABOVE A PROBE THAT FOUND ROWS IS WALKED: once the next
          // window would reach into the probe's, step past the probe window —
          // it is journaled — with a fresh streak and the one probe spent.
          const probeHitBeforeMs = backfill.earnings.probeHitBeforeMs;
          if (probeHitBeforeMs !== null && backfill.earnings.nextBeforeMs <= probeHitBeforeMs) {
            backfill.earnings.nextBeforeMs = Math.min(
              backfill.earnings.nextBeforeMs,
              (backfill.earnings.probeHitAfterMs ?? probeHitBeforeMs) - 1,
            );
            backfill.earnings.probeHitAfterMs = null;
            backfill.earnings.probeHitBeforeMs = null;
            backfill.earnings.emptyStreak = 0;
          }
          // THE ACCOUNT'S CREATION IS THE FLOOR. Nothing this account earned
          // predates it, so a walk that has passed it is done — the same hard,
          // page-local floor the daily walk stops at, claimed without egress.
          if (
            accountCreatedAt !== null
            && backfill.earnings.nextBeforeMs <= accountCreatedAt.getTime()
          ) {
            backfill.earnings.done = true;
            await coverage(
              CAPTURE_COVERAGE_PLANES.statsEarnings,
              "provider_exhausted",
              // The floor comes from page metadata rather than this lane's
              // journal, so there is no observation id to claim as lineage.
              "none",
              {
                newestCapturedAt: now,
                reasonCode: "account_creation_floor",
                cursor: { accountCreatedAt: accountCreatedAt.toISOString() },
              },
            );
            state = { ...state, backfill: { ...backfill } };
            await saveProgress();
            continue;
          }
        }
        backfill.earnings.walk ??= startEarningsWindow(
          backfill.earnings.nextBeforeMs - earningsGuard.spanDays * DAY_MS,
          backfill.earnings.nextBeforeMs,
        );
        const walk = backfill.earnings.walk;
        const requested = walk.pending.at(-1)!;
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getEarningsStatsWindow(requestContext, {
          before: new Date(requested.beforeMs), after: new Date(requested.afterMs),
          limit: EARNINGS_PAGE_LIMIT,
        });
        const persisted = await persist("earnings_stats_snapshot", {
          mode: "backfill", before: new Date(requested.beforeMs).toISOString(),
          after: new Date(requested.afterMs).toISOString(), limit: EARNINGS_PAGE_LIMIT,
        }, response.raw);
        earningsGuard.lastObservationId = persisted.observationId
          ?? earningsGuard.lastObservationId;
        const result = advanceEarningsWindow(walk, response.raw);
        if (result === "invalid") throw new FanslyLaneInvalidResponseError("earnings_stats_snapshot");
        if (result === "window_not_honoured" || result === "saturated_day") {
          backfill.earnings.done = true;
          await recordEarningsPartial(result, requested, persisted.observationId ?? null);
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        if (result === "continue") {
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        const windowRows = walk.hasRows ? 1 : 0;
        const after = new Date(walk.afterMs);
        backfill.earnings.nextBeforeMs = walk.afterMs - 1;
        backfill.earnings.walk = null;
        if (windowRows === 0) {
          backfill.earnings.emptyStreak += 1;
          // Where the creation date is known, or while the walk is filling the
          // gap above a probe that found rows, an empty window only steps back
          // (`nextBeforeMs` already sits below it): empty windows prove
          // inactivity, and a better floor is ahead.
          const streakMayEnd = accountCreatedAt === null
            && backfill.earnings.probeHitBeforeMs === null;
          if (
            streakMayEnd
            && backfill.earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT
            && !backfill.earnings.probeSpent
          ) {
            // Empty windows prove inactivity, not a retention floor. Bookmark
            // the ordinary walk and spend one probe substantially further
            // back, matching the daily month walk's probe-and-resume rule.
            backfill.earnings.probeSpent = true;
            backfill.earnings.probeResumeBeforeMs = backfill.earnings.nextBeforeMs;
            backfill.earnings.nextBeforeMs -= BACKFILL_PROBE_JUMP_DAYS * DAY_MS;
          } else if (
            streakMayEnd && backfill.earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT
          ) {
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
            // The probe PROVED older earnings: resume at the gap it jumped,
            // remembering the probe window so the walk steps past it — and no
            // empty streak ends the walk — once it gets there.
            backfill.earnings.probeHitAfterMs = walk.afterMs;
            backfill.earnings.probeHitBeforeMs = walk.beforeMs;
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
          hourly,
        },
      };
    }
    return null;
  };

  /**
   * One page of a broadcast list's `before` walk — the live list at step 6, the
   * deleted list at step 7 — journaled BEFORE the walk moves. A walk that ends
   * on anything but an empty page says so once, as an anomaly.
   */
  const readBroadcastPage = async (
    context: typeof requestContext,
    kind: "broadcast_stats" | "broadcast_stats_deleted",
    walk: BroadcastWalk,
  ) => {
    const before = walk.floorReached ? null : walk.before;
    const response = await app.adapter.getBroadcastStatsPage(context, {
      before,
      limit: null,
      deleted: kind === "broadcast_stats_deleted",
    });
    await persist(kind, {
      before,
      walk: walk.floorReached ? "head" : "first_enable_backfill",
    }, response.raw);
    const next = advanceBroadcastWalk(walk, response.raw);
    if (next.stop !== null && next.stop !== "empty_page") {
      await input.telemetry.addAnomaly({
        code: "fansly_stats_broadcast_walk_stopped",
        severity: "warn",
        message:
          "A Fansly broadcast history walk stopped on something other than an empty page; "
          + "the list is treated as read to its floor",
        details: { kind, stop: next.stop, before },
      });
    }
    return next;
  };

  // ── THE HOURLY PLANE, ON ITS OWN CLOCK ────────────────────────────────────
  //
  // The route serves hourly buckets ONLY inside its trailing 25 h, so an hour
  // no capture's window reached is gone for good. Bound to the once-per-UTC-day
  // sweep, the capture lost hours whenever a sweep ran EARLY — a 00:05
  // continuation after a cap deferral, a deploy, a manual run — and the next
  // day's ran on its slot: 28.9 h apart, 3.9 h lost. Production, 31 days to
  // 2026-09-29: lilly-2 123.9 h, lora-2 22.0 h, lora-3 4.5 h, lilly-1 1.7 h.
  // And where a served window ends moves by up to 2 h from call to call, so
  // captures a day apart can still miss a bucket (HOURLY_CAPTURE_SPACING_MS).
  //
  // So every dispatch asks whether the NEXT dispatch this lane can count on
  // would put two captures more than 23 h apart, and captures only then: on
  // 6-hourly slots every third slot, 18 h apart, whenever the sweep itself
  // runs — one call more every three days than a once-a-day capture. It runs
  // FIRST because it is the one call here whose delay loses data; it spends
  // the same daily cap as everything else.

  /** Takes the trailing hourly window now: journaled before parsing, the
   *  steady row moved onto it, and any hole since the last capture recorded. */
  const captureHourly = async () => {
    await assertOwnedPageSyncLease(app.db);
    const beforeDate = now;
    const afterDate = new Date(now.getTime() - HOURLY_WINDOW_MS);
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
    const served = servedWindow(response.raw);
    await coverage(
      CAPTURE_COVERAGE_PLANES.statsAccountHourly,
      "window_captured",
      "none",
      {
        scopeRef: "steady", replaceWindowBounds: true,
        oldestCapturedAt: new Date(served.afterMs ?? afterDate.getTime()),
        newestCapturedAt: new Date(served.beforeMs ?? now.getTime()),
        proofObservationId: persisted.observationId,
      },
    );
    // The steady row describes the latest window and nothing before it, so a
    // hole between two windows is written down where it stays: its own row,
    // never overwritten, plus one anomaly on the run that found it.
    const lastCapturedMs = state.lastHourlyCapturedAt === null
      ? null
      : Date.parse(state.lastHourlyCapturedAt);
    const hole = hourlyCaptureGap(
      lastCapturedMs === null ? null : {
        capturedMs: lastCapturedMs,
        servedBeforeMs: state.lastHourlyServedBefore === null
          ? null
          : Date.parse(state.lastHourlyServedBefore),
      },
      { capturedMs: now.getTime(), servedAfterMs: served.afterMs },
    );
    if (hole !== null) {
      const missingFrom = new Date(hole.fromMs).toISOString();
      const missingTo = new Date(hole.toMs).toISOString();
      const missingHours = Math.round((hole.toMs - hole.fromMs) / HOUR_MS * 10) / 10;
      const holeDetails = {
        missingFrom,
        missingTo,
        missingHours,
        basis: hole.basis,
        previousCapturedAt: state.lastHourlyCapturedAt,
        capturedAt: now.toISOString(),
      };
      await coverage(
        CAPTURE_COVERAGE_PLANES.statsAccountHourly,
        // Bounded by the PROVIDER's surface, like the plane's history row:
        // these buckets now lie outside every window the route serves. The
        // bounds stay null — a hole is not a captured window.
        "partial_provider_surface",
        "none",
        {
          scopeRef: `gap:${missingFrom}/${missingTo}`,
          reasonCode: "hourly_capture_gap",
          proofObservationId: persisted.observationId,
          cursor: holeDetails,
        },
      );
      await input.telemetry.addAnomaly({
        code: "fansly_stats_hourly_capture_gap",
        severity: "warn",
        message:
          "Fansly hourly statistics: no captured window carries the hours between two "
          + "captures, and they are not recoverable",
        details: holeDetails,
      });
    }
    state = {
      ...state,
      lastHourlyCapturedAt: now.toISOString(),
      lastHourlyServedBefore: served.beforeMs === null
        ? null
        : new Date(served.beforeMs).toISOString(),
    };
    await saveProgress();
    hourly = "captured";
  };

  const today = utcDayKey(now);
  const sweepDoneToday =
    state.lastSweepDay === today && state.stepIndex === 0 && state.sweepDay === null;
  /** Today's sweep keeps the cap's last call for the hourly window: it spends
   *  that call on the window if it defers the lane to 00:05 (the sweep loop). */
  let hourlyHoldsCall = false;
  if (hourlyEnabled) {
    if (state.lastHourlyCapturedAt === null) {
      // A cursor from before these fields. The steady row is written by the
      // capture itself, so its write time IS the last capture's and its newest
      // bound that capture's served `dateBefore`; with no row there is nothing
      // to wait for.
      const steadyRow = (await listCaptureCoverage(app.db, {
        pageId,
        plane: CAPTURE_COVERAGE_PLANES.statsAccountHourly,
      })).find((row) => row.scopeRef === "steady");
      if (steadyRow !== undefined) {
        state = {
          ...state,
          lastHourlyCapturedAt: steadyRow.updatedAt.toISOString(),
          lastHourlyServedBefore: steadyRow.newestCapturedAt?.toISOString() ?? null,
        };
      }
    }
    const lastCapturedMs = state.lastHourlyCapturedAt === null
      ? null
      : Date.parse(state.lastHourlyCapturedAt);
    const nextDayStartMs = nextFanslyUtcDayStart(now).getTime();
    // A slot is at most one cadence away — unless a history walk is open. A
    // walk spends whatever cap the day has left and defers the lane to 00:05,
    // and no slot dispatches a lane while its deferral is pending (production
    // 2026-09-28: walks deferred at 23:02, next dispatch 00:05).
    const nextDispatchByMs = Math.max(
      now.getTime() + STATS_CADENCE_MS,
      state.mode === "backfill" && state.backfill !== null ? nextDayStartMs : 0,
    );
    if (!hourlyCaptureDue(lastCapturedMs, now.getTime(), nextDispatchByMs)) {
      hourly = "not_due";
      // Today's sweep can defer the lane to 00:05 as well, but rarely
      // (production: once in 35 days). Asked against 00:05 up front, the
      // window would be due on every day's first chunk — a second call a day —
      // so the sweep holds a call back for it instead.
      hourlyHoldsCall = !sweepDoneToday
        && hourlyCaptureDue(lastCapturedMs, now.getTime(), nextDayStartMs);
    } else if (
      !hasDayCapacity()
      || !input.budget.hasRequestCapacity(1)
      || !input.budget.hasWallClockCapacity()
    ) {
      hourly = "deferred";
    } else {
      await captureHourly();
    }
  }

  // ── STEADY DAILY SWEEP ────────────────────────────────────────────────────
  if (sweepDoneToday) {
    const pendingHistory = await runBackfill();
    if (pendingHistory !== null) return pendingHistory;
    if (hourly === "deferred") {
      // The hourly window is due and this chunk could not take it: it never
      // completes over it. The day's cap spent, DEFER as the sweep does, so
      // the window is captured at the UTC roll rather than at whichever slot
      // comes after it. This chunk's own requests or wall clock spent (loading
      // can eat the 45 s), YIELD for the continuation the executor chains at
      // once.
      const capSpent = !hasDayCapacity();
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: capSpent ? null : input.budget.resolveYieldReason(1),
        ...(capSpent ? { continuationRetryAt: nextFanslyUtcDayStart(now) } : {}),
        stats: {
          mode: "steady",
          journaled,
          callsToday: state.callsToday,
          dailyCap,
          deferred: capSpent ? "daily_call_budget" : null,
          hourly,
        },
      };
    }
    await completeLane(input.syncRunId);
    return {
      satisfied: true,
      yieldReason: null,
      stats: { skipped: "sweep_not_due", lastSweepDay: state.lastSweepDay, hourly },
    };
  }

  // The held call is out of the sweep's reach altogether: out of the capacity
  // it checks before a step, and out of the allowance the adapter reads for
  // retries and the admission of every attempt. A retry that spent it would
  // leave the lane deferring to 00:05 without the window.
  const sweep = holdingBack(hourlyHoldsCall ? 1 : 0);
  while (input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()) {
    if (!sweep.hasCapacity()) {
      if (hourlyHoldsCall && hasDayCapacity()) {
        // The call held back for the hourly window: the lane now sleeps until
        // 00:05, more than 23 h after the last capture, so the window goes
        // before it does.
        await captureHourly();
      }
      // DEFER, never drop. The step index is durable, so tomorrow resumes here.
      deferred = "daily_call_budget";
      break;
    }
    await assertOwnedPageSyncLease(app.db);
    if (state.sweepDay === null) {
      // Bind the sweep to the day on which its first executable step starts.
      // The binding survives midnight; completion below stamps THIS day, not
      // whatever day the tail happens to finish on.
      state = { ...state, sweepDay: today };
    }

    if (state.stepIndex === 0) {
      const beforeDate = now;
      const afterDate = new Date(now.getTime() - DAILY_TRAILING_DAYS * DAY_MS);
      const response = await app.adapter.getAccountStats(sweep.requestContext, {
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
          scopeRef: "steady", replaceWindowBounds: true,
          oldestCapturedAt: new Date(servedWindow(response.raw).afterMs ?? afterDate.getTime()),
          newestCapturedAt: new Date(servedWindow(response.raw).beforeMs ?? now.getTime()),
          proofObservationId: persisted.observationId,
        },
      );
      state = { ...state, stepIndex: 1 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 1) {
      // The hourly capture left the sweep for its own clock (above). The step
      // stays, empty, so a cursor saved here by an older image still resumes.
      state = { ...state, stepIndex: 2 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 2) {
      state.earningsWalk ??= startEarningsWindow(
        now.getTime() - EARNINGS_TRAILING_DAYS * DAY_MS, now.getTime(),
      );
      const walk = state.earningsWalk;
      const requested = walk.pending.at(-1)!;
      const response = await app.adapter.getEarningsStatsWindow(sweep.requestContext, {
        before: new Date(requested.beforeMs), after: new Date(requested.afterMs),
        limit: EARNINGS_PAGE_LIMIT,
      });
      const persisted = await persist("earnings_stats_snapshot", {
        mode: "steady", before: new Date(requested.beforeMs).toISOString(),
        after: new Date(requested.afterMs).toISOString(), limit: EARNINGS_PAGE_LIMIT,
      }, response.raw);
      const result = advanceEarningsWindow(walk, response.raw);
      if (result === "invalid") throw new FanslyLaneInvalidResponseError("earnings_stats_snapshot");
      if (result === "window_not_honoured" || result === "saturated_day") {
        await recordEarningsPartial(result, requested, persisted.observationId ?? null, "steady");
      }
      if (result === "complete") {
        await coverage(CAPTURE_COVERAGE_PLANES.statsEarnings, "window_captured", "none", {
          scopeRef: "steady", replaceWindowBounds: true,
          oldestCapturedAt: new Date(walk.afterMs), newestCapturedAt: new Date(walk.beforeMs),
          proofObservationId: persisted.observationId, reasonCode: "trailing_window_captured",
          cursor: { afterMs: walk.afterMs, beforeMs: walk.beforeMs },
        });
      }
      if (result !== "continue") state = { ...state, stepIndex: 3, earningsWalk: null };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 3) {
      // All-time in one call. `after` is set below any plausible account
      // creation date rather than left off: the observed live call carried both
      // bounds, and an unbounded form has never been seen answering.
      const response = await app.adapter.getEarningsMonthlyStats(sweep.requestContext, {
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
      const response = await app.adapter.getTrackingLinks(sweep.requestContext);
      await persist("tracking_links", {}, response.raw);
      state = { ...state, stepIndex: 5 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 5) {
      const page = state.discoveryPage;
      const response = await app.adapter.getDiscoveryMediaSuggestions(sweep.requestContext, {
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
      const next = await readBroadcastPage(sweep.requestContext, "broadcast_stats", {
        before: state.broadcastBefore,
        floorReached: state.broadcastFloorReached,
        pagesInSweep: state.broadcastPagesInSweep,
      });
      state = {
        ...state,
        broadcastBefore: next.walk.before,
        broadcastFloorReached: next.walk.floorReached,
        broadcastPagesInSweep: next.walk.pagesInSweep,
        broadcastWalkStop: next.stop ?? state.broadcastWalkStop,
        stepIndex: next.stepDone ? 7 : 6,
      };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 7) {
      // The DELETED list is paged the same way and walked the same way: a
      // withdrawn broadcast and its sales exist nowhere else, and its head
      // holds only the newest page of them.
      const next = await readBroadcastPage(sweep.requestContext, "broadcast_stats_deleted", {
        before: state.deletedBroadcastBefore,
        floorReached: state.deletedBroadcastFloorReached,
        pagesInSweep: state.deletedBroadcastPagesInSweep,
      });
      state = {
        ...state,
        deletedBroadcastBefore: next.walk.before,
        deletedBroadcastFloorReached: next.walk.floorReached,
        deletedBroadcastPagesInSweep: next.walk.pagesInSweep,
        deletedBroadcastWalkStop: next.stop ?? state.deletedBroadcastWalkStop,
        stepIndex: next.stepDone ? 8 : 7,
      };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 8) {
      const response = await app.adapter.getBroadcastScheduled(sweep.requestContext);
      await persist("broadcast_scheduled", {}, response.raw);
      state = { ...state, stepIndex: 9 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === 9) {
      const response = await app.adapter.getPolls(sweep.requestContext);
      await persist("polls", {}, response.raw);
      state = { ...state, stepIndex: 10 };
      await saveProgress();
      continue;
    }

    if (state.stepIndex === LAST_SWEEP_STEP) {
      const response = await app.adapter.getRecapStats(sweep.requestContext);
      await persist("recapstats", {}, response.raw);
      const completedSweepDay = state.sweepDay ?? today;
      state = {
        ...state,
        stepIndex: 0,
        lastSweepDay: completedSweepDay,
        sweepDay: null,
      };
      if (completedSweepDay === today) {
        await saveProgress();
        const pendingHistory = await runBackfill();
        if (pendingHistory !== null) return pendingHistory;
        await completeLane(input.syncRunId);
        return {
          satisfied: true,
          yieldReason: null,
          stats: { mode: "steady", journaled, callsToday: state.callsToday, dailyCap, hourly },
        };
      }
      // Yesterday's tail is complete, but today's sweep is still due. Keep the
      // same chunk moving when it has room; otherwise the durable step-0 cursor
      // makes the next chunk start at the current head instead of skipping it.
      await saveProgress();
      continue;
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
      hourly,
    },
  };
}

// ── the broadcast walks (steps 6 and 7) ──────────────────────────────────────

/**
 * Why a broadcast list's `before` walk reached its floor. Only `empty_page` is
 * the provider saying so; the others end the walk rather than repeat it, and
 * raise an anomaly so they cannot pass for a real floor.
 */
export type BroadcastWalkStop =
  | "empty_page"
  | "no_row_ids"
  | "cursor_not_advancing"
  | "malformed_shape";

const BROADCAST_WALK_STOPS: ReadonlySet<string> = new Set<BroadcastWalkStop>([
  "empty_page",
  "no_row_ids",
  "cursor_not_advancing",
  "malformed_shape",
]);

function parseBroadcastWalkStop(value: unknown): BroadcastWalkStop | null {
  return typeof value === "string" && BROADCAST_WALK_STOPS.has(value)
    ? value as BroadcastWalkStop
    : null;
}

/** One broadcast list's walk, as the cursor keeps it. */
export interface BroadcastWalk {
  before: string | null;
  floorReached: boolean;
  pagesInSweep: number;
}

/**
 * The `messages[]` of one broadcast-stats page, BY NAME, or null when the body
 * carries none. The body also carries `accountMedia`, `accountMediaBundles`,
 * `tipGoals` and `tips` sidecars, so its first array is not the page: an empty
 * sidecar ahead of a full page of broadcasts would read as the floor.
 */
export function broadcastMessageRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  return record !== null && Array.isArray(record.messages) ? record.messages : null;
}

/**
 * One page of a broadcast `before` walk, folded into the walk.
 *
 * At the floor only the head is polled and the step is done. Otherwise an
 * empty page is the floor, a page whose oldest id is missing or does not move
 * the cursor ends the walk rather than repeating it, and the walk is BOUNDED
 * PER SWEEP: without that the first-enable walk would hold the sweep on this
 * step until the whole history was read — and `lastSweepDay` only advances at
 * the last step, so the DAILY traffic capture behind it would stall for as
 * many days as the walk took. Three pages a day finishes any realistic history
 * in under a fortnight and never blocks the head poll.
 */
export function advanceBroadcastWalk(
  walk: BroadcastWalk,
  payload: unknown,
  pagesPerSweep = BROADCAST_BACKFILL_PAGES_PER_SWEEP,
): { walk: BroadcastWalk; stepDone: boolean; stop: BroadcastWalkStop | null } {
  if (walk.floorReached) {
    return { walk: { ...walk, pagesInSweep: 0 }, stepDone: true, stop: null };
  }
  const floor = (stop: BroadcastWalkStop) => ({
    walk: { before: null, floorReached: true, pagesInSweep: 0 },
    stepDone: true,
    stop,
  });
  const rows = broadcastMessageRows(payload);
  if (rows === null) {
    return floor("malformed_shape");
  }
  if (rows.length === 0) {
    return floor("empty_page");
  }
  const nextBefore = oldestBroadcastRef(payload);
  if (nextBefore === null) {
    return floor("no_row_ids");
  }
  // A cursor that does not advance is a walk that would never end.
  if (nextBefore === walk.before) {
    return floor("cursor_not_advancing");
  }
  const pagesInSweep = walk.pagesInSweep + 1;
  return pagesInSweep >= pagesPerSweep
    ? { walk: { before: nextBefore, floorReached: false, pagesInSweep: 0 }, stepDone: true, stop: null }
    : { walk: { before: nextBefore, floorReached: false, pagesInSweep }, stepDone: false, stop: null };
}

/** The `before` cursor for the next broadcast page: the oldest id this page
 *  served. Returns null when the shape carries none — which ends the walk
 *  rather than repeating it. */
function oldestBroadcastRef(payload: unknown): string | null {
  let oldest: string | null = null;
  for (const row of broadcastMessageRows(payload) ?? []) {
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
