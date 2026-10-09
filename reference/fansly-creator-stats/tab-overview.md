# Fansly creator stats — SHELL + OVERVIEW tab (static read of web bundles, 2026-10-08)

Method: static text reading only. Nothing executed, no network requests. Every statement below is
backed by a `file:line` reference; anything not provable from the code is tagged **UNRESOLVED** or
**(inferred)**.

File aliases used in references:

| alias | file |
|---|---|
| `729:` | `analysis/729.d14b4c5910bebc74.pretty.js` (lazy stats chunk, webpack module 8729) |
| `381:` | `analysis/381.3db514b57dd6c2e7.pretty.js` (shared chunk, `app-stats-card`) |
| `main:` | `analysis/main.2e6b96097a4bb73b.pretty.js` |


---

## 0. Transport facts that apply to every call below

- Base URL: `https://apiv3.fansly.com/api/v1` (`apiBaseUrl`, main:37841; used at main:26952).
- All 12 stats endpoints are `GET` and built by one helper `get_(path, params, cb)` (main:26954-26966):
  - params are appended in **object-literal key order**; a param is **omitted when its value is `null`/`undefined` or `""`**
    (`null == te || "" === te`); `0` is NOT omitted (so `source=0`, `end=0` are sent).
  - each value is `encodeURIComponent(String(value))`.
  - no body (`new G.Kd("GET", url, null)`).
- Response envelope: `{ success, response, error: { details } }`. On `success` the callback receives `body.response`;
  otherwise the error string is `error.details` or the literal `"error getting statistics"` (main:26961-26965).
- Interceptors on the request:
  - per-call auth interceptor: header `authorization: <active session token>`, `withCredentials: true` (main:26082-26084).
  - global interceptor (registered main:25717): headers `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`,
    `fansly-client-check` (main:25671-25687).
  - global interceptor (registered main:25717): appends `ngsw-bypass=true` to the query string of every URL
    (main:25690-25697). So the wire URL is e.g. `/account/stats/summary?after=…&before=…&ngsw-bypass=true`.
- No client-side caching of stats responses: every `load()` refetches (only the tracking-link calls used by the
  discovery card have a cache, see 2.S3).
- Route: `/creator/stats` lazy-loads chunks 381 + 729 (`CREATOR_STATS_ROUTES`), main:104490. Parent `/creator` route
  guards: `dr` (must be authorized, main:61747-61750) and `Dm` (active account `isModel()`, main:62180-62184);
  declared on the `creator` route in main:104486. The stats route itself has no extra guard.
- Child routes (729:2118): `""` → redirect `overview`; `overview` → `app-creator-stats-overview-route`;
  `content`; `audience`; `earnings`; `**` → redirect `""`.
- The runtime chunk map lists only chunks 189, 294, 381, 729, 795 (`raw/runtime.f973459b9af62fd8.js`), all of
  which were downloaded, so "no caller found" below means no caller in the whole web app build.

---

## 1. Shell (`app-creator-stats-route`, 729:2060-2117)

The shell owns the header, the global period control, the refresh button, the beta notice, the tab bar and the
`<router-outlet>`. All state lives in the root-singleton facade `CreatorStatsService` (webpack module 804, export
`po`, main:27010-27294, `providedIn: "root"` main:27293), so period/source survive tab switches and even leaving
the stats page.

### 1.1 Facade state and defaults (main:27013-27015)

| field | default | notes |
|---|---|---|
| `periodDays_` | `30` | `null` when a custom range (or month) is active |
| `window_` | `trackingLinkService_.buildGrowthWindow(30)` | built in the constructor |
| `source_` | `S.EL.FYP` = `0` | global "surface" selection |
| `overwriteAccountId_` | `""` | see 1.6 |
| emitters | `onWindowChange`, `onSourceChange`, `onRefresh` | custom emitter class (main:3-…, module 4505) |

### 1.2 Global controls, in on-screen order (template 729:2110-2116)

| # | control | default English text | stringId | behaviour |
|---|---|---|---|---|
| 1 | title | `Statistics` | `fansly_creator_stats_title` | static |
| 2 | tag | `Beta` | `fansly_beta_tag` | static |
| 3 | description | `How your content, audience and earnings develop over time. Every number compares the selected period with the one before it. Numbers update within minutes; follower and subscriber counts update nightly.` | `fansly_creator_stats_desc` | static |
| 4 | period selector `app-growth-period-selector` (main module 5351, main:20695-20736) with `[options]=d.Z2=[7,30,90]`, `[periodDays]`, `[window]`, `[allowCustom]=true`; `allowLifetime` not bound → `false` (729:2116) | buttons `7 days`, `30 days`, `90 days`; `Custom` | `fansly_profile_stats_overview_period_7` / `_30` / `_90` (built as `"fansly_profile_stats_overview_period_" + N`, main:20625); `fansly_profile_stats_overview_period_custom` (main:20653) | `periodChange` → shell `setPeriod` (729:2072) → facade `setPeriod`; `rangeChange` → shell `setRange` (729:2075) → facade `setRange` |
| 4a | period caption (below the buttons, main:20656-20693) | current range `MMM d – MMM d` (UTC); when custom is active it is a clickable button `MMM d, y – MMM d` that reopens the picker; then `vs` + previous range `MMM d – MMM d` | `fansly_profile_stats_overview_vs` | display only; uses `window.currentStart/currentEnd/previousStart/previousEnd` formatted in `"UTC"` |
| 5 | refresh button (`aria-label="Refresh"`, icon `arrows-rotate`, `[spin]=refreshing`) | — | — (no stringId) | shell `refresh()` (729:2078-2083) |
| 6 | beta notice title | `Statistics are in beta` | `fansly_creator_stats_beta_title` | static |
| 7 | beta notice text | `Past For You Page interactions are still being backfilled, so views, watch time and hashtag numbers may only cover a limited timeframe for now and will fill in over time. Earnings are complete. We are open for feedback and suggestions, so tell us what you think through Support.` | `fansly_creator_stats_beta_desc` | static |
| 8 | legacy link → `/creator/profilestats` | `View the legacy For You charts` | `fansly_creator_stats_beta_legacy_link` | shown only if `showLegacyProfileStatistics()` (729:2069-2071) = active account `createdAt < Date.UTC(2026, 8, 21)` i.e. before 2026-09-21T00:00:00Z = `1789948800000` (module 1332, main:136-143) |
| 9 | tabs (each `routerLink` + `queryParamsHandling="preserve"`, consts 729:2109) | `Overview`, `Content`, `Audience`, `Earnings` | `fansly_creator_stats_tab_overview`, `…_tab_content`, `…_tab_audience`, `…_tab_earnings` | `/creator/stats/overview`, `/creator/stats/content`, `/creator/stats/audience`, `/creator/stats/earnings` |

There is **no global source switch in the shell**. The surface switch (`app-stats-source-switch`) is rendered inside
individual cards (on Overview: "Right now" card and "Top media" card, see section 2). The facade nevertheless holds
one global `source_` shared by all tabs (main:27055-27057).

Custom range picker (`pickCustomRange`, main:20707-20716):
- opens a date-only modal (`setDateOnly(true)`, `setAllowPastDates(true)`, main:20717-20720) titled `Start date`
  (`fansly_creator_stats_range_start`), initial value = local-day of `window.currentStart`
  (`bucketToLocalDay_`, main:20721-20724) or `Date.now() - 25056e5` (29 days) when there is no window;
- when the first modal closes with a value, opens a second one titled `End date` (`fansly_creator_stats_range_end`),
  initial value `max(local-day of window.currentEnd, start)`;
- emits `{ from: <start timestamp>, to: <end timestamp> }` (main:20713). The timestamps are whatever the date modal
  reports as `selectedTimestamp` (main:3664); only their **local calendar day** matters (see 1.3).

Month selection: there is no month control in the shell itself. A month is selected from the *Monthly statements*
widget on the Earnings tab ("View month"), which calls `creatorStatsService_.setRange(d.po.monthRange(row.bucket))`
(729:1674-1675) — i.e. it replaces the **global** window, exactly like a custom range. The same helper is used inside
the supporter modal (main:20183-20184), but there it only changes the modal's private window.
`monthRange(bucket)` = `{ from: new Date(y, m, 1, 12).getTime(), to: new Date(y, m + 1, 0, 12).getTime() }` with
`y`/`m` taken from the bucket in UTC (main:27147-27150) → after `setRange` this becomes "UTC-midnight of the 1st …
UTC-midnight of the last day of that month, clamped to today". `isMonthWindow(window, bucket)` (main:27151-27155)
tells whether the active window is exactly that month: `currentStart === bucket && currentEnd === min(Date.UTC(y, m+1, 0), todayUtcMidnight)`.

### 1.3 Exact window math

All in `TrackingLinkService` (webpack module 7511, export `F`), day constant `p = 864e5` (main:36907).

```
todayBucket_()            = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())      // main:37021-37024
localDayBucket_(ts)       = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())  with d = new Date(ts) // main:37025-37028
                            (LOCAL calendar day of ts, re-expressed as UTC midnight)

buildGrowthWindow(days)                                                                              // main:36914-36917
    T = todayBucket_()
    return buildWindow_(T - (days - 1) * 864e5, T)

buildGrowthWindowForRange(from, to)                                                                  // main:36918-36925
    R = localDayBucket_(from); j = localDayBucket_(to); B = todayBucket_()
    if (j < R) swap(R, j)
    if (j > B) j = B              // end clamped to today (UTC day)
    if (R > j) R = j              // start clamped to end
    return buildWindow_(R, j)

buildWindow_(start, end)                                                                             // main:37017-37020
    days          = Math.round((end - start) / 864e5) + 1
    previousEnd   = start - 864e5                 (also exposed as splitAt)
    previousStart = start - days * 864e5
    return { days, currentStart: start, currentEnd: end, previousStart, previousEnd,
             splitAt: start - 864e5,
             spanBefore: end + 864e5,
             spanAfter:  start - (days + 1) * 864e5 }
```

