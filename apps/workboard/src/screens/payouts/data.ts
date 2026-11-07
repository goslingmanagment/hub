/**
 * Выплаты — the data layer (spec §4.7). Owned by the Выплаты screen.
 *
 * Phase 1 adapter: `teamShiftExport` { from, to } — confirmed shift reports by
 * chatter (Moscow days, both included: the global period's `from`/`to`). No
 * placeholder data across periods: the columns of a new window must never carry
 * the sums of the old one.
 * The copy for the payout sheet stays byte for byte: reuse the format of
 * apps/dashboard/src/pages/team/payoutSheet.ts (move it to packages/ui by a new
 * file if both apps need it — ask in the report).
 * Query keys start with "payouts".
 */
export {};
