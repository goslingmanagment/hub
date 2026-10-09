# OFAPI read collections: rollout and recovery

The closed catalog supports the selected GET operations from the 294-operation audit inventory; the final audit counts distinct method/path pairs across all integrated batches. Some already had a transport or partial capture path; count the union of method/path pairs when combining batches. This batch adds no vendor webhook event. The staged S1b/S10/S11a/S12 read work remains default off until the owner opts in.

## Enable one collector

1. Deploy the reviewed code and migrations 0161/0162 with the policy batch. Keep all new collection policies off. The integrator registers `ensureOfapiCollectionSchedules(boss)` and `startOfapiCollectionWorker(app,boss,handlers)` in scheduler/worker startup. The minutely sweep only wakes existing approved jobs or explicit scheduled policies.
2. Read `GET /api/v1/admin/ofapi/collection` through the owner session. Use its current `revision` and chosen `pageId`. Confirm the page binding, credit balance, permitted vendor operations and healthy capture storage.
3. For a bounded first look, call the existing SDK `ofapiCollectionJobCreate` with `expectedRevision`, `pageId`, category, `maxCalls`, `maxCredits`, `maxBytes`, nullable `from`/`to`, and an explicit `selection`. One-off approval does not turn on a scheduled collector. Example selections below. Start with one operation and one call, then review captured usage and coverage.
4. Read the local result through `ofapiReadCollectionsGet({query:{pageId}})`, or `GET /api/v1/admin/ofapi/collection/results?pageId=...`. Look at the source window, `ageSeconds`, per-page `coverage.state`, reason, omitted fan count, and actual/reserved credits. `complete` refers to the documented operation/window; it never proves all creator data exists in Hub.
5. To keep this category fresh, preview then apply its policy with `mode:"scheduled"`, one page, `intervalMinutes`, `dailyCreditLimit`, `maxCallsPerRun`, and `includeDetails:false`. Change exactly one category per rollout. Start with a 1440-minute interval and a small owner-chosen budget. A schedule freezes yesterday's UTC date window for endpoints that accept dates, with a 16 MiB run ceiling. It never changes the provider's following order.
6. Turning the category off or applying global background pause prevents new dispatch. Already captured responses and checkpoints remain available. Owner resume preserves the original selection and remaining caps. A cap-exhausted job needs a separately bounded continuation approval, not a silent cap reset.

| Category | First one-off selection | Default scheduled selection |
|---|---|---|
| profile_notifications | `["me"]`, then `["notification_counts"]`, then `["fans_expired"]` | me, expired fans, notifications, counts |
| posts_comments | `["posts"]`, then explicit `["post:123","post_comments:123","post_stats:123"]` | posts and labels |
| content_history | `["stories"]`; optional explicit story/highlight IDs or engagement ranges | active stories, archive, highlights, mass queue |
| balances | `["payout_balances"]`, then separate `["statistics_overview"]` and `["subscriber_statistics"]` with paired dates | payout balance snapshot, the newest page of payout requests (limit 50), one general overview and subscriber statistics; needs `maxCallsPerRun` ≥ 4 |
| visitors | selection `["total"]` with UTC-midnight from/to and sufficient explicit calls | previous UTC day via the S8 visitor handler; users/guests are separate optional types |
| account_settings | `["welcome_message"]`, one call | the welcome template snapshot (one call, 1 credit) |

Selections name a catalog `id`, with `:numeric-id` only for a detail operation; user-list details also allow documented named IDs such as `friends`, `tagged` and `rebill_off`. Searching requires the catalog's query term. An explicit selector may include an allowlisted query, for example `giphy_search?q=hello`. No selector becomes an arbitrary path. Empty selection picks only the listed defaults. Detail fanout never occurs implicitly. For a continuation approval, create a new bounded job using the captured next-query evidence, for example `["following_expired?offset=50&limit=50"]`. The new selector is validated against the same strict query catalog; it never rewrites the previous job's caps or cursor.

## OnlyFans payout requests

The scheduled `balances` run reads the newest page of `payouts/payout-requests` (offset 0, limit 50). OnlyFans keeps the whole history and documents only limit/offset; the response `marker` is never used as a request cursor, so a scheduled run makes exactly one call for it. Older requests are a bounded one-off `balances` job with explicit selectors, for example `payout_requests?offset=50`, then `?offset=100`. A policy created before this change with `maxCallsPerRun: 3` ends every run at `scheduled_run_exhausted:job_limit` before its fourth step (subscriber statistics): raise it to 4 in Settings → Сбор for each OnlyFans page.

