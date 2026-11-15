/**
 * «Мои смены» — what the screen shows of the person's shifts and their reports; pure, no React
 * (tests/workboard-my-shifts.test.ts). Which report is which shift's is Hub's (`accountShifts`,
 * apps/runtime/src/services/own-shift-rows.ts): the rows come paired, with two named numbers — the shift's sales by the
 * rule and its report's one number. Here: the period's window (what to ask for), each row's one label of a shift, and
 * the line of facts over the rows. Sales only — nothing here is pay.
 */
import type { ChatterStats, OwnShiftRow, OwnShiftRowState } from "@agency_hub_core/contracts";
import { addDays, daysInRange, moscowDayOf, moscowDayStart, type MoscowDay } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { perHourMills } from "../../shared/metrics.js";

export type StatsShift = ChatterStats["shifts"][number];

/** The longest window `accountShifts` reads (Moscow days): a longer own range shows its last days. */
export const MY_SHIFTS_MAX_DAYS = 31;

// ─────────────────────────────────────────────────────────────── The window

export interface MyShiftsWindow {
  /** What `accountShifts` is asked for. */
  days: number;
  until: MoscowDay | undefined;
  /** The shown Moscow days, both included (a week's days to come are inside, empty). */
  from: MoscowDay;
  to: MoscowDay;
  /** `[startsAt, endsAt)`, ms: Moscow midnight of `from` and of the day after `to`. */
  startsAt: number;
  endsAt: number;
  /** The period is longer than Hub reads: its last MY_SHIFTS_MAX_DAYS days are shown. */
  clipped: boolean;
}

/** The window of a period of the app (spec §3: week · 14 · 30 · own range). */
export function myShiftsWindow(period: ResolvedPeriod): MyShiftsWindow {
  const { spec } = period;
  let days: number;
  let until: MoscowDay | undefined;
  let from: MoscowDay;
  let to: MoscowDay;
  let clipped = false;
  if (spec.kind === "week") {
    // The whole calendar week: its days to come are empty.
    days = 7;
    until = addDays(spec.monday, 6);
    from = spec.monday;
    to = until;
  } else if (spec.kind === "days") {
    days = spec.days;
    until = undefined;
    from = period.from;
    to = period.to;
  } else {
    const full = daysInRange(period.from, period.to);
    days = Math.min(full, MY_SHIFTS_MAX_DAYS);
    until = period.to;
    from = addDays(period.to, -(days - 1));
    to = period.to;
    clipped = full > days;
  }
  return {
    days,
    until,
    from,
    to,
    startsAt: Date.parse(moscowDayStart(from)),
    endsAt: Date.parse(moscowDayStart(addDays(to, 1))),
    clipped,
  };
}

// ──────────────────────────────────────────────────────────────── The rows

/**
 * The state of a row, in words on the screen: `posted` «Пост отправлен», `draft` «Собран» (check it and send it),
 * `missing` «Отчёта нет», `ongoing` «Идёт», `unknown` (nothing said per row), `other` (the ledger's own word); with the
 * person's switch «сдаёт смену в системе» on: `due` «Сдайте смену», `handed` «Сдан».
 */
export type RowState = OwnShiftRowState;

/** A row as Hub paired it, with its one label of a shift (D12) and its pages. */
export interface MyShiftRow extends OwnShiftRow {
  /** The shift's own label; a report alone — its window's, or its day alone. */
  when: ShiftWhen;
  /** Where the shift worked (Hub); a report alone — the report's pages. */
  pages: string[];
}

/** Hub's report of a shift row (`shiftReportsList`). */
export type HubShiftReport = NonNullable<OwnShiftRow["hub"]>;

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
