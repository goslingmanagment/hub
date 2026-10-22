import {
  upsertCreatorStatsActiveHours,
  upsertCreatorStatsBenchmarks,
  upsertCreatorStatsGeo,
  upsertCreatorStatsMediaShown,
  upsertCreatorStatsTags,
  type CreatorStatsLineage,
  type Database,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { parseFanslyMetadataAccountCreatedAt } from "../../../services/fansly.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";
import { CREATOR_STATS_MAX_SPAN_DAYS, DAY_MS, previousSpan, utcDayStart, type CreatorStatsWindow } from "../lib/creator-stats.ts";
import {
  AUDIENCE_ROWS_LIMIT,
  AUDIENCE_SETTLE_MS,
  AUDIENCE_SOURCES,
  HOUR_MS,
  daysEndingWith,
  lastFullHour,
  lastSettledDay,
  monthEndingWith,
  parseActiveHoursAnswer,
  parseBenchmarksAnswer,
  parseGeoAnswer,
  parseMediaShownAnswer,
  parseTagsAnswer,
  previousMonth,
  steadyGeoDays,
  type AudienceEcho,
  type AudienceSource,
} from "../lib/creator-stats-audience.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";

// The audience plane of Fansly's creator statistics of 2026-10 (map:
// reference/fansly-creator-stats §5.5–5.9; plan: 8-docs
// 2026-10-09-hub-fansly-stats-collection, impl-2026-10-22.md, PR C). The answer
// is journaled first (kinds `creator_stats_geo`, `creator_stats_tags`,
// `creator_stats_media_benchmarks`, `creator_stats_media_shown`,
// `creator_stats_active_hours`); the apply writes its typed rows
// (`fansly_creator_stats_*`, 0294) in the same transaction, and the plane's
// coverage (`creator_stats_audience`).
//
// audience (poll, every 6 h): geo per surface (0, 1, 4) for every UTC day not
// yet read after it settled — yesterday once, final — and today, partial;
// tags (kind 1) per surface over the last 30 days (window totals with lift,
// and each tag's views per day). Six requests a run, nine on the first run
// after a day settles.
//
// audience-daily (poll, once per settled day): media benchmarks per surface
// over the last 30 settled days, active hours per surface over the last 90
// (UTC: `timezoneOffsetMinutes=0`, shifted at read time). Six requests.
//
// media-shown (poll, every hour): each full hour since the last one read, at
// most a day back — `end` the hour, `hours=1`: one answer carries every
// surface. One request an hour.
//
// audience-history (goal: owner, a new page): tags (kind 1) per surface in
// spans of 400 days back to the account's creation (each tag's views per day),
// one probe of kind 2 (the tags of posts: empty on the sampled account), then
// geo per surface per calendar month back to the account's creation.

export type CreatorStatsAudienceVariant = "audience" | "daily" | "media-shown" | "history";

/** At most this many days back a steady geo sweep fills one day at a time. */
const GEO_CATCH_UP_DAYS = 7;
/** The steady tags window (lift is served up to 120 days). */
const TAGS_STEADY_DAYS = 30;
/** The benchmarks and active-hours windows of the daily poll (the server's
 *  caps are 120 and 90 days, map §4). */
const BENCHMARKS_DAYS = 30;
const ACTIVE_HOURS_DAYS = 90;
/** How long after an hour ends `media/shown` is read for it. */
const MEDIA_SHOWN_LAG_MS = 15 * 60_000;
/** At most this many past hours a media-shown run catches up. */
const MEDIA_SHOWN_CATCH_UP_HOURS = 24;

// ── asks ─────────────────────────────────────────────────────────────────────

type Ask =
  | { route: "geo" | "benchmarks" | "active_hours"; source: AudienceSource; window: CreatorStatsWindow }
  | { route: "tags"; source: AudienceSource; kind: 1 | 2; window: CreatorStatsWindow }
  | { route: "media_shown"; endHourMs: number; hours: number };

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function windowOf(value: unknown): CreatorStatsWindow | null {
  const record = recordOf(value);
  const afterMs = int(record.afterMs);
  const beforeMs = int(record.beforeMs);
  return afterMs === null || beforeMs === null || afterMs > beforeMs ? null : { afterMs, beforeMs };
}

function sourceOf(value: unknown): AudienceSource | null {
  return AUDIENCE_SOURCES.find((source) => source === value) ?? null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function requestFor(ask: Ask, step: Record<string, unknown>): RequestPlan {
  switch (ask.route) {
    case "geo":
      return { spec: "stats.geo", params: { source: ask.source, ...ask.window, limit: AUDIENCE_ROWS_LIMIT }, step };
    case "tags":
      return { spec: "stats.tags", params: { source: ask.source, kind: ask.kind, ...ask.window, limit: AUDIENCE_ROWS_LIMIT }, step };
    case "benchmarks":
      return { spec: "stats.media_benchmarks", params: { source: ask.source, ...ask.window }, step };
    case "active_hours":
      return { spec: "stats.active_hours", params: { source: ask.source, ...ask.window, timezoneOffsetMinutes: 0 }, step };
    case "media_shown":
      return { spec: "stats.media_shown", params: { endMs: ask.endHourMs, hours: ask.hours }, step };
  }
}

/** The ask a request made, read back from the request itself. */
function askOf(request: RequestPlan): Ask | null {
  const params = recordOf(request.params);
  if (request.spec === "stats.media_shown") {
    const endHourMs = int(params.endMs);
    const hours = int(params.hours);
    return endHourMs === null || hours === null ? null : { route: "media_shown", endHourMs, hours };
  }
  const source = sourceOf(params.source);
  const window = windowOf(params);
  if (source === null || window === null) return null;
  switch (request.spec) {
    case "stats.geo":
      return { route: "geo", source, window };
    case "stats.tags":
      return params.kind === 1 || params.kind === 2 ? { route: "tags", source, kind: params.kind, window } : null;
    case "stats.media_benchmarks":
      return { route: "benchmarks", source, window };
    case "stats.active_hours":
      return params.timezoneOffsetMinutes === 0 ? { route: "active_hours", source, window } : null;
    default:
      return null;
  }
}

/** The coverage scope of an ask (without the steady/history prefix). */
function scopeOf(ask: Ask): string {
  switch (ask.route) {
    case "media_shown":
      return "media_shown";
    case "tags":
      return `tags:${ask.kind}:${ask.source}`;
    default:
      return `${ask.route}:${ask.source}`;
  }
}

function sameWindow(a: CreatorStatsWindow, b: CreatorStatsWindow): boolean {
  return a.afterMs === b.afterMs && a.beforeMs === b.beforeMs;
}

/** One ask as text: what a step planned and what its request sent compare equal. */
function askKey(ask: Ask): string {
  switch (ask.route) {
    case "media_shown":
      return `media_shown:${ask.endHourMs}:${ask.hours}`;
    case "tags":
      return `tags:${ask.kind}:${ask.source}:${ask.window.afterMs}:${ask.window.beforeMs}`;
    default:
      return `${ask.route}:${ask.source}:${ask.window.afterMs}:${ask.window.beforeMs}`;
  }
}

function sameAsk(a: Ask, b: Ask): boolean {
  return askKey(a) === askKey(b);
}

// ── one answer ───────────────────────────────────────────────────────────────

interface Written {
  /** What the answer is about: the window it served, or the hours. */
  extent: { afterMs: number; beforeMs: number };
  /** The window a windowed answer served (null for media/shown). */
  served: CreatorStatsWindow | null;
  counters: Record<string, number>;
  /** Why the claim is weaker than "the whole window as asked". */
  reasonCode: "rows_at_limit" | "window_shortened" | "span_moved" | null;
  /** Rows the answer carried (tags: rows of the window). */
  rows: number;
}

function invalid(ask: Ask): never {
  throw new ApplyQuarantine("creator_stats_response_invalid", { route: ask.route });
}

/** The window an answer stands for: the echoed one, or the asked one. */
function servedOf(ask: Exclude<Ask, { route: "media_shown" }>, echo: AudienceEcho): CreatorStatsWindow {
  if (echo.source !== null && echo.source !== ask.source) {
    throw new ApplyQuarantine("creator_stats_answer_mismatch", { route: ask.route, asked: ask.source, served: echo.source });
  }
  return echo.served ?? ask.window;
}

function windowReason(ask: Exclude<Ask, { route: "media_shown" }>, served: CreatorStatsWindow): Written["reasonCode"] {
  return served.afterMs > ask.window.afterMs || served.beforeMs !== ask.window.beforeMs ? "window_shortened" : null;
}

function skippedCounter(skipped: number): Record<string, number> {
  return skipped > 0 ? { creator_stats_rows_skipped: skipped } : {};
}

async function writeAnswer(tx: Database, input: ApplyInput, ask: Ask): Promise<Written> {
  const lineage: CreatorStatsLineage = { pageId: input.pageId, observationId: input.observation.id, capturedAt: input.observation.receivedAt };
  if (ask.route === "media_shown") {
    const answer = parseMediaShownAnswer(input.response);
    if (answer === null) invalid(ask);
    const endHourMs = answer.endHourMs ?? ask.endHourMs;
    const hours = answer.hours ?? ask.hours;
    const written = await upsertCreatorStatsMediaShown(tx, lineage, { endHour: new Date(endHourMs), hours }, answer.rows);
    return {
      extent: { afterMs: endHourMs - (hours - 1) * HOUR_MS, beforeMs: endHourMs + HOUR_MS },
      served: null,
      counters: { media_shown_rows: written, ...skippedCounter(answer.skipped) },
      reasonCode: endHourMs !== ask.endHourMs || hours !== ask.hours ? "span_moved" : null,
      rows: answer.rows.length,
    };
  }

  const windowOfServed = (served: CreatorStatsWindow) => ({ source: ask.source, afterDay: isoDay(served.afterMs), beforeDay: isoDay(served.beforeMs) });
  const extentOf = (served: CreatorStatsWindow) => ({ afterMs: served.afterMs, beforeMs: Math.min(served.beforeMs + DAY_MS, input.now.getTime()) });
  switch (ask.route) {
    case "geo": {
      const answer = parseGeoAnswer(input.response);
      if (answer === null) invalid(ask);
      const served = servedOf(ask, answer);
      const written = await upsertCreatorStatsGeo(tx, lineage, windowOfServed(served), answer.rows);
      const cut = answer.viewRows >= AUDIENCE_ROWS_LIMIT || answer.profileRows >= AUDIENCE_ROWS_LIMIT;
      return {
        extent: extentOf(served),
        served,
        counters: { geo_rows: written, ...(cut ? { creator_stats_rows_at_limit: 1 } : {}), ...skippedCounter(answer.skipped) },
        reasonCode: cut ? "rows_at_limit" : windowReason(ask, served),
        rows: answer.rows.length,
      };
    }
    case "tags": {
      const answer = parseTagsAnswer(input.response);
      if (answer === null) invalid(ask);
      if (answer.kind !== null && answer.kind !== ask.kind) {
        throw new ApplyQuarantine("creator_stats_answer_mismatch", { route: ask.route, asked: ask.kind, served: answer.kind });
      }
      const served = servedOf(ask, answer);
      const written = await upsertCreatorStatsTags(tx, lineage, windowOfServed(served), {
        kind: ask.kind,
        liftAvailable: answer.liftAvailable,
        rows: answer.rows,
        series: answer.series,
        names: answer.names,
      });
      const cut = answer.rows.length >= AUDIENCE_ROWS_LIMIT;
      return {
        extent: extentOf(served),
        served,
        counters: {
          tags_rows: written.tags ?? 0,
          tag_series_rows: written.tag_series ?? 0,
          tag_names: written.tag_names ?? 0,
          ...(cut ? { creator_stats_rows_at_limit: 1 } : {}),
          ...skippedCounter(answer.skipped),
        },
        reasonCode: cut ? "rows_at_limit" : windowReason(ask, served),
        rows: answer.rows.length,
      };
    }
    case "benchmarks": {
      const answer = parseBenchmarksAnswer(input.response);
      if (answer === null) invalid(ask);
      const served = servedOf(ask, answer);
      const written = await upsertCreatorStatsBenchmarks(tx, lineage, windowOfServed(served), answer.rows);
      return {
        extent: extentOf(served),
        served,
        counters: { benchmark_rows: written, ...skippedCounter(answer.skipped) },
        reasonCode: windowReason(ask, served),
        rows: answer.rows.length,
      };
    }
    case "active_hours": {
      const answer = parseActiveHoursAnswer(input.response);
      if (answer === null) invalid(ask);
      if (answer.timezoneOffsetMinutes !== null && answer.timezoneOffsetMinutes !== 0) {
        throw new ApplyQuarantine("creator_stats_answer_mismatch", { route: ask.route, asked: 0, served: answer.timezoneOffsetMinutes });
      }
      const served = servedOf(ask, answer);
      const written = await upsertCreatorStatsActiveHours(tx, lineage, windowOfServed(served), answer.cells);
      return {
        extent: extentOf(served),
        served,
        counters: { active_hours_cells: written },
        reasonCode: windowReason(ask, served),
        rows: answer.cells.length,
      };
    }
  }
}

/** The coverage of one read under its scope. */
async function claim(tx: Database, input: ApplyInput, scopeRef: string, written: Written, replace: boolean): Promise<void> {
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: CAPTURE_COVERAGE_PLANES.creatorStatsAudience,
    scopeRef,
    status: "window_captured",
    acquisitionMode: "retroactive",
    proof: "none",
    proofObservationId: input.observation.id,
    oldestCapturedAt: new Date(written.extent.afterMs),
    newestCapturedAt: new Date(written.extent.beforeMs),
    replaceWindowBounds: replace,
    reasonCode: written.reasonCode,
    cursor: { ...written.extent },
  });
}

