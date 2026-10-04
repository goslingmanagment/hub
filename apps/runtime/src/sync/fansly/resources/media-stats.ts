import {
  countMediaStatsRefreshProgress,
  getSyncAttempt,
  listMediaStatsRefreshChunk,
  markMediaStatsTopMediaDirty,
  recordMediaStatsBackfillCursor,
  recordMediaStatsBackfillProgress,
  recordMediaStatsVisit,
  type CaptureCoverageStatus,
  type Database,
  type MediaStatsRefreshCandidate,
  type MediaStatsTier,
  type MediaStatsTiers,
  type SyncAttemptRow,
  type SyncPageRow,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { fanslyUtcDayKey, writeFanslyLaneCoverage } from "../lib/lane.ts";
import {
  answeredFloor,
  BACKFILL_EMPTY_STREAK_LIMIT,
  BACKFILL_OVERLAP_DAYS,
  BACKFILL_WINDOWS_PER_VISIT,
  backfillCursorJson,
  countMediaStatBuckets,
  isProviderRefusal,
  MEDIA_STATS_DAILY_PERIOD_MS,
  mediaBackfillCreationFloorMs,
  mediaBackfillFirstMonthProbe,
  mediaStatsWindowIsEmpty,
  parseMediaBackfillCursor,
  servedMediaOfferRef,
  servedWindowCoversRequest,
  servedWindowSpansRequest,
  steadyRefreshPlan,
  steadyWindows,
  TOP_MEDIA_MARK_LIMIT,
  windowAnsweredBy,
  windowKey,
  type HoleLeftOpen,
  type LongTailWindowMode,
  type MediaBackfillCursor,
  type WindowFailure,
} from "../lib/media-stats-rules.ts";
import { classifyStatsWindow, narrowedSpanDays, servedWindow, windowWasHonoured } from "../lib/stats-rules.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import {
  effectiveTiers,
  type ApplyInput,
  type ApplyResult,
  type LocalApplyInput,
  type RequestPlan,
  type ResourceModule,
  type StepPlan,
} from "../../engine/resource.ts";
import { clearQueueSubjectBlocks, recordQueueSubjectFailures, standingRecheckAt } from "../lib/subject-queue.ts";
import { fanslyResourceSpec } from "../registry.ts";

// `media-stats.walk` (plan §5, design §5.18, owner decision №6 "экономно"):
// per-media traffic, `GET /it/moie/statsnew`, journaled as
// `media_offer_stats` and turned into events by inline canonicalization
// (`pull/stats`). A standing walk over the `media_stats` queue the media-plane
// and engagement projectors seed and dirty (design §4.3): dirty (a purchase,
// the daily top-50 mark) → by tier → within a tier the window edge, never
// visited newest first, then the oldest visit. The tiers are the owner's
// (≤ 30 d daily, 31–90 d weekly, older monthly, D19), passed to the chunk
// query as its `tiers` input.
//
// One VISIT of one item is the legacy lane's visit, every rule kept — the
// first-sight backfill in 31-day windows newest first down to the item's
// creation (two all-zero windows buy one first-month probe), the tier's steady
// refresh with the hole below it, the repeat guard, halve-once-then-stop on a
// window the route does not honour, and the 90-day long-tail discovery with
// its fallback to three 31-day windows — but one WINDOW per step. The legacy
// day cap, chunk budget and continuations are gone: the pacer is the only
// pace, so a visit is never cut short by a budget.
//
// How a visit spans steps: a visit is a pure procedure over the item as it
// stood when the visit began (`snapshot`) and the answers of the windows it
// has asked for so far (`outcomes`). Each step replays it — deterministically,
// no clock, no randomness — until it needs a window it has no answer for: that
// window is the step's one request, and the visit travels with the request
// (`RequestPlan.step`), so the apply folds the answer into exactly the visit
// the plan decided. A visit that ends writes what the legacy visit wrote: the
// item's visit and backfill cursor (`recordMediaStatsVisit`), or only the
// cursor a walk moved without a look. A failed window ends the visit: the
// item's queue-row breaker opens (the engine's subject ladder) and the
// backfill windows it had journaled stay in its cursor; a refused 90-day
// window first tries the split plan, exactly as legacy.
//
// A visit replays only under the rules it began with. One in flight across a
// deploy that changed a visit rule (`steadyWindows`, the backfill constants
// shared with the legacy lane) no longer replays: it is ABANDONED, never
// fatal — the plan drops it and starts the next due item afresh, an apply
// whose step it was ends it without a look (the answer stays journaled and
// canonicalized) and opens the item's queue-row breaker, so a visit that never
// replays costs that item its backoff ladder, never the page's walk.

