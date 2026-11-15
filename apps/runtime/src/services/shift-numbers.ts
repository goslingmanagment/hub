import { createHash } from "node:crypto";

import {
  SHIFT_REVIEW_AI_LOOKBACK_MINUTES,
  SHIFT_REVIEW_DELETED_UNSEEN_SECONDS,
  SHIFT_REVIEW_WAIT_HORIZON_HOURS,
} from "@agency_hub_core/contracts";
import { listStoredShiftNumbers, loadTeamFacts, shiftInputsMark, upsertShiftNumbers, type Database, type StoredShiftNumbers } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  numbersOf,
  readJobNumbers,
  teamShiftJobs,
  type ShiftJob,
  type ShiftNumbersRow,
  type TeamShiftJobs,
} from "./chatter-numbers.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

/**
 * The stored numbers of closed shifts (0417 `shift_numbers`, products plan 2026-11-13 §5, package N).
 *
 * - The SAME function fills a row: `readShiftNumbers` (chatter-numbers.ts) of the shift as the team read finds it
 *   (`teamShiftJobs`). There is no second definition; the table is a copy the reads may take instead of recounting.
 * - A row is of a shift as it is now when its end and its `key` (its pages, the pages whose every fan it answers for,
 *   the automated openings) match and its `revision` is SHIFT_NUMBERS_REVISION: a merged or moved shift, or a change
 *   of the definition (raise the revision), is counted again, never mixed.
 * - The job (every 30 minutes, never in the hour of the 05:20 MSK backup dump) writes each closed shift of the last
 *   SHIFT_NUMBERS_REFRESH_DAYS without a fresh row, and rewrites one whose facts moved (`shiftInputsMark`: a late
 *   author report, a late message, a PPV bought later). A whose-sale decision moves no number of a shift (they count
 *   messages, replies and fans, not sales), so it rewrites nothing.
 * - A going shift has no row: it is counted live. Each write is one statement: no transaction is held.
 * - The test team's wall (sandbox/realm.ts): the live agency's shifts and the test team's are found apart, each as
 *   its own realm's reader finds them; a reader looks rows up only by the shifts of its own cut, and nothing here
 *   opens a matter.
 * - The shadow check (`compareShiftNumbers`, the job team.shift-numbers.check and `cli shift-numbers check`) counts
 *   every closed shift of the last 14 days live and compares it with its row; its line is the routine's detail in
 *   «Система → Состояние». The reads switch to the table by `teamNumbersFromTable` (off) after it shows zero.
 */

/** Raise when what a shift's numbers are changes: every row of another revision is counted again. */
export const SHIFT_NUMBERS_REVISION = 1;
/** How far back each pass looks for closed shifts to write or rewrite (the team reads ask up to 31 days). */
export const SHIFT_NUMBERS_REFRESH_DAYS = 16;
/** The shadow check's window. */
export const SHIFT_NUMBERS_CHECK_DAYS = 14;

const DAY_MS = 86_400_000;
/** Shifts the pass reads at once: it runs beside the API on the same database. */
const PASS_READS_AT_ONCE = 3;

/** What a shift's numbers are read from, besides the facts: its end, pages, all-fans pages and the openings. Pure. */
export function shiftKeyOf(job: ShiftJob, openings: readonly string[]): string {
  const openingsHash = createHash("sha1").update(openings.join("\u0000")).digest("hex").slice(0, 12);
  return JSON.stringify({
    end: job.end,
    pages: job.pages.map((page) => page.id).sort((a, b) => a - b),
    allFans: [...job.allFansPageIds].sort((a, b) => a - b),
    openings: openingsHash,
  });
}

const lookupKey = (userId: number, startedAt: number) => `${userId}:${startedAt}`;

/** Where the rows live: the table, or (the read-only check against production) memory. */
export interface ShiftNumbersStore {
  list(input: { userIds: readonly number[]; from: Date; to: Date }): Promise<StoredShiftNumbers[]>;
  put(row: Omit<StoredShiftNumbers, "computedAt">, now: Date): Promise<void>;
}

export function tableStore(db: Database): ShiftNumbersStore {
  return { list: (input) => listStoredShiftNumbers(db, input), put: (row, now) => upsertShiftNumbers(db, row, now) };
}

/** Rows in memory: what the table would hold, for a check on a database that has no table or may not be written. */
export function memoryStore(): ShiftNumbersStore & { size(): number } {
  const rows = new Map<string, StoredShiftNumbers>();
  return {
    size: () => rows.size,
    list: async (input) => [...rows.values()].filter((row) => input.userIds.includes(row.userId)
      && row.startedAt.getTime() >= input.from.getTime() && row.startedAt.getTime() < input.to.getTime()),
    put: async (row, now) => { rows.set(lookupKey(row.userId, row.startedAt.getTime()), { ...row, computedAt: now }); },
  };
}

