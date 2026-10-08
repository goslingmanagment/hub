# Fansly creator statistics — EARNINGS tab (`/creator/stats/earnings`)

Static reading only (pretty-printed public bundles, no code executed, no network requests).
Everything not provable from the code is marked **UNRESOLVED** or *(inferred)*.

File refs (all under `analysis/`):

| short | file |
|---|---|
| `729:N` | `729.d14b4c5910bebc74.pretty.js` (lazy stats chunk, webpack module 8729) |
| `main:N` | `main.2e6b96097a4bb73b.pretty.js` |
| `381:N` | `381.3db514b57dd6c2e7.pretty.js` (shared: CSV helper 895, `app-stats-card` 6818, `app-creator-wallet-transaction-history` 376, tx describer 10) |
| `189:N` | `189.f9d360b81f0ae194.pretty.js` (wallet routes, cross-reference only) |

Base URL `https://apiv3.fansly.com/api/v1` (`main:37841`). Envelope of every call: `{ success: bool, response: <payload>, error?: { details } }` (`main:26961-26965`, `main:37514-37518`).
All money is **mills** (`$0.001`); all buckets are **ms epoch, UTC**; `DAY = 86400000`, `HOUR = 3600000` (`729:1651`).

Component: `app-creator-stats-earnings-route` (`729:1652-1888`), route `earnings` (`729:2118`), hosted in shell `app-creator-stats-route` (`729:2060-2118`).
Injected: `creatorStatsService_` = facade `po` of module 804 (`main:27010-27294`), `walletService_` = module 2659 `F` (`main:37608-37761`), `modalService_`.

---

## 0. Shared state: period window and how params are derived

Facade (`main:27012-27102`):

- `periodDays_` default `30`; `overwriteAccountId_` default `""` (`main:27014`).
- `window_ = trackingLinkService_.buildGrowthWindow(periodDays_)` (`main:36914-36917`, `main:37017-37024`):
  - `T = Date.UTC(now.utcY, now.utcM, now.utcD)` (today, UTC midnight)
  - `currentStart = T - (days-1)*DAY`, `currentEnd = T`, `days = round((end-start)/DAY)+1`
  - also `previousEnd = currentStart - DAY`, `previousStart = previousEnd - (days-1)*DAY`, `splitAt`, `spanBefore = T + DAY`, `spanAfter` (not sent by the stats API).
- Custom range → `buildGrowthWindowForRange(from, to)` (`main:36918-36925`, `main:37025-37028`): each timestamp is converted **local calendar date → `Date.UTC(y,m,d)`**, swapped if reversed, end clamped to today (UTC).
- `getWindow()` rebuilds the window when the UTC day rolled over (`main:27022-27029`).
- `granularityForWindow(w)` = `w.days > 400 ? "month" : "day"` (`main:27106-27108`). The Earnings route stores it as `isMonthly` (`729:1796`).
- Every stats request passes `after = window.currentStart`, `before = window.currentEnd` (`main:27065`, `27068`, `27097`).
- `get_(path, params)` (`main:26954-26966`): query string built in **object key order**, each value `encodeURIComponent(String(v))`; keys whose value is `null`/`undefined`/`""` are omitted (`0` is NOT omitted). So `overwriteAccountId` is absent unless set.
- `overwriteAccountId` comes from the page's own query string `?overwriteAccountId=` (`729:2094-2095`), reset to `""` on shell destroy (`729:2104`).

Shell controls that drive the Earnings tab (`729:2109-2116`, selector module 5351 `main:20694-20737`):

| control | label / stringId | effect |
|---|---|---|
| period segmented | `"7 days"`, `"30 days"`, `"90 days"` — stringId `fansly_profile_stats_overview_period_{7,30,90}`; options `Z2 = [7, 30, 90]` (`main:27009`) | `setPeriod(n)` → `onWindowChange` → `load()` |
| `Custom` | `fansly_profile_stats_overview_period_custom`; two date pickers `"Start date"` (`fansly_creator_stats_range_start`), `"End date"` (`fansly_creator_stats_range_end`); default start `now − 2505600000 ms` (29 d) | `setRange({from,to})` → `onWindowChange` → `load()` |
| caption | `"{start MMM d, y} – {end MMM d}"` + `"vs"` (`fansly_profile_stats_overview_vs`) `"{previousStart} – {previousEnd}"`, all formatted in UTC | — |
| refresh button (aria `Refresh`) | — | `creatorStatsService_.refresh()` → `onWindowChange` + `onRefresh` (`main:27052-27054`) |
| auto refresh | — | when the document was hidden ≥ 300000 ms and becomes visible (`729:2084-2088`) |

No `Lifetime` button in the shell (`allowLifetime` not bound → false; it exists only in the fan modal). No polling interval on the Earnings tab.

Lifecycle (`729:1866-1873`):

- `ngOnInit`: `showPurchases = !getOverwriteAccountId()`; then `load()`, `loadStatements()`, `loadWallet()`.
- `onWindowChange` → `load()` only (period-dependent widgets).
- `onRefresh` → `loadStatements()`, `loadWallet()`, `purchases_.reload()` (period-independent widgets).

---

## 1. Widgets in on-screen order

Template: `729:1885-1886` (root), `729:1625-1650` (main block `gi`), consts `729:1885`.

