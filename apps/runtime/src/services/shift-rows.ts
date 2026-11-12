import {
  syncShiftRows,
  type Database,
  type ShiftChangeKind,
  type ShiftRowFacts,
  type ShiftRowRecord,
  type ShiftRowsPlan,
  type ShiftRowsSyncResult,
} from "@agency_hub_core/db";
import { shiftReportDay } from "@agency_hub_core/look";

import type { AppContext } from "../bootstrap.ts";
import { readPeopleWork, type ComputedWork } from "./chatter-shifts.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

/**
 * A chatter's shift as a row with a stable id (0379 `shifts`). What a shift is
 * stays chatter-shifts.ts's: this job computes everyone's work as every screen
 * does (`readPeopleWork`, every page) and writes each shift it finds, going or
 * over. A shift keeps its id while its start moves (a look-in before it joins
 * it) and when two pieces merge (the older id stays, the other row is
 * `merged` into it); a row late activity unmade is `dropped`, never deleted.
 * Every change after the first write is traced (`shift_changes`).
 *
 * In shadow: no screen reads the rows yet. A shift's report date is
 * `reportDateOfShift`, ledger's rule, the one day every system will report a
 * shift on.
 */

const DAY_MS = 86_400_000;

/** How far back each run looks: a shift that ended earlier is no longer changed by the job (a CLI run can). */
export const SHIFT_ROWS_LOOKBACK_DAYS = 2;

/**
 * The Moscow day a shift is reported on (ledger internal/payroll/source.go `ReportDate`): `shiftReportDay`, the one
 * function Hub and Workboard put a shift's report on. Pure.
 */
export function reportDateOfShift(work: { startedAt: number; endedAt: number }): string {
  return shiftReportDay(work.startedAt, work.endedAt);
}

/** A computed shift as its row holds it. Pure. */
export function shiftRowFactsOf(userId: number, work: ComputedWork): ShiftRowFacts {
  return {
    userId,
    state: work.ongoing ? "going" : "closed",
    startedAt: new Date(work.startedAt),
    endedAt: new Date(work.endedAt),
    workedMinutes: work.workedMinutes,
    messages: [...work.messages.values()].reduce((sum, count) => sum + count, 0),
    reportDate: reportDateOfShift(work),
    pages: [...new Set([...work.pages.keys(), ...work.messages.keys()])].sort().map((pageLabel) => {
      const since = work.salesSince.get(pageLabel);
      return {
        pageLabel,
        activeMinutes: work.pages.get(pageLabel) ?? 0,
        messages: work.messages.get(pageLabel) ?? 0,
        salesFrom: since === undefined ? null : new Date(since).toISOString(),
      };
    }),
    pauses: work.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
  };
}

const overlaps = (a: { startedAt: Date; endedAt: Date }, b: { startedAt: Date; endedAt: Date }) =>
  a.startedAt.getTime() === b.startedAt.getTime()
  || (a.startedAt.getTime() < b.endedAt.getTime() && b.startedAt.getTime() < a.endedAt.getTime());

// Field by field: a row read back from jsonb has its keys in jsonb's order, not the order they were written in.
const samePages = (a: ShiftRowFacts["pages"], b: ShiftRowFacts["pages"]) => a.length === b.length && a.every((page, at) => {
  const other = b[at]!;
  return page.pageLabel === other.pageLabel && page.activeMinutes === other.activeMinutes && page.messages === other.messages
    && page.salesFrom === other.salesFrom;
});
const samePauses = (a: ShiftRowFacts["pauses"], b: ShiftRowFacts["pauses"]) =>
  a.length === b.length && a.every((pause, at) => pause.from === b[at]!.from && pause.to === b[at]!.to);

/** What changed between a row and the shift computed for it; null — nothing. Pure. */
function changeOf(row: ShiftRowRecord, after: ShiftRowFacts): { change: ShiftChangeKind | null } | null {
  if (row.state === "dropped" || row.state === "merged") return { change: "restored" };
  if (row.state === "going" && after.state === "closed") return { change: "closed" };
  if (row.state === "closed" && after.state === "going") return { change: "reopened" };
  const moved = row.startedAt.getTime() !== after.startedAt.getTime();
  const rest = row.endedAt.getTime() !== after.endedAt.getTime() || row.workedMinutes !== after.workedMinutes
    || row.messages !== after.messages || row.reportDate !== after.reportDate || !samePages(row.pages, after.pages)
    || !samePauses(row.pauses, after.pauses);
  if (after.state === "going") {
    // A going shift's end, minutes and pages move with every look: traced only when its start moves.
    if (moved) return { change: "moved" };
    return rest ? { change: null } : null;
  }
  return moved || rest ? { change: "moved" } : null;
}