Agents read the result as the OnlyFans-only dataset `ofapi_payout_requests` (`read:datasets` + `read:money`, claim field `ofapiPayoutRequest`): one row per invoice (`payoutRef`), the latest observation wins, with `amountMills`, `currency`, `state`, `rejectReason`, `requestedAt`, `lastObservedAt` and `observationRef`. The window and the capture floor run on `requestedAt`, so the floor is the oldest request Hub holds. `amount` is taken as US dollars like the balance snapshot (`payoutAvailable` 247.46 → 247460 mills); confirm it against the OnlyFans payout page on the first real capture.

## Welcome template snapshot (`account_settings`)

The chat extension's "New" panel shows whether the page's automatic welcome
message is on, has text or media, and its price. Hub reads it as the
`account_settings` category: one `GET settings/welcome-message` per run (1
credit), stored like any other read snapshot. The category is off until the
owner applies it per OnlyFans page in Settings → Сбор: mode **Scheduled**,
interval **1440** minutes, daily credit limit **1**, calls per run **1**.
Nothing is applied by deployment.

- The read is collection-only. The desktop's read of the same path through the
  read gateway keeps its own capture-first operation
  (`ofapi_gateway_welcome_message`) and admission; turning this category on or
  off does not change it.
- It is not the owner action `welcome_message_read`. That action holds the
  cluster-wide owner-action lock, so a background read there would turn the
  owner's own actions into 409s.
- The canonical snapshot item carries `welcomeTemplate`
  (`enabled`, `hasText`, `hasMedia`, `priceMills`). OnlyFans prices the
  template in US dollars (0, or 3–200 on write); the price becomes mills at
  canonicalization (`$5` → `5000`). `enabled` is the provider's `isActive`, or
  null when absent.
- `readLatestOfapiWelcomeTemplate(db, pageId)`
  (`apps/runtime/src/services/ofapi-welcome-template.ts`) returns the newest
  stored template, or null when none was collected. It reads local rows only.
- No template is a stop, not an empty snapshot. OFAPI documents only the
  template object (`data` with an `id`), and the desktop's gateway read of
  this path already refuses anything else. A `data` of `null` or a list stops
  the run as `contract rejected`: it parks as `paused` with the raw response
  retained and holds only this category on that page, so the next daily read
  waits. Read the retained response, then use **Завершить неполный проход**
  (below). A `4xx` other than `401` and `403` ends the run as `failed` with
  that status and the next daily read asks again (one call a day). If the
  next run stops the same way, the page has no template the read accepts:
  turn `account_settings` off for that page and report the response shape.
  Check the first live capture on each pilot page after the flip.
- Rollback: an image older than this category does not know
  `account_settings`. Once the owner has turned it on or run it as a one-off,
  the newest collection jobs include `account_settings` runs, and the older
  image's collection page (`GET /api/v1/admin/ofapi/collection`, Settings →
  Сбор) fails response validation with a `500` until a roll-forward, even if
  the category was turned off before the rollback. Other categories keep
  collecting; stored snapshots and device clients are unaffected.

## Data and recovery

The owner report is DB-only. Expired fan rows provide contactability, captured subscription expiration, prior spend and last reply from local projections where present. Unknown fields remain null. This is a candidate review surface; it never automatically sends reactivation messages. Notes remain local.

Agent consumers query `POST /api/v1/agent/pages/{pageLabel}/datasets/ofapi_financial_snapshots/query`. Both `read:datasets` and `read:money` plus the page grant are mandatory. `valueMills` is populated only for normalized monetary values; `rawValue` and `unit=provider_number` preserve otherwise unnamed provider numbers. The dataset's request window filters observation time; the row's `windowFrom/windowTo` identifies the provider aggregation window. Do not add the same snapshot across collection runs.

