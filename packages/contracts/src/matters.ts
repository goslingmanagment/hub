/**
 * Дела (ecosystem plan §2, §6, package D): everything that waits for a person,
 * one matter per reason key, owned by a person or a role. Hub's server mirrors
 * today's sources of «Ждут вас» and «Решения» into matters (the kinds below);
 * an agent key opens and closes its own kinds by key; a person reads what is
 * theirs. A source that did not answer is «не проверено» for its kind, never a
 * zero.
 */
import { z } from "zod";

import { intId, isoTimestamp } from "./primitives.ts";
import { WAITING_GROUP_IDS } from "./waiting-groups.ts";

/** Dotted words: `send.held`, `shift.report.missing`. */
export const MATTER_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const matterKindSchema = z.string().max(64).regex(MATTER_KIND_PATTERN);
/** `<kind>:<ref>`, stable for the reason: the same finding has the same key. */
export const matterKeySchema = z.string().min(3).max(200).regex(/^[a-z][a-z0-9_.]*:\S/);

/** The kind a key names: what comes before its first colon. */
export function matterKindOfKey(key: string): string {
  return key.slice(0, Math.max(0, key.indexOf(":")));
}

/**
 * The kinds Hub's server keeps from today's sources, each the one writer of its
 * kind: an agent key opens or closes none of them.
 */
export const MATTER_MIRROR_KINDS = [
  /** A publication drafted and not approved (Публикации, status draft). */
  "publication.draft",
  /** A publication whose outcome on the platform is not known (status unknown). */
  "publication.unknown",
  /** A question «whose is this sale» the team's agent asked the owner (the ledger's). */
  "ledger.sale_question",
  /** A post in «Отчётность» the ledger could not use, of the days it pays from the posts. */
  "ledger.report_post",
  /** A paid day whose report changed since (the ledger's pending change). */
  "ledger.paid_day_changed",
  /** A custom the fan paid for and nobody delivered yet. */
  "custom.paid_not_delivered",
  /** A send of the chat extension whose outcome nobody reported. */
  "send.held",
  /** A Fansly page whose browser or login needs the owner. */
  "page.login_needed",
  /** An open failure (notification incident) that waits for a person. */
  "incident.open",
  /** A critical counter of the chat extension over the last 7 days. */
  "extension.critical",
  /** An OnlyFans history request that waits for the owner's approval. */
  "history.request",
] as const;
export type MatterMirrorKind = (typeof MATTER_MIRROR_KINDS)[number];

const MIRROR_KIND_SET: ReadonlySet<string> = new Set(MATTER_MIRROR_KINDS);
export function isMatterMirrorKind(kind: string): kind is MatterMirrorKind {
  return MIRROR_KIND_SET.has(kind);
}

/**
 * The kinds Hub's server opens by its own rules (not mirrored from a list),
 * each the one writer of its kind: an agent key opens or closes none of them.
 */
export const MATTER_SERVER_KINDS = [
  /** A routine with no run for twice its period and ten minutes («Состояние», package P). */
  "routine.silent",
  /** A routine that failed twice in a row. */
  "routine.failed",
  /** A routine whose input stayed empty longer than its reporter's threshold. */
  "routine.empty",
  /** A copy older than 36 hours. */
  "copy.stale",
  /** A reporter (the Mac's) silent for 30 minutes inside its hours. */
  "reporter.silent",
] as const;
export type MatterServerKind = (typeof MATTER_SERVER_KINDS)[number];

const SERVER_KIND_SET: ReadonlySet<string> = new Set(MATTER_SERVER_KINDS);
export function isMatterServerKind(kind: string): kind is MatterServerKind {
  return SERVER_KIND_SET.has(kind);
}

/**
 * Отчёт смены (package F): the kinds of the shift report's own check, the server their one writer — a shift not
 * handed in two hours after it closed (the person's), the owner's one line of them a day later, a report handed in
 * after the ledger paid its day (the owner's). Kept apart from MATTER_SERVER_KINDS: «Состояние» closes every open
 * matter of those that its own pass did not find.
 */