/**
 * What a sync changes. `existing` — the rows that ended after the look-back's start less a day (any state);
 * `computed` — everyone's shifts as computed now, read from a day before `from`; `from` — the look-back's start. A
 * computed shift that began before `from` may be cut by the read: it only keeps the rows it overlaps from being
 * dropped. Each other computed shift takes the oldest live row of its person it overlaps (a dropped one if none),
 * the other live rows it overlaps merge into it; none — a new row. A live row that began at `from` or later and no
 * computed shift overlaps is dropped. Pure.
 */
export function planShiftRows(input: { existing: readonly ShiftRowRecord[]; computed: readonly ShiftRowFacts[]; from: Date }): ShiftRowsPlan {
  const plan: ShiftRowsPlan = { open: [], update: [], merge: [], drop: [] };
  const from = input.from.getTime();
  const claimed = new Set<number>();
  const byUser = new Map<number, ShiftRowRecord[]>();
  for (const row of input.existing) {
    if (row.state === "merged") continue;
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }
  const computed = [...input.computed].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.userId - b.userId);
  for (const after of computed) {
    const rows = (byUser.get(after.userId) ?? []).filter((row) => !claimed.has(row.id) && overlaps(row, after));
    const live = rows.filter((row) => row.state !== "dropped").sort((a, b) => a.id - b.id);
    const dropped = rows.filter((row) => row.state === "dropped").sort((a, b) => a.id - b.id);
    if (after.startedAt.getTime() < from) {
      for (const row of live) claimed.add(row.id);
      continue;
    }
    const keeper = live[0] ?? dropped[0];
    if (keeper === undefined) {
      plan.open.push(after);
      continue;
    }
    claimed.add(keeper.id);
    for (const other of live.slice(keeper === live[0] ? 1 : 0)) {
      claimed.add(other.id);
      plan.merge.push({ id: other.id, into: keeper.id, before: other });
    }
    const changed = changeOf(keeper, after);
    if (changed !== null) plan.update.push({ id: keeper.id, change: changed.change, before: keeper, after });
  }
  for (const rows of byUser.values()) {
    for (const row of rows) {
      if (claimed.has(row.id) || row.state === "dropped" || row.startedAt.getTime() < from) continue;
      plan.drop.push({ id: row.id, before: row });
    }
  }
  return plan;
}

/**
 * Computes everyone's shifts since `from` (and a day before, so a shift that began before it is whole) and writes them
 * as rows. `now` decides which still go.
 */
export async function syncShiftRowsSince(db: Database, input: { from: Date; now: Date }): Promise<ShiftRowsSyncResult> {
  const { from, now } = input;
  const people = await readPeopleWork(db, { from: new Date(from.getTime() - DAY_MS), to: now, now, pages: "all" });
  const computed = [...people].flatMap(([userId, person]) => person.work
    .filter((work) => work.kind === "shift")
    .map((work) => shiftRowFactsOf(userId, work)));
  return syncShiftRows(db, {
    endedAfter: new Date(from.getTime() - DAY_MS),
    now,
    plan: (existing) => planShiftRows({ existing, computed, from }),
  });
}

export const SHIFT_ROWS_QUEUE = "team.shift-rows";

/** One run of the job: the last SHIFT_ROWS_LOOKBACK_DAYS. */
export async function runShiftRowsTick(app: Pick<AppContext, "db" | "logger">): Promise<ShiftRowsSyncResult> {
  const now = new Date();
  const result = await syncShiftRowsSince(app.db, { from: new Date(now.getTime() - SHIFT_ROWS_LOOKBACK_DAYS * DAY_MS), now });
  if (result.opened + result.merged + result.dropped + result.traced > 0) app.logger.info(result, "shift rows synced");
  return result;
}

export async function ensureShiftRowsQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, SHIFT_ROWS_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureShiftRowsSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  // Every ten minutes: a shift gets its id within ten minutes of being recognised.
  await boss.schedule(SHIFT_ROWS_QUEUE, "*/10 * * * *", null, { tz: "UTC" });
}
