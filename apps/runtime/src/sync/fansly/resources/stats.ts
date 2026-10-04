import type { CaptureCoverageProof, CaptureCoverageStatus, Database, SyncPageRow } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { parseFanslyMetadataAccountCreatedAt } from "../../../services/fansly.ts";
import {
  advanceEarningsWindow,
  FANSLY_EARNINGS_ROW_LIMIT,
  parseEarningsWindow,
  startEarningsWindow,
  type EarningsWindowWalk,
} from "../lib/earnings-window.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import {
  advanceBroadcastWalk,
  BACKFILL_EMPTY_STREAK_LIMIT,
  BACKFILL_PROBE_JUMP_DAYS,
  BACKFILL_PROBE_JUMP_MONTHS,
  classifyStatsMonth,
  classifyStatsWindow,
  DAILY_TRAILING_DAYS,
  DISCOVERY_PAGE_LIMIT,
  DISCOVERY_PAGES_PER_SWEEP,
  EARNINGS_TRAILING_DAYS,
  emptyDailyBackfill,
  emptyEarningsBackfill,
  HOURLY_CAPTURE_SPACING_MS,
  HOURLY_TRAILING_HOURS,
  hourlyCaptureGap,
  LAST_SWEEP_STEP,
  monthFromIndex,
  monthIndexOf,
  monthLabel,
  MONTH_FORM_TRAILING_DAYS,
  monthPredatesAccountCreation,
  monthWasHonoured,
  narrowedSpanDays,
  parseDailyBackfill,
  parseEarningsBackfill,
  servedWindow,
  trustedAccountCreatedAt,
  windowWasHonoured,
  type BroadcastWalkStop,
  type DailyBackfillState,
  type EarningsBackfillState,
} from "../lib/stats-rules.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import {
  effectivePeriodMs,
  type ApplyInput,
  type ApplyResult,
  type RequestPlan,
  type ResourceModule,
  type StepPlan,
} from "../../engine/resource.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";
import { fanslyResourceSpec } from "../registry.ts";

// `stats.daily`, `stats.hourly`, `stats.backfill` (plan §5, design §5.19):
// the account statistics, journaled under the legacy kinds and turned into
// events by inline canonicalization (`pull/stats`); the coverage rows the
// Analytics panels read are the legacy lane's.
//
// daily (poll, 24 h): the legacy sweep, one read a step, the step in the poll
// row's cursor — the 30-day daily account stats, the trailing earnings window
// (split by UTC day while a window is full), all-time monthly earnings,
// tracking links, two discovery pages, the live and the deleted broadcast
// lists (a list not yet read to its floor walks ≤ 3 pages a sweep, then only
// its head), scheduled broadcasts, polls, the recap. Step indexes are the
// legacy ones (step 1 has been empty since the hourly plane left the sweep).
//
// hourly (poll, 22 h [A15]): the trailing 25 hours at hourly buckets — the
// only hours the route serves; a hole between two captures is written down
// for good. The next capture is never planned further out than the legacy
// 23-hour spacing two windows need to meet.
//
// backfill (goal: owner): the trailing daily window once, then calendar month
// by month down to the account's creation (two empty months buy one probe a
// year further back where the creation is unknown), and the earnings in
// 31-day windows to the same floor; the hourly plane has no history and says
// so. One request a step; every rule and coverage claim is the legacy lane's.

const HOURLY_KEY = "stats.hourly";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAILY_PERIOD_MS = 86_400_000;
const HOURLY_PERIOD_MS = 3_600_000;
const ALL_TIME_AFTER_MS = Date.UTC(2015, 0, 1);

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function params(request: RequestPlan): Record<string, unknown> {
  return recordOf(request.params);
}

/** One coverage claim of the stats planes, JSON-able (it may travel with a
 *  step from the plan that decided it to the apply that writes it). */
interface CoverageClaim {
  plane: string;
  scopeRef: string;
  status: CaptureCoverageStatus;
  proof: CaptureCoverageProof;
  proofObservationId?: number | null;
  oldestCapturedAt?: string | null;
  newestCapturedAt?: string | null;
  replaceWindowBounds?: boolean;
  reasonCode?: string | null;
  cursor?: Record<string, unknown>;
}

async function writeClaims(tx: Database, pageId: number, claims: readonly CoverageClaim[]): Promise<void> {
  for (const claim of claims) {
    await writeFanslyLaneCoverage({
      db: tx,
      pageId,
      plane: claim.plane,
      scopeRef: claim.scopeRef,
      status: claim.status,
      acquisitionMode: "retroactive",
      proof: claim.proof,
      ...(claim.proofObservationId === undefined ? {} : { proofObservationId: claim.proofObservationId }),
      ...(claim.oldestCapturedAt === undefined ? {} : { oldestCapturedAt: claim.oldestCapturedAt === null ? null : new Date(claim.oldestCapturedAt) }),
      ...(claim.newestCapturedAt === undefined ? {} : { newestCapturedAt: claim.newestCapturedAt === null ? null : new Date(claim.newestCapturedAt) }),
      ...(claim.replaceWindowBounds === undefined ? {} : { replaceWindowBounds: claim.replaceWindowBounds }),
      ...(claim.reasonCode === undefined ? {} : { reasonCode: claim.reasonCode }),
      ...(claim.cursor === undefined ? {} : { cursor: claim.cursor }),
    });
  }
}

