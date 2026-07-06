> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 09 — Transactions, Spend, Reporting & OFAPI Credits

**Scope.** This document covers the financial-truth territory of `core`: the money model
(`packages/shared/src/money.ts`, `packages/shared/src/types.ts`), the canonical `transactions`
table and its ingest paths (`apps/runtime/src/services/sync/transactions.ts`,
`apps/runtime/src/services/sync/transaction-backfill.ts`,
`apps/runtime/src/services/sync/onlyfans-transactions.ts`,
`packages/db/src/repositories/transactions.ts`), the derived aggregates
(`revenue_daily`, `fan_spend_daily`, `fan_spend_lifetime`, `page_fan_identities`) and their
repositories (`packages/db/src/repositories/spenders.ts`,
`packages/db/src/repositories/top-spenders.ts`,
`packages/db/src/repositories/reporting.ts`), the spender/retention model
(`packages/shared/src/spender-buckets.ts`, `packages/shared/src/spender-retention.ts`), the
spender-analytics and reporting service surfaces (`apps/runtime/src/services/spenders.ts`,
`apps/runtime/src/services/reporting.ts`,
`apps/runtime/src/services/sync/onlyfans-top-spenders.ts`), the OFAPI **credit ledger**
(`apps/runtime/src/services/ofapi-credits.ts`, `apps/runtime/src/services/ofapi-credit-report.ts`,
plus `ofapi_credit_ledger`/`ofapi_credit_state` in `packages/db/src/repositories/ofapi.ts`), and
the OFAPI **spend-projection shadow** and its comparison against transaction truth
(`apps/runtime/src/services/ofapi-spend-projection.ts`,
`apps/runtime/src/services/ofapi-spend-projection-contract.ts`,
`apps/runtime/src/services/ofapi-spend-transaction-ingest.ts`,
`apps/runtime/src/services/ofapi-spend-transaction-mapping.ts`,
`apps/runtime/src/services/ofapi-transactions-backfill.ts`,
`apps/runtime/src/services/ofapi-spend-comparison.ts`). Two distinct financial paths run here: the
**canonical transactions path** (sync + OFAPI-projection ingest, feeding all reporting) and the
**OFAPI credit ledger** (what we *pay OFAPI*, entirely separate money). Both use the same "credits"
word loosely but they are unrelated: transaction money is USD mills of fan spend; OFAPI credits are
API-usage units.

---

## 1. The money model

### 1.1 Mills

All fan-spend money is stored as integer **mills**: `1 mill = $0.001`, so `$1 = 1000 mills`
(`packages/shared/src/money.ts`, `packages/shared/src/spender-buckets.ts:4`). Columns are Postgres
`bigint` carried as JS `bigint`.

| Function (`money.ts`) | Behavior |
| --- | --- |
| `toMills(value)` :4 | Coerces `bigint`/`number`/`string` to `bigint`; `number` is `Math.trunc`'d (drops sub-mill fractions). |
| `dollarsToMills(value)` :50 | Parses a dollar `number`/`string` to mills. A `number` is first `toFixed(3)` (3 decimal places); a string is regex-parsed `^(-)?(\d+)(?:\.(\d+))?$`, fraction padded/truncated to exactly 3 digits. Throws `Invalid dollar amount` on non-match. |
| `millsToNumber(value)` :38 | `Number(toMills(value))` — used everywhere at the service boundary to emit JSON numbers; loses precision above 2^53 mills (not reached in practice). |
| `formatUsdFromMills(value)` :26 | Formats as `$x.xx` via `Intl.NumberFormat`, rounding to cents by `Number(mills / 10n) / 100`. |
| `millsToDecimalString(value)` :16 | `"<whole>.<3-digit remainder>"` string, sign-preserving. |
| `sumMills(iterable)` :42 | `bigint` sum. |

`reporting.ts` also has `millsToRoundedCents` (`reporting.ts:101`): rounds mills to whole cents with
`(mills ± 5n) / 10n` (round-half-away-from-zero), used for the `totalSpentCents` fields of
subscriber/follower rows.

### 1.2 Gross vs creator-net; commission

Every transaction stores three amounts (`packages/db/src/schema.ts:1223`):

- **`grossAmountMills`** — what the fan paid (before platform fee).
- **`sourceDestinationAmountMills`** — the platform's raw destination amount.
- **`creatorNetAmountMills`** — the creator's net after the platform fee. **All reporting/revenue and
  spender lifetime totals are creator-net** (`getRevenueBreakdown` sums `creator_net_amount_mills`,
  `reporting.ts:255`,`322`).

