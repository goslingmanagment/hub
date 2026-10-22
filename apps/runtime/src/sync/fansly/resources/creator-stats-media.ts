import {
  countCreatorStatsMediaQueue,
  pickCreatorStatsMediaDue,
  queueCreatorStatsMediaOffers,
  readCreatorStatsMediaQueueRow,
  recordCreatorStatsMediaRead,
  recordCreatorStatsMediaVisit,
  seedCreatorStatsMediaQueue,
  upsertCreatorStatsMediaAnswer,
  upsertCreatorStatsMediaTop,
  CREATOR_STATS_MEDIA_PLANE,
  type CaptureCoverageStatus,
  type CreatorStatsLineage,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, DemandSignal, LocalApplyInput, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";
import { DAY_MS, trailingDays, type CreatorStatsWindow } from "../lib/creator-stats.ts";
import {
  mediaAgeDays,
  mediaTierIndex,
  mediaVisitAsks,
  parseMediaAnswer,
  parseMediaQueueState,
  parseMediaTopAnswer,
  type MediaAsk,
  type MediaSurface,
  type MediaTier,
} from "../lib/creator-stats-media.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import { clearQueueSubjectBlocks, recordQueueSubjectFailures } from "../lib/subject-queue.ts";
import { fanslyResourceSpec } from "../registry.ts";

// `creator-stats.media-top` and `creator-stats.media`: the media plane of
// Fansly's creator statistics of 2026-10 (`/account/stats/media/top` and
// `/account/stats/media`; map: reference/fansly-creator-stats §5.3–5.4; plan:
// 8-docs 2026-10-09-hub-fansly-stats-collection, impl-2026-10-22.md "B"). The
// answer is journaled first (kinds `creator_stats_media_top`,
// `creator_stats_media`); the apply writes its typed rows
// (`fansly_creator_stats_media_*`, 0293) in the same transaction.
//
// media-top (poll, every 3 h): the top 100 offers by views of surfaces 0, 1
// and 4 over the last 7 days, and once a UTC day over the last 120 (the most
// the route serves) — three requests a run, six on the day's first. An offer
// the list names that the walk's queue lacks is queued, and the walk is asked
// to look (a demand, not a second request); an offer on surface 4's list is
// read on that surface too while it is young.
//
// media (a standing walk over `subject_refresh_state` plane
// `creator_stats_media`, one row per offer): the page's post media (the
// `media_stats` queue, copied in hourly, zero requests) and every offer a top
// list named. One visit reads an offer per surface — 0 and 1 (and 4) while it
// is at most 93 days old, after that `-1` (every surface's days and the likes)
// and 1 (Timeline's totals, retention, hours, tags) — from the day before the
// last day read to today; a surface never read is read from the posting day in
// spans of 400 days, oldest first. How often by the post's age (the registry's
// tiers): ≤ 2 days every 6 h (`hours[]` reach back two days), ≤ 30 days daily,
// ≤ 93 days weekly, older monthly; the youngest tier is always served first.
// A failed read opens the offer's breaker on its queue row (the engine's
// subject ladder), never the walk's.

export const MEDIA_WALK_KEY = "creator-stats.media";

const HOUR_MS = 3_600_000;
const TOP_SOURCES = [0, 1, 4] as const;
const TOP_RECENT_DAYS = 7;
/** The longest window `media/top` serves (map §4). */
const TOP_LONG_DAYS = 120;
/** `media/top` lists at most 100 offers (map §5.3). */
const TOP_LIMIT = 100;
const TOP_ORDER = "views";
/** The walk copies the `media_stats` queue in, and rewrites its coverage, this often. */
const SEED_EVERY_MS = HOUR_MS;
/** A visit still in flight after this long is dropped: its offer stays due
 *  and is read again from what its queue row says was read. */
const VISIT_MAX_AGE_MS = DAY_MS;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowOf(value: unknown): CreatorStatsWindow | null {
  const record = recordOf(value);
  const afterMs = int(record.afterMs);
  const beforeMs = int(record.beforeMs);
  return afterMs === null || beforeMs === null || afterMs > beforeMs ? null : { afterMs, beforeMs };
}

function lineageOf(input: ApplyInput): CreatorStatsLineage {
  return { pageId: input.pageId, observationId: input.observation.id, capturedAt: input.observation.receivedAt };
}

// ── media-top ────────────────────────────────────────────────────────────────

interface TopStep {
  source: (typeof TOP_SOURCES)[number];
  days: number;
}

function topSteps(long: boolean): TopStep[] {
  const recent = TOP_SOURCES.map((source) => ({ source, days: TOP_RECENT_DAYS }));
  return long ? [...recent, ...TOP_SOURCES.map((source) => ({ source, days: TOP_LONG_DAYS }))] : recent;
}

interface TopCursor {
  stepIndex: number;
  /** This run also reads the 120-day windows. */
  long: boolean;
  /** The UTC day the 120-day windows were last read. */
  longDay: string | null;
}

function parseTopCursor(value: unknown): TopCursor {
  const record = recordOf(value);
  const long = record.long === true;
  const index = int(record.stepIndex);
  return {
    stepIndex: index !== null && index >= 0 && index < topSteps(long).length ? index : 0,
    long,
    longDay: text(record.longDay),
  };
}

const mediaTopModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseTopCursor(work.cursor);
    const long = cursor.stepIndex === 0 ? cursor.longDay !== isoDay(ctx.now.getTime()) : cursor.long;
    const step = topSteps(long)[cursor.stepIndex]!;
    const window = trailingDays(ctx.now, step.days);
    return {
      kind: "request",
      request: {
        spec: "stats.media_top",
        params: { source: step.source, mediaType: null, afterMs: window.afterMs, beforeMs: window.beforeMs, orderBy: TOP_ORDER, limit: TOP_LIMIT },
        step: { index: cursor.stepIndex, long, days: step.days, window },
      },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseTopCursor(input.work.cursor);
    const step = recordOf(input.request.step);
    const params = recordOf(input.request.params);
    const asked = windowOf(step.window);
    const askedSource = int(params.source);
    const days = int(step.days);
    const long = step.long === true;
    if (int(step.index) !== cursor.stepIndex || asked === null || askedSource === null || days === null
      || input.request.spec !== "stats.media_top") {
      throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, stepIndex: cursor.stepIndex });
    }
    const answer = parseMediaTopAnswer(input.response);
    if (answer === null) throw new ApplyQuarantine("creator_stats_response_invalid", { spec: "stats.media_top" });
    // Rows and coverage are the surface the server says it answered for.
    const source = answer.source ?? askedSource;
    const served = answer.served ?? asked;
    const written = await upsertCreatorStatsMediaTop(tx, lineageOf(input), {
      source,
      mediaType: answer.mediaType ?? 0,
      orderBy: typeof params.orderBy === "string" ? params.orderBy : TOP_ORDER,
      afterDay: isoDay(served.afterMs),
      beforeDay: isoDay(served.beforeMs),
      rows: answer.rows,
    });
    await writeFanslyLaneCoverage({
      db: tx,
      pageId: input.pageId,
      plane: CAPTURE_COVERAGE_PLANES.creatorStatsMedia,
      scopeRef: `top:${source}:${days}d`,
      status: "window_captured",
      acquisitionMode: "retroactive",
      proof: "none",
      proofObservationId: input.observation.id,
      oldestCapturedAt: new Date(served.afterMs),
      newestCapturedAt: new Date(Math.min(served.beforeMs + DAY_MS, input.now.getTime())),
      replaceWindowBounds: true,
      observedUniqueCount: answer.offers.length,
      reasonCode: served.afterMs > asked.afterMs ? "window_shortened" : null,
      cursor: { afterMs: served.afterMs, beforeMs: served.beforeMs, offers: answer.offers.length },
    });
    const queued = await queueCreatorStatsMediaOffers(tx, { pageId: input.pageId, now: input.now, other: source === 4, offers: answer.offers });
    const followups: DemandSignal[] = queued.queued > 0 ? [{ resource: MEDIA_WALK_KEY, demand: { reason: "media_top_new_offers" } }] : [];
    const counters: Record<string, number> = {
      [`media_top_${source}_${days}d`]: written,
      ...(queued.queued > 0 ? { media_top_offers_queued: queued.queued } : {}),
      ...(queued.marked > 0 ? { media_top_offers_other: queued.marked } : {}),
      ...(answer.skipped > 0 ? { media_top_rows_skipped: answer.skipped } : {}),
    };
    const next = cursor.stepIndex + 1;
    if (next < topSteps(long).length) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, stepIndex: next, long } }, followups, counters };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "sweep_complete",
        cursor: { stepIndex: 0, long: false, longDay: long ? isoDay(input.now.getTime()) : cursor.longDay } satisfies TopCursor,
        result: { sweptAt: input.now.toISOString(), long },
      },
      followups,
      counters: { ...counters, creator_stats_media_top_sweeps: 1 },
    };
  },
};