// ── daily ────────────────────────────────────────────────────────────────────

interface BroadcastState {
  before: string | null;
  floorReached: boolean;
  pagesInSweep: number;
  stop: BroadcastWalkStop | null;
}

export interface StatsDailyCursor {
  /** The legacy step index the next read is (0, 2 … 10). */
  stepIndex: number;
  earningsWalk: EarningsWindowWalk | null;
  discoveryPage: number;
  broadcasts: { live: BroadcastState; deleted: BroadcastState };
  last: Record<string, unknown> | null;
}

const DAILY_STEPS: Readonly<Record<number, FanslyWireId>> = {
  0: "account.stats",
  2: "earnings.stats_window",
  3: "earnings.monthly",
  4: "trackinglinks",
  5: "discovery.suggestions",
  6: "broadcast.stats",
  7: "broadcast.stats_deleted",
  8: "broadcast.scheduled",
  9: "polls",
  [LAST_SWEEP_STEP]: "recapstats",
};

function parseBroadcast(value: unknown): BroadcastState {
  const record = recordOf(value);
  const stop = record.stop;
  return {
    before: text(record.before),
    floorReached: record.floorReached === true,
    pagesInSweep: Math.max(0, int(record.pagesInSweep) ?? 0),
    stop: stop === "empty_page" || stop === "no_row_ids" || stop === "cursor_not_advancing" || stop === "malformed_shape" ? stop : null,
  };
}

