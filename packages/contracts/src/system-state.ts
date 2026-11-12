/**
 * «Состояние» (ecosystem plan §3.6, §6, package P): every routine and every
 * copy of the system seen from the owner's place. A reporter (the Mac's, later
 * others) sends its whole list of routines and copies with an agent key
 * (`write:system_state`); Hub adds its own facts (its job schedules, the
 * ledger's health) itself. A routine is never «в порядке» merely because it
 * ran: `skipped` and `empty_input` are results of their own, and a place whose
 * reporter went silent is «не проверено», neither green nor red.
 */
import { z } from "zod";

import { isoDateTime, isoTimestamp } from "./primitives.ts";

/** Where a routine runs or a copy lies. */
export const SYSTEM_PLACES = ["server", "mac", "pc"] as const;
export type SystemPlace = (typeof SYSTEM_PLACES)[number];

/** What a routine's last run came to, as its reporter reads it. */
export const ROUTINE_RESULTS = ["ok", "failed", "skipped", "empty_input"] as const;
export type RoutineResult = (typeof ROUTINE_RESULTS)[number];

/**
 * A routine as Hub judges it now, the first that holds:
 * - `unchecked` — its reporter is silent: not verified, never red or green;
 * - `silent` — no run for twice its period and ten minutes;
 * - `failing` — two failed runs in a row or more;
 * - `empty_long` — empty input longer than the threshold its reporter gave;
 * - `failed_once` — the last run failed, the one before did not;
 * - `empty` — empty input, still within the threshold;
 * - `outcome_unknown` — it ran on time, its reporter cannot see how it ended;
 * - `pending` — known, not run yet, not overdue;
 * - `skipped` — it ran on time and had nothing to do;
 * - `ok` — it ran on time and did its work.
 */
export const ROUTINE_STATES = [
  "unchecked", "silent", "failing", "empty_long", "failed_once", "empty", "outcome_unknown", "pending", "skipped", "ok",
] as const;
export type RoutineState = (typeof ROUTINE_STATES)[number];

/** How much a state asks of the owner: a problem has a matter; attention is worth a look; healthy folds away. */
export const SYSTEM_LEVELS = ["problem", "attention", "unchecked", "healthy"] as const;
export type SystemLevel = (typeof SYSTEM_LEVELS)[number];

/** A copy now: fresh, older than the limit (a matter), or its reporter is silent. */
export const COPY_STATES = ["fresh", "stale", "unchecked"] as const;
export type CopyState = (typeof COPY_STATES)[number];

/** A reporter's name: `mac`, `pc`. `hub` is Hub's own and no key's. */
export const systemReporterSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).refine((value) => value !== "hub", {
  message: "«hub» is Hub's own reporter",
});
/** A routine's or a copy's key, stable for the thing: `mac.launchd.ledger-reports`. */
export const systemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,119}$/);

/** The longest period Hub watches: a routine of some days of a month (40 days). */
export const ROUTINE_PERIOD_MAX_SECONDS = 40 * 86_400;
const instant = isoDateTime({ offset: true });
const words = (max: number) => z.string().trim().min(1).max(max);

export const routineReportSchema = z.object({
  key: systemKeySchema,
  place: z.enum(SYSTEM_PLACES),
  /** What a person reads: «Сторож сбоев», «Ledger: отчёты из «Отчётности»». */
  title: words(200),
  /** How often it is meant to run, at most: the longest gap of its schedule. */
  periodSeconds: z.number().int().min(60).max(ROUTINE_PERIOD_MAX_SECONDS),
  /** When it last ran (ended, or was seen running); null — never, or not known. */
  lastRunAt: instant.nullable(),
  /** When it last did its work. */
  lastSuccessAt: instant.nullable(),
  /** null — it never ran, or the reporter cannot see how it ended. */
  lastResult: z.enum(ROUTINE_RESULTS).nullable(),
  /** A short line the reporter writes: an exit code, an error's first words. */
  detail: z.string().trim().max(500).nullable().optional(),
  /** Failed runs in a row, when the routine itself counts them. Otherwise Hub counts the runs it sees. */
  failedRuns: z.number().int().min(0).max(100_000).nullable().optional(),
  /** Since when its input is empty, when the reporter knows. Otherwise Hub counts from the first such run it sees. */
  emptySince: instant.nullable().optional(),
  /** How long empty input may last before it is a problem; absent — never. */
  emptyThresholdSeconds: z.number().int().min(60).max(ROUTINE_PERIOD_MAX_SECONDS).nullable().optional(),
  /** A counter of runs that only grows while its host is up (launchd's `runs`): a change is a run Hub saw happen. */
  runCount: z.number().int().min(0).nullable().optional(),
}).strict();

export const agentSystemRoutinesBodySchema = z.object({
  reporter: systemReporterSchema,
  /** Where the reporter itself runs: its silence makes that place's lines «не проверено». */
  place: z.enum(SYSTEM_PLACES),
  /** The reporter's own clock when it read the routines. */
  readAt: instant,
  /** The reporter's version, for the screen's detail. */
  version: z.string().trim().max(60).optional(),
  /** The reporter's whole list: a routine it no longer sends is retired (kept, no longer watched). */
  routines: z.array(routineReportSchema).max(500),
}).strict();

