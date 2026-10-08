# Fansly creator stats — CONTENT tab (`/creator/stats/content`) — static RE notes

Source: today's public web bundles, pretty-printed, read as text only. Nothing was executed, no network requests were made.

File aliases used in refs:

- `729:N` = `analysis/729.d14b4c5910bebc74.pretty.js` line N (lazy stats chunk, webpack module 8729)
- `main:N` = `analysis/main.2e6b96097a4bb73b.pretty.js` line N
- `381:N` = `analysis/381.3db514b57dd6c2e7.pretty.js` line N

Confidence markers: **PROVEN** = literal in code. **INFERRED** = follows from client arithmetic/formatting only (server not observed). **UNRESOLVED** = cannot be proven from the bundles.

---

## 0. Shared plumbing (needed to read everything below)

### 0.1 HTTP wrapper (`main:26954-26966`)

`get_(path, params, cb)`: `GET https://apiv3.fansly.com/api/v1` (`apiBaseUrl`, `main:37841`) `+ path + "?" + k=v&...`.

- A param is **omitted** when its value is `null`, `undefined` or `""` (`null == te || "" === te`). `0` and `-1` ARE sent (`source=0`, `source=-1`, `timezoneOffsetMinutes=0`).
- Values go through `encodeURIComponent(String(v))`. Param order = object-literal key order of each API method.
- Response envelope: `body.success ? body.response : error` (`error.details` if present, else `"error getting statistics"`). Everything below describes `body.response`.
- Request goes through `authInterceptorService_` (auth headers) — details outside this slice.

### 0.2 Window (`after` / `before`) — `main:36907-37028`

`window = { days, currentStart, currentEnd, previousStart, previousEnd, splitAt, spanBefore, spanAfter }` (`buildWindow_`, `main:37017-37020`). All values are **epoch milliseconds at UTC midnight** (day buckets).

- Preset period N days (`buildGrowthWindow`, `main:36914-36917`): `currentEnd = Date.UTC(todayUTC y,m,d)` (`todayBucket_`, `main:37021-37024`), `currentStart = currentEnd - (N-1)*86400000`. `days = N`.
- Custom range (`buildGrowthWindowForRange(from,to)`, `main:36918-36925`): each picked timestamp → `Date.UTC(local year, local month, local date)` (`localDayBucket_`, `main:37025-37028`), swapped if reversed, end clamped to today's UTC bucket. `days = round((end-start)/86400000)+1`.
- Sent as `after = window.currentStart`, `before = window.currentEnd` (numbers, ms). Note `before` is the **start** (00:00 UTC) of the last day, and the client treats it as an inclusive day bucket (`bucketsBetween` iterates `<= end`, `main:27109-27122`). Server-side inclusivity: **UNRESOLVED**.
- Example (today 2026-10-08, 30 days): `after=1788912000000&before=1791417600000`.
- The previous period is never sent; the server returns `{value, previous}` pairs itself.
- Facade refreshes the window when the UTC day rolls over (`refreshWindow_`, `main:27025-27029`).

### 0.3 Facade state (`main:27010-27102`, class exported as `d.po`)

- `periodDays_` default `30`; `source_` default `S.EL.FYP` = `0`; `overwriteAccountId_` default `""` (`main:27014`).
- `overwriteAccountId` is taken from the route query param `?overwriteAccountId=` by the shell (`729:2094-2095`), reset to `""` on shell destroy (`729:2104`). When `""` it is omitted from every request.
- `aggregated_(cb)` (`main:27016-27021`): on success, if `response.aggregationData` exists → `apiGatewayAggregationService_.handleAggregationDataModel(response.aggregationData)`, then calls `cb`. Used by `getTopMedia`, `getMediaOfferStats`, `getTopTags` (and fans calls). NOT used by `getSummary`, `getWatchBenchmarks`, `getActiveHours`.

### 0.4 `aggregationData` join (`main:25620-25622`)

`handleAggregationDataModel(h)` fans out these keys (each only if non-empty array): `accounts`, `accountMedia`, `accountMediaBundles`, `accountMediaOrders`, `posts`, `groups`, `tags`.

- `aggregationData.accountMedia[]` → media service cache keyed by **`accountMedia.id`** (`main:30731-30732`, `main:31303-31310`). `getCachedAccountMedia(id)` = `accountMediaCache_.get(id)` (`main:31175-31177`, `main:31300-31302`).
  - Stats `mediaOfferId` **is the accountMedia id** (PROVEN by usage: `getCachedAccountMedia(offer.mediaOfferId)` `729:809,904,1129`; elsewhere in main `mediaOfferId: D.id` for an accountMedia `main:41137`).
  - Stats `mediaId` / `bestMediaId` is the inner **`accountMedia.media.id`** or **`accountMedia.preview.id`**: `mediaOfOffer(am, id)` returns `am.media` if `am.media.id === id`, else `am.preview` if `am.preview.id === id`, else `null` (`main:27261-27263`).
- `aggregationData.tags[]` → `tagCache_[tag.id] = tag` (`main:26648-26649`); `getCachedTagById(id)` (`main:26746-26748`). UI label = `"#" + tag.tag` (`729:955-958`, `729:1289-1292`); if not cached → `"Unknown tag"` (`fansly_creator_stats_tag_unknown`).
- `aggregationData.creatorMediaOfferLocations[]` is NOT handled by the aggregation service; it is read directly by the stats components (fields read: `mediaOfferId`, `correlationId`, `createdAt`).
- If an accountMedia is not in cache the thumbnail falls back to `<app-account-media [mediaId]=mediaOfferId>` (`729:639-643`, `729:1032-1036`), which uses the regular media service (existing `GET /account/media?ids=…`, `main:30125`) — not a stats endpoint.
- Which of those keys the stats endpoints actually populate: **UNRESOLVED** (client handles all generically).

### 0.5 Shared formatters

