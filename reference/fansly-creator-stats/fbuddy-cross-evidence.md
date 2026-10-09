# FBuddy 2026.927.830 — evidence on Fansly `/api/v1/account/stats/*`

Static reading only. Snapshot root: `~/code/1-platform/fbuddy-analysis/snapshots/2026.927.830/layout/`.

File aliases used in references:

- `P:` = `readable/chunks/popup-YfJ3obO0.js`
- `M:` = `readable/content-scripts/main.js`
- `H:` = `readable/injections/fbuddy-network-hook.js`
- `L:` = `readable/i18n/main/en.json` (array; `L[n]` = message index n, resolved with jq)
- `X:` = `indexes/ast-network-literals.json`

Markers: **INFERRED** = deduced from order/usage, not from an explicit code link. **UNRESOLVED** = cannot be established from the snapshot.

---

## 0. Structural findings that change how to read everything below

1. **Call sites are not in the popup chunk.** `P` holds the URL builders (P:28553-28663), the Fansly client class with the 10 methods (P:30104-30223) and the zod schema block, but nothing in `P` calls those methods (grep: only the definitions at P:30104-30207). All callers are in `M`, which carries an identical copy of the builders (M:31074-31184), methods (M:32658-32777) and schemas (M:28727-29144, M:30448-30538). The shared client instance is `Jt` (M:36333-36343).
2. **The response zod schemas are declared but never executed.** Envelope schemas `xK…UK, BK` are referenced only at their own definition (P:26740-26757); same for the `M` copies `C2r…W2r` (M:29133-29144) and for all query schemas `Ree…Uee` (P:28032-28111) / `Ixr…Uxr` (M:30451-30538). No `.parse/.safeParse` call uses them. They are a declared contract (they carry `.describe()` notes, e.g. P:26689-26691, P:26755-26757, P:28084-28088), not a runtime gate.
3. **What is actually enforced at runtime** on a stats response: (a) the generic recursive JSON schema `Pv = g_()` = union(string, number, boolean, null, array(self), record(string,self)) (P:28678, P:15463-15466) applied to the whole body (P:29048); (b) envelope checks `success` truthy + `response` truthy in each method (P:30118, 30128, 30138, 30155, 30171, 30181, 30191); (c) ad-hoc per-field guards at the call sites (documented per route below).
4. **Schema-to-route binding is INFERRED.** No code object links a schema to a URL. Binding below rests on: declaration order of query schemas matching builder order exactly (builders C9, O9, F9, D9, L9, N9, $9, z9, U9 at P:28586-28663 vs schemas Ree, Tee, kee, [xee], Pee, Cee, Oee, [Fee, Dee], Lee, Nee, [$ee, zee], Uee at P:28032-28111), field names, and field access at call sites. For the 7 used routes the binding is corroborated by call-site usage; for the 5 unused routes it rests on order and field names only.
5. zod aliases in `P` (zod v4): `u`=object, non-loose (P:15195-15198); `oc`=object with `catchall: unknown` (P:15199-15201, not used by any stats schema); `v`=array (P:15145); `p`=number (P:15089, P:14003); `f`=number with `format:"safeint"` i.e. int (P:15095, P:14006-14008); `o`=string (P:14954); `S`=boolean (P:15101); `j`=null (P:15107); `ye`=unknown (P:15113); `U`=union (P:15208); `x`=enum (P:15268); `F`=literal (P:15287); `ae`=record (P:15241). **No stats schema uses `.loose()`/passthrough**; the only `.loose()` nearby is the error helper `hl` (P:28664-28666).

---

## 1. Request mechanics common to all Fansly API calls

### Method, URL, options
- Base `https://apiv3.fansly.com/api/v1` (P:28715). Each stats method builds `new URL(builder(params), base)` and then adds `ngsw-bypass=true` (e.g. P:30125-30126). Builders append every key whose value is not `undefined`; `null` is sent as the string `null`; values go through `String()` (P:28587-28592).
- HTTP method: `GET` (default of `fanslyRequest(e, t = "GET", n = null, r)`, P:28945; all stats methods call it with the URL only, P:30117, 30127, 30137, 30154, 30170, 30180, 30190).
- fetch options: `mode:"cors"`, `credentials:"include"`, `referrer:"https://fansly.com/"`, `referrerPolicy:"strict-origin-when-cross-origin"`, no body (P:28970-28980; `M` copy M:31491-31500).
- GET de-duplication: identical in-flight GETs (same method+URL+headers) share one promise (M:27591-27608).
- Retries: up to 6 attempts (P:28956); HTTP 429 → retry via adaptive limiter, give up after the 6th (P:29005-29023); HTTP 401 on first attempt → clear token, re-read from localStorage, retry once (P:29024-29030); thrown fetch error → wait 1 s, retry (P:29086-29087). Non-OK other statuses return the parsed JSON body if any, else `undefined` (P:29041-29046).
- Pacing: adaptive limiter keyed by `"<METHOD> <normalized path>"` where numeric path segments become `:id` (key: M:11801-11803; normalization P:28728-28743; acquire P:28941-28944, 28964). Defaults: initial spacing 400 ms, min 25 ms, max 120 000 ms, cooldown 5 s, backoff x2.25, max concurrency 8 (M:11777-11800). No stats-specific policy exists (only one other `account/stats` literal in `M`, the passive listener at M:41082).
- Side effect: any `response.aggregationData` is fed to FBuddy's cache (accounts, groups, accountMedia, accountMediaBundles, accountMediaOrders) (P:25729-25733, P:25737-25800, P:29060-29062).