| # | widget / selector | default label(s) → stringId | controls | data source |
|---|---|---|---|---|
| 1 | Wallet strip `div.wallet-strip` | `Available for Payout` → `fansly_routes_earnings_available`; `Pending balance` → `fansly_routes_earnings_pending` (hint `title`: "Funds are pending for 7 days from the day they are received and unlocked on a rolling base."); `Total balance` → `fansly_routes_earnings_total_balance` | link button `Request Payout` → `fansly_routes_earnings_request` (`routerLink /creator/wallet/payouts`); link `Wallet, payout methods and payout history` → `fansly_creator_stats_wallet_link` (`/creator/wallet/history`) | §2.1 |
| 2 | Glance row `div.glance-row` | `Today` → `fansly_creator_stats_glance_today`; `Yesterday` → `fansly_creator_stats_glance_yesterday`; `This month` → `fansly_creator_stats_glance_month`; `All time` → `fansly_creator_stats_glance_all_time`; note `fansly_creator_stats_glance_note_local` (when hourly data loaded) or `fansly_creator_stats_glance_note` (UTC fallback) — full texts at `729:1523`, `729:1526` | none (period-independent) | §2.3–2.4 |
| 3 | `app-stats-card` "Recent purchases" → `fansly_creator_stats_recent_purchases_title`; desc "Your last five sales as they reached your wallet, whatever the period above." → `fansly_creator_stats_recent_purchases_desc`; contains `app-creator-wallet-transaction-history [limit]=5 [showActions]=false`. **Rendered only when `overwriteAccountId` is empty** (`729:1872`, `729:1886`) | link `View all` → `fansly_creator_stats_view_all` (`/creator/wallet/history`) | no pager, no refund button, no export | §2.2 |
| — | state: error `Statistics could not be loaded right now.` → `fansly_creator_stats_error`; skeleton tiles while first summary loads | | | |
| 4 | Tile grid (4 × `app-growth-stat-tile`) | `Earnings` → `fansly_creator_stats_tile_earnings` (sparkline); `Gross` → `fansly_creator_stats_tile_gross` (sparkline); `Purchases` → `fansly_creator_stats_tile_transactions`; `Paying fans` → `fansly_creator_stats_tile_paying_fans` | footer "vs previous {window.days} days" (`fansly_profile_stats_overview_vs_previous` / `_days`), or "No data in the previous period" (`fansly_profile_stats_overview_no_previous`) | §2.5 |
| 5 | Compact tile grid | `Subscription earnings` → `fansly_creator_stats_tile_subscription_earnings`; `New paying fans` → `fansly_creator_stats_tile_new_paying_fans`; `Avg. per paying fan` → `fansly_creator_stats_tile_avg_per_fan`; `Avg. per purchase` → `fansly_creator_stats_tile_avg_per_purchase`; **only if `hasRefunds`**: `Net before refunds` → `fansly_creator_stats_tile_net_before_refunds`; `Refunded` → `fansly_creator_stats_tile_refunded`; `Refunds` → `fansly_creator_stats_tile_refunds`; `Refund rate` → `fansly_creator_stats_tile_refund_rate` | — | §2.5 |
| 6 | `app-stats-card` "Monthly statements" → `fansly_creator_stats_statements_title`; desc → `fansly_creator_stats_statements_desc_earnings` ("Whole calendar months, newest first, whatever the period above. The running month compares with the same days of the month before. View a month to make it the period; the charts below then show it day by day.") | button `Download CSV` → `fansly_creator_stats_products_csv` (→ `downloadStatementsCsv()`), styled disabled when no statements; baseline box "Last 30 days" → `fansly_creator_stats_baseline_title`; list `app-stats-statements` with row action `View month` → `fansly_creator_stats_statements_view_month`; `Show more` → `fansly_creator_stats_show_more` | shows 6 months, each "Show more" adds 12 (`main:20494`, `20508-20510`); row click = `openStatement` | §2.3, §5 |
| 7 | `app-stats-card` "Revenue" → `fansly_creator_stats_earnings_chart_title`; desc "What fans paid and what you earned, per day." → `fansly_creator_stats_earnings_chart_desc` / "…per month." → `…_chart_desc_monthly`; `app-stats-line-chart` | series legend: `Gross` → `fansly_creator_stats_series_gross`, `Earnings` → `fansly_creator_stats_series_earnings`, `Refunded` → `fansly_creator_stats_series_refunded` (only with refunds) | none | §2.5 (daily) / §2.6 (monthly) |
| 8 | `app-stats-card #productChartCard` "Earnings by product over time" → `fansly_creator_stats_earnings_products_chart_title`; desc "Net per day for each product in the period. Tap a product in the legend to hide or show its line." → `fansly_creator_stats_earnings_products_chart_desc` (/ `_monthly`) | button `Download CSV` → `fansly_creator_stats_products_csv` (→ `downloadCsv()`), styled disabled while `productSeries` is null; legend toggle per product (client-side hide/show only — **the only "type filter" on the tab; no server-side type filter exists**) | | §2.6 |
| 9 | `app-stats-card` "By product" → `fansly_creator_stats_earnings_types_title`; desc → `fansly_creator_stats_earnings_types_desc`; `app-stats-bar-table` columns `Net` → `fansly_creator_stats_label_net`, `Gross` → `fansly_creator_stats_label_gross`, `Change` → `fansly_creator_stats_label_change` | none | §2.5 |
| 10 | `app-stats-card` "Top supporters" → `fansly_creator_stats_top_supporters_title`; desc "Fans ranked by what you earned from them in the period. Tap one for the breakdown." → `fansly_creator_stats_earnings_fans_desc`; `app-stats-segmented` + `app-stats-fan-list [selectable]=true` | sort: `Net` → `fansly_creator_stats_sort_net` (`netMills`), `Gross` → `fansly_creator_stats_sort_gross` (`grossMills`), `Purchases` → `fansly_creator_stats_sort_transactions` (`transactions`) (`729:1656`); row click → fan detail modal. **No "show more"/paging: fixed 25 rows** | | §2.7, §6 |

Fan-list row strings (`729:1382-1418`): `purchase`/`purchases` → `fansly_creator_stats_fan_transaction(s)`; `since` → `fansly_creator_stats_fan_since`; `refund`/`refunds` → `fansly_creator_stats_fan_refund(s)`; empty `No data in this period.` → `fansly_creator_stats_empty`.
Statement row strings (`main:20433-20477`): `so far` → `fansly_creator_stats_statements_so_far`; `Best month` → `…_statements_best`; `2nd best` → `…_second_best`; `3rd best` → `…_third_best`; `Record pace` → `…_record_pace`; `gross` → `…_statements_gross`; empty `No earnings recorded yet.` → `fansly_creator_stats_statements_empty`.
Baseline strings (`729:1569-1604`): `above your usual month` → `fansly_creator_stats_baseline_above`; `below your usual month` → `…_below`; `level with your usual month` → `…_level`; `Would rank` / `of your last` / `months` → `…_rank_prefix` / `…_rank_middle` / `…_rank_suffix`; `Below each of your last` → `…_rank_last`; `Your usual month appears after three full months.` → `…_baseline_pending`.

---

## 2. Call chains and params

Request count on first render of the tab: **7 stats calls + 1 wallet call + 1 transactions call** (the last only without `overwriteAccountId`).

### 2.1 Wallet strip

1. **Pending balance** — `loadWallet()` (`729:1661-1666`) → `walletService_.getEarnings(cb)` (`main:37699-37701`) → API `getEarnings` (`main:37520-37527`)
   `GET /account/wallets/earnings` — **no query params** (no `overwriteAccountId` either: the strip always shows the logged-in account).
   Reads `response.pendingBalance` → `pendingBalance = Number(...) || 0` (mills).
