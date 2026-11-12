/**
 * «Чья продажа»: one home and one writer (review R2b-3). What the team's chat agent records «со слов» — a decision about a
 * sale (the owner's ruling or the chatters' agreement) and a question about one — is written in Hub through these doors,
 * no longer in the ledger: Hub's `sale_owner_decisions` and `sale_claims` (kind question), the same rows the owner's
 * dispute and the imported records use. A decision on a sale Hub knows behaves exactly like the owner's decision of a
 * dispute: the home computed again, every handed-in report holding the sale given a new version with what it gives,
 * the open claims and questions of the sale decided with it, their matters closed. Each write needs write:shift_reports
 * and names the message and its sender; reads take write:shift_reports or read:team. The lists render as the agent's
 * memory file has them (`format=md`), the shape `ledger decision list --md` and `ledger question list --md` gave.
 */
import { z } from "zod";

import { errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** The ledger's words of a decision's kind: whole to one, shares, a pot, money outside the platform, nobody's. */
export const SALE_DECISION_KINDS = ["owner", "split", "pot", "off_platform", "exclude"] as const;

const saleWords = {
  /** The sale by Hub's id (`hub sale-chain` and every Hub screen name it)… */
  transactionId: intId.optional(),
  /** …or its page and the platform's transaction id… */
  pageLabel: z.string().trim().min(1).max(200).optional(),
  transactionRef: z.string().trim().min(1).max(200).optional(),
  /**
   * …or, a sale Hub cannot name yet, the words that will find it: the page (required then), the fan's reference (the
   * platform's id or login, never a name), when it was bought and its net. The owner ties it later («привязать»).
   */
  fanRef: z.string().trim().min(1).max(200).optional(),
  occurredAt: isoTimestamp.optional(),
  netMills: mills.optional(),
};

const saidWords = {
  /** The sender of the Telegram message the words are in. */
  telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The message: required. */
  sourceRef: z.string().trim().min(1).max(300),
};

export const agentSaleDecisionBodySchema = z.object({
  ...saleWords,
  kind: z.enum(SALE_DECISION_KINDS),
  /** owner: one share of 100; split: two or more summing to 100; off_platform: whose report takes it; pot, exclude: none. */
  shares: z.array(z.object({ person: z.string().trim().min(1).max(63), percent: z.number().int().min(1).max(100) })).max(10).default([]),
  /** pot: the pot's slug. */
  pot: z.string().trim().min(1).max(63).optional(),
  /** Who decided: «владелец», or the chatters who agreed. */
  saidBy: z.string().trim().min(1).max(200),
  /** When it was said: a day or a moment. */
  saidAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/),
  note: z.string().trim().min(1).max(4000).optional(),
  /**
   * The decision it replaces: the active one of the very sale (it must be named); for a decision that names no sale,
   * an active one of the same page and fan. The owner's own decision only when `telegramUserId` is the owner's (else 409
   * `owner_decision`), never another sale's (409 `other_sale`); one of a page outside the key's answers as one that does
   * not exist (409 `not_active`).
   */
  supersedes: intId.optional(),
  /**
   * The open question it answers, closed with it: one about the same sale (or, neither naming a sale, the same page
   * and fan). Another's is 409 `other_sale`; one of a page outside the key's answers as none (409 `question_closed`).
   */
  answers: intId.optional(),
  ...saidWords,
});

export const agentSaleDecisionCancelBodySchema = z.object({ decisionId: intId, note: z.string().trim().min(1).max(4000), ...saidWords });

export const agentSaleDecisionAppliedBodySchema = z.object({
  decisionId: intId,
  /** The person whose post took it in, by the registry's code. */
  person: z.string().trim().min(1).max(63),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const agentSaleDecisionsQuerySchema = z.object({
  /**
   * Only the decisions someone still waits for: active, not taken into a post, and not held — the reports handed in Hub
   * hold the sale for everyone it gives a share to.
   */
  open: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /** Said (or decided) on this Moscow day or later. */
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** md — the list as the agent's memory file has it, in `markdown`. */
  format: z.enum(["json", "md"]).default("json"),
});

const fanSchema = z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() });

