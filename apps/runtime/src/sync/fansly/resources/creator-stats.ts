import {
  upsertCreatorStatsFollows,
  upsertCreatorStatsProfile,
  upsertCreatorStatsRevenue,
  upsertCreatorStatsSubscriptions,
  upsertCreatorStatsSummary,
  upsertCreatorStatsViews,
  type CreatorStatsLineage,
  type Database,
} from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { parseFanslyMetadataAccountCreatedAt } from "../../../services/fansly.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, StepPlan } from "../../engine/resource.ts";
import {
  CREATOR_STATS_FAMILIES,
  CREATOR_STATS_MAX_SPAN_DAYS,
  CREATOR_STATS_REVENUE_FLOOR_MS,
  DAY_MS,
  parseSeriesAnswer,
  parseSummaryAnswer,
  previousSpan,
  trailingDays,
  utcDayStart,
  type CreatorStatsFamily,
  type CreatorStatsGranularity,
  type CreatorStatsWindow,
  type SeriesAnswer,
} from "../lib/creator-stats.ts";
import { writeFanslyLaneCoverage } from "../lib/lane.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";

// `creator-stats.account` and `creator-stats.history`: the account plane of
// Fansly's creator statistics of 2026-10 (`/account/stats/series` and
// `/account/stats/summary`; map: reference/fansly-creator-stats; plan:
// 8-docs 2026-10-09-hub-fansly-stats-collection, impl-2026-10-22.md). The
// answer is journaled first (kinds `creator_stats_series`,
// `creator_stats_summary`); the apply writes its typed rows
// (`fansly_creator_stats_*`, 0292) in the same transaction, and the plane's
// coverage (`creator_stats_account`): a window read says that a bucket with no
// row in it had no activity.
//
// account (poll, every hour): one request a step — each series family a day
// over the last 14 days (re-reading absorbs Fansly's late corrections),
// hourly views and revenue over the last 3 days, the summaries of the last 30,
// 7 and 90 days (levels, tiers, engagement, and the window totals of the
// periods Fansly's Overview offers: uniques and paying fans are not sums of
// days). Ten requests a run.
//
// history (goal: owner, a new page): the summary and each series family back
// to the account's creation in spans of 400 days (the most the server serves;
// a span it shortens is continued from what it served), monthly revenue in one
// request, hourly views and revenue over the 14 days Fansly keeps them.

export type CreatorStatsVariant = "account" | "history";

const ACCOUNT_STEPS: readonly AccountStep[] = [
  ...CREATOR_STATS_FAMILIES.map((family): AccountStep => ({ kind: "series", family, granularity: "day", days: 14 })),
  { kind: "series", family: "views", granularity: "hour", days: 3 },
  { kind: "series", family: "revenue", granularity: "hour", days: 3 },
  { kind: "summary", days: 30 },
  // Appended, so a run in flight keeps its step indexes.
  { kind: "summary", days: 7 },
  { kind: "summary", days: 90 },
];

type AccountStep =
  | { kind: "series"; family: CreatorStatsFamily; granularity: CreatorStatsGranularity; days: number }
  | { kind: "summary"; days: number };

/** The history walk's phases, in order. */
const HISTORY_PHASES = [
  "summary", ...CREATOR_STATS_FAMILIES, "revenue_month", "views_hour", "revenue_hour",
] as const;
type HistoryPhase = (typeof HISTORY_PHASES)[number];

/** Hourly rows Fansly keeps at account level (map §5.2). */
const HOURLY_KEPT_DAYS = 14;

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

