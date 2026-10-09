# Fansly creator stats — AUDIENCE tab (`/creator/stats/audience`)

Static reading only (no code executed, no network). Everything below is proven from the pretty-printed
bundles unless explicitly marked **UNRESOLVED** / *inferred*.

File legend (all under `analysis/`):

| short | file |
|---|---|
| `729:N` | `729.d14b4c5910bebc74.pretty.js` (lazy stats chunk, webpack module 8729) |
| `main:N` | `main.2e6b96097a4bb73b.pretty.js` |
| `381:N` | `381.3db514b57dd6c2e7.pretty.js` |

Key symbols: facade `d.po` = class `Ie` in module 804 (`main:27010`), API service = class `C` in module 804
(`main:26948-27007`), tracking-link service = module 7511 (`main:36823-37047`), enums = module 906
(`main:27295-27297`), growth metric `w.n` = module 8854 (`main:20521-20531`).

---

## 0. TL;DR

The Audience tab makes exactly these requests (base `https://apiv3.fansly.com/api/v1`, `main:37841`):

| # | Request | Issued by | When |
|---|---|---|---|
| 1 | `GET /account/stats/summary?after={currentStart}&before={currentEnd}[&overwriteAccountId=…]` | route `load()` `729:304` | init, window change, refresh |
| 2 | `GET /account/stats/geo?source={0\|1\|4}&after={currentStart}&before={currentEnd}&limit=10[&overwriteAccountId=…]` | route `loadGeo()` `729:313` | init, window change, refresh, source switch |
| 3 | `GET /trackinglinks[?overwriteAccountId=…]` | discovery card `load()` `729:24` | init, window change, refresh |
| 4 | `GET /trackinglinks/stats?trackingLinkId={id}&before={spanBefore}&after={spanAfter}[&overwriteAccountId=…]` | discovery card, per link | after #3 (60 s client cache) |
| 5 | `GET /trackinglinks/revenuestats?trackingLinkId={id}&before={spanBefore}&after={spanAfter}[&overwriteAccountId=…]` | discovery card, per link | after #3 (60 s client cache) |

It does **not** call `/account/stats/series`, `/account/stats/activehours`, `/account/stats/media/shown`,
`/it/amoie/stats` or `/geolocation/subdivisions`.
`app-stats-heatmap` and `app-stats-hour-bars` are defined next to the Audience code but are **not rendered
on the Audience tab** (heatmap → Content tab; hour bars → Overview "Right now" card and media-detail modal). See §9.

---

## 1. Widgets in on-screen order

Shell (shared by all four tabs, `729:2059-2118`): title "Statistics" (`fansly_creator_stats_title`) + "Beta",
`app-growth-period-selector` (options `[7, 30, 90]` + "Custom"), refresh button, beta notice, tab strip
Overview / Content / **Audience** (`fansly_creator_stats_tab_audience`) / Earnings.

Audience route component: `app-creator-stats-audience-route`, class `Xt` (`729:236-336`), template `At`
(`729:222-234`), consts `729:333`. Three render states (`729:335`): error (`loadError`) → skeleton (4 + 8 tiles)
→ content (`hasLoaded`).

Error state text: "Statistics could not be loaded right now." (`fansly_creator_stats_error`), `729:175-177`.

### 1.1 Large tile grid (`div.tile-grid`, 4 × `app-growth-stat-tile`, with sparkline)

| # | Label (default EN) | stringId | icon | `metric` | `series` (sparkline) |
|---|---|---|---|---|---|
| 1 | Total followers | `fansly_creator_stats_tile_followers` | users | `followerCount` | `followerLevelSeries` |
| 2 | Subscribers | `fansly_creator_stats_tile_subscribers` | star | `subscriberCount` | `subscriberLevelSeries` |
| 3 | Profile visits | `fansly_creator_stats_tile_profile_visits` | user | `profileVisits` | `profileVisitsSeries` |
| 4 | New subscribers | `fansly_creator_stats_tile_new_subscribers` | star | `subscriptionsNew` | `subscriptionsNewSeries` |

All get `periodDays = window.days` (`729:233`). No controls.

### 1.2 Compact tile grid (`div.tile-grid.compact`, 8 × `app-growth-stat-tile [compact]=true`)

| # | Label | stringId | icon | `metric` | extras |
|---|---|---|---|---|---|
| 5 | Unique visitors | `fansly_creator_stats_tile_unique_visitors` | eye | `uniqueVisitors` | |
| 6 | Avg. time on profile | `fansly_creator_stats_tile_avg_profile_time` | clock | `avgProfileWatchMs` | `valueFormat = formatDuration` |
| 7 | New followers | `fansly_creator_stats_tile_follows` | user-plus | `follows` | |
| 8 | Unfollows | `fansly_creator_stats_tile_unfollows` | user-minus | `unfollows` | `lowerIsBetter` |
| 9 | Follower growth | `fansly_creator_stats_tile_net_follows` | arrow-trend-up | `netFollows` | |
| 10 | Renewal rate | `fansly_creator_stats_tile_renewal_rate` | rotate | `renewalRate` (client-derived) | `valueFormat = formatPercent` |
| 11 | Expired subscriptions | `fansly_creator_stats_tile_expired` | hourglass-end | `subscriptionsExpired` | `lowerIsBetter` |
| 12 | Cancelled subscriptions | `fansly_creator_stats_tile_cancelled` | ban | `subscriptionsCancelled` | `lowerIsBetter` |

