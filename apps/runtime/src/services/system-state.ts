import {
  ROUTINE_PERIOD_MAX_SECONDS,
  type AgentSystemCopiesBody,
  type AgentSystemReportResponse,
  type AgentSystemRoutinesBody,
  type CopyReport,
  type CopyState,
  type RoutineReport,
  type RoutineState,
  type SystemLevel,
  type SystemStateResponse,
} from "@agency_hub_core/contracts";
import {
  listInstanceLiveness,
  listNotificationIncidents,
  listSystemCopies,
  listSystemKeyNames,
  listSystemReporters,
  listSystemRoutines,
  readOpsLiveFailedLastHour,
  readOpsLiveQueueNow,
  replaceReporterCopies,
  replaceReporterRoutines,
  SystemReporterConflictError,
  type SystemCopyRow,
  type SystemReporterRow,
  type SystemRoutineRow,
} from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal } from "./auth.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ConflictError } from "./errors.ts";
import { cachedRead, opsLiveProcessesOf, opsLiveRevision, OPS_LIVE_FAILED_JOBS_TTL_MS } from "./ops-live.ts";

/**
 * «Состояние» (ecosystem plan §3.6, §6, package P): what a reporter's batch
 * changes in a routine, how Hub judges a routine and a copy now, and the
 * owner's read. One rule for the screen and the matters: a routine is silent
 * after twice its period and ten minutes without a run; it fails after two
 * failed runs in a row; its empty input is a problem past its reporter's
 * threshold; a copy is stale after 36 hours; a place whose reporter is silent
 * for 30 minutes is «не проверено» — never green, never red. Database only.
 */

const MINUTE_MS = 60_000;
/** A reporter silent this long: its place reads «не проверено», and inside its hours that is a matter. */
export const REPORTER_SILENT_MS = 30 * MINUTE_MS;
/** A copy older than this is a matter. */
export const COPY_STALE_MS = 36 * 60 * MINUTE_MS;
/** Beside twice the period: a routine on time but late by a tick is not silent. */
export const SILENT_GRACE_MS = 10 * MINUTE_MS;
/** Hub's own reporter: its schedules and the ledger's health. */
export const HUB_REPORTER = "hub";

// ── A batch's routine, written over the row it had ─────────────────────────

const later = (...values: Array<Date | null | undefined>): Date | null =>
  values.reduce<Date | null>((best, value) => (value && (!best || value.getTime() > best.getTime()) ? value : best), null);

export interface ReportContext {
  reporter: string;
  agentKeyId: number | null;
  /** Hub's clock when the batch arrived: nothing in it is later than this. */
  at: Date;
}

/** A routine as its reporter tells it, in Hub's types. */
export interface RoutineReportInput {
  key: string;
  place: SystemRoutineRow["place"];
  title: string;
  periodSeconds: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastResult: SystemRoutineRow["lastResult"];
  detail: string | null;
  failedRuns: number | null;
  emptySince: Date | null;
  emptyThresholdSeconds: number | null;
  runCount: number | null;
}

/**
 * The routine after a report. Its last run and last success never go back. A
 * run is new when the last run moves on, or when the run counter changes (a
 * launchd job that says no time: Hub dates the run by the report). Failed runs
 * in a row are the routine's own count when it gives one, else Hub's of the
 * runs it sees; the empty stretch starts at the first empty run Hub sees,
 * unless the reporter says when.
 */