// ── media (the walk) ─────────────────────────────────────────────────────────

/** One visit of one offer: its requests, decided when it began. */
interface MediaVisit {
  subjectRef: string;
  startedAtMs: number;
  postedAtMs: number | null;
  asks: MediaAsk[];
  /** The request this step makes. */
  index: number;
}

interface WalkCursor {
  /** The visit in flight (its `index` is the next request). */
  visit: MediaVisit | null;
  /** When the `media_stats` queue was last copied in. */
  seededAt: string | null;
  last: Record<string, unknown> | null;
}

const SURFACES: readonly number[] = [-1, 0, 1, 4];

function parseVisit(value: unknown): MediaVisit | null {
  const record = recordOf(value);
  const subjectRef = text(record.subjectRef);
  const startedAtMs = int(record.startedAtMs);
  const index = int(record.index);
  if (subjectRef === null || startedAtMs === null || index === null || index < 0 || !Array.isArray(record.asks)) return null;
  const asks: MediaAsk[] = [];
  for (const raw of record.asks) {
    const window = windowOf(raw);
    const source = int(recordOf(raw).source);
    if (window === null || source === null || !SURFACES.includes(source)) return null;
    asks.push({ source: source as MediaSurface, ...window });
  }
  if (index >= asks.length) return null;
  const posted = int(record.postedAtMs);
  return { subjectRef, startedAtMs, postedAtMs: posted, asks, index };
}