export const copyReportSchema = z.object({
  key: systemKeySchema,
  /** What it is a copy of: «База Hub». */
  title: words(200),
  /** From where to where: «agency-de», «мак: ~/Backups/agency-hub». */
  source: words(200),
  destination: words(200),
  /** When the newest copy was taken; null — there is none. */
  takenAt: instant.nullable(),
  bytes: z.number().int().min(0).nullable(),
  /** How many copies are kept. */
  kept: z.number().int().min(0).nullable(),
  detail: z.string().trim().max(500).nullable().optional(),
}).strict();

export const agentSystemCopiesBodySchema = z.object({
  reporter: systemReporterSchema,
  place: z.enum(SYSTEM_PLACES),
  readAt: instant,
  version: z.string().trim().max(60).optional(),
  /** The reporter's whole list: a copy it no longer sends is retired. */
  copies: z.array(copyReportSchema).max(100),
}).strict();

export const agentSystemReportResponseSchema = z.object({
  reporter: z.string(),
  /** The routines or copies taken. */
  accepted: z.number().int().nonnegative(),
  /** This reporter's rows it no longer sends: retired now. */
  retired: z.number().int().nonnegative(),
  serverNow: isoTimestamp,
});

const level = z.enum(SYSTEM_LEVELS);

export const systemStateRoutineSchema = z.object({
  key: z.string(),
  reporter: z.string(),
  place: z.enum(SYSTEM_PLACES),
  title: z.string(),
  periodSeconds: z.number().int().positive(),
  lastRunAt: isoTimestamp.nullable(),
  lastSuccessAt: isoTimestamp.nullable(),
  lastResult: z.enum(ROUTINE_RESULTS).nullable(),
  detail: z.string().nullable(),
  failedStreak: z.number().int().nonnegative(),
  emptySince: isoTimestamp.nullable(),
  emptyThresholdSeconds: z.number().int().positive().nullable(),
  /** When Hub was last told about it, and by which agent key (its name; null — Hub itself). */
  reportedAt: isoTimestamp,
  reportedBy: z.string().nullable(),
  state: z.enum(ROUTINE_STATES),
  level,
  /** From when it counts as silent, when it is on time: the moment of «молчит». */
  silentAfter: isoTimestamp,
});

export const systemStateCopySchema = z.object({
  key: z.string(),
  reporter: z.string(),
  title: z.string(),
  source: z.string(),
  destination: z.string(),
  takenAt: isoTimestamp.nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  kept: z.number().int().nonnegative().nullable(),
  detail: z.string().nullable(),
  reportedAt: isoTimestamp,
  reportedBy: z.string().nullable(),
  state: z.enum(COPY_STATES),
  level,
});

export const systemStateReporterSchema = z.object({
  reporter: z.string(),
  /** The place its routines run: `server` for Hub's own. */
  place: z.enum(SYSTEM_PLACES),
  lastReportAt: isoTimestamp,
  /** The first report since its last silence. */
  onlineSince: isoTimestamp,
  version: z.string().nullable(),
  /** It reported within the limit. */
  fresh: z.boolean(),
  /** Moscow hours it is watched in ("10:00–03:00"); null — all day. */
  hours: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).nullable(),
  /** Its silence is a problem now (a matter): stale, and inside its hours. */
  silentProblem: z.boolean(),
});

export const systemStateServerSchema = z.object({
  /** The source revision Hub runs; null — the build does not say. */
  revision: z.string().nullable(),
  /** Hub's processes by role: its freshest heartbeat. */
  processes: z.array(z.object({
    role: z.string(),
    state: z.enum(["active", "stale", "missing"]),
    lastSeenAt: isoTimestamp.nullable(),
  })),
  /** The job queue now: ready and waiting, the oldest of them, failed in the last hour. */
  queue: z.object({
    waiting: z.number().int().nonnegative(),
    oldestWaitingAgeMs: z.number().int().nonnegative().nullable(),
    failedLastHour: z.number().int().nonnegative(),
  }),
  /** Open failures (Система → Сбои). */
  openIncidents: z.number().int().nonnegative(),
});

export const systemStateResponseSchema = z.object({
  server: systemStateServerSchema,
  reporters: z.array(systemStateReporterSchema),
  /** Every routine not retired: problems first, then by place and title. */
  routines: z.array(systemStateRoutineSchema),
  copies: z.array(systemStateCopySchema),
  limits: z.object({
    /** A copy older than this is a problem. */
    copyStaleHours: z.number().int().positive(),
    /** A reporter silent this long is «не проверено». */
    reporterSilentMinutes: z.number().int().positive(),
  }),
  serverNow: isoTimestamp,
});

export type RoutineReport = z.infer<typeof routineReportSchema>;
export type AgentSystemRoutinesBody = z.infer<typeof agentSystemRoutinesBodySchema>;
export type CopyReport = z.infer<typeof copyReportSchema>;
export type AgentSystemCopiesBody = z.infer<typeof agentSystemCopiesBodySchema>;
export type AgentSystemReportResponse = z.infer<typeof agentSystemReportResponseSchema>;
export type SystemStateRoutine = z.infer<typeof systemStateRoutineSchema>;
export type SystemStateCopy = z.infer<typeof systemStateCopySchema>;
export type SystemStateReporter = z.infer<typeof systemStateReporterSchema>;
export type SystemStateServer = z.infer<typeof systemStateServerSchema>;
export type SystemStateResponse = z.infer<typeof systemStateResponseSchema>;