Commission conversion (`money.ts:91`,`106`) uses `COMMISSION_RATE_SCALE = 10_000n`
(rate expressed 0..1; scaled to basis-points·10). `calculateNetMillsFromGross` computes the platform
fee, **rounding the fee to whole cents before subtracting** (`money.ts:102`, comment: "OnlyFans rounds
the platform fee to whole cents"). `calculateGrossMillsFromNet` inverts it with banker-free
`roundDiv` (round-half-up on magnitude, `money.ts:81`).

Per-platform net/gross derivation:
- **Fansly** (`sync/transactions.ts:396`): `destinationAmount` (mills) *is* creator-net; gross =
  `calculateGrossMillsFromNet(net, commissionRate)` **unless** `sourceAmount === destinationAmount`,
  in which case gross = `sourceAmount`. Commission rate is per-item `destinationTax/10_000` when a
  valid `0..10000` integer, else the page fallback (`resolveFanslyCommissionRate`, `:256`).
- **OnlyFans** (`sync/onlyfans-transactions.ts:650`): `amount` (dollars) → gross via `dollarsToMills`;
  net = `calculateNetMillsFromGross(gross, commissionRate)`. Chargebacks negate: gross =
  `-dollarsToMills(item.amount)` (`:696`).

### 1.3 Transaction types, buckets, states (`packages/shared/src/types.ts`)

Canonical `TransactionType` (9, `types.ts:4`): `subscription`, `tip`, `message_purchase`,
`post_purchase`, `stream_tip`, `chargeback`, `refund`, `payout_reversal`, `other`.

Each maps to a **reporting bucket** and an `affectsSpenderAnalytics` flag
(`transactionClassificationByType`, `types.ts:32`):

| Bucket | Types | In `reportableTransactionTypes`? | In `spenderAnalyticsTransactionTypes`? |
| --- | --- | --- | --- |
| `revenue` | subscription, tip, message_purchase, post_purchase, stream_tip | yes | yes |
| `adjustment` | chargeback, refund | yes | yes |
| `unclassified` | other | yes | yes |
| `excluded` | payout_reversal | **no** | **no** |

`reportableTransactionTypes` (bucket ≠ `excluded`) gates revenue rollups; `spenderAnalyticsTransactionTypes`
(`affectsSpenderAnalytics=true`, all but `payout_reversal`) gates `fan_spend_daily` and top-spender
aggregation. `getTransactionClassification(type).bucket` is used by revenue serializers to sort each
type into revenue/adjustment/unclassified (`reporting.ts:330`, `transactions.ts:334`).

`TransactionState` (`types.ts:100`): `pending` | `posted` | `unknown`. Per-platform mappers
(`mapFanslyTransactionState`, `mapOnlyMonsterTransactionState`, and for OFAPI
`mapOfapiSpendStatusToTransactionState` → `pending`|`posted`, `ofapi-spend-transaction-mapping.ts:34`).

### 1.4 Active/inactive; scan-token retire

`transactions.isActive` (default true) with `inactiveReason` enum whose only value is
`missing_from_sync_window` (`schema.ts:124`,`1236`) and `inactivatedAt`. Only `is_active = true` rows
feed rollups. A transaction is retired (`isActive=false`) by
`retireTransactionsMissingFromWindow` (`transactions.ts:338`) in three modes: `keep_set`,
`authoritative_empty`, `scan_token`. `upsertTransaction` always re-activates on write
(`isActive:true, inactiveReason:null`, `transactions.ts:74`).

The **scan-token** mechanism (OnlyFans incremental, §3.2): every write in a scan stamps
`transactions.scanToken` with a per-scan `randomUUID()`; after the scan, rows in-window whose
`scan_token IS DISTINCT FROM` the current token are retired. A defensive guard
(`countActiveInWindowTransactionsByScanToken`, `transactions.ts:388`) skips the destructive retire
when it would deactivate `> 50%` of the window **and** `> 5` rows absolute
(`onlyfans-transactions.ts:61`,`1120`) — the signature of a provider under-return.

---

## 2. The canonical `transactions` table and upsert

`transactions` (`schema.ts:1203`): PK `id bigserial`; unique
`(platform_account_id, transaction_id)` (`transactions_account_transaction_uniq`). Key columns:
`fanId` (FK `fans`, `set null`), `transactionId`, `rawType`, `canonicalType` (enum),
`transactionState` (enum), `grossAmountMills`/`sourceDestinationAmountMills`/`creatorNetAmountMills`
(bigint), `senderId`/`receiverId`, `correlationAccountId`, `occurredAt` (tz), `sourceUpdatedAt`,
`scanToken`, `isActive`, `inactiveReason`, `inactivatedAt`. Indexes cover
`(account,state,occurred_at)`, `(account,occurred_at)`, `(account,isActive,occurred_at)`, `(fanId)`.

`upsertTransaction` (`transactions.ts:52`) inserts or `ON CONFLICT (platform_account_id,
transaction_id) DO UPDATE`. Notable conflict semantics: `fanId` is `coalesce(excluded.fan_id, existing)`
(never overwrites a known fan with null); `scanToken` is preserved when the input omits it
(`undefined`) and otherwise set; every update re-activates the row. Returns the row.

`markTransactionsScanToken` (`transactions.ts:101`) batch-updates scanToken for a set of
`transactionIds` (1000/batch). `getOldestPendingTransactionAt` (`transactions.ts:419`) returns the
oldest active `pending` transaction — the rescan lower-bound anchor for both platforms.

---

## 3. Transaction ingest paths (into `transactions`)

Four writers hit `upsertTransaction`. All are **inbound** flows landing external platform data as
canonical rows, and all rebuild the same downstream aggregates (§4) over a `dirtyFrom` boundary.

### 3.1 Fansly sync (`sync/transactions.ts`)

Entry `syncTransactions` (`:1431`) loads the `transactions` checkpoint, then dispatches:
`syncTransactionsBackfill` (full offset head-scan) or `syncTransactionsIncremental` (windowed rescan)
based on the persisted checkpoint state (`parseTransactionBackfillState` /
`parseFanslyTransactionIncrementalState`). Data source: `app.adapter.getTransactionsPage` (Fansly
adapter — see territory 06). Each item is mapped (`mapFanslyTransactionType`,
`mapFanslyTransactionState`), fans are hydrated (`lookupHydratedFans`/`upsertHydratedFansForPage`),
raw payloads persisted (`persistRawPayload`, endpoint `earnings_transactions`), and rows upserted
inside `withOwnedPageSyncTransaction`. The incremental scanner tracks provider totals and emits
telemetry anomalies (`incremental_total_changed`, `incremental_offset_overlap`,
`incremental_total_mismatch`, `checkpoint_stalled`, `after_ineffective`, `wide_rescan`,
`rescan_cap_clamped`), and early-stops when the API ignores the `after` lower bound
(`:831`). Windowing (`transactionLookbackDays`, `transactionRescanCapDays`) is threaded live from
effective config, falling back to boot config. On chunk-budget yield it flushes the dirty range and
returns unsatisfied for resume.

### 3.2 OnlyFans sync (`sync/onlyfans-transactions.ts`, 2039 lines)

Two modes, both via `app.onlyFansAdapter.getTransactionsPage`/`getChargebacksPage` (OnlyMonster/OFAPI
adapter — territory 06/07):
- **Incremental** (`syncOnlyFansTransactionsIncremental`, `:721`): a `[start, end]` rescan (start =
  `max(earliestRescanStart, rescanCapStart)`, `startOfBusinessDay` UTC-clamped; manual `rescanStart`
  never widens past the cap). Every write stamps a per-scan `scanToken` (`:669`), transactions in the
  `transactions` phase then `chargebacks` phase. After the scan, `retireTransactionsMissingFromWindow`
  (`cleanupMode:"scan_token"`) retires stale rows *unless* the retire guard trips (§1.4), then
  `rebuildSpenderProjections`/`rebuildRevenueRollups` from `start`. Chargebacks are written as
  `canonicalType:"chargeback"` with negated gross.
- **Backfill** (`syncOnlyFansTransactionsBackfill`, `:1351`): 365-day sliding historical windows down
  to a lower bound resolved from page metadata
  (`ONLYFANS_TRANSACTION_BACKFILL_LOWER_BOUND_METADATA_KEY`), legacy account-created-at, or synthetic
  `2016-01-01` (`ONLYFANS_SYNTHETIC_BACKFILL_START`, `:52`). On a provider range-rejection it clamps
  the start and retries (`fetchOnlyFansBackfillTransactionsPage`, `:1277`).

Backfill/incremental resume state is parsed/validated by `transaction-backfill.ts`
(`parseTransactionBackfillState`, both `FanslyTransactionBackfillState` and
`OnlyFansTransactionBackfillState`, `:86`).

### 3.3 OFAPI webhook-projection ingest (§9) — writes truth when a flag is on

`applyOfapiSpendProjectionTransactions` (`ofapi-spend-transaction-ingest.ts:104`) turns
projected webhook events into canonical transactions. See §9.

### 3.4 OFAPI REST backfill (`ofapi-transactions-backfill.ts`) — CLI-triggered

Paginated `app.ofapi.listTransactions` walk for OFAPI-only OnlyFans pages; writes the same row shape
as §3.3. See §9.5.

All four converge on the same downstream rebuild: `rebuildSpenderProjections` + `rebuildRevenueRollups`
(often inside `withOfapiSpendTransactionPageLock` or `withOwnedPageSyncTransaction`).

---

## 4. Derived aggregates

### 4.1 `revenue_daily` (`revenueDaily`, `schema.ts:1263`)

Per `(platform_account_id, business_date, canonical_type, transaction_state)` rollup of
`transaction_count`, `gross_amount_mills`, `creator_net_amount_mills`. Rebuilt by
`rebuildRevenueRollups` (`transactions.ts:127`): deletes rows `>= businessDate(from)` then re-inserts
by grouping active `reportableTransactionTypes` transactions, bucketing `business_date =
timezone('UTC', occurred_at)::date`. **Business date is always computed in UTC in the rollup SQL**,
though `resolveBusinessTimeZone(platform)` is used when *reading* to translate a period's calendar
bounds to business-date strings — OnlyFans vs Fansly business timezones differ (see the "platform
window widths differ" note, `reporting.ts:241`).

### 4.2 `fan_spend_daily` (`fanSpendDaily`, `schema.ts:1294`)

Per `(platform_account_id, fan_id, business_date, canonical_type, transaction_state)` with counts +
gross/net + `last_transaction_at`. Rebuilt by `rebuildSpenderDailyFacts` (`spenders.ts:54`): deletes
`>= businessDate(from)` (UTC), re-inserts from active `spenderAnalyticsTransactionTypes` transactions
with a non-null `fan_id`. This is the source table for all windowed spender metrics.

### 4.3 `fan_spend_lifetime` (`fanSpendLifetime`, `schema.ts` alias) + `page_fans` denormalization

Per `(platform_account_id, fan_id)` lifetime gross/net + `last_transaction_at`. Rebuilt by
`rebuildSpenderLifetimePage` (`spenders.ts:105`) by summing `fan_spend_daily`; with a `from` bound it
only recomputes fans touched since `from`, then denormalizes `page_fans.total_creator_net_mills` from
lifetime net (full-rebuild path `spenders.ts:224`, incremental path `:176`).

### 4.4 Rebuild orchestration + watermark

`rebuildSpenderProjections` (`spenders.ts:213`) runs daily-facts + lifetime rebuilds + the
`page_fans` denorm inside one transaction and stamps `spender_projection_watermarks.last_rebuilt_at`
(`upsertSpenderProjectionWatermark`, `:189`). `getSpenderProjectionAsOf` (`:313`) reads the *minimum*
watermark across a page set — surfaced as the `asOf` staleness marker in every spender response.

### 4.5 Top spenders (`page_fan_identities` a.k.a. `pageTopSpenders`, `schema.ts:1366`)

PK `(platform_account_id, source_identity_key)`; carries `correlationAccountId`, `accountId`, `fanId`,
`grossAmountMills`, `creatorNetAmountMills`, `sourceWindowStartedAt`/`EndedAt`, `lastSyncedAt`.
`upsertPageTopSpenders` (`top-spenders.ts:21`) upserts a window's rankings. For **OnlyFans**, rankings
are computed *entirely from the `transactions` table* — zero external requests —
`aggregateTransactionTopSpenders` (`top-spenders.ts:123`) sums per-fan gross/net over `[from,to)` for
active, fan-linked, `spenderAnalyticsTransactionTypes` rows. The `top_spenders` executor handler
(`sync/executor-handlers.ts:1362`) bootstraps monthly windows anchored on
`getEarliestSpenderTransactionAt` (`top-spenders.ts:151`) then refreshes a trailing 7-day steady-state
window. `onlyfans-top-spenders.ts` is purely the flag gate + pause machinery
(`isOnlyFansTopSpendersEnabled` on config `onlyFansTopSpendersEnabled`, default off;
`filterOnlyFansTopSpendersStreams` strips the stream when off; `pauseDisabled…` pauses page sync for
the stream). (Fansly top-spenders come from a provider stream — territory 06.)

### 4.6 Spender buckets & retention (`packages/shared`)

`SPENDER_AUTO_LIST_BUCKETS` (`spender-buckets.ts:14`) — 6 lifetime-gross bands mirroring Fansly
"[FB] $X-$Y Spenders" lists: `0-25` (min 10 mills), `25-50`, `50-150`, `150-350`, `350-600`, `600-plus`
(open-ended). Consumed by the auto-lists endpoints (§5).

`SPENDER_RETENTION_STATUSES` (`spender-retention.ts:1`): `all`, `active`, `cooling`, `inactive`,
`needs_reactivation`. `classifyRetention` (`:23`): `active` if last transaction ≤ 14 days
(`SPENDER_RETENTION_ACTIVE_DAYS`); `cooling` if ≤ 45 days (`…INACTIVE_DAYS`); otherwise
`needs_reactivation` if lifetime creator-net ≥ `100_000` mills ($100), else `inactive`. The same
thresholds are reproduced as SQL in `buildRetentionFilterSql` (`spenders.ts:484`) for server-side
filtering.

---

## 5. Spender-analytics service (`apps/runtime/src/services/spenders.ts`)

Serves the `/api/v2/spenders*` and `/api/v2/fans/search` and page auto-list endpoints. All amounts
are emitted as JSON numbers via `millsToNumber`. Scope resolution (`resolveSpenderScope`, `:317`):
`page` | `model` | `agency`, respecting `AuthPrincipal` visible page IDs; API-key principals are
restricted to `page` scope (`ForbiddenError`, `:324`). Period handling (`normalizePeriodInput`, `:165`)
supports `lifetime` and windowed periods incl. `custom` (`from`/`to`), resolved to platform-aware
business-date ranges (`resolveSpenderBusinessDateRangeForPlatform`).

| Service fn (`spenders.ts`) | Endpoint (`api/server.ts`) | Reads |
| --- | --- | --- |
| `getSpenderList` :741 | `GET /api/v2/spenders` :1220 | `listRankedSpenders`, `getSpenderWindowMetrics` (comparison), `getSpenderLifetimeMetrics` (platform), `getSpenderRevenueDiagnosticsForScope` |
| `getSpenderDetail` :847 | `GET /api/v2/spenders/:platform/:platformUserId` :1227 | `findVisibleFanByIdentity`, window/lifetime metrics, `getSpenderTypeBreakdown`, `getVisibleFanPageMemberships` |
| `getSpenderSeries` :972 | `GET /api/v2/spenders/:platform/:platformUserId/series` :1234 | `getSpenderDailySeriesRows` bucketed day/week/month |
| `getSpenderBatch` :1050 | `POST /api/v2/spenders:batch` :1242 | batch lifetime/window/type-breakdown/subscription |
| `searchVisibleFans` :1208 | `GET /api/v2/fans/search` :1249 | `searchFansInScope` + memberships |
| `getPageSpenderAutoLists` :444 | `GET /api/v1/pages/:pageLabel/spender-autolists` :967 | `countPageFansBy{Lifetime,Window}GrossBuckets` |
| `getPageSpenderAutoListDetail` :502 | `.../spender-autolists/:bucketKey` :978 | `listPageFansBy{Lifetime,Window}GrossBucket` |

`listRankedSpenders` (`spenders.ts:1045`, DB repo) is the workhorse: it joins `fan_spend_daily`
(window) or `fan_spend_lifetime` (lifetime) with `fans`, the primary DM conversation
(`page_dm_conversations`), the latest transaction, and lifetime metrics, applying the retention SQL
filter and paginating with a windowed `count(*) over()`. Window metrics split gross/net into
`posted`/`pending`/`unknown` sub-totals per transaction state
(`getSpenderWindowMetrics`, `spenders.ts:643`; also surfaced in the series buckets). "Diagnostics"
(`getSpenderRevenueDiagnosticsForScope`, `spenders.ts:1781`) reconciles `revenue_daily` totals against
`fan_spend_daily` attributed totals and reports the **unattributed** delta (revenue with no fan link).

---

## 6. Reporting service (`apps/runtime/src/services/reporting.ts`)

The overview/revenue/list surface behind the `/api/v1` reporting endpoints. Revenue reports operate on
`revenue_daily` (creator-net); `serializeRevenueWindow` (`:149`) sums each type into
`revenueMills`/`adjustmentMills`/`unclassifiedMills` by bucket, with `netEarningsMills =
revenue + adjustment + unclassified` and a redundant `totalNetMills` alias. Mixed-platform overview
reports resolve **per-platform windows** (`buildPlatformRevenueWindows`, `:245`; OnlyFans trailing
windows are deliberately one calendar day wider — audit B2 note) and union them into one top-level
window (`combinePeriodBounds`, `:269`); each type row is merged across platforms
(`mergeRevenueBreakdownRows`, `:303`). Comparison windows produce `deltaNetMills`/`deltaPct`.

| Service fn | Endpoint | Notes |
| --- | --- | --- |
| `getOverviewRevenueReport` :510 | `GET /api/v1/overview/revenue` :820 | per-page + per-model net totals |
| `getModelRevenueReport` :569 | `GET /api/v1/models/:modelSlug/revenue` :846 | |
| `getPageRevenueReport` :457 | `GET /api/v1/pages/:pageLabel/revenue` :859 | single-page window + comparison |
| `getPageTransactionsReport` :625 | `GET /api/v1/pages/:pageLabel/transactions` :874 | raw `transactions` rows via `listTransactionsForPage`; Fansly numeric `rawType` re-parsed to number (`serializeRawType`, :110) |
| `getPageSubscribersReport` / `…DailyReport` :669/:707 | subscribers endpoints | joins `page_subscriptions`, `fan_spend_lifetime` |
| `getPageFollowersReport` / `…DailyReport` :731/:784 | followers endpoints | includes DM + presence |
| `getPageFansReport` / `getPageDeletedFansReport` :808/:845 | fans endpoints | |
| `getPageFanDetailReport` / `getCrossPageFanDetailReport` :891/:960 | fan detail | `getPlatformTotalSpendForFan` |
| `getOverviewGrowthReport` :1038 | `GET /api/v1/overview/growth` | follower/subscriber deltas from `daily_followers`/`daily_subscribers` |
| `getFanSpendSummary` :1081 | (helper) | |

Repository backing lives in `reporting.ts` (DB): `getRevenuePageTotals`/`…ForExactPeriod`
(the latter windows directly on `transactions.occurred_at` for the credits page revenue overlay, §8),
`getRevenueBreakdownForScope`, `listTransactionsForPage`/`…ForScope`/`listFanTransactions*`,
subscriber/follower listers, and `getPlatformTotalSpendForFan` (creator-net sum from
`fan_spend_lifetime`). Reporting functions do not call Telegram directly; the Telegram report jobs
consume equivalent rollups — see cross-refs.

---

## 7. OFAPI credit ledger (what we pay OFAPI)

This is **separate money** from §1–§6: it tracks OFAPI API-usage credits, not fan spend. Master gate:
`OFAPI_CREDIT_LEDGER_ENABLED` (config `ofapiCreditLedgerEnabled`, default off,
`isOfapiCreditLedgerEnabled`, `ofapi-credits.ts:50`). With the flag off, the sink is a no-op and the
day counter keeps its pre-ledger behavior.

### 7.1 Tables

**`ofapi_credit_state`** (`schema.ts:1980`) — singleton row `id=1`: `spend_day`/`spent_credits`
(global daily counter), `audience_spend_day`/`audience_spent_credits` (audience-sweep reservation
counter, audit F9), `last_balance`/`last_balance_at` (last server-reported balance),
`reconciled_through_ledger_id`/`last_reconcile_at`/`last_drift_credits` (reconciliation cursor).

**`ofapi_credit_ledger`** (`schema.ts:2015`) — append-only. Columns: `id bigserial`, `occurred_at`,
`source` (one of `OFAPI_CREDIT_LEDGER_SOURCES` = `rest`|`webhook_accrual`|`external`|`refill`|`adjustment`,
`schema.ts:2000`), `operation`, `page_id`, `http_status`, `credits` (int; **positive = spent, negative
= added**), `estimated`, `balance_after`, `request_id`, `accrual_day`, `details jsonb`. Indexes cover
occurred-at ordering, page/operation-filtered listing, a **partial** balance-observation index
(`WHERE balance_after IS NOT NULL`), and a **partial unique** index on `accrual_day WHERE source =
'webhook_accrual'` (idempotent daily accrual).

### 7.2 The spend sink (D2)

`createOfapiCreditSpendSink` (`ofapi-credits.ts:62`) returns an `OfapiCreditSpendSink` wired into
`createOfapiClient`. For every reported REST response it calls `recordOfapiCreditSpend`
(`ofapi.ts:1234`), which in **one transaction** inserts a `source:'rest'` ledger row *and* increments
the `ofapi_credit_state` global day counter (`recordOfapiCreditUsage`, `ofapi.ts:995`) so the fast
budget counter can never disagree with the ledger. The sink never throws — a failed write is logged and
the reconciliation residual absorbs the gap. Observation fields consumed: `operation`, `pageId`,
`httpStatus`, `credits`, `estimated`, `balanceAfter`, `requestId`, `attemptNumber`, `isCached`.

### 7.3 Webhook accrual (D4)

`webhookAccrualCredits(eventCount) = ceil(eventCount/100)` — 1 credit per 100 webhook events
(`ofapi-credits.ts:94`). `runOfapiWebhookAccrual` (`:116`) walks the last 7 completed UTC days
(`ACCRUAL_BACKFILL_MAX_DAYS`), counts journaled deliveries via
`countOfapiWebhookEventsReceivedBetween` (`ofapi.ts:1295`, over `ofapi_webhook_events.received_at`),
and posts one idempotent `source:'webhook_accrual'` row per day via `upsertOfapiWebhookAccrual`
(`ofapi.ts:1266`, `ON CONFLICT (accrual_day) … DO NOTHING`). `occurred_at` is set to the accrued
day's start so occurred-at-bucketed aggregates attribute the credits to the arrival day.

### 7.4 Reconciliation (D5) — bank-statement decomposition

`planOfapiCreditReconciliation` (`ofapi-credits.ts:186`, pure) walks balance observations
(`ofapi_credit_ledger` rows with a non-null `balance_after`) in insertion order from the cursor. For
each accepted consecutive pair, `residual = previous.balanceAfter − knownCredits − observed.balanceAfter`,
where `knownCredits = ledgerKnownCredits + webhookCredits`. `ledgerKnownCredits` sums only
`rest`+`adjustment` rows (`OFAPI_RECONCILE_KNOWN_SOURCES`, `ofapi.ts:1355`); **`webhook_accrual` is
deliberately excluded** and instead estimated per window as `events/100` fractional
(`estimateWebhookCreditsBetween`, `ofapi-credits.ts:298`) to avoid double-counting (audit F8).
`residual > tolerance (1)` → `source:'external'` (spend we didn't record); `residual < −tolerance` →
`source:'refill'`. Observations closer than `RECONCILE_MIN_OBSERVATION_GAP_MS` (60s) to the last
accepted one are skipped. `runOfapiCreditReconciliation` (`:250`) seeds the cursor on first run, then
writes adjustment rows + advances the cursor in one transaction; `external` rows carry
`details.fromOccurredAt`/`fromBalance`/`toBalance` for later pro-rating.

### 7.5 Burn monitor (D6) & balance ping

`runOfapiCreditBurnMonitor` (`ofapi-credits.ts:341`) sums trailing-60-minute spend
(`sumOfapiCreditsSpentBetween`, all sources except refill) against the live-editable
`ofapiBurnAlertCreditsPerHour` (default `DEFAULT_BURN_ALERT_CREDITS_PER_HOUR = 300`) and raises /
resolves an `ofapi_burn_rate` incident through the notification-incident machinery
(`notifyOfapiGlobalIncident`/`resolveOfapiGlobalIncident`). `runOfapiBalancePing` (`:390`, config
`ofapiBalancePingEnabled`, default off) makes one 1-credit request to anchor reconciliation on idle
days — a minimal chats page on the first mapped OnlyFans page (`app.ofapi.pingBalance`), falling back
to `listAccounts` (GET /accounts carries no `_meta`).

### 7.6 Queues & schedules

Three pg-boss queues (`ensureOfapiCreditQueues`, policy `exclusive`, `ofapi-credits.ts:412`),
scheduled (`ensureOfapiCreditSchedules`, `:423`, worker registration `startOfapiCreditWorker`, `:438`,
wired from `apps/runtime/src/worker-services.ts:145`,`181`):

| Queue constant | Cron (UTC) | Runs |
| --- | --- | --- |
| `ofapi.credits.balance-ping` | `5 0 * * *` (00:05) | `runOfapiBalancePing` |
| `ofapi.credits.accrual` | `40 0 * * *` (00:40) | `runOfapiWebhookAccrual` |
| `ofapi.credits.reconcile` | `5 * * * *` (hourly :05) | `runOfapiCreditReconciliation` |

The burn monitor runs from the minutely OFAPI sweep (not one of these three queues).

---

## 8. OFAPI credits read models (`apps/runtime/src/services/ofapi-credit-report.ts`)

Pure read models for the owner-only `/ofapi-credits` dashboard page and a chatter-scoped summary. No
OFAPI requests are made here — everything derives from `ofapi_credit_ledger`/`ofapi_credit_state` +
incidents.

| Service fn | Endpoint (`api/server.ts`) | Shape |
| --- | --- | --- |
| `getOfapiCreditsSummary` :206 | `GET /api/v1/admin/ofapi/credits/summary` :1649 | balance, today spend `bySource`, per-stream budgets, floor, runway forecast, incidents, reconciliation, accrual, recent-burn drivers, pricing |
| `getOfapiCreditsDaily` :423 | `GET /api/v1/admin/ofapi/credits/daily` :1658 | dense daily series `bySource`, balance points, refills, by-operation/by-page (with per-page creator-net revenue overlay) |
| `getOfapiCreditsLedger` :499 | `GET /api/v1/admin/ofapi/credits/ledger` :1667 | filtered ledger rows + page options |
| `getOfapiCreditsLedgerCsv` :587 | `GET /api/v1/admin/ofapi/credits/ledger.csv` :1676 | RFC-4180 CSV, hard-capped `OFAPI_LEDGER_CSV_MAX_ROWS = 50_000`, truncation surfaced |
| `getChatterOfapiCreditsSummary` :160 | `GET /api/v1/ofapi/credits/summary` :1575 | page-scoped REST+estimated-webhook credits only; owner-only figures omitted |

`estimateOfapiRunway` (`:100`): average daily spend = trailing-7-day net spend ÷ *observed* days
(span from first spend row to now, floored at 1, capped at 7); `daysLeft = floor(balance /
avgDailySpend)`. `summarizeOfapiSpendWindowBetween` (`ofapi.ts:1403`) computes net spend (refills
excluded, `external` drift rows pro-rated by window overlap, audit P-33) **and** the earliest effective
spend start in one query. Budgets mirror the executor guards exactly: the DM ceiling compares against
the global `spent_credits` counter; the audience ceiling uses `audience_spent_credits` when the ledger
is on, else the global (`resolveBudget`, `:286`). The credit **floor** (config `ofapiCreditFloor`,
default 500) blocks streams via `isOfapiCreditFloorBlocking` (`sync/ofapi-dm-sync.ts`), unless the
observation has gone stale (audit F7). `refillRecommendation` sizes for `REFILL_TARGET_DAYS = 30` above
the floor. The by-page revenue overlay uses `getRevenuePageTotalsForExactPeriod`
(`reporting.ts:264`) so credit cost aligns 1:1 (same raw-UTC `[from,to)` boundary) with what each page
earned (creator-net).

---

## 9. The spend-projection shadow & transaction-truth ingest

Three independently-flagged stages turn OFAPI webhook events into (a) a **shadow** projection, then
(b) canonical `transactions`, and (c) a read-only **comparison** against transaction truth.

### 9.1 Shadow projection (flag `ofapiSpendProjectionShadowEnabled`, default off)

`ofapi-spend-projection.ts` projects three webhook event types (`OFAPI_SPEND_PROJECTION_EVENT_TYPES`,
`:35`): `transactions.new`, `messages.ppv.unlocked`, `tips.received`. Driven either by the settle path
(`runOfapiSpendProjectionForSettledRow`, called from `services/ofapi-events.ts:107`) or the minutely
sweep (`sweepOfapiSpendProjections`, `:312`, called from `ofapi-events.ts:481`, limit 200). Each row is
mapped by `mapOfapiWebhookToSpendProjectionEvent` (`ofapi-spend-projection-contract.ts:288`):

- `transactions.new` → `projectable` `CoreSpendProjectionEvent` with category
  (`mapTransactionCategory`), status (`mapOfapiTransactionStatusForSpendProjection` →
  `settled`|`reversed`|`pending`), gross/net from `dollarsToMills`; requires transactionId, fanId,
  occurredAt, `currency === "USD"`.
- `messages.ppv.unlocked` → `projectable` but `status:"estimated"`, gross **estimated** from a `$AMOUNT`
  token in `replacePairs`/`text` (`ppvEstimatedAmountMills`, `:101`), net null.
- `tips.received` → **`blocked`** with reason `tips_received_live_fixture_required` (`:10`) — never
  projected until a verified live fixture exists.

Results are upserted into **`ofapi_spend_projection_events`** (`schema.ts:2057`, unique on
`domain_key`) with `projectionStatus` `projected`|`blocked`|`skipped`
(`upsertOfapiSpendProjectionEvent`, `ofapi.ts:374`). Domain keys are deterministic per
(account, transactionId+status / ppv notificationId+fan / tipId). A `reversed` transaction gets a
distinct `…:tx-reversal:<id>:reversal` key so a reversal and its original coexist
(`ofapiSpendProjectionTransactionId`/`…DomainKey`, contract `:164`,`:171`).

### 9.2 Truth ingest (flag `ofapiSpendTransactionIngestEnabled`, default off)

When enabled, after projecting, `applyOfapiSpendProjectionTransactions`
(`ofapi-spend-transaction-ingest.ts:104`) selects candidates via
`listMissingOfapiSpendProjectionTransactionsForTruthIngest` (`ofapi.ts:469`) — `transactions.new`
`projected` rows with all required fields **that have no matching `transactions` row** (a `NOT EXISTS`
that matches on page, transactionId, sender, mapped state, rawStatus, canonicalType, and signed
amounts). Rows are grouped by page and applied under `withOfapiSpendTransactionPageLock`, upserting
fans/fan-pages then `upsertTransaction` with `rawType = "ofapi:<category>"`, canonicalType via
`mapOfapiSpendCategoryToTransactionType` (reversed → `refund`, `ofapi-spend-transaction-mapping.ts:10`),
state via `mapOfapiSpendStatusToTransactionState`, and amounts negated for reversals
(`normalizeOfapiSpendAmountMills`, `:40`). Then `rebuildSpenderProjections` + `rebuildRevenueRollups`
from the earliest touched `occurredAt`. OFAPI emits `loading/pending` even for settled spend, so
pending rows enter truth as pending and are re-selected when a later terminal projection arrives
(`ofapi.ts:462` comment).

### 9.3 Comparison (read-only, `ofapi-spend-comparison.ts`)

`getOfapiSpendComparison` (`:75`) — `GET /api/v1/admin/ofapi/spend/comparison` (`server.ts:1707`).
Over a trailing `days` window (default 7) it left-joins `ofapi_spend_projection_events` against
`transactions` truth and classifies each into an `OfapiSpendProjectionComparisonStatus`
(`OFAPI_SPEND_COMPARISON_STATUS_SQL`, `ofapi.ts:636`): `matched`, `missing_in_core_truth`,
`page_mismatch`, `amount_mismatch`, `fan_mismatch`, `state_mismatch`, `ppv_estimated`, `tips_blocked`,
`blocked`, `skipped`, `other`. Returns per-status and per-page aggregates + non-matched samples.
Explicit `limitations`: read-only (writes nothing), PPV rows are estimates not settled revenue, tips
stay blocked, and the desktop spend sweep must keep its old cadence until production comparison matches.

### 9.4 (Fixture note)

`domainKeyFor`/`writeBlockedTipsEvent` handle the blocked-tips path (`ofapi-spend-projection.ts:74`,
`:156`), storing a `blocked` row with `blockedReason` and a parsed `createdAt` occurredAt.

### 9.5 REST transaction backfill (`ofapi-transactions-backfill.ts`, CLI)

`runOfapiTransactionsBackfill` (`:755`) is invoked only from the CLI command
`ofapi-transactions-backfill` (`apps/runtime/src/cli.ts:963`) — `--page`, `--from`, `--to`, `--limit`,
`--write`. It paginates `app.ofapi.listTransactions` for OFAPI-only OnlyFans pages, normalizes rows
(`normalizeRestTransaction`, `:204`) into the **same shape** as §9.2, and in `write` mode (gated by the
*same* `ofapiSpendTransactionIngestEnabled` master switch, `:770`) upserts under the page lock with a
terminal-state-wins guard (`loadPostedTransactionIds`, `:348`) so a stale REST `pending` never demotes
a webhook-settled row. In `dry-run` it only reports (`overlap` against
`ofapi_spend_projection_events`, month histograms, type/status histograms, pagination stop reason).
The paginated walk has an ascending-order early-stop (only trusted after positively observing
ascending order, `:453`) and a hard `OFAPI_TRANSACTION_BACKFILL_MAX_PAGES = 1000` cap so it can never
page — and pay credits — through unbounded history. Eligibility (`loadWriteEligibility`, `:371`) blocks
non-OnlyFans pages, pages missing `ofapiAccountId`, pages **with** stored page credentials, or pages
with active non-OFAPI transactions in-window.

---

## Boundaries catalog

### Inbound HTTP (all under `apps/runtime/src/api/server.ts`; contracts in `packages/contracts/src/routes.ts`)

| Method + path | Handler | Data crossing (out) |
| --- | --- | --- |
| `GET /api/v2/spenders` | `getSpenderList` | ranked spenders: fan identity, window/lifetime gross+net (mills→number), state splits, comparison delta, retention, conversation, last transaction, diagnostics |
| `GET /api/v2/spenders/:platform/:platformUserId` | `getSpenderDetail` | one fan's window/lifetime metrics, type breakdown, per-page memberships (subscription/follower flags) |
| `GET /api/v2/spenders/:platform/:platformUserId/series` | `getSpenderSeries` | day/week/month-bucketed spend series |
| `POST /api/v2/spenders:batch` | `getSpenderBatch` | batched per-fan metrics for a fan list |
| `GET /api/v2/fans/search` | `searchVisibleFans` | fan search results + page memberships |
| `GET /api/v1/pages/:pageLabel/spender-autolists[/:bucketKey]` | `getPageSpenderAutoLists[Detail]` | bucket counts / bucketed fan lists (lifetime or window gross) |
| `GET /api/v1/overview/revenue`, `/models/:slug/revenue`, `/pages/:label/revenue` | reporting revenue fns | creator-net revenue windows + comparison + per-type breakdown |
| `GET /api/v1/pages/:pageLabel/transactions` | `getPageTransactionsReport` | raw transaction rows (gross/net/state/type/fan) |
| `GET /api/v1/ofapi/credits/summary` | `getChatterOfapiCreditsSummary` | page-scoped REST + estimated-webhook credits |
| `GET /api/v1/admin/ofapi/credits/summary` | `getOfapiCreditsSummary` | owner credit balance, spend-by-source, budgets, runway, incidents, reconciliation, burn drivers, pricing |
| `GET /api/v1/admin/ofapi/credits/daily` | `getOfapiCreditsDaily` | daily spend series, balance points, refills, by-op/by-page + revenue overlay |
| `GET /api/v1/admin/ofapi/credits/ledger[.csv]` | `getOfapiCreditsLedger[Csv]` | filtered ledger rows / CSV export (≤50k rows) |
| `GET /api/v1/admin/ofapi/spend/comparison` | `getOfapiSpendComparison` | projection-vs-truth status/page aggregates + non-matched samples |

### Inbound webhooks (upstream of this territory)

OFAPI webhook deliveries land in `ofapi_webhook_events` (territory 07). This territory *reads* that
journal: `countOfapiWebhookEventsReceivedBetween` (webhook accrual basis) and
`listOfapiWebhookEventsForSpendProjection` (shadow projection input). Fields consumed:
`event_type`, `payload` (OFAPI envelope: `transactions.new` `{id,fan.id,amount,net_amount,currency,
status,type,created_at}`; `messages.ppv.unlocked` `{id, notification chat/fan, text/replacePairs}`;
`tips.received` — blocked), `ofapi_account_id`, `platform_account_id`, `fanout_seq`, `status`,
`received_at`.

### Outbound HTTP to OFAPI (territory 07 client)

- `app.ofapi.listTransactions(requestContext, ofapiAccountId, {limit,startDate,marker,pageIndex})` —
  REST transaction backfill (`ofapi-transactions-backfill.ts:462`). **Costs OFAPI credits.**
- `app.ofapi.pingBalance({pageId}, ofapiAccountId)` / `app.ofapi.listAccounts()` — balance ping
  (`ofapi-credits.ts:403`,`405`). 1 credit.
- Every OFAPI response (any operation) flows back through `createOfapiCreditSpendSink` → ledger write.

### Database writes

| Table | Written by |
| --- | --- |
| `transactions` | `upsertTransaction` from Fansly sync, OnlyFans sync, OFAPI projection ingest, OFAPI REST backfill; `retireTransactionsMissingFromWindow` / `markTransactionsScanToken` |
| `revenue_daily` | `rebuildRevenueRollups` |
| `fan_spend_daily` | `rebuildSpenderDailyFacts` |
| `fan_spend_lifetime` + `page_fans.total_creator_net_mills` | `rebuildSpenderLifetimePage` |
| `spender_projection_watermarks` | `upsertSpenderProjectionWatermark` |
| `page_fan_identities` (top spenders) | `upsertPageTopSpenders` (OnlyFans: from `transactions`) |
| `ofapi_credit_ledger` | sink (`rest`), accrual (`webhook_accrual`), reconciliation (`external`/`refill`), manual (`adjustment`) |
| `ofapi_credit_state` | `recordOfapiCreditUsage`, `reserveOfapiDayCredits`, `settleOfapiDayCreditReservation`, `setOfapiCreditReconcileCursor` |
| `ofapi_spend_projection_events` | `upsertOfapiSpendProjectionEvent` (projected/blocked/skipped) |

### Database reads (financial truth)

Spender/reporting read `transactions`, `revenue_daily`, `fan_spend_daily`, `fan_spend_lifetime`,
`page_subscriptions`, `page_follows`, `daily_followers`, `daily_subscribers`, `page_dm_conversations`,
`fans`/`fan_pages`/`page_fan_aliases`/`fan_username_aliases`, `pages`/`models`. Credit read models
read `ofapi_credit_ledger`, `ofapi_credit_state`, `ofapi_webhook_events`, `notification_incidents`,
plus `transactions` (revenue overlay).

### pg-boss queue jobs

`ofapi.credits.balance-ping` (00:05 UTC), `ofapi.credits.accrual` (00:40 UTC),
`ofapi.credits.reconcile` (hourly :05) — see §7.6. The credit **burn monitor**, the **spend-projection
sweep**, and the **top_spenders** stream run from other sweeps/executors (territory 06/07), not from
this territory's queues.

### Secrets / credentials

This territory does not read platform credentials directly, but the REST backfill's write-eligibility
gate treats the **presence** of stored `page_credentials` as a block (OFAPI-only pages must have no
first-party creds, `ofapi-transactions-backfill.ts:404`). It resolves a page's stored **proxy**
(`resolveStoredProxyConfig`/`resolveStoredProxyEgressKey`) to dispatch OFAPI requests through the
correct egress.

### Telegram / notifications

The burn monitor raises/clears an `ofapi_burn_rate` incident via `notifyOfapiGlobalIncident` /
`resolveOfapiGlobalIncident` (`ofapi-credits.ts:354`,`366`,`373`) — the notification-incident machinery
that fans out to Telegram (territory 12). The credits summary surfaces open `ofapi_*` incidents.

---

## Cross-references

- **Territory 04/05 (schema/tables):** `transactions`, `revenue_daily`, `fan_spend_daily`,
  `fan_spend_lifetime`, `page_fan_identities`, `spender_projection_watermarks`, `ofapi_credit_ledger`,
  `ofapi_credit_state`, `ofapi_spend_projection_events`, `ofapi_webhook_events`.
- **Territory 06 (sync):** the Fansly/OnlyFans adapters, checkpoint/lease/chunk-budget machinery, the
  `top_spenders` executor handler, and the Fansly provider top-spenders stream all feed the
  `transactions`/aggregates this territory reports on.
- **Territory 07 (OFAPI):** the OFAPI client + credit-spend sink observations, the webhook journal and
  settle/fanout pipeline (source of projection input and accrual counts), and OFAPI auth/mapping.
- **Territory 12 (Telegram reports):** consumes revenue/spend rollups and the `ofapi_burn_rate`
  incident notifications.