Tile footer strings (module 9039, `main:20782-20884`): "vs previous" (`fansly_profile_stats_overview_vs_previous`)
+ `{periodDays}` + "days" (`fansly_profile_stats_overview_days`) — only on non-compact tiles;
"No data in the previous period" (`fansly_profile_stats_overview_no_previous`); delta pill "New"
(`fansly_profile_stats_overview_new`).

### 1.3 Row of two cards (`div.stats-grid.two`)

**(a) Card "Where profile visits come from"** — `app-stats-card`
heading `fansly_creator_stats_audience_sources_title`; desc "Visits and unique visitors per surface."
(`fansly_creator_stats_audience_sources_desc`); header link "Tracking links"
(`fansly_creator_stats_audience_discovery_link`) → route `/creator/trackinglinks`; `loading = n.loading`.
Body: `app-stats-bar-table` `rows = visitSourceRows`, value column "Visits" (`fansly_creator_stats_label_visits`),
secondary column "Unique" (`fansly_creator_stats_label_unique`), delta column "Change"
(`fansly_creator_stats_label_change`, bar-table default). No controls.

**(b) Card "Top countries"** — heading `fansly_creator_stats_audience_geo_title`; `loading = n.loadingGeo`.
Description depends on `geoMetric` (`729:233`):

| geoMetric | desc | stringId |
|---|---|---|
| `views` (default) | "Where your media views come from on this surface." | `fansly_creator_stats_audience_geo_desc` |
| `watch` | "How long viewers in each country watch on this surface." | `fansly_creator_stats_audience_geo_watch_desc` |
| `visits` | "Where your profile visitors are, from every surface." | `fansly_creator_stats_audience_geo_visits_desc` |

Live (2026-10-08 capture): after switching the metric to "Watched" the page still showed the `views`
description while the table already had the watch columns, so the description is not refreshed on a
metric switch even though the binding above changes.

Controls (in the card header, `cardActions` slot):
- `app-stats-segmented` `options = geoOptions`, `value = geoMetric`, `(valueChange) → setGeoMetric`:
  `views` "Views" (`fansly_creator_stats_geo_metric_views`), `watch` "Watched" (`fansly_creator_stats_geo_metric_watch`),
  `visits` "Profile visits" (`fansly_creator_stats_geo_metric_visits`) — `729:239`.
- `app-stats-source-switch` `source = n.source`, `(sourceChange) → setSource` — rendered only when
  `geoMetric !== "visits"` (`729:233`: `t.vxM("visits" !== n.geoMetric ? 19 : -1)`). Options are the component
  default `M.Bs = [0, 1, 4]` → buttons "For You" / "Timeline" / "Other" (`729:150`, `main:27297`).

Body: one of three `app-stats-bar-table` variants, all `rows = geoRows`:

| geoMetric | value column | secondary column | extras |
|---|---|---|---|
| `visits` | "Visits" (`fansly_creator_stats_label_visits`) | — | empty: "No located profile visits in this period yet." (`fansly_creator_stats_geo_visits_empty`) |
| `watch` | "Avg. watched %" (`fansly_creator_stats_tile_avg_watch_percent`), `valueSuffix="%"` | "Avg. watch time" (`fansly_creator_stats_label_avg_watch_time`) | |
| `views` | source 0: "Views" (`fansly_creator_stats_media_views`); else "Video views" (`fansly_creator_stats_label_video_views`) | "Image views" (`fansly_creator_stats_label_image_views`) — column appears only when source ≠ 0 | default empty: "No data in this period." (`fansly_creator_stats_empty`) |

### 1.4 Discovery card — `app-stats-discovery-card` (class `Ot`, `729:15-94`)

`app-stats-card` heading "Followers discovery brought you" (`fansly_creator_stats_discovery_follows_title`);
desc "People who first reached you from For You, Suggestions or Search, or through one of your links, and then
followed. Credited to the source that brought them." (`fansly_creator_stats_discovery_follows_desc`);
header link "Manage links" (`fansly_creator_stats_discovery_manage`) → `/creator/trackinglinks`.
Body: `app-stats-bar-table` value column "Followed" (`fansly_creator_stats_discovery_label_followed`) + "Change";
empty: "Nobody who found you through discovery followed in this period."
(`fansly_creator_stats_discovery_follows_empty`). Own error state (same error string). No controls.
Rows: "For You" / "Suggestions" / "Search" / (optional) "Your links" — see §5.4.

### 1.5 Row of two chart cards (`div.stats-grid.two`)

**(a) "New followers and unfollows"** (`fansly_creator_stats_audience_follows_title`), desc "Per day in the period."
(`fansly_creator_stats_audience_follows_desc`); `app-stats-line-chart series = followsChart`:
"New followers" (`fansly_creator_stats_series_follows`, color `--v2-green-1`), "Unfollows"
(`fansly_creator_stats_series_unfollows`, `--v2-red-1`).