2. **Available for Payout** — `<app-wallet-balance activeAccount="true" [balanceMode]=3 [balanceOnly]=true [balanceConversion]=2>` (`729:1886`). `getBalance()` (`main:22200-22203`): mode 3 = **earnings wallet only** (`walletService_.getEarningsWallet().balance`). No request is made by the tab: wallets are loaded app-wide by `walletService_.loadWallets(accountId)` → `GET /account/{accountId}/wallets` (`main:37496-37503`, callers `main:25980` at session start, `main:61534` when the app becomes visible after > 30 s) and patched by websocket wallet events (`main:37638-37647`). Wallet model fields: `id, accountId, balance, type (1 = main, 2 = earnings), flags, walletVersion, updatedAt` (`main:37473-37476`).
3. **Total balance** — same component with `[balanceAdd]="pendingBalance"` → earnings wallet balance + `pendingBalance`.
   Formatting: `balance` pipe mode 2 (`main:24566-24574`): `balanceToDollars` then thousands separators, cents shown only when non-zero.

### 2.2 Recent purchases (embedded `app-creator-wallet-transaction-history`, `381:186-294`)

- `ngOnInit` (`381:275-282`): `perPage = 5`; pager `new u(idOf = transactionId, pageRows = 5, chunkRows = 5, read_)` (pager class `main:91-135`); `show_(1)` → `ensurePage(1)` → `read_("", 5, cb)`.
- `read_(before, limit)` (`381:266-274`) → `walletService_.getEarningsTransactionHistory(before, "", limit, 0, cb)` (`main:37686-37698`) → API (`main:37512-37519`):
  `GET /account/wallets/earnings/transactions?before=&after=&limit=5&offset=0`
  - `before` = `""` on the first read (pager passes the last held row's `transactionId` for later chunks — never happens here because `limit` hides the pager, `381:183`)
  - `after` = literal `""`; `limit` = `min(100, max(5, 5 − held))` = `5`; `offset` = literal `0`
  - values are concatenated raw — empty params ARE sent (`before=&after=`), unlike the stats API.
- Re-read on shell refresh via `purchases_.reload()` (`729:1871`, `381:195-197`).
- Not embedded here: the pager (hidden when `limit > 0`), the refund action (`showActions=false`), any CSV export.

### 2.3 Monthly statements + glance "This month"/"All time" + baseline — `loadStatements()` (`729:1714-1739`)

All four calls go `creatorStatsService_.getSeriesForRange(family, granularity, after, before, cb)` (`main:27070-27072`) → `api_.getSeries` (`main:26970-26972`):
`GET /account/stats/series?family=…&granularity=…&after=…&before=…[&overwriteAccountId=…]`

`family` is always `M.$t.REVENUE` = **`"revenue"`** (`main:27297`). Let `o = floor(Date.now()/DAY)*DAY` (today 00:00 UTC).

| # | granularity | `after` | `before` | used for |
|---|---|---|---|---|
| A | `"month"` | `s = monthStartOf(Date.now() − Hc*DAY)`; `Hc = ceil((Date.now() at module load − 1561494359539)/DAY)` (`main:27009`) → evaluates to **`1559347200000` (2019-06-01T00:00:00Z)** unless the tab has been open > ~5 days | `o` | `statementRows_` (raw rows), `statements`, glance `This month` / `All time`, baseline months, statements CSV |
| B | `"day"` | `c = monthsBefore(monthStartOf(now), 1)` = previous month start (UTC) | `v = min(c + (utcDayOfMonth − 1)*DAY, currentMonthStart − DAY)` | `monthToDatePreviousMills_` = "same days of last month" |
| C | `"day"` | `o − 29*DAY` | `o` | `baselineMills_` (last 30 days); UTC fallback for glance `Today`/`Yesterday` |
| D | `"hour"` | `o − 3*DAY` | `o` | glance `Today`/`Yesterday` in local time + deltas (§2.4) |

Example for 2026-10-08 (UTC): A `after=1559347200000&before=1791417600000`; B `after=1788220800000&before=1788825600000` (Sep 1 … Sep 8); C `after=1788912000000&before=1791417600000`; D `after=1791158400000&before=1791417600000`.

A stale-response guard `statementsToken_` discards out-of-date callbacks. Error on call A → `statementsError` (card shows the error text); errors on B/C/D are silently ignored.

### 2.4 Glance hours — `loadGlanceHours_(token, o)` (`729:1740-1753`)

Call D above. The response is used **only if `response.granularity === "hour"`** and `rows` is non-empty (`729:1743-1745`); otherwise the UTC-day fallback from call C stays and the note reads `fansly_creator_stats_glance_note`.

> `/account/stats/media/shown` (`end`, `hours`) is **not** called by the Earnings tab. Its only caller is the Overview tab: `getMediaShownHours(24)` (`729:1968`) → `api_.getMediaShownHours(0, 24, overwriteAccountId)` (`main:27084-27086`) → `GET /account/stats/media/shown?end=0&hours=24` (`end=0` is sent, since only `null`/`""` are dropped).

### 2.5 Period summary — `load()` (`729:1794-1802`)

`creatorStatsService_.getSummary(cb)` (`main:27064-27066`) → `api_.getSummary` (`main:26967-26969`):
`GET /account/stats/summary?after={currentStart}&before={currentEnd}[&overwriteAccountId=…]`
Feeds tiles (#4, #5), the daily Revenue chart (#7 when `!isMonthly`), the By-product table (#9). Stale guard `loadToken_`; error → `loadError`.

### 2.6 Period revenue series — `loadSeries()` (`729:1854-1859`)

`creatorStatsService_.getSeries("revenue", isMonthly ? "month" : "day", cb)` (`main:27067-27069`):
`GET /account/stats/series?family=revenue&granularity={day|month}&after={currentStart}&before={currentEnd}[&overwriteAccountId=…]`
Result kept whole as `productSeries`; feeds the product chart (#8), the monthly Revenue chart (#7 when `isMonthly`) and `downloadCsv()`.
Granularity values the client ever sends for revenue: `"day"`, `"month"`, `"hour"`. `"month"` is chosen when `window.days > 400` (only reachable through `Custom`).

### 2.7 Top supporters — `loadTopFans()` (`729:1860-1865`)

`creatorStatsService_.getTopFans(fanOrderBy, 25, cb)` (`main:27096-27098`) → `api_.getTopFans` (`main:26997-26999`):
`GET /account/stats/fans/top?after={currentStart}&before={currentEnd}&orderBy={netMills|grossMills|transactions}&limit=25[&overwriteAccountId=…]`
`orderBy` default `M.Fy.NET = "netMills"`; enum `Fy = { NET: "netMills", GROSS: "grossMills", TRANSACTIONS: "transactions" }` (`main:27297`). Changing the sort (`setFanOrderBy`, `729:1667-1669`) re-requests. The callback is wrapped by `aggregated_` (`main:27016-27021`).
Other caller: Overview tab, `getTopFans("netMills", 5, …)` (`729:2018`).

### 2.8 Statement row click — `openStatement(row)` (`729:1674-1678`)

`creatorStatsService_.setRange(po.monthRange(row.bucket))` — `monthRange` (`main:27147-27150`) returns local-noon timestamps of the first and last day of that UTC month; the window becomes `[Date.UTC(y,m,1) … min(last day of month, today)]`. Fires `onWindowChange` → §2.5 + §2.6 + §2.7 again with daily granularity; the page scrolls to the product chart card. No dedicated "statement" endpoint exists.

### 2.9 Wallet endpoints the Earnings tab does NOT use

The older wallet statistics endpoints are still in the bundle but are called only by the legacy `/creator/earnings/*` route tree (`main:104490`), never by `/creator/stats/earnings`:

| endpoint | API method | only caller |
|---|---|---|
| `GET /account/wallets/earnings/stats?before&after&limit&offset` | `getHistoryStats` (`main:37528`) | `app-history-stats` `main:85156` (paged by 100, `main:37702-37716`) |
| `GET /account/wallets/earnings/monthlystats?before&after` | `getHistoryMonthlyStats` (`main:37536`) | `app-history-stats` `main:85163`, `app-monthly-history-stats` `main:85356` |
| `GET /account/wallets/earnings/accounts?before&after` | `getCorrelationAccountStats` (`main:37568`) | `app-monthly-history-correlation-account-stats` `main:86554` |
| `GET /account/wallets/earnings/stats/accounts?correlationAccountId&before&after&limit&offset` | `getHistoryCorrelationAccountStats` (`main:37544`) | `app-history-stats` in per-fan mode `main:85158` |
| `GET /account/wallets/earnings/monthlystats/accounts?correlationAccountId&before&after` | `getHistoryMonthlyCorrelationAccountStats` (`main:37560`) | `app-monthly-history-stats` in per-fan mode `main:85356` |

### 2.10 Cross-cutting (not specific to this tab)

Two global HTTP interceptors are registered (`main:25712-25717`): one adds headers `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`, `fansly-client-check` (`main:25671-25687`), the other appends `ngsw-bypass=true` to every request URL (`main:25690-25697`). Auth header handling was not traced in this slice.

---

## 3. Response fields read by the client

Types are inferred from how the client coerces values (`Number(x) || 0` everywhere); JSON string-vs-number is **UNRESOLVED** unless noted.

### 3.1 `GET /account/wallets/earnings`
| path | unit | use |
|---|---|---|
| `pendingBalance` | mills | Pending balance; added to earnings wallet balance for Total balance (`729:1664`) |

### 3.2 `GET /account/stats/summary` — fields read by Earnings (`applySummary_`, `729:1779-1793`)
| path | type / unit | use |
|---|---|---|
| `revenue.netAfterRefundsMills.{value,previous}` | mills | tile Earnings; numerator of Avg. per paying fan |
| `revenue.grossMills.{value,previous}` | mills | tile Gross |
| `revenue.netMills.{value,previous}` | mills | tile Net before refunds; numerator of Avg. per purchase |
| `revenue.refundedNetMills.{value,previous}` | mills | tile Refunded; `.value` in `hasRefunds` |
| `revenue.transactions.{value,previous}` | count | tile Purchases; denominator |
| `revenue.refunds.{value,previous}` | count | tile Refunds; `hasRefunds`; refund rate |
| `revenue.payingFans.{value,previous}` | count | tile Paying fans; denominator |
| `revenue.newPayingFans.{value,previous}` | count | tile New paying fans |
| `revenue.byProductType[]` → `productType` | type code (§7) | row key / label; `15001` picked for Subscription earnings |
| `revenue.byProductType[].netMills.{value,previous}` | mills | row value, sort key, delta |
| `revenue.byProductType[].grossMills.value` | mills | row secondary value |
| `revenue.byProductType[].transactions.value` | count | row sublabel `"{n}×"` |
| `revenue.series.grossMills[]` `{bucket, value}` | ms bucket, mills | Gross sparkline + chart line |
| `revenue.series.netMills[]` `{bucket, value}` | ms bucket, mills | minuend of the Earnings series |
| `revenue.series.refundedNetMills[]` `{bucket, value}` | ms bucket, mills | subtrahend; Refunded chart line |

`.value`/`.previous` are passed through `Math.round` (`toGrowthMetric`, `main:27103-27105`). `previous` is the server-computed previous period — the client never sends the previous window's bounds.
Other summary sections (`views`, `profile`, `follows`, `subscriptions`, `levels`, `dataSince`) are read by other tabs only.

### 3.3 `GET /account/stats/series?family=revenue`
| path | type / unit | use |
|---|---|---|
| `granularity` | string | checked `=== "hour"` for call D only |
| `afterBucket`, `beforeBucket` | ms epoch | bucket axis: `Number(afterBucket) || window.currentStart` … `Number(beforeBucket) || window.currentEnd` (`729:1832-1834`) |
| `rows[].bucket` | ms epoch (day; normalised to month start by the client when monthly) | grouping key (day/month granularity) |
| `rows[].hourBucket` | ms epoch (hour) | grouping key for hour granularity (`729:1748`) |
| `rows[].productType` | type code | product family; `6101` rows skipped for per-product figures |
| `rows[].transactions` | count | totals / CSV `Purchases` |
| `rows[].grossMills` | mills | totals / CSV `Gross` / monthly chart |
| `rows[].netMills` | mills | totals, per-product chart & CSV |
| `rows[].refunds` | count | totals / CSV `Refunds` |
| `rows[].refundedNetMills` | mills | totals / CSV `Refunded`; earnings = net − refundedNet |

Rows are one per (bucket, productType) *(inferred from the client grouping on both; the client also tolerates several rows per key because it sums)*.

### 3.4 `GET /account/stats/fans/top`
| path | type / unit | use |
|---|---|---|
| `rows[]` | — | list, capped by the request `limit` |
| `rows[].fanId` | account id | avatar + username lookup; `track` key; passed to the modal |
| `rows[].transactions` | count | "{n} purchase(s)" |
| `rows[].netAfterRefundsMills` | mills (server-provided here) | row amount |
| `rows[].refunds` | count | "{n} refund(s)" (shown when non-zero) |
| `rows[].firstBucket` | ms epoch | "since {MMM d | MMM d, y}" in UTC (year shown when not the current UTC year) |
| `rows[].grossMills`, `netMills`, `refundedNetMills`, `lastBucket` | mills / ms | only read when the row seeds the modal (`setFan_`, `main:20168-20170`) |
| `aggregationData` | object | `apiGatewayAggregationService_.handleAggregationDataModel` (`main:25620-25622`): arrays `accounts`, `accountMedia`, `accountMediaBundles`, `accountMediaOrders`, `posts`, `groups`, `tags` are pushed into client caches. The fan list joins **`rows[].fanId` → `aggregationData.accounts[].id`** indirectly through `app-account-avatar [accountId]` / `app-account-username [accountId]` |

### 3.5 `GET /account/wallets/earnings/transactions` (Recent purchases)
`response = { data: [...], total, aggregationData }` (`main:37688-37697`, `381:268-273`).

| path | use |
|---|---|
| `data[].transactionId` | row key, shown as `#id`, pager cursor |
| `data[].type` | label / icon (§7) |
| `data[].destination` | `1` = outgoing (sign `−`), `2` = incoming (sign `+`) |
| `data[].status` | status pill (§7) |
| `data[].amount` | mills; net of fees according to the wallet-history card text that hosts the same component (`189:236`: "Amounts are what you received after fees, so they match your balance"); `app-balance-display` |
| `data[].createdAt` | ms epoch, `date:"MMM d, y, HH:mm"` (local time) |
| `data[].correlationId` | media id (2010/2110), bundle id (2016/2116), order id (6101), join key for sublabels |
| `data[].correlationAccountId`, `senderId`, `receiverId` | the fan account shown next to the label |
| `data[].refundable` | refund button (hidden on this tab) |
| `data[].productOrder.{type, items[0].metadata (JSON string with accountId/authorId), items[0].productId, items[0].taxes[0].{descriptionShort, description}}` | type 58000 label, tax line |
| `data[].walletId`, `accountId`, `newBalance`, `updatedAt` | copied into the model, not displayed |
| `total` | total row count for the pager |
| `aggregationData.subscriptionHistory[]` `{id, subscriptionTierName, billingCycle (days), subscriptionTierColor}` | sublabel for type 15001: `"{tier} · {round(billingCycle/30)} month(s)"`, joined on `correlationId` (`main:37393-37400`) |
| `aggregationData.tips[]` `{id, message}` | sublabel for 7001/7101: quoted 80-char excerpt |
| `aggregationData.stories[]` `{id, content}` | sublabel for 32001/32101 (locked text) |
| `aggregationData.accounts / accountMedia / accountMediaBundles / …` | generic cache fill (`main:37690`) |

Formatting everywhere: `app-balance-display` (`main:2829-2850`) → `balance` pipe mode 2 → `balanceToDollars(mills) = floor(mills/10)/100` (`main:490-496`): **sub-cent mills are floored**, then thousands separators, cents omitted when `.00`. Negative values render a leading `−` on the absolute value.

---

## 4. CSV exports — both are built **client-side** (no server export endpoint)

CSV helper = module 895 `f` (`381:2-35`):

- `line(cells)`: `null`/`undefined` → `""`; a cell starting with `=`, `+`, `-`, `@`, TAB or CR that is not a plain number (`/^-?\d+(\.\d+)?$/`) gets a leading `'`; a cell containing `"`, `,`, CR or LF is wrapped in `"…"` with `"` doubled; cells joined by `,`.
- `dollars(mills)` = `balanceToDollars(mills || 0).toFixed(2)` → always 2 decimals, `.` separator, no currency sign, no thousands separator.
- `utcDay(ts, g)` = `YYYY-MM-DD` (UTC), or `YYYY-MM` when `g === "month"`.
- `save(name, lines)`: `new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" })`, object URL, synthetic `<a download>` click. CRLF line ends, trailing CRLF, **no BOM**.

Shared row builder `revenueCsvLines_(rows, buckets, gran)` (`729:1693-1713`):

1. `totals = po.revenueTotalsByBucket(rows, gran)` keyed by bucket (§5) — **all rows, including productType 6101**.
2. For each row with `productType !== 6101`: `family = productFamily_(productType)` (label with a trailing `" (Legacy)"` removed, `729:1803-1806`); `perFamily[family][bucketKey] += netMills`; `familyTotal[family] += netMills`. `bucketKey` = month start when `gran === "month"`, else the row's `bucket`.
3. Family columns = all families present, sorted by total net descending (no `> 0` filter here, unlike the chart).
4. Header: `Date,Purchases,Gross,Net,Refunds,Refunded,Earnings,<family…>` — e.g. `…,Subscriptions,Tips,Media,Media Sets,Locked Text,…`.
5. One line per bucket in `buckets` (zero-filled when a bucket has no rows):

| column | value |
|---|---|
| `Date` | `utcDay(bucket, gran)` |
| `Purchases` | `String(transactions)` |
| `Gross` | `dollars(grossMills)` |
| `Net` | `dollars(netMills)` |
| `Refunds` | `String(refunds)` |
| `Refunded` | `dollars(refundedNetMills)` |
| `Earnings` | `dollars(netMills − refundedNetMills)` |
| each family | `dollars(sum of that family's netMills in the bucket)` — **net before refunds** |

### 4.1 `downloadCsv()` — "Earnings by product over time" card (`729:1682-1686`)
- Feeds on: the already-loaded period series response `productSeries` (§2.6). No request. No-op when it is null.
- `gran = isMonthly ? "month" : "day"`; `buckets = bucketsBetween(Number(afterBucket) || currentStart, Number(beforeBucket) || currentEnd, gran)` (`main:27109-27122`: inclusive both ends; monthly = every UTC month start from the start's month).
- Filename: `fansly-earnings-{YYYY-MM-DD of window.currentStart}-{YYYY-MM-DD of window.currentEnd}.csv` (day format even when monthly).

### 4.2 `downloadStatementsCsv()` — "Monthly statements" card (`729:1687-1692`)
- Feeds on: `statementRows_` = raw `rows` of call A (all-time, monthly; §2.3). No request. No-op when `statements` is empty.
- `buckets` = `statements[].bucket` reversed → oldest month first; covers every month from the first month that has any row through the current month.
- Filename: `fansly-statements-{YYYY-MM first}-{YYYY-MM last}.csv`; `gran = "month"`.

### 4.3 Not on this tab (cross-reference): wallet-history export, `/creator/wallet/history` (`189:163-212`)
Reached through the "View all" / wallet links. Also client-built: loops `GET /account/wallets/earnings/transactions?before={id}&after={id}&limit=100&offset=0` where the bounds are **snowflake ids** `(BigInt(ms) − 1561494359539) << 22` (`main:708-709`) for the picked range (`this_month`, `last_month`, `90_days`, `this_year`, local-time bounds), next page `before = last transactionId`, stops below 100 rows or at 5000 rows; resolves usernames via `accountService_.getAccountsByIds` in batches of 50; header `Date,Transaction ID,Type,Details,Fan,Fan ID,Amount,Status`; filename `fansly-wallet-history-{key}-{YYYY-MM-DD}.csv`. A payouts export `fansly-payouts-{YYYY-MM-DD}.csv` exists at `189:483-505` (not analysed here).

---

## 5. Client-side derived metrics

Growth metric object (`main:20523-20531`): `build(value, previous)` → `{ value, previous, delta = value − previous, deltaAbs, deltaPercent = previous > 0 ? delta/previous*100 : null, hasPrevious = previous > 0 }`.
Delta pill (`main:20592-20598`): `round(deltaPercent)%` with sign, capped to `>999%` / `<-999%`; without a previous value → `New` (`fansly_profile_stats_overview_new`) when `value > 0`, else `–`. `lowerIsBetter` flips the colour only.

| metric | formula | ref |
|---|---|---|
| Earnings / "net after refunds" (per bucket) | `netMills − refundedNetMills` | `main:27137`, `729:1726`, `1732`, `1748` |
| Earnings sparkline / chart line (daily) | `seriesMinus(series.netMills, series.refundedNetMills)` per bucket | `main:27193-27204`, `729:1784` |
| Avg. per paying fan | `round(netAfterRefundsMills.value / payingFans.value)` (previous likewise; 0 when denominator 0) | `ratioMetric`, `main:27245-27249`; `729:1781` |
| Avg. per purchase | `round(netMills.value / transactions.value)` — **net before refunds** | `729:1781` |
| Refund rate | `round(refunds.value / transactions.value * 100)`, shown as `N%` | `729:1781`, `1656` |
| Subscription earnings | `byProductType[productType == 15001].netMills` | `729:1782-1783` |
| `hasRefunds` | `refunds.value > 0 || refunds.previous > 0 || refundedNetMills.value > 0` | `729:1783` |
| By-product rows | sorted by `netMills.value` desc; excluded: type 6101 and rows with both net and gross ≤ 0; delta = `toGrowthMetric(netMills)` | `729:1786-1792` |
| By-product bar width | `value / max(value of visible rows)` — relative to the top row, **not** a share of the total; no percentage is computed | `main:19951-19961` |
| Product chart lines | per family: sum of `netMills` per bucket; only families with total > 0; legend amount = family total; colour from table §7 | `729:1810-1831` |
| Monthly Revenue chart | per month: Gross = `grossMills`, Earnings = `netAfterRefundsMills`, Refunded = `refundedNetMills` (line only when the period total > 0) | `729:1835-1853` |
| Chart down-sampling | more than 90 buckets → consecutive buckets merged in groups of `ceil(n/90)` by summing; x label becomes a date span | `main:20389-20418` |
| `revenueTotalsByBucket(rows, gran)` | group by bucket (month start when monthly), sum `transactions, grossMills, netMills, refunds, refundedNetMills`, add `netAfterRefundsMills`; ascending | `main:27131-27142` |
| Statement rows | months from the first bucket through the current UTC month, newest first, zero-filled; `{bucket, label "Mon YYYY", isCurrent, transactions, grossMills, netAfterRefundsMills, delta, best, onRecordPace}` | `main:27156-27165` |
| Statement delta (closed month) | `build(this month, previous calendar month or 0)`; `null` for the very first month | `main:27161-27162` |
| Statement delta (running month) | `build(current month so far, monthToDatePreviousMills_)` where the latter = Σ(net − refundedNet) of call B | `729:1762-1767`, `1724-1727` |
| Personal bests | closed months with earnings > 0; needs ≥ 3; top three by earnings get `best = 1,2,3` | `main:27166-27174` |
| Record pace | only when UTC day-of-month ≥ 7 and bests exist: `currentMonth / dayOfMonth * daysInMonth > bestMonth` | `main:27175-27176` |
| Recent closed months | non-current rows, newest 12 | `main:27188-27192` |
| Usual month | median of those (mean of the two middle values when even); `null` when fewer than 3 | `main:27178-27187` |
| Baseline "Last 30 days" | `earnedMills` = Σ(net − refundedNet) of call C; `vsUsualPercent = round((earned − usual)/usual*100)`; `rank = 1 + count(recent closed months with earnings > earned)`; `monthCount`; sparkline = recent closed months oldest→newest, then `earned`; `hasUsual = usual > 0` | `729:1768-1774` |
| Glance This month | `netAfterRefundsMills` of the `isCurrent` statement row | `729:1754-1758` |
| Glance All time | Σ `netAfterRefundsMills` over **all** statement rows | `729:1756` |
| Glance This month delta | `build(glanceMonth, monthToDatePreviousMills_)` | `729:1759-1761` |
| Glance Today / Yesterday, UTC fallback | from call C: bucket `== o` → today, `== o − DAY` → yesterday; no deltas | `729:1730-1737` |
| Glance Today / Yesterday, hourly | see below | `729:1746-1751` |

Glance-hours logic (local time zone of the browser): `h` = current hour start; `v`/`g`/`m` = local midnight of today / yesterday / the day before; `p = h − DAY`. For every row, `k = hourBucket`, `x = netMills − refundedNetMills`:

- `k ≥ v` → `today += x`
- else `k ≥ g` → `yesterday += x`, and additionally `yesterdayUpToThisHour += x` when `k ≤ p`
- else `k ≥ m` → `dayBefore += x`

Result: `glanceToday = today`, `glanceYesterday = yesterday`, `glanceTodayDelta = build(today, yesterdayUpToThisHour)`, `glanceYesterdayDelta = build(yesterday, dayBefore)`, `glanceLocalDays_ = true` (which also blocks the UTC fallback from overwriting).

Fan revenue (list): no derivation — the row's `netAfterRefundsMills` is displayed as delivered. In the modal the totals are recomputed from `byProductType` (§6.2).

---

## 6. Fan list and fan drill-down

### 6.1 Who calls what (grep over `main` + all chunks)

| method | endpoint | callers |
|---|---|---|
| `getTopFans` | `GET /account/stats/fans/top` | Earnings `729:1862` (`orderBy` = sort, `limit=25`); Overview `729:2018` (`"netMills"`, `5`) |
| `getFanRevenue` | `GET /account/stats/fans` | fan detail modal only: `main:20190` (statements), `main:20199` (period) |
| `getEarningsTransactionsForAccount` | `GET /account/wallets/earnings/transactions/accounts` | fan detail modal only: `main:20221` |

Fan detail modal = `app-stats-fan-detail-modal` (module 2980, `main:20147-20278`), title `Supporter` → `fansly_creator_stats_fan_detail_title`. Entry points:

- `setFan(row)` (seeded with the list row): Earnings `729:1670-1673`, Overview `729:1991-1994`.
- `setFanId(accountId)` (unseeded, method name `openEarningsModel`): `app-messaging-overlay-group` `main:59839`, `app-messages-conversation-route` `main:74648`, `app-creator-dashboard-subscription` `main:93831`, `app-profile-route` `main:99922`.

Modal controls: `app-growth-period-selector` with `7/30/90 days`, `Lifetime` (`fansly_profile_stats_overview_period_lifetime`, sentinel `-1`), `Custom`. Initial window and period are copied from the facade. `Lifetime` → window from `lifetimeStart_()` (= `firstBucket`, else the oldest statement month, else `now − Hc days`) to now (`main:20171-20179`). Sections: `Monthly statements` (`fansly_creator_stats_statements_title` / `…_statements_desc`), metric boxes `Earned` (`fansly_creator_stats_fan_detail_net_after`), `Gross` (`…_fan_detail_gross`), `purchases`, `Refunded` (`…_fan_detail_refunded`), `First purchase` / `Last purchase` (`…_fan_detail_first` / `_last`), `By product` (`…_fan_detail_types`), `Net per day` / `Net per month` (`…_fan_detail_daily` / `_monthly`), `Purchases` (`…_fan_detail_transactions`, desc `…_transactions_desc`), empty `No purchases in this period.` (`fansly_creator_stats_fan_tx_empty`).

### 6.2 `GET /account/stats/fans` (`main:27000-27002`, facade `main:27099-27102`)

Params: `fanId`, `after`, `before`, `granularity` (API default `"day"` when falsy), `overwriteAccountId`.

| call | `after` / `before` | `granularity` |
|---|---|---|
| period (`load`, `main:20197-20205`) | modal window `currentStart` / `currentEnd` | `"month"` when `window.days > 400`, else `"day"` |
| statements (`loadStatements`, `main:20188-20196`) | window for `{from: monthRange(monthStartOf(now − Hc days)).from, to: now}` → `1559347200000` … today (UTC bucket of the local date, clamped) | `"month"` |

Response fields read (`apply_`, `main:20234-20253`; statements via `po.statementRows`):

| path | unit | use |
|---|---|---|
| `byProductType[].productType` | code | label; 6101 excluded from rows |
| `byProductType[].{grossMills, netMills, refundedNetMills, transactions, refunds}` | **plain numbers** (not `{value, previous}`) | summed into the modal totals: gross, net, refundedNet, `netAfterRefunds = net − refundedNet`, transactions, refunds; rows sorted by `netMills` desc, shown when net or gross > 0 |
| `firstBucket`, `lastBucket` | ms epoch | First / Last purchase (UTC `MMM d, y`) |
| `rows[].bucket`, `rows[].netMills`, `rows[].refundedNetMills` | ms, mills | chart "Earned" (`fansly_creator_stats_series_fan_net`): per bucket Σ(net − refundedNet) |
| `rows[].{transactions, grossMills, refunds}` (month call) | — | statement rows, same algorithm as §5 |
| `aggregationData` | — | generic cache fill via `aggregated_` |

### 6.3 `GET /account/wallets/earnings/transactions/accounts` (`main:37552-37559`, service wrapper `main:37735-37740`) — new endpoint

Query string, in this order (`main:37553`):
`correlationAccountId={fanId}&before={ms}&after={ms}&cursor={id|0}&limit={n}[&overwriteAccountId={id}]`

| param | value from the modal (`readTransactions_`, `main:20219-20227`) | API default |
|---|---|---|
| `correlationAccountId` | `fan.fanId` | `""` |
| `before` | `window.currentEnd + 86400000` (**ms timestamp**, end of the last day) | `"0"` |
| `after` | `window.currentStart` (**ms timestamp**) | `"0"` |
| `cursor` | id of the last row already held (`transactionId`), `"0"` on the first read | `"0"` |
| `limit` | pager chunk: `min(100, max(30, page*10 − held))` → `30` on the first read (pager `pageRows = 10`, `chunkRows = 30`, `main:20153-20157`) | `25` |
| `overwriteAccountId` | facade value; appended only when non-empty | omitted |

Note the unit difference: here `before`/`after` are millisecond timestamps, whereas `/account/wallets/earnings/transactions` takes transaction (snowflake) ids.

Response fields read (`main:20222-20233`):

| path | use |
|---|---|
| `data[]` | rows |
| `hasMore` (boolean) | pager exhaustion; `total` is not supplied, so the page count grows while reading |
| `aggregationData` | passed to `handleAggregationDataModel` (accounts, media, bundles…) and to the sublabel join (`subscriptionHistory`, `tips`, `stories`, §3.5) |
| `data[].transactionId` | row id / cursor |
| `data[].createdAt` | ms, local `MMM d, y, HH:mm` |
| `data[].destination` | `1` → the row is a refund debit (label `Refund` → `fansly_creator_stats_fan_tx_refund`, icon `rotate-left`, leading `−`) |
| `data[].status` | pill: `1` → `Pending` (`fansly_creator_stats_fan_tx_pending`); non-refund row with `5`/`6` → `Refunded` (`…_fan_tx_refunded`); `4` or literal `8` → `Cancelled` (`…_fan_tx_cancelled`) |
| `data[].type` | label via `productTypeLabel`, icon |
| `data[].correlationId` (`"0"` treated as empty) | `mediaOfferId` for types 2010/2110 (thumbnail `app-account-media`), `bundleId` for 2016/2116, sublabel join key |
| `data[].amount` | mills, `Math.abs` → displayed net amount |
| `data[].transactionAmount` | mills → "{amount} paid" (`fansly_creator_stats_fan_tx_gross`), shown for non-refund rows when it differs from the net amount |

---

## 7. Enumerations and constants

Series family `$t` (`main:27297`): `VIEWS "views"`, `PROFILE "profile"`, `FOLLOWS "follows"`, `SUBSCRIPTIONS "subscriptions"`, `REVENUE "revenue"`. Earnings uses only `"revenue"`; refunds are fields/rows inside it, not a separate family.
Fan order `Fy`: `"netMills"`, `"grossMills"`, `"transactions"`.
Module 804 exports (`main:27009`): `Z2 = [7, 30, 90]`; `tO = 400` (used as the lifetime window length by the media modal `729:812`; the 400-day granularity rule itself is the literal in `granularityForWindow`); `Hc = ceil((Date.now() − 1561494359539)/86400000)` — days since the Fansly snowflake epoch 2019-06-25T20:25:59.539Z.
Period selector lifetime sentinel `w = -1` (`main:20694`).

Revenue product types (`ee`, `main:27009`; unknown code → `"Other"`; labels are English literals with no stringId), chart colour token (`wi`, `729:1651`; default `--v2-dark-blue-1`), family after stripping `" (Legacy)"`:

| code | label | family | colour token |
|---|---|---|---|
| 7001 | Tips (Legacy) | Tips | `--v2-chart-purple` |
| 7101 | Tips | Tips | `--v2-chart-purple` |
| 2010 | Media (Legacy) | Media | `--v2-chart-grey` |
| 2110 | Media | Media | `--v2-chart-grey` |
| 2016 | Media Sets (Legacy) | Media Sets | `--v2-chart-blue` |
| 2116 | Media Sets | Media Sets | `--v2-chart-blue` |
| 15001 | Subscriptions | Subscriptions | `--v2-chart-green` |
| 18001 | Referrals | Referrals | `--v2-chart-teal` |
| 18002 | Referrals | Referrals | `--v2-chart-teal` |
| 45001 | Stream Tickets | Stream Tickets | `--v2-chart-orange` |
| 45101 | Stream Tickets | Stream Tickets | `--v2-chart-orange` |
| 32001 | Locked Text | Locked Text | `--v2-chart-red` |
| 32101 | Locked Text | Locked Text | `--v2-chart-red` |
| 24101 | Leaderboard Prize Money | Leaderboard Prize Money | `--v2-chart-gold` |
| 6101 | Refunds | excluded (`K = 6101`, `729:1651`) | — |

Wallet transaction types handled by the Recent-purchases describer (module 10, `381:303-383`; incoming = `destination === 2`):
6101 Refund / Refund from / Refund to; 2010, 2110 Media Sale (to) / Media Purchase from; 2016, 2116 Media Bundle Sale (to) / Purchase from; 32001, 32101 Locked Text Sale (to) / Purchase from; 45101 Stream Ticket Sale (to); 7001, 7101 Tip from / Tip to / Tip; 15000, 15001 Subscription Sale (to) / Subscription Purchase; 6515 Subscription Payment Credit; 58000 product order (sub-typed by `productOrder.type` 15001 / 45001 / 32001 / 2010 / 2016 / 7001, else `Product Order`); 6002 Internal Transfer; 14001 Balance purchase; 16013 Canceled Payout Refund; 18001 Referral Code Earnings; 18002 Creator Referral Code Earnings; 24101 Leaderboard Prize Money; 24102 Gift Code Claim; 24103 Promotional Credit; 24301 Crypto Wallet Balance Purchase; default `Transaction`. String ids are `fansly_wallet_tx_*` at the same lines.
Icons (`main:37376`): 6002 arrow-right-arrow-left; 6101, 16013 rotate-left; 6515, 15000, 15001 star; 7001, 7101 gift; 18001, 18002 user-plus; 24101 trophy; 24102 gift-card; 24103 tag; 32001, 32101 lock; 45001, 45101 ticket; default coins.

Transaction status (`main:37434`, `37461`): `PENDING 1`, `APPROVED 2`, `CANCELED 4`, `REFUNDED 5`, `REFUNDED_PENDING 6`. Status text (`main:37447-37449`): pending+outgoing → `Approved`, pending → `Pending`, `Approved`, `Canceled`, `Refunded`, otherwise `Please contact Support with Order Number`.
Transaction `destination`: `1` outgoing (`Eh = 1`, `381:298`), `2` incoming.
Wallet `type`: `1` main, `2` earnings (`main:37656`). `WALLET_FLAGS`: `BLOCK_INGOING 1`, `BLOCK_OUTGOING 2` (`main:37758`).
`app-wallet-balance`: `balanceMode` 1 = main + earnings, 2 = main, 3 = earnings; `balanceConversion` 1 = gems, 2 = dollars (`main:22200-22203`, `24566-24568`).

---

## 8. Open questions / UNRESOLVED

1. **Bound semantics of `after`/`before` on `/account/stats/*`.** The client always sends UTC-midnight day buckets and treats both as inclusive (`bucketsBetween` loops `<= before`; "last 30 days" is `o − 29d … o`; the hourly call sends `before = today 00:00 UTC` yet expects rows for today's hours). Inclusive-day behaviour on the server is strongly implied but not provable from the bundle.
2. **JSON types** of `bucket`, `hourBucket`, `firstBucket`, `lastBucket`, `afterBucket`, `beforeBucket` and the mills fields (string vs number). The client wraps all of them in `Number()`; the modal's seed object uses string `"0"` for `firstBucket`/`lastBucket`, which hints at strings.
3. **productType 6101 rows in `/series` and `byProductType`.** The client skips them for per-product figures but `revenueTotalsByBucket` sums every row. Whether the server emits such rows, and what their `transactions`/`netMills`/`refunds` contain, is unknown — it decides whether totals double-count.
4. **Refund attribution date**: whether `refunds`/`refundedNetMills` sit in the bucket of the original sale or of the refund.
5. **Hour granularity limits**: maximum range accepted and whether the server downgrades granularity (the client checks the echoed `granularity === "hour"` and silently falls back, which suggests it can).
6. **Bucket granularity of `summary.revenue.series`** for windows longer than 400 days (the tiles' sparklines use it regardless; the chart switches to `/series` monthly).
7. **`/account/stats/fans/top`**: maximum `limit`, other accepted `orderBy` values, tie-breaking, any paging — the client only ever sends 5 or 25 and the three sort keys.
8. **Row fields not read by any caller**: `refundedGrossMills` appears only in the modal's local seed object (`main:20163`); its presence in responses is unproven. Full response schemas beyond the fields listed are unknown.
9. **Which `aggregationData` arrays** the stats endpoints actually return (the handler accepts `accounts`, `accountMedia`, `accountMediaBundles`, `accountMediaOrders`, `posts`, `groups`, `tags`; the wallet endpoints add `subscriptionHistory`, `tips`, `stories`).
10. **`overwriteAccountId`**: who may use it and how the server authorises it. Client side it is just the page query param forwarded to every `/account/stats/*` call and to `/transactions/accounts`; `/account/wallets/earnings` and the Recent-purchases call never carry it.
11. **`/account/wallets/earnings/transactions/accounts`**: exact meaning of `cursor` (the client passes the last `transactionId`), ordering (UI text says newest first), maximum `limit`, and whether `transactionAmount` is the fan-paid gross including tax.
12. **`status === 8`** on transactions: handled as "Cancelled" by a bare literal, no enum name.
13. **`GET /account/wallets/earnings`**: fields other than `pendingBalance` are not read by any current caller.
14. Auth header and the derivation inputs of `fansly-client-check` were only sighted (`main:25671-25687`), not analysed in this slice.
