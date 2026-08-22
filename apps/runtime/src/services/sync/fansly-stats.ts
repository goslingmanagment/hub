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
// THE BACKFILL, and the one thing about it that is not obvious: each next
// window is derived from the RETURNED `dateAfter`/`dateBefore`, not from the
// bounds we asked for. The provider snaps windows to its own bucket grid, so
// asking for [t-30d, t] and then walking back 30 d from OUR t would drift a
// bucket per chunk and silently leave holes. It stops after two consecutive
// all-empty windows PLUS one extra probe window about a year further back — an
// empty window on a long-idle account proves inactivity, not a retention floor
// ([E10]) — and it journals every empty response, because an empty window IS
// the floor evidence.
//
// BURST SHAPE, not daily volume, is the real ban-risk surface: a chunk spends
// its 5 requests in ~13 s and is re-queued immediately, so a deep walk would
// otherwise run contiguously at ~23 req/min for as long as it has work. Backfill
// continuations therefore carry `fanslyBackfillContinuationDelayMs` ± 30 %
// jitter. Steady-state sweeps keep immediate continuation.

import {
  assertOwnedPageSyncLease,
  getCheckpoint,
  upsertCaptureCoverage,
  upsertCheckpoint,
  upsertCheckpointProgress,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
} from "@agency_hub_core/db";
import type { HttpRequestEvent, HttpRequestObserver } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { createSyncRateLimitWaiter } from "./rate-limiter.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

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

/** `datapointLimit` came back 100, so a daily backfill window is at most 100
 *  buckets. One day of OVERLAP between adjacent windows is what lets the
 *  contiguity assertion below have something to check. */
const BACKFILL_DAILY_WINDOW_DAYS = 100;
const BACKFILL_DAILY_OVERLAP_DAYS = 1;
const BACKFILL_HOURLY_STEP_DAYS = 4;
const BACKFILL_EARNINGS_WINDOW_DAYS = 100;
/** Two consecutive empty windows, then ONE probe this far further back. */
const BACKFILL_EMPTY_STREAK_LIMIT = 2;
const BACKFILL_PROBE_JUMP_DAYS = 365;
const BACKFILL_JITTER_FRACTION = 0.3;
/** Pages of mass-DM history the first-enable walk takes per daily sweep. */
const BROADCAST_BACKFILL_PAGES_PER_SWEEP = 3;

export const FANSLY_STATS_COVERAGE_PLANES = {
  accountDaily: "stats_account_daily",
  accountHourly: "stats_account_hourly",
  earnings: "stats_earnings",
} as const;

// ── cursor state ─────────────────────────────────────────────────────────────

interface DailyBackfillState {
  /** Exclusive upper bound of the NEXT window, in epoch ms. */
  nextBeforeMs: number;
  emptyStreak: number;
  /** The one extra probe window ~1 year further back has been spent. */
  probeSpent: boolean;
  done: boolean;
  /** ISO instant of the oldest bucket the provider ever served. */
  floorAt: string | null;
}

interface HourlyBackfillState {
  nextBeforeMs: number;
  daysWalked: number;
  done: boolean;
}

interface EarningsBackfillState {
  nextBeforeMs: number;
  emptyStreak: number;
  done: boolean;
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

function parseDailyBackfill(value: unknown, now: Date): DailyBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    emptyStreak: asInt(record?.emptyStreak, 0),
    probeSpent: record?.probeSpent === true,
    done: record?.done === true,
    floorAt: asNullableString(record?.floorAt),
  };
}

function parseHourlyBackfill(value: unknown, now: Date): HourlyBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    daysWalked: asInt(record?.daysWalked, 0),
    done: record?.done === true,
  };
}

