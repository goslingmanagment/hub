/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G): what people
 * say about a sale reaches the other side and, when they do not agree, the
 * owner. A statement of a handed-in report that touches another person — «моё»
 * on a sale the rule or another person's report gives to them, «делим с …» —
 * is a claim: the other side answers «Согласен» or «Не согласен» on their own
 * shift report (a matter takes them to the line); agreement settles it, the
 * homes follow; «Не согласен» or 24 hours of silence make ONE matter for the
 * owner with both statements and the facts, and his answer — to the first, to
 * the second, in halves, to nobody — is a decision the rule takes before
 * itself. A sale two reports count for more than its net is a dispute by
 * itself. The owner also confirms or rejects «мимо площадки», and sees once a
 * week the sales nobody claimed.
 *
 * Who sees what: a person their own claims, both sides of each; a chatter only
 * claims of sales on pages they may open, and only the sales' amounts, never
 * anyone's pay; the owner every claim and decision. An agent key reads them for
 * a person or a sale on its granted pages, and records an answer «со слов»
 * with the message and the sender checked against the person.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";
import { shiftReportLineFactsSchema } from "./routes-shift-handins.ts";
import { SALE_DISPUTE_OUTCOMES_WITH_DISMISS, saleClaimAnswerEnum, saleClaimSchema } from "./sale-claims.ts";

const idParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const note = z.string().trim().max(300);
const person = z.object({ userId: intId, name: z.string() });


export const saleClaimAnswerParamsSchema = z.object({ claimId: idParam });
export const saleClaimAnswerBodySchema = z.object({
  answer: saleClaimAnswerEnum,
  /** «Не согласен» needs one line of why; «Согласен» may have one. */
  note: note.nullable().optional(),
});
export const saleClaimAnswerResponseSchema = z.object({ claim: saleClaimSchema, savedAt: isoTimestamp });

// ── The owner's dispute ─────────────────────────────────────────────────────

export const saleDisputeParamsSchema = z.object({ transactionId: idParam });

const saleSchema = z.object({
  transactionId: intId,
  pageLabel: z.string(),
  platform: z.string(),
  /** Hub's canonical type: message_purchase, post_purchase, tip, stream_tip, subscription. */
  kind: z.string(),
  occurredAt: isoTimestamp,
  netMills: mills,
  fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
});

/** One person of a dispute: what they said, what their report counts, what each answer gives them. */
export const saleDisputePartySchema = z.object({
  userId: intId,
  name: z.string(),
  /** first — the one whose statement opened it; second — the other side. */
  role: z.enum(["first", "second"]),
  /** What they said, in plain words: «моё: фан мой, договорились вчера», «не согласен: …», «молчит 26 ч». */
  says: z.array(z.string()),
  /** What their handed-in report counts of the sale now; null — no report holds it. */
  countedMills: mills.nullable(),
  /** What the party's handed-in report claims while it counts nothing, disputed (review R2b-2); null — none. */
  claimedMills: mills.nullable().default(null),
  /** Their shift whose report it is; null — none. */
  shiftId: intId.nullable(),
});

export const saleDisputeResponseSchema = z.object({
  sale: saleSchema.nullable(),
  /** The rule's home now, in words, and its shares. */
  home: z.object({ kind: z.string(), reason: z.string(), words: z.string(), shares: z.array(z.object({ userId: intId, name: z.string(), mills })) }).nullable(),
  parties: z.array(saleDisputePartySchema),
  claims: z.array(saleClaimSchema),
  /** The facts the rule read (the claimant's draft facts): sender, holders, whose slot, who wrote last. Null — not read. */
  facts: shiftReportLineFactsSchema.nullable(),
  /** The answers the owner may give, each with what it gives every party. */
  outcomes: z.array(z.object({
    outcome: z.enum(SALE_DISPUTE_OUTCOMES_WITH_DISMISS),
    label: z.string(),
    gives: z.array(z.object({ userId: intId, mills })),
  })),
  /** The owner's decision already standing; null — none. */
  decision: z.object({ outcome: z.string(), note: z.string().nullable(), decidedAt: isoTimestamp, by: z.string().nullable() }).nullable(),
  /**
   * The reports handed in Hub that hold the sale (review R2b-3d): each gets a new version with the decision. A report
   * that is a post in «Отчётность» is recomputed by nobody: the decision is read by the next report.
   */
  reports: z.array(z.object({ userId: intId, name: z.string(), shiftId: intId, reportDate: z.string() })).default([]),
  serverNow: isoTimestamp,
});

export const saleDisputeDecideBodySchema = z.object({
  /** The sale disputed… */
  transactionId: intId.optional(),
  /** …or a question carried over from the ledger that names no sale. */
  claimId: intId.optional(),
  outcome: z.enum(SALE_DISPUTE_OUTCOMES_WITH_DISMISS),
  /** Why: kept with the decision. */
  note: z.string().trim().max(1000).nullable().optional(),
}).refine((body) => (body.transactionId === undefined) !== (body.claimId === undefined), "name the sale or the claim");