export const agentSaleDecisionSchema = z.object({
  id: intId,
  transactionId: intId.nullable(),
  pageLabel: z.string().nullable(),
  fan: fanSchema,
  netMills: mills.nullable(),
  occurredAt: isoTimestamp.nullable(),
  kind: z.enum(SALE_DECISION_KINDS),
  shares: z.array(z.object({ person: z.string().nullable(), name: z.string(), percent: z.number().int() })),
  pot: z.string().nullable(),
  saidBy: z.string().nullable(),
  saidAt: isoTimestamp.nullable(),
  sourceLink: z.string().nullable(),
  note: z.string().nullable(),
  /** dispute — the owner's decision of a dispute; ledger — carried over from the ledger; agent — recorded «со слов». */
  source: z.enum(["dispute", "ledger", "agent"]),
  /**
   * open — still to be taken into a report; held — the reports handed in Hub hold the sale for everyone it gives a
   * share to (their versions follow the decision); applied — taken into a post; cancelled; superseded.
   */
  status: z.enum(["open", "held", "applied", "cancelled", "superseded"]),
  /** Where it went, in words: «учтено в отчёте anna за 2026-11-11». */
  statusWords: z.string(),
  supersededBy: intId.nullable(),
});

export const agentSaleDecisionsResponseSchema = z.object({
  decisions: z.array(agentSaleDecisionSchema),
  /** The list as the memory file has it (format md); null — json asked. */
  markdown: z.string().nullable(),
  serverNow: isoTimestamp,
});

export const agentSaleDecisionWriteResponseSchema = z.object({
  decision: agentSaleDecisionSchema,
  /** The handed-in reports that got a new version with it. */
  versions: z.array(z.object({ shiftId: intId, version: z.number().int().positive() })),
  savedAt: isoTimestamp,
});

export const agentSaleQuestionBodySchema = z.object({
  ...saleWords,
  /** owner — the owner's word is needed (it reaches the owner as a dispute); chatters — they settle it themselves. */
  askedOf: z.enum(["owner", "chatters"]),
  /** Who has to agree, in words: «Аня и Боря». */
  who: z.string().trim().min(1).max(200).optional(),
  /** The people by the registry's codes, when known: the first and the second side. */
  people: z.array(z.string().trim().min(1).max(63)).max(2).default([]),
  question: z.string().trim().min(1).max(2000),
  note: z.string().trim().min(1).max(2000).optional(),
  askedAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T.+)?$/),
  ...saidWords,
});

export const agentSaleQuestionAnswerBodySchema = z.object({ questionId: intId, answer: z.string().trim().min(1).max(2000), ...saidWords });
export const agentSaleQuestionCloseBodySchema = z.object({ questionId: intId, note: z.string().trim().min(1).max(2000), ...saidWords });

export const agentSaleQuestionsQuerySchema = z.object({
  open: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  format: z.enum(["json", "md"]).default("json"),
});

export const agentSaleQuestionSchema = z.object({
  id: intId,
  transactionId: intId.nullable(),
  pageLabel: z.string().nullable(),
  fan: fanSchema,
  netMills: mills.nullable(),
  askedOf: z.enum(["owner", "chatters"]),
  who: z.string().nullable(),
  question: z.string(),
  askedAt: isoTimestamp,
  sourceLink: z.string().nullable(),
  /** open; decided — a decision answered it; answered — in words; closed — dropped. */
  status: z.enum(["open", "decided", "answered", "closed"]),
  decisionId: intId.nullable(),
  answer: z.string().nullable(),
  /** carried over from the ledger (its question number) or asked here. */
  ledgerQuestionId: intId.nullable(),
});

export const agentSaleQuestionsResponseSchema = z.object({
  questions: z.array(agentSaleQuestionSchema),
  markdown: z.string().nullable(),
  serverNow: isoTimestamp,
});

export const agentSaleQuestionWriteResponseSchema = z.object({ question: agentSaleQuestionSchema, savedAt: isoTimestamp });

