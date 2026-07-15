> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Financial data and money representation

Platform revenue is represented in mills; AI provider spend is represented in
micro-USD. The codec is `packages/shared/src/money.ts`, transaction truth is in
`packages/db/src/schema.ts` plus `packages/db/src/repositories/transactions.ts`,
and HTTP reporting is registered by `apps/runtime/src/modules/finance/index.ts`.
OFAPI request credits are a separate operational currency documented through
the ops surface.

## Money codec

`Mills` is a branded `bigint` where 1,000 mills equals one USD. `MicroUsd` is a
branded integer `number` where 1,000,000 micro-USD equals one USD. The brands
are TypeScript-only; database values retain their integer representation.

Source-named constructors define the conversion boundary:

- `millsFromInteger` accepts already-mills bigint, number, or integer string.
- `millsFromDollars` parses a decimal dollar value to three fractional places.
- `millsFromCents` multiplies whole cents by ten.
- `microUsdFromDollars` and `microUsdFromDbInt` construct AI-plane values.
- `millsToMicroUsd` is exact multiplication by 1,000; `microUsdToMills`
  truncates sub-mill precision.

Display and aggregation helpers include `millsToDecimalString`,
`formatUsdFromMills`, numeric/whole-dollar projections, and `sumMills`.
`dollarsToMills` remains an alias of the source-honest dollar constructor.
Commission helpers calculate net from gross using a scaled integer rate and
OnlyFans whole-cent fee rounding; the inverse reconstructs gross from net.

`tests/money.test.ts` pins parsing, conversion, formatting, and commission
behavior. `tests/money-ratchet.test.ts` scans for raw money-like floating-point
rounding outside the codec and reads the ceiling from
`scripts/money-float-budget.json`; it also prevents the deleted generic
`toMills` entry point from returning.

## Transaction truth

The `transactions` table is keyed by `(platform_account_id, transaction_id)`.
It stores raw and canonical types, state, active/inactive status, gross,
source-destination and creator-net mills, optional platform fee/VAT/tax mills,
fan and observation lineage, scan token, timestamps, and source. The allowed
source vocabulary distinguishes legacy, Fansly, and OFAPI REST/webhook writers.

`upsertTransaction` in `packages/db/src/repositories/transactions.ts` preserves
sticky inactive reversal states, fills absent fee/lineage fields, and does not
let a later REST observation replace webhook provenance. Pending rows can be
retired or reconciled, and repository queries support scan-token absence checks,
rollup rebuilding, period reports, and fan/page scopes.

Canonical transaction data reaches the table through platform sync/projection
code. Page-level `transactions_writer` in `pages` gates which producer may
mutate a page's financial truth. Writer conflicts are surfaced as notification
incidents rather than silently mixing sources.

Financial aggregates are stored in daily and lifetime rollup tables declared
in `packages/db/src/schema.ts`. The reporting layer reads active transaction
truth and rollups. Inactive rows and the classification-excluded
`payout_reversal` type are omitted from reportable revenue, while chargebacks
and refunds remain classified adjustments.

## Finance HTTP surface

`apps/runtime/src/modules/finance/index.ts` exposes:

- overview, model, and page revenue summaries and daily series;
- page and cross-page transaction lists;
- page fan and cross-page fan transaction histories;
- spender auto-list summaries and bucket detail;
- v2 spender search, detail, series, and batch lookup; and
- the combined overview response used by the dashboard shell.

Page-scoped routes resolve the page and call `canAccessPage`. Raw revenue and
transaction reads also pass through `enforceRevenueRouteRoleScope`, whose
configured mode is either log-only would-deny behavior or handler enforcement
for non-dashboard bearer principals.

`apps/runtime/src/services/reporting.ts` implements page/model/overview revenue,
transaction, subscriber, follower, deleted-fan, fan-detail, growth, and fan
spend reports. It resolves platform-specific business-day windows through the
shared time engine and serializes mills explicitly for the wire.

`apps/runtime/src/services/spenders.ts` implements the cross-page spender model:
period-bounded totals, trends, retention classification, page breakdowns,
message/purchase context, series granularity, batch resolution, and visible-fan
search. Page membership and principal assignments constrain visible results.
Spender bucket thresholds come from `packages/shared/src/spender-buckets.ts`;
retention states and day thresholds come from
`packages/shared/src/spender-retention.ts`.

## Other financial consumers

Telegram revenue reports use mills throughout
`apps/runtime/src/services/telegram-report.ts`. Workboard value signals read
gross and creator-net mills. AI spend is written to `ai_usage_events` as
micro-USD and is never added to platform transaction totals. OFAPI credit ledger
rows count vendor request credits and may display a configured micro-USD price,
but that display estimate does not change transaction truth.
