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
  /** The decision it replaces (the sale's active one must be named). */
  supersedes: intId.optional(),
  /** The open question it answers: closed with it. */
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
  /** Only the decisions still to be taken into a report: active, not taken into a post, not held by a report in Hub. */
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
   * open — still to be taken into a report; held — a report handed in Hub holds the sale (its version follows the
   * decision); applied — taken into a post; cancelled; superseded.
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

export type AgentSaleDecision = z.infer<typeof agentSaleDecisionSchema>;
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
      + "decision needs `supersedes` (409 `decision_exists`). A sale not named yet waits for the owner to tie it.",
    body: agentSaleDecisionBodySchema,
    response: { 200: agentSaleDecisionWriteResponseSchema, ...agentErrors },
  },
  agentSaleDecisionCancel: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Cancel a decision «со слов», with why (needs write:shift_reports)",
    description: "Database only. The sale's home is computed again without it; a report handed in keeps its version until the "
      + "person hands it in again.",
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
    description: "Database only. Every source: the owner's disputes, the ones carried over from the ledger, the ones recorded «со слов».",
    querystring: agentSaleDecisionsQuerySchema,
    response: { 200: agentSaleDecisionsResponseSchema, ...agentErrors },
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
