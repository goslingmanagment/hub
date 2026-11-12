import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// «Состояние» (0391, ecosystem plan package P): reporters, their routines and
// copies. A reporter's batch is its whole list: written in one transaction
// under an advisory lock per reporter, what it no longer sends is retired. The
// rules of what a report changes (its run, its streak, its empty stretch) are
// the service's (apps/runtime/src/services/system-state.ts): this file reads
// and writes rows. Raw SQL: the tables are the migration's alone.

export const SYSTEM_ROUTINE_RESULTS = ["ok", "failed", "skipped", "empty_input"] as const;
export type SystemRoutineResult = (typeof SYSTEM_ROUTINE_RESULTS)[number];
export type SystemPlaceName = "server" | "mac" | "pc";

export interface SystemReporterRow {
  reporter: string;
  place: SystemPlaceName;
  agentKeyId: number | null;
  lastReportAt: Date;
  onlineSince: Date;
  readAt: Date | null;
  version: string | null;
}

export interface SystemRoutineRow {
  key: string;
  reporter: string;
  place: SystemPlaceName;
  title: string;
  periodSeconds: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastResult: SystemRoutineResult | null;
  detail: string | null;
  failedStreak: number;
  emptySince: Date | null;
  emptyThresholdSeconds: number | null;
  runCount: number | null;
  firstSeenAt: Date;
  reportedAt: Date;
  reportedByKeyId: number | null;
  retiredAt: Date | null;
}

export interface SystemCopyRow {
  key: string;
  reporter: string;
  title: string;
  source: string;
  destination: string;
  takenAt: Date | null;
  bytes: number | null;
  kept: number | null;
  detail: string | null;
  firstSeenAt: Date;
  reportedAt: Date;
  reportedByKeyId: number | null;
  retiredAt: Date | null;
}

/** A key another reporter keeps: one writer per routine and per copy. */
export class SystemReporterConflictError extends Error {
  constructor(readonly key: string, readonly heldBy: string) {
    super(`"${key}" is reported by ${heldBy}`);
    this.name = "SystemReporterConflictError";
  }
}

const LOCK_SEED = 731_402_659;

type Stamp = Date | string;
type Num = string | number | bigint;
const date = (value: Stamp) => new Date(value);
const dateOrNull = (value: Stamp | null) => (value === null ? null : new Date(value));
const numOrNull = (value: Num | null) => (value === null ? null : Number(value));
const iso = (value: Date | null) => (value === null ? null : value.toISOString());

type ReporterDbRow = {
  reporter: string; place: SystemPlaceName; agent_key_id: Num | null; last_report_at: Stamp; online_since: Stamp;
  reporter_read_at: Stamp | null; version: string | null;
};
const REPORTER_COLUMNS = sql.raw("reporter, place, agent_key_id, last_report_at, online_since, reporter_read_at, version");

function reporterOf(row: ReporterDbRow): SystemReporterRow {
  return {
    reporter: row.reporter,
    place: row.place,
    agentKeyId: numOrNull(row.agent_key_id),
    lastReportAt: date(row.last_report_at),
    onlineSince: date(row.online_since),
    readAt: dateOrNull(row.reporter_read_at),
    version: row.version,
  };
}

type RoutineDbRow = {
  routine_key: string; reporter: string; place: SystemPlaceName; title: string; period_seconds: Num; last_run_at: Stamp | null;
  last_success_at: Stamp | null; last_result: SystemRoutineResult | null; detail: string | null; failed_streak: Num;
  empty_since: Stamp | null; empty_threshold_seconds: Num | null; run_count: Num | null; first_seen_at: Stamp; reported_at: Stamp;
  reported_by_key_id: Num | null; retired_at: Stamp | null;
};
const ROUTINE_COLUMNS = sql.raw(
  "routine_key, reporter, place, title, period_seconds, last_run_at, last_success_at, last_result, detail, failed_streak, "
    + "empty_since, empty_threshold_seconds, run_count, first_seen_at, reported_at, reported_by_key_id, retired_at",
);

function routineOf(row: RoutineDbRow): SystemRoutineRow {
  return {
    key: row.routine_key,
    reporter: row.reporter,
    place: row.place,
    title: row.title,
    periodSeconds: Number(row.period_seconds),
    lastRunAt: dateOrNull(row.last_run_at),
    lastSuccessAt: dateOrNull(row.last_success_at),
    lastResult: row.last_result,
    detail: row.detail,
    failedStreak: Number(row.failed_streak),
    emptySince: dateOrNull(row.empty_since),
    emptyThresholdSeconds: numOrNull(row.empty_threshold_seconds),
    runCount: numOrNull(row.run_count),
    firstSeenAt: date(row.first_seen_at),
    reportedAt: date(row.reported_at),
    reportedByKeyId: numOrNull(row.reported_by_key_id),
    retiredAt: dateOrNull(row.retired_at),
  };
}