export const agentSaleDecisionsFeedQuerySchema = z.object({
  /** The `next` of the previous answer; absent — from the first change. */
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * A decision as the feed carries it: as it is now. Its structured fields carry no fan's name (the sale is Hub's id and
 * its page); `note` is the team's free text, served as written — it may name the fan, and a fan's erasure clears it.
 */
export const agentSaleDecisionFeedDecisionSchema = z.object({
  id: intId,
  /** The sale by Hub's id; null — not tied to a sale yet (or off_platform, which names none). */
  transactionId: intId.nullable(),
  pageLabel: z.string().nullable(),
  kind: z.enum(SALE_DECISION_KINDS),
  shares: z.array(z.object({ person: z.string().nullable(), userId: intId, percent: z.number().int() })),
  /** kind pot: the pot's name — the ledger's pot slug. */
  pot: z.string().nullable(),
  /** first | second | half | nobody (a dispute), imported (from the ledger), said (recorded «со слов»). */
  outcome: z.string(),
  /** The sale's home by the rule when it was decided. */
  ruleHome: z.string().nullable(),
  state: z.enum(["active", "superseded", "cancelled"]),
  source: z.enum(["dispute", "ledger", "agent"]),
  saidBy: z.string().nullable(),
  saidAt: isoTimestamp.nullable(),
  decidedAt: isoTimestamp,
  /** Why, as written: the ledger shows it with a report line's agreement. */
  note: z.string().nullable(),
  /** Taken into a person's post of a date; null — not. */
  applied: z.object({ person: z.string().nullable(), reportDate: z.string() }).nullable(),
  /** The ledger's own number of a decision carried over from it; null — made in Hub. */
  ledgerDecisionId: intId.nullable(),
});

export const agentSaleDecisionsFeedResponseSchema = z.object({
  /**
   * Every change after the cursor, in the order the feed placed them (`seq`): made, superseded, cancelled, linked (tied
   * to its sale), applied, changed. Each carries the decision as it is now: keep decisions by id and go by
   * `decision.state`. A change held back for the key's pages earlier gets a NEW place at the end of the feed once the
   * key may read it and comes here through the cursor — possibly after later changes of the same decision, possibly a
   * second time for a reader whose cursor had passed its old place.
   */
  changes: z.array(z.object({
    seq: intId,
    change: z.enum(["made", "superseded", "cancelled", "linked", "applied", "changed"]),
    at: isoTimestamp,
    decision: agentSaleDecisionFeedDecisionSchema,
  })),
  /** Changes of a decision on a page outside the key's pages: listed on every read until the key may read them. */
  held: z.array(z.object({ seq: intId, decisionId: intId, pageLabel: z.string().nullable(), reason: z.enum(["page_outside_key"]) })).default([]),
  /** Ask again with `since` = this (the last place read, served or held); the same as asked when nothing is new. */
  next: z.string(),
  /**
   * Whether places follow `next`. `limit` counts places, held ones too, so a page may carry fewer `changes` than
   * `limit` while more follow: read on while this is true (or until `next` is the `since` asked).
   */
  more: z.boolean(),
  serverNow: isoTimestamp,
});

export type AgentSaleDecision = z.infer<typeof agentSaleDecisionSchema>;
export type AgentSaleDecisionsFeedResponse = z.infer<typeof agentSaleDecisionsFeedResponseSchema>;
export type AgentSaleQuestion = z.infer<typeof agentSaleQuestionSchema>;

const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
  503: errorResponseSchema,
} as const;