**(b) "Subscriptions"** (`fansly_creator_stats_audience_subs_title`), desc "New and expired subscriptions per day."
(`fansly_creator_stats_audience_subs_desc`); `series = subscriptionsChart`: "New"
(`fansly_creator_stats_series_subs_new`, green), "Expired" (`fansly_creator_stats_series_subs_expired`, red).

Legend is static (`legendToggle` not set → clicking does nothing). No controls.

### 1.6 Card "Subscribers by tier"

heading `fansly_creator_stats_audience_tiers_title`; desc "Subscribers per tier at the end of the period, new
subscriptions in it and the change against the period before." (`fansly_creator_stats_audience_tiers_desc`).
`app-stats-bar-table rows = tierRows`: value "Subscribers" (`fansly_creator_stats_label_subscribers`), secondary
"New" (`fansly_creator_stats_label_new`), delta "Change"; empty: "Levels appear after the first nightly snapshot."
(`fansly_creator_stats_levels_empty`). No controls.

---

## 2. Call chains and query params

### 2.0 Transport facts (apply to every `/account/stats/*` call)

- `get_(path, params, cb)` — `main:26954-26966`. Builds `apiBaseUri_ + path + "?" + k=encodeURIComponent(String(v))&…`
  in object-literal key order; **a param is omitted when its value is `null`/`undefined` or `""`**
  (`null == te || "" === te`). `0` is NOT omitted, so `source=0` is sent.
- Method GET, `authInterceptorService_` attached. Global interceptors (`main:25717`) additionally append
  `ngsw-bypass=true` to the URL (`main:25694-25697`) and set headers `fansly-client-id`, `fansly-client-ts`,
  `fansly-session-id`, `fansly-client-check` (`main:25671-25686`) — same as for any other Fansly API call.
- Envelope: `body.success ? cb(null, body.response) : cb(body.error.details || "error getting statistics")`.
- `overwriteAccountId`: facade field, default `""` (`main:27014`); set by the shell from the page's own query string
  `?overwriteAccountId=` (`729:2094-2095`) and reset to `""` on shell destroy (`729:2104`). Omitted when empty.

### 2.1 Window object (source of `after`/`before`)

Built by the tracking-link service (`main:36914-36925`, `main:37017-37028`), day = `864e5` ms:

```
todayBucket_()        = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())      // UTC midnight of today
buildGrowthWindow(N)  = buildWindow_(today - (N-1)*day, today)
buildWindow_(start,end):
  days          = round((end - start)/day) + 1
  currentStart  = start                    // UTC-midnight ms of first day
  currentEnd    = end                      // UTC-midnight ms of LAST day (today for presets) — a day bucket, not an end instant
  previousEnd   = splitAt = start - day
  previousStart = start - days*day
  spanBefore    = end + day
  spanAfter     = start - day - days*day   (= previousStart - day)
```

Custom range `buildGrowthWindowForRange(from, to)`: each picked timestamp is mapped with `localDayBucket_` =
`Date.UTC(local year, local month, local date)`; swapped if reversed; end clamped to today's bucket; then
`buildWindow_`. No maximum length is enforced by the facade.

Facade state (`main:27013-27057`): `periodDays_ = 30` initially, `source_ = S.EL.FYP (0)`, singleton
(`providedIn: "root"`) so period/source persist across tabs. `getWindow()` first calls `refreshWindow_()`, which
rebuilds a preset window when `floor(Date.now()/day)*day !== window.currentEnd` (UTC day rollover); custom ranges
(`periodDays_ === null`) are never auto-rolled.

All `/account/stats/*` date params are epoch **milliseconds**.

### 2.2 Tiles, "Where profile visits come from", both line charts, "Subscribers by tier"

```
Xt.load()                                             729:304-312
  → facade.getWindow()                                main:27022
  → facade.getSummary(cb)                             main:27064-27066
  → api.getSummary(window.currentStart, window.currentEnd, overwriteAccountId, cb)   main:26967-26969
  → GET /account/stats/summary
```

| param | value / origin |
|---|---|
| `after` | `window_.currentStart` (ms, UTC midnight of first day) |
| `before` | `window_.currentEnd` (ms, UTC midnight of last day) |
| `overwriteAccountId` | facade `overwriteAccountId_`; omitted when `""` |

No source, no granularity, no previous-window bounds are sent. NOT wrapped in `aggregated_` → no `aggregationData` use.
On error/empty: `loadError = true` → whole tab shows the error state.
`load()` then always calls `loadGeo()` (§2.3).

### 2.3 "Top countries"

```
Xt.loadGeo()                                          729:313-318
  → this.source = facade.getSource()                  main:27033
  → facade.getGeoStats(this.source, 10, cb)           main:27087-27089
  → api.getGeoStats(source, window.currentStart, window.currentEnd, 10, overwriteAccountId, cb)   main:26985-26987
  → GET /account/stats/geo
```

| param | value / origin |
|---|---|
| `source` | facade `source_`: `0` FYP (default), `1` TIMELINE, `4` OTHER (the only values the switch offers; `2`/`3` exist in the enum but are never sent from this tab) |
| `after` | `window_.currentStart` |
| `before` | `window_.currentEnd` |
| `limit` | literal `10` (`729:315`) |
| `overwriteAccountId` | as above |