Facts:
- `currentStart`/`currentEnd` are **UTC-midnight epoch milliseconds of the first and the last day of the window; both
  are day buckets, the end is the bucket of the last included day (today for presets), not an exclusive bound.**
- `days` counts both ends (30-day preset → `currentEnd - currentStart = 29 days`).
- Preset example for "today" = 2026-10-08 UTC, 30 days: `currentStart=1788912000000` (2026-09-09),
  `currentEnd=1791417600000` (2026-10-08), `previousStart=1786320000000` (2026-08-10),
  `previousEnd=1788825600000` (2026-09-08), `spanBefore=1791504000000`, `spanAfter=1786233600000`, `days=30`.
- The stats API calls send only `after=currentStart` and `before=currentEnd`. `previousStart/previousEnd` are **never
  sent to `/account/stats/*`**; they are used for the caption (1.2 #4a) and, via `spanBefore/spanAfter/splitAt`, by the
  tracking-link growth helper (2.S3). The "previous" numbers of the stats API come back from the server as
  `{ value, previous }` pairs (section 4).
- Custom ranges are picked in the browser's **local** calendar and converted to UTC-midnight of the same Y-M-D.
- Day rollover: `refreshWindow_()` (main:27025-27029) rebuilds a preset window when
  `window_.currentEnd !== Math.floor(Date.now() / 864e5) * 864e5`; it does nothing when `periodDays_` is `null`
  (custom range/month stays frozen). It is called by `getWindow()`, `setPeriod()` and `refresh()`.

### 1.4 Facade mutators (main:27042-27057)

- `setPeriod(days)`: if same preset and a window exists → `refreshWindow_()`; emits `onWindowChange` only if the window
  object was actually rebuilt (UTC day changed). Otherwise sets `periodDays_`, builds `buildGrowthWindow(days)` and emits
  `onWindowChange(window)`. (The selector itself only emits when the value differs, main:20704-20706.)
- `setRange({from,to})`: `periodDays_ = null`, `window_ = buildGrowthWindowForRange(from, to)`, emits `onWindowChange`.
- `refresh()`: `refreshWindow_()`, then emits **both** `onWindowChange(window_)` and `onRefresh(Date.now())`.
- `setSource(src)`: if changed → store and emit `onSourceChange(src)`.
- `buildWindow(days)` / `buildWindowForRange({from,to})`: pure builders, no state change (used by the modals).

### 1.5 What re-triggers loads

Shell (729:2078-2107):
- Period button / custom range → facade `setPeriod`/`setRange` → `onWindowChange`.
- Refresh button → shell `refresh()` → facade `refresh()` (both emitters) + 1 s spinner (`setTimeout(…, 1e3)`).
- `document` `visibilitychange`: on `hidden` stores `hiddenAt_ = Date.now()`; on return, if hidden for
  `>= 3e5` ms (5 min) → `refresh()` (729:2084-2089).
- Router events only cause `refreshUi()` (729:2096-2098), no reload.
- The shell itself issues **no API request**.

Overview subscriptions (729:2032-2043):

| event | handler | requests fired |
|---|---|---|
| `ngOnInit` | `load()` + `loadRealtime()` | summary, fans/top, media/top, media/benchmarks, series(views,hour), media/shown |
| `onWindowChange` | `load()` | summary, fans/top, media/top, media/benchmarks |
| `onSourceChange` | `loadTopMedia()` | media/top, media/benchmarks |
| `onRefresh` | `loadRealtime()` (non-silent) | series(views,hour), media/shown |
| `setInterval(…, 6e4)` | `loadRealtime(true)` (silent) **only if** `document.visibilityState === "visible"` | series(views,hour), media/shown |
| "Right now" source switch | `setRealtimeSource()` → `applyRealtime_()` (729:1958-1960) | none (re-slices cached rows) |

So the refresh button on Overview fires all 6 requests (because `refresh()` emits both emitters). Stale responses are
dropped by counters `loadToken_`, `mediaToken_`, `benchmarksToken_`, `realtimeToken_`.

### 1.6 Account override `overwriteAccountId`

- Origin: URL query parameter of the stats page, read **once** in the shell's `ngOnInit`:
  `this.route_.snapshot.queryParamMap.get("overwriteAccountId")` → `creatorStatsService_.setOverwriteAccountId(i)`
  (729:2094-2095). Reset to `""` in the shell's `ngOnDestroy` (729:2104).
- Kept across tabs and "See all" links by `queryParamsHandling="preserve"` (tab links 729:2109; card links 381:67,
  consts entry `["queryParamsHandling", "preserve", 1, "stats-card-link", 3, "routerLink"]`).
- Sent as query param `overwriteAccountId=<id>` on all 12 `/account/stats/*` endpoints (main:26968-27001; omitted when
  `""`), on `/trackinglinks`, `/trackinglinks/stats`, `/trackinglinks/revenuestats` (main:36850, 36860, 36870) and on
  `/account/wallets/earnings/transactions/accounts` (main:37553).
- Client-side effect besides the param: Earnings tab hides "Recent purchases" when an override is set
  (`showPurchases = !getOverwriteAccountId()`, 729:1872).
- Who may use it: **UNRESOLVED**. There is no client-side role check, and no code in any downloaded bundle generates a
  link carrying this param (all occurrences listed: main:26968-27101, 36850-36870, 37553, 62242, 62781, 63125 and
  729:2094). Authorization is necessarily server-side.

---

## 2. Overview tab (`app-creator-stats-overview-route`, 729:1946-2054) — widgets in on-screen order

Template: 729:2051-2053 (root) and 729:1890-1944 (embedded views). Constants: `L = 36e5`, `W = 24 * L` (729:1945).

### W1. Card "Right now" (`app-stats-card`, class `realtime`, `[loading]=loadingRealtime`)

| item | default English | stringId |
|---|---|---|
| heading | `Right now` | `fansly_creator_stats_realtime_title` |
| description | `Video views on this surface in your time zone, not affected by the period above. The last 24 hours compare with the 24 before, today with yesterday up to this hour, yesterday with the day before. Media shown counts the different videos this surface put in front of someone in the last 24 hours.` | `fansly_creator_stats_realtime_desc` |
| card action: `app-stats-source-switch` `[source]=realtimeSource` (default `0`), options default `M.Bs = [0, 1, 4]` | `For You`, `Timeline`, `Other` | `fansly_creator_stats_source_0`, `_1`, `_4` |
| error state | `Statistics could not be loaded right now.` | `fansly_creator_stats_error` |
| tile (icon `clock`, compact) | `Last 24 hours` | `fansly_creator_stats_realtime_last_24h` |
| tile (icon `sun`, compact) | `Today so far` | `fansly_creator_stats_realtime_today` |
| tile (icon `moon`, compact) | `Yesterday` | `fansly_creator_stats_realtime_yesterday` |
| tile (icon `photo-film`, compact) — only when `realtimeMediaShown` is non-null | `Media shown, 24h` | `fansly_creator_stats_realtime_media_shown` |
| `app-stats-hour-bars` `[points]=realtimePoints` `[hours]=realtimeHours (48)` (729:509-556) | caption `Busiest hour` + `<label> · <n>`; hover caption `<label> <n> Views`; empty `No views in the last 48 hours.` | `fansly_creator_stats_heatmap_peak`; `fansly_creator_stats_media_views`; `fansly_creator_stats_hours_empty` |

The source switch here is **local** to the card (`setRealtimeSource`, 729:1958) — it does not touch the facade source
and triggers no request.

### W2. Main section state

`loadError` → message `Statistics could not be loaded right now.` (`fansly_creator_stats_error`);
before the first successful load → 8 skeleton tiles (`skeletonTiles = [0..7]`); afterwards the blocks below
(729:2053, branch `i.loadError ? 4 : i.hasLoaded ? 6 : 5`).

### W3. Tile grid — 8 `app-growth-stat-tile` (main module 9039, main:20782-20886), `[periodDays]=window.days`

| # | icon | label | stringId | `metric` | sparkline `series` | format |
|---|---|---|---|---|---|---|
| 1 | `coins` | `Earnings` | `fansly_creator_stats_tile_earnings` | `earnings` | `earningsSeries` | `isBalance` |
| 2 | `sparkles` | `Views on For You` | `fansly_creator_stats_tile_views_fyp` | `viewsFyp` | `viewsFypSeries` | count |
| 3 | `newspaper` | `Views on Timeline` | `fansly_creator_stats_tile_views_timeline` | `viewsTimeline` | `viewsTimelineSeries` | count |
| 4 | `eye` | `Unique viewers on For You` | `fansly_creator_stats_tile_unique_viewers_fyp` | `uniqueViewersFyp` | `[]` (none) | count |
| 5 | `user` | `Profile visits` | `fansly_creator_stats_tile_profile_visits` | `profileVisits` | `profileVisitsSeries` | count |
| 6 | `user-plus` | `Follower growth` | `fansly_creator_stats_tile_net_follows` | `netFollows` | `netFollowsSeries` | count |
| 7 | `star` | `New subscribers` | `fansly_creator_stats_tile_new_subscribers` | `newSubscribers` | `newSubscribersSeries` | count |
| 8 | `users` | `Paying fans` | `fansly_creator_stats_tile_paying_fans` | `payingFans` | `[]` (none) | count |

Tile chrome strings (main:20835-20850, 20547-20570): `vs previous` (`fansly_profile_stats_overview_vs_previous`) +
`<periodDays>` + `days` (`fansly_profile_stats_overview_days`); `No data in the previous period`
(`fansly_profile_stats_overview_no_previous`); pill `New` (`fansly_profile_stats_overview_new`). No controls.

### W4. Two line-chart cards (`div.stats-grid.two`)

| card heading | stringId | description | desc stringId | chart input |
|---|---|---|---|---|
| `Total followers` | `fansly_creator_stats_levels_followers` | `Your count at the end of each day.` | `fansly_creator_stats_levels_desc` | `[series]=followerLevels` |
| `Subscribers` | `fansly_creator_stats_levels_subscribers` | `Your count at the end of each day.` | `fansly_creator_stats_levels_desc` | `[series]=subscriberLevels` |

Chart = `app-stats-line-chart` (main module 4260, main:20279-20428); empty text `Levels appear after the first nightly
snapshot.` (`fansly_creator_stats_levels_empty`). Series legend labels (only rendered when a chart has more than one
series, so not visible here): `Followers` (`fansly_creator_stats_levels_followers`), `Subscribers`
(`fansly_creator_stats_levels_subscribers`) (729:2005). No controls.

### W5. Card "Top media" (`[loading]=loadingMedia`)

| item | default English | stringId |
|---|---|---|
| heading | `Top media` | `fansly_creator_stats_top_media_title` |
| description | `Your best performing media on this surface in the period.` | `fansly_creator_stats_top_media_desc` |
| link → `/creator/stats/content` | `See all` | `fansly_creator_stats_see_all` |
| card action: `app-stats-source-switch` `[source]=source`, options `[0,1,4]` → `setSource()` → facade `setSource` (global) | `For You` / `Timeline` / `Other` | `fansly_creator_stats_source_<n>` |
| `app-stats-media-list` `originId="creator_stats_overview"` `[limit]=3` `[selectable]=true` (729:1098-1146) | per-row metric labels `Views`, `Unique viewers`, `Avg. watch`, `Completion`, `Likes`; empty `No data in this period.` | `fansly_creator_stats_media_views`, `fansly_creator_stats_media_unique`, `fansly_creator_stats_media_avg_watch`, `fansly_creator_stats_media_completion`, `fansly_creator_stats_media_likes`, `fansly_creator_stats_empty` |

Row click → `openMedia(offer)` (729:1987-1990) opens `app-stats-media-detail-modal` with `setOffer(offer, this.source)`.
Row "open post" icon → `/post/<postId>`.

### W6. Card "Top supporters" (`[loading]=loading`)

| item | default English | stringId |
|---|---|---|
| heading | `Top supporters` | `fansly_creator_stats_top_supporters_title` |
| description | `Fans who earned you the most this period. Tap one for the breakdown.` | `fansly_creator_stats_top_supporters_desc` |
| link → `/creator/stats/earnings` | `See all` | `fansly_creator_stats_see_all` |
| `app-stats-fan-list` `[limit]=5` `[selectable]=true` (729:1425-1453) | `purchase`/`purchases`; `since`; `refund`/`refunds`; empty `No data in this period.` | `fansly_creator_stats_fan_transaction` / `…_fan_transactions`; `fansly_creator_stats_fan_since`; `fansly_creator_stats_fan_refund` / `…_fan_refunds`; `fansly_creator_stats_empty` |

Row click → `openFan(row)` (729:1991-1994) opens `app-stats-fan-detail-modal` (main module 2980) with `setFan(row)`.

### W7. Data-since note (only if `dataSinceInWindow`)

`Statistics are collected since` (`fansly_creator_stats_data_since`) + `dataSince | date:'MMM d, y':'UTC'` (729:1917-1922).

### Shared widgets in my line ranges that are NOT rendered on Overview

- **S1 `app-stats-segmented`** (729:110-130): generic pill group. Inputs `options` (`[{ value, label, labelStringId }]`),
  `value`; output `valueChange` (emits `option.value` only when it differs from `value`). Used on Audience (729:225),
  media modal (729:787), Content (729:1182-1222), Earnings (729:1636).
- **S2 `app-stats-source-switch`** (729:146-170): inputs `source` (default `0`), `options` (default `M.Bs = [0,1,4]`);
  output `sourceChange` (emits the numeric source only when it differs). Label = `po.sourceLabel(n)`, stringId =
  `"fansly_creator_stats_source_" + n` (729:155-160, main:27211-27216).
- **S3 `app-stats-discovery-card`** (729:15-93) — rendered on the **Audience** tab (729:229), not on Overview.
  Documented in 3.7 because it lives in my range.
- **`app-stats-card`** (381:36-67): inputs `heading`, `headingStringId`, `desc`, `descStringId`, `linkLabel`,
  `linkStringId`, `linkRoute`, `loading`; content slots `[cardActions]` and default; the optional link is an
  `<a [routerLink] queryParamsHandling="preserve">`; `loading` only adds CSS class `is-loading`.

---

## 3. Call chains and query parameters (Overview)

`after`/`before` are `window_.currentStart` / `window_.currentEnd` from 1.3 unless stated otherwise.
`overwriteAccountId` = facade `overwriteAccountId_` (1.6), omitted when empty. Every URL additionally gets
`ngsw-bypass=true` (section 0).

### 3.1 Summary — tiles W3, charts W4, note W7

`Overview.load()` (729:2007-2021) → `creatorStatsService_.getSummary(cb)` (729:2013) → facade `getSummary`
(main:27064-27066) → API `getSummary(after, before, overwriteAccountId, cb)` (main:26967-26969) →

`GET /account/stats/summary?after=<currentStart>&before=<currentEnd>[&overwriteAccountId=<id>]`

| param | value / origin |
|---|---|
| `after` | `window_.currentStart` (UTC-midnight ms of first day) |
| `before` | `window_.currentEnd` (UTC-midnight ms of last day) |
| `overwriteAccountId` | optional |

Not wrapped in `aggregated_` (no `aggregationData` handling). `load()` first calls `getWindow()` (729:2009), which
rolls a preset window over a UTC-day change before the request.

### 3.2 Top supporters — W6

`Overview.load()` → `creatorStatsService_.getTopFans("netMills", 5, cb)` (729:2018) → facade `getTopFans(orderBy, limit, cb)`
(main:27096-27098) → API `getTopFans(after, before, orderBy, limit, overwriteAccountId, cb)` (main:26997-26999) →

`GET /account/stats/fans/top?after=<currentStart>&before=<currentEnd>&orderBy=netMills&limit=5[&overwriteAccountId=<id>]`

| param | value / origin |
|---|---|
| `after`, `before` | window |
| `orderBy` | literal `"netMills"` (hard-coded string on Overview; equals enum `Fy.NET`, main:27297) |
| `limit` | literal `5` |

Callback is wrapped in `aggregated_` (main:27016-27021).

### 3.3 Top media — W5

`Overview.loadTopMedia()` (729:2022-2031) → `creatorStatsService_.getTopMedia(this.source, null, "views", 3, cb)` (729:2024)
→ facade `getTopMedia(source, mediaType, orderBy, limit, cb)` (main:27073-27075) → API
`getTopMedia(source, mediaType, after, before, orderBy, limit, overwriteAccountId, cb)` (main:26973-26975) →

`GET /account/stats/media/top?source=<0|1|4>&after=<currentStart>&before=<currentEnd>&orderBy=views&limit=3[&overwriteAccountId=<id>]`

| param | value / origin |
|---|---|
| `source` | `creatorStatsService_.getSource()` — global facade source, default `0` (FYP); the Overview switch offers `0` For You, `1` Timeline, `4` Other |
| `mediaType` | `null` → **omitted** |
| `after`, `before` | window |
| `orderBy` | literal `"views"` (= enum `mM.VIEWS`) |
| `limit` | literal `3` |

Callback wrapped in `aggregated_`.

### 3.4 Watch benchmarks — verdict line in W5 rows

`Overview.loadTopMedia()` → `creatorStatsService_.getWatchBenchmarks(this.source, null, cb)` (729:2028) → facade
`getWatchBenchmarks(source, window, cb)` with `window = null → this.window_` (main:27080-27083) → API
`getWatchBenchmarks(source, after, before, overwriteAccountId, cb)` (main:26979-26981) →

`GET /account/stats/media/benchmarks?source=<0|1|4>&after=<currentStart>&before=<currentEnd>[&overwriteAccountId=<id>]`

Not wrapped in `aggregated_`. Error → `benchmarks = null` (no verdicts shown).

### 3.5 Realtime hourly views — W1 tiles 1-3 and the hour bars

`Overview.loadRealtime(silent)` (729:1961-1974) → `creatorStatsService_.getSeriesForRange(M.$t.VIEWS, "hour", o - 3 * W, o, cb)`
(729:1963) with `o = Math.floor(Date.now() / W) * W` (today's UTC midnight) → facade `getSeriesForRange(family, granularity, after, before, cb)`
(main:27070-27072) → API `getSeries(family, granularity, after, before, overwriteAccountId, cb)` (main:26970-26972) →

`GET /account/stats/series?family=views&granularity=hour&after=<todayUtcMidnight − 3 days>&before=<todayUtcMidnight>[&overwriteAccountId=<id>]`

| param | value / origin |
|---|---|
| `family` | `M.$t.VIEWS` = literal `"views"` (main:27297) |
| `granularity` | literal `"hour"` |
| `after` | `floor(now / 86400000) * 86400000 − 3 * 86400000` |
| `before` | `floor(now / 86400000) * 86400000` |

Independent of the selected period and of the facade source (all sources come back; filtered client-side).
Example on 2026-10-08: `after=1791158400000&before=1791417600000`.

### 3.6 Realtime "media shown" — W1 tile 4

`Overview.loadRealtime()` → `creatorStatsService_.getMediaShownHours(24, cb)` (729:1968) → facade
`getMediaShownHours(hours, cb)` → `api_.getMediaShownHours(0, hours, overwriteAccountId_, cb)` (main:27084-27086) → API
(main:26982-26984) →

`GET /account/stats/media/shown?end=0&hours=24[&overwriteAccountId=<id>]`

| param | value / origin |
|---|---|
| `end` | literal `0`, hard-coded in the facade (it is sent, because only `null`/`""` are dropped). Meaning of `0` (presumably "now") is **UNRESOLVED** |
| `hours` | literal `24` |

### 3.7 Discovery card (Audience tab; in my line range)

`DiscoveryCard.load()` (729:24-48), triggered on init, `onWindowChange` and `onRefresh` (729:77-84):

1. `trackingLinkService_.getAccountTrackingLinks(cb, overwriteAccountId)` → `GET /trackinglinks[?overwriteAccountId=<id>]`
   (main:36848-36857).
2. For every selected link: `trackingLinkService_.getTrackingLinkGrowth(link.id, window, cb, overwriteAccountId)`
   (main:36929-36957) → two calls through a per-link 60-second span cache (`loadSpanRows_`, main:36988-37005; cache
   `new e.d({ maxItems: 40, accessTimeout: 6e5 })`, main:36912):
   - `GET /trackinglinks/stats?trackingLinkId=<id>&before=<window.spanBefore>&after=<window.spanAfter>[&overwriteAccountId=<id>]` (main:36858-36867)
   - `GET /trackinglinks/revenuestats?trackingLinkId=<id>&before=<window.spanBefore>&after=<window.spanAfter>[&overwriteAccountId=<id>]` (main:36868-36877)

Link selection (729:29-35): links with `type === 1` are indexed by `String(internalId)` and only internalIds `"1"`
(key `fyp`), `"2"` (`suggestions`), `"3"` (`search`) are used (table `j`, 729:14); every link with `type !== 1` is a
"custom link", **capped at the first 30** returned, summed under key `links`.

Card strings: heading `Followers discovery brought you` (`fansly_creator_stats_discovery_follows_title`); description
`People who first reached you from For You, Suggestions or Search, or through one of your links, and then followed.
Credited to the source that brought them.` (`fansly_creator_stats_discovery_follows_desc`); link `Manage links` →
`/creator/trackinglinks` (`fansly_creator_stats_discovery_manage`); value column `Followed`
(`fansly_creator_stats_discovery_label_followed`); empty `Nobody who found you through discovery followed in this
period.` (`fansly_creator_stats_discovery_follows_empty`); rows `For You`, `Suggestions`, `Search`, `Your links`
(`fansly_creator_stats_discovery_source_fyp|suggestions|search|links`).

### 3.8 Modals reachable from Overview (summary only; they belong to other slices)

- **Supporter modal** (`app-stats-fan-detail-modal`, main module 2980, main:20146-20278), opened by W6 row click:
  - `load()` (main:20197-20205): `getFanRevenue(fanId, window, isMonthly ? "month" : "day", cb)` →
    `GET /account/stats/fans?fanId=<row.fanId>&after=<window.currentStart>&before=<window.currentEnd>&granularity=<day|month>[&overwriteAccountId]`
    (facade main:27099-27102, API main:27000-27002; API default `granularity || "day"`); `isMonthly` =
    `granularityForWindow(window) === "month"` i.e. `window.days > 400`. Initial window = facade window.
  - `loadStatements()` (main:20188-20196): `getFanRevenue(fanId, W2, "month", cb)` with
    `W2 = buildWindowForRange({ from: monthRange(monthStartOf(Date.now() − Hc * 864e5)).from, to: Date.now() })` — i.e.
    from the month containing the 2019-06-25 epoch constant (section 6.3) up to today.
  - transactions: `walletService_.getEarningsTransactionsForAccount(fanId, window.currentEnd + 864e5, window.currentStart, cursor || "0", limit, overwriteAccountId, cb)`
    (main:20219-20227) →
    `GET /account/wallets/earnings/transactions/accounts?correlationAccountId=<fanId>&before=<currentEnd + 1 day>&after=<currentStart>&cursor=<lastTransactionId|0>&limit=<n>[&overwriteAccountId=<id>]`
    (main:37552-37559). Pager `new V.u(idOf, 10, 30, read)` (main:20153-20157; module 2744 main:89-135): page size 10,
    `limit = min(100, max(30, page * 10 − rowsHeld))` → first request `limit=30`; cursor = `transactionId` of the last
    held row.
  - Modal-local period selector has `allowLifetime=true`: lifetime (`-1`) → window
    `buildWindowForRange({ from: lifetimeStart_(), to: Date.now() })` (main:20171-20176).
- **Media modal** (`app-stats-media-detail-modal`, 729:800-1010), opened by W5 row click with `(offer, source)`:
  `getMediaOfferStats(offer.mediaOfferId, source, window, cb)` (729:825), `getWatchBenchmarks(source, window, cb)`
  (729:834), `getMediaOfferStats(offer.mediaOfferId, M.kT = -1, window, cb)` (729:858) →
  `GET /account/stats/media?mediaOfferId=…&source=<n | -1>&after=…&before=…` and `GET /account/stats/media/benchmarks?…`.
  Its "Lifetime" preset is `buildWindow(d.tO = 400)` (729:812). Details: content-tab document.

---

## 4. Response fields read by the client

Types are inferred from how the client uses each value. "pair" = object `{ value, previous }` (both numbers; the
client reads `U.value || 0` and `U.previous || 0`, main:27103-27105). "points" = array of `{ bucket, value }`.
`bucket` values are coerced with `Number(...)` at several sites, so they may arrive as numeric strings.
"mills" = Fansly balance units, 1000 = $1.00 (display path: `app-balance-display` → `balance` pipe with mode `2` →
`balanceToDollars(x) = Math.round(Math.floor(x / 10) / 100 * 100) / 100`, main:2848, main:24560-24576 [module 2682],
main:490-496).

### 4.1 `GET /account/stats/summary` → `applySummary_` (729:2000-2006)

| field path | type / unit | used for |
|---|---|---|
| `revenue.netAfterRefundsMills` | pair, mills | tile `Earnings` |
| `revenue.series.netMills` | points, mills | `Earnings` sparkline (minuend) |
| `revenue.series.refundedNetMills` | points, mills | `Earnings` sparkline (subtrahend, matched on `bucket`) |
| `revenue.payingFans` | pair, count | tile `Paying fans` |
| `views[]` | array of per-source rows | looked up by `Number(row.source)` (729:1995-1999); Overview reads only source `0` and `1` |
| `views[].source` | number (source code, section 6.2) | row selector |
| `views[].views` | pair, count | tiles `Views on For You` (source 0) / `Views on Timeline` (source 1) |
| `views[].uniqueViewers` | pair, count | tile `Unique viewers on For You` (source 0 only) |
| `views[].series.views` | points, count | sparklines of the two view tiles |
| `profile.profileVisits` | pair, count | tile `Profile visits` |
| `profile.series.profileVisits` | points, count | its sparkline |
| `follows.netFollows` | pair, count (may be negative) | tile `Follower growth` |
| `follows.series.follows` | points, count | sparkline minuend |
| `follows.series.unfollows` | points, count | sparkline subtrahend |
| `subscriptions.subscriptionsNew` | pair, count | tile `New subscribers` |
| `subscriptions.series.subscriptionsNew` | points, count | its sparkline |
| `levels[]` | array (optional; missing value is treated as `[]`) | W4 charts |
| `levels[].bucket` | ms epoch (UTC day), `Number()`-coerced | x value |
| `levels[].followerCount` | count (absolute level) | `Total followers` chart |
| `levels[].subscriberCount` | count (absolute level) | `Subscribers` chart |
| `dataSince` | ms epoch (optional; missing value is treated as `0`) | W7 note; shown when `dataSince > 0 && dataSince > window.currentStart` |

Notes:
- `revenue`, `revenue.series`, `profile`, `profile.series`, `follows`, `follows.series`, `subscriptions`,
  `subscriptions.series` are dereferenced without null checks → they must always be present. A missing `views[]` row
  for a source is tolerated (`null` → empty metric / empty series).
- The series bucket granularity for summary is decided by the server (the request has no `granularity` param). The
  sparklines only use the values in array order; the W4 charts label points as days (chart default
  `granularity = "day"`, main:20331) — **UNRESOLVED** whether the server ever returns non-daily buckets here.
- Display: balances as dollars with up to 2 decimals and thousands separators; counts through the `shortNumber` pipe
  (1 decimal + `K`/`M`/`B`/`T`/`Q`, main:24001-24022).

### 4.2 `GET /account/stats/fans/top` (729:2018-2020, list 729:1425-1453, modal seed main:20168-20170)

| field path | type / unit | used for |
|---|---|---|
| `rows[]` | array (missing value or error is treated as `[]`), server-ordered | list, sliced to 5 |
| `rows[].fanId` | account id (string) | avatar + username (`[accountId]`), track-by key, modal `fan.fanId` |
| `rows[].transactions` | count | `<n> purchase(s)` |
| `rows[].netAfterRefundsMills` | mills | amount (`app-balance-display`) |
| `rows[].refunds` | count | `<n> refund(s)` when non-zero |
| `rows[].firstBucket` | ms epoch, `Number()`-coerced (the client's own default literal is the string `"0"`, main:20163) | `since <date>`; format `MMM d` if same UTC year as now, else `MMM d, y`; timezone `UTC` |
| `rows[].grossMills`, `rows[].netMills`, `rows[].refundedNetMills`, `rows[].lastBucket` | mills / ms epoch | not shown in the list; seed values of the supporter modal (`setFan_`, main:20168-20170) |
| `aggregationData` | object (optional) | see 4.7 |

Errors are swallowed (`topFans = []`).

### 4.3 `GET /account/stats/media/top` (729:2024-2026; list `buildRows_` 729:1124-1133)

| field path | type / unit | used for |
|---|---|---|
| `offers[]` | array, server-ordered by `orderBy`; `rank = index + 1` | list (first 3) |
| `offers[].mediaOfferId` | id (string). Passed to `mediaService_.getCachedAccountMedia(id)` and to `<app-account-media [mediaId]>` → it is an **accountMedia id** | thumbnail, track-by, post lookup, modal |
| `offers[].bestMediaId` | media id | selects the "best" entry of `offers[].media[]` (fallback: first entry) |
| `offers[].likes` | count | `Likes` |
| `offers[].media[]` | array of per-media stats | — |
| `offers[].media[].mediaId` | media id | match against `bestMediaId`; match against cached `accountMedia.media.id` / `accountMedia.preview.id` (`mediaOfOffer`, main:27261-27263) |
| `offers[].media[].mediaType` | number; `1` = IMAGE, `2` = VIDEO (`qq`, main:27297) | `isVideo = Number(mediaType) !== 1` |
| `offers[].media[].views` | count | `Views`; divisor for avg watch |
| `offers[].media[].uniqueViewers` | count | `Unique viewers` |
| `offers[].media[].watchMs` | ms, total watch time | `Avg. watch = formatDuration(views ? watchMs / views : 0)` |
| `offers[].media[].durationMs` | ms (may be 0/absent → fallback `1000 * accountMedia.getVideoDuration()`) | `/ <duration>` suffix; length-bucket lookup |
| `offers[].media[].videoViews` | count | completion divisor; verdict threshold (`>= 50`) |
| `offers[].media[].completedViews` | count | `Completion = completedViews / videoViews` (shown `× 100`, `1.0-0`, `%`), `null` when `videoViews` is 0 |
| `offers[].media[].watchPctSum` | sum over video views of watched-percent × 100 (see 5.6) | verdict |
| `aggregationData.creatorMediaOfferLocations[]` | array (optional) | post link |
| `…creatorMediaOfferLocations[].mediaOfferId` | id | key |
| `…creatorMediaOfferLocations[].correlationId` | post id (used as `/post/<id>`) | newest one per offer wins |
| `…creatorMediaOfferLocations[].createdAt` | ms epoch (`Number()`) | "newest" comparison |
| `aggregationData` (rest) | see 4.7 | fills the media cache used for thumbnails |

Errors are swallowed (`topMedia = []`, `topMediaLocations = []`).

### 4.4 `GET /account/stats/media/benchmarks` (729:2028-2030; consumed in `watchLiftPoints`/`lengthBucketOf`, main:27232-27236, 27268-27273)

| field path | type / unit | used for |
|---|---|---|
| `buckets[]` | array of video-length buckets | lookup by the media's `durationMs` |
| `buckets[].minMs` | ms (inclusive lower bound, default 0) | bucket match `duration >= minMs` |
| `buckets[].maxMs` | ms (exclusive upper bound; falsy = open-ended) | bucket match `duration < maxMs` |
| `buckets[].mediaCount` | count of videos in the bucket | must be `>= 3` |
| `buckets[].videoViews` | count | must be truthy |
| `buckets[].avgWatchPercent` | percent points 0-100 | subtracted from the media's watched % |

(Other bucket fields — `lengthBucket`, `completionRate`, `avgWatchMs` — are read only by the media modal /
`lengthBucketLabelStringId`, 729:845-854, main:27279-27281.)

### 4.5 `GET /account/stats/series?family=views&granularity=hour` (729:1963-1967, `applyRealtime_` 729:1975-1986)

| field path | type / unit | used for |
|---|---|---|
| `rows[]` | array (missing value is treated as `[]`) | — |
| `rows[].source` | number (source code) | filter `Number(source) === realtimeSource` |
| `rows[].hourBucket` | ms epoch of the hour start (`Number()`) | time slicing |
| `rows[].views` | count (`Number()`) | sums and bars |

### 4.6 `GET /account/stats/media/shown` (729:1968-1973, 729:1984-1985)

| field path | type / unit | used for |
|---|---|---|
| `rows[]` | array (missing value is treated as `[]`) | — |
| `rows[].source` | number (source code) | filter by `realtimeSource` (last matching row wins) |
| `rows[].mediaShown` | count | tile value |
| `rows[].previousMediaShown` | count | tile comparison value |

If the request fails on a non-silent load the tile disappears (`realtimeMediaShown = null`); if there is no row for the
selected source the tile is also hidden.

### 4.7 How `aggregationData` is consumed

`aggregated_(cb)` (main:27016-27021): on success, if `response.aggregationData` exists it is passed to
`ApiGatewayAggregationService.handleAggregationDataModel` (module 561, main:25620-25622) **before** the component
callback runs. That function emits each non-empty array to a model emitter:

| `aggregationData` key | emitter | effect |
|---|---|---|
| `accounts` | `accountModelEmitter_` | account cache → `app-account-avatar` / `app-account-username` resolve `fanId` |
| `accountMedia` | `accountMediaModelEmitter_` | media cache → `getCachedAccountMedia(mediaOfferId)`, thumbnails |
| `accountMediaBundles` | `accountMediaBundleModelEmitter_` | bundle cache |
| `accountMediaOrders` | `accountMediaOrderModelEmitter_` | order cache |
| `posts` | `postModelEmitter_` | post cache |
| `groups` | `groupModelEmitter_` | group cache |
| `tags` | `tagModelEmitter_` | tag cache |

Wrapped facade methods: `getTopMedia`, `getMediaOfferStats`, `getTopTags`, `getTopFans`, `getFanRevenue`
(main:27074, 27078, 27094, 27097, 27101). Not wrapped: `getSummary`, `getSeries`, `getSeriesForRange`,
`getWatchBenchmarks`, `getMediaShownHours`, `getGeoStats`, `getActiveHours`.
The only `aggregationData` key the Overview reads directly is `creatorMediaOfferLocations` (4.3).
Which of the generic keys the server actually returns per endpoint is **UNRESOLVED** (the client accepts any subset).

### 4.8 Discovery card responses (Audience; my range)

- `GET /trackinglinks` → array of links; fields read: `type` (`1` = built-in), `internalId`, `id` (729:31-40).
- `GET /trackinglinks/stats` → array of rows; fields read: `timestamp` (ms epoch, `parseInt`), `clicks`, `claims`,
  `follows`, `subscriptions` (main:36939-36943).
- `GET /trackinglinks/revenuestats` → array of rows; fields read: `timestamp`, `totalGross` (main:36949-36953).
- The card displays only `follows` (current vs previous) per source group; the other totals are accumulated but unused
  (729:61-63, 70-71).

### 4.9 Supporter-modal responses (reachable from Overview)

- `GET /account/stats/fans` (`apply_`, main:20234-20253; statements via `statementRows`, main:20193):
  `byProductType[]` `{ productType, grossMills, netMills, refundedNetMills, transactions, refunds }`;
  `firstBucket`, `lastBucket` (ms epoch); `rows[]` `{ bucket, netMills, refundedNetMills, transactions, grossMills, refunds }`;
  `aggregationData`. Product type `6101` (Refunds) is excluded from the "By product" table.
- `GET /account/wallets/earnings/transactions/accounts` (main:20221-20232): `data[]`
  `{ transactionId, createdAt, destination, status, type, correlationId, amount, transactionAmount }`, `hasMore`,
  `aggregationData`. `destination === 1` → refund row; `status` enum `{ PENDING: 1, APPROVED: 2, CANCELED: 4, REFUNDED: 5, REFUNDED_PENDING: 6 }`
  (main:37434) plus literal `8` treated as cancelled; `netMills = |amount|`, `grossMills = transactionAmount`;
  types `2010`/`2110` → `correlationId` is a media id, `2016`/`2116` → bundle id (main:20146).

---

## 5. Client-side derived metrics and formulas

### 5.1 Growth metric (module 8854 `n`, main:20521-20531)

```
empty()            = { value: 0, previous: 0, delta: 0, deltaAbs: 0, deltaPercent: null, hasPrevious: false }
build(value, prev) = { value, previous: prev, delta: value - prev, deltaAbs: |value - prev|,
                       deltaPercent: prev > 0 ? (value - prev) / prev * 100 : null,
                       hasPrevious: prev > 0 }
toGrowthMetric(pair) = pair ? build(Math.round(pair.value || 0), Math.round(pair.previous || 0)) : empty()   // main:27103
```

### 5.2 Delta pill (`app-growth-delta-pill`, main:20592-20598)

- `isUp = delta > 0`, `isDown = delta < 0`; "good" = up (or down when `lowerIsBetter`; Overview never sets it).
- No previous (`previous <= 0`): shows `New` if `value > 0 && !(previous < 0)`, else `–`.
- Otherwise `A = Math.round(deltaPercent)`; `|A| > 999` → `>999%` / `<-999%`; else `+A%` / `A%`
  (compact variant: caret icon + `|A|%`).

### 5.3 Stat tile (main:20782-20886)

- Value: `isBalance` → `app-balance-display` (mills → dollars); otherwise `shortNumber`.
- Sparkline rendered only when not `compact` and `series.length > 0`.
- Footer: delta pill + absolute delta (`+`/`−` and balance display of `deltaAbs`, or signed `shortNumber(delta)`), then
  `vs previous <periodDays> days` (non-compact only); if `!hasPrevious` → `No data in the previous period`.

### 5.4 Overview tile inputs (729:2002)

```
earnings        = toGrowthMetric(revenue.netAfterRefundsMills)
earningsSeries  = seriesValues(seriesMinus(revenue.series.netMills, revenue.series.refundedNetMills))
viewsFyp        = toGrowthMetric(views[source=0].views)          viewsFypSeries      = seriesValues(views[source=0].series.views)
uniqueViewersFyp= toGrowthMetric(views[source=0].uniqueViewers)
viewsTimeline   = toGrowthMetric(views[source=1].views)          viewsTimelineSeries = seriesValues(views[source=1].series.views)
profileVisits   = toGrowthMetric(profile.profileVisits)          profileVisitsSeries = seriesValues(profile.series.profileVisits)
netFollows      = toGrowthMetric(follows.netFollows)             netFollowsSeries    = seriesValues(seriesMinus(follows.series.follows, follows.series.unfollows))
newSubscribers  = toGrowthMetric(subscriptions.subscriptionsNew) newSubscribersSeries= seriesValues(subscriptions.series.subscriptionsNew)
payingFans      = toGrowthMetric(revenue.payingFans)
```

`seriesMinus(a, b)` = for each point of `a`: `value − Σ b.value` with the same `String(bucket)` (buckets only in `b`
are dropped) (main:27193-27204). `seriesValues(s)` = `s.map(p => p.value || 0)` (main:27205-27210).

### 5.5 Level charts (729:2003-2005, chart main:20376-20418)

`followerLevels = [{ label: "Followers", points: levels.map(l => ({ bucket: Number(l.bucket), value: l.followerCount || 0 })), colorToken: "--v2-blue-1", aggregate: "last" }]`,
same for subscribers with `subscriberCount`. Chart: `maxPlotPoints = 90`; when there are more distinct buckets, they
are grouped in runs of `ceil(n / 90)` and with `aggregate: "last"` the value of the latest bucket in each run is
plotted (default `"sum"`, also `"mean"`). `hasData = Σ|value| > 0`, else the empty text. Not `isBalance` → raw
integers, integer ticks.

### 5.6 Top-media row metrics (729:1124-1133)

```
best       = offer.media.find(m => m.mediaId === offer.bestMediaId) || offer.media[0]
avgWatch   = formatDuration(best.views ? best.watchMs / best.views : 0)
duration   = durationLabel(best.durationMs, cachedMedia)             // "" when unknown
completion = best.videoViews ? best.completedViews / best.videoViews : null     // shown ×100, 0 decimals
verdict    = lengthVerdict(watchLiftPoints(best, benchmarks))
postId     = newest creatorMediaOfferLocations[].correlationId for this mediaOfferId (by createdAt)

watchLiftPoints(media, bm):                                                    // main:27232-27236
    if (!media || !bm || (Number(media.videoViews) || 0) < 50) return null
    b = lengthBucketOf(bm.buckets, media.durationMs)
    if (!b || b.mediaCount < 3 || !b.videoViews) return null
    return (Number(media.watchPctSum) || 0) / media.videoViews / 100 - b.avgWatchPercent

lengthVerdict(points):  N = Math.round(points)                                 // main:27237-27241
    N <= -10 → "<|N|> pts below similar-length videos"  (tone "bad")
    N >=  10 → "<N> pts above similar-length videos"    (tone "good")
    else     → "+N / −N pts vs similar-length videos"   (tone "")
```

Unit consequence: `watchPctSum / videoViews / 100` must be a 0-100 percentage, so `watchPctSum` is the sum of per-view
watched-percent expressed in hundredths of a percent (inferred from the arithmetic, same in `watchedPercent`,
main:27242-27244).

### 5.7 Realtime windows (`applyRealtime_`, 729:1975-1986)

```
now = new Date()
i   = floor(now / 3600000) * 3600000        // current hour bucket (epoch-aligned)
s   = i − 47 h                              // first of the 48 bars
o   = i − 24 h
l   = local midnight today                  // new Date(y, m, d)  — browser time zone
c   = local midnight yesterday
_   = local midnight the day before yesterday
h   = i − 24 h

for each row with Number(row.source) === realtimeSource:  x = Number(row.hourBucket), T = Number(row.views)
    if s <= x <= i:  realtimePoints.push({ bucket: x, value: T });  x > o ? last24 += T : prev24 += T
    if      l <= x <= i:  today += T
    else if c <= x <  l:  yesterday += T;  if (x <= h) yesterdaySameHours += T
    else if _ <= x <  c:  dayBefore += T

realtimeLast24    = build(last24, prev24)                 // hours (i−24h, i]  vs  [i−47h, i−24h]
realtimeToday     = build(today, yesterdaySameHours)      // local today so far vs local yesterday up to the same hour
realtimeYesterday = build(yesterday, dayBefore)           // full local yesterday vs the local day before
realtimeMediaShown= build(row.mediaShown, row.previousMediaShown) for the media/shown row of that source, else null
```

"Today"/"Yesterday" depend on the **viewer's time zone**; the request itself carries no time zone (rows are UTC hour
buckets, sliced client-side). The 3-day request span (`todayUtcMidnight − 3 d … todayUtcMidnight`) always covers the
local "day before yesterday".

Hour bars (729:528-548): 48 bars ending at the current hour bucket (`endBucket` unset → `floor(now/1h)*1h`); labels
`Ddd HH:MM` in local time; bar height `max(4, value / max * 100)` % (2 % when zero); `isPeak = value > 0 && value >= 0.75 * max`;
"Busiest hour" = first bar with the maximum value; y labels `shortNumber(max)` and `shortNumber(round(max / 2))`.

### 5.8 Timers and polling

| timer | value | where |
|---|---|---|
| realtime poll | `setInterval`, `6e4` ms (60 s), skipped unless `document.visibilityState === "visible"`; silent (no spinner, errors keep old data) | 729:2040-2042 |
| auto refresh after returning to the tab | hidden for `>= 3e5` ms (5 min) → full `refresh()` | 729:2084-2089 |
| refresh spinner | `1e3` ms | 729:2080-2082 |
| preset window rollover | at UTC midnight, lazily on next `getWindow()/setPeriod()/refresh()` | main:27025-27029 |
| tracking-link stats cache (discovery card only) | reuse for 60 s (`E - ce.loadedAt < 6e4`); cache object `{ maxItems: 40, accessTimeout: 6e5 }` | main:36912, 36990 |

### 5.9 Module-804 formulas used by other tabs (documented here because module 804 is in my slice)

- **Rates** — `ratioMetric(num, den, scale)` (main:27245-27249): `empty()` if either pair is missing; otherwise
  `build(round(den.value ? (num.value || 0) / den.value * scale : 0), round(den.previous ? (num.previous || 0) / den.previous * scale : 0))`.
- **Monthly statements** — `statementRows(rows)` (main:27156-27165): aggregate `rows` per UTC month
  (`revenueTotalsByBucket(rows, "month")`), build every month from the first month with data up to the current month,
  output newest first: `{ bucket, label: "Mon YYYY", isCurrent, transactions, grossMills, netAfterRefundsMills, delta, best: 0, onRecordPace: false }`
  where `delta = build(thisMonthNet, previousCalendarMonthNet || 0)` for every closed month except the oldest, and
  `null` for the current month and the oldest month.
- **Personal bests** — `markPersonalBests_` (main:27166-27177): among closed months with `netAfterRefundsMills > 0`,
  if there are at least 3, the top three get `best = 1, 2, 3`. If today's UTC day-of-month `>= 7`, the current month
  gets `onRecordPace = netAfterRefundsMills / dayOfMonth * daysInMonth > bestMonth.netAfterRefundsMills`.
- **"Usual month" / median** — `usualMonthMills(statementRows)` (main:27178-27187): take
  `recentClosedMonths` = non-current rows, first 12 (the 12 most recent closed months, zero months included); if fewer
  than 3 → `null`; else the **median** of their `netAfterRefundsMills` (mean of the two middle values for an even count).
- **Revenue totals** — `revenueTotalsByBucket(rows, granularity)` (main:27131-27142): groups by `Number(row.bucket)`
  (month start when `granularity === "month"`), summing `transactions`, `grossMills`, `netMills`, `refunds`,
  `refundedNetMills`; `netAfterRefundsMills = netMills − refundedNetMills`; sorted ascending by bucket.
- **Granularity switch** — `granularityForWindow(w)` = `w.days > 400 ? "month" : "day"` (main:27106-27108).
- **Tag verdict** — `tagVerdict(lift, views)` (main:27223-27228): `null` if `lift === undefined` or `views < 50`;
  `lift === null` → `No other viewers to compare`; else the same ±10-point thresholds as 5.6 with the wording
  `… other viewers`.

---

## 6. Module 804 reference (main:26945-27294, read completely)

Exports (main:26946): `po` = facade class, `Z2` = `[7, 30, 90]`, `Hc` = days since the epoch constant, `tO` = `400`.
The API service class (`C`, main:26948-27007) is **not exported**; it is reachable only through the facade.

### 6.1 API methods (all `GET`, main:26967-27002) — params in wire order

| API method | path | params (in order) |
|---|---|---|
| `getSummary(after, before, ow, cb)` | `/account/stats/summary` | `after`, `before`, `overwriteAccountId` |
| `getSeries(family, granularity, after, before, ow, cb)` | `/account/stats/series` | `family`, `granularity`, `after`, `before`, `overwriteAccountId` |
| `getTopMedia(source, mediaType, after, before, orderBy, limit, ow, cb)` | `/account/stats/media/top` | `source`, `mediaType`, `after`, `before`, `orderBy`, `limit`, `overwriteAccountId` |
| `getMediaOfferStats(mediaOfferId, source, after, before, ow, cb)` | `/account/stats/media` | `mediaOfferId`, `source`, `after`, `before`, `overwriteAccountId` |
| `getWatchBenchmarks(source, after, before, ow, cb)` | `/account/stats/media/benchmarks` | `source`, `after`, `before`, `overwriteAccountId` |
| `getMediaShownHours(end, hours, ow, cb)` | `/account/stats/media/shown` | `end`, `hours`, `overwriteAccountId` |
| `getGeoStats(source, after, before, limit, ow, cb)` | `/account/stats/geo` | `source`, `after`, `before`, `limit`, `overwriteAccountId` |
| `getActiveHours(source, after, before, tzOffsetMin, ow, cb)` | `/account/stats/activehours` | `source`, `after`, `before`, `timezoneOffsetMinutes`, `overwriteAccountId` |
| `getTopTags(source, kind, after, before, orderBy, limit, ow, cb)` | `/account/stats/tags` | `source`, `kind`, `after`, `before`, `orderBy`, `limit`, `overwriteAccountId` |
| `getPostEngagement(postIds[], after, before, ow, cb)` | `/account/stats/posts` | `postIds` (= `postIds.join(",")`), `after`, `before`, `overwriteAccountId` |
| `getTopFans(after, before, orderBy, limit, ow, cb)` | `/account/stats/fans/top` | `after`, `before`, `orderBy`, `limit`, `overwriteAccountId` |
| `getFanRevenue(fanId, after, before, granularity, ow, cb)` | `/account/stats/fans` | `fanId`, `after`, `before`, `granularity` (falsy value is replaced by `"day"`), `overwriteAccountId` |

Facade instance methods (main:27016-27102): `aggregated_`, `getWindow`, `refreshWindow_`, `getPeriodDays`, `getSource`,
`getOverwriteAccountId`, `setOverwriteAccountId`, `setPeriod`, `setRange`, `refresh`, `setSource`, `buildWindow`,
`buildWindowForRange`, `getSummary`, `getSeries(family, granularity, cb)`,
`getSeriesForRange(family, granularity, after, before, cb)`, `getTopMedia(source, mediaType, orderBy, limit, cb)`,
`getMediaOfferStats(mediaOfferId, source, window|null, cb)`, `getWatchBenchmarks(source, window|null, cb)`,
`getMediaShownHours(hours, cb)` (always `end = 0`), `getGeoStats(source, limit, cb)`,
`getActiveHours(source, cb)` (`timezoneOffsetMinutes = -(new Date()).getTimezoneOffset()`),
`getTopTags(source, kind, orderBy, limit, cb)`, `getTopFans(orderBy, limit, cb)`,
`getFanRevenue(fanId, window|null, granularity, cb)`. There is **no facade wrapper for `getPostEngagement`**.

### 6.2 Static helpers of the facade (complete, main:27103-27289)

| # | helper (line) | meaning |
|---|---|---|
| 1 | `toGrowthMetric(pair)` (27103) | `{value, previous}` → rounded growth metric; `empty()` when pair is falsy |
| 2 | `granularityForWindow(w)` (27106) | `"month"` if `w.days > 400`, else `"day"` |
| 3 | `bucketsBetween(start, end, gran)` (27109) | list of bucket timestamps, inclusive: UTC month starts for `"month"`, otherwise every 864e5 ms |
| 4 | `monthLabel(ts)` (27123) | `"Mon YYYY"` in UTC (`Jan`…`Dec`) |
| 5 | `monthStartOf(ts)` (27127) | UTC midnight of the 1st of `ts`'s month |
| 6 | `revenueTotalsByBucket(rows, gran)` (27131) | sum revenue rows per bucket (or per month), add `netAfterRefundsMills`, sort ascending |
| 7 | `monthsBefore(ts, n)` (27143) | UTC month start `n` months before `ts`'s month |
| 8 | `monthRange(bucket)` (27147) | `{from, to}` = local noon of first / last day of the bucket's (UTC) month — input for `setRange` |
| 9 | `isMonthWindow(window, bucket)` (27151) | is the window exactly that calendar month (end clamped to today)? |
| 10 | `statementRows(rows)` (27156) | monthly statement rows, newest first, with month-over-month delta (5.9) |
| 11 | `markPersonalBests_(rows)` (27166) | ranks top-3 closed months, flags current month "on record pace" (5.9) |
| 12 | `usualMonthMills(rows)` (27178) | median net of the last ≤ 12 closed months, `null` if < 3 (5.9) |
| 13 | `recentClosedMonths(rows)` (27188) | non-current statement rows, first 12 |
| 14 | `seriesMinus(a, b)` (27193) | per-bucket `a − b` over `a`'s buckets |
| 15 | `seriesValues(series)` (27205) | `[{bucket,value}]` → `[value]` |
| 16 | `sourceLabel(code)` (27211) | view-source label (table 6.4), default `"Other"` |
| 17 | `sourceLabelStringId(code)` (27214) | `"fansly_creator_stats_source_" + code` |
| 18 | `profileSourceLabel(code)` (27217) | profile-visit-source label (table 6.4), default `"Other"` |
| 19 | `profileSourceLabelStringId(code)` (27220) | `"fansly_creator_stats_profile_source_" + code` |
| 20 | `tagVerdict(lift, views)` (27223) | verdict `{text, short, tone}` vs "other viewers"; `null` if `lift` undefined or `views < 50` |
| 21 | `liftShort_(n)` (27229) | `"+N pts"` / `"−N pts"` (U+2212 minus) |
| 22 | `watchLiftPoints(media, benchmarks)` (27232) | watched % minus the length bucket's `avgWatchPercent`; `null` under 50 video views / bucket with < 3 videos |
| 23 | `lengthVerdict(points)` (27237) | verdict `{text, short, tone}` vs "similar-length videos" (±10-point thresholds) |
| 24 | `watchedPercent(watchPctSum, videoViews)` (27242) | `round(watchPctSum / videoViews / 100)`, `null` when no views |
| 25 | `ratioMetric(num, den, scale)` (27245) | growth metric of `num/den*scale` for current and previous |
| 26 | `productTypeLabel(type)` (27250) | revenue product-type label (table 6.5), default `"Other"` |
| 27 | `countryName(code)` (27253) | region name from `Intl.DisplayNames` for locale `navigator.language` (fallback `"en"`), `type: "region"`, upper-cased code; `"Unknown"` if empty; raw code on failure |
| 28 | `mediaOfOffer(accountMedia, mediaId)` (27261) | returns `accountMedia.media` or `.preview` whose `id === mediaId`, else `null` |
| 29 | `durationLabel(ms, accountMediaModel)` (27264) | `formatDuration(ms)`; falls back to `1000 * model.getVideoDuration()`; `""` if unknown |
| 30 | `lengthBucketOf(buckets, durationMs)` (27268) | first bucket with `minMs <= duration < maxMs` (open-ended when `maxMs` falsy) |
| 31 | `lengthBucketLabel(bucket)` (27274) | `"N to Ls"`, `"Up to Ls"`, `"Over Ns"` (seconds) |
| 32 | `lengthBucketLabelStringId(bucket)` (27279) | `"fansly_creator_stats_length_" + bucket.lengthBucket` |
| 33 | `formatDuration(ms)` (27282) | `"Ns"`; `"Mm SSs"`; `"Hh MMm"` |

### 6.3 Module-level constants (main:27009)

| name (export) | value | use |
|---|---|---|
| `m` (`Z2`) | `[7, 30, 90]` | period presets (shell 729:2064, media modal 729:803, supporter modal main:20151) |
| `O` | `864e5` | one day in ms |
| `T` (`tO`) | `400` | "Lifetime" length (days) of the media modal: `buildWindow(d.tO)` (729:812). The `> 400` test in `granularityForWindow` uses the literal `400`, not `T` |
| `R` (`Hc`) | `Math.ceil((Date.now() - 1561494359539) / 864e5)`, evaluated once at module load | number of days since **1561494359539 = 2019-06-25T20:25:59.539Z**. Used as the "all-time" lookback: Earnings statements `after = monthStartOf(Date.now() − Hc·day)` (729:1715, → 2019-06-01 UTC); supporter-modal statements (main:20189); supporter-modal lifetime fallback (main:20175). What the date represents (platform launch / oldest data) is **(inferred)**, not stated in code |
| `I` | `["Jan", …, "Dec"]` | `monthLabel` |
| `ee` | product-type labels (6.5) | `productTypeLabel` |
| `ne` | view-source labels (6.4) | `sourceLabel` |
| `ce` | profile-source labels (6.4) | `profileSourceLabel` |

### 6.4 Enums of module 906 (main:27295-27297) and source labels

| export | literal | meaning (names from the object keys; group names inferred from usage) |
|---|---|---|
| `EL` | `{ FYP: 0, TIMELINE: 1, SUGGESTIONS: 2, SEARCH: 3, OTHER: 4 }` | source / surface codes |
| `Bs` | `[0, 1, 4]` (`[FYP, TIMELINE, OTHER]`) | default options of every source switch |
| `kT` | `-1` | "all sources" selector (media modal breakdown, 729:858) |
| `qq` | `{ IMAGE: 1, VIDEO: 2 }` | media type (`mediaType` param / field); content filter also uses `0` = All (729:1238) |
| `k6` | `{ VIEWER_FILTER: 1, POST_TAG: 2 }` | `kind` of `/account/stats/tags` |
| `mM` | `{ VIEWS: "views", UNIQUE_VIEWERS: "uniqueViewers", WATCH_MS: "watchMs", COMPLETED_VIEWS: "completedViews", WATCH_LIFT: "watchLift" }` | `orderBy` values offered for `/media/top` (Content sort options, 729:1238) |
| `Fy` | `{ NET: "netMills", GROSS: "grossMills", TRANSACTIONS: "transactions" }` | `orderBy` of `/fans/top` |
| `$t` | `{ VIEWS: "views", PROFILE: "profile", FOLLOWS: "follows", SUBSCRIPTIONS: "subscriptions", REVENUE: "revenue" }` | `family` of `/account/stats/series` |

| code | `sourceLabel` (`ne`) | stringId | `profileSourceLabel` (`ce`) | stringId |
|---|---|---|---|---|
| 0 | `For You` | `fansly_creator_stats_source_0` | `For You` | `fansly_creator_stats_profile_source_0` |
| 1 | `Timeline` | `fansly_creator_stats_source_1` | `Direct` | `fansly_creator_stats_profile_source_1` |
| 2 | `Suggestions` | `fansly_creator_stats_source_2` | `Suggestions` | `fansly_creator_stats_profile_source_2` |
| 3 | `Search` | `fansly_creator_stats_source_3` | `Search` | `fansly_creator_stats_profile_source_3` |
| 4 | `Other` | `fansly_creator_stats_source_4` | `Other` | `fansly_creator_stats_profile_source_4` |
| any other | `Other` | `fansly_creator_stats_source_<code>` | `Other` | `fansly_creator_stats_profile_source_<code>` |

Granularity strings seen in the client: `"hour"`, `"day"`, `"month"`.

### 6.5 Revenue product-type labels (`ee`, main:27009)

| productType | label |
|---|---|
| 7001 | `Tips (Legacy)` |
| 7101 | `Tips` |
| 2016 | `Media Sets (Legacy)` |
| 2010 | `Media (Legacy)` |
| 2116 | `Media Sets` |
| 2110 | `Media` |
| 15001 | `Subscriptions` |
| 18001 | `Referrals` |
| 18002 | `Referrals` |
| 45001 | `Stream Tickets` |
| 45101 | `Stream Tickets` |
| 32001 | `Locked Text` |
| 32101 | `Locked Text` |
| 24101 | `Leaderboard Prize Money` |
| 6101 | `Refunds` |
| anything else | `Other` |

### 6.6 Other constants used by the shell / Overview

| constant | value | where |
|---|---|---|
| period-selector lifetime sentinel `w` (module 5351) | `-1` | main:20694 (not enabled in the shell) |
| period-selector default options | `[7, 30, 90]`, default `periodDays = 30` | main:20699 |
| custom-range default start | `Date.now() − 25056e5` (29 days) | main:20708 |
| Overview `L`, `W` | `36e5`, `864e5` | 729:1945 |
| realtime chart hours | `48` | 729:1950 |
| realtime request span | 3 days back from today's UTC midnight | 729:1962-1963 |
| realtime poll | `6e4` ms | 729:2040-2042 |
| hidden-tab auto refresh | `3e5` ms | 729:2087 |
| top media `limit` / `orderBy` | `3` / `"views"` | 729:2024 |
| top fans `limit` / `orderBy` | `5` / `"netMills"` | 729:2018 |
| media-shown `hours` / `end` | `24` / `0` | 729:1968, main:27085 |
| verdict thresholds | ≥ 50 video views, bucket ≥ 3 videos, ±10 points | main:27224, 27233-27240 |
| line chart `maxPlotPoints` | `90` | main:20331 |
| legacy-stats availability cutoff | `Date.UTC(2026, 8, 21)` = `1789948800000` | main:143 |
| discovery card custom-link cap | `30` | 729:31 |
| discovery built-in links | `internalId` `"1"` fyp, `"2"` suggestions, `"3"` search (`type === 1`) | 729:14, 31 |

---

## 7. Methods NOT called from chunk 729 / 381, and the full caller matrix

Searched: all six pretty-printed bundles (main, 189, 294, 381, 729, 795) for `.<method>(`; the raw `scripts`, `runtime`
and `index.html` contain no `account/stats` reference.

### 7.1 Not called from 729/381

| method | callers | params |
|---|---|---|
| API `getPostEngagement` → `GET /account/stats/posts` (main:26994-26996) | **none anywhere**. The name occurs once in the whole build (its definition); the API class is not exported and the facade has no wrapper → dead code in this build. | would be `postIds=<id1,id2,…>&after&before[&overwriteAccountId]`; response shape **UNRESOLVED** |
| facade `getFanRevenue` → `GET /account/stats/fans` | only `app-stats-fan-detail-modal` in **main** (module 2980): `loadStatements()` main:20190 and `load()` main:20199 | see 3.8: (a) `fanId`, `after/before` = modal window, `granularity` = `"day"` or `"month"` (`days > 400`); (b) `fanId`, `after` = UTC month start of 2019-06, `before` = today's UTC midnight, `granularity=month` |

Who opens that modal (and therefore triggers `getFanRevenue`):

| opener | file:line | entry | initial window |
|---|---|---|---|
| Overview "Top supporters" row | 729:1991-1994 | `setFan(row)` (seeded with the row's totals) | facade window |
| Earnings "Top supporters" row | 729:1670-1673 | `setFan(row)` | facade window |
| `app-messaging-overlay-group` `openEarningsModel()` | main:59838-59839 | `setFanId(account.id)` | facade window (singleton state; default 30 days if the stats page was never opened) |
| `app-messages-conversation-route` `openEarningsModel()` | main:74647-74648 | `setFanId(account.id)` | same |
| `app-creator-dashboard-subscription` `openEarningsModel()` | main:93830-93831 | `setFanId(account_.id)` | same |
| `app-profile-route` `openEarningsModel()` | main:99921-99922 | `setFanId(account.id)` | same |

`setFanId` seeds zeros and `firstBucket: "0"`, `lastBucket: "0"` (main:20162-20164). Outside the stats shell
`overwriteAccountId_` is `""` (the shell clears it on destroy).

Static helper called only outside 729/381: `isMonthWindow` (main:20506, `app-stats-statements`, module 6026).
Statics used only inside module 804: `monthLabel`, `markPersonalBests_`, `liftShort_`.

### 7.2 Caller matrix for every facade data method

| facade method | endpoint | callers (file:line → component) |
|---|---|---|
| `getSummary` | `/account/stats/summary` | 729:306 Audience; 729:1328 Content; 729:1796 Earnings; 729:2013 Overview |
| `getSeries` | `/account/stats/series` | 729:1856 Earnings |
| `getSeriesForRange` | `/account/stats/series` | 729:1716, 1723, 1728, 1742 Earnings; 729:1963 Overview (realtime) |
| `getTopMedia` | `/account/stats/media/top` | 729:1337 Content; 729:2024 Overview |
| `getMediaOfferStats` | `/account/stats/media` | 729:825, 858 media modal |
| `getWatchBenchmarks` | `/account/stats/media/benchmarks` | 729:834 media modal; 729:1343 Content; 729:2028 Overview |
| `getMediaShownHours` | `/account/stats/media/shown` | 729:1968 Overview |
| `getGeoStats` | `/account/stats/geo` | 729:315 Audience |
| `getActiveHours` | `/account/stats/activehours` | 729:1349 Content |
| `getTopTags` | `/account/stats/tags` | 729:1355 Content |
| `getTopFans` | `/account/stats/fans/top` | 729:1862 Earnings; 729:2018 Overview |
| `getFanRevenue` | `/account/stats/fans` | main:20190, 20199 supporter modal |
| — (`getPostEngagement`, API only) | `/account/stats/posts` | none |

---

## 8. Open questions / UNRESOLVED

1. **`before` inclusivity.** The client always sends the UTC-midnight bucket of the *last included day* as `before`
   (today for presets). Strong evidence that the server treats it as an inclusive day bucket: the realtime call sends
   `before = today's UTC midnight` and then expects hourly rows up to the current hour (729:1962-1981); by contrast the
   wallet-transactions call adds one day (`currentEnd + 864e5`, main:20221). Not provable from client code alone.
2. **How the server derives `previous`.** `/account/stats/summary` and `/media/shown` return `{value, previous}` /
   `previousMediaShown`; the client never sends the previous window. The UI caption implies "same number of days
   immediately before" (`previousStart…previousEnd`, 1.3), but the server rule is not visible.
3. **`end=0` on `/account/stats/media/shown`** — hard-coded; semantics (now?) unknown. The exact definition of
   `mediaShown` comes only from the UI text ("different videos this surface put in front of someone in the last 24 hours").
4. **Who may send `overwriteAccountId`** — no client-side check and no UI that produces it (1.6).
5. **JSON types of ids/timestamps** — `bucket`, `hourBucket`, `firstBucket`, `lastBucket`, `createdAt`, `source` are
   all coerced with `Number()`/`parseInt`; whether the wire format is number or string is unknown.
6. **Fields the client does not read** — the response may contain more than section 4 lists (e.g. `views[]` rows for
   sources 2/3/4, extra totals). Only fields read by the code are documented.
7. **Summary series granularity and range limits** — no `granularity` param on summary; custom ranges are not
   length-limited client-side on Overview. Whether the server switches to monthly buckets or rejects long ranges is unknown.
8. **`levels[]` cadence** — described in UI text as nightly snapshots ("count at the end of each day"); bucket
   alignment is assumed to be UTC days like the other series.
9. **`aggregationData` contents per endpoint** — the handler accepts `accounts`, `accountMedia`, `accountMediaBundles`,
   `accountMediaOrders`, `posts`, `groups`, `tags`; which ones each stats endpoint returns is unknown. Only
   `creatorMediaOfferLocations` (on `/media/top`) is read explicitly by Overview.
10. **`watchPctSum` unit** — inferred as hundredths of a percent per video view from `watchPctSum / videoViews / 100`
    being compared with a 0-100 `avgWatchPercent`.
11. **Meaning of the `1561494359539` constant** — code only uses it as the earliest "all-time" start
    (2019-06-25T20:25:59.539Z).
12. **`/account/stats/posts`** — parameter list known, response unknown, no caller in this build.
13. **Localized strings** — the English texts above are the inline defaults of `xd-localization-string`; the served
    localization table (by `stringId`) may differ and was not inspected.
14. **Rate limits / server caching** of the stats endpoints are not visible in the client; the client itself polls only
    the two realtime calls every 60 s while the tab is visible.
