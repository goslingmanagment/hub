# Fansly creator statistics (new UI, 2026-10) — endpoint map

Fansly replaced the creator statistics pages with `https://fansly.com/creator/stats/{overview,content,audience,earnings}`
(tagged "Beta" in the UI). This folder maps every request those four tabs and their two drill-down
modals make: endpoint, parameters, enumerations, response fields, and what each number on screen is
computed from.

| File | Contents |
|---|---|
| this file | Endpoint-centric map: the contract of each route, evidence, open questions, hub notes |
| [tab-overview.md](tab-overview.md) | Shell (period, refresh, account override), Overview tab, full reference of the client stats service |
| [tab-content.md](tab-content.md) | Content tab and the media detail modal |
| [tab-audience.md](tab-audience.md) | Audience tab, discovery card (tracking links), heatmap and hour-bar widgets |
| [tab-earnings.md](tab-earnings.md) | Earnings tab, statements, CSV exports, supporter (fan) modal |
| [fbuddy-cross-evidence.md](fbuddy-cross-evidence.md) | What the FBuddy extension sends to and expects from the same routes |

## 1. Evidence and its limits

Every claim below carries one or more of these tags.

| Tag | Source | What it proves |
|---|---|---|
| **B** | Fansly web bundle downloaded 2026-10-08 (`main.2e6b96097a4bb73b.js`, lazy chunk `729.d14b4c5910bebc74.js`), read statically | The exact requests the official client builds, and every response field it reads |
| **S** | Unauthenticated `GET` to each path on `apiv3.fansly.com`, 2026-10-08 | The route exists server-side (it answers the auth gate, not `404`) |
| **F** | FBuddy 2026.927.830 snapshot, read statically | An independent client: requests it sends to 7 of the routes, the response schema its authors declared for all 12 |
| **H** | Six HAR captures of real sessions, 2026-08-19 … 08-21 (`artifacts/`) | The `fansly-client-check` recipe, recomputed offline over 408 recorded requests |

**Not done in this pass: no authenticated response of the new routes was captured by us.** Request
shapes are proven (B). Response shapes are what two independent clients read or declare (B, F), not
bodies we observed. Units marked *inferred* follow from client arithmetic only. Section 9 lists what a
live capture has to settle, and section 8 how the hub can make one.

The bundle is the same build the 2026-10-06 quota research recorded (main SHA-256 `5e59696b…ca99ab`).
Notation in section 5: a field listed plainly is read by the official client; a line starting with
`F:` lists fields that only FBuddy's schema declares and the official client never reads.

Line references in the annexes (`main:N`, `729:N`, `381:N`) point into the pretty-printed files of
the local, git-ignored artifact `artifacts/fansly-app-bundle-2026-10-08/` (`raw/` with `SHA256SUMS`,
`analysis/*.pretty.js` produced by `esbuild 0.25.12 <file> --outfile=…`, `analysis/extract-calls.mjs`,
`live/*.tsv`). Re-download the bundle and re-run esbuild to get the same line numbers while Fansly
serves this build.

## 2. What is new

Diffing all request call sites of this build against the 2026-08-20 inventory
(`artifacts/fansly-app-bundle-2026-08-20/`) gives 13 new data routes. All are `GET`, all on
`https://apiv3.fansly.com/api/v1`.

| # | Route | Used by | B | S | F |
|---|---|---|---|---|---|
| 1 | `/account/stats/summary` | all four tabs | ✔ | ✔ | calls it |
| 2 | `/account/stats/series` | Overview "Right now", Earnings | ✔ | ✔ | schema only |
| 3 | `/account/stats/media/top` | Overview, Content | ✔ | ✔ | calls it |
| 4 | `/account/stats/media` | media detail modal | ✔ | ✔ | calls it |
| 5 | `/account/stats/media/benchmarks` | Overview, Content, media modal | ✔ | ✔ | calls it |
| 6 | `/account/stats/media/shown` | Overview "Right now" | ✔ | ✔ | schema only |
| 7 | `/account/stats/geo` | Audience | ✔ | ✔ | schema only |
| 8 | `/account/stats/activehours` | Content | ✔ | ✔ | calls it |
| 9 | `/account/stats/tags` | Content | ✔ | ✔ | calls it |
| 10 | `/account/stats/posts` | **no caller in the web app** (defined, dead) | ✔ | ✔ | placeholder schema |
| 11 | `/account/stats/fans/top` | Overview, Earnings | ✔ | ✔ | schema only |
| 12 | `/account/stats/fans` | supporter modal | ✔ | ✔ | calls it |
| 13 | `/account/wallets/earnings/transactions/accounts` | supporter modal | ✔ | ✔ | calls it |

