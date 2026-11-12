import { MATTER_INFO_KINDS } from "@agency_hub_core/contracts";
import { ruPlural } from "@agency_hub_core/ui/plural";

/**
 * «Ждут вас»: which group a matter's kind is in, and the words for a kind
 * that could not be checked. A kind this file does not know (another
 * package's, an agent's) goes to «Другие дела» and shows its own title, link
 * and age: nothing here has to change for a new kind.
 */

export type WaitingGroupId = "questions" | "reports" | "customs" | "held" | "publications" | "people" | "ledger" | "system" | "other" | "info";

export interface WaitingGroup {
  id: WaitingGroupId;
  title: string;
}

/** The groups in the list's order: the old sections of «Решения» first (their anchors still open them), what only informs last. */
export const WAITING_GROUPS: readonly WaitingGroup[] = [
  { id: "questions", title: "Чья продажа" },
  { id: "reports", title: "Отчёты смен" },
  { id: "customs", title: "Кастомы" },
  { id: "held", title: "Зависшие отправки" },
  { id: "publications", title: "Публикации" },
  { id: "people", title: "Люди и доступ" },
  { id: "ledger", title: "Проверки ledger" },
  { id: "system", title: "Сбор и сбои" },
  { id: "other", title: "Другие дела" },
  { id: "info", title: "Для сведения" },
];

const INFO: ReadonlySet<string> = new Set(MATTER_INFO_KINDS);

export function groupOf(kind: string): WaitingGroupId {
  if (INFO.has(kind)) return "info";
  if (kind === "ledger.sale_question") return "questions";
  if (kind === "ledger.report_post" || kind === "ledger.paid_day_changed") return "reports";
  if (kind.startsWith("custom.")) return "customs";
  if (kind === "send.held") return "held";
  if (kind.startsWith("publication.")) return "publications";
  if (kind.startsWith("people.")) return "people";
  if (kind === "ledger.check" || kind === "ledger.sheet_column" || kind === "ledger.off_platform") return "ledger";
  if (kind === "page.login_needed" || kind === "incident.open" || kind === "extension.critical" || kind === "history.request") return "system";
  return "other";
}

/** An address's anchor (`/decisions#held`): the list of that group alone. Today's four and the new rows' of the console's Home. */
export function groupOfAnchor(hash: string): WaitingGroupId | null {
  const id = hash.replace(/^#/, "");
  return WAITING_GROUPS.some((group) => group.id === id) ? (id as WaitingGroupId) : null;
}

/** What could not be checked, in a few words: «Не удалось проверить: кастомы, проверки ledger». */
const UNCHECKED_WORD: Readonly<Record<string, string>> = {
  "publication.draft": "посты на утверждение",
  "publication.unknown": "исход публикаций",
  "ledger.sale_question": "вопросы «чья продажа»",
  "ledger.report_post": "отчёты смен",
  "ledger.paid_day_changed": "отчёты смен",
  "custom.paid_not_delivered": "кастомы",
  "send.held": "зависшие отправки",
  "page.login_needed": "вход в Fansly",
  "incident.open": "сбои",
  "extension.critical": "сбои расширения",
  "history.request": "заявки на историю",
  "ledger.check": "проверки ledger",
  "ledger.sheet_column": "проверки ledger",
  "ledger.off_platform": "проверки ledger",
};

export function uncheckedWords(kinds: readonly string[]): string[] {
  const words: string[] = [];
  for (const kind of kinds) {
    const word = UNCHECKED_WORD[kind] ?? (kind.startsWith("people.") ? "люди и доступ" : "другие дела");
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

/**
 * Since when a matter waits: the moment its own finding names (a send's, a
 * question's, a payment's, a red check's first run), else when it was opened.
 */
export function waitingSince(matter: { kind: string; openedAt: string; evidence: Record<string, unknown> }): string {
  const fields = ["sentAt", "askedAt", "paidAt", "postedAt", "openedAt", "requestedAt", "failingSince", "saidAt", "publishAt"];
  for (const field of fields) {
    const value = matter.evidence[field];
    if (typeof value !== "string") continue;
    const at = Date.parse(value);
    // A publication's moment is when it goes out, not when it waits: only a past one counts.
    if (!Number.isNaN(at) && at <= Date.now() && at <= Date.parse(matter.openedAt) + 60_000) return new Date(at).toISOString();
  }
  return matter.openedAt;
}

/** «12 мин», «5 ч», «3 дня»: how long it waits, short. */
export function waitedFor(sinceIso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}
