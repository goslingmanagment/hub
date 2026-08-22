// Fansly revenue type codes → labels (WP-S1, §5 "Shared label modules").
//
// STORAGE ALWAYS HOLDS THE RAW INTEGER (A22-2). `revenue_mix_daily.type_code` is
// an integer and stays one; this module is a READ-TIME label table and nothing
// else. It exists because S1 serves `revenue_mix_daily` on a REST route and on a
// dataset, and the initiative's rule for every labelled enum is "raw code +
// label + mapping version" — a label with no table is a guess, and a code with
// no label is unreadable.
//
// THE TRAP THIS TABLE EXISTS TO SURVIVE (A22-2, verified against the client
// bundle at `main.pretty.js:151984–152035` / `235227–235280`): ONE VISIBLE LABEL
// MAPS TO TWO LIVE CODES, legacy and current, and the ledger reaches back to
// 2025-03-06 — well into legacy territory.
//
//   label            legacy   current
//   Media             2010     2110
//   Media Sets        2016     2116
//   Tips              7001     7101
//   Locked Text      32001    32101
//   Stream Tickets   45001    45101
//   Subscriptions    15002    15001
//   Referrals        18002    18001
//
// Keying storage by the LABEL silently merges legacy into current; keying by
// code against a closed four-value set silently DROPS every legacy row. Both
// halves of every pair therefore get their own row here, with the same label and
// an explicit `era`, so a reader can see the merge instead of suffering it.
//
// FOLDING IS NOT DONE HERE. A22-2: "the folding is per-context and applies only
// at read time" — the wallet-earnings chart folds `18002 → 18001`, and the
// tracking-link chart additionally folds `15002 → 15001`. Neither fold is
// applied by this module and neither is applied by S1's serving layer: a caller
// that wants the platform chart's grouping groups by `label`, and a caller that
// wants the ledger truth groups by `code`. Both are available because both are
// served.

/** Bumped whenever a mapping below changes. v1 is the A22-2 table plus the
 *  ledger renderer's dispatch codes (`main.pretty.js:215060–217180`). */
export const FANSLY_REVENUE_LABEL_VERSION = 1;

/** Which half of a legacy/current pair a code is, or `single` when it has no
 *  twin. Serving it is what makes the pair visible rather than surprising. */
export type FanslyRevenueTypeEra = "legacy" | "current" | "single";

export interface FanslyRevenueTypeRow {
  code: number;
  label: string;
  era: FanslyRevenueTypeEra;
}

/**
 * The per-code table. Every row's provenance is the client bundle read named in
 * the header; nothing here is inferred from a sample of our own data.
 */
export const FANSLY_REVENUE_TYPES: readonly FanslyRevenueTypeRow[] = Object.freeze([
  // ── the five sampled pairs (A22-2) ───────────────────────────────────────
  { code: 2010, label: "media", era: "legacy" },
  { code: 2110, label: "media", era: "current" },
  { code: 2016, label: "media_sets", era: "legacy" },
  { code: 2116, label: "media_sets", era: "current" },
  { code: 7001, label: "tips", era: "legacy" },
  { code: 7101, label: "tips", era: "current" },
  { code: 32001, label: "locked_text", era: "legacy" },
  { code: 32101, label: "locked_text", era: "current" },
  { code: 45001, label: "stream_tickets", era: "legacy" },
  { code: 45101, label: "stream_tickets", era: "current" },
  { code: 15002, label: "subscriptions", era: "legacy" },
  { code: 15001, label: "subscriptions", era: "current" },
  { code: 18002, label: "referrals", era: "legacy" },
  { code: 18001, label: "referrals", era: "current" },
  // ── the ledger renderer's other dispatch codes ───────────────────────────
  // Two of these move money the WRONG WAY (6101 refund, 16013 canceled-payout
  // refund). A four-type projection would have bucketed both as unknown.
  { code: 6101, label: "refund", era: "single" },
  { code: 6002, label: "internal_transfer", era: "single" },
  { code: 6515, label: "subscription_payment_credit", era: "single" },
  { code: 14001, label: "balance_purchase", era: "single" },
  { code: 16013, label: "canceled_payout_refund", era: "single" },
  { code: 24101, label: "leaderboard_prize_money", era: "single" },
  { code: 24102, label: "gift_code_claim", era: "single" },
  { code: 24103, label: "promotional_credit", era: "single" },
  { code: 24301, label: "crypto_balance_purchase", era: "single" },
  // Dispatches on a NESTED product type; the outer code alone says only that a
  // product was ordered, so the label says exactly that and no more.
  { code: 58000, label: "product_order", era: "single" },
]);

const ROWS_BY_CODE: ReadonlyMap<number, FanslyRevenueTypeRow> = new Map(
  FANSLY_REVENUE_TYPES.map((row) => [row.code, row]),
);

/** `<label>` for a code this version can name, `unmapped:<code>` otherwise.
 *  Never a fabricated family reading: an unnamed code stays unnamed. */
export function fanslyRevenueTypeLabel(code: number): string {
  if (!Number.isSafeInteger(code)) {
    return `unmapped:${String(code)}`;
  }
  return ROWS_BY_CODE.get(code)?.label ?? `unmapped:${code}`;
}

/** `legacy` / `current` / `single`, or `null` for a code with no row. */
export function fanslyRevenueTypeEra(code: number): FanslyRevenueTypeEra | null {
  if (!Number.isSafeInteger(code)) {
    return null;
  }
  return ROWS_BY_CODE.get(code)?.era ?? null;
}

/** True when this label version can NAME the code. */
export function isKnownFanslyRevenueType(code: number): boolean {
  return !fanslyRevenueTypeLabel(code).startsWith("unmapped:");
}