export const saleDecisionRouteSchemas = {
  agentSaleDecisionAdd: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Record a decision about a sale «со слов»: the owner's ruling or the chatters' agreement (needs write:shift_reports)",
    description: "Database only. A sale Hub knows: it behaves as the owner's decision of a dispute — the reports holding it get a "
      + "new version, the open claims and questions of the sale are decided, the home is computed again. A sale with an active "
      + "decision needs `supersedes` (409 `decision_exists`). A sale not named yet waits for the owner to tie it. What it "
      + "replaces and answers is checked in the transaction that writes: of the key's pages, about the same sale (409 "
      + "`other_sale`). A decision the owner made himself in Workboard is replaced only when the message's sender "
      + "(`telegramUserId`) is the owner's Telegram account in the people registry (else 409 `owner_decision`).",
    body: agentSaleDecisionBodySchema,
    response: { 200: agentSaleDecisionWriteResponseSchema, ...agentErrors },
  },
  agentSaleDecisionCancel: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Cancel a decision recorded «со слов» or carried over, with why (needs write:shift_reports)",
    description: "Database only. The sale's home is computed again without it, and every report handed in that the decision "
      + "settled gets a new version with what rules now (`versions`): an agreement of the two sides, else the rule with the "
      + "person's own word. The claims and questions it decided wait again. A decision the owner made himself in Workboard "
      + "is cancelled only when the message's sender (`telegramUserId`) is the owner's Telegram account in the people "
      + "registry (else 409 `owner_decision`).",
    body: agentSaleDecisionCancelBodySchema,
    response: { 200: agentSaleDecisionWriteResponseSchema, ...agentErrors },
  },
  agentSaleDecisionApplied: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Mark a decision taken into a person's post of a date (needs write:shift_reports)",
    description: "Database only. For a person whose report is a post in «Отчётность»: the decision is not taken in twice.",
    body: agentSaleDecisionAppliedBodySchema,
    response: { 200: agentSaleDecisionWriteResponseSchema, ...agentErrors },
  },
  agentSaleDecisions: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The decisions about sales on the key's pages, as a list or as the memory file has them (needs write:shift_reports or read:team)",
    description: "Database only. Every source: the owner's disputes, the ones carried over from the ledger, the ones recorded «со слов». "
      + "The fan is named as Hub's own rows name him; a note is the team's free text, as written.",
    querystring: agentSaleDecisionsQuerySchema,
    response: { 200: agentSaleDecisionsResponseSchema, ...agentErrors },
  },
  agentSaleDecisionsFeed: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Every change of a decision about whose a sale is, after a cursor: what the ledger follows (needs read:money)",
    description: "Database only. A change is placed when the feed first finds it committed, after every place given before: "
      + "a change committed late comes after the cursor, never passed. A change held back for the key's pages gets a new "
      + "place at the end once the key may read it. `limit` counts places: a page may carry fewer changes than asked while "
      + "`more` is true. The structured fields carry no fan's name; `note` is the team's free text, as written.",
    querystring: agentSaleDecisionsFeedQuerySchema,
    response: { 200: agentSaleDecisionsFeedResponseSchema, ...agentErrors },
  },
  agentSaleQuestionAsk: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Ask a question about whose a sale is: of the owner or of the chatters (needs write:shift_reports)",
    description: "Database only. Asked of the owner, it reaches the owner as a dispute (its title names the page, the amount, the "
      + "day and the people, never the fan); asked of the chatters, it waits for their answer.",
    body: agentSaleQuestionBodySchema,
    response: { 200: agentSaleQuestionWriteResponseSchema, ...agentErrors },
  },
  agentSaleQuestionAnswer: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Close a question with an answer in words, when there is no decision to record (needs write:shift_reports)",
    description: "Database only. An answer that decides the sale is a decision: `agentSaleDecisionAdd` with `answers`.",
    body: agentSaleQuestionAnswerBodySchema,
    response: { 200: agentSaleQuestionWriteResponseSchema, ...agentErrors },
  },
  agentSaleQuestionClose: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Close a question without an answer, with why (needs write:shift_reports)",
    description: "Database only.",
    body: agentSaleQuestionCloseBodySchema,
    response: { 200: agentSaleQuestionWriteResponseSchema, ...agentErrors },
  },
  agentSaleQuestions: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "The questions about sales on the key's pages, as a list or as the memory file has them (needs write:shift_reports or read:team)",
    description: "Database only. The ones carried over from the ledger and the ones asked here.",
    querystring: agentSaleQuestionsQuerySchema,
    response: { 200: agentSaleQuestionsResponseSchema, ...agentErrors },
  },
} as const;