const KEY = "media-stats.walk";
const PLANE = "media_stats";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The walk looks at its queue again this long after it found nothing due
 *  (the legacy stream's cadence). */
export const MEDIA_STATS_RECHECK_MS = 6 * HOUR_MS;
/** The page's coverage row is rewritten at most this often (an aggregate over
 *  the whole queue, not a per-look record). */
const COVERAGE_EVERY_MS = HOUR_MS;
/** Error classes of a failure that is about the item (its breaker opened). */
const SUBJECT_ERRORS: ReadonlySet<string> = new Set(["subject_failure", "envelope_unsuccessful", "subject_terminal"]);

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

// ── the tiers (owner decision №6, from the registry) ─────────────────────────

/** The tiers of `media-stats.walk` on this page as the chunk query takes
 *  them: the registry's (owner decision №6), or the page's override (`sync
 *  page override --resource media-stats.walk --tiers … --owner-approved`). */
export function mediaStatsOwnerTiers(page: Pick<SyncPageRow, "registryOverrides">): MediaStatsTiers {
  const tiers = effectiveTiers(fanslyResourceSpec(KEY)!, page) ?? [];
  const [fresh, mid, old] = tiers;
  if (fresh?.maxAgeDays == null || mid?.maxAgeDays == null || old === undefined) {
    throw new Error(`${KEY} needs three tiers (fresh, mid, older)`);
  }
  return {
    freshDays: fresh.maxAgeDays,
    midDays: mid.maxAgeDays,
    freshEveryMs: fresh.everyMs,
    midEveryMs: mid.everyMs,
    oldEveryMs: old.everyMs,
  };
}

/** How long after a visit an item of this tier is due again. */
export function tierEveryMs(tiers: MediaStatsTiers, tier: MediaStatsTier): number {
  return tier === "fresh" ? tiers.freshEveryMs : tier === "mid" ? tiers.midEveryMs : tiers.oldEveryMs;
}

export function pickDueMedia(
  db: Database,
  input: { pageId: number; now: Date; limit: number; tiers: MediaStatsTiers },
): Promise<MediaStatsRefreshCandidate[]> {
  return listMediaStatsRefreshChunk(db, { pageId: input.pageId, limit: input.limit, now: input.now, tiers: input.tiers });
}

// ── one visit, replayed ──────────────────────────────────────────────────────

/** What the route has shown about its 90-day window (page-scoped, durable). */
export interface MediaStatsPageState {
  longTailWindowMode: LongTailWindowMode;
  longTailWindowAnnounced: boolean;
  /** The UTC day a 31-day probe after a refused 90-day window last failed. */
  longTailProbeFailedDay: string | null;
}

/** The item as the visit began. */
export interface MediaVisitSnapshot {
  subjectRef: string;
  tier: MediaStatsTier;
  dirty: boolean;
  createdAtPlatformMs: number | null;
  firstSeenAtMs: number | null;
  lastVisitedAtMs: number | null;
  /** `subject_refresh_state.backfill_cursor` as the visit began. */
  backfillCursor: Record<string, unknown>;
  /** The visit's clock: every window and the item's age are measured from it. */
  nowMs: number;
  page: MediaStatsPageState;
}

export type MediaWindowOutcome =
  | {
    key: string;
    ok: { servedAfterMs: number | null; servedBeforeMs: number | null; empty: boolean; buckets: number; observationId: number | null };
  }
  | { key: string; failed: WindowFailure };

export interface MediaVisit {
  snapshot: MediaVisitSnapshot;
  outcomes: MediaWindowOutcome[];
}

export interface MediaWindowRequest {
  key: string;
  periodMs: number;
  afterMs: number;
  beforeMs: number;
  mode: "backfill" | "steady";
  /** The long tail's trailing 90-day window on a route not known to split. */
  ninetyProbe: boolean;
}

export type MediaVisitRun =
  /** The visit needs this window next. */
  | { kind: "need"; window: MediaWindowRequest; page: MediaStatsPageState; counters: Record<string, number> }
  /** A window failed: the visit ends; `progress` is the backfill cursor to
   *  keep (null when it did not move). */
  | { kind: "failed"; progress: Record<string, unknown> | null; page: MediaStatsPageState; counters: Record<string, number> }
  /** The visit is over: `visited` is the look to record (null: nothing
   *  durable to call a visit — `progress` then is a moved cursor, or null). */
  | {
    kind: "finished";
    visited: { knownCount: number; backfillCursor: Record<string, unknown>; clearDirty: boolean } | null;
    progress: Record<string, unknown> | null;
    page: MediaStatsPageState;
    counters: Record<string, number>;
  };

/** The replay asked for a different window than the one the step answered:
 *  the visit began under other visit rules (a deploy while it was in flight). */
export class MediaVisitDivergedError extends Error {
  constructor(readonly expected: string, readonly recorded: string) {
    super(`Media-stats visit replay diverged: asked ${expected}, the step answered ${recorded}`);
    this.name = "MediaVisitDivergedError";
  }
}

class NeedWindow {
  constructor(readonly window: MediaWindowRequest) {}
}

type Window = { periodMs: number; afterMs: number; beforeMs: number };
type Span = { afterMs: number; beforeMs: number };
type Served = { afterMs: number | null; beforeMs: number | null };
type Answer = { served: Served; honoured: boolean; empty: boolean; buckets: number; observationId: number | null };
type SteadyResult = { status: "ok" | "failed"; buckets: number; complete: boolean; holeClosed: boolean };

/**
 * One visit (the legacy `visitCandidate` with its budgets removed) over the
 * answers recorded so far. Pure: the same visit always asks for the same
 * windows in the same order.
 */
export function runMediaVisit(visit: MediaVisit): MediaVisitRun {
  const s = visit.snapshot;
  const now = new Date(s.nowMs);
  const today = fanslyUtcDayKey(now);
  const page: MediaStatsPageState = { ...s.page };
  const counters: Record<string, number> = {};
  const count = (name: string, by = 1) => {
    counters[name] = (counters[name] ?? 0) + by;
  };
  const candidate = {
    createdAtPlatform: s.createdAtPlatformMs === null ? null : new Date(s.createdAtPlatformMs),
    firstSeenAt: s.firstSeenAtMs === null ? null : new Date(s.firstSeenAtMs),
  };
  const cursor: MediaBackfillCursor = parseMediaBackfillCursor(s.backfillCursor, now);
  const cursorAtEntry = JSON.stringify(backfillCursorJson(cursor));
  const moved = () => {
    const json = backfillCursorJson(cursor);
    return JSON.stringify(json) === cursorAtEntry ? null : json;
  };
  const issued = new Set<string>();
  const answered: Span[] = [];
  let holeFrom: Date | null = null;
  let holeLeftOpen: HoleLeftOpen | null = null;
  let lastFailure: WindowFailure | null = null;
  let next = 0;

  const requestWindow = (window: Window & { mode: "backfill" | "steady"; ninetyProbe: boolean }): Answer | "repeat" | "failed" => {
    const key = windowKey(window);
    if (issued.has(key)) {
      count("window_repeat");
      return "repeat";
    }
    issued.add(key);
    const outcome = visit.outcomes[next];
    if (outcome === undefined) throw new NeedWindow({ key, ...window });
    if (outcome.key !== key) throw new MediaVisitDivergedError(key, outcome.key);
    next += 1;
    if ("failed" in outcome) {
      lastFailure = outcome.failed;
      return "failed";
    }
    const served = { afterMs: outcome.ok.servedAfterMs, beforeMs: outcome.ok.servedBeforeMs };
    answered.push({ afterMs: served.afterMs ?? window.afterMs, beforeMs: served.beforeMs ?? window.beforeMs });
    return {
      served,
      honoured: windowWasHonoured({ afterMs: window.afterMs, beforeMs: window.beforeMs }, served),
      empty: outcome.ok.empty,
      buckets: outcome.ok.buckets,
      observationId: outcome.ok.observationId,
    };
  };
  const windowHeld = (window: Window) => issued.has(windowKey(window)) || windowAnsweredBy(window, answered);

  /** Halve once, then stop the item's backfill (legacy `handleUnhonouredWindow`). */
  const unhonoured = (): "narrowed" | "stopped" => {
    const narrower = narrowedSpanDays(cursor.guard.spanDays);
    if (!cursor.guard.narrowed && narrower < cursor.guard.spanDays) {
      cursor.guard.spanDays = narrower;
      cursor.guard.narrowed = true;
      return "narrowed";
    }
    cursor.done = true;
    cursor.stopReason = "window_not_honoured";
    count("window_not_honoured");
    return "stopped";
  };

  const runBackfill = (): { status: "ok" | "failed"; windows: number; buckets: number } => {
    const creationFloorMs = mediaBackfillCreationFloorMs(candidate);
    let windows = 0;
    let journaledWindows = 0;
    let buckets = 0;
    while (windows < BACKFILL_WINDOWS_PER_VISIT && !cursor.done) {
      if (creationFloorMs !== null && cursor.nextBeforeMs < creationFloorMs) {
        cursor.done = true;
        cursor.stopReason = "created_at_floor";
        cursor.floorBasis = "created_at";
        break;
      }
      if (cursor.probeHitBeforeMs !== null && cursor.nextBeforeMs <= cursor.probeHitBeforeMs) {
        cursor.done = true;
        cursor.stopReason = "created_at_floor";
        cursor.floorBasis = "created_at";
        cursor.probeHitBeforeMs = null;
        break;
      }
      const requested = {
        beforeMs: cursor.nextBeforeMs,
        afterMs: cursor.nextBeforeMs - cursor.guard.spanDays * DAY_MS,
      };
      if (cursor.guard.lastBeforeMs === requested.beforeMs && cursor.guard.lastAfterMs === requested.afterMs) {
        unhonoured();
        break;
      }
      const outcome = requestWindow({ periodMs: MEDIA_STATS_DAILY_PERIOD_MS, ...requested, mode: "backfill", ninetyProbe: false });
      windows += 1;
      if (outcome === "failed") return { status: "failed", windows: journaledWindows, buckets };
      cursor.guard.lastBeforeMs = requested.beforeMs;
      cursor.guard.lastAfterMs = requested.afterMs;
      if (outcome === "repeat") {
        unhonoured();
        break;
      }
      journaledWindows += 1;
      count("backfill_windows");
      buckets += outcome.buckets;
      cursor.guard.lastObservationId = outcome.observationId ?? cursor.guard.lastObservationId;
      if (!outcome.honoured) {
        if (unhonoured() === "stopped") break;
        continue;
      }
      if (outcome.empty) {
        cursor.emptyStreak += 1;
        if (cursor.probeResumeBeforeMs !== null) {
          cursor.done = true;
          cursor.stopReason = "empty_window_probe";
          cursor.floorBasis = "empty_window_probe";
          cursor.probeResumeBeforeMs = null;
          break;
        }
        if (cursor.emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT && cursor.probeHitBeforeMs === null) {
          const probe = cursor.probeSpent ? null : mediaBackfillFirstMonthProbe(cursor, candidate);
          if (probe !== null) {
            cursor.probeSpent = true;
            cursor.probeResumeBeforeMs = probe.resumeBeforeMs;
            cursor.nextBeforeMs = probe.probeBeforeMs;
            continue;
          }
          cursor.done = true;
          cursor.stopReason = "empty_window_streak";
          cursor.floorBasis = "empty_window";
          break;
        }
        cursor.nextBeforeMs -= cursor.guard.spanDays * DAY_MS;
        continue;
      }
      cursor.emptyStreak = 0;
      if (outcome.served.afterMs !== null) {
        const servedFloor = new Date(outcome.served.afterMs).toISOString();
        cursor.floorAt = cursor.floorAt === null || servedFloor < cursor.floorAt ? servedFloor : cursor.floorAt;
      }
      if (cursor.probeResumeBeforeMs !== null) {
        cursor.probeHitBeforeMs = Math.min(requested.beforeMs, outcome.served.beforeMs ?? requested.beforeMs);
        cursor.nextBeforeMs = cursor.probeResumeBeforeMs;
        cursor.probeResumeBeforeMs = null;
        continue;
      }
      cursor.nextBeforeMs = outcome.served.afterMs !== null
        ? outcome.served.afterMs + BACKFILL_OVERLAP_DAYS * DAY_MS
        : cursor.nextBeforeMs - cursor.guard.spanDays * DAY_MS;
    }
    return { status: "ok", windows: journaledWindows, buckets };
  };

  const fallBackFromNinetyDays = (): SteadyResult => {
    const failed: SteadyResult = { status: "failed", buckets: 0, complete: false, holeClosed: false };
    const refusal = lastFailure;
    if (refusal === null || !isProviderRefusal(refusal)) return failed;
    const [probeWindow] = steadyWindows(s.tier, now, "split_31");
    if (probeWindow === undefined) return failed;
    const answeredThisVisit = issued.has(windowKey(probeWindow));
    if (!answeredThisVisit && page.longTailProbeFailedDay === today) return failed;
    let probeBuckets = 0;
    if (!answeredThisVisit) {
      const probe = requestWindow({ ...probeWindow, mode: "steady", ninetyProbe: false });
      if (probe === "failed") {
        page.longTailProbeFailedDay = today;
        return failed;
      }
      if (probe === "repeat") return failed;
      probeBuckets = probe.buckets;
    }
    // Always announced: a page that had proven 90 days and lost them is a
    // new fact about the route, and it triples what a long-tail visit costs.
    page.longTailWindowMode = "split_31";
    page.longTailWindowAnnounced = true;
    count("long_tail_window_split");
    const split = runSteady("split_31");
    return { ...split, buckets: probeBuckets + split.buckets };
  };

  const runSteady = (planMode: LongTailWindowMode): SteadyResult => {
    const plan = steadyRefreshPlan(s.tier, now, planMode, holeFrom);
    const windows = plan.windows;
    const trailing = windows[0];
    const spanCount = windows.length - plan.holeWindows;
    const inHole = (window: Window) => windows.indexOf(window as (typeof windows)[number]) >= spanCount;
    let buckets = 0;
    const toRead = windows.filter((window) => !windowHeld(window));
    let spanMissing = toRead.filter((window) => !inHole(window)).length;
    let holeMissing = toRead.length - spanMissing;
    const result = (status: SteadyResult["status"]): SteadyResult => ({
      status,
      buckets,
      complete: status !== "failed" && spanMissing === 0,
      holeClosed: status !== "failed" && holeMissing === 0,
    });
    const leaveHoleOpen = (reason: HoleLeftOpen["reason"], window: Window, served: HoleLeftOpen["served"] = null) => {
      if (inHole(window) && holeLeftOpen === null) {
        holeLeftOpen = { reason, requested: { afterMs: window.afterMs, beforeMs: window.beforeMs }, served };
      }
    };
    for (const window of toRead) {
      const hole = inHole(window);
      const ninetyProbe = s.tier === "long_tail" && window === trailing && planMode !== "split_31";
      const outcome = requestWindow({ ...window, mode: "steady", ninetyProbe });
      if (outcome === "failed") return ninetyProbe ? fallBackFromNinetyDays() : result("failed");
      if (outcome === "repeat") {
        leaveHoleOpen("repeat_request", window);
        break;
      }
      buckets += outcome.buckets;
      if (hole) {
        if (!outcome.honoured || !servedWindowSpansRequest(window, outcome.served)) {
          leaveHoleOpen("window_not_honoured", window, outcome.served);
          break;
        }
        holeMissing -= 1;
        count("hole_windows");
        continue;
      }
      spanMissing -= 1;
      if (ninetyProbe) {
        const covered = outcome.honoured && servedWindowCoversRequest(window, outcome.served);
        if (!covered && page.longTailWindowMode !== "split_31") {
          page.longTailWindowMode = "split_31";
          if (!page.longTailWindowAnnounced) {
            page.longTailWindowAnnounced = true;
            count("long_tail_window_split");
          }
          const rerun = runSteady(page.longTailWindowMode);
          return { ...rerun, buckets: buckets + rerun.buckets };
        }
        if (covered && page.longTailWindowMode === "unproven") {
          page.longTailWindowMode = "ninety";
          if (!page.longTailWindowAnnounced) {
            page.longTailWindowAnnounced = true;
            count("long_tail_window_proven");
          }
        }
      }
    }
    return result("ok");
  };

  try {
    // Legacy repair: a walk that ended on two empty windows before the probe
    // existed reopens with the probe armed, once.
    if (cursor.done && cursor.floorBasis === "empty_window" && !cursor.probeSpent) {
      const probe = mediaBackfillFirstMonthProbe(cursor, candidate);
      if (probe !== null) {
        cursor.done = false;
        cursor.stopReason = null;
        cursor.floorBasis = null;
        cursor.probeSpent = true;
        cursor.probeResumeBeforeMs = probe.resumeBeforeMs;
        cursor.nextBeforeMs = probe.probeBeforeMs;
      }
    }
    const walkInPast = !cursor.done && cursor.nextBeforeMs < s.nowMs - DAY_MS;
    const walkFromToday = !cursor.done && !walkInPast;
    const refreshedThroughMs = cursor.refreshedThroughMs ?? s.lastVisitedAtMs ?? null;
    holeFrom = walkFromToday || refreshedThroughMs === null ? null : new Date(refreshedThroughMs);
    const closesHole = steadyRefreshPlan(s.tier, now, page.longTailWindowMode, holeFrom).holeWindows > 0;
    // A walk anchored in the past answers neither a dirty mark nor a hole:
    // the refresh goes first, whole, and the walk resumes below it.
    const refreshFirst = walkInPast && (s.dirty || closesHole);
    let buckets = 0;
    let journaledWindows = 0;
    let steadyComplete = false;
    let holeClosed = true;
    const failedRun = (): MediaVisitRun => ({ kind: "failed", progress: moved(), page, counters });

    if (refreshFirst) {
      const steady = runSteady(page.longTailWindowMode);
      if (steady.status === "failed") return failedRun();
      buckets += steady.buckets;
      steadyComplete = steady.complete;
      holeClosed = steady.holeClosed;
      if (cursor.probeResumeBeforeMs === null) {
        const resumeBeforeMs = answeredFloor(cursor.nextBeforeMs, answered) + BACKFILL_OVERLAP_DAYS * DAY_MS;
        if (resumeBeforeMs < cursor.nextBeforeMs) {
          cursor.nextBeforeMs = resumeBeforeMs;
          cursor.emptyStreak = 0;
        }
      }
    }
    if (!cursor.done) {
      const walk = runBackfill();
      if (walk.status === "failed") return failedRun();
      buckets += walk.buckets;
      journaledWindows += walk.windows;
    }
    if (!refreshFirst) {
      const steady = runSteady(page.longTailWindowMode);
      if (steady.status === "failed") return failedRun();
      buckets += steady.buckets;
      steadyComplete = steady.complete;
      holeClosed = steady.holeClosed;
    }

    if (journaledWindows === 0 && !steadyComplete) {
      // Nothing durable to call a visit; a cursor moved without egress stays.
      return { kind: "finished", visited: null, progress: moved(), page, counters };
    }
    const refreshedWhole = steadyComplete && holeClosed;
    if (steadyComplete && !holeClosed) count(`refresh_hole_open:${(holeLeftOpen as HoleLeftOpen | null)?.reason ?? "unknown"}`);
    const unreadHole = refreshedWhole ? steadyRefreshPlan(s.tier, now, page.longTailWindowMode, holeFrom).unreadHole : null;
    if (unreadHole !== null) count("refresh_hole_unread");
    cursor.refreshedThroughMs = refreshedWhole || walkFromToday ? s.nowMs : holeFrom?.getTime() ?? null;
    return {
      kind: "finished",
      visited: { knownCount: buckets, backfillCursor: backfillCursorJson(cursor), clearDirty: steadyComplete },
      progress: null,
      page,
      counters,
    };
  } catch (error) {
    if (error instanceof NeedWindow) return { kind: "need", window: error.window, page, counters };
    throw error;
  }
}

/** `runMediaVisit`, or null when the visit no longer replays under today's
 *  rules (it is abandoned, never fatal). */
export function replayMediaVisit(visit: MediaVisit): MediaVisitRun | null {
  try {
    return runMediaVisit(visit);
  } catch (error) {
    if (error instanceof MediaVisitDivergedError) return null;
    throw error;
  }
}

/** A visit exactly as the journal and the cursor will hold it (JSON), so the
 *  plan that asks for a window and the apply that replays the stored visit
 *  read the same values. */
function asStored(visit: MediaVisit): MediaVisit {
  return JSON.parse(JSON.stringify(visit)) as MediaVisit;
}

/** The visit of a queue candidate, as it begins now. */
export function startMediaVisit(candidate: MediaStatsRefreshCandidate, page: MediaStatsPageState, now: Date): MediaVisit {
  // Read into a local: the platform-branch ratchet greps for a literal
  // comparison on a name that ends in `platform`.
  const publishedAt = candidate.createdAtPlatform;
  return asStored({
    snapshot: {
      subjectRef: candidate.subjectRef,
      tier: candidate.tier,
      dirty: candidate.dirtyReason !== null,
      createdAtPlatformMs: publishedAt === null ? null : publishedAt.getTime(),
      firstSeenAtMs: candidate.firstSeenAt === null ? null : candidate.firstSeenAt.getTime(),
      lastVisitedAtMs: candidate.lastVisitedAt === null ? null : candidate.lastVisitedAt.getTime(),
      backfillCursor: candidate.backfillCursor,
      nowMs: now.getTime(),
      page: { ...page },
    },
    outcomes: [],
  });
}

/** The window outcome of one served answer (legacy `requestWindow`'s
 *  judgement after journaling): an unreadable body or one about another item
 *  is a failure of this item. */
export function mediaWindowOutcome(
  window: Pick<MediaWindowRequest, "key">,
  input: { subjectRef: string; response: unknown; observationId: number | null },
): { outcome: MediaWindowOutcome; refusal: "invalid_response" | "subject_mismatch" | null } {
  if (classifyStatsWindow(input.response) === "invalid") {
    return { outcome: { key: window.key, failed: { httpStatus: null, retryAfter: false } }, refusal: "invalid_response" };
  }
  const servedRef = servedMediaOfferRef(input.response);
  if (servedRef !== null && servedRef !== input.subjectRef) {
    return { outcome: { key: window.key, failed: { httpStatus: null, retryAfter: false } }, refusal: "subject_mismatch" };
  }
  const served = servedWindow(input.response);
  return {
    outcome: {
      key: window.key,
      ok: {
        servedAfterMs: served.afterMs,
        servedBeforeMs: served.beforeMs,
        empty: mediaStatsWindowIsEmpty(input.response),
        buckets: countMediaStatBuckets(input.response),
        observationId: input.observationId,
      },
    },
    refusal: null,
  };
}

// ── the walk's cursor ────────────────────────────────────────────────────────

export interface MediaStatsWalkCursor extends MediaStatsPageState {
  /** The UTC day the top-50 media were last marked dirty (zero calls). */
  topMarkedDay: string | null;
  /** The visit in progress (its next window is due now). */
  visit: MediaVisit | null;
  coverageWrittenAt: string | null;
  last: Record<string, unknown> | null;
}

function parseLongTailMode(value: unknown): LongTailWindowMode {
  return value === "ninety" || value === "split_31" ? value : "unproven";
}

function parseVisit(value: unknown): MediaVisit | null {
  const record = recordOf(value);
  const snapshot = recordOf(record.snapshot);
  if (text(snapshot.subjectRef) === null || int(snapshot.nowMs) === null || !Array.isArray(record.outcomes)) return null;
  return value as MediaVisit;
}

function parseMediaStatsWalkCursor(value: unknown): MediaStatsWalkCursor {
  const record = recordOf(value);
  return {
    longTailWindowMode: parseLongTailMode(record.longTailWindowMode),
    longTailWindowAnnounced: record.longTailWindowAnnounced === true,
    longTailProbeFailedDay: text(record.longTailProbeFailedDay),
    topMarkedDay: text(record.topMarkedDay),
    visit: parseVisit(record.visit),
    coverageWrittenAt: text(record.coverageWrittenAt),
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

function pageStateOf(cursor: MediaStatsPageState): MediaStatsPageState {
  return {
    longTailWindowMode: cursor.longTailWindowMode,
    longTailWindowAnnounced: cursor.longTailWindowAnnounced,
    longTailProbeFailedDay: cursor.longTailProbeFailedDay,
  };
}

/** The step a request carries: the visit as the plan made it, and the item
 *  whose stored visit the plan abandoned to make it (counted by the apply). */
interface MediaStatsStep {
  visit?: MediaVisit;
  abandoned?: string;
}

function stepOf(request: Pick<RequestPlan, "step">): MediaStatsStep {
  const record = recordOf(request.step);
  const visit = parseVisit(record.visit);
  const abandoned = text(record.abandoned);
  return {
    ...(visit === null ? {} : { visit }),
    ...(abandoned === null ? {} : { abandoned }),
  };
}

function windowRequest(subjectRef: string, window: Window, step: MediaStatsStep): RequestPlan<"media.offer_stats"> {
  return {
    spec: "media.offer_stats",
    params: { mediaOfferId: subjectRef, beforeMs: window.beforeMs, afterMs: window.afterMs, periodMs: window.periodMs },
    step,
  };
}

function sameWindow(request: RequestPlan, subjectRef: string, window: Window): boolean {
  const params = recordOf(request.params);
  return params.mediaOfferId === subjectRef && params.beforeMs === window.beforeMs
    && params.afterMs === window.afterMs && params.periodMs === window.periodMs;
}

/** The window an attempt asked for and how it failed, folded into the visit
 *  it served (the plan's view of a failed step: the real status). Null when
 *  the visit asks for nothing more, or no longer replays. */
function failedVisitOf(attempt: SyncAttemptRow): MediaVisit | null {
  const visit = stepOf({ step: recordOf(attempt.request).step }).visit;
  if (visit === undefined) return null;
  const run = replayMediaVisit(visit);
  if (run === null || run.kind !== "need") return null;
  return asStored({
    ...visit,
    outcomes: [...visit.outcomes, {
      key: run.window.key,
      failed: { httpStatus: attempt.httpStatus, retryAfter: attempt.retryAfterMs !== null },
    }],
  });
}

/** The page's coverage row (one per page, never one per item): an aggregate
 *  over the queue under the page's tiers, the per-look evidence being the
 *  journal. */
async function writeQueueCoverage(tx: Database, input: { pageId: number; now: Date; mode: LongTailWindowMode; tiers: MediaStatsTiers }) {
  const progress = await countMediaStatsRefreshProgress(tx, { pageId: input.pageId, now: input.now, tiers: input.tiers });
  const everyItemVisited = progress.queueSize > 0 && progress.neverVisited === 0 && progress.backfillComplete >= progress.queueSize;
  const status: CaptureCoverageStatus = progress.queueSize === 0
    ? "not_started"
    : everyItemVisited ? "window_captured" : "in_progress";
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: CAPTURE_COVERAGE_PLANES.mediaStats,
    scopeRef: String(input.pageId),
    status,
    acquisitionMode: "retroactive",
    proof: "none",
    newestCapturedAt: input.now,
    expectedCount: progress.queueSize,
    observedUniqueCount: progress.queueSize - progress.neverVisited,
    reasonCode: null,
    cursor: {
      dirty: progress.dirty,
      neverVisited: progress.neverVisited,
      backfillComplete: progress.backfillComplete,
      backfillStopped: progress.backfillStopped,
      longTailWindowMode: input.mode,
    },
  });
}

// ── the module ───────────────────────────────────────────────────────────────

/** Mark the page's latest top-50 media dirty, due now (the items visited
 *  within the day left alone); how many were marked. */
async function markTopMedia(tx: Database, pageId: number, now: Date): Promise<number> {
  const marked = await markMediaStatsTopMediaDirty(tx, {
    pageId,
    limit: TOP_MEDIA_MARK_LIMIT,
    dueAt: now,
    visitedSince: new Date(now.getTime() - DAY_MS),
  });
  return marked.marked;
}

export const mediaStatsWalkModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseMediaStatsWalkCursor(work.cursor);
    const tiers = mediaStatsOwnerTiers(ctx.page);
    // The free signal (zero calls): today's top-50 jump the queue once a UTC
    // day, marked before the pick as legacy marks them — also on a day the
    // queue holds nothing else due. This is the walk's only mark. Never
    // between a visit's steps or after a failed step (their plan comes
    // first): a visit in flight at midnight ends first, and after a failure
    // the mark waits for the first plan after an applied step.
    if (cursor.topMarkedDay !== fanslyUtcDayKey(ctx.now) && cursor.visit === null && work.lastErrorClass === null) {
      return { kind: "local", reason: "top_media_mark" };
    }
    let page = pageStateOf(cursor);
    let visit = cursor.visit;
    let abandoned: string | null = null;
    // The previous step's request failed (an applied attempt is already
    // folded into the cursor's visit, whatever failed after it): a failure
    // about the item ended its visit (its breaker is open, its progress kept
    // at the capture) unless a refused 90-day window falls back to the split
    // plan; any other failure (the page's: pace, network, credentials) asks
    // the same window again.
    if (work.lastErrorClass !== null && work.lastAttemptId !== null) {
      const attempt = await getSyncAttempt(ctx.db, work.lastAttemptId);
      const asked = attempt === null || attempt.applyState === "applied"
        ? undefined
        : stepOf({ step: recordOf(attempt.request).step }).visit;
      if (attempt !== null && asked !== undefined) {
        if (replayMediaVisit(asked) === null) {
          abandoned = asked.snapshot.subjectRef;
          visit = null;
        } else if (attempt.errorClass !== null && SUBJECT_ERRORS.has(attempt.errorClass)) {
          const failed = failedVisitOf(attempt);
          const run = failed === null ? null : replayMediaVisit(failed);
          if (failed !== null && run !== null && run.kind === "need") {
            return { kind: "request", request: windowRequest(failed.snapshot.subjectRef, run.window, { visit: failed }) };
          }
          if (run !== null) page = run.page;
          visit = null;
        } else {
          visit = asked;
        }
      }
    }
    if (visit !== null) {
      const run = replayMediaVisit(visit);
      if (run === null) abandoned = visit.snapshot.subjectRef;
      else if (run.kind === "need") return { kind: "request", request: windowRequest(visit.snapshot.subjectRef, run.window, { visit }) };
    }
    const [candidate] = await pickDueMedia(ctx.db, { pageId: ctx.pageId, now: ctx.now, limit: 1, tiers });
    if (candidate === undefined) return { kind: "wait", reason: "not_due", until: standingRecheckAt(ctx.now, MEDIA_STATS_RECHECK_MS) };
    const fresh = startMediaVisit(candidate, page, ctx.now);
    const run = runMediaVisit(fresh);
    // Every visit reads at least the tier's refresh: a visit asking for
    // nothing would be picked again at once.
    if (run.kind !== "need") return { kind: "quarantine", reason: "media_visit_without_window" };
    return {
      kind: "request",
      request: windowRequest(candidate.subjectRef, run.window, { visit: fresh, ...(abandoned === null ? {} : { abandoned }) }),
    };
  },

  /** The plan's `top_media_mark`: today's top-50 marked, the walk picks again
   *  at once. */
  async applyLocal(tx, input: LocalApplyInput): Promise<ApplyResult> {
    const cursor = parseMediaStatsWalkCursor(input.work.cursor);
    const today = fanslyUtcDayKey(input.now);
    if (cursor.topMarkedDay === today) return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
    const marked = await markTopMedia(tx, input.pageId, input.now);
    return {
      work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, topMarkedDay: today } satisfies MediaStatsWalkCursor },
      followups: [],
      counters: { top_media_marked: marked },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const cursor = parseMediaStatsWalkCursor(input.work.cursor);
    const step = stepOf(input.request);
    const asked = step.visit;
    if (asked === undefined) throw new ApplyQuarantine("media_stats_step_missing");
    const subjectRef = asked.snapshot.subjectRef;
    const counters: Record<string, number> = {};
    // The plan dropped a stored visit that no longer replays to make this one.
    if (step.abandoned !== undefined) counters.media_visit_abandoned = 1;
    const pending = replayMediaVisit(asked);
    const replays = pending !== null && pending.kind === "need" && sameWindow(input.request, subjectRef, pending.window);
    let visit: MediaVisit = asked;
    let run: MediaVisitRun | null = null;
    let next: MediaStatsWalkCursor = { ...cursor, visit: null };
    if (replays) {
      const folded = mediaWindowOutcome(pending.window, { subjectRef, response: input.response, observationId: input.observation.id });
      if (folded.refusal !== null) counters[folded.refusal] = 1;
      visit = asStored({ ...asked, outcomes: [...asked.outcomes, folded.outcome] });
      run = runMediaVisit(visit);
      for (const [name, by] of Object.entries(run.counters)) counters[name] = (counters[name] ?? 0) + by;
      next = { ...next, ...run.page };
    }

    if (run !== null && run.kind === "need") {
      return {
        work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...next, visit } },
        followups: [],
        counters,
      };
    }
    let receipt: Record<string, unknown>;
    if (run === null) {
      // The visit this step served does not replay to the window it asked
      // for: it began under other visit rules (a deploy between its plan and
      // this apply, a re-apply from the journal after the restart). It ends
      // without a look — the answer stays journaled and canonicalized — and
      // its item's breaker opens, so a visit that never replays costs that
      // item its ladder, never the walk: the next plan starts the next due
      // item afresh under today's rules.
      await recordQueueSubjectFailures(tx, { pageId: input.pageId, plane: PLANE, subjectRefs: [subjectRef], now });
      receipt = {
        subjectRef,
        outcome: "abandoned",
        reason: pending === null ? "visit_diverged" : "window_changed",
        windows: asked.outcomes.length,
        at: now.toISOString(),
      };
      counters.media_visit_abandoned = (counters.media_visit_abandoned ?? 0) + 1;
    } else if (run.kind === "failed") {
      // A 2xx that is no answer about this item: its breaker, and the windows
      // its walk had accepted stay in its cursor.
      await recordQueueSubjectFailures(tx, { pageId: input.pageId, plane: PLANE, subjectRefs: [subjectRef], now });
      if (run.progress !== null) {
        await recordMediaStatsBackfillCursor(tx, { pageId: input.pageId, subjectRef, backfillCursor: run.progress });
      }
      receipt = { subjectRef, outcome: "failed", windows: visit.outcomes.length, at: now.toISOString() };
      counters.media_visits_failed = 1;
    } else if (run.visited !== null) {
      await recordMediaStatsVisit(tx, {
        pageId: input.pageId,
        subjectRef,
        tier: asked.snapshot.tier,
        knownCount: run.visited.knownCount,
        visitedAt: now,
        nextDueAt: new Date(now.getTime() + tierEveryMs(mediaStatsOwnerTiers(input.page), asked.snapshot.tier)),
        backfillCursor: run.visited.backfillCursor,
        clearDirty: run.visited.clearDirty,
      });
      await clearQueueSubjectBlocks(tx, { pageId: input.pageId, plane: PLANE, subjectRefs: [subjectRef] });
      receipt = {
        subjectRef,
        outcome: "visited",
        tier: asked.snapshot.tier,
        windows: visit.outcomes.length,
        buckets: run.visited.knownCount,
        at: now.toISOString(),
      };
      counters.media_visited = 1;
    } else {
      if (run.progress !== null) {
        await recordMediaStatsBackfillProgress(tx, { pageId: input.pageId, subjectRef, backfillCursor: run.progress });
      }
      receipt = { subjectRef, outcome: "no_look", windows: visit.outcomes.length, at: now.toISOString() };
    }
    next = { ...next, last: receipt };
    const coverageDue = cursor.coverageWrittenAt === null || now.getTime() - Date.parse(cursor.coverageWrittenAt) >= COVERAGE_EVERY_MS;
    if (coverageDue) {
      await writeQueueCoverage(tx, { pageId: input.pageId, now, mode: next.longTailWindowMode, tiers: mediaStatsOwnerTiers(input.page) });
      next = { ...next, coverageWrittenAt: now.toISOString() };
    }
    // The walk row stays: the next plan takes the next due item, or rests.
    return { work: { satisfiesRevision: true, nextDueAt: now, cursor: next, result: receipt }, followups: [], counters };
  },

  async onSubjectOutcome(tx, work, outcome, step): Promise<void> {
    if (outcome.kind === "ok") return;
    const visit = stepOf(step.request).visit;
    if (visit === undefined) return;
    const subjectRef = visit.snapshot.subjectRef;
    await recordQueueSubjectFailures(tx, { pageId: work.pageId, plane: PLANE, subjectRefs: [subjectRef], now: new Date() });
    // Keep what the walk accepted before the failed window (its status is
    // read by the next plan, which may still fall back from a refused 90-day
    // window; the visit then writes its cursor anyway). A visit that no
    // longer replays keeps nothing: the plan abandons it.
    const pending = replayMediaVisit(visit);
    if (pending === null || pending.kind !== "need") return;
    const run = replayMediaVisit({
      ...visit,
      outcomes: [...visit.outcomes, { key: pending.window.key, failed: { httpStatus: null, retryAfter: false } }],
    });
    if (run !== null && run.kind === "failed" && run.progress !== null) {
      await recordMediaStatsBackfillCursor(tx, { pageId: work.pageId, subjectRef, backfillCursor: run.progress });
    }
  },
};