The new pages also reuse routes the hub already knows: `/trackinglinks`, `/trackinglinks/stats`,
`/trackinglinks/revenuestats` (Audience discovery card), `/account/wallets/earnings` and
`/account/wallets/earnings/transactions` (Earnings wallet strip and "Recent purchases"), and the
app-wide `/account/{accountId}/wallets`. See section 6.

The legacy routes `/it/amoie/stats`, `/it/moie/statsnew` and
`/account/wallets/earnings/{stats,monthlystats,accounts,…}` are still in the bundle but are called
only by the legacy pages (`/creator/profilestats`, `statistics/:mediaOfferId`, `/creator/earnings/*`);
`/it/moie/stats` is defined and has no caller left. The new tabs never call any of them. The shell links to the legacy charts only for accounts created before
2026-09-21T00:00:00Z.

The statistics routes involve no WebSocket and no server-side export: "Right now" is two polled
GETs, and both CSV downloads are assembled in the browser from already loaded rows. The only live
element on these pages is the wallet balance of the Earnings strip, which the app-wide wallet
WebSocket events keep current.

The same diff shows eight new routes that have nothing to do with statistics, listed here only so
the inventory is complete. None is on the `apiv3` API base:

- `https://apip.fansly.com/application` (a base that did not exist in August): `GET /status/v1/`,
  `POST /upload-url/v1/`, `POST /upload-verify/v1/`, `POST /submit/v1/`;
- `https://apip.fansly.com/complaints`: `POST /email-challenge/v1/`, `POST /email-verify/v1/`;
- `https://apip.fansly.com`: `GET /streaming/channelType/v1/`, `GET /streaming/health/v1/`.

### Server-side route check (S)

Paced one request per 2.6 s, no session, 2026-10-08:

- Every route in the table answered `400 {"success":false,"error":{"code":99,"details":"missing parameter \"sessionToken\""}}`,
  the same body the known-live `/account/me` and `/it/amoie/stats` give without a session.
- `/account/stats/doesnotexist` answered `404 not found`.
- Control for path collisions: `/account/zzzz/{summary,series,media/top,media,media/benchmarks,media/shown,geo,activehours,tags,posts,fans/top,fans}`
  all answered `404`, so the twelve are literal routes and not matches of a parametric `/account/:id/…`.
- 45 plausible sibling names under `/account/stats/` were tried (`overview`, `export`, `realtime`,
  `revenue`, `statements`, `subscribers`, `sources`, `retention`, `media/retention`, `fans/geo`, …):
  43 are `404`. The two `400`s, `/account/stats/followers` and `/account/stats/wallet`, are the existing
  parametric routes `/account/:id/followers` and `/account/:id/wallet(s)` matching `id = "stats"`
  (`/account/zzzz/followers` and `/account/zzzz/wallet` answer `400` too). No hidden stats route was found.

## 3. Transport

**Envelope.** `{ success: boolean, response: <payload>, error?: { code, details } }`. Everything in
section 5 describes `response`.

**Query string.** The stats service builds `path?k=v&…` in a fixed key order (given per route
below); a parameter whose value is `null`, `undefined` or `""` is left out, `0` and `-1` are sent.
A global interceptor then appends `ngsw-bypass=true`. `/account/wallets/earnings/transactions/accounts`
and the tracking-link routes concatenate their own strings (order given below).

**Headers** (B, H). `authorization: <session token>` (raw, no `Bearer`), `fansly-client-id: <device id>`,
`fansly-session-id: <session id>`, `fansly-client-ts`, `fansly-client-check`.

- `fansly-client-ts` is a cached `Date.now() + (5000 − floor(10000·random))`, replaced every 3 s
  only when the new value is larger, plus the server clock offset once that offset has exceeded
  30 s in either direction (it is then kept).