// ── steady sweeps ────────────────────────────────────────────────────────────

/** A sweep's anchor: the instants it was planned around (JSON numbers). */
type Anchor = Record<string, number>;

/** What a finished sweep leaves for the next one. */
type Memo = Record<string, number | null>;

interface SweepCursor {
  memo: Memo;
  sweep: { anchor: Anchor; index: number } | null;
}

interface SweepDefinition {
  /** A new sweep's anchor, or the instant one is due. */
  start(now: Date, memo: Memo): { anchor: Anchor } | { waitUntil: Date };
  steps(anchor: Anchor): Ask[];
  /** Whether the step's coverage starts its scope afresh (else it extends it). */
  replaces(anchor: Anchor, index: number, memo: Memo): boolean;
  finish(anchor: Anchor, memo: Memo): { memo: Memo; nextDueAt?: Date };
}

function anchorOf(value: unknown): Anchor | null {
  const record = recordOf(value);
  const anchor: Anchor = {};
  for (const [key, item] of Object.entries(record)) {
    const parsed = int(item);
    if (parsed === null) return null;
    anchor[key] = parsed;
  }
  return Object.keys(anchor).length > 0 ? anchor : null;
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function parseSweepCursor(value: unknown): SweepCursor {
  const record = recordOf(value);
  const memo: Memo = {};
  for (const [key, item] of Object.entries(recordOf(record.memo))) memo[key] = int(item);
  const sweep = recordOf(record.sweep);
  const anchor = anchorOf(sweep.anchor);
  const index = int(sweep.index);
  return { memo, sweep: anchor === null || index === null || index < 0 ? null : { anchor, index } };
}

function sweepModule(definition: SweepDefinition): ResourceModule {
  return {
    async plan(work, ctx): Promise<StepPlan> {
      const cursor = parseSweepCursor(work.cursor);
      let sweep = cursor.sweep;
      if (sweep === null) {
        const started = definition.start(ctx.now, cursor.memo);
        if ("waitUntil" in started) return { kind: "wait", reason: "not_due", until: started.waitUntil };
        sweep = { anchor: started.anchor, index: 0 };
      }
      const ask = definition.steps(sweep.anchor)[sweep.index];
      if (ask === undefined) return { kind: "quarantine", reason: "creator_stats_step_out_of_range" };
      return { kind: "request", request: requestFor(ask, { anchor: sweep.anchor, index: sweep.index }) };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const cursor = parseSweepCursor(input.work.cursor);
      const step = recordOf(input.request.step);
      const anchor = anchorOf(step.anchor);
      const index = int(step.index);
      const asked = askOf(input.request);
      const expected = anchor === null || index === null ? undefined : definition.steps(anchor)[index];
      const continues = cursor.sweep === null
        ? index === 0
        : anchor !== null && sameAnchor(cursor.sweep.anchor, anchor) && cursor.sweep.index === index;
      if (anchor === null || index === null || asked === null || expected === undefined || !continues || !sameAsk(expected, asked)) {
        throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, index: cursor.sweep?.index ?? 0 });
      }
      const written = await writeAnswer(tx, input, asked);
      await claim(tx, input, `steady:${scopeOf(asked)}`, written, definition.replaces(anchor, index, cursor.memo));
      const next = index + 1;
      if (next < definition.steps(anchor).length) {
        return {
          work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { memo: cursor.memo, sweep: { anchor, index: next } } },
          followups: [],
          counters: written.counters,
        };
      }
      const finished = definition.finish(anchor, cursor.memo);
      return {
        work: {
          satisfiesRevision: true,
          close: "done",
          closeReason: "sweep_complete",
          cursor: { memo: finished.memo, sweep: null },
          ...(finished.nextDueAt === undefined ? {} : { nextDueAt: finished.nextDueAt }),
          result: { sweptAt: input.now.toISOString() },
        },
        followups: [],
        counters: { ...written.counters, creator_stats_sweeps: 1 },
      };
    },
  };
}

