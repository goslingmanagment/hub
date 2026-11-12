import { WAITING_GROUPS, waitingGroupOf, type WaitingGroupId } from "@agency_hub_core/contracts";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { contentopsHref } from "@agency_hub_core/ui/sites";

/**
 * «Ждут вас»: the anchors of the groups, the words for a kind that could not be
 * checked, and how long a line waits. A kind no group knows (an agent's own)
 * goes to «Другие дела» and shows its own title, link and age.
 */

/**
 * The groups, their titles and order, and which group a kind is in: the one table in contracts (waiting-groups.ts),
 * which Hub's server counts the console Home's chips by too. Nothing is grouped here.
 */
export { WAITING_GROUPS, type WaitingGroup, type WaitingGroupId } from "@agency_hub_core/contracts";
export const groupOf = waitingGroupOf;

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
  "report.post_fix": "отчёты смен",
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

/** «2026-W46»: the ISO week of a day (Monday first), as ContentOps' plan addresses its weeks. */
export function isoWeekOf(day: string): string | null {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // The Thursday of the day's week names its year and number.
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Where a ContentOps matter is decided, in ContentOps (its model's code is the
 * evidence's `model`): a custom's copy outside the customs folder in the
 * inbox's «Копии кастомов», a custom in the plan on the plan's week of its
 * slot. A matter's own `link` stays a hub path, so the address is made here.
 * Without what an address needs: the model's inbox, or ContentOps itself.
 */
export function contentopsLink(matter: { kind: string; evidence: Record<string, unknown> }): string {
  const model = typeof matter.evidence.model === "string" && matter.evidence.model !== "" ? matter.evidence.model : null;
  if (model === null) return contentopsHref(null, "");
  if (matter.kind === "contentops.custom_copy") return contentopsHref(model, "inbox/copies");
  if (matter.kind === "contentops.custom_in_plan") {
    const slot = typeof matter.evidence.slot === "string" ? matter.evidence.slot.slice(0, 10) : null;
    const week = slot ? isoWeekOf(slot) : null;
    if (week) return contentopsHref(model, `plan/w/${week}`);
  }
  return contentopsHref(model, "inbox");
}
