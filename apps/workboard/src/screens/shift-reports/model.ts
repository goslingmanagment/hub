/**
 * «Смены → Отчёты»: what the feed shows of each report, pure (no React). Every number is Hub's (`teamShiftReports`):
 * the report's total for this reader, its pages' sums, what it is made of, the shift's sales by the rule before a
 * hand-in, the day's and the period's tallies. Here only the words of a report's state, its one step on one's own
 * report, and which cards a state filter keeps. Nothing here is summed.
 */
import type { TeamShiftReport, TeamShiftReportsResponse } from "@agency_hub_core/contracts";
import { formatTimeOfDay, formatWeekdayDay } from "@agency_hub_core/ui/format";
import { addDays, moscowDayOf } from "@agency_hub_core/ui/moscow";
import { checkWords, noteworthyCheckWords } from "../../shared/reportChecks.js";
import type { ReportStep } from "../my-shifts/model.js";

export type Report = TeamShiftReport;
export type Tally = TeamShiftReportsResponse["totals"];

// ─────────────────────────────────────────────────────────────── The state

/** «в 16:04», or «чт, 20 нояб. в 00:12» when it happened on another day than the shift's report. */
function atWords(at: string, reportDate: string): string {
  return moscowDayOf(at) === reportDate ? `в ${formatTimeOfDay(at)}` : `${formatWeekdayDay(at)} в ${formatTimeOfDay(at)}`;
}

/** Where a report stands, in plain words, with the check's few words; the step is one's own only. */
export interface FeedStep extends ReportStep {
  /** Hub's check and Gengar's, as the board says them. */
  facts: string[];
}

/**
 * The state of a report and, on one's own, the ONE step «Мои» shows (a button to the board). Someone else's report has
 * no step: its card opens the shift's page. Pure.
 */
export function feedStepOf(report: Report): FeedStep {
  const own = report.own;
  const handed = report.report;
  const facts = report.check === null ? [] : report.phase === "checking" || report.phase === "confirm" ? checkWords(report.check) : noteworthyCheckWords(report.check);
  const via = handed?.door === "telegram" ? "со слов, через Генгара" : null;
  if (handed === null) {
    if (report.ongoing) return { words: "Идёт", tone: "live", note: "отчёт в конце смены", action: null, facts: [] };
    if (report.board) return { words: "Не сдан", tone: "warn", note: null, action: own ? "Сдать смену" : null, facts: [] };
    return { words: "По-старому", tone: "quiet", note: "отчёт постом в «Отчётности»", action: null, facts: [] };
  }
  const handedAt = `сдан ${atWords(handed.at, report.reportDate)}${via === null ? "" : `, ${via}`}`;
  switch (report.phase) {
    case "checking":
      return { words: "Проверка", tone: "live", note: handedAt, action: null, facts };
    case "confirm":
      return { words: "Ждёт подтверждения", tone: "warn", note: own ? "без «Подтверждаю» отчёт не учтён" : handedAt, action: own ? "Подтвердить" : null, facts };
    case "fixing": {
      const counted = report.counted === null ? null : `учтён ${atWords(report.counted.at, report.reportDate)}, версия ${report.counted.version}`;
      return { words: "Правка", tone: "warn", note: own ? "исправьте и сдайте заново" : counted, action: own ? "Сдать заново" : null, facts };
    }
    default: {
      if (own && report.postCopied === false) return { words: "Учтён", tone: "warn", note: "осталось скопировать пост в «Отчётность»", action: "Скопировать пост", facts };
      const counted = report.counted ?? { version: handed.number, at: handed.at };
      return { words: `Учтён ${atWords(counted.at, report.reportDate)}, версия ${counted.version}`, tone: "good", note: via, action: null, facts };
    }
  }
}

// ─────────────────────────────────────────────────────────────── The filters

/** The state filter of the address (`?state=`): the reports not handed in, or those waiting for «Подтверждаю». */
export type StateFilter = "due" | "confirm";

export function stateFilterOf(value: string | null): StateFilter | null {
  return value === "due" || value === "confirm" ? value : null;
}

/** Whether a report is one the state filter keeps. Pure. */
export function keeps(report: Report, filter: StateFilter | null): boolean {
  if (filter === null) return true;
  if (filter === "confirm") return report.waitsConfirm;
  return report.report === null && report.board && !report.ongoing;
}

// ─────────────────────────────────────────────────────────────── The day

/** «Сегодня», «Вчера», else «Ср, 18 нояб.». */
export function dayTitle(day: string, today: string): string {
  if (day === today) return "Сегодня";
  if (day === addDays(today, -1)) return "Вчера";
  const words = formatWeekdayDay(day);
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}