export function parseStatsDailyCursor(value: unknown): StatsDailyCursor {
  const record = recordOf(value);
  const stepIndex = int(record.stepIndex);
  const broadcasts = recordOf(record.broadcasts);
  return {
    stepIndex: stepIndex !== null && DAILY_STEPS[stepIndex] !== undefined ? stepIndex : 0,
    earningsWalk: parseEarningsWindow(record.earningsWalk),
    discoveryPage: Math.max(0, int(record.discoveryPage) ?? 0),
    broadcasts: { live: parseBroadcast(broadcasts.live), deleted: parseBroadcast(broadcasts.deleted) },
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

function nextDailyStep(index: number): number | null {
  if (index === 0) return 2;
  return index >= LAST_SWEEP_STEP ? null : index + 1;
}

function dailyRequest(cursor: StatsDailyCursor, now: Date): RequestPlan {
  const index = cursor.stepIndex;
  const step = { index };
  const nowMs = now.getTime();
  switch (index) {
    case 0:
      return { spec: "account.stats", params: { beforeMs: nowMs, afterMs: nowMs - DAILY_TRAILING_DAYS * DAY_MS, periodMs: DAILY_PERIOD_MS }, step };
    case 2: {
      const walk = cursor.earningsWalk ?? startEarningsWindow(nowMs - EARNINGS_TRAILING_DAYS * DAY_MS, nowMs);
      const window = walk.pending.at(-1)!;
      return {
        spec: "earnings.stats_window",
        params: { beforeMs: window.beforeMs, afterMs: window.afterMs, limit: FANSLY_EARNINGS_ROW_LIMIT },
        step: { index, earningsWalk: walk },
      };
    }
    case 3:
      return { spec: "earnings.monthly", params: { beforeMs: nowMs, afterMs: ALL_TIME_AFTER_MS }, step };
    case 5:
      return { spec: "discovery.suggestions", params: { limit: DISCOVERY_PAGE_LIMIT, offset: cursor.discoveryPage * DISCOVERY_PAGE_LIMIT }, step };
    case 6:
    case 7: {
      const walk = index === 6 ? cursor.broadcasts.live : cursor.broadcasts.deleted;
      return { spec: DAILY_STEPS[index]!, params: { before: walk.floorReached ? null : walk.before }, step } as RequestPlan;
    }
    default:
      return { spec: DAILY_STEPS[index]!, params: {}, step } as RequestPlan;
  }
}

function dailyStepOf(request: RequestPlan): { index: number; earningsWalk: EarningsWindowWalk | null } | null {
  const record = recordOf(request.step);
  const index = int(record.index);
  if (index === null || DAILY_STEPS[index] !== request.spec) return null;
  return { index, earningsWalk: parseEarningsWindow(record.earningsWalk) };
}

/** The cursor after a step that moved the sweep on. */
function advanceDaily(cursor: StatsDailyCursor, now: Date): { cursor: StatsDailyCursor; sweepDone: boolean } {
  const next = nextDailyStep(cursor.stepIndex);
  return next === null
    ? { cursor: { ...cursor, stepIndex: 0, earningsWalk: null, discoveryPage: 0, last: { sweptAt: now.toISOString() } }, sweepDone: true }
    : { cursor: { ...cursor, stepIndex: next }, sweepDone: false };
}

function dailyOutcome(cursor: StatsDailyCursor, now: Date, sweepDone: boolean, counters: Record<string, number>): ApplyResult {
  return sweepDone
    ? { work: { satisfiesRevision: true, close: "done", closeReason: "sweep_complete", cursor, result: cursor.last }, followups: [], counters: { ...counters, stats_sweeps: 1 } }
    : { work: { satisfiesRevision: false, nextDueAt: now, cursor }, followups: [], counters };
}

/** One broadcast page folded into its list's walk (legacy steps 6 and 7). */
function foldBroadcast(walk: BroadcastState, response: unknown, counters: Record<string, number>, kind: string): { walk: BroadcastState; stepDone: boolean } {
  const next = advanceBroadcastWalk({ before: walk.before, floorReached: walk.floorReached, pagesInSweep: walk.pagesInSweep }, response);
  if (next.stop !== null && next.stop !== "empty_page") counters[`${kind}_walk_stopped:${next.stop}`] = 1;
  return { walk: { ...next.walk, stop: next.stop ?? walk.stop }, stepDone: next.stepDone };
}

const dailyModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    return { kind: "request", request: dailyRequest(parseStatsDailyCursor(work.cursor), ctx.now) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const step = dailyStepOf(input.request);
    const stored = parseStatsDailyCursor(input.work.cursor);
    if (step === null || step.index !== stored.stepIndex) {
      throw new ApplyQuarantine("stats_daily_step_mismatch", { spec: input.request.spec, stepIndex: stored.stepIndex });
    }
    const counters: Record<string, number> = {};
    let cursor = stored;
    const p = params(input.request);
    switch (step.index) {
      case 0: {
        if (classifyStatsWindow(input.response) === "invalid") throw new ApplyQuarantine("stats_response_invalid", { kind: "account_stats" });
        const served = servedWindow(input.response);
        await writeClaims(tx, input.pageId, [{
          plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
          scopeRef: "steady",
          status: "window_captured",
          proof: "none",
          replaceWindowBounds: true,
          oldestCapturedAt: new Date(served.afterMs ?? (int(p.afterMs) ?? now.getTime())).toISOString(),
          newestCapturedAt: new Date(served.beforeMs ?? (int(p.beforeMs) ?? now.getTime())).toISOString(),
          proofObservationId: input.observation.id,
        }]);
        break;
      }
      case 2: {
        const walk = step.earningsWalk;
        const requested = walk?.pending.at(-1);
        if (walk === null || requested === undefined || requested.afterMs !== p.afterMs || requested.beforeMs !== p.beforeMs) {
          throw new ApplyQuarantine("stats_earnings_walk_mismatch");
        }
        const result = advanceEarningsWindow(walk, input.response);
        if (result === "invalid") throw new ApplyQuarantine("stats_response_invalid", { kind: "earnings_stats_snapshot" });
        if (result === "window_not_honoured" || result === "saturated_day") {
          counters[`earnings_${result}`] = 1;
          await writeClaims(tx, input.pageId, [{
            plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
            scopeRef: "steady",
            status: "partial_provider_surface",
            proof: "terminal_response",
            replaceWindowBounds: true,
            reasonCode: `earnings_${result}`,
            proofObservationId: input.observation.id,
            cursor: { afterMs: requested.afterMs, beforeMs: requested.beforeMs },
          }]);
        }
        if (result === "complete") {
          await writeClaims(tx, input.pageId, [{
            plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
            scopeRef: "steady",
            status: "window_captured",
            proof: "none",
            replaceWindowBounds: true,
            oldestCapturedAt: new Date(walk.afterMs).toISOString(),
            newestCapturedAt: new Date(walk.beforeMs).toISOString(),
            proofObservationId: input.observation.id,
            reasonCode: "trailing_window_captured",
            cursor: { afterMs: walk.afterMs, beforeMs: walk.beforeMs },
          }]);
        }
        if (result === "continue") return dailyOutcome({ ...cursor, earningsWalk: walk }, now, false, counters);
        cursor = { ...cursor, earningsWalk: null };
        break;
      }
      case 5: {
        const nextPage = cursor.discoveryPage + 1;
        if (nextPage < DISCOVERY_PAGES_PER_SWEEP) return dailyOutcome({ ...cursor, discoveryPage: nextPage }, now, false, counters);
        cursor = { ...cursor, discoveryPage: 0 };
        break;
      }
      case 6:
      case 7: {
        const live = step.index === 6;
        const folded = foldBroadcast(live ? cursor.broadcasts.live : cursor.broadcasts.deleted, input.response, counters, live ? "broadcast" : "deleted_broadcast");
        cursor = { ...cursor, broadcasts: live ? { ...cursor.broadcasts, live: folded.walk } : { ...cursor.broadcasts, deleted: folded.walk } };
        if (!folded.stepDone) return dailyOutcome(cursor, now, false, counters);
        break;
      }
      default:
        break;
    }
    const next = advanceDaily(cursor, now);
    return dailyOutcome(next.cursor, now, next.sweepDone, counters);
  },
};

// ── hourly ───────────────────────────────────────────────────────────────────

export interface StatsHourlyCursor {
  /** The last capture's window end (its request instant), ISO. */
  lastCapturedAt: string | null;
  /** The newest bucket that capture was served (`dateBefore`), ISO. */
  lastServedBefore: string | null;
  last: Record<string, unknown> | null;
}

function parseHourlyCursor(value: unknown): StatsHourlyCursor {
  const record = recordOf(value);
  const instant = (raw: unknown) => {
    const value = text(raw);
    return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
  };
  return {
    lastCapturedAt: instant(record.lastCapturedAt),
    lastServedBefore: instant(record.lastServedBefore),
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

/** The next capture: the page's period (the registry's 22 h unless the page
 *  overrides it) ±10 %, never past the spacing two hourly windows need to
 *  meet (`HOURLY_CAPTURE_SPACING_MS`). */
export function nextHourlyCaptureAt(now: Date, random: number, page: Pick<SyncPageRow, "registryOverrides">): Date {
  const everyMs = effectivePeriodMs(fanslyResourceSpec(HOURLY_KEY)!, page) ?? 22 * HOUR_MS;
  const jittered = everyMs * (0.9 + 0.2 * Math.min(Math.max(random, 0), 1));
  return new Date(now.getTime() + Math.round(Math.min(jittered, HOURLY_CAPTURE_SPACING_MS)));
}

const hourlyModule: ResourceModule = {
  async plan(_work, ctx): Promise<StepPlan> {
    const nowMs = ctx.now.getTime();
    return {
      kind: "request",
      request: { spec: "account.stats", params: { beforeMs: nowMs, afterMs: nowMs - HOURLY_TRAILING_HOURS * HOUR_MS, periodMs: HOURLY_PERIOD_MS } },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    if (classifyStatsWindow(input.response) === "invalid") throw new ApplyQuarantine("stats_response_invalid", { kind: "account_stats" });
    const cursor = parseHourlyCursor(input.work.cursor);
    const p = params(input.request);
    const capturedMs = int(p.beforeMs) ?? input.now.getTime();
    const afterMs = int(p.afterMs) ?? capturedMs - HOURLY_TRAILING_HOURS * HOUR_MS;
    const served = servedWindow(input.response);
    const claims: CoverageClaim[] = [{
      plane: CAPTURE_COVERAGE_PLANES.statsAccountHourly,
      scopeRef: "steady",
      status: "window_captured",
      proof: "none",
      replaceWindowBounds: true,
      oldestCapturedAt: new Date(served.afterMs ?? afterMs).toISOString(),
      newestCapturedAt: new Date(served.beforeMs ?? capturedMs).toISOString(),
      proofObservationId: input.observation.id,
    }];
    const counters: Record<string, number> = {};
    // The steady row describes the latest window only, so a hole between two
    // windows is written down where it stays: its own row, never overwritten.
    const hole = hourlyCaptureGap(
      cursor.lastCapturedAt === null ? null : {
        capturedMs: Date.parse(cursor.lastCapturedAt),
        servedBeforeMs: cursor.lastServedBefore === null ? null : Date.parse(cursor.lastServedBefore),
      },
      { capturedMs, servedAfterMs: served.afterMs },
    );
    if (hole !== null) {
      const missingFrom = new Date(hole.fromMs).toISOString();
      const missingTo = new Date(hole.toMs).toISOString();
      claims.push({
        plane: CAPTURE_COVERAGE_PLANES.statsAccountHourly,
        scopeRef: `gap:${missingFrom}/${missingTo}`,
        status: "partial_provider_surface",
        proof: "none",
        reasonCode: "hourly_capture_gap",
        proofObservationId: input.observation.id,
        cursor: {
          missingFrom,
          missingTo,
          missingHours: Math.round((hole.toMs - hole.fromMs) / HOUR_MS * 10) / 10,
          basis: hole.basis,
          previousCapturedAt: cursor.lastCapturedAt,
          capturedAt: new Date(capturedMs).toISOString(),
        },
      });
      counters.hourly_capture_gap = 1;
    }
    await writeClaims(tx, input.pageId, claims);
    const next: StatsHourlyCursor = {
      lastCapturedAt: new Date(capturedMs).toISOString(),
      lastServedBefore: served.beforeMs === null ? null : new Date(served.beforeMs).toISOString(),
      last: { capturedAt: new Date(capturedMs).toISOString(), gap: hole !== null },
    };
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "hourly_captured",
        cursor: next,
        nextDueAt: nextHourlyCaptureAt(input.now, Math.random(), input.page),
      },
      followups: [],
      counters,
    };
  },
};

// ── backfill ─────────────────────────────────────────────────────────────────

export interface StatsBackfillState {
  daily: DailyBackfillState;
  hourlyDone: boolean;
  earnings: EarningsBackfillState;
}

interface StatsBackfillCursor {
  state: StatsBackfillState | null;
}

type BackfillLane = { lane: "daily_trailing" } | { lane: "daily_month"; monthIndex: number } | { lane: "earnings" };

interface BackfillStep {
  /** The state the request was made from (after the no-request decisions
   *  the plan took, whose coverage claims travel with it). */
  state: StatsBackfillState;
  lane: BackfillLane;
  claims: CoverageClaim[];
}

function freshBackfill(now: Date): StatsBackfillState {
  return { daily: emptyDailyBackfill(now), hourlyDone: false, earnings: emptyEarningsBackfill(now.getTime(), false) };
}

function parseBackfillState(value: unknown, now: Date): StatsBackfillState | null {
  const record = recordOf(value);
  if (Object.keys(record).length === 0) return null;
  return {
    daily: parseDailyBackfill(record.daily, now),
    hourlyDone: record.hourlyDone === true,
    earnings: parseEarningsBackfill(record.earnings, now),
  };
}

function parseBackfillCursor(value: unknown, now: Date): StatsBackfillCursor {
  return { state: parseBackfillState(recordOf(value).state, now) };
}

function cloneState(state: StatsBackfillState): StatsBackfillState {
  return structuredClone(state);
}

/** What one advance of the walks decided. */
interface BackfillAdvance {
  state: StatsBackfillState;
  claims: CoverageClaim[];
  counters: Record<string, number>;
  next: { request: RequestPlan; lane: BackfillLane } | null;
}

function floorAt(daily: DailyBackfillState): string | null {
  return daily.floorAt === null ? null : new Date(daily.floorAt).toISOString();
}

/** The halve-once-then-stop of a window walk not honoured (legacy
 *  `handleUnhonouredWindow`); the stop claims the plane once. */
function unhonoured(
  lane: { done: boolean; guard: DailyBackfillState["guard"] },
  plane: string,
  requested: { afterMs: number; beforeMs: number },
  detail: { now: Date; served?: { afterMs: number | null; beforeMs: number | null }; oldestCapturedAt?: string | null },
  out: { claims: CoverageClaim[]; counters: Record<string, number> },
): void {
  const narrower = narrowedSpanDays(lane.guard.spanDays);
  if (!lane.guard.narrowed && narrower < lane.guard.spanDays) {
    lane.guard.spanDays = narrower;
    lane.guard.narrowed = true;
    return;
  }
  lane.done = true;
  const proofObservationId = lane.guard.lastObservationId;
  out.claims.push({
    plane,
    scopeRef: "",
    status: "partial_provider_surface",
    proof: proofObservationId === null ? "none" : "terminal_response",
    oldestCapturedAt: detail.oldestCapturedAt ?? null,
    newestCapturedAt: detail.now.toISOString(),
    proofObservationId,
    reasonCode: "window_not_honoured",
    cursor: {
      requestedAfterMs: requested.afterMs,
      requestedBeforeMs: requested.beforeMs,
      spanDays: lane.guard.spanDays,
      servedAfterMs: detail.served?.afterMs ?? null,
      servedBeforeMs: detail.served?.beforeMs ?? null,
    },
  });
  out.counters.window_not_honoured = (out.counters.window_not_honoured ?? 0) + 1;
}

/** The month walk's stop: there is no half of a month to ask for. */
function stopMonthWalk(
  daily: DailyBackfillState,
  input: { now: Date; monthIndex: number; trigger: string; served?: { afterMs: number | null; beforeMs: number | null }; proofObservationId?: number | null },
  out: { claims: CoverageClaim[]; counters: Record<string, number> },
): void {
  daily.done = true;
  const proofObservationId = input.proofObservationId ?? daily.guard.lastObservationId;
  const { year, month } = monthFromIndex(input.monthIndex);
  out.claims.push({
    plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    scopeRef: "",
    status: "partial_provider_surface",
    proof: proofObservationId === null ? "none" : "terminal_response",
    oldestCapturedAt: floorAt(daily),
    newestCapturedAt: input.now.toISOString(),
    proofObservationId,
    reasonCode: "month_form_not_honoured",
    cursor: {
      mode: "backfill_month",
      trigger: input.trigger,
      requestedYear: year,
      requestedMonth: month,
      servedAfterMs: input.served?.afterMs ?? null,
      servedBeforeMs: input.served?.beforeMs ?? null,
    },
  });
  out.counters.month_form_not_honoured = 1;
}

/**
 * Walk the backfill's decisions that need no request (repeat guards, floors,
 * the hourly plane's claim) until the next request, or the end. Pure over
 * `state` (a copy is changed and returned).
 */
export function advanceStatsBackfill(input: { state: StatsBackfillState; now: Date; accountCreatedAt: Date | null }): BackfillAdvance {
  const state = cloneState(input.state);
  const now = input.now;
  const created = input.accountCreatedAt;
  const out = { claims: [] as CoverageClaim[], counters: {} as Record<string, number> };
  const daily = state.daily;
  const earnings = state.earnings;
  for (let guard = 0; guard < 64; guard += 1) {
    if (!daily.done) {
      if (!daily.trailingCaptured) {
        const requested = { beforeMs: daily.nextBeforeMs, afterMs: daily.nextBeforeMs - daily.guard.spanDays * DAY_MS };
        if (daily.guard.lastBeforeMs === requested.beforeMs && daily.guard.lastAfterMs === requested.afterMs) {
          unhonoured(daily, CAPTURE_COVERAGE_PLANES.statsAccountDaily, requested, { now, oldestCapturedAt: floorAt(daily) }, out);
          continue;
        }
        return {
          state,
          ...out,
          next: {
            request: { spec: "account.stats", params: { beforeMs: requested.beforeMs, afterMs: requested.afterMs, periodMs: DAILY_PERIOD_MS } },
            lane: { lane: "daily_trailing" },
          },
        };
      }
      const monthIndex = daily.nextMonthIndex ?? monthIndexOf(now) - 1;
      const probeHit = daily.probeHitMonthIndex;
      if (probeHit !== null && monthIndex <= probeHit) {
        daily.probeHitMonthIndex = null;
        daily.emptyStreak = 0;
        if (monthIndex === probeHit) {
          daily.nextMonthIndex = probeHit - 1;
          continue;
        }
      }
      if (monthPredatesAccountCreation(monthIndex, created)) {
        daily.done = true;
        out.claims.push({
          plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
          scopeRef: "",
          status: "provider_exhausted",
          proof: "none",
          oldestCapturedAt: floorAt(daily),
          newestCapturedAt: now.toISOString(),
          reasonCode: "account_creation_floor",
          cursor: { mode: "backfill_month", requestedMonth: monthLabel(monthIndex), accountCreatedAt: created!.toISOString() },
        });
        continue;
      }
      if (daily.lastMonthIndex === monthIndex) {
        stopMonthWalk(daily, { now, monthIndex, trigger: "repeat_request" }, out);
        continue;
      }
      const { year, month } = monthFromIndex(monthIndex);
      // The app's own request: the trailing bounds ride along and the server
      // ignores them; `year`/`month` select the window.
      return {
        state,
        ...out,
        next: {
          request: {
            spec: "account.stats",
            params: { beforeMs: now.getTime(), afterMs: now.getTime() - MONTH_FORM_TRAILING_DAYS * DAY_MS, periodMs: DAILY_PERIOD_MS, year, month },
          },
          lane: { lane: "daily_month", monthIndex },
        },
      };
    }
    if (!state.hourlyDone) {
      // The hourly plane has no history: the route serves hourly buckets only
      // inside its trailing 25 h, which the hourly poll captures.
      state.hourlyDone = true;
      out.claims.push({
        plane: CAPTURE_COVERAGE_PLANES.statsAccountHourly,
        scopeRef: "",
        status: "partial_provider_surface",
        proof: "none",
        reasonCode: "hourly_trailing_window_only",
        newestCapturedAt: now.toISOString(),
        cursor: { trailingHours: HOURLY_TRAILING_HOURS },
      });
      continue;
    }
    if (!earnings.done) {
      if (earnings.walk === null) {
        const probeHitBeforeMs = earnings.probeHitBeforeMs;
        if (probeHitBeforeMs !== null && earnings.nextBeforeMs <= probeHitBeforeMs) {
          earnings.nextBeforeMs = Math.min(earnings.nextBeforeMs, (earnings.probeHitAfterMs ?? probeHitBeforeMs) - 1);
          earnings.probeHitAfterMs = null;
          earnings.probeHitBeforeMs = null;
          earnings.emptyStreak = 0;
        }
        if (created !== null && earnings.nextBeforeMs <= created.getTime()) {
          earnings.done = true;
          out.claims.push({
            plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
            scopeRef: "",
            status: "provider_exhausted",
            proof: "none",
            newestCapturedAt: now.toISOString(),
            reasonCode: "account_creation_floor",
            cursor: { accountCreatedAt: created.toISOString() },
          });
          continue;
        }
        earnings.walk = startEarningsWindow(earnings.nextBeforeMs - earnings.guard.spanDays * DAY_MS, earnings.nextBeforeMs);
      }
      const window = earnings.walk.pending.at(-1)!;
      return {
        state,
        ...out,
        next: {
          request: { spec: "earnings.stats_window", params: { beforeMs: window.beforeMs, afterMs: window.afterMs, limit: FANSLY_EARNINGS_ROW_LIMIT } },
          lane: { lane: "earnings" },
        },
      };
    }
    return { state, ...out, next: null };
  }
  throw new Error("stats backfill advance did not settle");
}

/** One answer folded into the walk it served (legacy `runBackfill`'s fold). */
export function foldStatsBackfill(input: {
  state: StatsBackfillState;
  lane: BackfillLane;
  request: RequestPlan;
  response: unknown;
  observationId: number;
  now: Date;
  accountCreatedAt: Date | null;
}): { state: StatsBackfillState; claims: CoverageClaim[]; counters: Record<string, number> } {
  const state = cloneState(input.state);
  const { now, observationId, response } = input;
  const out = { claims: [] as CoverageClaim[], counters: {} as Record<string, number> };
  const daily = state.daily;
  const p = params(input.request);
  switch (input.lane.lane) {
    case "daily_trailing": {
      const requested = { beforeMs: int(p.beforeMs) ?? 0, afterMs: int(p.afterMs) ?? 0 };
      if (requested.beforeMs !== daily.nextBeforeMs || daily.trailingCaptured) {
        throw new ApplyQuarantine("stats_backfill_step_mismatch", { lane: "daily_trailing" });
      }
      daily.guard.lastBeforeMs = requested.beforeMs;
      daily.guard.lastAfterMs = requested.afterMs;
      daily.guard.lastObservationId = observationId;
      if (classifyStatsWindow(response) === "invalid") throw new ApplyQuarantine("stats_response_invalid", { kind: "account_stats", lane: "daily_trailing" });
      const served = servedWindow(response);
      if (!windowWasHonoured(requested, served)) {
        unhonoured(daily, CAPTURE_COVERAGE_PLANES.statsAccountDaily, requested, { now, served, oldestCapturedAt: floorAt(daily) }, out);
        break;
      }
      if (served.afterMs !== null) {
        const servedFloor = new Date(served.afterMs).toISOString();
        daily.floorAt = daily.floorAt === null || servedFloor < daily.floorAt ? servedFloor : daily.floorAt;
      }
      daily.trailingCaptured = true;
      daily.nextMonthIndex = monthIndexOf(now) - 1;
      out.claims.push({
        plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
        scopeRef: "",
        status: "in_progress",
        proof: "none",
        oldestCapturedAt: floorAt(daily),
        newestCapturedAt: now.toISOString(),
        cursor: { mode: "backfill_month", nextMonth: monthLabel(daily.nextMonthIndex) },
      });
      break;
    }
    case "daily_month": {
      const monthIndex = input.lane.monthIndex;
      const { year, month } = monthFromIndex(monthIndex);
      if (p.year !== year || p.month !== month || daily.done) throw new ApplyQuarantine("stats_backfill_step_mismatch", { lane: "daily_month" });
      daily.lastMonthIndex = monthIndex;
      daily.guard.lastObservationId = observationId;
      const monthClass = classifyStatsMonth(response);
      if (monthClass === "invalid") {
        if (daily.probeResumeMonthIndex === null) throw new ApplyQuarantine("stats_response_invalid", { kind: "account_stats", lane: "daily_month" });
        // A malformed answer to the one-off deep probe ends the walk
        // conservatively, never as an empty-window claim.
        daily.done = true;
        out.claims.push({
          plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
          scopeRef: "",
          status: "partial_provider_surface",
          proof: "terminal_response",
          oldestCapturedAt: floorAt(daily),
          newestCapturedAt: now.toISOString(),
          proofObservationId: observationId,
          reasonCode: "probe_response_invalid",
          cursor: { mode: "backfill_month_probe", requestedMonth: monthLabel(monthIndex), resumeMonth: monthLabel(daily.probeResumeMonthIndex) },
        });
        out.counters.probe_response_invalid = 1;
        break;
      }
      const served = servedWindow(response);
      if (!monthWasHonoured(monthIndex, served)) {
        stopMonthWalk(daily, { now, monthIndex, trigger: "served_window", served, proofObservationId: observationId }, out);
        break;
      }
      if (monthClass === "empty") {
        const streak = daily.emptyStreak + 1;
        daily.emptyStreak = streak;
        if (input.accountCreatedAt !== null || daily.probeHitMonthIndex !== null) {
          daily.nextMonthIndex = monthIndex - 1;
        } else if (streak >= BACKFILL_EMPTY_STREAK_LIMIT && !daily.probeSpent) {
          daily.probeSpent = true;
          daily.probeResumeMonthIndex = monthIndex - 1;
          daily.nextMonthIndex = monthIndex - BACKFILL_PROBE_JUMP_MONTHS;
        } else if (streak >= BACKFILL_EMPTY_STREAK_LIMIT) {
          daily.done = true;
          out.claims.push({
            plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
            scopeRef: "",
            status: "provider_exhausted",
            proof: "empty_window",
            oldestCapturedAt: floorAt(daily),
            proofObservationId: observationId,
            reasonCode: "empty_window_streak",
            cursor: { mode: "backfill_month", lastMonth: monthLabel(monthIndex) },
          });
        } else {
          daily.nextMonthIndex = monthIndex - 1;
        }
        break;
      }
      daily.emptyStreak = 0;
      if (served.afterMs !== null) {
        const servedFloor = new Date(served.afterMs).toISOString();
        daily.floorAt = daily.floorAt === null || servedFloor < daily.floorAt ? servedFloor : daily.floorAt;
      }
      if (daily.probeResumeMonthIndex !== null) {
        daily.probeHitMonthIndex = monthIndex;
        daily.nextMonthIndex = daily.probeResumeMonthIndex;
        daily.probeResumeMonthIndex = null;
      } else {
        daily.nextMonthIndex = monthIndex - 1;
      }
      out.claims.push({
        plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
        scopeRef: "",
        status: "in_progress",
        proof: "none",
        oldestCapturedAt: floorAt(daily),
        newestCapturedAt: now.toISOString(),
        cursor: { mode: "backfill_month", nextMonth: monthLabel(daily.nextMonthIndex) },
      });
      break;
    }
    case "earnings": {
      const earnings = state.earnings;
      const walk = earnings.walk;
      const requested = walk?.pending.at(-1);
      if (walk === null || requested === undefined || requested.afterMs !== p.afterMs || requested.beforeMs !== p.beforeMs) {
        throw new ApplyQuarantine("stats_backfill_step_mismatch", { lane: "earnings" });
      }
      earnings.guard.lastObservationId = observationId;
      const result = advanceEarningsWindow(walk, response);
      if (result === "invalid") throw new ApplyQuarantine("stats_response_invalid", { kind: "earnings_stats_snapshot", lane: "earnings" });
      if (result === "window_not_honoured" || result === "saturated_day") {
        earnings.done = true;
        out.claims.push({
          plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
          scopeRef: "",
          status: "partial_provider_surface",
          proof: "terminal_response",
          reasonCode: `earnings_${result}`,
          proofObservationId: observationId,
          cursor: { afterMs: requested.afterMs, beforeMs: requested.beforeMs },
        });
        out.counters[`earnings_${result}`] = 1;
        break;
      }
      if (result === "continue") break;
      const windowHadRows = walk.hasRows;
      earnings.nextBeforeMs = walk.afterMs - 1;
      earnings.walk = null;
      if (!windowHadRows) {
        earnings.emptyStreak += 1;
        const streakMayEnd = input.accountCreatedAt === null && earnings.probeHitBeforeMs === null;
        if (streakMayEnd && earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT && !earnings.probeSpent) {
          earnings.probeSpent = true;
          earnings.probeResumeBeforeMs = earnings.nextBeforeMs;
          earnings.nextBeforeMs -= BACKFILL_PROBE_JUMP_DAYS * DAY_MS;
        } else if (streakMayEnd && earnings.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT) {
          earnings.done = true;
          out.claims.push({
            plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
            scopeRef: "",
            status: "provider_exhausted",
            proof: "empty_window",
            proofObservationId: observationId,
            reasonCode: "empty_window_streak",
          });
        }
      } else {
        earnings.emptyStreak = 0;
        if (earnings.probeResumeBeforeMs !== null) {
          earnings.probeHitAfterMs = walk.afterMs;
          earnings.probeHitBeforeMs = walk.beforeMs;
          earnings.nextBeforeMs = earnings.probeResumeBeforeMs;
          earnings.probeResumeBeforeMs = null;
        }
        out.claims.push({
          plane: CAPTURE_COVERAGE_PLANES.statsEarnings,
          scopeRef: "",
          status: "in_progress",
          proof: "none",
          oldestCapturedAt: new Date(walk.afterMs).toISOString(),
          newestCapturedAt: now.toISOString(),
        });
      }
      break;
    }
  }
  return { state, ...out };
}

function backfillStepOf(request: RequestPlan, now: Date): BackfillStep | null {
  const record = recordOf(request.step);
  const state = parseBackfillState(record.state, now);
  const lane = recordOf(record.lane);
  const parsedLane: BackfillLane | null = lane.lane === "daily_trailing" || lane.lane === "earnings"
    ? { lane: lane.lane }
    : lane.lane === "daily_month" && int(lane.monthIndex) !== null ? { lane: "daily_month", monthIndex: int(lane.monthIndex)! } : null;
  if (state === null || parsedLane === null) return null;
  return { state, lane: parsedLane, claims: Array.isArray(record.claims) ? record.claims as CoverageClaim[] : [] };
}

async function accountCreatedAtOf(db: Database, pageId: number, now: Date): Promise<Date | null> {
  const facts = await readFanslyPageFacts(db, pageId);
  return facts === null ? null : trustedAccountCreatedAt(parseFanslyMetadataAccountCreatedAt(facts.metadata), now);
}

function backfillDone(state: StatsBackfillState): boolean {
  return state.daily.done && state.hourlyDone && state.earnings.done;
}

const backfillModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseBackfillCursor(work.cursor, ctx.now);
    const created = await accountCreatedAtOf(ctx.db, ctx.pageId, ctx.now);
    const advanced = advanceStatsBackfill({ state: cursor.state ?? freshBackfill(ctx.now), now: ctx.now, accountCreatedAt: created });
    if (advanced.next === null) {
      return { kind: "done", reason: "backfill_complete", cursor: { state: advanced.state } satisfies StatsBackfillCursor };
    }
    const step: BackfillStep = { state: advanced.state, lane: advanced.next.lane, claims: advanced.claims };
    return { kind: "request", request: { ...advanced.next.request, step } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const step = backfillStepOf(input.request, now);
    if (step === null) throw new ApplyQuarantine("stats_backfill_step_missing");
    const created = await accountCreatedAtOf(tx, input.pageId, now);
    const folded = foldStatsBackfill({
      state: step.state,
      lane: step.lane,
      request: input.request,
      response: input.response,
      observationId: input.observation.id,
      now,
      accountCreatedAt: created,
    });
    // Settle the decisions that need no request now, so the next plan only
    // asks: the claims of both are written here, in order.
    const advanced = advanceStatsBackfill({ state: folded.state, now, accountCreatedAt: created });
    await writeClaims(tx, input.pageId, [...step.claims, ...folded.claims, ...advanced.claims]);
    const counters = { ...folded.counters, ...advanced.counters };
    const cursor: StatsBackfillCursor = { state: advanced.state };
    if (advanced.next === null || backfillDone(advanced.state)) {
      return { work: { satisfiesRevision: true, close: "done", closeReason: "backfill_complete", cursor }, followups: [], counters };
    }
    return { work: { satisfiesRevision: false, nextDueAt: now, cursor }, followups: [], counters };
  },
};

export type StatsVariant = "daily" | "hourly" | "backfill";

export function statsModule(variant: StatsVariant): ResourceModule {
  switch (variant) {
    case "daily":
      return dailyModule;
    case "hourly":
      return hourlyModule;
    case "backfill":
      return backfillModule;
  }
}