type CopyDbRow = {
  copy_key: string; reporter: string; title: string; source: string; destination: string; taken_at: Stamp | null; bytes: Num | null;
  kept: Num | null; detail: string | null; first_seen_at: Stamp; reported_at: Stamp; reported_by_key_id: Num | null; retired_at: Stamp | null;
};
const COPY_COLUMNS = sql.raw(
  "copy_key, reporter, title, source, destination, taken_at, bytes, kept, detail, first_seen_at, reported_at, reported_by_key_id, retired_at",
);

function copyOf(row: CopyDbRow): SystemCopyRow {
  return {
    key: row.copy_key,
    reporter: row.reporter,
    title: row.title,
    source: row.source,
    destination: row.destination,
    takenAt: dateOrNull(row.taken_at),
    bytes: numOrNull(row.bytes),
    kept: numOrNull(row.kept),
    detail: row.detail,
    firstSeenAt: date(row.first_seen_at),
    reportedAt: date(row.reported_at),
    reportedByKeyId: numOrNull(row.reported_by_key_id),
    retiredAt: dateOrNull(row.retired_at),
  };
}

export interface SystemReportInput {
  reporter: string;
  place: SystemPlaceName;
  /** The key that sent it; null — Hub itself. */
  agentKeyId: number | null;
  /** Hub's clock when the report arrived. */
  at: Date;
  /** The reporter's own clock. */
  readAt: Date | null;
  version: string | null;
  /** A report later than this after the previous one starts a new stretch (`online_since`). */
  silentAfterMs: number;
}

/** The reporter's row after this report: a report after a silence starts its stretch again. */
async function touchReporter(db: Database, input: SystemReportInput): Promise<SystemReporterRow> {
  const at = input.at.toISOString();
  const silentSeconds = Math.max(1, Math.round(input.silentAfterMs / 1000));
  const result = await db.execute<ReporterDbRow>(sql`
    insert into system_reporters (reporter, place, agent_key_id, last_report_at, online_since, reporter_read_at, version, updated_at)
    values (${input.reporter}, ${input.place}, ${input.agentKeyId}, ${at}::timestamptz, ${at}::timestamptz, ${iso(input.readAt)}::timestamptz,
      ${input.version}, clock_timestamp())
    on conflict (reporter) do update set
      place = excluded.place,
      agent_key_id = excluded.agent_key_id,
      online_since = case
        when system_reporters.last_report_at < excluded.last_report_at - make_interval(secs => ${silentSeconds}) then excluded.last_report_at
        else system_reporters.online_since end,
      last_report_at = greatest(system_reporters.last_report_at, excluded.last_report_at),
      reporter_read_at = excluded.reporter_read_at,
      version = excluded.version,
      updated_at = clock_timestamp()
    returning ${REPORTER_COLUMNS}`);
  return reporterOf(result.rows[0]!);
}