export function mergeRoutineReport(old: SystemRoutineRow | null, report: RoutineReportInput, context: ReportContext): SystemRoutineRow {
  const { at } = context;
  const clamp = (value: Date | null) => (value !== null && value.getTime() > at.getTime() ? at : value);
  const counterMoved = report.runCount !== null && old?.runCount !== null && old?.runCount !== undefined && report.runCount !== old.runCount;
  const lastRunAt = later(old?.lastRunAt, clamp(report.lastRunAt), counterMoved ? at : null);
  const newRun = lastRunAt !== null && (old?.lastRunAt == null || lastRunAt.getTime() > old.lastRunAt.getTime());
  const result = report.lastResult;
  const lastSuccessAt = later(old?.lastSuccessAt, clamp(report.lastSuccessAt), result === "ok" && newRun ? lastRunAt : null);

  let failedStreak = 0;
  if (report.failedRuns !== null) failedStreak = report.failedRuns;
  else if (result === "failed") {
    const before = old?.lastResult === "failed" ? old.failedStreak : 0;
    failedStreak = newRun ? before + 1 : Math.max(before, 1);
  }

  let emptySince: Date | null = null;
  if (result === "empty_input") {
    emptySince = clamp(report.emptySince)
      ?? (old?.lastResult === "empty_input" ? old.emptySince : null)
      ?? lastRunAt
      ?? at;
  }

  return {
    key: report.key,
    reporter: context.reporter,
    place: report.place,
    title: report.title,
    periodSeconds: Math.min(Math.max(60, Math.round(report.periodSeconds)), ROUTINE_PERIOD_MAX_SECONDS),
    lastRunAt,
    lastSuccessAt,
    lastResult: result,
    detail: report.detail,
    failedStreak,
    emptySince,
    emptyThresholdSeconds: report.emptyThresholdSeconds,
    runCount: report.runCount,
    firstSeenAt: old?.firstSeenAt ?? at,
    reportedAt: at,
    reportedByKeyId: context.agentKeyId,
    retiredAt: null,
  };
}

export function mergeCopyReport(old: SystemCopyRow | null, report: CopyReport, context: ReportContext): SystemCopyRow {
  const takenAt = report.takenAt === null ? null : new Date(report.takenAt);
  return {
    key: report.key,
    reporter: context.reporter,
    title: report.title,
    source: report.source,
    destination: report.destination,
    takenAt: takenAt !== null && takenAt.getTime() > context.at.getTime() ? context.at : takenAt,
    bytes: report.bytes,
    kept: report.kept,
    detail: report.detail ?? null,
    firstSeenAt: old?.firstSeenAt ?? context.at,
    reportedAt: context.at,
    reportedByKeyId: context.agentKeyId,
    retiredAt: null,
  };
}

// ── How a routine, a copy and a reporter are now ───────────────────────────

/** What the judges need of a routine's reporter. */
export interface ReporterView {
  /** It reported within REPORTER_SILENT_MS. */
  fresh: boolean;
  /** The first report since its last silence: a routine is not silent for a grace after it. */
  onlineSince: Date | null;
}

export function reporterFresh(reporter: Pick<SystemReporterRow, "lastReportAt"> | undefined, now: Date): boolean {
  return reporter !== undefined && now.getTime() - reporter.lastReportAt.getTime() <= REPORTER_SILENT_MS;
}

const LEVEL_OF: Readonly<Record<RoutineState, SystemLevel>> = {
  unchecked: "unchecked",
  silent: "problem",
  failing: "problem",
  empty_long: "problem",
  failed_once: "attention",
  empty: "attention",
  outcome_unknown: "healthy",
  pending: "healthy",
  skipped: "healthy",
  ok: "healthy",
};

export interface RoutineVerdict {
  state: RoutineState;
  level: SystemLevel;
  /** From when it counts as silent if nothing runs. */
  silentAfter: Date;
}

/**
 * A routine now, the first that holds: its reporter silent → unchecked; no
 * run for twice its period and ten minutes (counted from its last run, or
 * from when Hub first heard of it, and never before its reporter came back)
 * → silent; two failed runs in a row → failing; empty input past the
 * threshold → empty_long; then failed_once, empty, outcome_unknown, pending,
 * skipped, ok.
 */
export function routineVerdict(row: SystemRoutineRow, reporter: ReporterView, now: Date): RoutineVerdict {
  const base = later(row.lastRunAt ?? row.firstSeenAt, reporter.onlineSince) ?? row.firstSeenAt;
  const silentAfter = new Date(base.getTime() + 2 * row.periodSeconds * 1000 + SILENT_GRACE_MS);
  const verdict = (state: RoutineState): RoutineVerdict => ({ state, level: LEVEL_OF[state], silentAfter });
  if (!reporter.fresh) return verdict("unchecked");
  if (now.getTime() > silentAfter.getTime()) return verdict("silent");
  if (row.lastResult === "failed") return verdict(row.failedStreak >= 2 ? "failing" : "failed_once");
  if (row.lastResult === "empty_input") {
    const since = row.emptySince ?? row.lastRunAt ?? row.firstSeenAt;
    const long = row.emptyThresholdSeconds !== null && now.getTime() - since.getTime() > row.emptyThresholdSeconds * 1000;
    return verdict(long ? "empty_long" : "empty");
  }
  if (row.lastResult === null) return verdict(row.lastRunAt === null ? "pending" : "outcome_unknown");
  return verdict(row.lastResult === "skipped" ? "skipped" : "ok");
}