- `fansly-client-check` is **computable for any route**:

  ```
  check = cyrb53("necvac-govry3-tybkYz" + "_" + pathname + "_" + deviceId, seed 0).toString(16)
  ```

  `pathname` is the URL path including `/api/v1`, without the query; `deviceId` is the
  `fansly-client-id` value; `cyrb53` is the public 53-bit hash (`h1 = 0xdeadbeef`, `h2 = 0x41c6ce57`,
  multipliers 2654435761 / 1597334677, finalizers 2246822507 / 3266489909). An earlier assignment in
  the same constructor (`oybZy8-fySzis-bubayf`) is overwritten and never used. Recomputed over six
  August HARs: 408 of 408 recorded requests on 48 distinct paths match (`analysis/verify-client-check.mjs`).
  The key is unchanged in today's build.

  Hub consequence: `fanslyClientCheckRoute()` returns `null` for the twelve `/account/stats/*`
  paths, so today the hub would send them without a check header, as it does for `/it/amoie/stats`;
  route 13 falls into the `earnings` family and would carry that family's stored value. The hub
  already sends one stored value per family across paths whose true checks differ (every
  `/account/wallets/earnings/*` path hashes differently) and FBuddy replays a single captured value
  on every route, both without rejections, so the server evidently does not enforce the check per
  path today. Whether the new routes behave the same is a live question (section 9); if one ever
  requires the exact value, the hub can compute it from the stored `fanslyClientId`.

**Access.** The `/creator` route tree requires a logged-in creator account. `overwriteAccountId`
(below) is the only account selector and is authorised server-side.

## 4. Conventions shared by the stats routes

**Time.** Every timestamp is epoch milliseconds.

- The official client always sends UTC-midnight day buckets: `after` = first day, `before` = **last
  included day** (today for the presets), so a 30-day preset has `before − after = 29 days`.
  Presets are 7 / 30 / 90 days (default 30); a custom range maps the picked local calendar dates to
  UTC midnights and clamps the end to today. Example for 2026-10-08, 30 days:
  `after=1788912000000&before=1791417600000`.
- The client treats `before` as an inclusive day: it asks hourly rows with `before` = today 00:00 UTC
  and uses rows up to the current hour. FBuddy instead sends local midnight … local end-of-day − 1 ms,
  and `end + 1 ms` on `/account/stats/fans` (F), so the server evidently accepts bounds that are not
  UTC midnights; the exact rule is open (section 9).
- The comparison period is never sent. The server returns `{ value, previous }` pairs; the UI caption
  describes `previous` as the equally long window immediately before.
- Response series points are `{ bucket, value }` with `bucket` = epoch ms of the UTC day (or month);
  hourly rows use `hourBucket`. Both clients coerce with `Number()`; FBuddy's authors note that tag
  series buckets "currently" arrive as decimal strings (F).

**Money.** `*Mills` fields are thousandths of a dollar. The UI shows `floor(mills / 10) / 100`.

**Durations.** `*Ms` fields are milliseconds.

**Percentages.** `avgWatchPercent` is 0–100. Benchmarks `completionRate` is 0–1. `watchPctSum`
divided by `videoViews` and by 100 gives a 0–100 percentage, so it is the per-view sum in hundredths
of a percent. Retention points are `percent` 0–100, `stillWatching` 0–1. (All *inferred* from the
arithmetic of both clients, B+F.)

**`overwriteAccountId`.** Optional on all twelve stats routes, on the three tracking-link routes and
on route 13. The web app takes it only from the page's own query string (`?overwriteAccountId=`) and
no UI produces such a link. Purpose and authorisation are unknown. The hub does not need it: each
page has its own session.

**`aggregationData`.** Returned by some routes and merged into the client's generic caches:
`accounts`, `accountMedia`, `accountMediaBundles`, `accountMediaOrders`, `posts`, `groups`, `tags`.
The pages read four more keys directly: `creatorMediaOfferLocations` (routes 3, 4) and, on the
wallet routes, `subscriptionHistory`, `tips`, `stories`. `accountMedia` carries media locations, the
same signed-CDN material the hub already treats as journal-only.

### Enumerations (B; FBuddy agrees where it overlaps)

