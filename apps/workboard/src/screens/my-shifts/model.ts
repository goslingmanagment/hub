/**
 * «Мои смены» — what the screen shows of the person's shifts and their reports; pure, no React
 * (tests/workboard-my-shifts.test.ts). Which report is which shift's is Hub's (`accountShifts`,
 * apps/runtime/src/services/own-shift-rows.ts): the rows come paired, with two named numbers — the shift's sales by the
 * rule and its report's one number. Here: the period's window (what to ask for), each row's one label of a shift, and
 * the line of facts over the rows. Sales only — nothing here is pay.
 */
import type { ChatterStats, OwnShiftRow } from "@agency_hub_core/contracts";
import { addDays, moscowDayOf, moscowDayStart } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { perHourMills } from "../../shared/metrics.js";
import { SHIFT_READS_MAX_DAYS, shiftsWindow, type ShiftsWindow } from "../../shared/shiftsWindow.js";

export type StatsShift = ChatterStats["shifts"][number];

/** The longest window `accountShifts` reads (Moscow days): a longer own range shows its last days. */
export const MY_SHIFTS_MAX_DAYS = SHIFT_READS_MAX_DAYS;

// ─────────────────────────────────────────────────────────────── The window

/** The shift reads' window (`accountShifts` is asked its `days`/`until`), with its instants. */
export interface MyShiftsWindow extends ShiftsWindow {
  /** `[startsAt, endsAt)`, ms: Moscow midnight of `from` and of the day after `to`. */
  startsAt: number;
  endsAt: number;
}

/** The window of a period of the app (spec §3: week · 14 · 30 · own range). */
export function myShiftsWindow(period: ResolvedPeriod): MyShiftsWindow {
  const window = shiftsWindow(period);
  return {
    ...window,
    startsAt: Date.parse(moscowDayStart(window.from)),
    endsAt: Date.parse(moscowDayStart(addDays(window.to, 1))),
  };
}

// ──────────────────────────────────────────────────────────────── The rows

/** A row as Hub paired it, with its one label of a shift (D12) and its pages. */
export interface MyShiftRow extends OwnShiftRow {
  /** The shift's own label; a report alone — its window's, or its day alone. */
  when: ShiftWhen;
  /** Where the shift worked (Hub); a report alone — the report's pages. */
  pages: string[];
}

/** Hub's rows, each with its label. Pure. */
export function rowsOf(rows: readonly OwnShiftRow[]): MyShiftRow[] {
  return rows.map((row) => {
    const { shift, report } = row;
    let when: ShiftWhen;
    if (shift !== null) when = shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, workedMinutes: shift.workedMinutes });
    else if (report?.windowFrom && report.windowTo && Date.parse(report.windowTo) > Date.parse(report.windowFrom)) when = shiftWhen({ startedAt: report.windowFrom, endedAt: report.windowTo });
    else when = dayOnly(moscowDayStart(report?.reportDate ?? moscowDayOf(Date.now())));
    return { ...row, when, pages: shift !== null ? shift.pages : (report?.pages ?? []).map((page) => page.pageLabel) };
  });
}

/** The label of a report Hub has no shift for and that has no window (a post written by hand): its day alone. */
function dayOnly(dayStart: string): ShiftWhen {
  const when = shiftWhen({ startedAt: dayStart, endedAt: dayStart });
  return { ...when, time: UNKNOWN_TIME, label: `${when.days}, ${UNKNOWN_TIME}` };
}

/** The clock of a shift nobody knows the hours of. */
export const UNKNOWN_TIME = "время смены не известно";

// ─────────────────────────────────────────────────────────────── The facts

export interface MyShiftsFacts {
  /** Rows: Hub's shifts and the reports Hub has no shift for. */
  shifts: number;
  /** Hub's worked time of the shifts, pauses left out. */
  workedMinutes: number;
  /** The sum of the reports' one numbers (what was posted, else the draft's total); null — the reports or the posts did not come. */
  reportedMills: number | null;
  /** The report totals of shifts with a report over their worked time; null — no such shift. */
  perHourMills: number | null;
  /** Ended shifts with neither a draft nor a post: the one thing to act on. 0 while the reports or the posts are unknown. */
  withoutReport: number;
  /** Reports to check and send («Собран»). */
  drafts: number;
}

export function factsOf(rows: readonly MyShiftRow[], reportsKnown: boolean): MyShiftsFacts {
  let workedMinutes = 0;
  let reportedMills = 0;
  let pairedMills = 0;
  let pairedMinutes = 0;
  for (const row of rows) {
    workedMinutes += row.workedMinutes ?? 0;
    reportedMills += row.totalMills ?? 0;
    if (row.shift !== null && row.report !== null) {
      pairedMills += row.report.totalMills;
      pairedMinutes += row.shift.workedMinutes;
    }
  }
  return {
    shifts: rows.length,
    workedMinutes,
    reportedMills: reportsKnown ? reportedMills : null,
    perHourMills: reportsKnown ? perHourMills(pairedMills, pairedMinutes) : null,
    withoutReport: rows.filter((row) => row.state === "missing").length,
    drafts: rows.filter((row) => row.state === "draft").length,
  };
}