### Headers
- Sent headers = `accept: "application/json, text/plain, */*"` + captured client headers + `authorization` (when auth included and a token exists); `content-type: application/json` only when there is a body (P:28931-28934).
- **authorization**: raw token string from `localStorage["session_active_session"]` parsed as JSON `{token?: string}` (P:28869-28897, getter P:28898-28907). No `Bearer` prefix is added (P:28933). In the Electron build the token is the constant string `relayed` (M:36332-36334); what replaces it downstream is UNRESOLVED.
- **fansly-client-id, fansly-client-ts, fansly-client-check, fansly-session-id**: FBuddy does not compute any of them. A page-world script wraps `window.fetch` and `XMLHttpRequest` (H:204-253, H:270-353), and for every request to `fansly.com`/`*.fansly.com` under `/api/` except the CDN hosts (H:181-196) copies exactly these four request headers (H:56-61, H:120-141, H:293-305) into a bridge event. The content script validates the header bag with the zod object of four optional strings (P:28718-28723 / M:31239-31244) and stores each non-empty value, overwriting the previous one (M:34476-34485; `setClientHeaders` P:28908-28915). They are then replayed verbatim on every FBuddy request (P:28932).
- **Is `fansly-client-check` per route?** In FBuddy: **no**. One stored value (the last one Fansly's own web app sent on any API route) is reused for all routes, together with the equally stale `fansly-client-ts`. Whether Fansly's server ties the check to URL/timestamp is **UNRESOLVED** from this snapshot; FBuddy's design only shows that its authors expect a replayed value to be accepted.
- Injection wiring: hook script injected by the content script (M:20301-20321), listed as a web-accessible resource (`readable/manifest.json:21`).

### Envelope handling
- Declared envelope for every stats route: `{ success: boolean (required), response: <payload>.optional(), error: union({code:number, details:string}, null).optional() }` (P:26740-26750; error object `J` P:26347).
- Runtime: method returns `response` when `success` and `response` are truthy, otherwise logs a warning and returns `undefined` (P:30118-30122 and siblings). Special cases: earnings-by-account requires `Array.isArray(response.data)` (P:30108); tracking links and their stats require `Array.isArray(response)` (P:30201, P:30218).

---

## 2. Per-route evidence (routes FBuddy calls)

Shared date-window helpers: `No(tz)` = today's calendar date in `tz` (M:55160-55162); `Ai()` = browser local time zone (M:55174-55176). All `after`/`before` values are **epoch milliseconds** (produced by `Date.getTime()`).

Media Performance window (used by summary, media/top, tags, activehours): paid users choose a range, default start = UTC-today minus 29 days, end = UTC-today; free users are fixed to the last 7 days (M:179644-179650). `after` = local midnight of start; `before` = local midnight of (end + 1 day) minus 1 ms, i.e. inclusive end-of-day (M:179651-179652). Shared query object = `{source, after, before}` (M:179653). `source` state accepts only 0, 1, 4 (M:179686-179689), default 0 (M:179645).

### 2.1 `GET /account/stats/summary` — builder C9 (P:28586-28593), method `getCreatorStatsSummary` (P:30124-30133)

**Request** (single call site M:179663-179685): params `{after, before}` only (M:179667). No `source` is sent; the source split is done client-side. Refetched when the window key `after:before` changes (M:179654, 179664-179666).

Declared query schema `Ree` (P:28032): `after` int optional, `before` int optional, `overwriteAccountId` string optional. FBuddy never sends `overwriteAccountId` on any stats route (the name occurs only in schema declarations, M:30354-30538).

**Declared response** `y3` (P:26423-26510). Building blocks: `Stat` = `{value?: number, previous?: number}` (P:26405); `Point` = `{bucket?: number, value?: number}` (P:26406); `Series` (P:26407-26422) = object of optional `Point[]`: `views, imageViews, watchMs, profileVisits, follows, unfollows, subscriptionsNew, subscriptionsExpired, grossMills, netMills, refundedNetMills, likes, postLikes, comments`. All fields below are optional.

- `dataSince`: number
- `followerCount`: Stat; `subscriberCount`: Stat
- `levels`: array of `{bucket: number, followerCount: number, subscriberCount: number}`
- `views`: array (one element per source) of
  - `source`: number
  - `views, imageViews, uniqueViewers, uniqueImageViewers, avgWatchMs, avgWatchPercent, completedViews, videoViews, replays, mediaShown, avgImageWatchMs`: Stat each
  - `series`: Series
- `revenue`: object
  - `netAfterRefundsMills, grossMills, netMills, refundedNetMills, transactions, refunds, payingFans, newPayingFans`: Stat each
  - `series`: Series
  - `byProductType`: array of `{productType: number, netMills: Stat, grossMills: Stat, transactions: Stat, refunds: Stat}`
- `profile`: object `{profileVisits: Stat, uniqueVisitors: Stat, avgProfileWatchMs: Stat, series: Series, bySource: array of {source: number, profileVisits: Stat, uniqueVisitors: Stat}}`
- `follows`: object `{follows: Stat, unfollows: Stat, netFollows: Stat, series: Series}`
- `subscriptions`: object
  - `subscriptionsNew, subscriptionsRenewed, subscriptionsExpired, subscriptionsCancelled`: Stat each
  - `series`: Series
  - `byTier`: array of `{tierId: string, tierName: string, tierActive: boolean, tierColor: string, tierPos: number, subscriberCount: Stat, subscriptionsNew: Stat, subscriptionsMovedIn: Stat, subscriptionsMovedOut: Stat}`
- `engagement`: object `{mediaLikes: array of {source: number, likes: Stat, series: Series}, postLikes: Stat, comments: Stat, series: Series}`

**Usage** (feature: "Media Performance" modal, L[693], Overview tab L[449]; M:179640, tabs M:179878-179930):
- Picks `views[]` element whose `source` equals the selected source, and `engagement.mediaLikes[]` element likewise (M:174773-174776).
- KPI tiles (M:177223-177234) with labels: Views L[3125] = `views + imageViews`; Viewers L[2857] = `uniqueViewers + uniqueImageViewers` (sums of value and of previous, M:174755-174764, 174778-174779); Likes L[3163] = `mediaLikes[].likes`; Media shown L[5036] = `mediaShown`; Avg. watch % L[5038] = `avgWatchPercent` shown as-is with one decimal and `%` (so a 0-100 scale; formatter M:174796-174803); Avg. watch time L[5040] = `avgWatchMs` treated as milliseconds, rendered `Xm Ys` (M:174791-174795); Completion rate L[5042] = derived `completedViews / videoViews * 100` for both value and previous (M:174765-174771, 174784); Replays L[5044] = `replays`.
- `previous` is the prior-period value: tile shows change % = `(value - previous) / |previous| * 100` (M:177000-177005) and a "Previous: …" tooltip (M:177100-177101, L[525]).
- Charts (M:179550-179565): daily Views = `series.views` + `series.imageViews` merged by `bucket`; Watch time = `series.watchMs` divided by 60 000, axis "Minutes" (L[352]); Likes = `mediaLikes[].series.likes`. `bucket` must be a finite number in (0, 8.64e15] and is passed to `new Date(bucket)` → epoch ms (M:174712-174729, M:179512).
- Never read by FBuddy (declaration only): `dataSince, followerCount, subscriberCount, levels, avgImageWatchMs`, all of `revenue`, `profile`, `follows`, `subscriptions`, `engagement.postLikes/comments` (single occurrences at M:28803-28884).
- The "Follows" (L[5031]) and "New visitors" (L[5033]) tiles on the same tab do **not** come from summary; see 2.8.

### 2.2 `GET /account/stats/media/top` — builder D9 (P:28610-28619), method `getCreatorStatsTopMedia` (P:30134-30143)

**Request** (M:178962-178966, initial M:178997-178999, re-sort M:178922-178924): `{source, after, before, orderBy, limit: 100}`. `orderBy` initial `"views"` (M:178914); UI allows `views | uniqueViewers | watchMs | completedViews` (M:178923) with labels Views / Viewers / Watch time / Completed (M:174746-174751). Changing the ranking triggers a new server request. `mediaType` is never sent.

Declared query `Pee` (P:28042-28050): `source` union of literals 0|1|4 optional; `mediaType` union of literals 1|2 optional; `after`, `before` int optional; `orderBy` enum `views | uniqueViewers | watchMs | completedViews | watchLift` optional; `limit` int optional; `overwriteAccountId` string optional. `watchLift` is declared but never sent.

**Declared response** `_3` (P:26529-26551), all optional:
- `offers`: array of
  - `mediaOfferId`: string; `bestMediaId`: string; `likes`: number
  - `media`: array of `{mediaId: string, mediaType: number, views: number, uniqueViewers: number, watchMs: number, durationMs: number, videoViews: number, completedViews: number, watchPctSum: number, likes: number}`

**Usage** (Top media tab, L[5055]):
- Flattens `offers[].media[]`, keeps items with non-empty string `mediaId`, attaches the offer's trimmed `mediaOfferId`, and uses `media.likes ?? offer.likes` (M:178972-178983).
- Card shows rank, Views = `views`, Viewers = `uniqueViewers`, "Engagement" (L[708]) = `watchPctSum / videoViews / 100` formatted as percent (M:174805-174809, M:179319-179325), Likes = `likes`.
- "FBuddy Score" (L[707]): only for `mediaType === 2` with `views > 0` and finite `watchMs` (M:174733-174740); inputs sent to FBuddy's own backend are `views`, `watchMs`, `durationMs` (M:178938-178947, M:112967-112972). So FBuddy treats `mediaType` 2 as video.
- File name/preview come from a separate media lookup by `mediaId` (M:178926-178933). Clicking a card opens media details for `mediaOfferId` (M:179331).
- `bestMediaId` and `completedViews` are not read from this response.

### 2.3 `GET /account/stats/media` — builder L9 (P:28620-28627), method `getCreatorStatsMedia` (P:30144-30160)

**Client-side precondition**: non-empty `mediaOfferId`; `after`/`before`, when given, non-negative safe integers with `after < before`; else throws (P:30145-30151).

**Request** — two calls per view (M:175205-175215):
1. selected source: `{mediaOfferId, source, after, before}` (params M:175596-175601; `source` restricted to 0|1|4, M:175725-175728; default from the opener or 0, M:175580).
2. source breakdown: same object with `source: -1` (M:175213). Its `daily[]` rows are grouped by their own `source` field (M:175287-175297).

Window: same math as 2.1 (M:175582-175600).

Declared query `Cee` (P:28051-28057): `mediaOfferId` string **required**; `source` union of literals -1|0|1|4 optional; `after`, `before` int optional; `overwriteAccountId` string optional.

**Declared response** `S3` (P:26594-26626), all optional unless noted. `Row` = `ki` (P:26552-26570): `{mediaId: string, mediaOfferId: string, bucket: string, hourBucket: string, tagId: string, mediaType: number, durationMs: number, source: number, kind: number, views: number, impressions: number, watchMs: number, videoViews: number, completedViews: number, watchPctSum: number, replays: number, uniqueViewers: number}` (note `bucket`/`hourBucket` are declared as **string** here).
- `afterBucket`, `beforeBucket`, `source`: number; `mediaOfferId`: string
- `media`: array of
  - `mediaId`: string; `mediaType`: number
  - `totals`: Row, `.nullish()` (null or absent)
  - `daily`: Row[]; `hours`: Row[]; `tags`: Row[]
  - `retention`: array of `{percent: number, stillWatching: number}`
  - `retentionSampleSize`: number
- `likes`: array of `{source: number, bucket: string, likes: number, unlikes: number}`
- `tagSeries`: Row[]
- `aggregationData`: object
  - `accountMedia`, `accountMediaBundles`: arrays of the full account-media object `Oa` (P:26324-26346)
  - `tags`: array of `Xc` (P:26571-26580): `{id: string, tag: string, label?: string, description: string, viewCount: number, postCount?: number, flags: number, createdAt: number}` (non-optional except where marked)
  - `creatorMediaOfferLocations`: array of `w3` (P:26581-26593): `{id, mediaOfferId: string, mediaOfferType: number, mediaOfferBundleId: string|null, mediaId: string, mediaType: number, previewId: null, accountId, locationId, correlationId: string, createdAt: number}` (all required)

**Usage** (feature: "Media performance details" modal, L[5316]; opened from Top media, and from a button FBuddy adds to Fansly's own statistics page/modal, M:217573-217594):
- Period totals are **not** taken from `totals`; they are sums over `daily[]` of `views, impressions, watchMs, videoViews, completedViews, watchPctSum, replays, uniqueViewers` (M:175226-175235, 175244-175264). Derived: avg watch time = `watchMs / views`; avg watched % = `watchPctSum / videoViews / 100`; completion % = `completedViews / videoViews * 100` (M:175254-175258). This implies `watchPctSum` is a per-view sum in hundredths of a percent (INFERRED from the formula).
- `totals.views` is shown as all-time views (M:176970; tooltip L[5281] says it does not change with dates). `totals.durationMs`, else first `daily[].durationMs`, is the video duration in ms (M:175615).
- Tiles (M:175624-175638): Views, Watch time (ms → `Xm Ys`), Likes (sum of `likes[].likes` for rows with no `source` or the selected source, M:175620-175621), Viewers (sum of daily `uniqueViewers`; tooltip L[5328] notes cross-day double counting), Average watch time, Average watched, Watched to end, Times shown = `impressions`, Full watches = `completedViews`, Replays, Likes removed = sum of `likes[].unlikes`.
- Daily chart: `daily[]` grouped by `bucket` (string → Number; valid if 0 < n ≤ 8.64e15, i.e. epoch ms) summing `views` or `watchMs`; likes chart uses `likes[].bucket` (M:175239-175243, 175265-175275, 175639-175646).
- Hourly chart "Recent hourly views" (L[5221]): `media[].hours[]` grouped by `hourBucket` summing `views` (M:176381-176384).
- Retention chart: `retention[]` kept when `percent` in [0,100] and `stillWatching` in [0,1]; plotted as x=`percent`, y=`stillWatching*100` (M:175647-175662). `retentionSampleSize` is not read (M:28997 only).
- "Where views came from" (L[5275]): from the `source=-1` call, per-source sums of `daily[]`, sorted by views desc; share = source views / total (M:175616-175618, 175294-175296, 175546-175552). Labels: 0 For You Page, 1 Timeline, 2 Suggestions, 3 Search, 4 Other; unknown code → "Source N" (M:175276-175286, L[6295]).
- Tags: `media[].tags[]` rows (need `tagId`) with the same derived metrics; name = `aggregationData.tags[].label`, else `.tag`, else the id (M:175312-175315, 175685-175699). Tag chart = `tagSeries[]` filtered by `tagId`, grouped by `bucket`, summing `views` (M:175669-175674).
- Posts list: `aggregationData.creatorMediaOfferLocations[]` (matching `mediaId` or without one), unique by `correlationId`, newest `createdAt` first, linked to `https://fansly.com/post/<correlationId>` (M:175675-175684, M:176313).
- `aggregationData.accountMedia[]` element matched by `mediaId` or `media.id` supplies filename, upload date, current like count (M:175609-175613, M:176962, M:176971).
- `mediaType`: 2 → "Video", 1 → "Image" (M:176965-176969, L[3127], L[3126]).

**Runtime-enforced schema on Fansly's own traffic.** FBuddy also listens to successful XHR GETs made by the Fansly web app to any `*.fansly.com` path ending in `/account/stats/media` (M:41074-41083) and `safeParse`s the body with a real schema (M:41044-41055): `success` literal `true`; `response.mediaOfferId` string min 1; `response.media` array of `{mediaId: string min 1}`; `response.aggregationData.accountMedia` and `.accountMediaBundles` arrays of `{id: string, accountId: string}`, each `.default([])`. It additionally requires `response.mediaOfferId` to equal the request's `mediaOfferId` query param and one aggregation entry with `id === mediaOfferId` owned by the current account (M:41096-41103). Result: a mediaId → mediaOfferId map (last 20) used to open FBuddy's details from Fansly's stats modal (M:41104-41112, M:41068-41073). This confirms Fansly's own client sends `mediaOfferId` as a query parameter on this route.

### 2.4 `GET /account/stats/media/benchmarks` — builder N9 (P:28628-28637), method `getCreatorStatsMediaBenchmarks` (P:30161-30176)

**Precondition**: same `after`/`before` validation as 2.3 (P:30162-30167).

**Request** (M:175216-175221): `{source, after, before}` taken from the media-details query (no `mediaOfferId`).

Declared query `Oee` (P:28058-28063): `source` 0|1|4 optional; `after`, `before` int optional; `overwriteAccountId` optional.

**Declared response** `I3` (P:26627-26647), all optional: `afterBucket, beforeBucket, source`: number; `buckets`: array of `{lengthBucket, minMs, maxMs, mediaCount, views, watchMs, videoViews, completedViews, watchPctSum, avgWatchMs, avgWatchPercent, completionRate}` (all number).

**Usage** ("Video comparison" / "Compared with your other videos", L[5294], L[5310]; only for `mediaType === 2`, M:176735):
- Picks the first bucket with `minMs ≤ duration` and (`maxMs` falsy or `duration < maxMs`), `mediaCount ≥ 3`, `videoViews > 0` (M:175298-175311). Caption shows `mediaCount` and the `minMs`–`maxMs` range rendered as durations, or "or longer" when `maxMs` is falsy (M:176458-176460).
- Baseline columns (M:175710-175724): `avgWatchMs` as time (ms); `avgWatchPercent` shown as-is as percent (0-100 scale, compared against the derived 0-100 value); `completionRate` **multiplied by 100** (so the server value is a 0-1 fraction).
- `lengthBucket`, and the raw `views/watchMs/completedViews/watchPctSum` of a bucket, are not read.

### 2.5 `GET /account/stats/activehours` — builder $9 (P:28638-28647), method `getCreatorStatsActiveHours` (P:30187-30196)

**Request** (M:177392-177397): `{source, after, before, timezoneOffsetMinutes}` where `timezoneOffsetMinutes = -new Date(before).getTimezoneOffset()`, i.e. minutes **east** of UTC at the window end (UTC+3 → 180) (M:177394).

Declared query `Lee` (P:28072-28078): `source` 0|1|4 optional; `after`, `before`, `timezoneOffsetMinutes` int optional; `overwriteAccountId` optional.

**Declared response** `E3` (P:26665): `{views?: number[][], imageViews?: number[][]}`.

**Usage** (Peak Hours tab, L[5077]):
- Cell value = `views` + `imageViews` at (day, hour). Accessor accepts both orientations: outer length 7 → `[day][hour]`, outer length 24 → `[hour][day]`; non-finite or ≤ 0 → 0 (M:174819-174823). Which orientation Fansly actually returns is **UNRESOLVED** from code.
- Day index 0 is labelled Sun … 6 Sat (M:177373-177381, L[2898]-L[2904]); hours 0-23 (M:177382).
- "Top Viewing Hours" (L[5080]): per hour sum over 7 days, zero rows dropped, sorted by views desc then hour, top 15 (M:174810-174818). "Weekly Heat Map" (L[5068]): 7×24 grid colored by value / max in steps at 0.2/0.4/0.6/0.8 (M:177415-177427).

### 2.6 `GET /account/stats/tags` — builder z9 (P:28648-28655), method `getCreatorStatsTags` (P:30177-30186)

**Request** (M:178415-178418): `{source, after, before, kind: 1, orderBy: "views", limit: 100}`.

Declared query `Nee` (P:28079-28091): `source` 0|1|4 optional; `kind` literal `1` optional; `after`, `before` int optional; `orderBy` enum with the single value `views` optional (schema note: Fansly's web client sends `views` and sorts the other modes locally, P:28084-28088); `limit` int optional; `overwriteAccountId` optional. Meaning of `kind = 1` is **UNRESOLVED** (only the literal is known).

**Declared response** `R3` (P:26666-26697), all optional:
- `source, kind, afterBucket, beforeBucket`: number; `liftAvailable`: boolean
- `rows`: array of `{tagId: string, views, imageViews, videoViews, watchMs, imageWatchMs, completedViews, watchPctSum, liftPoints, liftVideoViews: number}`
- `series`: array of `{tagId: string, bucket: union(number, string), views: number, imageViews: number}` (schema note: daily timestamp, currently sent as a decimal string, P:26689-26691)
- `aggregationData`: `{tags: Xc[]}` (Xc as in 2.3)

**Usage** (Tags tab, L[520]; up to 100 rows, M:178406):
- Call-site guards (real zod, M:178301-178307): ids/tags must be non-empty trimmed strings; a timestamp is an int, or a 13-digit string converted to Number, and must be a safe integer in (0, 8.64e15] → epoch ms.
- Name = `#` + `aggregationData.tags[].tag` matched by `id`, else "Unknown tag" (M:178323-178328, 178349).
- Daily series: day list from `afterBucket` to `beforeBucket` in 86 400 000 ms steps (1-366 days), filled from `series[]` `views` by `bucket` (M:178315-178321, 178331-178338, 178357-178359).
- Per row (M:178341-178361): Views = `views`; Avg. watched % (L[5160]) = `watchPctSum / videoViews / 100`, rounded (M:178355, 178437-178439); Watch time = `watchMs` (ms); Image watch time (L[5116]) = `imageWatchMs`, shown only when > 0 (M:178797-178803); Completed (L[1494]) = `completedViews`; "vs viewers" = `liftPoints`, used only when `liftAvailable !== false` and `videoViews ≥ 50`, shown as ± N percentage points (M:178356, 178440-178444).
- Sort modes Views / Watched % / vs viewers are applied locally (M:178364-178377, 178409-178413); the server is always asked for `orderBy=views`.
- `imageViews`, `liftVideoViews`, and `series[].imageViews` are not read.

### 2.7 `GET /account/stats/fans` — builder U9 (P:28656-28663), method `getCreatorStatsFanRevenue` (P:30114-30123)

**Request** (M:224369-224374): `{fanId, after: startMs, before: endMs + 1, granularity: "month"}`. `fanId` = Fansly account id resolved from the profile username (M:224430-224436). Window (M:227247-227254): local-today minus 179 days (paid) or minus 6 days (free) through local-today; `startMs` = local midnight of start; `endMs` = local midnight of end + 86 400 000 − 1; so `before` is the exclusive next-midnight bound. A failure of this call is swallowed (M:224374-224376).

Declared query `Uee` (P:28105-28111): `fanId` string optional; `after`, `before` int optional; `granularity` enum `day | month` optional; `overwriteAccountId` optional.

**Declared response** `k3` (P:26713-26739), all optional:
- `byProductType`: array of `{productType, grossMills, netMills, refundedNetMills, refundedGrossMills, transactions, refunds: number}`
- `firstBucket`, `lastBucket`: union(string, number)
- `rows`: array of `{bucket: union(string, number), productType, transactions, grossMills, netMills, refunds, refundedNetMills, refundedGrossMills: number}`

**Usage** (feature: "User Earnings: @user" modal on a fan's profile, L[3386], L[3387]; M:227206, M:227259):
- Money: every `*Mills` value is divided by 1000 and rendered `$x.xx` (M:124546-124549).
- Overview (M:225465-225473, 225493-225533): uses `byProductType` when non-empty, else `rows`; Net earnings (L[435]) = Σ`netMills` − Σ`refundedNetMills`; Gross earnings (L[436]) = Σ`grossMills`; Purchases (L[5007]) = Σ`transactions`. `firstBucket`/`lastBucket` → Number, must be a positive safe integer; values below 1e10 are treated as **seconds** and multiplied by 1000, otherwise ms (M:124529-124531, M:225481-225485); shown as first/last purchase dates in UTC.
- Monthly statements (L[5009]): `rows[]` with `bucket` coerced to a positive safe integer (M:224287, 224292), same seconds/ms normalization, re-bucketed to UTC month start, summing `transactions, grossMills, netMills, refunds, refundedNetMills` (M:224289-224313); table columns gross, net − refundedNet, refunds (M:225237, 225255, 225275); chart = monthly `netMills − refundedNetMills` (M:225334).
- Product categories (L[5010]): `byProductType` minus `productType === 6101` (wallet refund) (M:225632); label by type-code category (section 4), else "Product type N" (M:225646-225650).
- `refundedGrossMills` is not read (M:29113, 29129 only).

### 2.8 Non-stats builders from the anchor list

**`GET /account/wallets/earnings/transactions/accounts`** — builder E9 (P:28553-28562), method `getAccountEarningsTransactions` (P:30104-30113).
- Request (M:224408-224416): `{correlationAccountId: <fan id>, after: startMs, before: endMs + 1, cursor, limit: 100}`; `cursor` starts as the string `"0"`, then `response.nextCursor` while `hasMore`; aborts if the cursor repeats or does not advance (M:224407-224428). Declared query `VX` (P:27930-27937): `correlationAccountId` string, `before`/`after` int, `cursor` string, `limit` int, `overwriteAccountId` string — all optional.
- Declared response `RK` (P:26348-26382): `response` optional object `{data?: array of {transactionId?: string, createdAt?: number, destination?: number, status?: number, type?: number, correlationId?: string, amount?: number, transactionAmount?: number, transactionDestinationAmount?: number}, aggregationData?: {accountMedia?: Oa[], accountMediaBundles?: Oa[], subscriptionHistory?: array of {id?, subscriptionTierName?: string, billingCycle?: number, subscriptionTierColor?: string}, tips?: array of {id?, message?: string}, stories?: array of {id?, content?: string}}, hasMore?: boolean, nextCursor?: string}`.
- Runtime row schema actually enforced (M:224259-224269): `transactionId` non-empty string, `createdAt`, `type`, `amount` numbers **required**; `correlationId` string, `status`, `destination`, `transactionAmount`, `transactionDestinationAmount` optional. Rows outside the window (after seconds/ms normalization of `createdAt`) are dropped (M:224318-224323). Extra subscription fields read from `subscriptionHistory[]` when present: `duration, createdAt, endsAt, price, renewPrice` (number, nullish), `giftCodeId, promoId` (string, nullable) (M:224276-224284, 224340-224352).
- Usage: purchase list of the same "User Earnings" modal and CSV export (M:227323-227343). Amount = `transactionDestinationAmount ?? amount`, in mills (÷1000), negated when `destination === 1` (M:225793-225796). Status label (M:121286-121300, M:225797-225800): `destination === 1` with `status !== 1` → Refunded; status 1 → Pending (or Approved when destination is 1); 2 → Approved; 4 → Canceled; 5 or 6 → Refunded; other → contact-support text.

**`GET /trackinglinks`** — builder O9 (P:28594-28601), method `getTrackingLinks` (P:30197-30206). Request: no params (M:177177). Declared query `Tee` (P:28033): `overwriteAccountId` optional. Declared response: array of `g3` (P:26383-26396): `{id, accountId, internalId: string, type: int, label, description: string, clicks, claims, follows, subscriptions, totalGross: number}`, all optional. Usage: finds the link with `type === 1` and `String(internalId) === "1"` (M:177177-177183) — FBuddy treats it as the For You Page link (log text M:177211).

**`GET /trackinglinks/stats`** — builder F9 (P:28602-28609), method `getTrackingLinkStats` (P:30207-30223). Precondition: non-empty `trackingLinkId`, finite `after < before` (P:30208-30214). Request (M:177185-177190): `{trackingLinkId, after: prevStart − 86 400 000, before: windowEnd + 1}` where `prevStart = after − (before − after + 1)` (previous period of equal length). Declared query `kee` (P:28034): `trackingLinkId` string, `before`, `after` int **required**; `overwriteAccountId` optional. Declared response: array of `v3` (P:26397-26404): `{timestamp: string, clicks, claims, follows, subscriptions: number}`, all optional. Usage (only when source = 0, M:177203): `timestamp` → Number (ms); rows in [after, before] vs [prevStart, after) are summed; `follows` → "Follows" tile, `claims` → "New visitors" tile, each as `{value, previous}` (M:177192-177200, M:177226-177227).

---

## 3. Routes FBuddy does NOT call

No URL literal exists anywhere in the snapshot for `stats/series`, `stats/media/shown`, `stats/geo`, `stats/posts`, `stats/fans/top` (grep over `readable/`; `X:` lists only the seven used routes at X:2363-2411 for `P` and X:5231-5279 for `M`). FBuddy nevertheless ships declared schemas for all twelve; the route binding of these five is **INFERRED from declaration order and field names only**.

| Route | Declared query (P) | Declared response payload (P), all fields optional |
|---|---|---|
| `series` | `xee` 28035-28041: `family` enum `views\|revenue`; `granularity` enum `hour\|day\|month`; `after`, `before` int; `overwriteAccountId` | `b3` 26511-26528: `afterBucket`, `beforeBucket` number; `rows[]` of `{source, hourBucket, views, bucket, productType, transactions, grossMills, netMills, refunds, refundedNetMills}` (all number) |
| `media/shown` | `Fee` 28064: `end` int; `hours` int; `overwriteAccountId` | `A3` 26648-26652: `rows[]` of `{source, mediaShown, previousMediaShown}` (number) |
| `geo` | `Dee` 28065-28071: `source` 0\|1\|4; `after`, `before`, `limit` int; `overwriteAccountId` | `M3` 26653-26664: `rows[]` of `{country: string, views, imageViews, avgWatchPercent, avgWatchMs: number}`; `profileRows[]` of `{country: string, profileVisits: number}` |
| `posts` | `$ee` 28092-28097: `postIds` string; `after`, `before` int; `overwriteAccountId` | `BK` 26751-26757: `response` = record(string, unknown), nullish; schema note says payload fields are left open until observed. Binding of `BK` to `posts` is the weakest (it is simply the one envelope left over) |
| `fans/top` | `zee` 28098-28104: `after`, `before` int; `orderBy` enum `netMills\|grossMills\|transactions`; `limit` int; `overwriteAccountId` | `T3` 26698-26712: `rows[]` of `{fanId: string, transactions, firstBucket, lastBucket, netAfterRefundsMills, grossMills, netMills, refundedNetMills, refunds: number}` |

Used by FBuddy: `summary`, `media/top`, `media`, `media/benchmarks`, `activehours`, `tags`, `fans` (7 of 12).

---

## 4. Constants and enums

- **Source codes.** Query filter options offered in the UI: 0 "For You Page", 1 "Timeline", 4 "Other" (M:174741-174745); declared query literal sets: 0|1|4, plus −1 for `media` only (P:28043, 28053, 28059, 28066, 28073, 28080). Response-side breakdown labels: 0 For You Page, 1 Timeline, 2 Suggestions, 3 Search, 4 Other (M:175276-175282). So 2 and 3 are known as response values but are never requested as filters.
- **Media types.** `{IMAGE: 1, VIDEO: 2, AUDIO: 3}` (P:15601, M:15829); declared `mediaType` filter for `media/top`: 1|2 (P:28044).
- **orderBy strings.** `media/top`: `views, uniqueViewers, watchMs, completedViews, watchLift` (P:28047; first four used, M:174746-174751). `tags`: `views` (P:28084). `fans/top`: `netMills, grossMills, transactions` (P:28101).
- **granularity.** `series`: `hour, day, month` (P:28037); `fans`: `day, month` (P:28109; FBuddy sends `month`, M:224373). **family** (`series`): `views, revenue` (P:28036).
- **Transaction / product type codes** (M:15787-15814), used for `transactions[].type` and for stats `productType` (M:225632-225649): MEDIA_LEGACY 2010, MEDIA_BUNDLE_LEGACY 2016, MEDIA 2110, MEDIA_BUNDLE 2116, INTERNAL_TRANSFER 6002, WALLET_REFUND 6101, SUBSCRIPTION_PURCHASE 6515, TIPS_LEGACY 7001, TIPS 7101, BALANCE_PURCHASE 14001, SUBSCRIPTION_INDIVIDUAL 15000, SUBSCRIPTIONS 15001, SUBSCRIPTION_VARIANT 15002, GIFT_CODE_CLAIM 16013, REFERRALS 18001, REFERRAL_VARIANT 18002, LEADERBOARD_PRIZE_MONEY 24101, GIFT_CODE_CLAIM_VARIANT 24102, CRYPTO_WALLET_BALANCE_PURCHASE 24301, LOCKED_TEXT 32001, LOCKED_TEXT_VARIANT 32101, STREAM_TICKETS 45001, STREAM_TICKETS_VARIANT 45101, PRODUCT_ORDER 58000. Category mapping (subscription, tip, media, media_bundle, locked_text, stream_ticket, referral, leaderboard_prize, gift_code_claim, crypto_wallet_balance_purchase, internal_transfer, refund, balance_purchase, product_order, other): M:124482-124525.
- **Transaction status codes** as FBuddy reads them: 1 pending, 2 approved, 4 canceled, 5/6 refunded; `destination === 1` flips sign / marks refund (M:121252-121254, M:121286-121300, M:124590-124595, M:225793-225800).
- **Units summary.** `after`/`before`/`bucket`/`hourBucket`/`afterBucket`/`beforeBucket`: epoch ms (fans `bucket`/`firstBucket`/`lastBucket` tolerated as seconds when < 1e10, M:124529-124531). `*Ms`: milliseconds. `*Mills`: 1/1000 USD (M:124546-124549). `avgWatchPercent` (server-provided): 0-100. `completionRate` (benchmarks): 0-1. `watchPctSum`: ÷ `videoViews` ÷ 100 → percent. `retention.percent`: 0-100; `retention.stillWatching`: 0-1. `timezoneOffsetMinutes`: minutes east of UTC.

---

## 5. UNRESOLVED / caveats

1. Response schemas are never executed, so optionality in sections 2-3 reflects FBuddy's declared contract (everything optional), not validated observations. Only the fields listed under "Usage" are proven to be read.
2. Schema ↔ route binding is by order and field names (section 0.4); weakest for `media/shown` ↔ `Fee`/`A3` and `posts` ↔ `$ee`/`BK`.
3. Whether Fansly validates `fansly-client-check`/`fansly-client-ts` per route or per timestamp; how Fansly computes them (FBuddy only replays captured values).
4. What the Electron build substitutes for the `relayed` authorization value.
5. Semantics of tags `kind = 1`, of `Row.kind`, of `lengthBucket`, and of `source = 2/3` beyond their UI labels.
6. Orientation of the `activehours` matrices (FBuddy handles 7×24 and 24×7) and whether Fansly applies `timezoneOffsetMinutes` server-side.
7. `overwriteAccountId` is declared on every stats query schema but never sent; its behaviour is unknown.
8. Type discrepancy inside FBuddy's own declarations: `bucket` is number in summary `Point` and in `series`/benchmarks, string in the media `Row` and `likes`, and union(string, number) in tags `series` and in fans — call sites coerce all of them with `Number()`.