function sameWindow(a: CreatorStatsWindow, b: CreatorStatsWindow): boolean {
  return a.afterMs === b.afterMs && a.beforeMs === b.beforeMs;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** What a step asks: a series family at a granularity, or the summary. */
type Ask = { kind: "series"; family: CreatorStatsFamily; granularity: CreatorStatsGranularity } | { kind: "summary" };

function requestFor(ask: Ask, window: CreatorStatsWindow, step: Record<string, unknown>): RequestPlan {
  return ask.kind === "summary"
    ? { spec: "stats.summary", params: { afterMs: window.afterMs, beforeMs: window.beforeMs }, step }
    : {
      spec: "stats.series",
      params: { family: ask.family, granularity: ask.granularity, afterMs: window.afterMs, beforeMs: window.beforeMs },
      step,
    };
}

/** The ask a request made, read back from the request itself. */
function askOf(request: RequestPlan): Ask | null {
  if (request.spec === "stats.summary") return { kind: "summary" };
  if (request.spec !== "stats.series") return null;
  const params = recordOf(request.params);
  const family = CREATOR_STATS_FAMILIES.find((name) => name === params.family);
  const granularity = params.granularity === "hour" || params.granularity === "day" || params.granularity === "month"
    ? params.granularity
    : null;
  return family === undefined || granularity === null ? null : { kind: "series", family, granularity };
}

function scopeOf(ask: Ask): string {
  return ask.kind === "summary" ? "summary" : `series:${ask.family}:${ask.granularity}`;
}

/** Write one answer's typed rows; the window it served and the counts. */
async function writeAnswer(
  tx: Database,
  input: ApplyInput,
  ask: Ask,
  asked: CreatorStatsWindow,
): Promise<{ served: CreatorStatsWindow; counters: Record<string, number>; dataSince: number | null }> {
  const lineage: CreatorStatsLineage = { pageId: input.pageId, observationId: input.observation.id, capturedAt: input.observation.receivedAt };
  if (ask.kind === "summary") {
    const summary = parseSummaryAnswer(input.response);
    if (summary === null) throw new ApplyQuarantine("creator_stats_response_invalid", { spec: "stats.summary" });
    const served = summary.served ?? asked;
    const written = await upsertCreatorStatsSummary(tx, lineage, {
      afterDay: isoDay(served.afterMs),
      beforeDay: isoDay(served.beforeMs),
      levels: summary.levels,
      tierLevels: summary.tierLevels,
      tiers: summary.tiers,
      engagement: summary.engagement,
      windowTotals: summary.windowTotals,
    });
    return { served, counters: Object.fromEntries(Object.entries(written).map(([table, n]) => [`summary_${table}`, n])), dataSince: summary.dataSince };
  }
  const answer = parseSeriesAnswer(input.response, ask.family, ask.granularity);
  if (answer === null) throw new ApplyQuarantine("creator_stats_response_invalid", { spec: "stats.series", family: ask.family, granularity: ask.granularity });
  const written = await writeSeries(tx, lineage, answer);
  return {
    served: answer.served ?? asked,
    counters: { [`series_${ask.family}_${ask.granularity}`]: written, ...(answer.skipped > 0 ? { series_rows_skipped: answer.skipped } : {}) },
    dataSince: null,
  };
}

async function writeSeries(tx: Database, lineage: CreatorStatsLineage, answer: SeriesAnswer): Promise<number> {
  switch (answer.family) {
    case "views":
      if (answer.granularity === "month") return 0; // views has no monthly form (map §9)
      return upsertCreatorStatsViews(tx, lineage, answer.granularity, answer.rows);
    case "profile":
      return upsertCreatorStatsProfile(tx, lineage, answer.granularity, answer.rows);
    case "follows":
      return upsertCreatorStatsFollows(tx, lineage, answer.granularity, answer.rows);
    case "subscriptions":
      return upsertCreatorStatsSubscriptions(tx, lineage, answer.granularity, answer.rows);
    case "revenue":
      return upsertCreatorStatsRevenue(tx, lineage, answer.granularity, answer.rows);
  }
}

/** The coverage of one window read: the days it served, under its scope. */
async function claimWindow(
  tx: Database,
  input: ApplyInput,
  scopeRef: string,
  served: CreatorStatsWindow,
  replace: boolean,
  reasonCode: string | null,
): Promise<void> {
  await writeFanslyLaneCoverage({
    db: tx,
    pageId: input.pageId,
    plane: CAPTURE_COVERAGE_PLANES.creatorStatsAccount,
    scopeRef,
    status: "window_captured",
    acquisitionMode: "retroactive",
    proof: "none",
    proofObservationId: input.observation.id,
    oldestCapturedAt: new Date(served.afterMs),
    newestCapturedAt: new Date(Math.min(served.beforeMs + DAY_MS, input.now.getTime())),
    replaceWindowBounds: replace,
    reasonCode,
    cursor: { afterMs: served.afterMs, beforeMs: served.beforeMs },
  });
}

// ── account ──────────────────────────────────────────────────────────────────

interface AccountCursor {
  stepIndex: number;
}

function parseAccountCursor(value: unknown): AccountCursor {
  const index = int(recordOf(value).stepIndex);
  return { stepIndex: index !== null && index >= 0 && index < ACCOUNT_STEPS.length ? index : 0 };
}

const accountModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const index = parseAccountCursor(work.cursor).stepIndex;
    const step = ACCOUNT_STEPS[index]!;
    const window = trailingDays(ctx.now, step.days);
    const ask: Ask = step.kind === "summary" ? { kind: "summary" } : { kind: "series", family: step.family, granularity: step.granularity };
    return { kind: "request", request: requestFor(ask, window, { index, window }) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseAccountCursor(input.work.cursor);
    const step = recordOf(input.request.step);
    const asked = windowOf(step.window);
    const ask = askOf(input.request);
    if (int(step.index) !== cursor.stepIndex || asked === null || ask === null) {
      throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, stepIndex: cursor.stepIndex });
    }
    const { served, counters } = await writeAnswer(tx, input, ask, asked);
    // Each summary length is its own steady window.
    const scope = ask.kind === "summary" ? `${scopeOf(ask)}:${Math.round((asked.beforeMs - asked.afterMs) / DAY_MS) + 1}d` : scopeOf(ask);
    await claimWindow(tx, input, `steady:${scope}`, served, true, served.afterMs > asked.afterMs ? "window_shortened" : null);
    const next = cursor.stepIndex + 1;
    if (next < ACCOUNT_STEPS.length) {
      return { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { stepIndex: next } }, followups: [], counters };
    }
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "sweep_complete", cursor: { stepIndex: 0 }, result: { sweptAt: input.now.toISOString() } },
      followups: [],
      counters: { ...counters, creator_stats_sweeps: 1 },
    };
  },
};