Not wrapped in `aggregated_`. On error the tables silently become empty (`geo_ = []`, `profileGeo_ = []`).
`source` is sent even while the "Profile visits" metric is shown (that metric reads `profileRows`, and the UI text
says "from every surface"). Switching the geo metric does not issue a request (§6).

### 2.4 Discovery card

```
Ot.load()                                                             729:24-48
  s = this.window_ (facade.getWindow()), o = facade.getOverwriteAccountId()
  → trackingLinkService.getAccountTrackingLinks(cb, o)                main:36964-36966
  → api.getAccountTrackingLinks(cb, o)                                main:36848-36857
  → GET /trackinglinks            (+ "?overwriteAccountId=" + o   when o is truthy; not URL-encoded)

  for each selected link (see §5.4):
  → trackingLinkService.getTrackingLinkGrowth(link.id, s, cb, o)      main:36929-36957
      → getTrackingLinkStats(id, s.spanBefore, s.spanAfter, cb, o)        main:36967-36972 → 36858-36867
        → GET /trackinglinks/stats?trackingLinkId={id}&before={spanBefore}&after={spanAfter}[&overwriteAccountId={o}]
      → getTrackingLinkRevenueStats(id, s.spanBefore, s.spanAfter, cb, o) main:36973-36978 → 36868-36877
        → GET /trackinglinks/revenuestats?trackingLinkId={id}&before={spanBefore}&after={spanAfter}[&overwriteAccountId={o}]
```

| param | value / origin |
|---|---|
| `trackingLinkId` | `link.id` from the `/trackinglinks` response |
| `before` | `window.spanBefore` = `currentEnd + 1 day` (ms) |
| `after` | `window.spanAfter` = `currentStart − (days+1) days` (ms) → one request covers current + previous window |
| `overwriteAccountId` | appended only when truthy |

Param order in the URL is literally `trackingLinkId, before, after`. Details in §7.

---

## 3. Response fields read by the client

### 3.1 `GET /account/stats/summary` → `response` (object `e` in `applySummary_`, `729:264-277`)

"Metric" below = object `{ value: number, previous: number }` consumed by `toGrowthMetric` (`main:27103-27105`):
`build(Math.round(value || 0), Math.round(previous || 0))`; a missing/`null` metric → `empty()` (all zeros).
"Point" = `{ bucket, value }`; `seriesValues()` (`main:27205-27210`) reads only `.value`; the line chart reads
`Number(.bucket)` and `.value`.

| path | type / unit (inferred from use) | used for |
|---|---|---|
| `followerCount` | Metric, count (level at period end; "updates nightly" per shell text) | tile 1 |
| `subscriberCount` | Metric, count | tile 2 |
| `levels[]` | array (optional, `|| []`) | sparklines of tiles 1-2 |
| `levels[].followerCount` | number | tile 1 sparkline |
| `levels[].subscriberCount` | number | tile 2 sparkline |
| `profile` | object, **required** (dereferenced without guard) | |
| `profile.profileVisits` | Metric, count | tile 3 |
| `profile.uniqueVisitors` | Metric, count | tile 5 |
| `profile.avgProfileWatchMs` | Metric, milliseconds | tile 6 (`formatDuration`) |
| `profile.series` | object, **required** | |
| `profile.series.profileVisits[]` | Point[] | tile 3 sparkline (`.value` only) |
| `profile.bySource[]` | array (optional) | card 1.3(a) |
| `profile.bySource[].source` | number/string code 0-4 (`Number()`/`String()` applied) | row key + label |
| `profile.bySource[].profileVisits` | Metric (`.value` read directly for sort/value → object required per row) | value + delta |
| `profile.bySource[].uniqueVisitors.value` | number (object required per row) | secondary value |
| `follows` | object, **required** | |
| `follows.follows` | Metric | tile 7 |
| `follows.unfollows` | Metric | tile 8 |
| `follows.netFollows` | Metric (may be negative) | tile 9 |
| `follows.series` | object, **required** | |
| `follows.series.follows[]` | Point[] (`bucket` = epoch ms) | chart 1.5(a); also `followsSeries` (unused in template) |
| `follows.series.unfollows[]` | Point[] | chart 1.5(a); also `unfollowsSeries` (unused) |
| `subscriptions` | object, **required** | |
| `subscriptions.subscriptionsNew` | Metric | tile 4 |
| `subscriptions.subscriptionsRenewed` | Metric | only as renewal-rate numerator (no own tile) |
| `subscriptions.subscriptionsExpired` | Metric | tile 11 + renewal-rate denominator |
| `subscriptions.subscriptionsCancelled` | Metric | tile 12 |
| `subscriptions.series` | object, **required** | |
| `subscriptions.series.subscriptionsNew[]` | Point[] | tile 4 sparkline + chart 1.5(b) |
| `subscriptions.series.subscriptionsExpired[]` | Point[] | chart 1.5(b); `subscriptionsExpiredSeries` (unused) |
| `subscriptions.byTier[]` | array (optional) | card 1.6 |
| `…byTier[].tierId` | id (row key) | |
| `…byTier[].tierName` | string; fallback `"Subscription"` (`main:36099`) | label when active |
| `…byTier[].tierActive` | boolean-ish; falsy → label "Removed tier" (`fansly_creator_stats_tier_removed`), no color | |
| `…byTier[].tierColor` | CSS color string | swatch (active tiers only) |
| `…byTier[].tierPos` | number | sort tie-breaker (asc) |
| `…byTier[].subscriberCount` | Metric (optional) | value, delta (`null` delta if absent), sort key (desc) |
| `…byTier[].subscriptionsNew.value` | number | secondary value "New" |
| `…byTier[].subscriptionsMovedIn.value` | number | sublabel "N moved in" (`fansly_creator_stats_tier_moved_in`) |
| `…byTier[].subscriptionsMovedOut.value` | number | sublabel "M moved out" (`fansly_creator_stats_tier_moved_out`) |