export const SHIFT_REPORT_MATTER_KINDS = ["shift.report.missing", "shift.reports.missing", "shift.report.after_paid"] as const;
const SHIFT_REPORT_KIND_SET: ReadonlySet<string> = new Set(SHIFT_REPORT_MATTER_KINDS);
export function isShiftReportMatterKind(kind: string): boolean {
  return SHIFT_REPORT_KIND_SET.has(kind);
}

/**
 * A newcomer's way to the first shift («Начало», package J), the kinds of its
 * own pass (people-start-tick.ts) — apart from MATTER_SERVER_KINDS on purpose:
 * «Состояние» closes every open matter of that list its own pass did not find.
 * Hub's server is the one writer: an agent key opens or closes none of them.
 */
export const MATTER_PERSON_START_KINDS = [
  /** A newcomer with no page opened to their login: the owner assigns one. */
  "person.no_pages",
  /** A newcomer on the same step of «Начало» for 48 hours (or the invitation not opened for as long). */
  "person.onboarding_stuck",
] as const;
export type MatterPersonStartKind = (typeof MATTER_PERSON_START_KINDS)[number];

const PERSON_START_KIND_SET: ReadonlySet<string> = new Set(MATTER_PERSON_START_KINDS);
export function isMatterPersonStartKind(kind: string): kind is MatterPersonStartKind {
  return PERSON_START_KIND_SET.has(kind);
}

export const MATTER_STATES = ["open", "closed"] as const;
export const MATTER_CLOSED_HOWS = ["resolved", "withdrawn", "cause_gone"] as const;
export const MATTER_SOURCE_NAMES = ["server", "agent", "ledger", "contentops", "person"] as const;
export const MATTER_OWNER_ROLE_NAMES = ["owner", "team_lead", "chatter"] as const;

/**
 * «Ждут вас»'s rows, in the screen's order (apps/dashboard/src/api/waiting.ts); after them the matters no old row
 * counts (package K): ContentOps' (`contentops.*`), people and access, the ledger's checks, and every other kind.
 */
export const WAITING_ROW_IDS = [
  "drafts", "unknown", "questions", "reports", "customs", "held", "login", "failures", "extension", "history", "content", "people", "ledger", "other",
] as const;
export type WaitingRowId = (typeof WAITING_ROW_IDS)[number];
/** «Решения»'s queues, in the screen's order (apps/workboard/src/shared/decisions.ts). */
export const DECISION_QUEUE_IDS = ["questions", "reports", "customs", "held"] as const;

const username = z.string().trim().min(1).max(64);
const pageLabel = z.string().trim().min(1).max(64);

export const matterOwnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"), userId: intId, username: z.string(),
    /** The person's name where the login is a person's (the people registry); null — a login of no person. */
    displayName: z.string().nullable(),
  }),
  z.object({ kind: z.literal("role"), role: z.enum(MATTER_OWNER_ROLE_NAMES) }),
]);

export const matterSchema = z.object({
  id: intId,
  key: z.string(),
  kind: z.string(),
  source: z.enum(MATTER_SOURCE_NAMES),
  state: z.enum(MATTER_STATES),
  closedHow: z.enum(MATTER_CLOSED_HOWS).nullable(),
  title: z.string(),
  /** The thing the matter is about: `client_send` and the attempt id, `publication` and its id… */
  object: z.object({ type: z.string(), id: z.string() }).nullable(),
  /** The pages it is about; empty — no page (every page's). */
  pageLabels: z.array(z.string()),
  owner: matterOwnerSchema,
  watcherUserIds: z.array(intId),
  /**
   * It waits for the viewer themself: their user's, or a role they hold (the owner's, and the team lead's while
   * nobody holds that role). Otherwise the viewer reads it as oversight: it waits for someone else, and it is in no
   * count of theirs («Ждут вас», the menu, the extension's icon).
   */
  mine: z.boolean(),
  /** The evidence carries money: only the owner is served such a matter. */
  money: z.boolean(),
  /** What the finding saw: ids, states, moments; money only in the owner's matters. */
  evidence: z.record(z.string(), z.unknown()),
  /** Where it is done: a console path (`/workboard/…` is Workboard's). */
  link: z.string().nullable(),
  openedAt: isoTimestamp,
  lastSeenAt: isoTimestamp,
  closedAt: isoTimestamp.nullable(),
});