// ── history ──────────────────────────────────────────────────────────────────

interface HistoryCursor {
  phase: HistoryPhase;
  /** The next window of a walking phase; null: the phase's first. */
  window: CreatorStatsWindow | null;
  /** The account's first UTC day: the walk's floor. */
  floorMs: number | null;
}

function parseHistoryCursor(value: unknown): HistoryCursor {
  const record = recordOf(value);
  const phase = HISTORY_PHASES.find((name) => name === record.phase) ?? "summary";
  const floorMs = int(record.floorMs);
  return { phase, window: windowOf(record.window), floorMs };
}

function askOfPhase(phase: HistoryPhase): Ask {
  switch (phase) {
    case "summary":
      return { kind: "summary" };
    case "revenue_month":
      return { kind: "series", family: "revenue", granularity: "month" };
    case "views_hour":
      return { kind: "series", family: "views", granularity: "hour" };
    case "revenue_hour":
      return { kind: "series", family: "revenue", granularity: "hour" };
    default:
      return { kind: "series", family: phase, granularity: "day" };
  }
}

/** A phase's first window. */
function firstWindow(phase: HistoryPhase, now: Date, floorMs: number): CreatorStatsWindow {
  const today = utcDayStart(now.getTime());
  if (phase === "revenue_month") return { afterMs: Math.max(utcDayStart(floorMs), CREATOR_STATS_REVENUE_FLOOR_MS), beforeMs: today };
  if (phase === "views_hour" || phase === "revenue_hour") return trailingDays(now, HOURLY_KEPT_DAYS);
  return { afterMs: Math.max(utcDayStart(floorMs), today - (CREATOR_STATS_MAX_SPAN_DAYS - 1) * DAY_MS), beforeMs: today };
}

/** Whether a phase walks back span by span (the day families and the summary). */
function walks(phase: HistoryPhase): boolean {
  return phase !== "revenue_month" && phase !== "views_hour" && phase !== "revenue_hour";
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
      return { kind: "wait", reason: "dependency", until: null, enqueue: [{ resource: "account.poll", demand: { reason: "dependency:creator-stats.history" } }] };
    }
    const window = cursor.window ?? firstWindow(cursor.phase, ctx.now, floorMs);
    return { kind: "request", request: requestFor(askOfPhase(cursor.phase), window, { phase: cursor.phase, window, floorMs }) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseHistoryCursor(input.work.cursor);
    const step = recordOf(input.request.step);
    const asked = windowOf(step.window);
    const floorMs = int(step.floorMs);
    const ask = askOf(input.request);
    if (step.phase !== cursor.phase || asked === null || floorMs === null || ask === null
      || (cursor.window !== null && !sameWindow(cursor.window, asked))) {
      throw new ApplyQuarantine("creator_stats_step_mismatch", { spec: input.request.spec, phase: cursor.phase });
    }
    const { served, counters } = await writeAnswer(tx, input, ask, asked);
    const shortened = served.afterMs > asked.afterMs;
    await claimWindow(tx, input, `history:${scopeOf(ask)}`, served, false, shortened ? "window_shortened" : null);

    // A walking phase goes on from the first day both asked and served (a
    // shortened span is continued from what the server served), to the floor.
    const nextWindow = walks(cursor.phase) ? previousSpan(Math.max(served.afterMs, asked.afterMs), floorMs) : null;
    if (nextWindow !== null) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { phase: cursor.phase, window: nextWindow, floorMs } },
        followups: [],
        counters: { ...counters, ...(shortened ? { creator_stats_window_shortened: 1 } : {}) },
      };
    }
    const phaseIndex = HISTORY_PHASES.indexOf(cursor.phase);
    const nextPhase = HISTORY_PHASES[phaseIndex + 1];
    if (nextPhase !== undefined) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { phase: nextPhase, window: null, floorMs } },
        followups: [],
        counters,
      };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "history_complete",
        cursor: { phase: "summary", window: null, floorMs },
        result: { floor: isoDay(floorMs), completedAt: input.now.toISOString() },
      },
      followups: [],
      counters: { ...counters, creator_stats_history_complete: 1 },
    };
  },
};

export function creatorStatsModule(variant: CreatorStatsVariant): ResourceModule {
  return variant === "account" ? accountModule : historyModule;
}
