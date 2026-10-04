import {
  fanslyStatsDatasetHasDatapointArrays,
  isExactTerminalNullAccountStatsPayload,
} from "../../../services/canonicalize/fansly-stats.ts";
import { parseEarningsWindow, type EarningsWindowWalk } from "./earnings-window.ts";
import { classifyFanslyResponse, fanslyUtcDayKey, type FanslyResponseClass } from "./lane.ts";

// The account-statistics rules of the Sync Engine's `stats.*` resources
// (resources/stats.ts): the `stats_snapshot` cursor with its backfill walks'
// durable state, the served-window and month checks, the hourly plane's gap
// and the broadcast walks. The per-media rules share the window guard and the
// window classifier (media-stats-rules.ts). Pure.

/** Stamped on every `fansly-stats` family capture (this lane and the media
 *  stats lane); the Fansly Sync Engine's capture helper reports the same. */
export const FANSLY_STATS_MAPPER_VERSION = "fansly-stats-v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The hourly period `account_stats` is polled at. */
const HOURLY_PERIOD_MS = 3_600_000;

/** The steady-state trailing windows. Fansly restates recent buckets, so the
 *  30-day daily window is re-compared every day; unchanged buckets dedup to
 *  zero events, which is exactly the granularity D-1 was chosen for. */
export const DAILY_TRAILING_DAYS = 30;
export const HOURLY_TRAILING_HOURS = 25;
/** The route serves hourly buckets only inside this window, so two hourly
 *  captures further apart than it leave hours that no window will reach again. */
const HOURLY_WINDOW_MS = HOURLY_TRAILING_HOURS * HOUR_MS;
/** The furthest apart two hourly captures may be. A served window is 25
 *  buckets, dateAfter to dateBefore inclusive, and ends 0–2 h short of the
 *  hour asked for, varying from call to call (production 2026-09). Two windows
 *  whose request hours are Δ apart meet while Δ ≤ 25 h − (older lag − newer
 *  lag): a day apart, a lag going 2 h -> 0 h leaves one bucket in neither; at
 *  23 h they meet even then. */
export const HOURLY_CAPTURE_SPACING_MS = 23 * HOUR_MS;

export const EARNINGS_TRAILING_DAYS = 30;

export const DISCOVERY_PAGE_LIMIT = 10;
export const DISCOVERY_PAGES_PER_SWEEP = 2;

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
export const MONTH_FORM_TRAILING_DAYS = 30;
/** Two consecutive empty MONTHS, then ONE probe this many months further back —
 *  [E10] in the unit this walk actually steps in. Only where the account's
 *  creation date is unknown: a known one is the floor, and nothing is probed. */
export const BACKFILL_PROBE_JUMP_MONTHS = 12;
export const BACKFILL_PROBE_JUMP_DAYS = 365;
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
export const BACKFILL_EMPTY_STREAK_LIMIT = 2;
/** Pages of mass-DM history each first-enable walk (live, deleted) takes per
 *  daily sweep. */
const BROADCAST_BACKFILL_PAGES_PER_SWEEP = 3;
/** `recapstats` — the step that completes the sweep and stamps `lastSweepDay`. */
export const LAST_SWEEP_STEP = 10;

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

export interface DailyBackfillState {
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

export interface EarningsBackfillState {
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

export function parseDailyBackfill(value: unknown, now: Date): DailyBackfillState {
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

export function parseEarningsBackfill(value: unknown, now: Date): EarningsBackfillState {
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

export function emptyDailyBackfill(now: Date): DailyBackfillState {
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
export function emptyEarningsBackfill(nextBeforeMs: number, done: boolean): EarningsBackfillState {
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

export function emptyFanslyStatsCursorState(now: Date): FanslyStatsCursorState {
  return {
    version: 2,
    // History remains resumable background work. Each day's fresh sweep gets
    // first use of the same physical-attempt budget, including on first enable.
    mode: "backfill",
    utcDay: fanslyUtcDayKey(now),
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

// ── the hourly plane's clock ─────────────────────────────────────────────────

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