- `shortNumber` pipe (`main:24007-24018`): `0/NaN/null → "0"`; else one decimal with `K` (1e3), `M`, `B`, `T`, `Q`; e.g. `1234 → "1.2K"`.
- `formatDuration(ms)` (`main:27282-27289`): `s = round(ms/1000)`; `<60 → "Ns"`; `<60 min → "Mm SSs"`; else `"Hh MMm"`.
- `durationLabel(ms, mediaObj)` (`main:27264-27267`): `ms` if non-zero, else `1000 * mediaObj.getVideoDuration()` (`media.metadata.duration`, seconds, `main:29825-29827`); `""` if 0.
- `toGrowthMetric(x)` (`main:27103-27105`): `build(round(x.value||0), round(x.previous||0))`; `build(v,p)` = `{value, previous, delta: v-p, deltaAbs, deltaPercent: p>0 ? (v-p)/p*100 : null, hasPrevious: p>0}` (`main:20527-20530`).
- `ratioMetric(num, den, k)` (`main:27245-27249`): `value = round(den.value ? num.value/den.value*k : 0)`, `previous = round(den.previous ? num.previous/den.previous*k : 0)`; empty metric if either arg missing.
- `watchedPercent(watchPctSum, videoViews)` (`main:27242-27244`): `videoViews ? round(watchPctSum / videoViews / 100) : null` → integer percent.
- `xd-localization-string`: `stringId` is the localization key; the English text in the template is the built-in default. Localized tables are not in the bundles.

---

## 1. Content tab widgets in on-screen order

Component: `app-creator-stats-content-route` (class `729:1234-1378`, template fn `bn` `729:1207-1232`, consts `729:1376`). Page-level controls live in the shell `app-creator-stats-route` (`729:2060-2118`).

### 1.0 Shell controls (above the tabs, shared by all 4 tabs) — `729:2109-2117`

| Control | Details |
|---|---|
| Title | "Statistics" (`fansly_creator_stats_title`) + "Beta" (`fansly_beta_tag`); desc `fansly_creator_stats_desc` |
| Period selector `app-growth-period-selector` | options `d.Z2 = [7, 30, 90]` (`main:27009`), default 30, `allowCustom=true`, **no** lifetime. Labels "N days" (`fansly_profile_stats_overview_period_{N}`), "Custom" (`fansly_profile_stats_overview_period_custom`) (`main:20615-20655`). Custom = two date-only pickers "Start date"/"End date" (`fansly_creator_stats_range_start` / `fansly_creator_stats_range_end`, `main:20707-20716`) |
| Refresh button | `aria-label "Refresh"` → `creatorStatsService_.refresh()` (`729:2078-2083`) |
| Auto refresh | tab hidden ≥ 300000 ms then visible → `refresh()` (`729:2084-2089`) |
| Beta notice | `fansly_creator_stats_beta_title` / `fansly_creator_stats_beta_desc` ("Past For You Page interactions are still being backfilled …") |
| Tabs | Overview / Content / Audience / Earnings (`fansly_creator_stats_tab_overview|content|audience|earnings`), `queryParamsHandling="preserve"` |

### 1.1 Content tab body (in order)

States: error → "Statistics could not be loaded right now." (`fansly_creator_stats_error`); before first summary → skeleton tiles (4 + 6); then body (`729:1377`).