One physical attempt settles into a raw observation before parsing. The worker recovers captured or completed steps without another request. Canonicalization repairs a missing event from retained raw data, and `projection:rebuild ofapi_read_snapshots` rebuilds the normalized view without vendor egress. Policy/storage/credit denial pauses a one-off job. A scheduled run refused at capture admission (storage gate, credit floor, caps) has dispatched nothing for that step, so it ends as `failed` with `scheduled_run_refused:<reason>` and the next interval starts a fresh window; the minutely sweep closes scheduled runs that an older runtime parked as paused for such a refusal (2026-09-18: a 93% disk had held balances, visitors and both link categories for two weeks). A scheduled run that reaches its job, daily or interval allowance instead ends as `failed` with `scheduled_run_exhausted:<limit>`; its saved cursor and partial coverage remain available. The next configured interval may create a fresh bounded window under current policy, without resuming the exhausted cursor or resetting its spend. Owner pauses still require explicit recovery. A lost network response is uncertain paid work: the transport settles the attempt as billed (`safe_read_retry_assumed_billed`), so its reserve leaves the unsettled pool while the charge stays in every budget, and the step is never requested again. No write command is part of this runner. Local parse failures retain the raw payload and have a bounded local retry count.

A scheduled GET with a captured `4xx` or `5xx` response other than `401` and
`403` also ends its current run as `failed`, and so does one whose response was
lost after dispatch (no response headers, an unreadable body, a body over the
size limit). Neither authorizes an immediate retry: the step allows one request
and it is spent. The next configured schedule may start a separate bounded run
from the first step under the category's own limits. The failed run keeps its
raw response, cursor, caps, consumed calls/credits and response bytes. The
minutely sweep closes scheduled runs that an older runtime parked as paused for
either outcome (2026-09-08..10-06: ten runs on both OF pages, the oldest held
its category for a month); it changes only the outer run's state. The same
sweep then settles as billed every lost read whose run has ended, closed by it
or finished by the owner, that an older runtime left unresolved: the reserve
leaves the unsettled pool once, the charge stays in every budget, and the
step's capture job still has no call left. Reads of other lanes and of runs
still parked for the owner are not touched. One-off jobs
remain paused on these outcomes; a fresh probe requires a separate bounded job.
`401`/`403`, a status outside `4xx`/`5xx`, a policy refusal, a rejected
contract, a cursor cycle and local failures still park the run for the owner
and never gain a fresh scheduled request this way. A `404` that names a missing
account ends its run like any other `404`, and the dead binding then stops the
next run before any request (`OFAPI binding unavailable`).

A scheduled category that keeps ending `failed` on the same step (a route the
vendor no longer serves, a response that always times out) spends its calls up
to that step every interval, inside its daily credit limit, and never reaches
the steps after it. Turn the category off for that page or fix the catalog entry.

Costs are based on reserved estimates until captured vendor metadata is available. All catalog requests start with a one-credit reservation; vendor prices can vary and the actual response may exceed a remaining cap. Such overage is retained and blocks the next call. These are managed-request ceilings, not a guarantee of the provider invoice: incoming vendor events, external tools and accepted asynchronous operations remain separate. No paid probe ran during development.

## Vendor discrepancies and limits, checked 2026-09-06