async function lockReporter(db: Database, reporter: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reporter}, ${LOCK_SEED}))`);
}

/**
 * A reporter's whole list of routines: the reporter's row touched, each
 * routine written as `build` makes it from the row it had (null — new), and
 * every routine of this reporter it no longer sends retired. A key another
 * reporter keeps, not retired, is refused (`SystemReporterConflictError`):
 * nothing of the batch is written.
 */
export async function replaceReporterRoutines(
  db: Database,
  input: SystemReportInput & {
    keys: readonly string[];
    build: (existing: ReadonlyMap<string, SystemRoutineRow>, reporter: SystemReporterRow) => SystemRoutineRow[];
  },
): Promise<{ reporter: SystemReporterRow; accepted: number; retired: number }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockReporter(txDb, input.reporter);
    const found = input.keys.length === 0 ? [] : (await txDb.execute<RoutineDbRow>(sql`
      select ${ROUTINE_COLUMNS} from system_routines where routine_key = any(${sql.param([...input.keys])}::text[]) for update`)).rows.map(routineOf);
    for (const row of found) {
      if (row.reporter !== input.reporter && row.retiredAt === null) throw new SystemReporterConflictError(row.key, row.reporter);
    }
    const reporter = await touchReporter(txDb, input);
    const rows = input.build(new Map(found.map((row) => [row.key, row])), reporter);
    for (const row of rows) await upsertRoutine(txDb, row);
    const retired = await txDb.execute<{ routine_key: string }>(sql`
      update system_routines set retired_at = ${input.at.toISOString()}::timestamptz, updated_at = clock_timestamp()
      where reporter = ${input.reporter} and retired_at is null and not (routine_key = any(${sql.param([...input.keys])}::text[]))
      returning routine_key`);
    return { reporter, accepted: rows.length, retired: retired.rows.length };
  });
}

async function upsertRoutine(db: Database, row: SystemRoutineRow): Promise<void> {
  await db.execute(sql`
    insert into system_routines (routine_key, reporter, place, title, period_seconds, last_run_at, last_success_at, last_result, detail,
      failed_streak, empty_since, empty_threshold_seconds, run_count, first_seen_at, reported_at, reported_by_key_id, retired_at, updated_at)
    values (${row.key}, ${row.reporter}, ${row.place}, ${row.title}, ${row.periodSeconds}, ${iso(row.lastRunAt)}::timestamptz,
      ${iso(row.lastSuccessAt)}::timestamptz, ${row.lastResult}, ${row.detail}, ${row.failedStreak}, ${iso(row.emptySince)}::timestamptz,
      ${row.emptyThresholdSeconds}, ${row.runCount}, ${row.firstSeenAt.toISOString()}::timestamptz, ${row.reportedAt.toISOString()}::timestamptz,
      ${row.reportedByKeyId}, ${iso(row.retiredAt)}::timestamptz, clock_timestamp())
    on conflict (routine_key) do update set
      reporter = excluded.reporter, place = excluded.place, title = excluded.title, period_seconds = excluded.period_seconds,
      last_run_at = excluded.last_run_at, last_success_at = excluded.last_success_at, last_result = excluded.last_result,
      detail = excluded.detail, failed_streak = excluded.failed_streak, empty_since = excluded.empty_since,
      empty_threshold_seconds = excluded.empty_threshold_seconds, run_count = excluded.run_count,
      reported_at = excluded.reported_at, reported_by_key_id = excluded.reported_by_key_id, retired_at = excluded.retired_at,
      updated_at = clock_timestamp()`);
}

/** A reporter's whole list of copies, as `replaceReporterRoutines` for routines. */
export async function replaceReporterCopies(
  db: Database,
  input: SystemReportInput & {
    keys: readonly string[];
    build: (existing: ReadonlyMap<string, SystemCopyRow>) => SystemCopyRow[];
  },
): Promise<{ reporter: SystemReporterRow; accepted: number; retired: number }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockReporter(txDb, input.reporter);
    const found = input.keys.length === 0 ? [] : (await txDb.execute<CopyDbRow>(sql`
      select ${COPY_COLUMNS} from system_copies where copy_key = any(${sql.param([...input.keys])}::text[]) for update`)).rows.map(copyOf);
    for (const row of found) {
      if (row.reporter !== input.reporter && row.retiredAt === null) throw new SystemReporterConflictError(row.key, row.reporter);
    }
    const reporter = await touchReporter(txDb, input);
    const rows = input.build(new Map(found.map((row) => [row.key, row])));
    for (const row of rows) {
      await txDb.execute(sql`
        insert into system_copies (copy_key, reporter, title, source, destination, taken_at, bytes, kept, detail, first_seen_at,
          reported_at, reported_by_key_id, retired_at, updated_at)
        values (${row.key}, ${row.reporter}, ${row.title}, ${row.source}, ${row.destination}, ${iso(row.takenAt)}::timestamptz, ${row.bytes},
          ${row.kept}, ${row.detail}, ${row.firstSeenAt.toISOString()}::timestamptz, ${row.reportedAt.toISOString()}::timestamptz,
          ${row.reportedByKeyId}, ${iso(row.retiredAt)}::timestamptz, clock_timestamp())
        on conflict (copy_key) do update set
          reporter = excluded.reporter, title = excluded.title, source = excluded.source, destination = excluded.destination,
          taken_at = excluded.taken_at, bytes = excluded.bytes, kept = excluded.kept, detail = excluded.detail,
          reported_at = excluded.reported_at, reported_by_key_id = excluded.reported_by_key_id, retired_at = excluded.retired_at,
          updated_at = clock_timestamp()`);
    }
    const retired = await txDb.execute<{ copy_key: string }>(sql`
      update system_copies set retired_at = ${input.at.toISOString()}::timestamptz, updated_at = clock_timestamp()
      where reporter = ${input.reporter} and retired_at is null and not (copy_key = any(${sql.param([...input.keys])}::text[]))
      returning copy_key`);
    return { reporter, accepted: rows.length, retired: retired.rows.length };
  });
}

export async function listSystemReporters(db: Database): Promise<SystemReporterRow[]> {
  const result = await db.execute<ReporterDbRow>(sql`select ${REPORTER_COLUMNS} from system_reporters order by reporter`);
  return result.rows.map(reporterOf);
}

/** Every routine, the retired too when asked (a matter of a retired routine closes). */
export async function listSystemRoutines(db: Database, input: { withRetired?: boolean } = {}): Promise<SystemRoutineRow[]> {
  const result = await db.execute<RoutineDbRow>(sql`
    select ${ROUTINE_COLUMNS} from system_routines ${input.withRetired ? sql`` : sql`where retired_at is null`} order by place, title, routine_key`);
  return result.rows.map(routineOf);
}

export async function listSystemCopies(db: Database, input: { withRetired?: boolean } = {}): Promise<SystemCopyRow[]> {
  const result = await db.execute<CopyDbRow>(sql`
    select ${COPY_COLUMNS} from system_copies ${input.withRetired ? sql`` : sql`where retired_at is null`} order by title, copy_key`);
  return result.rows.map(copyOf);
}

/** id → name of the agent keys named (who reported). */
export async function listSystemKeyNames(db: Database, keyIds: readonly number[]): Promise<Map<number, string>> {
  const ids = [...new Set(keyIds)];
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ id: Num; name: string }>(sql`
    select id, name from agent_keys where id = any(${sql.param(ids.map(String))}::bigint[])`);
  return new Map(result.rows.map((row) => [Number(row.id), row.name]));
}

// ── Hub's own schedules, from its job queue ─────────────────────────────────

export interface ScheduleRunRow {
  name: string;
  cron: string;
  timezone: string | null;
  /** The newest finished job (completed or failed); null — none kept. */
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastState: "completed" | "failed" | null;
  /** Failed jobs after the newest completed one. */
  failedAfterSuccess: number;
  /** The newest failure's message, cut to 200 characters. */
  lastError: string | null;
}

/**
 * Every schedule of the job queue with its newest finished jobs: one pass over
 * the finished jobs of the scheduled queues (the queue keeps a day of the
 * minutely ones, a week of the rest). A database the queue has not started in
 * has none.
 */
export async function readScheduleRuns(db: Database): Promise<ScheduleRunRow[]> {
  const present = await db.execute<{ present: boolean }>(sql`
    select (to_regclass('pgboss.job') is not null and to_regclass('pgboss.schedule') is not null) as present`);
  if (present.rows[0]?.present !== true) return [];
  const result = await db.execute<{
    name: string; cron: string; timezone: string | null; last_run_at: Stamp | null; last_success_at: Stamp | null;
    last_state: "completed" | "failed" | null; failed_after_success: Num | null; last_error: string | null;
  }>(sql`
    with schedules as (
      select distinct on (name) name, cron, timezone from pgboss.schedule order by name
    ), finished as (
      select j.name, j.state::text as state, j.completed_on, j.output
        from pgboss.job j
       where j.name in (select name from schedules) and j.state in ('completed', 'failed') and j.completed_on is not null
    ), success as (
      select name, max(completed_on) as at from finished where state = 'completed' group by name
    ), summary as (
      select f.name,
             max(f.completed_on) as last_run_at,
             (array_agg(f.state order by f.completed_on desc))[1] as last_state,
             count(*) filter (where f.state = 'failed' and (s.at is null or f.completed_on > s.at)) as failed_after_success,
             (array_agg(left(coalesce(f.output ->> 'message', f.output::text), 200) order by f.completed_on desc)
               filter (where f.state = 'failed'))[1] as last_error
        from finished f left join success s on s.name = f.name
       group by f.name
    )
    select sc.name, sc.cron, sc.timezone, su.last_run_at, s.at as last_success_at, su.last_state, su.failed_after_success, su.last_error
      from schedules sc
      left join summary su on su.name = sc.name
      left join success s on s.name = sc.name
     order by sc.name`);
  return result.rows.map((row) => ({
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    lastRunAt: dateOrNull(row.last_run_at),
    lastSuccessAt: dateOrNull(row.last_success_at),
    lastState: row.last_state,
    failedAfterSuccess: Number(row.failed_after_success ?? 0),
    lastError: row.last_error,
  }));
}
