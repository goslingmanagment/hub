/**
 * Цепочка продажи (ecosystem plan 2026-11-12, package T): from one sale, where its money is — «Продажа → Чья → Смена →
 * Отчёт → Начисление → Выплата», each link with a state, words and the screen that opens it. One read for every place
 * a sale stands (the shift screen's line, the owner's dispute, the console's «Операции» and the fan's operations) and
 * for agents. Read only: nothing here changes the rule, a home, a report or the ledger, and no number is computed
 * anew — the home is `sale_homes`, the report Hub's handed-in version or the ledger's post of that day, the accrual and
 * the payout the ledger's day of that person.
 *
 * Who reads what: the owner everything, pay included; a chatter a sale of their own shifts, reports or claims on a
 * page they may open — the home, their own report, their accrual and payout as states, their own sums only with their
 * switch «видит свои деньги»; a team lead a sale of their pages — whose it is, the shift and the report, never another
 * person's accrual or payout, not even as a state; an agent key (read:team + read:money) a sale of its pages, no pay sums. Another sale is not found. A link whose source did not answer says «неизвестно»
 * and why, never a guess.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** A sale by Hub's id, or by its page and the platform's transaction id (the console's rows name it so). */
export const saleChainQuerySchema = z.object({
  saleId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  pageLabel: z.string().trim().min(1).max(200).optional(),
  transactionRef: z.string().trim().min(1).max(200).optional(),
}).refine((query) => (query.saleId !== undefined) !== (query.pageLabel !== undefined && query.transactionRef !== undefined), "name the sale: saleId, or pageLabel and transactionRef");

/**
 * A link's state, for its mark: `done` — in place (handed in, accrued, paid); `wait` — not yet (to hand in, to pay);
 * `open` — a dispute or a claim waits; `none` — not applicable (a pot's sale has no shift); `unknown` — its source did
 * not answer (the words say why): never read as «paid».
 */
export const SALE_CHAIN_STATES = ["done", "wait", "open", "none", "unknown"] as const;

export const saleChainLinkSchema = z.object({
  state: z.enum(SALE_CHAIN_STATES),
  /** One line in Russian: «сдан: версия 2, 11 нояб., 23:10», «к выплате», «неизвестно: ledger не ответил». */
  words: z.string(),
  /** Where it is seen: a Workboard or console path; null — no screen of it for this reader. */
  link: z.string().nullable(),
  /** A sum of it the reader may see (a share, a post's page, a day's accrual or payout); null — none or not theirs to see. */
  amountMills: mills.nullable(),
});

export const saleChainResponseSchema = z.object({
  sale: z.object({
    transactionId: intId,
    pageLabel: z.string(),
    platform: z.string(),
    /** Hub's canonical type: message_purchase, post_purchase, tip, stream_tip, subscription. */
    kind: z.string(),
    occurredAt: isoTimestamp,
    netMills: mills,
    fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
  }),
  /** «Чья»: the home and why, the owner's decision or the agreement above the rule, an open claim or dispute. */
  home: saleChainLinkSchema.extend({
    /** shift, visit, pot, waiting, decide, nobody, before_rule, unknown; null — not computed yet. */
    kind: z.string().nullable(),
    /** The rule's reason in its words; null — none. */
    reason: z.string().nullable(),
    /** The owner's decision or the agreement standing above the rule, in words; null — none. */
    above: z.string().nullable(),
    /** An open claim or dispute: «спор открыт: ждёт ответа Алекса до 13 нояб., 15:04»; null — none. */
    dispute: z.string().nullable(),
  }),
  /**
   * The people the home gives a share, each with the rest of the chain: their shift, their report of that day, the
   * ledger's accrual and payout of that day. A chatter sees only their own; empty — nobody's sale, a pot's, waiting.
   */
  people: z.array(z.object({
    userId: intId,
    name: z.string(),
    /** Their share of the net by the home; null — not the reader's to see. */
    shareMills: mills.nullable(),
    /** The day the ledger pays it by (the shift's report date). */
    reportDate: businessDate,
    shift: saleChainLinkSchema,
    report: saleChainLinkSchema,
    accrual: saleChainLinkSchema,
    payout: saleChainLinkSchema,
  })),
  /** Why the rest of the chain is empty or cut, for the reader: «общак: смены и выплаты по человеку нет»; null — nothing to say. */
  note: z.string().nullable(),
  serverNow: isoTimestamp,
});

export const agentSaleChainQuerySchema = z.object({
  /** Hub's id of the sale… */
  saleRef: z.string().regex(/^\d{1,19}$/).optional(),
  /** …or its page and the platform's transaction id. */
  pageLabel: z.string().trim().min(1).max(200).optional(),
  transactionRef: z.string().trim().min(1).max(200).optional(),
}).refine((query) => (query.saleRef !== undefined) !== (query.pageLabel !== undefined && query.transactionRef !== undefined), "name the sale: saleRef, or pageLabel and transactionRef");

export type SaleChainQuery = z.infer<typeof saleChainQuerySchema>;
export type SaleChainLink = z.infer<typeof saleChainLinkSchema>;
export type SaleChainResponse = z.infer<typeof saleChainResponseSchema>;

const errors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
} as const;

export const saleChainRouteSchemas = {
  saleChain: {
    auth: { kind: "any" }, tags: ["client"],
    summary: "From one sale, its chain of money: whose it is, the shift, the report, the accrual, the payout",
    description: "Any session (the narrow one the extension opens included): the owner every sale with pay sums; a chatter a "
      + "sale of their own shifts, reports or claims on a page they may open, their own pay as states (sums with "
      + "«видит свои деньги»); a team lead a sale of their pages without anyone's pay (accrual and payout «видит только "
      + "владелец»). Another sale is 404. Database and "
      + "the ledger's reads the payout panel and «Выплаты → Отчёты» already make; a source that does not answer is «неизвестно».",
    querystring: saleChainQuerySchema,
    response: { 200: saleChainResponseSchema, ...errors },
  },
  agentSaleChain: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "A sale's chain of money for an agent: whose, the shift, the report, accrual and payout states, no pay sums (needs read:team and read:money)",
    description: "A sale of the key's pages, else 404. No pay sum is served: the ledger is the agents' door for pay.",
    querystring: agentSaleChainQuerySchema,
    response: { 200: saleChainResponseSchema, ...errors, 503: errorResponseSchema },
  },
} as const;
