// W7.3 (A21+B4): negation guards for the OFAPI spend writers.
//
// Two independent negative rows can negate the SAME payment — the webhook
// truth ingest / REST backfill mint `<id>:reversal` for 8 raw statuses, and
// the chargebacks reconcile mints `<id>:chargeback`. Dedup is per-suffix and
// their disjointness was only ever a comment, so a payment could be
// subtracted twice (B4). Separately, a negative can land whose original
// never settled (A21) — with the original parked `pending`, the pair used to
// net zero only by accident of the display's missing state filter.
//
// Guards (check-then-write; every caller already runs inside
// withOfapiSpendTransactionPageLock, which makes this race-safe per page):
// - Guard 1 (B4): the OTHER-suffix twin is active → write THIS negative
//   inactive as 'superseded_duplicate_negation'. First negative wins.
// - Guard 2 (A21): no active SETTLED positive under the base id (posted, or
//   pending and settled by OnlyFans' ledger since) → write the
//   negative inactive as 'reversal_without_settled_original'. A
//   later-arriving settled original reactivates it (the fixup below — the
//   ONLY reactivation path; redeliveries never resurrect, see Guard 0 in
//   upsertTransaction's conflict-set).

import {
  getTransactionByTransactionId,
  reactivateSuppressedNegations,
  upsertTransaction,
  type Database,
  type UpsertTransactionInput,
} from "@agency_hub_core/db";

const NEGATION_SUFFIX_RE = /:(reversal|chargeback)$/;

export function negationBaseTransactionId(transactionId: string): string | null {
  return NEGATION_SUFFIX_RE.test(transactionId)
    ? transactionId.replace(NEGATION_SUFFIX_RE, "")
    : null;
}

export type NegationSuppressionReason =
  | "superseded_duplicate_negation"
  | "reversal_without_settled_original";

export async function evaluateNegationSuppression(
  db: Database,
  input: { platformAccountId: number; transactionId: string },
): Promise<NegationSuppressionReason | null> {
  const base = negationBaseTransactionId(input.transactionId);
  if (base === null) {
    return null;
  }

  const twinId = input.transactionId.endsWith(":reversal")
    ? `${base}:chargeback`
    : `${base}:reversal`;
  const twin = await getTransactionByTransactionId(db, {
    platformAccountId: input.platformAccountId,
    transactionId: twinId,
  });
  if (twin?.isActive) {
    return "superseded_duplicate_negation";
  }

  const original = await getTransactionByTransactionId(db, {
    platformAccountId: input.platformAccountId,
    transactionId: base,
  });
  // Settled as readers count it: a pending row OnlyFans' ledger settled since is settled (settledTransactionState).
  if (!original || !original.isActive || original.settledState !== "posted") {
    return "reversal_without_settled_original";
  }

  return null;
}

export interface GuardedUpsertResult {
  suppressedAs: NegationSuppressionReason | null;
  /** Earliest occurred_at a late-original fixup reactivated (extend the
   * caller's rollup dirtyFrom with it), null when nothing reactivated. */
  reactivatedFrom: Date | null;
}

/** Drop-in for upsertTransaction on the OFAPI spend/chargeback/backfill
 * paths. Negative rows are guard-evaluated; settled positives trigger the
 * late-original fixup. */
export async function upsertTransactionWithNegationGuards(
  db: Database,
  input: UpsertTransactionInput,
): Promise<GuardedUpsertResult> {
  const base = negationBaseTransactionId(input.transactionId);
  if (base !== null) {
    const suppressedAs = await evaluateNegationSuppression(db, {
      platformAccountId: input.platformAccountId,
      transactionId: input.transactionId,
    });
    await upsertTransaction(db, {
      ...input,
      ...(suppressedAs ? { suppressAs: suppressedAs } : {}),
    });
    return { suppressedAs, reactivatedFrom: null };
  }

  await upsertTransaction(db, input);
  if (input.transactionState !== "posted") {
    return { suppressedAs: null, reactivatedFrom: null };
  }
  const { reactivatedFrom } = await reactivateSuppressedNegations(db, {
    platformAccountId: input.platformAccountId,
    baseTransactionId: input.transactionId,
  });
  return { suppressedAs: null, reactivatedFrom };
}