`aggregationData`: not read (summary is not passed through `aggregated_`).
The same endpoint is also used by Content/Earnings/Overview routes (`729:1328`, `1796`, `2013`) which read other
sections (`views[]`, `engagement`, …) — out of this slice.

### 3.2 `GET /account/stats/geo` → `response` (`729:315-317`, `729:251-263`)

| path | type / unit | used for |
|---|---|---|
| `rows[]` | array (optional) | metrics `views` / `watch` |
| `rows[].country` | region code string; falsy → key `"unknown"`, label "Unknown" | row key + label |
| `rows[].views` | number | `views` metric value (column "Views" for source 0, "Video views" otherwise) |
| `rows[].imageViews` | number | `views` metric secondary value, only when source ≠ 0 |
| `rows[].avgWatchPercent` | number, displayed as `Math.round(x)` + "%" (so 0-100 scale expected; *inferred from formatting*) | `watch` metric value |
| `rows[].avgWatchMs` | number, milliseconds | `watch` metric secondary (`formatDuration`) |
| `profileRows[]` | array (optional) | metric `visits` |
| `profileRows[].country` | region code string | row key + label |
| `profileRows[].profileVisits` | number | value |

Rows are rendered in **server order** — the client neither sorts nor truncates them (bar-table `limit` is 0).
No `previous`/delta is read for geo. No `aggregationData`.

### 3.3 Tracking links — see §7.

---

## 4. Client-side derived metrics and formulas

### 4.1 Growth metric (`w.n.build`, `main:20527-20530`)

```
build(value, previous):
  delta        = value − previous
  deltaAbs     = |delta|
  hasPrevious  = previous > 0
  deltaPercent = hasPrevious ? delta / previous * 100 : null
```

"Growth vs previous window" is therefore computed client-side from server-supplied `value` and `previous`
(both rounded to integers first). The client never sends the previous-window bounds to `/account/stats/*`.

Delta pill (`app-growth-delta-pill`, `main:20592-20599`): `isUp = delta > 0`, `isDown = delta < 0`;
`lowerIsBetter` swaps good/bad; no previous → "New" if `value > 0` (and `previous` not negative) else "–";
text = `round(deltaPercent)` with `+` sign and `%`, clamped to `">999%"` / `"<-999%"`.
Tile absolute delta (`main:20828-20839`): default `(+)shortNumber(delta)`; with `valueFormat`:
`("−"|"+") + valueFormat(deltaAbs)`.

### 4.2 Renewal rate (`729:269-270`, `ratioMetric` `main:27245-27249`)

```
renewed = subscriptions.subscriptionsRenewed, expired = subscriptions.subscriptionsExpired
value    = round( renewed.value    / (renewed.value    + expired.value)    * 100 )   (0 if denominator 0)
previous = round( renewed.previous / (renewed.previous + expired.previous) * 100 )   (0 if denominator 0)
renewalRate = build(value, previous)       → empty() if `subscriptionsRenewed` is missing
```

Displayed as `Math.round(v) + "%"`; the absolute delta is in percentage points, the pill shows the relative % change.
This is the only rate on the tab — there are **no conversion-rate metrics** (visit→follow, follow→sub, etc.).

### 4.3 Formatting

- Counts: `shortNumber` pipe (`main:24007-24018`): `0`/NaN → "0"; else 1-decimal K/M/B/T/Q (e.g. 1234 → "1.2K").
- Duration `formatDuration(ms)` (`main:27282-27289`): `s = round(ms/1000)`; `<60` → `"{s}s"`; `<60 min` →
  `"{m}m {ss}s"`; else `"{h}h {mm}m"`.
- Sparkline (`main:20727-20739`): needs ≥ 2 values, y scaled to the series max.

### 4.4 "Where profile visits come from" rows (`729:271-276`)

Copy of `profile.bySource`, sorted by `profileVisits.value` desc. Row = `{ key: String(source),
label: profileSourceLabel(Number(source)), labelStringId: "fansly_creator_stats_profile_source_" + source,
value: profileVisits.value, secondaryValue: uniqueVisitors.value, delta: toGrowthMetric(profileVisits) }`.

### 4.5 Bar-table "share" (`main:19950-19960`)

Bar width = `clamp(row.value / max(value over visible rows), 0..1)` — relative to the **largest row, not to the
total**. No percent-of-total figure is computed or shown anywhere on the tab.

### 4.6 Tier rows (`729:282-303`)

Sort: `subscriberCount.value` desc, then `tierPos` asc. `value = subscriberCount.value || 0`,
`secondaryValue = subscriptionsNew.value || 0`, `delta = subscriberCount ? toGrowthMetric(subscriberCount) : null`,
`sublabel = "{in} moved in, {out} moved out"` (parts omitted when 0), `color = tierActive && tierColor || ""`.

