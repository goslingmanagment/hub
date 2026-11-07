import { sql, type SQL } from "drizzle-orm";

import type { TransactionState } from "@agency_hub_core/shared";

/**
 * The state a reader counts a transaction in: the state its writer gave the
 * row, except that a `pending` row OnlyFans' own ledger has since settled
 * counts as `posted`.
 *
 * Why it is read, not written: a row of another writer is never changed
 * (services/client-onlyfans-feed-money.ts). OFAPI writes a purchase `pending`
 * and only its own rescan settled it; once a page's writer is `chatspace`
 * (the OnlyFans feed), OFAPI writes nothing there, so its pendings would stay
 * pending forever. The feed's ledger sighting that claims such a row records
 * the ledger's `done` (or `undo`, charged back) on its OWN claim
 * (`onlyfans_feed_money_claims.settled_at`, 0357), and every reader of the
 * state reads it through this expression. The amounts never change: only the
 * bucket the row is counted in.
 *
 * Not for a writer's own mechanics (OFAPI's ingest and its projection
 * diagnostics, Fansly's settle): those compare their row with their own facts.
 */
export function settledTransactionStateText(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Bad table alias "${alias}"`);
  return `(case when ${alias}.transaction_state <> 'pending'::transaction_state then ${alias}.transaction_state
      when exists (select 1 from onlyfans_feed_money_claims settled
                   where settled.transaction_row_id = ${alias}.id and settled.settled_at is not null)
        then 'posted'::transaction_state
      else ${alias}.transaction_state end)`;
}

/** settledTransactionStateText for raw SQL over `transactions <alias>`. */
export function settledTransactionStateSql(alias: string): SQL<TransactionState> {
  return sql.raw(settledTransactionStateText(alias)) as SQL<TransactionState>;
}

/**
 * settledTransactionStateText for a query builder over the `transactions` table
 * itself (not aliased). Named by the table on purpose: in a one-table select the
 * builder leaves its own columns unqualified, and an unqualified `id` inside the
 * subquery would quietly mean whatever `id` the claims table might one day have.
 */
export function settledTransactionState(): SQL<TransactionState> {
  return settledTransactionStateSql("transactions");
}
