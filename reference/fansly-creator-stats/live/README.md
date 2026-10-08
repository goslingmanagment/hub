# Live evidence for the creator statistics map

These files come from the capture session that recorded the new statistics pages in an authenticated
creator session on 2026-10-08 (same bundle as the map, hashes in `sources.json`). They were written
independently of the map in the parent folder and are kept here unchanged, apart from two lint fixes
in `check-invariants.mjs`. The raw responses are not in Git: they contain supporter data and signed
media URLs and live in the owner's private pack `~/Documents/Codex/fansly-new-stats-2026-10-08/`
(`bundles/`, `network/`, `screenshots/`).

| File | Contents |
|---|---|
| `sources.json` | URL, size and SHA-256 of the four bundles |
| `verification.json` | One record per distinct response: method, path, query with ids replaced by hashes, status, body hash, echoed bounds and sizes, and the capture files it came from. 196 raw records, 134 distinct responses, 18 routes |
| `response-shapes.json` | Every observed field path with its JSON types, array lengths and the records that showed it. `../response-fields.json` is the same dictionary built separately and annotated with the client that reads each field |
| `invariants.json` | Result of 898 numeric and structural checks in 18 groups: sums inside `summary`, `summary` against the standalone series, daily against monthly revenue, hourly revenue, both CSV exports against the mills they were built from, media scopes, `watchLift` order, consecutive pages of a supporter's transactions. Counts, flags and file references only |
| `verify-evidence.mjs` | Rebuilds the first three files from the private pack and compares them with the saved ones (`--write` regenerates) |
| `check-invariants.mjs` | Recomputes `invariants.json`; `--self-test` also proves that five corrupted inputs are rejected |

```sh
node reference/fansly-creator-stats/live/verify-evidence.mjs ~/Documents/Codex/fansly-new-stats-2026-10-08
node reference/fansly-creator-stats/live/check-invariants.mjs ~/Documents/Codex/fansly-new-stats-2026-10-08/network --self-test
```

Both need Node.js; the second also `python3` for CSV parsing.

## What the capture covered

All requests were reads. Account settings, messages, purchases and the hub were not touched, and the
browser was left on Overview with the 30-day period and the For You surface.

Driven through the UI:

| Area | Exercised |
|---|---|
| Overview | first load and refresh, the "Right now" surface switch, the separate surface of "Top media" |
| Content | For You / Timeline / Other, Videos / Images, 7 / 30 / 90 days, the four sort orders, an empty surface |
| Audience | geography and discovery, the Views / Watched / Profile visits modes, 90 days |
| Earnings | pending balance, recent purchases, statements, the Gross and Purchases sort, a custom range through both date pickers, both CSV downloads |
| Media modal | a video in the selected period and in Lifetime, an image on Timeline, retention and the comparison table |
| Supporter modal | opened from the ranking, the selected period, Lifetime, statements and purchases |

Asked directly, outside what the UI sends:

| Subject | Requests |
|---|---|
| Span limits | windows from 2019-06-01 on every route; `summary` and daily revenue for May 2024 |
| Series | all five families; `hour`, `day`, `month`; bounds inside one day |
| Surfaces and sorting | `media/top` with `source` 2 and 3, `orderBy=watchLift`, `limit` 100 / 200 / 1000 |
| Media detail | one surface and all surfaces, 30 and 400 days, a single day with hourly rows, a video and an image |
| Geography and tags | surfaces 0 and 1, `kind` 1 and 2, `limit=200`, the 120 / 121-day boundary of tag lift |
| Posts | two known ids, then 72 known ids over 400 days |
| Supporter transactions | two consecutive pages of 30 through the returned `nextCursor` |
| Media shown | an explicit `end` with `hours=48` |

Twenty-one early records are responses saved without their request method; `verification.json` marks
them as taken from the client's GET wrapper rather than observed on the wire.

Not covered: error responses (none were provoked), quotas and load, refunds, non-empty `kind=2` tags,
`overwriteAccountId`, a full walk of a supporter's history, and whether the top lists are complete.