### 4.7 Geo rows (`729:251-263`)

- `visits`: `{ key: country || "unknown", label: countryName(country), value: profileVisits || 0 }` from `profileRows`.
- `views`: `value = views || 0`; if `source !== 0` also `secondaryValue = imageViews || 0`.
- `watch`: `value = Math.round(avgWatchPercent || 0)`, `secondaryValue = avgWatchMs || 0`,
  `secondaryText = formatDuration(avgWatchMs || 0)`.

**Country name resolution** (`main:27253-27260`): purely client-side, no API and no static table:

```js
countryName(code) = !code ? "Unknown"
  : new Intl.DisplayNames([navigator.language || "en"], { type: "region" }).of(code.toUpperCase()) || code
  // on exception → the raw code
```

So names are localized to the browser locale; hub must map the code itself (ISO 3166-1 alpha-2 is what
`Intl.DisplayNames` region accepts; the actual code format returned by the server is not provable from the bundle).
Subdivisions are not used by the stats UI at all: `/geolocation/subdivisions?countryAlpha2=` exists only at
`main:27604` in an unrelated service, and chunks 729/381 contain no reference to it.

### 4.8 Line charts (`app-stats-line-chart`, `main:20328-20417`)

Union of all `bucket`s (as numbers) sorted asc; if more than `maxPlotPoints` (default 90) buckets, consecutive
buckets are merged in groups of `ceil(n/90)` and summed (default aggregate `"sum"`). X labels use **UTC**
month/day of `new Date(bucket)`; the Audience tab never passes `granularity`, so labels are always day-style.
Chart is "empty" when the sum of |values| is 0.

### 4.9 Discovery card totals — see §5.4 / §7.

---

## 5. Enumerations and constants (resolved)

### 5.1 Source enum `S.EL` / `M.EL` (module 906, `main:27297`)

| code | const | media label (`sourceLabel`, table `ne`, `main:27009`) | stringId | profile label (`profileSourceLabel`, table `ce`) | stringId |
|---|---|---|---|---|---|
| 0 | `FYP` | For You | `fansly_creator_stats_source_0` | For You | `fansly_creator_stats_profile_source_0` |
| 1 | `TIMELINE` | Timeline | `fansly_creator_stats_source_1` | **Direct** | `fansly_creator_stats_profile_source_1` |
| 2 | `SUGGESTIONS` | Suggestions | `fansly_creator_stats_source_2` | Suggestions | `fansly_creator_stats_profile_source_2` |
| 3 | `SEARCH` | Search | `fansly_creator_stats_source_3` | Search | `fansly_creator_stats_profile_source_3` |
| 4 | `OTHER` | Other | `fansly_creator_stats_source_4` | Other | `fansly_creator_stats_profile_source_4` |

Unknown codes → "Other" in both tables (`main:27211-27222`).
`M.Bs = [0, 1, 4]` = the options of every `app-stats-source-switch` (media surfaces selectable in the UI).
`M.kT = -1` ("all sources" sentinel, used only by the media-detail modal `729:858`).
On the Audience tab: the geo source switch uses the **media** table (0/1/4); the visit-sources table uses the
**profile** table for whatever codes the server returns in `profile.bySource[].source`.

### 5.2 Other module-906 enums (for completeness; none is sent by the Audience tab)

- `M.$t` series families for `GET /account/stats/series?family=`: `VIEWS "views"`, `PROFILE "profile"`,
  `FOLLOWS "follows"`, `SUBSCRIPTIONS "subscriptions"`, `REVENUE "revenue"`. In the stats chunk only `REVENUE`
  (`729:1716-1742`, `1856`) and `VIEWS` (`729:1963`) are actually requested; `profile`/`follows`/`subscriptions`
  families are defined but never requested by chunk 729 — the Audience tab gets those series embedded in `/summary`.
- Granularity strings seen: `"hour"`, `"day"`, `"month"`; `granularityForWindow(w) = w.days > 400 ? "month" : "day"`
  (`main:27106-27108`) — not used by the Audience tab.
- `M.qq = { IMAGE: 1, VIDEO: 2 }`, `M.k6 = { VIEWER_FILTER: 1, POST_TAG: 2 }`,
  `M.mM = { views, uniqueViewers, watchMs, completedViews, watchLift }`, `M.Fy = { netMills, grossMills, transactions }`.

### 5.3 Facade constants (`main:27009`)

`Z2 = [7, 30, 90]` (period presets), day `O = 864e5`, `tO = 400`, `Hc = ceil((Date.now() − 1561494359539)/day)`
(lifetime days; the stats shell does not enable the "Lifetime" button — `allowLifetime` is not bound, `729:2108`).

### 5.4 Discovery card constants (`729:14`, `729:24-76`)

| key | tracking-link match | label | stringId |
|---|---|---|---|
| `fyp` | `type === 1` and `String(internalId) === "1"` | For You | `fansly_creator_stats_discovery_source_fyp` |
| `suggestions` | `type === 1`, `internalId "2"` | Suggestions | `fansly_creator_stats_discovery_source_suggestions` |
| `search` | `type === 1`, `internalId "3"` | Search | `fansly_creator_stats_discovery_source_search` |
| `links` | every link with `type !== 1`, **first 30 only** in response order, summed | Your links | `fansly_creator_stats_discovery_source_links` |