/** A copy now: its reporter silent → unchecked; none, or older than 36 hours → stale; else fresh. */
export function copyVerdict(row: Pick<SystemCopyRow, "takenAt">, fresh: boolean, now: Date): { state: CopyState; level: SystemLevel } {
  if (!fresh) return { state: "unchecked", level: "unchecked" };
  if (row.takenAt === null || now.getTime() - row.takenAt.getTime() > COPY_STALE_MS) return { state: "stale", level: "problem" };
  return { state: "fresh", level: "healthy" };
}

/** The Moscow hours a reporter is watched in: the Mac's from the settings; any other all day (null). */
export function reporterHours(reporter: string, config: { systemMacHoursFrom?: number; systemMacHoursTo?: number }): { from: number; to: number } | null {
  if (reporter !== "mac") return null;
  const from = config.systemMacHoursFrom ?? 10;
  const to = config.systemMacHoursTo ?? 3;
  return from === to ? null : { from, to };
}

const MOSCOW_HOUR = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: MOSCOW_TIME_ZONE });

/** Whether `now` is inside the hours (Moscow): `to` not included; `to` before `from` — past midnight. */
export function insideHours(now: Date, hours: { from: number; to: number } | null): boolean {
  if (hours === null) return true;
  const hour = Number(MOSCOW_HOUR.format(now));
  return hours.from < hours.to ? hour >= hours.from && hour < hours.to : hour >= hours.from || hour < hours.to;
}

// ── Cron: the longest gap of a schedule ─────────────────────────────────────

function cronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      low = Number(a);
      high = Number(b);
    } else {
      low = Number(range);
      high = stepText === undefined ? low : max;
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

/**
 * The longest gap between two runs of a five-field cron, in seconds (over 62
 * days from a fixed Monday, in its own zone; Moscow has no daylight saving and
 * Hub's schedules are UTC). null — a cron this does not read; at most 40 days.
 */
export function cronMaxGapSeconds(expression: string): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = cronField(fields[0]!, 0, 59);
  const hours = cronField(fields[1]!, 0, 23);
  const days = cronField(fields[2]!, 1, 31);
  const months = cronField(fields[3]!, 1, 12);
  const weekdays = cronField(fields[4]!.replace(/\b7\b/g, "0"), 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  const anyDay = fields[2] === "*";
  const anyWeekday = fields[4] === "*";
  const start = Date.UTC(2026, 0, 5); // a Monday
  /** Whole minutes from the start: the gaps are whole minutes, no float. */
  const fires: number[] = [];
  for (let day = 0; day < 62; day += 1) {
    const date = new Date(start + day * 86_400_000);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const dayOk = days.has(date.getUTCDate());
    const weekdayOk = weekdays.has(date.getUTCDay());
    // Both restricted: either matches (cron's own rule).
    if (!(anyDay || anyWeekday ? dayOk && weekdayOk : dayOk || weekdayOk)) continue;
    for (const hour of [...hours].sort((a, b) => a - b)) {
      for (const minute of [...minutes].sort((a, b) => a - b)) fires.push(day * 1440 + hour * 60 + minute);
    }
  }
  if (fires.length < 2) return ROUTINE_PERIOD_MAX_SECONDS;
  let gap = 0;
  for (let index = 1; index < fires.length; index += 1) gap = Math.max(gap, fires[index]! - fires[index - 1]!);
  return Math.min(Math.max(60, gap * 60), ROUTINE_PERIOD_MAX_SECONDS);
}

// ── The reporter's door (write:system_state) ───────────────────────────────

type StateApp = Pick<AppContext, "db" | "config">;

function routineInput(report: RoutineReport): RoutineReportInput {
  const when = (value: string | null | undefined) => (value === null || value === undefined ? null : new Date(value));
  return {
    key: report.key,
    place: report.place,
    title: report.title,
    periodSeconds: report.periodSeconds,
    lastRunAt: when(report.lastRunAt),
    lastSuccessAt: when(report.lastSuccessAt),
    lastResult: report.lastResult,
    detail: report.detail ?? null,
    failedRuns: report.failedRuns ?? null,
    emptySince: when(report.emptySince),
    emptyThresholdSeconds: report.emptyThresholdSeconds ?? null,
    runCount: report.runCount ?? null,
  };
}

function otherReporter(error: SystemReporterConflictError): ConflictError {
  return new ConflictError(`"${error.key}" is another reporter's`, { reason: "routine_other_reporter" });
}

function distinctKeys<T extends { key: string }>(items: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(item.key, item);
  return [...byKey.values()];
}

/** Writes routines as told: by a reporter's agent key, or by Hub itself (`principal` null). */
export async function writeRoutineReports(
  app: StateApp,
  input: { reporter: string; place: SystemRoutineRow["place"]; agentKeyId: number | null; readAt: Date | null; version: string | null; routines: readonly RoutineReportInput[] },
  now: Date = new Date(),
): Promise<AgentSystemReportResponse> {
  const routines = distinctKeys(input.routines);
  const context: ReportContext = { reporter: input.reporter, agentKeyId: input.agentKeyId, at: now };
  try {
    const done = await replaceReporterRoutines(app.db, {
      reporter: input.reporter, place: input.place, agentKeyId: input.agentKeyId, at: now, readAt: input.readAt, version: input.version,
      silentAfterMs: REPORTER_SILENT_MS,
      keys: routines.map((routine) => routine.key),
      build: (existing) => routines.map((routine) => mergeRoutineReport(existing.get(routine.key) ?? null, routine, context)),
    });
    return { reporter: input.reporter, accepted: done.accepted, retired: done.retired, serverNow: now.toISOString() };
  } catch (error) {
    if (error instanceof SystemReporterConflictError) throw otherReporter(error);
    throw error;
  }
}

/** `agentSystemRoutines`: a reporter's whole list of routines. */
export async function acceptRoutineReports(app: StateApp, principal: AgentAuthPrincipal, body: AgentSystemRoutinesBody, now: Date = new Date()) {
  return writeRoutineReports(app, {
    reporter: body.reporter, place: body.place, agentKeyId: principal.agentKeyId, readAt: new Date(body.readAt), version: body.version ?? null,
    routines: body.routines.map(routineInput),
  }, now);
}

/** `agentSystemCopies`: a reporter's whole list of copies. */
export async function acceptCopyReports(app: StateApp, principal: AgentAuthPrincipal, body: AgentSystemCopiesBody, now: Date = new Date()): Promise<AgentSystemReportResponse> {
  const copies = distinctKeys(body.copies);
  const context: ReportContext = { reporter: body.reporter, agentKeyId: principal.agentKeyId, at: now };
  try {
    const done = await replaceReporterCopies(app.db, {
      reporter: body.reporter, place: body.place, agentKeyId: principal.agentKeyId, at: now, readAt: new Date(body.readAt),
      version: body.version ?? null, silentAfterMs: REPORTER_SILENT_MS,
      keys: copies.map((copy) => copy.key),
      build: (existing) => copies.map((copy) => mergeCopyReport(existing.get(copy.key) ?? null, copy, context)),
    });
    return { reporter: body.reporter, accepted: done.accepted, retired: done.retired, serverNow: now.toISOString() };
  } catch (error) {
    if (error instanceof SystemReporterConflictError) throw otherReporter(error);
    throw error;
  }
}

// ── The owner's read ────────────────────────────────────────────────────────

const LEVEL_ORDER: Readonly<Record<SystemLevel, number>> = { problem: 0, attention: 1, unchecked: 2, healthy: 3 };
const PLACE_ORDER = { server: 0, mac: 1, pc: 2 } as const;

/** The reporters, with whether each is fresh and whether its silence is a problem now. */
export function reporterViews(reporters: readonly SystemReporterRow[], config: { systemMacHoursFrom?: number; systemMacHoursTo?: number }, now: Date) {
  return reporters.map((reporter) => {
    const fresh = reporterFresh(reporter, now);
    const hours = reporter.reporter === HUB_REPORTER ? null : reporterHours(reporter.reporter, config);
    return {
      row: reporter,
      fresh,
      hours,
      silentProblem: reporter.reporter !== HUB_REPORTER && !fresh && insideHours(now, hours),
    };
  });
}

let failedLastHour: { db: unknown; read: () => Promise<number> } | null = null;
/** Jobs failed in the last hour: a pass over the job table, kept five minutes (as the operator screen keeps it). */
function readFailedLastHour(app: StateApp): Promise<number> {
  if (failedLastHour?.db !== app.db) failedLastHour = { db: app.db, read: cachedRead(() => readOpsLiveFailedLastHour(app.db), OPS_LIVE_FAILED_JOBS_TTL_MS) };
  return failedLastHour.read();
}

/** `systemState`: Hub's own health, every routine and copy as judged now, for the owner. */
export async function readSystemState(app: StateApp, now: Date = new Date()): Promise<SystemStateResponse> {
  const [config, reporters, routines, copies, instances, queue, failed, incidents] = await Promise.all([
    loadEffectiveConfig(app.db, app.config),
    listSystemReporters(app.db),
    listSystemRoutines(app.db),
    listSystemCopies(app.db),
    listInstanceLiveness(app.db),
    readOpsLiveQueueNow(app.db),
    readFailedLastHour(app),
    listNotificationIncidents(app.db, { status: "open" }),
  ]);
  const views = reporterViews(reporters, config, now);
  const viewOf = new Map(views.map((view) => [view.row.reporter, view]));
  const names = await listSystemKeyNames(app.db, [...routines, ...copies].flatMap((row) => (row.reportedByKeyId === null ? [] : [row.reportedByKeyId])));
  const nameOf = (id: number | null) => (id === null ? null : names.get(id) ?? null);

  const judged = routines.map((row) => {
    const view = viewOf.get(row.reporter);
    const verdict = routineVerdict(row, { fresh: view?.fresh ?? false, onlineSince: view?.row.onlineSince ?? null }, now);
    return {
      key: row.key,
      reporter: row.reporter,
      place: row.place,
      title: row.title,
      periodSeconds: row.periodSeconds,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastResult: row.lastResult,
      detail: row.detail,
      failedStreak: row.failedStreak,
      emptySince: row.emptySince?.toISOString() ?? null,
      emptyThresholdSeconds: row.emptyThresholdSeconds,
      reportedAt: row.reportedAt.toISOString(),
      reportedBy: nameOf(row.reportedByKeyId),
      state: verdict.state,
      level: verdict.level,
      silentAfter: verdict.silentAfter.toISOString(),
    };
  }).sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level]
    || PLACE_ORDER[left.place] - PLACE_ORDER[right.place]
    || left.title.localeCompare(right.title, "ru"));

  const judgedCopies = copies.map((row) => {
    const verdict = copyVerdict(row, viewOf.get(row.reporter)?.fresh ?? false, now);
    return {
      key: row.key,
      reporter: row.reporter,
      title: row.title,
      source: row.source,
      destination: row.destination,
      takenAt: row.takenAt?.toISOString() ?? null,
      bytes: row.bytes,
      kept: row.kept,
      detail: row.detail,
      reportedAt: row.reportedAt.toISOString(),
      reportedBy: nameOf(row.reportedByKeyId),
      state: verdict.state,
      level: verdict.level,
    };
  }).sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level] || left.title.localeCompare(right.title, "ru"));

  return {
    server: {
      revision: opsLiveRevision(),
      processes: opsLiveProcessesOf(instances, now).map((process) => ({ role: process.role, state: process.state, lastSeenAt: process.lastSeenAt })),
      queue: { waiting: queue.waiting, oldestWaitingAgeMs: queue.oldestWaitingAgeMs, failedLastHour: failed },
      openIncidents: incidents.length,
    },
    reporters: views.map((view) => ({
      reporter: view.row.reporter,
      place: view.row.place,
      lastReportAt: view.row.lastReportAt.toISOString(),
      onlineSince: view.row.onlineSince.toISOString(),
      version: view.row.version,
      fresh: view.fresh,
      hours: view.hours,
      silentProblem: view.silentProblem,
    })),
    routines: judged,
    copies: judgedCopies,
    limits: { copyStaleHours: COPY_STALE_MS / 3_600_000, reporterSilentMinutes: REPORTER_SILENT_MS / MINUTE_MS },
    serverNow: now.toISOString(),
  };
}
