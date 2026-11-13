import type { AccountReport, AccountReportLine, TeamLedgerReportPost } from "@agency_hub_core/contracts";

/**
 * Shift reports (the agency ledger's breakdown of each shift, and the posts in
 * «Отчётность» it reads) in words: a chatter's own in Workboard's «Мои смены»
 * (`accountReports`: sales only, no pay), every chatter's for the owner in
 * «Выплаты → Отчёты» (`teamLedgerReports`), and a post's flags as «Ждут вас»
 * says them. What of them waits for the owner is Hub's to say (the matters'
 * mirror). Times are Moscow's. No React here.
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

/** A report's state (the ledger's `status`) in a word. A post's is «Пост отправлен»; one handed in in Hub is «Сдан». */
export const REPORT_STATUS_WORDS = {
  draft: "Собран",
  posted: "Пост отправлен",
  superseded: "Заменён",
} as const;

/** What a chatter does with a report that is only composed. */
export const REPORT_DRAFT_NEXT = "проверьте и отправьте в Отчётность";

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

// ─────────────────────────────────────────────── The owner's: posts and questions

/** What a post's flag says, in a few words (the ledger's codes; an unknown one as it came). */
export const POST_FLAG_WORDS: Readonly<Record<string, string>> = {
  unknown_author: "автор не узнан",
  no_date: "дата не прочитана",
  date_mismatch: "дата дальше суток от отправки",
  sum_mismatch: "страницы не сходятся с итогом",
  unknown_page: "страница не узнана",
  tag_mismatch: "тег другого человека",
  duplicate: "повтор: учтён последний пост",
};

/** Why a flag matters, said in full (a hint): what the ledger did with the post and what fixes it. */
export const POST_FLAG_HINTS: Readonly<Record<string, string>> = {
  unknown_author: "Ledger не понял, чей это пост: отправитель не записан за человеком, и #тега нет. Пост не входит в оплату, пока автора не привяжут в ledger.",
  no_date: "В посте не прочиталась дата отчёта. Пост не входит в оплату, пока его не поправят.",
  date_mismatch: "Дата в посте дальше суток от дня отправки: скорее всего, опечатка. Пост не входит в оплату, пока его не поправят.",
  sum_mismatch: "Суммы по страницам не дают «Общий доход» поста. Пост не входит в оплату, пока его не поправят.",
  unknown_page: "Имя страницы в посте ledger не знает: эта строка не входит в оплату, остальные входят.",
  tag_mismatch: "#тег поста указывает на другого человека; ledger считает автором отправителя.",
  duplicate: "Та же страница того же дня есть в другом посте; считается последний.",
};

export function postFlagWord(flag: string): string {
  return POST_FLAG_WORDS[flag] ?? flag;
}

/** A post is about a page when one of its account lines is that page; a post with no page Hub knows is every page's. */
export function postOnPage(post: Pick<TeamLedgerReportPost, "pages">, page: string | null): boolean {
  if (page === null) return true;
  const labels = post.pages.map((line) => line.pageLabel).filter((label): label is string => label !== null);
  return labels.length === 0 || labels.includes(page);
}