/** Every UTC day from `firstMs` to `lastMs`, both included. */
function daysFrom(firstMs: number, lastMs: number): number[] {
  const days: number[] = [];
  for (let day = firstMs; day <= lastMs; day += DAY_MS) days.push(day);
  return days;
}

const audienceSweep: SweepDefinition = {
  start(now, memo) {
    const { firstDayMs, todayMs } = steadyGeoDays(now, memo.finalThroughMs ?? null, GEO_CATCH_UP_DAYS);
    return { anchor: { firstDayMs, todayMs, settledMs: lastSettledDay(now) } };
  },
  steps(anchor) {
    const geo = daysFrom(anchor.firstDayMs!, anchor.todayMs!).flatMap((day) =>
      AUDIENCE_SOURCES.map((source): Ask => ({ route: "geo", source, window: { afterMs: day, beforeMs: day } })));
    const tags = AUDIENCE_SOURCES.map((source): Ask => ({
      route: "tags", source, kind: 1, window: daysEndingWith(anchor.todayMs!, TAGS_STEADY_DAYS),
    }));
    return [...geo, ...tags];
  },
  replaces(anchor, index, memo) {
    // The day-by-day geo claim extends while the days meet; a first sweep or
    // one after a gap starts it afresh. The rolling tags window replaces.
    const geoSteps = AUDIENCE_SOURCES.length * daysFrom(anchor.firstDayMs!, anchor.todayMs!).length;
    if (index >= geoSteps) return true;
    const finalThrough = memo.finalThroughMs ?? null;
    return index < AUDIENCE_SOURCES.length && (finalThrough === null || anchor.firstDayMs! > finalThrough + DAY_MS);
  },
  finish(anchor, memo) {
    const settled = Math.min(anchor.settledMs!, anchor.todayMs! - DAY_MS);
    return { memo: { ...memo, finalThroughMs: Math.max(memo.finalThroughMs ?? settled, settled) } };
  },
};

