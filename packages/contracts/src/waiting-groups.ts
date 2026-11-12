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
  // ContentOps' findings (`contentops.*`) and the content routines' (`content.*`): each line opens where it is decided.
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
  // ContentOps' findings and the content routines' own (`content.*`: a week to approve, a gap in the schedule).
  if (kind.startsWith("contentops.") || kind.startsWith("content.")) return "content";
  // The people checks' (package K) and a newcomer's way (package J: `person.no_pages`, `person.onboarding_stuck`).
  if (kind.startsWith("people.") || kind.startsWith("person.")) return "people";
  if (LEDGER_KINDS.has(kind)) return "ledger";
  // Collection and failures, and the system state's (routines, copies, the Mac's reporter).
  if (SYSTEM_KINDS.has(kind) || kind.startsWith("routine.") || kind.startsWith("copy.") || kind.startsWith("reporter.")) return "system";
  return "other";
}

/**
 * The tone of what waits, beside its group (the one place): `bad` — something is broken (an open failure, a critical
 * failure of the extension, a page that needs sign-in, a routine that failed or went silent, a stale copy or a silent
 * reporter, a red check of the ledger); `warn` — the outcome is not known (a publication's, a held send's; and a group
 * whose source did not answer: «не проверено»); `null` — it only waits.
 */
export const WAITING_TONES = ["bad", "warn"] as const;
export type WaitingTone = (typeof WAITING_TONES)[number];

const BAD_KINDS: ReadonlySet<string> = new Set([
  "incident.open", "extension.critical", "page.login_needed", "routine.failed", "routine.silent", "copy.stale", "reporter.silent", "ledger.check",
]);
const WARN_KINDS: ReadonlySet<string> = new Set(["publication.unknown", "send.held"]);

/** The tone of a matter's kind. */
export function waitingToneOf(kind: string): WaitingTone | null {
  if (BAD_KINDS.has(kind)) return "bad";
  if (WARN_KINDS.has(kind)) return "warn";
  return null;
}

/** The worst of tones: `bad` over `warn` over none. */
export function worstWaitingTone(tones: Iterable<WaitingTone | null>): WaitingTone | null {
  let worst: WaitingTone | null = null;
  for (const tone of tones) {
    if (tone === "bad") return "bad";
    if (tone === "warn") worst = "warn";
  }
  return worst;
}

/** The list filtered to one group: `/workboard/decisions#<group>`. */
export function waitingGroupLink(id: WaitingGroupId): string {
  return `/workboard/decisions#${id}`;
}

/** The kinds whose finding names when their reason began under a word of its own (the system state's, a shift's report). */
const SINCE_OF_KIND: Readonly<Record<string, string>> = {
  // The input empty since; silent since the last run or the last report; the newest copy taken then.
  "routine.empty": "emptySince",
  "routine.silent": "lastRunAt",
  "reporter.silent": "lastReportAt",
  "copy.stale": "takenAt",
  // The shift ended and its report was not handed in.
  "shift.report.missing": "endedAt",
};

/**
 * The moments the other findings name: a state entered (a custom order's, a newcomer's step), a send's, a question's,
 * a payment's, a post's, a failure's opening, a request's, a red check's first run, a word said, a publication's.
 */
const SINCE_FIELDS = ["since", "sentAt", "askedAt", "paidAt", "postedAt", "openedAt", "requestedAt", "failingSince", "saidAt", "publishAt"] as const;

/**
 * Since when a matter waits: since its reason began, as its own finding names it, else since it was opened — never
 * the moment a matter row was opened (or reopened) today while its cause is days old. Only a past moment no later than
 * the opening counts (a publication's moment is when it goes out, not when it waits). The age both apps show and the
 * list's «дольше ждёт» order are this.
 */
export function waitingSinceOf(matter: { kind: string; openedAt: string; evidence: Record<string, unknown> }, now: number = Date.now()): string {
  const own = SINCE_OF_KIND[matter.kind];
  const opened = Date.parse(matter.openedAt);
  for (const field of own === undefined ? SINCE_FIELDS : [own, ...SINCE_FIELDS]) {
    const value = matter.evidence[field];
    if (typeof value !== "string") continue;
    const at = Date.parse(value);
    if (!Number.isNaN(at) && at <= now && at <= opened + 60_000) return new Date(at).toISOString();
  }
  return matter.openedAt;
}