function parseEarningsBackfill(value: unknown, now: Date): EarningsBackfillState {
  const record = asRecord(value);
  return {
    nextBeforeMs: asInt(record?.nextBeforeMs, now.getTime()),
    emptyStreak: asInt(record?.emptyStreak, 0),
    done: record?.done === true,
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
    stepIndex: Math.max(0, asInt(state.stepIndex, 0)),
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

export function emptyFanslyStatsCursorState(now: Date): FanslyStatsCursorState {
  return {
    version: 1,
    // FIRST ENABLE walks history before it settles into the daily sweep. That
    // is the only chance to reach the provider's floor cheaply — ten years of
    // daily buckets is ~37 calls.
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
      daily: {
        nextBeforeMs: now.getTime(),
        emptyStreak: 0,
        probeSpent: false,
        done: false,
        floorAt: null,
      },
      hourly: { nextBeforeMs: now.getTime(), daysWalked: 0, done: false },
      earnings: { nextBeforeMs: now.getTime(), emptyStreak: 0, done: false },
    },
  };
}

export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** A new UTC day resets the attempt counter. Nothing else about the cursor
 *  changes: a sweep that deferred mid-step resumes at exactly that step. */
export function rollUtcDay(
  state: FanslyStatsCursorState,
  now: Date,
): FanslyStatsCursorState {
  const today = utcDayKey(now);
  return state.utcDay === today ? state : { ...state, utcDay: today, callsToday: 0 };
}

// ── attempt counting ─────────────────────────────────────────────────────────

/**
 * Counts HTTP ATTEMPTS, retries included — the unit the cap is enforced in.
 *
 * `SyncChunkBudget` counts the same events but is scoped to one chunk; the day
 * counter has to survive across chunks, leases and restarts, which is why it
 * lives in the cursor and is fed from here.
 */
class AttemptCounter implements HttpRequestObserver {
  private attempts = 0;

  async onRequestEvent(event: HttpRequestEvent) {
    if (event.state === "started") {
      this.attempts += 1;
    }
  }

  /** Read and reset — the caller folds the delta into `callsToday`. */
  take(): number {
    const attempts = this.attempts;
    this.attempts = 0;
    return attempts;
  }
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

function statsDataset(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  return record === null ? null : asRecord(record.dataset);
}

/** True when the response carried no datapoints at all — the empty-window
 *  signal the backfill's stop rule reads. Journaled either way: an empty
 *  window IS the retention-floor evidence. */
function isEmptyStatsWindow(payload: unknown): boolean {
  const dataset = statsDataset(payload);
  if (dataset === null) {
    return true;
  }
  const datapoints = Array.isArray(dataset.datapoints) ? dataset.datapoints : [];
  const profile = Array.isArray(dataset.profileDatapoints) ? dataset.profileDatapoints : [];
  return datapoints.length === 0 && profile.length === 0;
}

/** The provider's OWN returned bounds. The next window is derived from these,
 *  never from what we asked for (§7) — the provider snaps to its bucket grid
 *  and a self-derived walk would drift a bucket per chunk. */
function servedWindow(payload: unknown): { afterMs: number | null; beforeMs: number | null } {
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

function rowCount(payload: unknown): number {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  const record = asRecord(payload);
  if (record === null) {
    return 0;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return 0;
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
  const jitter = 1 + (random() * 2 - 1) * BACKFILL_JITTER_FRACTION;
  return new Date(now.getTime() + Math.max(0, Math.round(delayMs * jitter)));
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

  const attempts = new AttemptCounter();
  const requestContext = {
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    requestObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
      attempts,
    ),
    rateLimitWaiter: createSyncRateLimitWaiter(app, input.pageContext),
  };

  let journaled = 0;
  let deferred: string | null = null;

  const persist = async (
    kind: string,
    requestParams: Record<string, unknown>,
    payload: unknown,
  ) => {
    // Journal FIRST, always. Everything after this line — the shape reads, the
    // cap check, the cursor advance — happens with the bytes already durable.
    const result = await persistRawPayload(app.db, {
      platformAccountId: pageId,
      syncRunId: input.syncRunId,
      endpoint: kind,
      requestParams,
      responsePayload: payload,
      mapperVersion: MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: `inserting Fansly ${kind} raw payload`,
      platform: "fansly",
    });
    journaled += 1;
    // The cap is counted in ATTEMPTS, folded in AFTER the response is safe.
    state = { ...state, callsToday: state.callsToday + attempts.take() };
    return result;
  };

  /** Room for one more call today? The chunk budget is the per-chunk guard;
   *  this is the per-DAY one, and crossing it defers rather than fails. */
  const hasDayCapacity = () => state.callsToday < dailyCap;

  const saveProgress = async () => {
    const advanced = await upsertCheckpointProgress(app.db, {
      platformAccountId: pageId,
      stream: STREAM,
      cursorText: state.lastSweepDay,
      state: { ...state } as unknown as Record<string, unknown>,
    });
    await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(advanced));
  };

  const coverage = async (
    plane: string,
    status: CaptureCoverageStatus,
    proof: CaptureCoverageProof,
    extra: {
      oldestCapturedAt?: Date | null;
      newestCapturedAt?: Date | null;
      proofObservationId?: number | null;
      reasonCode?: string | null;
      cursor?: Record<string, unknown>;
    } = {},
  ) => {
    await upsertCaptureCoverage(app.db, {
      pageId,
      platform: "fansly",
      plane,
      scopeRef: "",
      status,
      // Statistics windows are addressable backwards in time, so this lane is
      // RETROACTIVE: what it has not captured yet, it still can.
      acquisitionMode: "retroactive",
      proof,
      ...extra,
    });
  };

  // ── BACKFILL (first enable) ────────────────────────────────────────────────
  if (state.mode === "backfill" && state.backfill !== null) {
    const backfill = state.backfill;

    while (
      input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
      && hasDayCapacity()
    ) {
      if (!backfill.daily.done) {
        const beforeDate = new Date(backfill.daily.nextBeforeMs);
        const afterDate = new Date(
          backfill.daily.nextBeforeMs - BACKFILL_DAILY_WINDOW_DAYS * DAY_MS,
        );
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

        const served = servedWindow(response.raw);
        const empty = isEmptyStatsWindow(response.raw);
        if (empty) {
          const streak = backfill.daily.emptyStreak + 1;
          if (streak >= BACKFILL_EMPTY_STREAK_LIMIT && !backfill.daily.probeSpent) {
            // [E10]: an empty window on a long-idle account proves INACTIVITY,
            // not a retention floor. Spend one probe a year further back before
            // calling it a floor.
            backfill.daily.emptyStreak = streak;
            backfill.daily.probeSpent = true;
            backfill.daily.nextBeforeMs -= BACKFILL_PROBE_JUMP_DAYS * DAY_MS;
          } else if (streak >= BACKFILL_EMPTY_STREAK_LIMIT) {
            backfill.daily.emptyStreak = streak;
            backfill.daily.done = true;
            // The empty response IS the proof, and it is journaled: the
            // coverage row points at the observation rather than restating it.
            await coverage(
              FANSLY_STATS_COVERAGE_PLANES.accountDaily,
              "provider_exhausted",
              "empty_window",
              {
                oldestCapturedAt: backfill.daily.floorAt === null
                  ? null
                  : new Date(backfill.daily.floorAt),
                proofObservationId: persisted.observationId,
                reasonCode: "empty_window_streak",
                cursor: { nextBeforeMs: backfill.daily.nextBeforeMs },
              },
            );
          } else {
            backfill.daily.emptyStreak = streak;
            backfill.daily.nextBeforeMs -= BACKFILL_DAILY_WINDOW_DAYS * DAY_MS;
          }
        } else {
          backfill.daily.emptyStreak = 0;
          if (served.afterMs !== null) {
            // DERIVED FROM THE RETURNED BOUNDS, with one day of overlap.
            backfill.daily.nextBeforeMs = served.afterMs + BACKFILL_DAILY_OVERLAP_DAYS * DAY_MS;
            backfill.daily.floorAt = new Date(served.afterMs).toISOString();
          } else {
            backfill.daily.nextBeforeMs -= BACKFILL_DAILY_WINDOW_DAYS * DAY_MS;
          }
          await coverage(
            FANSLY_STATS_COVERAGE_PLANES.accountDaily,
            "in_progress",
            "none",
            {
              oldestCapturedAt: backfill.daily.floorAt === null
                ? null
                : new Date(backfill.daily.floorAt),
              newestCapturedAt: now,
              cursor: { nextBeforeMs: backfill.daily.nextBeforeMs },
            },
          );
        }
        state = { ...state, backfill: { ...backfill } };
        await saveProgress();
        continue;
      }

      if (hourlyEnabled && !backfill.hourly.done) {
        if (backfill.hourly.daysWalked >= hourlyBackfillMaxDays) {
          backfill.hourly.done = true;
          await coverage(
            FANSLY_STATS_COVERAGE_PLANES.accountHourly,
            // Bounded BY US, not by the platform: the honest status is that we
            // captured part of the surface, with a config value as the reason.
            "partial_provider_surface",
            "none",
            { reasonCode: "hourly_backfill_max_days", newestCapturedAt: now },
          );
          state = { ...state, backfill: { ...backfill } };
          await saveProgress();
          continue;
        }
        const beforeDate = new Date(backfill.hourly.nextBeforeMs);
        const afterDate = new Date(
          backfill.hourly.nextBeforeMs - BACKFILL_HOURLY_STEP_DAYS * DAY_MS,
        );
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getAccountStats(requestContext, {
          beforeDate,
          afterDate,
          periodMs: HOURLY_PERIOD_MS,
        });
        await persist("account_stats", {
          mode: "backfill_hourly",
          periodMs: HOURLY_PERIOD_MS,
          beforeDate: beforeDate.toISOString(),
          afterDate: afterDate.toISOString(),
        }, response.raw);
        const served = servedWindow(response.raw);
        backfill.hourly.nextBeforeMs = served.afterMs ?? afterDate.getTime();
        backfill.hourly.daysWalked += BACKFILL_HOURLY_STEP_DAYS;
        if (isEmptyStatsWindow(response.raw)) {
          backfill.hourly.done = true;
        }
        state = { ...state, backfill: { ...backfill } };
        await saveProgress();
        continue;
      }
      if (!hourlyEnabled) {
        backfill.hourly.done = true;
      }

      if (!backfill.earnings.done) {
        const before = new Date(backfill.earnings.nextBeforeMs);
        const after = new Date(
          backfill.earnings.nextBeforeMs - BACKFILL_EARNINGS_WINDOW_DAYS * DAY_MS,
        );
        await assertOwnedPageSyncLease(app.db);
        const response = await app.adapter.getEarningsStatsWindow(requestContext, {
          before,
          after,
          limit: EARNINGS_PAGE_LIMIT,
          offset: 0,
        });
        const persisted = await persist("earnings_stats_snapshot", {
          mode: "backfill",
          before: before.toISOString(),
          after: after.toISOString(),
          limit: EARNINGS_PAGE_LIMIT,
          offset: 0,
        }, response.raw);
        const rows = rowCount(response.raw);
        backfill.earnings.nextBeforeMs = after.getTime();
        if (rows === 0) {
          backfill.earnings.emptyStreak += 1;
          if (backfill.earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT) {
            backfill.earnings.done = true;
            await coverage(
              FANSLY_STATS_COVERAGE_PLANES.earnings,
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
          await coverage(
            FANSLY_STATS_COVERAGE_PLANES.earnings,
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
          : new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            5,
            0,
          )),
        stats: {
          mode: "backfill",
          journaled,
          callsToday: state.callsToday,
          dailyCap,
          deferred,
          dailyFloorAt: backfill.daily.floorAt,
          dailyDone: backfill.daily.done,
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
      await coverage(
        FANSLY_STATS_COVERAGE_PLANES.accountDaily,
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
      await coverage(
        FANSLY_STATS_COVERAGE_PLANES.accountHourly,
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

    if (state.stepIndex === 10) {
      const response = await app.adapter.getRecapStats(requestContext);
      await persist("recapstats", {}, response.raw);
      state = { ...state, stepIndex: 0, lastSweepDay: today };
      const completed = await upsertCheckpoint(app.db, {
        platformAccountId: pageId,
        stream: STREAM,
        cursorText: today,
        state: { ...state } as unknown as Record<string, unknown>,
        lastSuccessfulRunId: input.syncRunId,
      });
      await input.telemetry.recordCheckpointAdvanced(STREAM, summarizeCheckpoint(completed));
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
      continuationRetryAt: new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        5,
        0,
      )),
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