export const saleDisputeDecideResponseSchema = z.object({
  decided: z.boolean(),
  /** The reports given a new version by it, by shift. */
  versions: z.array(z.object({ shiftId: intId, version: z.number().int().positive() })),
  savedAt: isoTimestamp,
});

/** A question carried over from the ledger and tied to no sale: the claim's id instead. */
export const saleDisputeByClaimParamsSchema = z.object({ claimId: idParam });

// ── «Мимо площадки»: the owner's word ───────────────────────────────────────

export const offPlatformDecideParamsSchema = z.object({ offPlatformId: idParam });
export const offPlatformDecideBodySchema = z.object({
  decision: z.enum(["confirm", "reject"]),
  /** The page the confirmed amount counts on: one of the report's pages; absent — the report's first. */
  pageLabel: z.string().trim().min(1).max(64).optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
export const offPlatformDecideResponseSchema = z.object({
  state: z.enum(["confirmed", "rejected"]),
  /** The report's new version made by it. */
  version: z.number().int().positive().nullable(),
  savedAt: isoTimestamp,
});

export const offPlatformPendingQuerySchema = z.object({
  /** One report; absent — every report waiting. */
  shiftId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const offPlatformPendingResponseSchema = z.object({
  reports: z.array(z.object({
    shiftId: intId,
    person: person,
    reportDate: businessDate,
    /** The report's pages, the first is where a confirmed amount counts unless the owner names another. */
    pages: z.array(z.string()),
    totalMills: mills,
    lines: z.array(z.object({ id: intId, amountMills: mills, fromWhom: z.string(), whatFor: z.string(), addedAt: isoTimestamp })),
  })),
  serverNow: isoTimestamp,
});

// ── The week's sales nobody claimed ─────────────────────────────────────────

export const saleNobodyQuerySchema = z.object({
  /** The Monday of the week (Moscow). */
  week: businessDate,
});
export const saleNobodyResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** The days of the week all of whose shifts are handed in: only their sales are here. */
  days: z.array(businessDate),
  sales: z.array(saleSchema.extend({ home: z.string(), words: z.string() })),
  totalMills: mills,
  serverNow: isoTimestamp,
});
export const saleNobodyKeepBodySchema = z.object({
  week: businessDate,
  /** The sales the owner leaves nobody's; absent — every one of the week's list. */
  transactionIds: z.array(intId).max(500).optional(),
});
export const saleNobodyKeepResponseSchema = z.object({ kept: z.number().int().nonnegative(), savedAt: isoTimestamp });

// ── Decisions carried over from the ledger and tied to no sale ──────────────

export const saleDecisionsUnlinkedResponseSchema = z.object({
  decisions: z.array(z.object({
    id: intId,
    ledgerDecisionId: intId.nullable(),
    pageLabel: z.string().nullable(),
    /** What the ledger wrote: the fan, the amount, the moment, who said it, why. */
    words: z.string(),
    saidBy: z.string().nullable(),
    shares: z.array(z.object({ userId: intId, name: z.string(), percent: z.number().int() })),
    kind: z.enum(["split", "nobody", "pot", "off_platform"]),
    candidates: z.array(saleSchema),
  })),
  serverNow: isoTimestamp,
});
export const saleDecisionLinkParamsSchema = z.object({ decisionId: idParam });
export const saleDecisionLinkBodySchema = z.object({ transactionId: intId });
export const saleDecisionLinkResponseSchema = z.object({ linked: z.boolean(), savedAt: isoTimestamp });

// ── The agent's door ────────────────────────────────────────────────────────

export const agentSaleClaimsQuerySchema = z.object({
  /** A person by the registry's code… */
  person: z.string().min(1).max(63).optional(),
  /** …or by Telegram id… */
  telegramUserId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** …or a sale. */
  transactionId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** Only what is not over: open claims and standing decisions (the default); `all` — the history too. */
  scope: z.enum(["open", "all"]).default("open"),
}).refine((query) => query.person !== undefined || query.telegramUserId !== undefined || query.transactionId !== undefined, "name a person or a sale");

export const agentSaleClaimsResponseSchema = z.object({
  decisions: z.array(z.object({
    id: intId,
    transactionId: intId.nullable(),
    pageLabel: z.string().nullable(),
    kind: z.enum(["split", "nobody", "pot", "off_platform"]),
    shares: z.array(z.object({ person: z.string().nullable(), name: z.string(), percent: z.number().int() })),
    pot: z.string().nullable(),
    outcome: z.string(),
    note: z.string().nullable(),
    saidBy: z.string().nullable(),
    decidedAt: isoTimestamp,
    active: z.boolean(),
    needsLink: z.boolean(),
    /** One line in Russian, as a memory file would say it. */
    words: z.string(),
  })),
  claims: z.array(saleClaimSchema.extend({
    netMills: mills.nullable(),
    occurredAt: isoTimestamp.nullable(),
    /** One line in Russian. */
    words: z.string(),
  })),
  serverNow: isoTimestamp,
});

export const agentSaleClaimAnswerBodySchema = saleClaimAnswerBodySchema.extend({
  claimId: intId,
  /** The sender of the Telegram message: must be the other side's, else 409 `sender_not_person`. */
  telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** The message the words are in: required. */
  sourceRef: z.string().trim().min(1).max(300),
});

export type SaleDisputeResponse = z.infer<typeof saleDisputeResponseSchema>;
export type SaleDisputeOutcome = z.infer<typeof saleDisputeDecideBodySchema>["outcome"];
export type OffPlatformPendingResponse = z.infer<typeof offPlatformPendingResponseSchema>;
export type SaleNobodyResponse = z.infer<typeof saleNobodyResponseSchema>;
export type SaleDecisionsUnlinkedResponse = z.infer<typeof saleDecisionsUnlinkedResponseSchema>;
export type AgentSaleClaimsResponse = z.infer<typeof agentSaleClaimsResponseSchema>;

const personErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema,
} as const;
const agentErrors = { ...personErrors, 503: errorResponseSchema } as const;

export const saleClaimRouteSchemas = {
  saleClaimAnswer: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "The other side answers a claim on their sale: «Согласен» settles it, «Не согласен» (with a line of why) takes it to the owner",
    description: "Any session (the narrow one the extension opens included) or the chat extension's device token: the claim's other side "
      + "only, their switch «сдаёт смену в системе» on. Database only.",
    params: saleClaimAnswerParamsSchema,
    body: saleClaimAnswerBodySchema,
    response: { 200: saleClaimAnswerResponseSchema, ...personErrors },
  },
  saleDispute: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The owner's dispute of a sale: both statements, the facts, and what each of the four answers gives",
    description: "Owner only. Database only.",
    params: saleDisputeParamsSchema,
    response: { 200: saleDisputeResponseSchema, ...personErrors },
  },
  saleDisputeOfClaim: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The owner's dispute of a question carried over from the ledger that names no sale",
    description: "Owner only. Database only.",
    params: saleDisputeByClaimParamsSchema,
    response: { 200: saleDisputeResponseSchema, ...personErrors },
  },
  saleDisputeDecide: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The owner decides a dispute: to the first, to the second, in halves, to nobody; who, when and why are kept",
    description: "Owner only. The decision comes before the rule from now on; every report that counts the sale gets a new version "
      + "with what the decision gives (made by the system, the reason kept). Database only.",
    body: saleDisputeDecideBodySchema,
    response: { 200: saleDisputeDecideResponseSchema, ...personErrors },
  },
  offPlatformPending: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "«Мимо площадки» waiting for the owner, by report",
    description: "Owner only. Database only.",
    querystring: offPlatformPendingQuerySchema,
    response: { 200: offPlatformPendingResponseSchema, ...personErrors },
  },
  offPlatformDecide: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The owner confirms or rejects a «мимо площадки» line: a confirmed amount counts on a page of the report",
    description: "Owner only. The report gets a new version made by the system with the line's state (and a confirmed amount in its "
      + "page's sum); the person does not hand it in again. Database only.",
    params: offPlatformDecideParamsSchema,
    body: offPlatformDecideBodySchema,
    response: { 200: offPlatformDecideResponseSchema, ...personErrors },
  },
  saleNobody: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The week's sales nobody claimed, of the days all of whose shifts are handed in",
    description: "Owner only. Database only.",
    querystring: saleNobodyQuerySchema,
    response: { 200: saleNobodyResponseSchema, ...personErrors },
  },
  saleNobodyKeep: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "The owner leaves the week's unclaimed sales nobody's («никому»)",
    description: "Owner only. Each is the owner's decision «никому». Database only.",
    body: saleNobodyKeepBodySchema,
    response: { 200: saleNobodyKeepResponseSchema, ...personErrors },
  },
  saleDecisionsUnlinked: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Decisions carried over from the ledger that its text did not tie to a sale, each with the sales it may be",
    description: "Owner only. Database only.",
    response: { 200: saleDecisionsUnlinkedResponseSchema, ...personErrors },
  },
  saleDecisionLink: {
    auth: { kind: "owner-session" }, tags: ["admin"],
    summary: "Tie a decision carried over from the ledger to its sale («привязать»)",
    description: "Owner only. Database only.",
    params: saleDecisionLinkParamsSchema,
    body: saleDecisionLinkBodySchema,
    response: { 200: saleDecisionLinkResponseSchema, ...personErrors },
  },
  agentSaleClaims: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Decisions and claims of a person or a sale, on the key's pages (needs write:shift_reports or read:team)",
    description: "Database only. What Gengar's memory of «чья продажа» held, from Hub: one line of words with each.",
    querystring: agentSaleClaimsQuerySchema,
    response: { 200: agentSaleClaimsResponseSchema, ...agentErrors },
  },
  agentSaleClaimAnswer: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Record the other side's answer to a claim «со слов» (needs write:shift_reports)",
    description: "The sender's Telegram id must be the other side's: else 409 `sender_not_person`; the message is required.",
    body: agentSaleClaimAnswerBodySchema,
    response: { 200: saleClaimAnswerResponseSchema, ...agentErrors },
  },
} as const;