(`type === 1` = Fansly-internal links, corroborated by the legacy tracking-link page `main:85882`, which also treats
`type === 1000` as user-created links.)

Geo: `limit = 10`; geo metric values `"views" | "watch" | "visits"`.

---

## 6. Interactions and the requests they cause

| interaction | code path | requests re-issued on the Audience tab |
|---|---|---|
| Open tab | `Xt.ngOnInit → load()`; `Ot.ngOnInit → load()` | #1 summary, #2 geo, #3 links, #4/#5 per link |
| Period preset 7/30/90 | shell `setPeriod` (`729:2072`) → facade `setPeriod` (`main:27042-27048`) → `onWindowChange` | all (new `after`/`before`/span). No-op if same preset and the UTC day did not roll |
| Custom range | shell `setRange({from,to})` → facade `setRange` (`main:27049-27051`) → `onWindowChange` | all |
| Refresh button | facade `refresh()` (`main:27052-27054`): `onWindowChange` **and** `onRefresh` | summary + geo once; discovery `load()` runs twice (second supersedes via `loadToken_`), `/trackinglinks` is hit twice; link stats served from the 60 s cache when fresh |
| Tab hidden ≥ 5 min then visible | `onVisibilityChange_` (`729:2084-2089`, `3e5` ms) → `refresh()` | same as refresh |
| Geo source switch (For You / Timeline / Other) | `Xt.setSource` → facade `setSource` (`main:27055-27057`) → `onSourceChange` → `loadGeo()` | **only #2** with new `source`. Changes the global source for other tabs too |
| Geo metric segmented (Views / Watched / Profile visits) | `setGeoMetric` (`729:248-250`) → `buildGeoRows_()` | **none** (re-renders from the cached geo response) |
| "Tracking links" / "Manage links" header links | router link `/creator/trackinglinks` (query params preserved) | navigation only |

There is no "show more", pagination, sorting or CSV export on the Audience tab. Stale responses are dropped by
`loadToken_` / `geoToken_` counters.

---

## 7. Tracking links (discovery card)

### 7.1 `GET /trackinglinks` → `response` = array of link models (`729:26-35`)

Fields read: `type` (number; `1` = internal), `internalId` (stringified for matching `"1"|"2"|"3"`), `id`
(passed as `trackingLinkId`). Nothing else is read here.

Selection: internal links matching the three `internalId`s (each only if present) + up to 30 non-internal links.
If no link is selected → empty totals. So one card load = 1 + 2 × (≤ 33) requests.

### 7.2 `GET /trackinglinks/stats` → `response` = array of rows (`main:36936-36945`)

| field | type | use |
|---|---|---|
| `timestamp` | epoch ms (parsed with `parseInt`) | bucket assignment |
| `clicks`, `claims`, `follows`, `subscriptions` | numbers | summed into current / previous totals |

### 7.3 `GET /trackinglinks/revenuestats` → array of rows (`main:36946-36955`)

| field | type | use |
|---|---|---|
| `timestamp` | epoch ms | bucket assignment |
| `totalGross` | number (unit UNRESOLVED) | summed into `gross` — aggregated but **never displayed** by the card |

Both calls must succeed: any error → card error state (`729:42`).

### 7.4 Bucketing and totals

Client cache (`main:36912`, `36988-37005`): per service instance, 40 entries, key `linkId|overwriteAccountId`
+ span; a loaded entry whose span covers the requested one is reused for **60 s**; in-flight requests are shared.
Rows are then filtered to `after < timestamp < before` (both strict, `main:37006-37013`).

```
growthBucketIndex_(ts, w)     main:37029-37034
  ts <= w.spanAfter                          → ignored
  j = round((ts − w.splitAt)/day) − 1
  0 <= j < w.days                            → current window (day index j)
  otherwise                                  → previous window
```

Card totals (`729:55-63`): per key `{current, previous}` each `{clicks, claims, follows, subscriptions, gross}`,
summed over the key's links. Rows (`729:64-76`): one per key (fyp, suggestions, search, + links when any custom link
exists) with `value = current.follows`, `delta = build(current.follows, previous.follows)`; sorted by value desc;
if no key has `follows > 0` in either window the table is emptied (empty text shown).
Only `follows` reaches the screen; clicks/claims/subscriptions/gross are computed and discarded.

---

## 8. Open questions / UNRESOLVED

1. **`before` inclusivity.** The client sends `before = currentEnd` = UTC midnight of the *last day* and treats it as
   an inclusive day bucket (`days = (end−start)/day + 1`). Whether the server includes that whole day for
   `/account/stats/summary` and `/geo` cannot be proven from the bundle. Supporting (not conclusive) evidence: the
   Overview "Right now" card requests hourly views with `before = today's UTC midnight` (`729:1963`) and then expects
   rows up to the current hour (`729:1981`), which only works if `before` covers the whole day bucket.
2. **Previous window on the server.** `/summary` returns `previous` per metric although only `after`/`before` are
   sent. The UI caption shows `previousStart..previousEnd` = the equal-length window immediately before; that the
   server uses the same window is an assumption.