| Name | Values |
|---|---|
| `source` (surface) | `0` For You, `1` Timeline (labelled "Direct" for profile visits), `2` Suggestions, `3` Search, `4` Other; `-1` = all sources (route 4 only). The UI only ever **requests** `0`, `1`, `4`; both clients carry labels for `2` and `3`, so those are expected in responses |
| `mediaType` | `1` image, `2` video; omitted = all |
| series `family` | `views`, `profile`, `follows`, `subscriptions`, `revenue`. Only `views` and `revenue` are requested by any code; FBuddy declares only those two |
| `granularity` | `hour`, `day`, `month` |
| media `orderBy` | `views`, `uniqueViewers`, `watchMs`, `completedViews`, `watchLift` (the last is defined, never sent) |
| fans `orderBy` | `netMills`, `grossMills`, `transactions` |
| tags `kind` | `1` VIEWER_FILTER (the only value sent), `2` POST_TAG |
| `productType` | 2010 Media (Legacy), 2110 Media, 2016 Media Sets (Legacy), 2116 Media Sets, 7001 Tips (Legacy), 7101 Tips, 15001 Subscriptions, 18001 / 18002 Referrals, 32001 / 32101 Locked Text, 45001 / 45101 Stream Tickets, 24101 Leaderboard Prize Money, 6101 Refunds; anything else "Other" |

## 5. Route reference

Parameters are listed in wire order. "UI sends" is every combination the official client produces.
In the response blocks a plain field is read by the official client (B); an `F:` line lists fields
only FBuddy declares.

### 5.1 `GET /account/stats/summary`

| Param | Type | UI sends |
|---|---|---|
| `after` | ms | window start |
| `before` | ms | window end (last included day) |
| `overwriteAccountId` | id | page query param, normally absent |

No `source`: the response carries every surface and the tabs slice it locally. One call feeds the
tiles and most charts of all four tabs.

```
dataSince                       ms; UI shows "collected since" when it is later than the window start
followerCount, subscriberCount  {value, previous}   levels at period end (updated nightly per UI text)
levels[]                        {bucket, followerCount, subscriberCount}   one per day
views[]                         one row per source
  source
  views, imageViews, uniqueViewers, uniqueImageViewers, completedViews,
  videoViews, replays, mediaShown                       {value, previous} counts
  avgWatchMs, avgImageWatchMs                           {value, previous} ms
  avgWatchPercent                                       {value, previous} 0–100
  series { views[], imageViews[], watchMs[] }           points
engagement
  mediaLikes[]                  {source, likes {value, previous}, series {likes[]}}
  postLikes, comments           {value, previous}
  series { postLikes[], comments[] }
profile
  profileVisits, uniqueVisitors {value, previous}
  avgProfileWatchMs             {value, previous} ms
  series { profileVisits[] }
  bySource[]                    {source, profileVisits {value, previous}, uniqueVisitors {value}}
follows
  follows, unfollows, netFollows {value, previous}      netFollows may be negative
  series { follows[], unfollows[] }
subscriptions
  subscriptionsNew, subscriptionsRenewed, subscriptionsExpired, subscriptionsCancelled   {value, previous}
  series { subscriptionsNew[], subscriptionsExpired[] }
  byTier[]                      {tierId, tierName, tierActive, tierColor, tierPos} and four {value, previous} pairs:
                                 subscriberCount, subscriptionsNew, subscriptionsMovedIn, subscriptionsMovedOut
revenue
  netAfterRefundsMills, grossMills, netMills, refundedNetMills   {value, previous} mills
  transactions, refunds, payingFans, newPayingFans               {value, previous} counts
  byProductType[]               {productType, netMills, grossMills, transactions}  the last three {value, previous}
                                F: refunds {value, previous}
  series { grossMills[], netMills[], refundedNetMills[] }
F: uniqueVisitors.previous in bySource[]
```

The client dereferences without guards the sections `revenue`, `profile`, `follows`, `subscriptions`
and `engagement`, each one's `series`, the `series` of every `views[]` and `mediaLikes[]` row, and
the pairs inside `byProductType[]` and `bySource[]` rows, so the server always sends them.
`videoViews`, `mediaShown`, `levels`, `bySource` and `byTier` are treated as optional.
`views[].views` is labelled "Views" for source 0 and "Video views" otherwise.

### 5.2 `GET /account/stats/series`

| Param | Type | UI sends |
|---|---|---|
| `family` | string | `revenue`, `views` |
| `granularity` | string | `hour`, `day`, `month` |
| `after`, `before` | ms | see below |
| `overwriteAccountId` | id | — |

| Caller | family / granularity | `after` … `before` |
|---|---|---|
| Earnings charts and CSV | `revenue` / `day`, or `month` when the window exceeds 400 days | selected window |
| Earnings statements, "This month", "All time" | `revenue` / `month` | `1559347200000` (2019-06-01) … today |
| Earnings running-month comparison | `revenue` / `day` | previous month start … same day of that month |
| Earnings "Last 30 days" baseline | `revenue` / `day` | today − 29 d … today |
| Earnings "Today / Yesterday" | `revenue` / `hour` | today − 3 d … today |
| Overview "Right now" (polled every 60 s) | `views` / `hour` | today − 3 d … today |

