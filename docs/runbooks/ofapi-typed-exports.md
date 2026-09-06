# OFAPI typed exports and profile visitors

S8 core, decision #267, migration 0163. New collectors remain off. The minutely
`ofapi.typed-export.sweep` queue finds only owner-created typed jobs; no page is
seeded and no legacy background flag needs to change.

## Owner steps

1. Open **OFAPI exports** in the sidebar (`/ofapi-exports`). Choose one mapped
   OnlyFans page and a short closed UTC date range, initially 1–7 days.
2. Select **Profile visitors**, keep a small total credit ceiling, and press
   **Preview**. This is local and has no vendor request. The screen bounds the
   task to 100 requests, 4 MiB and 1,000 rows; visitors additionally use the
   number of selected days as their row ceiling.
3. Press **Create quote**. The exact task is durable; the worker creates it with
   `auto_start=false`. Leave all collection categories and the old mirror flag
   unchanged. The page list reloads local status every 15 seconds.
4. When a quote is captured, set the maximum credits for this single start and
   press **Preview start**. Review the amount, then **Approve start**. Unknown
   visitor pricing is bounded by its account-day cap; unknown pricing for fans
   or links refuses approval. Approval cannot exceed the original task's
   remaining ceiling. Stale versions refuse and require a reload.
5. After the vendor completes, press **Download, verify & import**. Success
   requires verified account, column list, byte/row bounds, delivered count and
   artifact SHA256. If the vendor uses an undocumented storage host, use
   **Import reviewed CSV** with the downloaded CSV instead. The browser computes
   the expected SHA256; the server checks it independently.
6. Inspect the per-day table and source, including missing days and actual
   billing. A completed vendor job stays unimported until checked bytes exist.
   The row viewer exposes the first 100 saved source rows; the generated SDK
   `ofapiTypedExportRows` supports offset/limit through the 1,000-row task cap.
7. Repeat one profile/page at a time. Fans support all/active/expired/latest;
   tracking/trial/smart links preserve source fields as item snapshots. Their
   money strings are vendor values, not normalized Hub accounting totals.

Collection controls at `/settings?tab=collection` can pause managed requests.
Already captured observations and imported rows remain readable. After unpausing,
open `/ofapi-exports` and choose **Resume approved export** on the paused job.
The owner-only SDK operation `ofapiTypedExportResume` checks the displayed job
version and current collection policy revision, then resumes both the capture
and collection records together. It preserves the exact vendor ID, cursor,
source account, original request/credit/byte caps and already authorized start.
A status poll remains free when the original start has reserved the entire
credit ceiling; calls and bytes still have to fit. Resume refuses a changed
account, stale snapshot, unresolved request or indeterminate POST. A completed
or failed export cannot be restarted through this action. A budget overrun is
recorded and stops new work; it does not disappear because the vendor exceeded
an approval.

The `visitors` REST collector uses one-day steps through the shared collection
runner. Before scheduling it, preview one bounded run, compare the same dates
against CSV, then apply only this page/category with a low daily allowance.
REST `type=total|users|guests` rows remain separate, and the local report accepts
`source=rest&visitorType=...`. CSV `avg_view_duration` and REST `chart.duration`
are not declared equivalent. Incoming lifecycle events are hints; captured
status polls remain the reconciliation fallback.

## Source evidence and discrepancies

Verified 2026-09-06, read-only documentation requests only:

- [Live export guide](https://docs.onlyfansapi.com/data-exports): expandable field
  tables give the selected CSV columns. Profile visitors is one account-day per
  row; unavailable/ineligible accounts may yield no rows. Tariff is one credit
  per 20 rows for visitors/fans/tracking/trial; smart links are free. Actual
  terminal billing remains authoritative.
- [Create export](https://docs.onlyfansapi.com/api-reference/data-exports/create-data-export)
  requires start/end dates, while the guide marks dates inapplicable for fans.
  We retain the closed range as request/approval identity and do not represent
  the resulting fan list as historical interval coverage.
- [Status](https://docs.onlyfansapi.com/api-reference/data-exports/get-data-export-status)
  describes signed artifact URLs. The pinned example uses S3 under
  `/data-exports/{team}/{export}.csv`. Only that documented host/path class is
  automated; unknown hosts require reviewed owner CSV upload.
- [REST visitors](https://docs.onlyfansapi.com/api-reference/statistics/get-profile-visitors)
  uses `isAvailable`, `hasStats`, `type` and chart buckets. Longer windows may
  change bucket granularity. One-day requests are required for daily projection.
  Duration units and equivalence to CSV average duration are not established.
- The pinned OpenAPI omits concrete CSV response column schemas and is therefore
  insufficient to define the parser. Explicit columns come from the live guide;
  responses with different/missing columns stay captured but unimported.

## Provider inventory, cancellation and retry

The owner-only provider inventory initially reads the last captured local page.
Press **Refresh selected profile** to capture one free vendor inventory page
(maximum 100 records; the screen requests 25). Further pages require another
explicit press. Its summary omits signed download URLs. This is shared credential
inventory, so assigned team leads do not receive access to other pages' exports.

For a running local export, **Preview vendor cancellation** saves the source
version and current collection-policy revision. Confirming creates a separate
one-attempt durable DELETE intent. The original job pauses until the captured
acknowledgment identifies that exact vendor export as cancelled. If the response
is rejected or lost, the worker resumes bounded GET status reconciliation of the
original ID; it never repeats DELETE automatically. Background pause may defer
that reconciliation. Earlier export charges remain recorded.

For a captured failed export, **Preview paid retry** explains that the vendor
creates a new export and starts it immediately. Confirming uses the saved source
version, policy revision and credit ceiling, creates a fresh bounded job, and
requires the response's new ID and original ID to match. The new export follows
normal status capture and artifact verification. A lost retry response remains
blocked with outcome unknown; there is no automatic retry or second spend.
Original and retry charges remain separate. Changed snapshots require review
again.

Live control documentation verified 2026-09-06:

- [List exports](https://docs.onlyfansapi.com/api-reference/data-exports/list-data-exports)
  returns a nested `data.data` list and `data.meta` pagination. The route is free.
- [Cancel export](https://docs.onlyfansapi.com/api-reference/data-exports/cancel-data-export)
  accepts pending/in-progress exports and returns `cancelled`. The list route's
  documented status filter omits `cancelled`; Hub retains this returned status
  and does not depend on that inconsistent filter enum.
- [Retry failed export](https://docs.onlyfansapi.com/api-reference/data-exports/retry-failed-data-export)
  creates a new export with the original parameters and auto-starts it. Its
  initial response reports zero credits, which is not proof that the asynchronous
  export is free. The full approved reservation remains until terminal billing.

## Validation / spend

Synthetic captured vendor fixtures cover quote → approval → start → polling →
bounded S3 download → immutable import → daily report, actual credit overrun,
replay, wrong-account artifact retention, missing dates, REST source separation,
old pilot refusal, page ACL, free polling caps and populated page erasure.
Provider controls cover cancellation under pause, rejected/unknown cancellation
GET reconciliation, exact new retry identity, separate retained charges, lost
retry fencing, stale approvals and captured owner-only inventory. Resume fixtures
fund a start to the full task ceiling, pause it, resume through the owner HTTP
route, and finish with one free poll and exactly one start. Separate regressions
reject policy/job version drift, account rebinding and uncertain POST recovery.
Downloader fixtures cover untrusted host/path, private/mixed DNS, redirects and
both declared/streamed byte limits. No paid probes or production mutations.

The export screen freezes page, profile, date range and task ceiling in the quote preview, and displays the page/profile/job identity in start and provider-action receipts. Target controls are disabled while requests are pending; quote creation submits the reviewed snapshot.