/** Whether Hub knows the kind now: its source answered lately (`yes`), did not (`no` — «не проверено»), or nothing mirrors it. */
export const matterKindCheckedSchema = z.enum(["yes", "no", "not_mirrored"]);

export const mattersListQuerySchema = z.object({
  state: z.enum(MATTER_STATES).default("open"),
  kind: matterKindSchema.optional(),
  /** One page's (a matter of no page is every page's). */
  pageLabel: pageLabel.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const mattersListResponseSchema = z.object({
  matters: z.array(matterSchema),
  /** Every kind the viewer has open matters of, and every mirrored kind, with whether its source answered. */
  kinds: z.array(z.object({
    kind: z.string(),
    /** The viewer's open matters of the kind. */
    open: z.number().int().nonnegative(),
    checked: matterKindCheckedSchema,
    /** When its source last answered; null — never, or nothing mirrors it. */
    checkedAt: isoTimestamp.nullable(),
  })),
  serverNow: isoTimestamp,
});

export const mattersWaitingQuerySchema = z.object({
  /** «Решения» on one page (a matter of no page is every page's). «Ждут вас» is never cut by page. */
  pageLabel: pageLabel.optional(),
}).strict();

export const mattersWaitingRowSchema = z.object({
  id: z.enum(WAITING_ROW_IDS),
  label: z.string(),
  /** null: «не удалось проверить» — the source did not answer lately; never a zero for it. */
  count: z.number().int().nonnegative().nullable(),
  /** The source's read hit its limit: there are at least this many. */
  capped: z.boolean(),
  /** The one page the row is about, when it is about one (a single Fansly page that needs a login). */
  pageLabel: z.string().nullable(),
  /** The one place it is done, as «Ждут вас» links it. */
  to: z.string(),
  /** The row's matters (for the extension counter, the row's count of events, not of matters). */
  matterIds: z.array(intId),
});

export const mattersWaitingResponseSchema = z.object({
  /** The owner's switch (`mattersReadEnabled`): the screens read this answer instead of their own sources. */
  active: z.boolean(),
  /** «Ждут вас»: the viewer's rows in the screen's order, none with a zero. */
  rows: z.array(mattersWaitingRowSchema),
  /**
   * «Ждут вас» by the list's groups (waiting-groups.ts, the one table): a group per kind the viewer's own open
   * matters fall in, in the list's order, never «Для сведения»; the console Home's chips. A group's count is the list's
   * (one per matter; the custom orders' count where they are customs' home); `checked: false` — a source of the group
   * did not answer lately. The owner's `total` is their sum; a team lead's stays the sum of `rows`.
   */
  groups: z.array(z.object({
    id: z.enum(WAITING_GROUP_IDS),
    title: z.string(),
    count: z.number().int().nonnegative(),
    checked: z.boolean(),
    to: z.string(),
  })),
  /** The sum of what did answer: the menu's number (the owner's: of `groups`, the list's numbers). */
  total: z.number().int().nonnegative(),
  /** The rows that could not be checked. */
  failed: z.array(z.enum(WAITING_ROW_IDS)),
  /** «Решения»: its four queues, on the asked page; null — not checked or not the viewer's. */
  decisions: z.object({
    questions: z.number().int().nonnegative().nullable(),
    reports: z.number().int().nonnegative().nullable(),
    reportParts: z.object({ posts: z.number().int().nonnegative(), changes: z.number().int().nonnegative() }).nullable(),
    customs: z.number().int().nonnegative().nullable(),
    held: z.number().int().nonnegative().nullable(),
    total: z.number().int().nonnegative(),
    /** With a page: what waits on the other pages. 0 without one. */
    elsewhere: z.number().int().nonnegative(),
    failed: z.array(z.enum(DECISION_QUEUE_IDS)),
  }),
  serverNow: isoTimestamp,
});

/** The extension's narrow read: how many matters wait for the person, and the newest of them, without evidence. */
export const clientMattersResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  matters: z.array(z.object({
    id: intId,
    kind: z.string(),
    title: z.string(),
    link: z.string().nullable(),
    pageLabels: z.array(z.string()),
    openedAt: isoTimestamp,
  })),
  serverNow: isoTimestamp,
});