"today" is today's UTC midnight. The all-time start is computed, not a literal: the month start of
`now − days since 1561494359539` (2019-06-25T20:25:59.539Z, the Fansly snowflake epoch), with the
day count fixed when the app loads.

```
granularity, afterBucket, beforeBucket      echo; Earnings uses its hourly rows only if granularity == "hour"
rows[]  family=revenue   {bucket | hourBucket, productType, transactions, grossMills, netMills, refunds, refundedNetMills}
rows[]  family=views     {source, hourBucket, views}       (hour granularity is the only one requested)
```

Revenue rows are one per bucket and product type. The client skips `productType 6101` for
per-product figures but sums every row for totals.

### 5.3 `GET /account/stats/media/top`

| Param | Type | UI sends |
|---|---|---|
| `source` | int | `0`, `1`, `4` |
| `mediaType` | int | omitted, `1`, `2` (never with source 0) |
| `after`, `before` | ms | window |
| `orderBy` | string | `views`, `uniqueViewers`, `watchMs`, `completedViews` |
| `limit` | int | `3` (Overview), `20` (Content); FBuddy sends `100` |
| `overwriteAccountId` | id | — |

No offset or cursor exists in either client.

```
offers[]                        server-ordered; rank = index + 1
  mediaOfferId                  = accountMedia.id
  bestMediaId                   = accountMedia.media.id or .preview.id
  likes
  media[]
    mediaId, mediaType
    views, uniqueViewers, videoViews, completedViews
    watchMs, durationMs         ms
    watchPctSum
    F: likes
aggregationData
  creatorMediaOfferLocations[]  {mediaOfferId, correlationId (= post id), createdAt}
  accountMedia[], …             generic join
```

### 5.4 `GET /account/stats/media`

| Param | Type | UI sends |
|---|---|---|
| `mediaOfferId` | id | the row's `mediaOfferId` (required) |
| `source` | int | `0`, `1`, `4` for the surface view; `-1` for the per-surface breakdown |
| `after`, `before` | ms | the modal's own window; "Lifetime" is a 400-day window |
| `overwriteAccountId` | id | — |

The modal fires this twice (selected source, then `-1`) plus one benchmarks call.

```
media[]
  mediaId, mediaType
  totals                {durationMs, views (all time)}      F: declared nullable, a full row object
  daily[]               {bucket, source, views, impressions, watchMs, videoViews, completedViews,
                         watchPctSum, replays, uniqueViewers, durationMs}
  hours[]               {hourBucket, views}
  tags[]                {tagId, views, videoViews, watchPctSum}
  retention[]           {percent, stillWatching}
  retentionSampleSize
likes[]                 {source, likes}                     F: bucket, unlikes
tagSeries[]             {tagId, bucket, views}
aggregationData
  creatorMediaOfferLocations[]   {mediaOfferId, correlationId, createdAt}
                                 F: id, mediaOfferType, mediaOfferBundleId, mediaId, mediaType, previewId, accountId, locationId
  tags[]                         {id, tag}                  F: label, description, viewCount, postCount, flags, createdAt
  accountMedia[], accountMediaBundles[], …                  generic join
F: top-level mediaOfferId, source, afterBucket, beforeBucket
```

`daily[].uniqueViewers` is per day; both clients sum it, which double-counts across days.
In the `source=-1` answer the official client groups `daily[]` by `source` and renders only
surfaces 0, 1 and 4; rows of 2 or 3 are dropped.
FBuddy validates Fansly's own responses on this route at runtime: `success: true`,
`response.mediaOfferId` equal to the request's, `media[].mediaId` non-empty, and an
`aggregationData.accountMedia[]` or `.accountMediaBundles[]` entry `{id, accountId}` whose `id` is the
offer and whose `accountId` is the current account.

### 5.5 `GET /account/stats/media/benchmarks`

| Param | Type | UI sends |
|---|---|---|
| `source` | int | `0`, `1`, `4` |
| `after`, `before` | ms | page window, or the modal's window |
| `overwriteAccountId` | id | — |

