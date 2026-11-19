/**
 * «Мои смены» — what the screen shows of the person's shifts and their reports; pure, no React
 * (tests/workboard-my-shifts.test.ts). Which report is which shift's is Hub's (`accountShifts`,
 * apps/runtime/src/services/own-shift-rows.ts): the rows come paired, with two named numbers — the shift's sales by the
 * rule and its report's one number. Here: the period's window (what to ask for), each row's one label of a shift, and
 * the line of facts over the rows. Sales only — nothing here is pay.
 */
import type { ChatterStats, OwnShiftRow } from "@agency_hub_core/contracts";
import { formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf, moscowDayStart } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { REPORT_DRAFT_NEXT, reportStatusWord } from "@agency_hub_core/ui/shiftReports";
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

// ─────────────────────────────────────────────────────────────── The report's step

/** What a missing report asks of the chatter (the old way: the agent composes it from the shift's sales). */
export const MISSING_NEXT = "попросите в чате: /smena";

/**
 * Where a shift's report stands, in plain words, and the ONE thing to do next when something is due — a button that
 * opens the board (`/report/:shiftId`). The state is Hub's: the row's (`accountShifts`) and, for a report handed in in
 * Hub, its board's phase and whether its post was copied (`shiftReportsList`).
 */
export interface ReportStep {
  /** «Сдайте смену», «Сдан в 16:04, версия 1», «Пост отправлен». Empty — nothing known (the reports did not come). */
  words: string;
  /** warn — something is the person's to do; good — done; live — the shift goes on; quiet — nothing to say more. */
  tone: "warn" | "good" | "live" | "quiet";
  /** A quieter line beside the words. */
  note: string | null;
  /** The button's words, opening the board; null — nothing to do now. */
  action: string | null;
}

/** The step of a row. Pure. */
export function reportStepOf(row: OwnShiftRow): ReportStep {
  const phase = row.hub?.phase ?? null;
  // Handed in (while the shift goes on too), and after a correction: the board's phase leads while it checks or asks.
  if (row.hub !== null) {
    if (phase === "checking") return { words: "Проверяется", tone: "live", note: "Hub сверяет суммы, Генгар читает переписки", action: null };
    if (phase === "confirm") return { words: "Подтвердите отчёт", tone: "warn", note: "без «Подтверждаю» отчёт не учтён", action: "Подтвердить" };
  }
  switch (row.state) {
    case "ongoing":
      return { words: "Идёт", tone: "live", note: "отчёт в конце смены", action: null };
    case "due":
      return { words: "Сдайте смену", tone: "warn", note: null, action: "Сдать смену" };
    case "handed": {
      if (phase === "fixing") return { words: "Отчёт открыт снова", tone: "warn", note: "исправьте и сдайте заново", action: "Сдать заново" };
      if (phase === "counted" && row.hub?.postCopied === false) {
        return { words: "Учтён", tone: "warn", note: "осталось скопировать пост в «Отчётность»", action: "Скопировать пост" };
      }
      const at = row.hub?.submittedAt ?? null;
      const version = row.hub?.version ?? null;
      const words = [at === null ? "Сдан" : `Сдан в ${formatTimeOfDay(at)}`, version === null ? null : `версия ${version}`].filter(Boolean).join(", ");
      return { words, tone: "good", note: null, action: null };
    }
    case "posted":
      return { words: "Пост отправлен", tone: "good", note: row.draftMills === null ? null : `в черновике было ${formatMills(row.draftMills)}`, action: null };
    case "draft":
      return { words: "Собран", tone: "warn", note: REPORT_DRAFT_NEXT, action: null };
    case "missing":
      return { words: "Отчёта нет", tone: "warn", note: MISSING_NEXT, action: null };
    case "other":
      return { words: reportStatusWord(row.report?.status ?? ""), tone: "quiet", note: null, action: null };
    case "unknown":
      return { words: "", tone: "quiet", note: null, action: null };
  }
}

/** The kinds of a sale as a card says them, short. */
export const KIND_SHORT: Readonly<Record<keyof StatsShift["byKind"], string>> = {
  ppv: "PPV",
  tip: "чаевые",
  subscription: "подписки",
  post: "посты",
};
