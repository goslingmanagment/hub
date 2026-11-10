import type { AccountReport, AccountReportLine } from "@agency_hub_core/contracts";

/**
 * A chatter's own shift reports (`accountReports`, the agency ledger's
 * breakdown of each shift) in words, for Workboard's «Мои смены», where each
 * report opens in its shift's row. Sales only, no pay. Times are Moscow's. No
 * React here.
 */

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const clock = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

/** `17:28`, Moscow; an unreadable moment is «—». */
export function clockOf(iso: string | null): string {
  if (iso === null) return "—";
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "—" : clock.format(new Date(at));
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

/** A reason without the agent's reference to its rules at the end: «… (§4.2)» → «…». */
export function reasonText(flag: string): string {
  return flag.replace(/\s*\(§[^()]*\)\s*$/u, "").trim();
}

/** The report's sales in two groups, each in the ledger's order: what is in the total, and what was held out. */
export function splitLines(lines: readonly AccountReportLine[]): { counted: AccountReportLine[]; held: AccountReportLine[] } {
  return { counted: lines.filter((line) => line.counted), held: lines.filter((line) => !line.counted) };
}