```
buckets[]
  lengthBucket          id (only used to pick a label)
  minMs, maxMs          video length range; 0 / absent = open
  mediaCount            creator's videos in the range
  videoViews
  avgWatchPercent       0–100
  completionRate        0–1
  avgWatchMs            ms
  F: views, watchMs, completedViews, watchPctSum
F: top-level source, afterBucket, beforeBucket
```

The "benchmark" is the creator's own average for videos of similar length, not a platform percentile.
A list row gets a verdict only when the video has ≥ 50 video views, a known duration that falls into
a bucket, and that bucket has ≥ 3 videos and non-zero `videoViews`. The modal's comparison table
applies the bucket conditions without the 50-view floor.

### 5.6 `GET /account/stats/media/shown`

| Param | Type | UI sends |
|---|---|---|
| `end` | int | literal `0` (meaning unknown, presumably "now") |
| `hours` | int | `24` |
| `overwriteAccountId` | id | — |

```
rows[]   {source, mediaShown, previousMediaShown}
```

UI text: the number of different videos the surface put in front of someone in the last 24 hours.

### 5.7 `GET /account/stats/geo`

| Param | Type | UI sends |
|---|---|---|
| `source` | int | `0`, `1`, `4` |
| `after`, `before` | ms | window |
| `limit` | int | `10` |
| `overwriteAccountId` | id | — |

```
rows[]          {country, views, imageViews, avgWatchPercent (0–100), avgWatchMs}
profileRows[]   {country, profileVisits}
```

Rendered in server order. `country` goes through `Intl.DisplayNames(…, {type: "region"})` upper-cased,
so ISO 3166-1 alpha-2 is expected; empty means "Unknown". No subdivisions.

### 5.8 `GET /account/stats/activehours`

| Param | Type | UI sends |
|---|---|---|
| `source` | int | `0`, `1`, `4` |
| `after`, `before` | ms | window |
| `timezoneOffsetMinutes` | int | `-(new Date()).getTimezoneOffset()`: minutes **east** of UTC (UTC+3 → `180`) |
| `overwriteAccountId` | id | — |

```
views[7][24], imageViews[7][24]     counts; first index weekday with 0 = Sunday, second hour 0–23
```

The official client reads `[day][hour]` and does no time-zone arithmetic of its own, while the card
says "by weekday and hour in your time zone", so the UI relies on the server applying the offset.
FBuddy labels the same indices Sun–Sat but its reader tolerates a 24×7 layout as well, so the
orientation is a live question.

### 5.9 `GET /account/stats/tags`

| Param | Type | UI sends |
|---|---|---|
| `source` | int | `0`, `1`, `4` |
| `kind` | int | `1` |
| `after`, `before` | ms | window |
| `orderBy` | string | `views` (other sort modes are client-side) |
| `limit` | int | `10`; FBuddy sends `100` |
| `overwriteAccountId` | id | — |

```
rows[]      {tagId, views, imageViews, videoViews, watchPctSum, liftPoints}
            F: watchMs, imageWatchMs, completedViews, liftVideoViews
series[]    {tagId, bucket, views}                          F: imageViews
aggregationData.tags[]   {id, tag}
F: top-level source, kind, afterBucket, beforeBucket, liftAvailable
```

`liftPoints` is in percentage points and may be `null` ("no other viewers to compare").

### 5.10 `GET /account/stats/posts`

Params `postIds` (comma-joined), `after`, `before`, `overwriteAccountId`. The route exists (S) but
nothing in the web app calls it and FBuddy leaves its payload schema open. Response unknown.

### 5.11 `GET /account/stats/fans/top`

| Param | Type | UI sends |
|---|---|---|
| `after`, `before` | ms | window |
| `orderBy` | string | `netMills`, `grossMills`, `transactions` |
| `limit` | int | `5` (Overview), `25` (Earnings) |
| `overwriteAccountId` | id | — |

```
rows[]            {fanId, transactions, refunds, netAfterRefundsMills, grossMills, netMills,
                   refundedNetMills, firstBucket, lastBucket}
aggregationData   accounts[] for the fan ids
```

No paging in the client.

### 5.12 `GET /account/stats/fans`

| Param | Type | UI sends |
|---|---|---|
| `fanId` | account id | the supporter |
| `after`, `before` | ms | modal window; the statements call uses 2019-06-01 … the viewer's local date as a UTC day, clamped to today |
| `granularity` | string | `day`, or `month` when the window exceeds 400 days; `month` for statements |
| `overwriteAccountId` | id | — |