const dailySweep: SweepDefinition = {
  start(now, memo) {
    const settledMs = lastSettledDay(now);
    const done = memo.settledMs ?? null;
    // One sweep per settled day: the next is due when the next day settles.
    if (done !== null && settledMs <= done) return { waitUntil: new Date(done + 2 * DAY_MS + AUDIENCE_SETTLE_MS) };
    return { anchor: { settledMs } };
  },
  steps(anchor) {
    return [
      ...AUDIENCE_SOURCES.map((source): Ask => ({ route: "benchmarks", source, window: daysEndingWith(anchor.settledMs!, BENCHMARKS_DAYS) })),
      ...AUDIENCE_SOURCES.map((source): Ask => ({ route: "active_hours", source, window: daysEndingWith(anchor.settledMs!, ACTIVE_HOURS_DAYS) })),
    ];
  },
  replaces: () => true,
  finish(anchor, memo) {
    return { memo: { ...memo, settledMs: anchor.settledMs! } };
  },
};

const mediaShownSweep: SweepDefinition = {
  start(now, memo) {
    const lastMs = lastFullHour(now, MEDIA_SHOWN_LAG_MS);
    const read = memo.lastHourMs ?? null;
    const firstMs = Math.max(read === null ? lastMs : read + HOUR_MS, lastMs - (MEDIA_SHOWN_CATCH_UP_HOURS - 1) * HOUR_MS);
    if (firstMs > lastMs) return { waitUntil: new Date(firstMs + HOUR_MS + MEDIA_SHOWN_LAG_MS) };
    return { anchor: { firstHourMs: firstMs, lastHourMs: lastMs } };
  },
  steps(anchor) {
    const asks: Ask[] = [];
    for (let hour = anchor.firstHourMs!; hour <= anchor.lastHourMs!; hour += HOUR_MS) asks.push({ route: "media_shown", endHourMs: hour, hours: 1 });
    return asks;
  },
  replaces(anchor, index, memo) {
    const read = memo.lastHourMs ?? null;
    return index === 0 && (read === null || anchor.firstHourMs! > read + HOUR_MS);
  },
  finish(anchor, memo) {
    // The next hour is read as soon as it is full and the lag has passed.
    return { memo: { ...memo, lastHourMs: anchor.lastHourMs! }, nextDueAt: new Date(anchor.lastHourMs! + 2 * HOUR_MS + MEDIA_SHOWN_LAG_MS) };
  },
};