| # | Widget | Selector | Default label (stringId) | Controls | Data |
|---|---|---|---|---|---|
| 1 | Source switch | `app-stats-source-switch` | options `M.Bs = [0, 1, 4]` → "For You" / "Timeline" / "Other" (`fansly_creator_stats_source_0/1/4`) | click → `setSource` | facade `source_` |
| 2 | Tile | `app-growth-stat-tile` icon `video` | FYP: "Views" (`fansly_creator_stats_media_views`); else "Video views" (`fansly_creator_stats_tile_views`) | – | `views`, sparkline `viewsSeries` |
| 3 | Tile | icon `eye` | FYP: "Unique viewers" (`fansly_creator_stats_media_unique`); else "Unique video viewers" (`fansly_creator_stats_tile_unique_viewers`) | – | `uniqueViewers` (no sparkline) |
| 4 | Tile | icon `gauge` | "Avg. watched %" (`fansly_creator_stats_tile_avg_watch_percent`) | – | `avgWatchPercent`, `formatPercent` |
| 5 | Tile | icon `heart` | "Likes" (`fansly_creator_stats_tile_likes`) | – | `likes`, sparkline `likesSeries` |
| 6 | Compact tile | icon `clock` | "Avg. watch time" (`fansly_creator_stats_tile_avg_watch_time`) | – | `avgWatchMs`, `formatDuration` |
| 7 | Compact tile | icon `circle-check` | "Completion rate" (`fansly_creator_stats_tile_completion_rate`) | – | `completionRate`, `formatPercent` |
| 8 | Compact tile | icon `rotate-right` | "Replays" (`fansly_creator_stats_tile_replays`) | – | `replays` |
| 9 | Compact tile (only if `mediaShown` present) | icon `photo-film` | "Media shown" (`fansly_creator_stats_tile_media_shown`) | – | `mediaShown` |
| 10 | Compact tiles (only when source ≠ FYP) | icons `image`, `eye`, `clock` | "Image views" (`fansly_creator_stats_tile_image_views`), "Unique image viewers" (`fansly_creator_stats_tile_unique_image_viewers`), "Avg. image view time" (`fansly_creator_stats_tile_avg_image_watch_time`) | – | `imageViews`, `uniqueImageViewers`, `avgImageWatchMs` |
| 11 | Card + line chart | `app-stats-card` + `app-stats-line-chart` | "Views over time" (`fansly_creator_stats_content_views_title`); desc FYP "Views per day on this surface." (`fansly_creator_stats_content_views_desc_fyp`), else "Video and image views per day on this surface." (`fansly_creator_stats_content_views_desc`) | – | `viewsChart`: series "Video views" (`fansly_creator_stats_series_video_views`, blue) + (non-FYP) "Image views" (`fansly_creator_stats_series_image_views`, orange) |
| 12 | Card + line chart | same | "Watch time" (`fansly_creator_stats_content_watch_title`), desc "Minutes watched per day on this surface, videos only." (`fansly_creator_stats_content_watch_desc`) | – | `watchChart`: "Minutes watched" (`fansly_creator_stats_series_watch_minutes`) |
| 13 | Card "Top media" | `app-stats-card` + `app-stats-media-list` (originId `creator_stats_content`, `selectable=true`, no `limit` input → all rows) | "Top media" (`fansly_creator_stats_top_media_title`); desc "Every media on this surface ranked in the period. Tap one for its daily views, retention and hashtags, or use the arrow to open its post." (`fansly_creator_stats_content_top_media_desc`) | (a) media-type segmented, **non-FYP only**: All=`0` (`fansly_creator_stats_type_all`), Videos=`2` (`fansly_creator_stats_type_videos`), Images=`1` (`fansly_creator_stats_type_images`); (b) sort segmented: Views=`"views"` (`fansly_creator_stats_sort_views`), Unique viewers=`"uniqueViewers"` (`fansly_creator_stats_sort_unique`), Watch time=`"watchMs"` (`fansly_creator_stats_sort_watch`), Completed=`"completedViews"` (`fansly_creator_stats_sort_completed`); (c) row click → detail modal; (d) arrow → `/post/{postId}` | `topMedia`, `benchmarks`, `topMediaLocations` |
| 14 | Card "When your audience watches" | `app-stats-card` + `app-stats-heatmap` | "When your audience watches" (`fansly_creator_stats_content_hours_title`), desc "Views on this surface by weekday and hour in your time zone." (`fansly_creator_stats_content_hours_desc`) | media-type segmented (same options and same `mediaType` state as #13), **non-FYP only** | `heatValues` |
| 15 | Card "Hashtags" | `app-stats-card` + `app-stats-bar-table` | "Hashtags" (`fansly_creator_stats_content_tags_title`), desc `fansly_creator_stats_content_tags_desc` ("Views each of your hashtags brought in through hashtag browsing on this surface, how much of those videos was watched, and how that compares with the same videos' other viewers. pts are percentage points of the video watched: +9 pts means these viewers watched 9% more of the video than everyone else did.") | sort segmented: Views=`"views"` (`fansly_creator_stats_sort_views`), Watched %=`"watched"` (`fansly_creator_stats_sort_watched`), vs viewers=`"lift"` (`fansly_creator_stats_sort_lift`) — **client-side only** | `tagRows`; value column "Views" (`fansly_creator_stats_media_views`) for FYP / "Video views" (`fansly_creator_stats_label_video_views`) otherwise; secondary column "Avg. watched %" (`fansly_creator_stats_tile_avg_watch_percent`); "Trend" sparkline column (`fansly_creator_stats_label_trend`) |
| 16 | Card "Post engagement" | `app-stats-card` + 2 tiles | "Post engagement" (`fansly_creator_stats_content_posts_title`), desc "Likes and comments on your posts. Posts have no surface, so the switch above does not apply." (`fansly_creator_stats_content_posts_desc`); tiles "Post likes" (`fansly_creator_stats_tile_post_likes`, icon `thumbs-up`), "Comments" (`fansly_creator_stats_tile_comments`, icon `comment`) | – | `postLikes`/`postLikesSeries`, `comments`/`commentsSeries` |

Template order refs: element creation `729:1210-1226`; bindings `729:1230`; component state defaults `729:1238`.

Not embedded by the Content tab: `app-stats-discovery-card` (`729:91`), `app-stats-hour-bars` (only in the modal and Overview), fan list. Content route dependency list: `729:1378`.

---

## 2. Call chains and query params

The initial `load()` (`729:1326-1334`) fires **5 GETs**: summary, media/top, media/benchmarks, activehours, tags.

Common params (all calls): `after = window.currentStart` (ms), `before = window.currentEnd` (ms), `overwriteAccountId` = facade value (omitted when `""`).

### 2.1 Summary (tiles, both line charts, post engagement)

`ContentRoute.load()` `729:1328` → `facade.getSummary(cb)` `main:27064-27066` → `api.getSummary(after, before, overwriteAccountId)` `main:26967-26969`

```
GET /account/stats/summary?after={ms}&before={ms}[&overwriteAccountId={id}]
```

No `source` param: the response carries all sources; the client picks the row with `Number(views[i].source) === source` (`viewsOf_`, `729:1256-1260`; `likesOf_`, `729:1261-1265`).

### 2.2 Top media list

`ContentRoute.loadTopMedia()` `729:1335-1340` → `facade.getTopMedia(source, mediaType, orderBy, limit, cb)` `main:27073-27075` → `api.getTopMedia(...)` `main:26973-26975` (wrapped by `aggregated_`)

```
GET /account/stats/media/top?source={0|1|4}[&mediaType={1|2}]&after={ms}&before={ms}&orderBy={views|uniqueViewers|watchMs|completedViews}&limit=20[&overwriteAccountId={id}]
```

| Param | Value / origin |
|---|---|
| `source` | `this.source` = facade source: `0` FYP (default), `1` Timeline, `4` Other |
| `mediaType` | `this.mediaType > 0 ? this.mediaType : null` → omitted for "All"; `2` Videos, `1` Images. Forced back to `0` whenever source is FYP (`applySource_`, `729:1323-1325`) |
| `orderBy` | `this.orderBy`, default `M.mM.VIEWS = "views"`; other UI values `"uniqueViewers"`, `"watchMs"`, `"completedViews"` |
| `limit` | literal `20` (`729:1337`). No offset/cursor param exists |

### 2.3 Watch benchmarks (verdict line under each list row)

`ContentRoute.loadBenchmarks_()` `729:1341-1346` (called at the end of **every** `loadTopMedia()`) → `facade.getWatchBenchmarks(source, null, cb)` `main:27080-27083` (window `null` → page window) → `api.getWatchBenchmarks` `main:26979-26981`

```
GET /account/stats/media/benchmarks?source={0|1|4}&after={ms}&before={ms}[&overwriteAccountId={id}]
```

### 2.4 Active hours (heatmap)

`ContentRoute.loadActiveHours()` `729:1347-1352` → `facade.getActiveHours(source, cb)` `main:27090-27092` → `api.getActiveHours` `main:26988-26990`

```
GET /account/stats/activehours?source={0|1|4}&after={ms}&before={ms}&timezoneOffsetMinutes={int}[&overwriteAccountId={id}]
```

`timezoneOffsetMinutes = -(new Date()).getTimezoneOffset()` (`main:27091`) → **minutes east of UTC** (local − UTC): UTC+3 → `180`, UTC−5 → `-300`, UTC → `0` (sent). The media-type control does NOT change this request (filtering is client-side between the two returned matrices).

### 2.5 Hashtags

`ContentRoute.loadTags()` `729:1353-1358` → `facade.getTopTags(source, kind, orderBy, limit, cb)` `main:27093-27095` → `api.getTopTags` `main:26991-26993` (wrapped by `aggregated_`)

```
GET /account/stats/tags?source={0|1|4}&kind=1&after={ms}&before={ms}&orderBy=views&limit=10[&overwriteAccountId={id}]
```

| Param | Value / origin |
|---|---|
| `kind` | `M.k6.VIEWER_FILTER = 1` (literal at `729:1355`). `POST_TAG = 2` exists in the enum (`main:27297`) but is never sent by any code in these bundles |
| `orderBy` | literal `"views"` (always; the UI sort is client-side) |
| `limit` | literal `10` |

### 2.6 Post engagement

No separate request: uses `summary.engagement` (§3.1). `GET /account/stats/posts` (`getPostEngagement`, `main:26994-26996`) is defined in the API class but has **no caller** in the facade or in chunk 729.

### 2.7 Not used by this tab

- `GET /account/stats/media/shown` — only Overview (`729:1968`).
- `GET /account/stats/series`, `/geo`, `/fans/top`, `/fans` — other tabs.
- Legacy `/it/moie/stats`, `/it/moie/statsnew`, `/it/amoie/stats` (`main:62224-62249`): chunk 729 contains zero references (`grep moie|statsnew` = 0); their only callers are legacy components in main (`main:63075-63200`, `main:75574-75637`; legacy routes `/creator/profilestats`, `statistics/:mediaOfferId` `main:104486`). The new Content tab and its modal do **not** use them.

---

## 3. Response fields read by the client

### 3.1 `GET /account/stats/summary` (Content-tab subset) — `applySummary_`, `729:1266-1274`

```
response.views[]                      one row per source
  .source                             number (compared via Number())
  .views              {value, previous}    count  (FYP label "Views", otherwise "Video views")
  .imageViews         {value, previous}    count
  .uniqueViewers      {value, previous}    count
  .uniqueImageViewers {value, previous}    count
  .avgWatchMs         {value, previous}    ms      → formatDuration
  .avgWatchPercent    {value, previous}    percent 0–100 (INFERRED: rendered as round(value)+"%")
  .completedViews     {value, previous}    count
  .videoViews         {value, previous}    count (optional: falls back to .views when falsy)
  .replays            {value, previous}    count
  .mediaShown         {value, previous}    count (optional; tile only rendered when present)
  .avgImageWatchMs    {value, previous}    ms
  .series.views[]      {bucket, value}     bucket = ms epoch (UTC day), value = count
  .series.imageViews[] {bucket, value}
  .series.watchMs[]    {bucket, value}     value = ms
response.engagement
  .mediaLikes[]       {source, likes: {value, previous}, series: {likes: [{bucket, value}]}}
  .postLikes          {value, previous}
  .comments           {value, previous}
  .series.postLikes[] {bucket, value}
  .series.comments[]  {bucket, value}
```

Formatting:

- All `{value, previous}` → `toGrowthMetric` (rounded to int). Tile value = `shortNumber(value)` unless a `valueFormat` is given; delta pill = `round(deltaPercent)%` (capped at `>999%`), "New" when no previous and value > 0; footer "vs previous {window.days} days" (`main:20837-20839`).
- Completion rate tile = `ratioMetric(completedViews, videoViews || views, 100)` → integer %.
- Tile sparklines = `seriesValues(series.X)` (values only, server order) (`main:27205-27210`).
- Views chart: points passed through as `{bucket, value}`; watch chart: `value = round(series.watchMs.value / 60000)` minutes (`729:1271-1273`).
- Line chart (`main:20389-20418`): union of buckets sorted; >90 buckets → grouped into `ceil(n/90)` spans (sum); x labels in **UTC** (`"Mon D"`).
- `series` must exist on a `views[]` row (accessed without a guard).

### 3.2 `GET /account/stats/media/top` — `729:1338`, media list `729:1107-1133`

```
response.offers[]
  .mediaOfferId        string, = accountMedia.id
  .bestMediaId         string, = accountMedia.media.id or .preview.id
  .likes               count (shown as the row's "Likes")
  .media[]
     .mediaId          string
     .mediaType        1 = image, anything else = video (2)
     .views            count
     .uniqueViewers    count
     .watchMs          ms
     .durationMs       ms (0/absent → fallback to cached media metadata.duration * 1000)
     .videoViews       count
     .completedViews   count
     .watchPctSum      sum over video views of watched-% × 100 (INFERRED, see §5.1)
response.aggregationData.creatorMediaOfferLocations[]
     .mediaOfferId, .correlationId (= post id), .createdAt (number, compared only)
response.aggregationData.{accountMedia,…}   generic join (§0.4)
```

Per row (only the "best" media of each offer is shown; `bestMediaOf_`: `media[]` entry whose `mediaId === bestMediaId`, else `media[0]`; offer skipped if `media` is empty):

| UI | Formula |
|---|---|
| rank | array index + 1 (server order is kept; the client never re-sorts) |
| thumbnail | `mediaOfOffer(getCachedAccountMedia(mediaOfferId), best.mediaId)`; fallback `app-account-media[mediaId=mediaOfferId]` |
| type icon | `Number(best.mediaType) !== 1` → `video`, else `image` |
| Views | `shortNumber(best.views)` |
| Unique viewers | `shortNumber(best.uniqueViewers)` |
| Avg. watch | `formatDuration(best.views ? best.watchMs / best.views : 0)` + `"/ " + durationLabel(best.durationMs, mediaObj)` if duration known |
| Completion | only if `best.videoViews` truthy: `100 * completedViews / videoViews`, Angular `number:'1.0-0'` + `%` |
| Likes | `shortNumber(offer.likes)` |
| verdict line | `lengthVerdict(watchLiftPoints(best, benchmarks))` (§5.2) |
| post link | newest (max `createdAt`) location with the same `mediaOfferId` → `routerLink ["/post", correlationId]` (`newestPostByOffer_`, `729:1112-1123`) |

Empty list → "No data in this period." (`fansly_creator_stats_empty`).

### 3.3 `GET /account/stats/media/benchmarks` — read via `lengthBucketOf` / `buildComparison_`

```
response.buckets[]
  .lengthBucket      id, only used to build stringId "fansly_creator_stats_length_{lengthBucket}"
  .minMs             ms (0/absent = no lower bound)
  .maxMs             ms (0/absent = no upper bound)
  .mediaCount        count of the creator's videos in the bucket (must be >= 3 to be used)
  .videoViews        count (must be truthy)
  .avgWatchPercent   percent 0–100 (INFERRED: rendered round()+"%" and subtracted from a 0–100 value)
  .completionRate    ratio 0–1 (INFERRED: client multiplies by 100)   [modal only]
  .avgWatchMs        ms                                             [modal only]
```

No percentiles are read anywhere; a "benchmark" is the creator's own same-length-bucket average ("Compared with your videos of similar length").

### 3.4 `GET /account/stats/activehours` — `buildHeat_`, `729:1275-1288`; heatmap `729:402-447`

```
response.views[7][24]        count; first index = weekday 0..6 with 0 = Sunday, second = hour 0..23
response.imageViews[7][24]   same shape
```

- Cell value: FYP or `mediaType === 2` → `views[d][h]`; `mediaType === 1` → `imageViews[d][h]`; All (`0`) → `views + imageViews`.
- Day labels `["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]` indexed by the first index; rows are **displayed** Mon→Sun (`at = [1,2,3,4,5,6,0]`).
- The client does no time-zone shifting: the server must already return local weekday/hour using `timezoneOffsetMinutes`.
- Cell opacity `0.12 + 0.88 * value/max` (empty cells grey); caption "Busiest hour" (`fansly_creator_stats_heatmap_peak`) = first max cell in display order, `"{Ddd} {HH}:00 · {shortNumber}"`; hover caption `"{Ddd HH:00} {shortNumber} Views"`.
- Empty (max = 0) → "No data in this period." (`fansly_creator_stats_empty`).

### 3.5 `GET /account/stats/tags` — `buildTagRows_`, `729:1296-1322`

```
response.rows[]
  .tagId          string → getCachedTagById → "#"+tag.tag
  .views          count (bar value)
  .videoViews     count
  .watchPctSum    as in §5.1
  .liftPoints     percentage points (number | null | undefined)
  .imageViews     count (only used for the non-FYP sublabel)
response.series[]
  .tagId, .bucket (ms epoch UTC day), .views (count)
response.aggregationData.tags[]   {id, tag, …} → tag cache
```

Per row: `value = views`; secondary = `watchedPercent(watchPctSum, videoViews)` → `"N%"` or `"–"`; when sorted by "Watched %" the bar length uses that percent instead of views (`barValue`); sublabel = `tagVerdict(liftPoints, videoViews)` (§5.3), else (non-FYP and `imageViews` truthy) `"{shortNumber(imageViews)} image views"`; sparkline = `views` per day over `bucketsBetween(currentStart, currentEnd, "day")` (only if the window has > 1 day; last write wins per `tagId`+`bucket`).

### 3.6 `GET /account/stats/media` (detail modal) — see §4.3.

---

## 4. Media detail modal (`app-stats-media-detail-modal`, `729:799-1021`)

### 4.1 Opening

- Content tab: click / Enter / Space on a `selectable` row of `app-stats-media-list` → `offerSelect` → `ContentRoute.openMedia(offer)` → `modalService_.openModal(ht)` then `instance.setOffer(offer, this.source)` (`729:1252-1255`). Also opened the same way from Overview (`729:1987-1988`).
- `setOffer` (`729:808-810`): `likes = offer.likes`, `window = facade.getWindow()`, `periodDays = facade.getPeriodDays()`, `bestMedia` from the media cache, then `load()`.
- The modal keeps its **own** `window`, `periodDays`, `source`: changing them inside the modal does not touch the facade or the page behind it.

### 4.2 Controls

| Control | Values | Handler |
|---|---|---|
| Title | "Media performance" (`fansly_creator_stats_media_detail_title`) | – |
| Period selector | `[7, 30, 90]` + "Lifetime" (`fansly_profile_stats_overview_period_lifetime`, value `-1`) + "Custom" (`allowLifetime=true`, `allowCustom=true`, `729:1019`) | `setPeriod(e)`: `window = buildWindow(e === -1 ? 400 : e)` (`729:811-813`; `J.w = -1` `main:20694`; `d.tO = 400` `main:27009`) → `load()`. `setRange({from,to})` → `buildWindowForRange` → `load()` |
| Source switch | `M.Bs = [0, 1, 4]` | `setSource(e)` → `loadSurface_()` only (`729:817-819`) |
| Hashtags sort | Views=`"views"`, Watched %=`"watched"` (no "lift" here) | `setTagOrderBy` — client-side only (`729:959-961`) |

"Lifetime" is literally a **400-day window** ending today, not an unbounded query.

### 4.3 Requests

`load()` = `loadSurface_()` + `loadBreakdown_()` (`729:820-822`) → **3 GETs** on open and on every period/range change; source change → requests A + B only.

**A. Surface stats** — `loadSurface_` `729:823-831` → `facade.getMediaOfferStats(mediaOfferId, source, window, cb)` `main:27076-27079` → `api.getMediaOfferStats` `main:26976-26978` (`aggregated_`)

```
GET /account/stats/media?mediaOfferId={offer.mediaOfferId}&source={0|1|4}&after={window.currentStart}&before={window.currentEnd}[&overwriteAccountId={id}]
```

**B. Benchmarks** — `loadBenchmarks_` `729:832-837` → `facade.getWatchBenchmarks(source, this.window, cb)` (modal window, not the page window)

```
GET /account/stats/media/benchmarks?source={0|1|4}&after={…}&before={…}[&overwriteAccountId={id}]
```

**C. Surface breakdown** — `loadBreakdown_` `729:856-861` → `facade.getMediaOfferStats(mediaOfferId, M.kT, window, cb)`, `M.kT = -1` (`main:27297`)

```
GET /account/stats/media?mediaOfferId={…}&source=-1&after={…}&before={…}[&overwriteAccountId={id}]
```

Response fields read (A unless noted):

```
response.media[]
  .mediaId                string
  .mediaType              1 = image, else video
  .totals.durationMs      ms
  .totals.views           count, all time ("views all time")
  .daily[]
     .bucket              ms epoch (UTC day)
     .source              number (read only in call C)
     .views, .impressions, .watchMs (ms), .videoViews, .completedViews,
     .watchPctSum, .replays, .uniqueViewers, .durationMs (ms)
  .retention[]            {percent: 0–100 position in the video, stillWatching: 0–1 share}
  .retentionSampleSize    count
  .hours[]                {hourBucket: ms epoch hour, views: count}
  .tags[]                 {tagId, views, videoViews, watchPctSum}
response.likes[]          {source, likes}
response.tagSeries[]      {tagId, bucket, views}
response.aggregationData.creatorMediaOfferLocations[]   {correlationId, createdAt}
response.aggregationData.{accountMedia, tags, …}        generic join (§0.4)
```

`impressions` is summed into `periodTotals_` but never rendered.

### 4.4 Derived model (`apply_`, `729:907-944`)

- `periodTotals_(media)` (`729:893-897`): sums over **all** `daily[]` rows of `views, impressions, watchMs, videoViews, completedViews, watchPctSum, replays, uniqueViewers`; `durationMs` = first positive `daily[].durationMs`. Note: `uniqueViewers` here is a **sum of daily uniques** (not de-duplicated across days), unlike the list row, which shows the server's `uniqueViewers`.
- Rows: best media first (`mediaId === offer.bestMediaId`, `isBest=true`), then the others. Labels "Video" (`fansly_creator_stats_type_video`) / "Image" (`fansly_creator_stats_type_image`); when an offer has more than one of a type they become "Video 1", "Video 2"… (no stringId).
- `best = rows[0]`.

### 4.5 Sections and metrics (on-screen order)

| Section (stringId) | Shown when | Content / formula |
|---|---|---|
| Thumbnail | always | cached media object or `app-account-media[mediaId=mediaOfferId]` |
| "{n} views all time" (`fansly_creator_stats_media_detail_all_time`) | `best.media.totals.views` non-zero | `shortNumber(totals.views)` |
| Views (`fansly_creator_stats_media_views`) | `best` | `shortNumber(Σ daily.views)` |
| Unique viewers (`fansly_creator_stats_media_unique`) | `best` | `shortNumber(Σ daily.uniqueViewers)` |
| Avg. watch (`fansly_creator_stats_media_avg_watch`) | `best` | `formatDuration(views ? watchMs/views : 0)` + `"/ " + durationLabel(totals.durationMs || period.durationMs, mediaObj)` |
| Completion (`fansly_creator_stats_media_completion`) | video and `videoViews > 0` | `100 * completedViews / videoViews`, `number:'1.0-0'` + `%` |
| Replays (`fansly_creator_stats_media_replays`) | same condition as Completion | `shortNumber(Σ daily.replays)` |
| Likes (`fansly_creator_stats_media_likes`) | `best` | `Σ response.likes[i].likes where Number(source) === modal source` (before load: `offer.likes`) |
| "Last 48 hours" (`fansly_creator_stats_media_detail_hours`), desc "Views per hour on this surface, in your time zone." (`fansly_creator_stats_media_detail_hours_desc`) | `Σ best.media.hours[].views > 0` | `app-stats-hour-bars` with `points = [{bucket: hourBucket, value: views}]` (§5.5) |
| "Views per day" (`fansly_creator_stats_media_detail_daily`) | always | line chart, one series per media row: `{bucket: daily.bucket, value: daily.views}`; colors `--v2-blue-1` (first), `--v2-orange-1` (rest) |
| "Compared with your videos of similar length (pts are percentage points of the video watched)" (`fansly_creator_stats_media_detail_compare_title`) | `compareRows.length` | §5.4. Sub-line: `{bucket label}` · `{mediaCount}` "of your videos on this surface in the period" (`fansly_creator_stats_media_detail_compare_videos`); columns "This video" (`fansly_creator_stats_label_this_video`), "Similar videos" (`fansly_creator_stats_label_similar_videos`) |
| "Views by surface" (`fansly_creator_stats_media_detail_surfaces`), desc "Where this media's views came from in the period." (`fansly_creator_stats_media_detail_surfaces_desc`) | always (empty → "No data in this period.") | from call C, best media only: group `daily[]` by `source`; only sources in `[0, 1, 4]` with non-zero views are listed; `value = Σ views`, secondary "Unique viewers" `= Σ uniqueViewers`; sorted by views desc (`buildSurfaceRows_`, `729:876-892`). Sources 2 and 3 are dropped even if returned |
| "Retention" (`fansly_creator_stats_media_detail_retention`), desc "Share of views still watching at each point of the video." (`fansly_creator_stats_media_detail_retention_desc`), "{n} views sampled" (`fansly_creator_stats_media_detail_sampled`) | at least one video row with non-empty `retention` | `app-stats-retention-chart` (§5.6); `n = Σ retentionSampleSize` over those rows |
| "Media in this offer" (`fansly_creator_stats_media_detail_media`) | `rows.length > 1` | per media: label, duration, badge "Ranked" (`fansly_creator_stats_media_best`) on the best one, Views, Unique viewers, Avg. watch, Completion (same formulas) |
| "Hashtags" (`fansly_creator_stats_media_detail_tags`), desc "Views this media got through each of its hashtags, how much of it those viewers watched, and how that compares with the video's other viewers." (`fansly_creator_stats_media_detail_tags_desc`) | always | §5.7; columns "Views" / "Avg. watched %" |
| "Posted in" (`fansly_creator_stats_media_detail_posts`), desc "Timeline posts this media appears in. Tap one to open it." (`fansly_creator_stats_media_detail_posts_desc`) | `postLocations.length` | from call A `aggregationData.creatorMediaOfferLocations`: de-dup by `correlationId`, sort `createdAt` desc; link `/post/{correlationId}`; label `createdAt | date:'MMM d, y, HH:mm'` (local tz) or "Post" (`fansly_creator_stats_media_detail_post`) (`buildPostLocations_`, `729:945-954`) |

Error state: "Statistics could not be loaded right now." (only when call A fails; B and C fail silently into empty sections).

---

## 5. Client-side derived metrics and formulas

### 5.1 `watchPctSum` unit (INFERRED)

Every use divides by `videoViews` and then by `100`, and prints the result with `%` or compares it with a 0–100 value:

- `watchedPercent = round(watchPctSum / videoViews / 100)` (`main:27243`)
- `watchLiftPoints = watchPctSum / videoViews / 100 − bucket.avgWatchPercent` (`main:27235`)

So `watchPctSum` = Σ over video views of (watched percent × 100), i.e. hundredths of a percent ("basis points", 10000 = fully watched). The real server range is **UNRESOLVED**.

### 5.2 List-row verdict vs similar-length videos

`watchLiftPoints(best, benchmarks)` (`main:27232-27236`): `null` unless `best.videoViews >= 50`, a bucket matches `best.durationMs` (`lengthBucketOf`: first bucket with `d >= (minMs||0) && (!maxMs || d < maxMs)`, `main:27268-27273`; `d = 0` → no bucket), `bucket.mediaCount >= 3` and `bucket.videoViews` truthy. Value in percentage points.

`lengthVerdict(p)` (`main:27237-27241`), `N = round(p)`:

- `N <= -10` → "`|N|` pts below similar-length videos" (tone `bad`)
- `N >= 10` → "`N` pts above similar-length videos" (tone `good`)
- else → "`+N`/`−N` pts vs similar-length videos" (neutral)

Note: in the list the bucket lookup uses `best.durationMs` only (no cached-media fallback).

### 5.3 Tag verdict

`tagVerdict(lift, videoViews)` (`main:27223-27228`): `null` when `lift === undefined` or `videoViews < 50`; `lift === null` → "No other viewers to compare"; `L = round(lift)`: `<= -10` → "`|L|` pts below other viewers" (`bad`); `>= 10` → "`L` pts above other viewers" (`good`); else "`±L` pts vs other viewers". Short form `±L pts`.

- Content tab: `lift = rows[].liftPoints` (server value).
- Modal: computed client-side (§5.7).

### 5.4 Modal comparison table (`buildComparison_`, `729:845-855`)

Only if `best` is a video and benchmarks loaded. `dur = best.media.totals.durationMs || best.period.durationMs`; `s = lengthBucketOf(buckets, dur)`; requires `s.mediaCount >= 3` and `s.videoViews`.

| Row (stringId) | This video | Similar videos | Diff |
|---|---|---|---|
| Watched (`fansly_creator_stats_label_watched`) | `round(watchPctSum/videoViews/100)%` (0 if no video views) | `round(s.avgWatchPercent)%` | `±round(diff) pts` |
| Completion (`fansly_creator_stats_media_completion`) | `round(completedViews/videoViews*100)%` | `round(100*s.completionRate)%` | `±round(diff) pts` |
| Avg. watch time (`fansly_creator_stats_label_avg_watch_time`) | `formatDuration(watchMs/views)` (denominator = all `views`) | `formatDuration(s.avgWatchMs)` | `±round(diffMs/1000)s` |

`diffText_`: `"+N"`, `"−N"` (U+2212) or `"±0"` + suffix; arrow direction = `sign(round(diff))`. Bucket label (`lengthBucketLabel`, `main:27274-27278`): `"A to Bs"`, `"Up to Bs"` (no min) or `"Over As"` (no max), seconds = `round(ms/1000)`.

### 5.5 Hour bars (`app-stats-hour-bars`, `729:509-558`)

Inputs used by the modal: `points` only → `hours = 48`, `endBucket = floor(Date.now()/3600000)*3600000`. Bars = 48 consecutive hour buckets ending at the current hour; a point is used only if `Number(bucket)` equals one of them exactly (others are dropped; duplicates summed). Labels use the **browser's local time** (`"Ddd HH:MM"`). Bar height `max(4, value/max*100)%` (2% if empty); `peak` class when `value >= 0.75*max`; caption "Busiest hour" = max bar. Empty → "No views in the last 48 hours." (`fansly_creator_stats_hours_empty`).

### 5.6 Retention chart (`app-stats-retention-chart`, `729:595-630`)

Per series point: `x = clamp(percent, 0, 100)/100 * 100`, `y = (1 − clamp(stillWatching, 0, 1)) * 40` (SVG `viewBox 0 0 100 40`, polyline `M/L`). `hasData` if any `stillWatching > 0`, else "Retention appears once the video has views." (`fansly_creator_stats_retention_empty`). Y axis `100% / 50% / 0%`. X labels at `[0, .25, .5, .75, 1]`: with exactly one series and `durationMs > 0` → `formatDuration(durationMs * q)`; otherwise `0% … 100%`. `durationMs` passed = `totals.durationMs || period.durationMs` of the single retention video (`729:930-937`). Legend only when > 1 series. Points are plotted in server order (no client sort).

### 5.7 Modal hashtag rows (`buildTagRows_`, `729:962-1003`)

Aggregated over **all** media of the offer by `tagId`:

- `views += tag.views`, `videoViews += tag.videoViews`, `watchPctSum += tag.watchPctSum`
- lift: with `f = tag.videoViews`, `k = tag.watchPctSum`, `x = mediaPeriod.videoViews − f`; if `f > 0 && x > 0`: `liftSum += (k/f − (mediaPeriod.watchPctSum − k)/x) / 100 * f`, `liftWeight += f`; `lift = liftWeight ? liftSum/liftWeight : null` (tag viewers' avg watched % minus all other viewers', in pts, weighted by tag video views)
- sort: "views" → views desc; "watched" → `watchedPercent` desc (nulls last, ties by views desc); then **top 10**
- row: `value = views`, secondary `"N%"`/`"–"`, verdict `tagVerdict(lift, videoViews)`, sparkline from `tagSeries` over the modal window's day buckets (summed per tag+bucket)
- warning banner (worst `bad` tag): "Viewers from {#tag | this tag} watched {|round(lift)|} points less of this video than everyone else. A tag that brings swipers costs the video its standing."

### 5.8 Content hashtag sort (client-side)

"views" keeps server order; "watched" sorts by `watchedPercent` desc; "lift" by `liftPoints` desc; nulls last; ties by `views` desc (`729:1299-1307`).

### 5.9 Bar table (`app-stats-bar-table`, `main:19942-19968`)

Bar width = `(barValue ?? value) / max` over visible rows; value cell `shortNumber(value)`; secondary cell `secondaryText` if set, else `shortNumber(secondaryValue)`; "Trend" column appears when any row has a sparkline with > 1 points.

---

## 6. Enumerations / constants (literals)

| Name | Literal | Label | Ref |
|---|---|---|---|
| Source `EL.FYP` | `0` | "For You" (`fansly_creator_stats_source_0`) | `main:27297`, `main:27009` |
| Source `EL.TIMELINE` | `1` | "Timeline" (`fansly_creator_stats_source_1`) | |
| Source `EL.SUGGESTIONS` | `2` | "Suggestions" — in label map, **not selectable** | |
| Source `EL.SEARCH` | `3` | "Search" — in label map, **not selectable** | |
| Source `EL.OTHER` | `4` | "Other" (`fansly_creator_stats_source_4`) | |
| Source options `Bs` | `[0, 1, 4]` | switch order | `main:27297` |
| All sources `kT` | `-1` | modal breakdown call only | `main:27297`, `729:858` |
| Media type `qq.IMAGE` | `1` | "Images" | `main:27297` |
| Media type `qq.VIDEO` | `2` | "Videos" | |
| Media type "All" | param omitted (UI value `0`) | "All" | `729:1238`, `729:1337` |
| Tag kind `k6.VIEWER_FILTER` | `1` | sent | `729:1355` |
| Tag kind `k6.POST_TAG` | `2` | never sent | `main:27297` |
| Media order `mM.VIEWS` | `"views"` | "Views" | `729:1238` |
| `mM.UNIQUE_VIEWERS` | `"uniqueViewers"` | "Unique viewers" | |
| `mM.WATCH_MS` | `"watchMs"` | "Watch time" | |
| `mM.COMPLETED_VIEWS` | `"completedViews"` | "Completed" | |
| `mM.WATCH_LIFT` | `"watchLift"` | defined, **never sent** by any code in the bundles | `main:27297` |
| Tag order (request) | `"views"` | – | `729:1355` |
| Tag sort (client) | `"views"`, `"watched"`, `"lift"` (modal: `"views"`, `"watched"`) | Views / Watched % / vs viewers | `729:1233,1238`, `729:798,803` |
| Top media limit | `20` (Content), `3` (Overview) | – | `729:1337`, `729:2024` |
| Tags limit | `10` | – | `729:1355` |
| Period options `Z2` | `[7, 30, 90]`, default `30` | "N days" | `main:27009,27014` |
| Lifetime sentinel `J.w` | `-1` → window of `tO = 400` days | "Lifetime" (modal only) | `main:20694`, `729:812` |
| Day / hour | `86400000` / `3600000` ms | – | `main:27009`, `729:508` |
| Verdict thresholds | `videoViews >= 50`, bucket `mediaCount >= 3`, `±10` pts | – | `main:27224,27233,27235` |
| Hour bars | `48` hours, peak `>= 0.75 * max` | – | `729:513,540` |
| Heatmap row order | `[1,2,3,4,5,6,0]` (Mon…Sun), index 0 = Sun | – | `729:402` |
| Retention x ticks | `[0, 0.25, 0.5, 0.75, 1]` | – | `729:594` |
| Series colors | `--v2-blue-1`, `--v2-orange-1` | – | `729:798` |
| Auto-refresh threshold | `300000` ms hidden | – | `729:2087` |

No monetary (mills) values are read anywhere in the Content tab or the modal.

---

## 7. Interactions that change requests

| Interaction | Effect |
|---|---|
| Page period preset / custom range | `facade.setPeriod/setRange` → `onWindowChange` → `ContentRoute.load()` (`729:1364-1366`) → all 5 GETs with new `after`/`before` |
| Refresh button, or return after ≥ 5 min hidden | `facade.refresh()` (`main:27052-27054`) emits `onWindowChange` (+ `onRefresh`, which Content does not subscribe to) → all 5 GETs |
| Source switch | `facade.setSource` → `onSourceChange` → `onSourceChange_()` (`729:1359-1361`): summary is **re-sliced locally (no new summary request)**; re-requests media/top, media/benchmarks, activehours, tags with the new `source`. Switching to FYP forces `mediaType = 0` |
| Media-type filter (Top media card or heatmap card; shared state) | `setMediaType` (`729:1246-1248`): heatmap rebuilt locally; re-requests media/top (`mediaType` added/omitted) **and** media/benchmarks (unchanged params) |
| Top media sort | `setOrderBy` (`729:1249-1251`): re-requests media/top (`orderBy`) **and** media/benchmarks |
| Hashtag sort | client-side only, no request |
| Show more / pagination | none in the Content tab (media list unbounded over the 20 returned; bar table `limit` unset) |
| Row click | opens modal → 3 GETs (§4.3) |
| Modal period / custom range / Lifetime | 3 GETs with the modal's own window |
| Modal source switch | requests A + B only; "Views by surface" (C) is kept |
| Modal hashtag sort | client-side only |
| Stale responses | each loader uses an incrementing token; late responses are ignored (`loadToken_`, `mediaToken_`, `hoursToken_`, `tagsToken_`, `benchmarksToken_`, `breakdownToken_`) |

The facade `source_` is shared across tabs within a session (also set by Audience `729:246` and read by Overview `729:2024`).

---

## 8. Open questions / UNRESOLVED

1. `before` semantics server-side (inclusive last-day bucket vs exclusive bound). The client sends 00:00 UTC of the last day and enumerates buckets inclusively.
2. Real units/ranges of `watchPctSum` (inferred ×100 percent), `avgWatchPercent` (inferred 0–100), benchmarks `completionRate` (inferred 0–1), retention `percent` (clamped 0–100) and `stillWatching` (clamped 0–1). All inferred from client arithmetic only.
3. Whether `daily[]` of a single-source `/account/stats/media` call contains only that source's rows and whether it carries `source` (the client sums all rows blindly there and reads `source` only in the `source=-1` call).
4. Which `aggregationData` keys each stats endpoint really returns (`accountMedia`? `accountMediaBundles`? `tags`? `posts`?), and the full shape of `creatorMediaOfferLocations` items (only `mediaOfferId`, `correlationId`, `createdAt` are read; unit of `createdAt` — compared numerically and fed to the Angular `date` pipe, so presumably ms — not proven).
5. Server meaning of tags `kind` (`1` VIEWER_FILTER vs `2` POST_TAG); only the UI copy ("through hashtag browsing") hints at kind 1. `kind=2` is never requested.
6. Whether the server accepts `orderBy=watchLift` for media/top, other `orderBy` values for tags, `source` 2/3, larger `limit` values, or any paging param (none exists in the client).
7. `lengthBucket` id values and the bucket boundaries (`minMs`/`maxMs`) — server data; localized bucket names (`fansly_creator_stats_length_{id}`) are not in the bundle.
8. Time span of `media[].hours[]` returned by the server (client just shows the last 48 local hours) and exact alignment of `hourBucket` (must be an exact hour-aligned ms epoch to be drawn).
9. `liftPoints` server definition, and when it is `null` vs absent.
10. When `views[].mediaShown` and `views[].videoViews` are present (both treated as optional by the client), and whether `views[].views` for non-FYP sources excludes image views (labels say "Video views"; heatmap "All" adds `views + imageViews`).
11. Meaning/authorization of `overwriteAccountId` (taken from the page URL query string).
12. `GET /account/stats/posts` (`postIds`, `after`, `before`) is defined but unused in these bundles — response shape unknown.
13. Auth headers / request signing performed by `authInterceptorService_` — outside this slice.
14. `uniqueViewers` in the modal is a client-side sum of daily values; whether the server offers a de-duplicated per-period figure for a single media outside `/media/top` is unknown.