```
byProductType[]   {productType, grossMills, netMills, refundedNetMills, transactions, refunds}   plain numbers
                  F: refundedGrossMills
firstBucket, lastBucket
rows[]            {bucket, transactions, grossMills, netMills, refunds, refundedNetMills}
                  F: productType, refundedGrossMills
aggregationData
```

The modal opens from the fan lists and from messaging, the profile page and the subscriber dashboard.

### 5.13 `GET /account/wallets/earnings/transactions/accounts`

Wire order: `correlationAccountId`, `before`, `after`, `cursor`, `limit`, `overwriteAccountId`.

| Param | Type | UI sends |
|---|---|---|
| `correlationAccountId` | account id | the supporter |
| `before` | **ms** | window end + 1 day |
| `after` | **ms** | window start |
| `cursor` | id | `0`, then the last `transactionId` held; FBuddy follows `response.nextCursor` |
| `limit` | int | 30 … 100 (client default 25); FBuddy sends `100` |

Unlike `/account/wallets/earnings/transactions`, whose `before` / `after` are snowflake transaction
ids, this route takes millisecond timestamps.

```
data[]            {transactionId, createdAt, type, status, destination, correlationId, amount, transactionAmount}
                  F: transactionDestinationAmount
hasMore
F: nextCursor
aggregationData
  subscriptionHistory[]   {id, subscriptionTierName, billingCycle (days), subscriptionTierColor}
  tips[]                  {id, message}
  stories[]               {id, content}
  accountMedia[], accountMediaBundles[], accounts[], …      generic join
```

`destination` is the direction: `1` outgoing, `2` incoming. The supporter modal labels every
`destination 1` row "Refund" and shows `|amount|` (mills, net); for the other rows it adds
"{transactionAmount} paid" when that differs from `amount`. `status`: 1 pending, 2 approved,
4 cancelled, 5 refunded, 6 refund pending; the client also treats a bare `8` as cancelled.
`correlationId` joins a row to `subscriptionHistory`, `tips` or `stories`; for media types it is the
media or bundle id.

## 6. Existing routes the new pages reuse

| Route | Where | Notes |
|---|---|---|
| `GET /trackinglinks` | Audience discovery card | `response` is a bare array; reads `id`, `type`, `internalId`; `type 1` with `internalId` 1 / 2 / 3 are Fansly's built-in For You / Suggestions / Search links (other `type 1` links are ignored); links of any other type are the creator's, first 30 only |
| `GET /trackinglinks/stats?trackingLinkId&before&after` | same, per link | `before` = window end + 1 d, `after` = window start − (days + 1) d, so one call spans current and previous period; bare array of `{timestamp, clicks, claims, follows, subscriptions}`, kept when `after < timestamp < before`; only `follows` is displayed; a 60 s client cache suppresses repeat calls |
| `GET /trackinglinks/revenuestats?…` | same, per link | bare array of `{timestamp, totalGross}`; fetched, never displayed |
| `GET /account/wallets/earnings` | Earnings wallet strip | only `pendingBalance` is read |
| `GET /account/wallets/earnings/transactions?before=&after=&limit=5&offset=0` | Earnings "Recent purchases" | `{data[], total, aggregationData}`; skipped when `overwriteAccountId` is set |
| `GET /account/{accountId}/wallets` | app-wide | "Available for Payout" is the type-2 (earnings) wallet balance, kept current by wallet WebSocket events |

## 7. What each tab requests

| Tab | On open | Re-requested when |
|---|---|---|
| Overview | 1 summary · 11 fans/top (`netMills`, 5) · 3 media/top (`views`, 3) · 5 benchmarks · 2 series (`views`, `hour`) · 6 media/shown | period: 1, 11, 3, 5 · surface switch on "Top media": 3, 5 · every 60 s while visible: 2, 6 |
| Content | 1 · 3 (limit 20) · 5 · 8 · 9 | period: all five · surface: 3, 5, 8, 9 (summary is re-sliced locally) · media type or sort: 3, 5 |
| Media modal | 4 (source) · 4 (`-1`) · 5 | period: all three · surface: first 4 and 5 |
| Audience | 1 · 7 · then, after the first successful summary, tracking links | period: 1, 7, `/trackinglinks`, and per-link stats unless cached · surface: 7 only |
| Earnings | 1 · 2 (period series) · four period-independent 2 calls · 11 (limit 25) · wallet · recent purchases | period: 1, 2 (period series), 11 · sort: 11 · the period-independent calls, wallet and recent purchases reload only on refresh |
| Supporter modal | 12 (period) · 12 (statements) · 13 | period: 12, 13 (with "Lifetime" once more when the first purchase date becomes known) · pager: 13 when a page beyond the rows held is opened |