// ── history ──────────────────────────────────────────────────────────────────

/** The walk's phases, in order. */
const HISTORY_PHASES = ["tags", "post_tags", "geo"] as const;
type HistoryPhase = (typeof HISTORY_PHASES)[number];

interface HistoryCursor {
  phase: HistoryPhase;
  sourceIndex: number;
  /** The next window of the phase's walk; null: its first. */
  window: CreatorStatsWindow | null;
  /** The account's first UTC day: the walk's floor. */
  floorMs: number | null;
  /** The walk's last day (the last settled day when it started). */
  lastDayMs: number | null;
}

function parseHistoryCursor(value: unknown): HistoryCursor {
  const record = recordOf(value);
  const phase = HISTORY_PHASES.find((name) => name === record.phase) ?? "tags";
  const sourceIndex = int(record.sourceIndex);
  return {
    phase,
    sourceIndex: sourceIndex !== null && sourceIndex >= 0 && sourceIndex < AUDIENCE_SOURCES.length ? sourceIndex : 0,
    window: windowOf(record.window),
    floorMs: int(record.floorMs),
    lastDayMs: int(record.lastDayMs),
  };
}

/** A span of at most 400 days that ends with `lastDayMs`. */
function lastSpan(lastDayMs: number, floorMs: number): CreatorStatsWindow {
  return { afterMs: Math.max(utcDayStart(floorMs), lastDayMs - (CREATOR_STATS_MAX_SPAN_DAYS - 1) * DAY_MS), beforeMs: lastDayMs };
}