3. **Series buckets in `/summary`** (`profile.series.*`, `follows.series.*`, `subscriptions.series.*`): the client only
   does `new Date(Number(bucket))` and prints UTC month/day; daily UTC alignment and the behaviour for very long
   custom ranges (day vs month buckets) are not provable. `levels[]` items: only `followerCount`/`subscriberCount`
   are read here; their timestamp field name and cadence ("nightly snapshot" per UI text) are unknown from this tab.
4. **Geo**: format/case of `country` (client upper-cases it; ISO alpha-2 assumed), server-side ordering of `rows` and
   `profileRows` (client keeps server order), whether `limit=10` applies to both arrays, whether `profileRows`
   depends on `source`, and the scale of `avgWatchPercent` (0-100 inferred from `Math.round(x) + "%"`).
5. **`profile.bySource`**: which source codes the server actually returns and the exact meaning of code 1 for
   profile visits (labelled "Direct" here vs "Timeline" for media) are not provable.
6. **Tracking links**: meaning of `type` values other than `1` (only `1000` is visible elsewhere); alignment of
   stats-row `timestamp`s (a non-midnight timestamp on the last day would round to index `days` and be counted as
   *previous* by `growthBucketIndex_`); unit of `totalGross`.
7. **Response fields not read** by the client are invisible to static analysis; the full schemas of `/summary` and
   `/geo` may contain more.
8. Whether `overwriteAccountId` is honoured for arbitrary accounts (the client only forwards the page's query param).

---

## 9. Appendix — heatmap / hour bars (defined in lines 337-558, NOT on the Audience tab)

Embedding (grep of all bundles): `app-stats-heatmap` only in the **Content** route template (`729:1222`);
`app-stats-hour-bars` in the **media-detail modal** (`729:681-685`) and the **Overview** "Right now" card
(`729:1900`). `app-stats-discovery-card` only in the Audience route (`729:229`).

### 9.1 `app-stats-heatmap` (`729:397-447`)

- Input `values`: 7 × 24 matrix `values[day][hour]`, day index **0 = Sun … 6 = Sat** (`it`, `729:397`); rows are
  displayed Mon→Sun (`at = [1,2,3,4,5,6,0]`). Hour header labels every 6 h (`"00:00"`, `"06:00"`, …).
- `intensity = value / max(all cells)`; cell opacity `value ? 0.12 + 0.88*intensity : 1` (+ class `empty`).
- "Best time": `peak` = the cell with the highest value, first one in display order on ties (strict `>`), shown as
  "Busiest hour" (`fansly_creator_stats_heatmap_peak`) `"{Day} {HH}:00 · {shortNumber(value)}"`; hover/focus/click
  shows that cell's `"{Day} {HH}:00  {value} Views"`. `hasData = max > 0`, else "No data in this period."
- **No client-side time-zone shifting or bucketing** — the matrix is used as delivered.

Data source (Content tab, card "When your audience watches" / `fansly_creator_stats_content_hours_title`, desc
"Views on this surface by weekday and hour in your time zone."):

```
Cn.loadActiveHours()  729:1347-1352 → facade.getActiveHours(source, cb)  main:27090-27092
 → GET /account/stats/activehours?source={source}&after={currentStart}&before={currentEnd}
       &timezoneOffsetMinutes={-(new Date()).getTimezoneOffset()}[&overwriteAccountId=…]
```

`timezoneOffsetMinutes` sign: **minutes east of UTC** (UTC+3 → `180`, UTC−5 → `-300`); the shift to local time is
done server-side. Response fields read (`buildHeat_`, `729:1275-1288`): `views[day][hour]`, `imageViews[day][hour]`;
cell = `views` when source is FYP or media type = VIDEO (2), `imageViews` when IMAGE (1), `views + imageViews` when
"All" (0). Triggered by window change, source change (`729:1359-1361`); media-type toggle only rebuilds.

### 9.2 `app-stats-hour-bars` (`729:509-558`)

- Inputs: `points [{bucket (hour-aligned epoch ms), value}]`, `hours` (default 48), `endBucket` (default
  `floor(now/1h)*1h`). Bars for every hour from `end − (hours−1)h` to `end`; duplicate buckets summed.
- `heightPercent = value ? max(4, value/max*100) : 2`; `isPeak = value > 0 && value >= 0.75*max`;
  `peak` = highest bar (first on ties) → "Busiest hour"; bar labels in **browser local time** `"Ddd HH:MM"`;
  empty text "No views in the last 48 hours." (`fansly_creator_stats_hours_empty`).
- Overview feed (`729:1963-1985`): `GET /account/stats/series?family=views&granularity=hour&after={todayUTC−3d}&before={todayUTC}`
  (`todayUTC = floor(now/day)*day`), response `rows[] {source, hourBucket, views}` filtered by the card's own source,
  last 48 h; plus `GET /account/stats/media/shown?end=0&hours=24` (facade passes literal `0` for `end`,
  `main:27084-27086`; `0` is not dropped by `get_`), response `rows[] {source, mediaShown, previousMediaShown}`.
- Modal feed (`729:938-943`): `best.media.hours[] {hourBucket, views}` from `GET /account/stats/media`.

(These two feeds belong to the Overview/Content slices; listed here only to show where the components get data.)