The refresh button and returning to a tab hidden for 5 minutes or more reload the open tab and the
discovery card; an open modal keeps its data. Period and surface are one state shared by the four
tabs; the "Right now" card and both modals keep their own. Derived figures (growth %, renewal rate,
completion rate, refund rate, averages per fan and per purchase, personal bests, "usual month",
verdict lines) are client arithmetic over the fields above; formulas are in the tab annexes.

## 8. Hub notes

Nothing in the hub requests these routes yet.

- **Sending.** The engine sends only wire specs (`packages/fansly/src/wire/specs.ts`), so each route
  needs a spec before it can be read at all, including by the owner's one-off
  `sync probe --page <label> --operation <wire id> --params '<json>'`. Journal-first specs
  (`parse: journalFirst`) are enough for a probe: the body lands in `observations` under the spec's
  kind and can be inspected read-only afterwards.
- **Budget.** A new wire id falls under `DEFAULT_ROUTE_BUDGET` (15 / min) unless it gets its own
  entry. Whether the twelve stats routes share one Fansly quota bucket is unknown; a shared family
  with a low starting rate, as `media.offer_stats` has, is the cautious choice. That is an owner
  decision.
- **Pins a new route moves.** Every wire spec must name a `legacyOperation` that
  `FANSLY_LEGACY_OPERATION_ROUTES` maps back to it, and `tests/sync-route-policy.test.ts` freezes
  that map to the operations of the deleted legacy senders "and no other"; the same test pins
  `ROUTE_POLICY_HASH`, which changes with every added route. `tests/fansly-wire-specs.test.ts`
  freezes the request of each API spec against what the legacy adapter sent (46 entries). These
  routes have no legacy twin, so adding them is a change to those invariants, not only new rows.
  Each new observation kind also needs an entry in `services/observation-kinds.ts` (a canonicalizer
  family or a raw-only justification).
- **What one page needs for full coverage.** `summary` for the window (everything with its
  comparison period and daily series); `series` `revenue` for history (monthly since 2019-06 in one
  call, daily per window, hourly for three days) and `views` hourly; `media/top` per surface, then
  `media` per offer with `source=-1` for per-surface daily rows, retention, hours and tags;
  `benchmarks`, `geo`, `activehours`, `tags` per surface; `media/shown`; `fans/top`, then `fans` and
  route 13 per supporter.
- **Overlap with existing lanes.** `summary` and `series` cover what `account.stats`
  (`/it/amoie/stats`) and the earnings snapshot routes give, with server-side comparison values;
  `media` covers `media.offer_stats` (`/it/moie/statsnew`) and adds retention, unique viewers,
  replays and tag attribution. The beta notice says past For You interactions are still being
  backfilled and "earnings are complete"; `dataSince` reports where collection starts.
- **Units.** Revenue here is mills, the platform-ledger unit, so no conversion is needed.

## 9. Open questions for a live capture

1. Does the hub's header plan (no `fansly-client-check` on these paths) get a `200`, or is the check required?
2. Inclusivity of `before`, and the rule for `previous`.
3. JSON types of `bucket`, `hourBucket`, `firstBucket`, `lastBucket` and the mills fields (number or decimal string).
4. Fields neither client reads; which `aggregationData` keys each route returns.
5. `/account/stats/series` with `family` = `profile`, `follows`, `subscriptions`, and `views` at `day` / `month`.
6. Limits: maximum `limit` on routes 3, 7, 9, 11, 13; maximum range for `hour` granularity and whether the server downgrades it; summary bucket size for very long windows.
7. `source` = `2` or `3` as a request filter; `orderBy=watchLift`; tags `kind=2`.
8. Orientation of the `activehours` matrices and whether the offset is applied server-side.
9. `end` on `/account/stats/media/shown`.
10. Whether `/account/stats/series` and `byProductType` emit `productType 6101` rows (totals would double-count refunds), and which date a refund is booked on.
11. Response of `/account/stats/posts`.
12. Rate limits of the family.