/** The stored rows that are of these shifts as they are now (closed ones only): job → its numbers. */
export async function storedRowsFor(
  app: Pick<AppContext, "db">, found: TeamShiftJobs, store: ShiftNumbersStore = tableStore(app.db),
): Promise<Map<ShiftJob, ShiftNumbersRow>> {
  const closed = found.jobs.filter((job) => !job.shift.ongoing);
  const out = new Map<ShiftJob, ShiftNumbersRow>();
  if (closed.length === 0) return out;
  const starts = closed.map((job) => job.shift.startedAt);
  const rows = await store.list({
    userIds: [...new Set(closed.map((job) => job.userId))],
    from: new Date(Math.min(...starts)),
    to: new Date(Math.max(...starts) + 1),
  });
  const byShift = new Map(rows.map((row) => [lookupKey(row.userId, row.startedAt.getTime()), row]));
  for (const job of closed) {
    const row = byShift.get(lookupKey(job.userId, job.shift.startedAt));
    if (!row || row.revision !== SHIFT_NUMBERS_REVISION || row.endedAt.getTime() !== job.end || row.key !== shiftKeyOf(job, found.openings)) continue;
    out.set(job, row.numbers as unknown as ShiftNumbersRow);
  }
  return out;
}

/**
 * The cuts the shifts are found in, as each realm's reader finds them: the live agency's ("all", the owner's), and
 * the test team's pages when there are any (the test owner's cut).
 */
async function realmScopes(app: Pick<AppContext, "db">): Promise<Array<"all" | number[]>> {
  const facts = await loadTeamFacts(app.db);
  const test = facts.pages.filter((page) => page.test).map((page) => page.pageId);
  return test.length === 0 ? ["all"] : ["all", test];
}

function markOf(app: Pick<AppContext, "db">, job: ShiftJob): Promise<string> {
  return shiftInputsMark(app.db, {
    userId: job.userId, pageIds: job.pages.map((page) => page.id), start: new Date(job.shift.startedAt), end: new Date(job.end),
    horizonHours: SHIFT_REVIEW_WAIT_HORIZON_HOURS, aiLookbackMinutes: SHIFT_REVIEW_AI_LOOKBACK_MINUTES, deletedUnseenSeconds: SHIFT_REVIEW_DELETED_UNSEEN_SECONDS,
  });
}

async function eachAtMost<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface ShiftNumbersRefresh {
  closed: number;
  written: number;
  kept: number;
}

/** Writes every closed shift since `from` without a fresh row, and rewrites those whose facts moved. */
export async function refreshShiftNumbers(
  app: Pick<AppContext, "db">, input: { from: Date; now: Date; store?: ShiftNumbersStore },
): Promise<ShiftNumbersRefresh> {
  const store = input.store ?? tableStore(app.db);
  const tally: ShiftNumbersRefresh = { closed: 0, written: 0, kept: 0 };
  for (const scope of await realmScopes(app)) {
    const found = await teamShiftJobs(app, { from: input.from, to: input.now, now: input.now, scope });
    const closed = found.jobs.filter((job) => !job.shift.ongoing);
    tally.closed += closed.length;
    if (closed.length === 0) continue;
    const starts = closed.map((job) => job.shift.startedAt);
    const stored = await store.list({
      userIds: [...new Set(closed.map((job) => job.userId))], from: new Date(Math.min(...starts)), to: new Date(Math.max(...starts) + 1),
    });
    const byShift = new Map(stored.map((row) => [lookupKey(row.userId, row.startedAt.getTime()), row]));
    await eachAtMost(closed, PASS_READS_AT_ONCE, async (job) => {
      const key = shiftKeyOf(job, found.openings);
      // The mark before the count: a fact landing between them leaves the old mark, and the next pass counts again.
      const mark = await markOf(app, job);
      const row = byShift.get(lookupKey(job.userId, job.shift.startedAt));
      if (row && row.revision === SHIFT_NUMBERS_REVISION && row.endedAt.getTime() === job.end && row.key === key && row.inputsMark === mark) {
        tally.kept += 1;
        return;
      }
      const numbers = await readJobNumbers(app, job, found.openings);
      await store.put({
        userId: job.userId, startedAt: new Date(job.shift.startedAt), endedAt: new Date(job.end), workedMinutes: job.shift.workedMinutes,
        revision: SHIFT_NUMBERS_REVISION, key, inputsMark: mark, numbers: numbers as unknown as Record<string, unknown>,
      }, new Date());
      tally.written += 1;
    });
  }
  return tally;
}