- [Following docs](https://docs.onlyfansapi.com/api-reference/following/list-all-followings) explicitly say sort persists account-wide and empty filtered pages are not EOF. The code rejects sort/sortDirection and follows verified continuation links. This agrees with the pinned schema; older cached documentation omitted the caveat.
- [Blocked](https://docs.onlyfansapi.com/api-reference/blocked-restricted-users/list-blocked-users) and [restricted users](https://docs.onlyfansapi.com/api-reference/blocked-restricted-users/list-restricted-users) live pages document `query`, which the pinned parameter list omitted. The read registry allows it. The restricted-user example incorrectly points `next_page` at `/users/restrict`; it is preserved as an invalid-continuation gap, never executed as a route.
- [Post comments](https://docs.onlyfansapi.com/api-reference/post-comments/list-post-comments) exposes one GET list and write actions, with no independent GET replies operation in the live page or 294-operation inventory. Inline replies are retained when supplied. The code does not invent `/replies`.
- Fans latest/top use `data.users`, mass/engagement lists use `data.items`, and notification tab order uses a string array. These are validated individually instead of coercing every envelope to `data.list`.
- Subscription history can advertise `hasMore` without documenting a request cursor. The result stays partial with `continuation_unavailable`; payout history without explicit continuation stays unknown. No fabricated completion certificate is issued.
- The pinned message-buyers example includes a localhost next URL and literal account placeholder. Foreign or changed-account links are refused. Max-spend fan filtering can use a provider-maintained index; its completeness and omitted rows are displayed instead of claiming all matching fans were read.
- Profile stats and subscriber values are retained as provider snapshots. They do not replace the active fan roster, transaction ledger or full payout reconciliation. Content publishing, comment writes/moderation, bank settings, and following sort writes are outside this batch.

## Recovery after a captured response and local projection failure

Collection step and cursor fingerprints use canonical JSON so a checkpoint's
Postgres JSONB key ordering cannot create a second paid intent. Reads also adopt
an older capture slot only when page, account, collection job and the complete
canonical request target match. A step whose one request ended without a
captured response still blocks new egress for that step; a different query,
account or job cannot borrow its response.

If a pre-fix job is paused after spending its full allowance, use the existing
owner **Resume** action. It now permits local recovery when the current frozen
checkpoint has an exact captured response under the page's current binding.
Resume preserves the original credit, call and byte ceilings and consumption.
It does not grant another request; an exhausted job without that response stays
non-resumable. Verify one original physical request, the completed local snapshot
and unchanged spend after recovery. Do not raise the allowance to repair parsing.

Collection transport failures retain bounded diagnostics in the indeterminate
credit receipt and log `OFAPI collection transport failed` with operation and
collection job ID. The fields distinguish response headers from body reading,
reported HTTP status, bytes read versus the size ceiling, elapsed time versus
timeout, and allowlisted transport cause names/codes. Logs and receipt details do
not include URLs, account/fan IDs, headers, response bodies or raw errors. A
`body_too_large` reason proves the explicit size guard; `body_read` needs its
transport/cause fields to distinguish an abort from a socket failure. Missing
diagnostics on older receipts remain unknown. These diagnostics do not change
timeouts, limits, accounting certainty or retry authorization.

## Finish an incomplete scheduled read

When a paused periodic GET cannot usefully resume (for example, a retained `401`
or a rejected response contract), the owner can choose **Завершить неполный
проход** in Collection. Confirm the page and category. The confirmation explains
that data, the saved cursor and uncertain charges remain, and the next run follows
the enabled schedule. The action marks only the outer run `failed`; it does not
claim complete coverage, resolve an unknown charge, dispatch a request, reset a
cap or move the schedule deadline. The original stop reason remains in the audit.

The SDK operation is `ofapiCollectionJobFinishIncomplete`, or
`POST /api/v1/admin/ofapi/collection/jobs/{id}/finish-incomplete`, with the current
`expectedRevision`, `expectedState:"paused"`, matching `pageId` and an owner
`reason`. A stale revision/state returns `409`; reload before another action.
Only paused background runs in the nine closed GET categories are eligible,
with no active worker lease or reserved/dispatching capture attempt. One-offs,
baseline sync, exports and uploads retain their own recovery paths. Global pause
and category-off settings continue to prevent the next scheduled dispatch.

## Exact GET catalog

Query names, limits, response families and category/detail flags live in `packages/shared/src/ofapi-read-catalog.ts` and are returned by the SDK catalog. Every request rejects unknown keys. IDs remain strings, including values above JavaScript's safe integer range.

| Selector | Method/path | Policy category |
|---|---|---|
| profile_visitors | GET /api/{account}/statistics/reach/profile-visitors | visitors |
| me | GET /api/{account}/me | profile_notifications |
| users_blocked | GET /api/{account}/users/blocked | profile_notifications |
| users_restricted | GET /api/{account}/users/restricted | profile_notifications |
| fans_expired | GET /api/{account}/fans/expired | profile_notifications |
| fans_latest | GET /api/{account}/fans/latest | profile_notifications |
| fans_top | GET /api/{account}/fans/top | profile_notifications |
| subscriptions_history | GET /api/{account}/fans/:id/subscriptions-history | profile_notifications |
| following_all | GET /api/{account}/following/all | profile_notifications |
| following_active | GET /api/{account}/following/active | profile_notifications |
| following_expired | GET /api/{account}/following/expired | profile_notifications |
| notifications | GET /api/{account}/notifications | profile_notifications |
| notification_counts | GET /api/{account}/notifications/counts | profile_notifications |
| notification_tabs | GET /api/{account}/notifications/tabs-order | profile_notifications |
| notification_search | GET /api/{account}/notifications/search-users | profile_notifications |
| giphy_trending | GET /api/{account}/giphy/trending | profile_notifications |
| giphy_search | GET /api/{account}/giphy/search | profile_notifications |
| posts | GET /api/{account}/posts | posts_comments |
| post_labels | GET /api/{account}/posts/labels | posts_comments |
| post | GET /api/{account}/posts/:id | posts_comments |
| post_stats | GET /api/{account}/posts/:id/stats | posts_comments |
| post_comments | GET /api/{account}/posts/:id/comments | posts_comments |
| stories | GET /api/{account}/stories | content_history |
| stories_archive | GET /api/{account}/stories/archive | content_history |
| highlights | GET /api/{account}/stories/highlights | content_history |
| highlight | GET /api/{account}/stories/highlights/:id | content_history |
| story | GET /api/{account}/stories/:id | content_history |
| story_stats | GET /api/{account}/stories/:id/stats | content_history |
| story_viewers | GET /api/{account}/stories/:id/viewers | content_history |
| mass_queue | GET /api/{account}/mass-messaging | content_history |
| mass_overview | GET /api/{account}/mass-messaging/overview | content_history |
| mass_item | GET /api/{account}/mass-messaging/:id | content_history |
| engagement_mass | GET /api/{account}/engagement/messages/mass-messages | content_history |
| engagement_mass_chart | GET /api/{account}/engagement/messages/mass-messages/chart | content_history |
| engagement_direct | GET /api/{account}/engagement/messages/direct-messages | content_history |
| engagement_direct_chart | GET /api/{account}/engagement/messages/direct-messages/chart | content_history |
| engagement_top | GET /api/{account}/engagement/messages/top-message | content_history |
| message_buyers | GET /api/{account}/engagement/messages/:id/buyers | content_history |
| payout_balances | GET /api/{account}/payouts/balances | balances |
| payout_requests | GET /api/{account}/payouts/payout-requests | balances |
| payout_earnings | GET /api/{account}/payouts/earning-statistics | balances |
| statistics_overview | GET /api/{account}/statistics/overview | balances |
| subscriber_statistics | GET /api/{account}/subscribers/statistics | balances |
| welcome_message | GET /api/{account}/settings/welcome-message | account_settings |

## Composer reference lookup and runtime composition

The collection worker and scheduler register the read runner and the typed Visitors handler. Job windows stay half-open UTC ranges; each daily upstream request ends at 23:59:59.999 of that day so the materializer records one daily bucket. Exact typed-export jobs and collection reads are excluded from the legacy mirror lease sweep.

Four default-off, explicit lookup paths support the desktop composer (the Giphy pair was already present; release forms and taggable users are the two added paths): `giphy/trending`, `giphy/search` (required `q`), `release-forms`, `release-forms/taggable-users`. Giphy returns `data[]` with opaque string IDs and has no documented terminal pagination evidence. Both release-form lists return `data.items` and follow `_pagination.next_page`, even when OnlyFans lacks a reliable hasMore flag. `rfTag`, `rfPartner` and `rfGuest` are distinct references; a release-form document ID must not be relabelled as a partner/guest ID. No public separate partners/guests GET was found in the 294-operation inventory. Sources verified 2026-09-06: https://docs.onlyfansapi.com/api-reference/giphy/list-trending-gi-fs, https://docs.onlyfansapi.com/api-reference/giphy/search-gi-fs, https://docs.onlyfansapi.com/api-reference/release-forms/list-release-forms, https://docs.onlyfansapi.com/api-reference/release-forms/list-taggable-users.

## S10 user lists and membership

Four explicit selectors complete durable list reads: `user_lists`, `user_list:friends`, `user_list_users:friends`, and `user_list_pinned_users:friends`. Numeric list IDs work as well. All four belong to `profile_notifications` and are absent from its default scheduled selection. Existing desktop list/index reads retain their previous gateway admission; the new collector always passes a collection context. No list creation, update, deletion, member add/remove, or pin mutation is included.

The owner can open Settings → Collect → create a one-off job on the selected page, choose `profile_notifications`, enter `user_list:friends` and `user_list_users:friends` on separate selection lines, and approve explicit call, credit, and byte ceilings. The first call reads metadata; subsequent calls read member pages until a terminal marker or cap. Start with a three-call ceiling and inspect stored continuation before authorizing more. Use `user_list_pinned_users:friends` in a separate job to inspect only pinned members. These selectors do not enable recurring list fanout; authorizing the category's schedule does not implicitly iterate every list. Nothing was enabled in production.

Settings → Collect → “Сохранённые данные и участники списков” reads the local SDK report only. It displays captured source, observation time, requested window, query, and coverage alongside list membership, contactability, last local reply and local spend when present. List metadata's `users[]` is a preview; `usersCount` is a separate provider number. Membership and pinned membership are separate response scopes. Historical partial responses never remove members or prove whole-list absence. Rebuild uses canonical snapshots and performs no vendor request.

Live documentation verified 2026-09-06: [list index](https://docs.onlyfansapi.com/api-reference/user-list-collections/list-user-lists) returns `data[]`, limit 10–50, offset, optional `view=queue`, and no terminal marker in its example; coverage stays unknown. [list detail](https://docs.onlyfansapi.com/api-reference/user-list-collections/get-user-list) returns a metadata object with nested preview users. [members](https://docs.onlyfansapi.com/api-reference/user-list-collections/list-user-list-users) and [pinned members](https://docs.onlyfansapi.com/api-reference/user-list-collections/list-pinned-users-in-user-list) return `data.list`, limit 1–100, offset and `hasMore`/`nextOffset`. An empty page with continuation is followed. Named list IDs and string member IDs survive normalization; unsafe numeric IDs fail shape validation. A nested preview does not certify full membership; the implementation preserves the live envelope and its uncertainty rather than deriving counts from preview length.

Validation: targeted `ofapi-user-list-reads`, `ofapi-read-coverage`, `ofapi-read-collections.integration`, and dashboard stored-read tests exercise safe named selectors, default-off planning, pagination, exact identities, raw capture → canonical event → rebuilt projection → owner route, local CRM enrichment, and scope labels. Spend during validation: mocked provider responses only, zero vendor calls.

## Free webhook event inventory (S3 audit closure)

Settings → Collect → Events and recovery → Provider event catalog reads the last retained catalog response. “Обновить каталог · бесплатно” dispatches exactly one `GET /api/webhooks/events`, captures its response as `ofapi_webhook_event_catalog`, and exposes event name/description, current requested membership, Hub support and optional group. The GET diagnostics endpoint is DB-only. New provider events stay unrequested; neither refresh nor UI polling changes registration or policy. Invalid/duplicate identities retain their raw response and display `invalid`, instead of replacing uncertainty with a successful empty catalog.

The [live endpoint](https://docs.onlyfansapi.com/api-reference/webhooks/list-available-events) documents no query parameters, a `data` array of `{value,description}`, and zero credits. Its illustrative response contains only 13 names despite the separate 32-event catalog; the code accepts the returned inventory rather than using that example as an authoritative fixed event set. Zero-cost fallback remains unestimated and diagnostics remain available with pending accounting receipts. Validation uses mocked provider responses, with exact transport, capture, owner authorization, local reread, malformed response, unknown-event and unchanged-registration regressions.

## Delivery-history failure diagnostics

A history scan's `errorCode` distinguishes `history_admission_failed`,
`history_authorization_failed`, `history_response_headers_failed`,
`history_response_body_failed`, `history_response_capture_failed`,
`history_response_contract_failed`, `history_credit_receipt_failed` and local `history_capture_missing_failed`,
`history_parse_failed`, `history_window_failed`, `history_persistence_failed`.
Vendor HTTP failures keep their existing HTTP code. The structured
`OFAPI delivery history scan paused` warning adds the stage, safe cause name/code
and, for the admin GET, response status plus elapsed time and the configured HTTP
timeout. Elapsed time starts before admission; it is not proof of HTTP duration.
Partial body bytes are not counted because this admin read still uses `text()`.
No URLs, SQL, raw errors, headers or payloads are copied into diagnostics.

Only the free `ofapi_webhook_deliveries` GET uses a 60-second HTTP deadline;
other admin reads and mutations retain 15 seconds. Page size stays at 100 and
the scan lease at two minutes. The same scan window, offset, existing facts and
five-minute polling rule remain unchanged. A successful HTTP ledger receipt is downstream of durable response
capture; its presence helps distinguish a later local parse/window/persistence
failure from a request that never reached durable capture. Do not infer failure
cause from the timing of an unrelated canonicalization log.

On 2026-09-07, the owner-triggered free history scan completed its local API
request in 16,075 ms with a failed scan, and repeated automatic polls reported
only `provider_outcome_unknown`. The previous HTTP deadline was 15 seconds.
This supports a timeout hypothesis; the old logs do not prove it. Use the new
stage/cause fields and subsequent capture progress to verify the next pass.
