> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 13 — Financial and Money

This map covers the money model as implemented and the finance serving layer of the kernel: the single money codec in `packages/shared/src/money.ts` (its two currency units, branded types, source-named constructors, converters, and commission math), the float-budget ratchet that pins bare-number arithmetic, the `modules/finance` route catalog and its revenue/transaction/spender endpoints, the transactions truth path and the reporting service that backs it, and the spenders service. Money handled here is **platform money** (fan payments). The OFAPI "credits" currency (the client's prepaid AI-serving balance) is a separate, unrelated unit and is documented in `09-ofapi-boundary.md`.

## 1. The money codec (`packages/shared/src/money.ts`)

The header (`money.ts:1-7`) states the doctrine directly. There are two currency units and they never share a representation:

- **Platform money = MILLS** — `bigint`, one mill = 1/1000 USD, Fansly-native on the wire (decision #15). Branded type `Mills` (`money.ts:10`), with `MillsLike = bigint | number | string` (`money.ts:15`) covering the shapes a Postgres driver hands back.
- **AI-plane money = MICRO-USD** — `number` (integer column), one micro-USD = 1/1,000,000 USD. Branded type `MicroUsd` (`money.ts:12`).

The brands are compile-time only (`money.ts:10-12`) — phantom `__unit` fields with zero runtime cost and no change to stored values. The design intent stated in the header is that the "1000× footgun" dies by construction: every constructor names its SOURCE unit, there is no bare-number entry path, and the two units mix only through the two explicit converters below. The legacy `toMills` constructor was deleted at Stage 27; the money ratchet (§2) pins that it never returns.

### Source-named constructors

| Function | Anchor | Behavior |
|---|---|---|
| `millsFromInteger(value: MillsLike)` | `money.ts:29` | Value that is ALREADY mills: a DB column read or a mills-native platform integer. `bigint` passes through; `number` is truncated via `Math.trunc` then `BigInt`; `string` parsed as an integer via `BigInt`. Byte-identical to the deleted `toMills`. |
| `millsFromDollars(value: number \| string)` | `money.ts:43` | Dollars → mills. Numbers are `toFixed(3)`; strings trimmed. Fixed 3-place truncation of the fraction (`padEnd(3,"0").slice(0,3)`), sign-aware. Throws on unparseable input. |
| `millsFromCents(value: number \| bigint)` | `money.ts:61` | Whole cents → mills, `× 10` exactly (the `total_tip_amount_cents` bridge). |
| `microUsdFromDollars(value: number)` | `money.ts:67` | Dollars → micro-USD, `× 1_000_000` rounded to nearest integer. Throws on non-finite input. |
| `microUsdFromDbInt(value: number)` | `money.ts:75` | Integer micro-USD as stored (`Math.trunc`). |

### Unit converters (the only sanctioned mixing points)

| Function | Anchor | Behavior |
|---|---|---|
| `millsToMicroUsd(value: Mills)` | `money.ts:82` | Mills → micro-USD, exact `× 1000`. |
| `microUsdToMills(value: MicroUsd)` | `money.ts:87` | Micro-USD → mills, **LOSSY** — truncates toward zero below the mill (`Math.trunc(value / 1000)`). |

### Display, aggregation, and legacy alias

| Function | Anchor | Behavior |
|---|---|---|
| `millsToDecimalString(value: MillsLike)` | `money.ts:93` | Mills → `"whole.fraction"` decimal string, 3-place, sign-aware. |
| `formatUsdFromMills(...)` | `money.ts:103` | `Intl` currency formatting from mills. |
| `millsToNumber(...)` | `money.ts:115` | Mills → JS `number` (the wire form emitted by finance handlers). |
| `millsToDollarsNumber(...)` | `money.ts:120` | Mills → dollars as JS `number`. |
| `millsToRoundedDollars(...)` | `money.ts:125` | Mills → rounded whole dollars. |
| `sumMills(...)` | `money.ts:129` | bigint sum over an iterable of mills. |
| `dollarsToMills` | `money.ts:142` | Legacy alias of `millsFromDollars`. |

### Commission math (over mills)

Commission is computed entirely in bigint mills against `COMMISSION_RATE_SCALE = 10_000n` (`money.ts:17`).

| Function | Anchor | Behavior |
|---|---|---|
| `calculateNetMillsFromGross(...)` | `money.ts:170` | Gross → net; the OnlyFans platform fee is rounded to whole cents before subtraction (`money.ts:181`). |
| `calculateGrossMillsFromNet(...)` | `money.ts:185` | Net → gross (inverse). |

## 2. The money-float ratchet (budget 9)

Bare-number money arithmetic outside the codec is capped by a ratchet.

- **Budget file:** `scripts/money-float-budget.json` — `"budget": 9` (`:3`). The comment names the first burn-down target: the `ofapi-dm-sync.ts` dollars→cents write.
- **Enforcement is a test, not a standalone script.** `tests/money-ratchet.test.ts:16-48` greps `Math\.round\(.*(1000|Price|Amount|Mills)` across `apps/runtime/src`, `apps/dashboard/src`, and `packages`, then asserts the match count is `≤ budget`. A second test (`tests/money-ratchet.test.ts:50-67`) asserts that the deleted `toMills(` never returns anywhere.
- **Direction:** the budget may only decrease; a decrease edits the JSON.
- **Sibling ratchets** (same pattern, unrelated numbers): `scripts/raw-fetch-budget.json` (13) and `scripts/platform-branch-budget.json` (49).

## 3. The finance module (`apps/runtime/src/modules/finance/index.ts`, 700 lines)

The header (`finance/index.ts:57-61`) declares this the canonical money module — transactions, revenue, spend rollups, reporting, spender views — with handlers relocated verbatim from `server.ts` at Stage 19 Task 3. The four Stage 2 revenue routes keep their `enforceRevenueRouteRoleScope` guards until the post-enforce-flip cleanup. `registerFinanceRoutes` (`finance/index.ts:70`) mounts the catalog below.

All revenue math is summed in bigint mills, then emitted onto the wire as JS numbers via `millsToNumber`. Revenue is bucketed as revenue / adjustment / unclassified with `netEarningsMills` totals (`finance/index.ts:225-260`), and the delta-percentage is computed in bigint (`finance/index.ts:263-266`). DB reads go through `@agency_hub_core/db` (`getRevenueBreakdownForScope`, `getRevenuePageTotals`, `listRevenueDailyForPages`, `listFanTransactions*`). Aggregate report builders come from `services/reporting.ts` (§5).

| Route | Anchor | Notes |
|---|---|---|
| `GET /api/v1/overview/revenue` | `:74` | Overview revenue, page-scoped by principal. |
| `GET /api/v1/models/:modelSlug/revenue` | `:87` | Per-model revenue. |
| `GET /api/v1/pages/:pageLabel/revenue` | `:100` | Per-page revenue; `enforceRevenueRouteRoleScope`. |
| `GET /api/v1/pages/:pageLabel/transactions` | `:116` | Per-page transactions list; role-scope enforced. |
| `GET /api/v1/pages/:pageLabel/spender-autolists` | `:135` | Bucketed spender auto-lists for a page. |
| `GET /api/v1/pages/:pageLabel/spender-autolists/:bucketKey` | `:146` | One auto-list bucket's detail. |
| `GET /api/v2/spenders` | `:162` | Ranked spender list. |
| `GET /api/v2/spenders/:platform/:platformUserId` | `:169` | Spender detail. |
| `GET /api/v2/spenders/:platform/:platformUserId/series` | `:176` (within `:162-189`) | Spender time series. |
| `POST /api/v2/spenders:batch` | within `:162-189` | Batch spender lookup. |
| `GET /api/v1/overview` | `:192-375` | The big dashboard aggregate. |
| `GET /api/v1/overview/revenue/daily`, `…/pages/…/revenue/daily`, `…/models/…/revenue/daily` | `:484-568` | Revenue-daily series. |
| `GET /api/v1/overview/revenue/by-model` | within `:484-568` | Revenue split by model. |
| `GET /api/v1/transactions` | `:571` | Cross-page transaction walk. |
| `GET /api/v1/pages/:pageLabel/fans/:userId/transactions` | `:618` | Per-fan transaction walk on a page. |
| `GET /api/v1/fans/:platform/:userId/transactions` | `:658` | Per-fan transaction walk across pages. |

**Ledger surface:** finance exposes the per-fan transaction walk (on-page and cross-page). It does NOT serve a `fan_earnings` snapshot — the top-spenders snapshot projection lives in the `audience` module (`GET /pages/:label/top-spenders`), described in the audience section of the module map.

## 4. The transactions truth path

Transactions converge into a canonical row and then feed rebuildable revenue rollups:

- `upsertTransaction` performs idempotent convergence of a transaction fact into its canonical row.
- `rebuildRevenueRollups` recomputes the revenue rollups downstream of those rows (projections are rebuildable; the underlying facts are not).

The reporting service (`services/reporting.ts`, §5) reads across this truth path to produce the finance module's aggregate reports.

## 5. The reporting service (`apps/runtime/src/services/reporting.ts`)

`reporting.ts` (exports at `:430-1081`) is the revenue/growth/fan report-builder layer backing both the finance and audience modules. The finance routes call, among others:

- `getOverviewRevenueReport`, `getModelRevenueReport`, `getPageRevenueReport` — the revenue aggregates behind the `…/revenue` routes.
- `getPageTransactionsReport` — the per-page transactions list.
- `getPageSummary` / `list{Page,Model}Summaries` — page/model metadata used for access checks and rollups.
- `getFanSpendSummary` (`:1081`) — per-fan spend via `getFanSpendByIdentifier`.

(Its growth/fan builders — `getPage{Subscribers,Followers}[Daily]Report`, `getPageFansReport`, `getPageDeletedFansReport`, `get{Page,CrossPage}FanDetailReport`, `getOverviewGrowthReport` — back the audience module and are catalogued there.)

## 6. The spenders service (`apps/runtime/src/services/spenders.ts`)

`spenders.ts` (≈41.5 KB) is the spender projection/query service, importing the Stage 16 spender projection and the retention codec from `@agency_hub_core/shared`. Every query is scoped by page access (`canAccessPage`) and reads projection helpers (`getSpender{Lifetime,Window}Metrics`, `getSpenderProjectionAsOf`, `getSpenderTypeBreakdown[Batch]`, `count/listPageFansBy{Lifetime,Window}GrossBucket`).

| Export | Anchor | Purpose |
|---|---|---|
| `getPageSpenderAutoLists` | `spenders.ts:444` | The Fansly `[FB] $X-$Y` bucketed lists, from `SPENDER_AUTO_LIST_BUCKETS`. |
| `getPageSpenderAutoListDetail` | `spenders.ts:502` | One auto-list bucket's members. |
| `getSpenderList` | `spenders.ts:741` | Ranked spenders (`listRankedSpenders`) with sort/window/retention filters. |
| `getSpenderDetail` | `spenders.ts:847` | Lifetime + window metrics, type breakdown, scoped totals for one spender. |
| `getSpenderSeries` | `spenders.ts:972` | Daily/weekly/monthly series (granularity via `resolveAutoSpenderSeriesGranularity`). |
| `getSpenderBatch` | `spenders.ts:1050` | Batch type-breakdown lookup. |
| `searchVisibleFans` | `spenders.ts:1208` | Fan search within the caller's page scope. |

## 7. Not covered here: OFAPI credits

The OFAPI "credits" currency — the client's prepaid balance for AI serving — is a distinct unit with no relation to fan/platform money and does not flow through the money codec above. It is documented in `09-ofapi-boundary.md` (and surfaces through `ops/index.ts` credits summary/ledger routes, not the finance module).
