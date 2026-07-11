// W7.3 (A21+B4, decision #132): negation guards for the OFAPI spend writers.
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
// - Guard 2 (A21): no active SETTLED positive under the base id → write the
//   negative inactive as 'reversal_without_settled_original'. A
//   later-arriving settled original reactivates it (the fixup below — the
//   ONLY reactivation path; redeliveries never resurrect, see Guard 0 in
//   upsertTransaction's conflict-set).

import {
  deactivateTransactionById,
  getTransactionByTransactionId,
  listActiveNegationAnomalies,
  reactivateSuppressedNegations,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertTransaction,
  withOfapiSpendTransactionPageLock,
  type Database,
  type UpsertTransactionInput,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

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
  if (!original || !original.isActive || original.transactionState !== "posted") {
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

export interface NegationRepairResult {
  pairs: number;
  orphans: number;
  deactivated: number;
  pagesRebuilt: number;
  dryRun: boolean;
}

/** W7.3 repair (owner CLI `money:repair-negations`; E6 census 2026-07-11:
 * 0 double pairs, 9 orphan reversals ≈ −$114.95). Deactivates — NEVER
 * deletes — then rebuilds spender projections + revenue rollups per page
 * from the earliest affected row. Canonical-twin pin: the :reversal row
 * (webhook truth path, Audit B2) stays active; the :chargeback twin
 * deactivates as the duplicate. */
export async function repairNegationAnomalies(
  app: Pick<AppContext, "db" | "logger">,
  options: { dryRun?: boolean } = {},
): Promise<NegationRepairResult> {
  const dryRun = options.dryRun ?? false;
  const { pairs, orphans } = await listActiveNegationAnomalies(app.db);

  interface PageWork {
    deactivate: Array<{ id: number; reason: NegationSuppressionReason }>;
    dirtyFrom: Date;
  }
  const byPage = new Map<number, PageWork>();
  const add = (
    pageId: number,
    id: number,
    reason: NegationSuppressionReason,
    occurredAt: Date,
  ) => {
    const work = byPage.get(pageId) ?? { deactivate: [], dirtyFrom: occurredAt };
    work.deactivate.push({ id, reason });
    if (occurredAt.getTime() < work.dirtyFrom.getTime()) {
      work.dirtyFrom = occurredAt;
    }
    byPage.set(pageId, work);
  };

  const pairedChargebackIds = new Set<number>();
  for (const pair of pairs) {
    pairedChargebackIds.add(pair.chargeback_id);
    add(
      pair.platform_account_id,
      pair.chargeback_id,
      "superseded_duplicate_negation",
      new Date(pair.chargeback_occurred_at),
    );
  }
  for (const orphan of orphans) {
    // A row can be both halves of a pair AND an orphan; the pair reason wins
    // (it is the sharper diagnosis) — skip re-adding.
    if (pairedChargebackIds.has(orphan.id)) {
      continue;
    }
    add(
      orphan.platform_account_id,
      orphan.id,
      "reversal_without_settled_original",
      new Date(orphan.occurred_at),
    );
  }

  let deactivated = 0;
  let pagesRebuilt = 0;
  if (!dryRun) {
    for (const [pageId, work] of byPage) {
      await withOfapiSpendTransactionPageLock(app.db, pageId, async (db) => {
        for (const row of work.deactivate) {
          await deactivateTransactionById(db, { id: row.id, reason: row.reason });
          deactivated += 1;
        }
        await rebuildSpenderProjections(db, pageId, work.dirtyFrom);
        await rebuildRevenueRollups(db, pageId, work.dirtyFrom);
      });
      pagesRebuilt += 1;
    }
  }

  const result: NegationRepairResult = {
    pairs: pairs.length,
    orphans: orphans.length,
    deactivated,
    pagesRebuilt,
    dryRun,
  };
  app.logger.info(result, "Negation-anomaly repair complete");
  return result;
}