function parseWalkCursor(value: unknown): WalkCursor {
  const record = recordOf(value);
  return {
    visit: parseVisit(record.visit),
    seededAt: text(record.seededAt),
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

/** The walk's age tiers (the registry's). */
function walkTiers(): readonly MediaTier[] {
  const tiers = fanslyResourceSpec(MEDIA_WALK_KEY)?.tiers;
  if (tiers === undefined || tiers.length === 0) throw new Error(`${MEDIA_WALK_KEY} needs its age tiers`);
  return tiers;
}

function walkRecheckMs(): number {
  return fanslyResourceSpec(MEDIA_WALK_KEY)?.standing?.recheckMs ?? HOUR_MS;
}

/** `subject_refresh_state.refresh_class` of a tier: the plane check's names. */
function refreshClassOf(tiers: readonly MediaTier[], tierIndex: number): "fresh" | "mid" | "long_tail" {
  if (tierIndex >= tiers.length - 1) return "long_tail";
  return tierIndex >= tiers.length - 2 ? "mid" : "fresh";
}

function visitRequest(visit: MediaVisit): RequestPlan<"stats.media"> {
  const ask = visit.asks[visit.index]!;
  return {
    spec: "stats.media",
    params: { mediaOfferId: visit.subjectRef, source: ask.source, afterMs: ask.afterMs, beforeMs: ask.beforeMs },
    step: { visit },
  };
}

function sameVisit(a: MediaVisit, b: MediaVisit): boolean {
  return a.subjectRef === b.subjectRef && a.startedAtMs === b.startedAtMs && a.index === b.index;
}

function seedDue(cursor: WalkCursor, now: Date): boolean {
  return cursor.seededAt === null || now.getTime() - Date.parse(cursor.seededAt) >= SEED_EVERY_MS;
}

const mediaWalkModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseWalkCursor(work.cursor);
    const now = ctx.now;
    let visit = cursor.visit;
    if (visit !== null && now.getTime() - visit.startedAtMs > VISIT_MAX_AGE_MS) visit = null;
    if (visit !== null) {
      // A visit whose offer failed (its breaker is open) ends; any other
      // failure (the page's pace, network) asks the same request again.
      const row = await readCreatorStatsMediaQueueRow(ctx.db, { pageId: ctx.pageId, subjectRef: visit.subjectRef });
      const failed = row === null || (row.consecutiveFailures > 0 && row.nextDueAt !== null && row.nextDueAt > now);
      if (!failed) return { kind: "request", request: visitRequest(visit) };
    }
    if (seedDue(cursor, now)) return { kind: "local", reason: "seed_media_queue" };
    const tiers = walkTiers();
    const picked = await pickCreatorStatsMediaDue(ctx.db, { pageId: ctx.pageId, now, tierMaxAgeDays: tiers.map((tier) => tier.maxAgeDays) });
    if (picked.candidate === null) {
      const seedAt = cursor.seededAt === null ? now.getTime() : Date.parse(cursor.seededAt) + SEED_EVERY_MS;
      const until = Math.min(now.getTime() + walkRecheckMs(), seedAt, picked.earliestDueAt?.getTime() ?? Number.POSITIVE_INFINITY);
      return { kind: "wait", reason: "not_due", until: new Date(Math.max(until, now.getTime())) };
    }
    const state = parseMediaQueueState(picked.candidate.backfillCursor);
    const asks = mediaVisitAsks(state, now);
    // Every surface asks at least for today: a visit with nothing to ask
    // would pick the same offer again at once.
    if (asks.length === 0) return { kind: "quarantine", reason: "creator_stats_media_visit_without_window" };
    return {
      kind: "request",
      request: visitRequest({ subjectRef: picked.candidate.subjectRef, startedAtMs: now.getTime(), postedAtMs: state.postedAtMs, asks, index: 0 }),
    };
  },

  /** The plan's `seed_media_queue`: the `media_stats` queue copied in, the
   *  plane's coverage rewritten (zero requests). */
  async applyLocal(tx, input: LocalApplyInput): Promise<ApplyResult> {
    const cursor = parseWalkCursor(input.work.cursor);
    const seeded = await seedCreatorStatsMediaQueue(tx, { pageId: input.pageId, now: input.now });
    const census = await countCreatorStatsMediaQueue(tx, { pageId: input.pageId, now: input.now });
    const status: CaptureCoverageStatus = census.queueSize === 0
      ? "not_started"
      : census.neverVisited === 0 ? "window_captured" : "in_progress";
    await writeFanslyLaneCoverage({
      db: tx,
      pageId: input.pageId,
      plane: CAPTURE_COVERAGE_PLANES.creatorStatsMedia,
      scopeRef: "walk",
      status,
      acquisitionMode: "retroactive",
      proof: "none",
      newestCapturedAt: input.now,
      expectedCount: census.queueSize,
      observedUniqueCount: census.queueSize - census.neverVisited,
      reasonCode: null,
      cursor: { dueNow: census.dueNow, neverVisited: census.neverVisited, failing: census.failing },
    });
    return {
      work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, seededAt: input.now.toISOString() } satisfies WalkCursor },
      followups: [],
      counters: { creator_stats_media_seeded: seeded },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const visit = parseVisit(recordOf(input.request.step).visit);
    if (visit === null) throw new ApplyQuarantine("creator_stats_media_step_missing");
    const ask = visit.asks[visit.index]!;
    const params = recordOf(input.request.params);
    if (input.request.spec !== "stats.media" || params.mediaOfferId !== visit.subjectRef || params.source !== ask.source
      || params.afterMs !== ask.afterMs || params.beforeMs !== ask.beforeMs) {
      throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, subjectRef: visit.subjectRef });
    }
    const cursor = parseWalkCursor(input.work.cursor);
    // A visit's first request starts it (the plan dropped whatever was in
    // flight); a later one must be the cursor's own next request. Anything
    // else is an answer re-applied after the walk moved on: its rows are
    // written, the walk is left as it is.
    const current = visit.index === 0 || (cursor.visit !== null && sameVisit(cursor.visit, visit));
    const subjectRef = visit.subjectRef;
    const answer = parseMediaAnswer(input.response, ask.source);
    if (answer === null || (answer.mediaOfferId !== null && answer.mediaOfferId !== subjectRef)) {
      // A 2xx that is no answer about this offer: its breaker, not the walk's.
      await recordQueueSubjectFailures(tx, { pageId: input.pageId, plane: CREATOR_STATS_MEDIA_PLANE, subjectRefs: [subjectRef], now });
      const reason = answer === null ? "creator_stats_media_answer_invalid" : "creator_stats_media_answer_mismatch";
      const receipt = { subjectRef, outcome: "failed", reason, at: now.toISOString() };
      return {
        work: current
          ? { satisfiesRevision: true, nextDueAt: now, cursor: { ...cursor, visit: null, last: receipt } satisfies WalkCursor, result: receipt }
          : { satisfiesRevision: false, nextDueAt: now },
        followups: [],
        counters: { [reason]: 1 },
      };
    }
    const served = answer.served ?? ask;
    const written = await upsertCreatorStatsMediaAnswer(tx, lineageOf(input), {
      mediaOfferId: subjectRef,
      source: ask.source,
      afterDay: isoDay(served.afterMs),
      beforeDay: isoDay(served.beforeMs),
      capturedDay: isoDay(input.observation.receivedAt.getTime()),
      daily: answer.daily,
      hourly: answer.hourly,
      totals: answer.totals,
      tags: answer.tags,
      tagSeries: answer.tagSeries,
      likes: answer.likes,
    });
    await recordCreatorStatsMediaRead(tx, { pageId: input.pageId, subjectRef, source: ask.source, throughMs: served.beforeMs });
    const counters: Record<string, number> = {};
    for (const [table, n] of Object.entries(written)) if (n > 0) counters[`media_${table}`] = n;
    if (answer.skipped > 0) counters.media_rows_skipped = answer.skipped;
    if (served.afterMs > ask.afterMs) counters.creator_stats_media_window_shortened = 1;
    if (!current) {
      counters.creator_stats_media_step_stale = 1;
      return { work: { satisfiesRevision: false, nextDueAt: now }, followups: [], counters };
    }
    const next = visit.index + 1;
    if (next < visit.asks.length) {
      return {
        work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, visit: { ...visit, index: next } } satisfies WalkCursor },
        followups: [],
        counters,
      };
    }
    const tiers = walkTiers();
    const tierIndex = mediaTierIndex(tiers, mediaAgeDays(visit.postedAtMs, now));
    await recordCreatorStatsMediaVisit(tx, {
      pageId: input.pageId,
      subjectRef,
      visitedAt: now,
      nextDueAt: new Date(now.getTime() + tiers[tierIndex]!.everyMs),
      refreshClass: refreshClassOf(tiers, tierIndex),
    });
    await clearQueueSubjectBlocks(tx, { pageId: input.pageId, plane: CREATOR_STATS_MEDIA_PLANE, subjectRefs: [subjectRef] });
    const receipt = { subjectRef, outcome: "visited", requests: visit.asks.length, tier: tierIndex, at: now.toISOString() };
    // The walk row stays: the next plan takes the next due offer, or rests.
    return {
      work: { satisfiesRevision: true, nextDueAt: now, cursor: { ...cursor, visit: null, last: receipt } satisfies WalkCursor, result: receipt },
      followups: [],
      counters: { ...counters, creator_stats_media_visited: 1 },
    };
  },

  async onSubjectOutcome(tx, work, outcome, step): Promise<void> {
    if (outcome.kind === "ok") return;
    const visit = parseVisit(recordOf(step.request.step).visit);
    if (visit === null) return;
    await recordQueueSubjectFailures(tx, { pageId: work.pageId, plane: CREATOR_STATS_MEDIA_PLANE, subjectRefs: [visit.subjectRef], now: new Date() });
  },
};

export function creatorStatsMediaModule(variant: "media-top" | "media"): ResourceModule {
  return variant === "media-top" ? mediaTopModule : mediaWalkModule;
}