function firstWindow(phase: HistoryPhase, lastDayMs: number, floorMs: number): CreatorStatsWindow | null {
  return phase === "geo" ? monthEndingWith(lastDayMs, floorMs) : lastSpan(lastDayMs, floorMs);
}

function historyAsk(phase: HistoryPhase, sourceIndex: number, window: CreatorStatsWindow): Ask {
  const source = AUDIENCE_SOURCES[sourceIndex]!;
  switch (phase) {
    case "tags":
      return { route: "tags", source, kind: 1, window };
    case "post_tags":
      return { route: "tags", source: 0, kind: 2, window };
    case "geo":
      return { route: "geo", source, window };
  }
}

/** The phase's position after the current one: the next surface, else the next phase. */
function nextPosition(phase: HistoryPhase, sourceIndex: number): { phase: HistoryPhase; sourceIndex: number } | null {
  // The kind-2 probe is one request (surface 0), not one per surface.
  if (phase !== "post_tags" && sourceIndex + 1 < AUDIENCE_SOURCES.length) return { phase, sourceIndex: sourceIndex + 1 };
  const next = HISTORY_PHASES[HISTORY_PHASES.indexOf(phase) + 1];
  return next === undefined ? null : { phase: next, sourceIndex: 0 };
}

async function accountFloor(db: Database, pageId: number): Promise<number | null> {
  const facts = await readFanslyPageFacts(db, pageId);
  const created = facts === null ? null : parseFanslyMetadataAccountCreatedAt(facts.metadata);
  return created === null ? null : utcDayStart(created.getTime());
}

const historyModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseHistoryCursor(work.cursor);
    const floorMs = cursor.floorMs ?? await accountFloor(ctx.db, ctx.pageId);
    if (floorMs === null) {
      return {
        kind: "wait", reason: "dependency", until: null,
        enqueue: [{ resource: "account.poll", demand: { reason: "dependency:creator-stats.audience-history" } }],
      };
    }
    const lastDayMs = cursor.lastDayMs ?? lastSettledDay(ctx.now);
    const window = lastDayMs < floorMs ? null : cursor.window ?? firstWindow(cursor.phase, lastDayMs, floorMs);
    if (window === null) return { kind: "done", reason: "account_newer_than_history", cursor: { ...cursor, floorMs, lastDayMs: null } };
    const step = { phase: cursor.phase, sourceIndex: cursor.sourceIndex, window, floorMs, lastDayMs };
    return { kind: "request", request: requestFor(historyAsk(cursor.phase, cursor.sourceIndex, window), step) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseHistoryCursor(input.work.cursor);
    const step = recordOf(input.request.step);
    const window = windowOf(step.window);
    const floorMs = int(step.floorMs);
    const lastDayMs = int(step.lastDayMs);
    const asked = askOf(input.request);
    if (step.phase !== cursor.phase || int(step.sourceIndex) !== cursor.sourceIndex || window === null || floorMs === null
      || lastDayMs === null || asked === null || !sameAsk(asked, historyAsk(cursor.phase, cursor.sourceIndex, window))
      || (cursor.window !== null && !sameWindow(cursor.window, window))
      || (cursor.floorMs !== null && cursor.floorMs !== floorMs) || (cursor.lastDayMs !== null && cursor.lastDayMs !== lastDayMs)) {
      throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, phase: cursor.phase });
    }
    const written = await writeAnswer(tx, input, asked);
    await claim(tx, input, `history:${scopeOf(asked)}`, written, false);
    const counters = {
      ...written.counters,
      ...(cursor.phase === "post_tags" ? { creator_stats_post_tags_rows: written.rows } : {}),
    };

    // A walking phase goes on from the first day both asked and served (a
    // shortened span is continued from what the server served), to the floor.
    const from = Math.max(written.served?.afterMs ?? window.afterMs, window.afterMs);
    const nextWindow = cursor.phase === "geo" ? previousMonth(from, floorMs)
      : cursor.phase === "tags" ? previousSpan(from, floorMs)
      : null;
    if (nextWindow !== null) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, window: nextWindow, floorMs, lastDayMs } },
        followups: [],
        counters,
      };
    }
    const next = nextPosition(cursor.phase, cursor.sourceIndex);
    if (next !== null) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...next, window: null, floorMs, lastDayMs } },
        followups: [],
        counters,
      };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "history_complete",
        cursor: { phase: HISTORY_PHASES[0], sourceIndex: 0, window: null, floorMs, lastDayMs: null },
        result: { floor: isoDay(floorMs), lastDay: isoDay(lastDayMs), completedAt: input.now.toISOString() },
      },
      followups: [],
      counters: { ...counters, creator_stats_history_complete: 1 },
    };
  },
};

export function creatorStatsAudienceModule(variant: CreatorStatsAudienceVariant): ResourceModule {
  switch (variant) {
    case "audience":
      return sweepModule(audienceSweep);
    case "daily":
      return sweepModule(dailySweep);
    case "media-shown":
      return sweepModule(mediaShownSweep);
    case "history":
      return historyModule;
  }
}
