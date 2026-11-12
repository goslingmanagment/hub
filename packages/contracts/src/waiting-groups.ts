/**
 * «Ждут вас»'s groups, the one table (ecosystem plan §6): which group a matter's kind is in, the group's title and
 * the order. Workboard's list groups its lines by it, and Hub's server counts the console Home's chips by it
 * (`mattersWaiting.groups`): one thing grouped in one place, so the Home's chips and the list's groups are the same
 * words and the same numbers by construction. A kind of a package's list that falls in no group is a test failure
 * (tests/waiting-groups.test.ts); an agent's own kind with no rule goes to «Другие дела», shown on both sides.
 */
import { MATTER_INFO_KINDS } from "./matter-checks.ts";

export const WAITING_GROUP_IDS = [
  "questions", "reports", "customs", "held", "publications", "content", "people", "ledger", "system", "other", "info",
] as const;
export type WaitingGroupId = (typeof WAITING_GROUP_IDS)[number];

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
  // ContentOps' findings (`contentops.*`): decided in ContentOps, each line opens it there.
  { id: "content", title: "Контент" },
  { id: "people", title: "Люди и доступ" },
  { id: "ledger", title: "Проверки ledger" },
  { id: "system", title: "Сбор, сбои и рутины" },
  { id: "other", title: "Другие дела" },
  { id: "info", title: "Для сведения" },
];

const INFO: ReadonlySet<string> = new Set(MATTER_INFO_KINDS);
const SYSTEM_KINDS: ReadonlySet<string> = new Set(["page.login_needed", "incident.open", "extension.critical", "history.request"]);
const LEDGER_KINDS: ReadonlySet<string> = new Set(["ledger.check", "ledger.sheet_column", "ledger.off_platform"]);
const REPORT_KINDS: ReadonlySet<string> = new Set(["ledger.report_post", "ledger.paid_day_changed", "report.post_fix", "off_platform.pending"]);

/** The group of a matter's kind. */
export function waitingGroupOf(kind: string): WaitingGroupId {
  if (INFO.has(kind)) return "info";
  // Whose a sale is: the ledger's questions and the claims' disputes (package G).
  if (kind === "ledger.sale_question" || kind.startsWith("sale.")) return "questions";
  // The shift's report: the ledger's posts and paid days, the author's post to fix, «мимо площадки», the hand-in (F).
  if (REPORT_KINDS.has(kind) || kind.startsWith("shift.report")) return "reports";
  if (kind.startsWith("custom.")) return "customs";
  if (kind === "send.held") return "held";
  if (kind.startsWith("publication.")) return "publications";
  if (kind.startsWith("contentops.")) return "content";
  // The people checks' (package K) and a newcomer's way (package J: `person.no_pages`, `person.onboarding_stuck`).
  if (kind.startsWith("people.") || kind.startsWith("person.")) return "people";
  if (LEDGER_KINDS.has(kind)) return "ledger";
  // Collection and failures, and the system state's (routines, copies, the Mac's reporter).
  if (SYSTEM_KINDS.has(kind) || kind.startsWith("routine.") || kind.startsWith("copy.") || kind.startsWith("reporter.")) return "system";
  return "other";
}

/** The list filtered to one group: `/workboard/decisions#<group>`. */
export function waitingGroupLink(id: WaitingGroupId): string {
  return `/workboard/decisions#${id}`;
}