/** At most this much evidence an agent may attach (the column's own limit is 8 KB). */
export const MATTER_EVIDENCE_MAX_BYTES = 4096;

const evidenceSchema = z.record(z.string(), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= MATTER_EVIDENCE_MAX_BYTES,
  { message: `evidence is at most ${MATTER_EVIDENCE_MAX_BYTES} bytes of JSON` },
);

export const agentMatterOpenBodySchema = z.object({
  /** `<kind>:<ref>`: the same finding, the same key. */
  key: matterKeySchema,
  kind: matterKindSchema,
  title: z.string().trim().min(1).max(300),
  /** Whom it waits for: a person by their login, or a role. */
  owner: z.union([z.object({ user: username }).strict(), z.object({ role: z.enum(MATTER_OWNER_ROLE_NAMES) }).strict()]),
  watchers: z.array(username).max(20).optional(),
  object: z.object({ type: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), id: z.string().min(1).max(200) }).strict().optional(),
  /** Pages of the key's grant; none — no page. */
  pageLabels: z.array(pageLabel).max(20).optional(),
  evidence: evidenceSchema.optional(),
  /** The evidence carries money: only the owner will read the matter. */
  money: z.boolean().optional(),
  /** A console path where it is done. */
  link: z.string().regex(/^\//).max(500).optional(),
  /** The person on whose word the agent writes (their login). */
  onBehalfOf: username.optional(),
}).strict().refine((body) => matterKindOfKey(body.key) === body.kind, { message: "the key starts with its kind and a colon", path: ["key"] });

export const agentMatterCloseBodySchema = z.object({
  key: matterKeySchema,
  how: z.enum(MATTER_CLOSED_HOWS),
  note: z.string().trim().min(1).max(500).optional(),
  onBehalfOf: username.optional(),
}).strict();

export const agentMatterCommentBodySchema = z.object({
  key: matterKeySchema,
  text: z.string().trim().min(1).max(2000),
  onBehalfOf: username.optional(),
}).strict();

export const agentMatterStateSchema = z.object({
  id: intId,
  key: z.string(),
  kind: z.string(),
  state: z.enum(MATTER_STATES),
  closedHow: z.enum(MATTER_CLOSED_HOWS).nullable(),
});

export const agentMatterResponseSchema = z.object({
  matter: agentMatterStateSchema,
  /** What the call did: opened, reopened, updated (the finding changed), unchanged; closed, or unchanged (it was closed). */
  transition: z.enum(["opened", "reopened", "updated", "unchanged", "closed"]),
});

export const agentMatterCommentResponseSchema = z.object({
  matter: agentMatterStateSchema,
  eventId: intId,
});

export type Matter = z.infer<typeof matterSchema>;
export type MattersListQuery = z.infer<typeof mattersListQuerySchema>;
export type MattersListResponse = z.infer<typeof mattersListResponseSchema>;
export type MattersWaitingQuery = z.infer<typeof mattersWaitingQuerySchema>;
export type MattersWaitingRow = z.infer<typeof mattersWaitingRowSchema>;
export type MattersWaitingResponse = z.infer<typeof mattersWaitingResponseSchema>;
export type ClientMattersResponse = z.infer<typeof clientMattersResponseSchema>;
export type AgentMatterOpenBody = z.infer<typeof agentMatterOpenBodySchema>;
export type AgentMatterCloseBody = z.infer<typeof agentMatterCloseBodySchema>;
export type AgentMatterCommentBody = z.infer<typeof agentMatterCommentBodySchema>;
export type AgentMatterResponse = z.infer<typeof agentMatterResponseSchema>;
export type AgentMatterCommentResponse = z.infer<typeof agentMatterCommentResponseSchema>;