export interface ShiftNumbersCheck {
  /** Closed shifts with a fresh row, counted live and compared. */
  compared: number;
  /** Of them, the ones whose numbers differ. */
  differ: number;
  /** Closed shifts with no fresh row (the reads count them live). */
  missing: number;
  /** The first three differences: «login 12, смена 2026-11-14T09:00:00.000Z: replyMedianSeconds 120 ≠ 130». */
  first: string[];
  /** Milliseconds: the live count of the closed shifts, and the stored read of the same shifts. */
  liveMs: number;
  storedMs: number;
}

/** The numbers a read shows of one shift (`numbersOf`): what the comparison weighs, insensitive to array order. */
function shownOf(row: ShiftNumbersRow): Record<string, unknown> {
  return numbersOf([{ row, workedMinutes: 0 }]);
}

function firstDifference(a: Record<string, unknown>, b: Record<string, unknown>): string | null {
  for (const field of Object.keys(a)) {
    const left = JSON.stringify(a[field]);
    const right = JSON.stringify(b[field]);
    if (left !== right) return `${field} ${right} ≠ ${left}`;
  }
  return null;
}

/** The shadow check: every closed shift since `from` counted live against its stored row. Reads only. */
export async function compareShiftNumbers(
  app: Pick<AppContext, "db">, input: { from: Date; now: Date; store?: ShiftNumbersStore },
): Promise<ShiftNumbersCheck> {
  const check: ShiftNumbersCheck = { compared: 0, differ: 0, missing: 0, first: [], liveMs: 0, storedMs: 0 };
  for (const scope of await realmScopes(app)) {
    const found = await teamShiftJobs(app, { from: input.from, to: input.now, now: input.now, scope });
    const closed: TeamShiftJobs = { jobs: found.jobs.filter((job) => !job.shift.ongoing), openings: found.openings };
    const storedStart = Date.now();
    const stored = await storedRowsFor(app, closed, input.store);
    check.storedMs += Date.now() - storedStart;
    check.missing += closed.jobs.length - stored.size;
    const liveStart = Date.now();
    await eachAtMost([...stored], PASS_READS_AT_ONCE, async ([job, row]) => {
      const live = await readJobNumbers(app, job, closed.openings);
      check.compared += 1;
      const difference = firstDifference(shownOf(live), shownOf(row));
      if (difference === null) return;
      check.differ += 1;
      if (check.first.length < 3) check.first.push(`login ${job.userId}, смена ${new Date(job.shift.startedAt).toISOString()}: ${difference}`);
    });
    check.liveMs += Date.now() - liveStart;
  }
  return check;
}

/** The check's one line for «Система → Состояние». */
export function checkLine(check: ShiftNumbersCheck): string {
  const head = `Сверено ${check.compared}, расходятся ${check.differ}, без строки ${check.missing}`;
  return check.first.length === 0 ? head : `${head}: ${check.first.join("; ")}`;
}

export const SHIFT_NUMBERS_QUEUE = "team.shift-numbers";
export const SHIFT_NUMBERS_CHECK_QUEUE = "team.shift-numbers.check";

/** One pass of the job. Its returned `detail` is its routine's line in «Система → Состояние». */
export async function runShiftNumbersTick(app: AppContext, now = new Date()): Promise<{ detail: string }> {
  const tally = await refreshShiftNumbers(app, { from: new Date(now.getTime() - SHIFT_NUMBERS_REFRESH_DAYS * DAY_MS), now });
  if (tally.written > 0) app.logger.info(tally, "shift numbers stored");
  return { detail: `Смен ${tally.closed}: записано ${tally.written}, без изменений ${tally.kept}` };
}

export async function runShiftNumbersCheck(app: AppContext, now = new Date()): Promise<{ detail: string }> {
  const check = await compareShiftNumbers(app, { from: new Date(now.getTime() - SHIFT_NUMBERS_CHECK_DAYS * DAY_MS), now });
  app.logger.info({ ...check }, "shift numbers checked against the live count");
  return { detail: checkLine(check).slice(0, 500) };
}

export async function ensureShiftNumbersQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, SHIFT_NUMBERS_QUEUE, { policy: "exclusive" }, createdQueues);
  await ensureQueueCreated(boss, SHIFT_NUMBERS_CHECK_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureShiftNumbersSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  // Every 30 minutes, never in 02:00–02:59 UTC: the 05:20 MSK business dump (docs/runbooks/business-backup.md).
  await boss.schedule(SHIFT_NUMBERS_QUEUE, "17,47 0-1,3-23 * * *", null, { tz: "UTC" });
  // Four times a day, away from the dump and the deploys' usual hours.
  await boss.schedule(SHIFT_NUMBERS_CHECK_QUEUE, "40 4,10,16,22 * * *", null, { tz: "UTC" });
}
