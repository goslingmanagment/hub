/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G): a claim — a
 * statement of a handed-in report that touches another person — as a person
 * and the owner read it, and the kinds of the matters it opens. The routes are
 * routes-sale-claims.ts; the shift report carries the claims of its lines.
 */
import { z } from "zod";

import { intId, isoTimestamp, mills } from "./primitives.ts";

/**
 * The kinds of package G's own matters, the server their one writer: the other side's «X считает своей …» (`sale.claim`),
 * the owner's dispute of a sale (`sale.dispute`), the owner's weekly line of sales nobody claimed (`sale.nobody_week`),
 * a report's «мимо площадки» waiting for the owner (`off_platform.pending`), the decisions carried over from the ledger
 * that wait to be tied to a sale (`sale.decisions.unlinked`). Kept apart from MATTER_SERVER_KINDS (as the shift report's):
 * «Состояние» closes every open matter of those that its own pass did not find. An agent key may open none of them.
 */
export const SALE_CLAIM_MATTER_KINDS = ["sale.claim", "sale.dispute", "sale.nobody_week", "off_platform.pending", "sale.decisions.unlinked"] as const;
const SALE_CLAIM_KIND_SET: ReadonlySet<string> = new Set(SALE_CLAIM_MATTER_KINDS);
export function isSaleClaimMatterKind(kind: string): boolean {
  return SALE_CLAIM_KIND_SET.has(kind);
}

export const SALE_CLAIM_STATES = ["asked", "agreed", "owner", "decided", "withdrawn"] as const;
export const SALE_CLAIM_ANSWERS = ["agree", "disagree"] as const;
export const SALE_DISPUTE_OUTCOMES = ["first", "second", "half", "nobody"] as const;
/** «Закрыть без решения»: only a question carried over from the ledger whose people Hub could not tell. */
export const SALE_DISPUTE_OUTCOMES_WITH_DISMISS = [...SALE_DISPUTE_OUTCOMES, "dismiss"] as const;

export const saleClaimStateEnum = z.enum(SALE_CLAIM_STATES);
export const saleClaimAnswerEnum = z.enum(SALE_CLAIM_ANSWERS);

const person = z.object({ userId: intId, name: z.string() });

/** One claim as a person reads it on their shift report, or the owner in a dispute. */
export const saleClaimSchema = z.object({
  id: intId,
  /** claim — a statement of a report; double — counted in two reports for more than its net; imported — a question carried over from the ledger. */
  kind: z.enum(["claim", "double", "imported"]),
  transactionId: intId.nullable(),
  pageLabel: z.string().nullable(),
  /** Who claims: the report's person; null — not known (a question carried over). */
  claimant: person.nullable(),
  /** mine — «моё»; share — «делим с …»; null — no word, the sale is counted twice. */
  statement: z.enum(["mine", "share"]).nullable(),
  /** The claimant's line of why. */
  note: z.string().nullable(),
  claimedAt: isoTimestamp,
  /** The other side; null — nobody to ask (the owner decides). */
  side: person.nullable(),
  /** The other side's shift whose report answers it; null — none known. */
  sideShiftId: intId.nullable(),
  state: saleClaimStateEnum,
  answer: saleClaimAnswerEnum.nullable(),
  answerNote: z.string().nullable(),
  answeredAt: isoTimestamp.nullable(),
  /** Why it went to the owner: disagree, silence (24 hours), no_side, double, imported; null — it did not. */
  escalatedWhy: z.enum(["disagree", "silence", "no_side", "double", "imported"]).nullable(),
  /** The owner's decision of the sale; null — none. */
  decision: z.object({
    outcome: z.enum(["first", "second", "half", "nobody", "imported"]),
    note: z.string().nullable(),
    decidedAt: isoTimestamp,
  }).nullable(),
  /** When the side may answer it (asked, or gone to the owner by silence and not decided). */
  answerBy: isoTimestamp.nullable(),
  /** A question carried over from the ledger: its words. */
  question: z.string().nullable(),
});

/** On the shift screen: the claims of the report's lines — incoming (someone claims what is yours) and outgoing (yours). */
export const shiftReportClaimSchema = saleClaimSchema.extend({
  direction: z.enum(["incoming", "outgoing", "other"]),
  /** The reader may answer it now: the other side, the claim asked. */
  canAnswer: z.boolean(),
  /** The sale, for a claim of a sale that is not a line of this report. */
  sale: z.object({
    kind: z.string(),
    occurredAt: isoTimestamp,
    netMills: mills,
    fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
  }).nullable(),
});


export type SaleClaim = z.infer<typeof saleClaimSchema>;
export type ShiftReportClaim = z.infer<typeof shiftReportClaimSchema>;
