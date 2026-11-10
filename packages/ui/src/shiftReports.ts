import { ACCOUNT_REPORTS_DEFAULT_DAYS, type AccountReport, type AccountReportLine } from "@agency_hub_core/contracts";
import { addDays, moscowToday, type MoscowDay } from "./moscow.js";

/**
 * A chatter's own shift reports (`accountReports`, the agency ledger's
 * breakdown of each shift) in words, for both screens that show them: the
 * cabinet's «Отчёт смены» (apps/dashboard) and Workboard's «Мои отчёты». Sales
 * only, no pay. Times are Moscow's. No React here.
 */

/** The screens' two windows: the last 14 or 30 Moscow days. */
export const REPORT_PERIODS = [
  { days: 14, label: "14 дней" },
  { days: 30, label: "30 дней" },
] as const;

/** `?days=14|30` of the address; anything else is the default 14. */
export function reportPeriodOf(raw: string | null | undefined): number {
  const value = Number(raw);
  return REPORT_PERIODS.some((period) => period.days === value) ? value : ACCOUNT_REPORTS_DEFAULT_DAYS;
}

/** The last `days` Moscow days, today included: the query of `accountReports`. */
export function reportDates(days: number, now: Date = new Date()): { from: MoscowDay; to: MoscowDay } {
  const to = moscowToday(now);
  return { from: addDays(to, -(days - 1)), to };
}

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

/** `сб, 8 ноября` of a Moscow `YYYY-MM-DD`. */
export function reportDay(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return `${weekday.format(at)}, ${dayMonth.format(at)}`;
}

/** `17:28`, Moscow; an unreadable moment is «—». */
export function clockOf(iso: string | null): string {
  if (iso === null) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : clock.format(new Date(at));
}

/** The shift's window in Moscow: `16:00–00:00`. */
export function reportWindow(report: Pick<AccountReport, "windowFrom" | "windowTo">): string {
  return `${clockOf(report.windowFrom)}–${clockOf(report.windowTo)}`;
}

function moscowDay(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * `собран в 23:54 · версия 2 из 2`. A report composed on its day or the night after shows the time
 * alone; one recomputed later names the day too.
 */
export function savedLine(report: Pick<AccountReport, "reportDate" | "savedAt" | "version" | "versions">): string {
  const day = moscowDay(report.savedAt);
  const nextDay = new Date(Date.parse(`${report.reportDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  const when = day === null || day === report.reportDate || day === nextDay
    ? `в ${clockOf(report.savedAt)}`
    : `${dayMonth.format(new Date(`${day}T12:00:00Z`))} в ${clockOf(report.savedAt)}`;
  return `собран ${when} · версия ${report.version} из ${report.versions}`;
}

/** A report's state (the ledger's `status`) in a word. */
export const REPORT_STATUS_WORDS = {
  draft: "Собран",
  posted: "Отправлен",
  superseded: "Заменён",
} as const;

/** What a chatter does with a report that is only composed. */
export const REPORT_DRAFT_NEXT = "проверь и отправь в Отчётность";

/** The state in a word; an unknown one as it came. */
export function reportStatusWord(status: string): string {
  return (REPORT_STATUS_WORDS as Readonly<Record<string, string>>)[status] ?? status;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  message_purchase: "ппв",
  subscription: "подписка",
  tip: "тип",
  post_purchase: "пост",
  stream_tip: "тип на стриме",
};

/** What a sale is, in the words of the report; an unknown type as it came. */
export function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

/** The fan as the report names them: the nickname, else the platform's id; null — none (an amount added by hand). */
export function fanOf(line: Pick<AccountReportLine, "fanName" | "fanRef">): string | null {
  const name = line.fanName.trim();
  if (name !== "") return name;
  const ref = line.fanRef.trim();
  return ref === "" ? null : ref;
}

/** A reason without the agent's reference to its rules at the end: «… (§4.2)» → «…». */
export function reasonText(flag: string): string {
  return flag.replace(/\s*\(§[^()]*\)\s*$/u, "").trim();
}

/** The report's sales in two groups, each in the ledger's order: what is in the total, and what was held out. */
export function splitLines(lines: readonly AccountReportLine[]): { counted: AccountReportLine[]; held: AccountReportLine[] } {
  return { counted: lines.filter((line) => line.counted), held: lines.filter((line) => !line.counted) };
}
