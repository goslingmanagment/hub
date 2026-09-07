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
| balances | `["payout_balances"]`, then separate `["statistics_overview"]` and `["subscriber_statistics"]` with paired dates | one general overview, subscriber statistics and payout balance snapshot |
| visitors | selection `["total"]` with UTC-midnight from/to and sufficient explicit calls | previous UTC day via the S8 visitor handler; users/guests are separate optional types |

Selections name a catalog `id`, with `:numeric-id` only for a detail operation; user-list details also allow documented named IDs such as `friends`, `tagged` and `rebill_off`. Searching requires the catalog's query term. An explicit selector may include an allowlisted query, for example `giphy_search?q=hello`. No selector becomes an arbitrary path. Empty selection picks only the listed defaults. Detail fanout never occurs implicitly. For a continuation approval, create a new bounded job using the captured next-query evidence, for example `["following_expired?offset=50&limit=50"]`. The new selector is validated against the same strict query catalog; it never rewrites the previous job's caps or cursor.

## Data and recovery

The owner report is DB-only. Expired fan rows provide contactability, captured subscription expiration, prior spend and last reply from local projections where present. Unknown fields remain null. This is a candidate review surface; it never automatically sends reactivation messages. Notes remain local.

Agent consumers query `POST /api/v1/agent/pages/{pageLabel}/datasets/ofapi_financial_snapshots/query`. Both `read:datasets` and `read:money` plus the page grant are mandatory. `valueMills` is populated only for normalized monetary values; `rawValue` and `unit=provider_number` preserve otherwise unnamed provider numbers. The dataset's request window filters observation time; the row's `windowFrom/windowTo` identifies the provider aggregation window. Do not add the same snapshot across collection runs.

One physical attempt settles into a raw observation before parsing. The worker recovers captured or completed steps without another request. Canonicalization repairs a missing event from retained raw data, and `projection:rebuild ofapi_read_snapshots` rebuilds the normalized view without vendor egress. Policy/storage/credit denial pauses the job. A scheduled run that reaches its job, daily or interval allowance instead ends as `failed` with `scheduled_run_exhausted:<limit>`; its saved cursor and partial coverage remain available. The next configured interval may create a fresh bounded window under current policy, without resuming the exhausted cursor or resetting its spend. Owner pauses still require explicit recovery. A lost network response is uncertain paid work; the existing capture operator tools can reconcile or cancel it. No write command is part of this runner. Local parse failures retain the raw payload and have a bounded local retry count.

A scheduled GET with a captured `429` or `500`–`599` response also ends its current
run as `failed`. These statuses follow the existing OFAPI rate-limit/server-error
classification (Decision #245); they do not authorize an immediate retry. The
next configured schedule may start a separate bounded run. The failed run keeps
its raw response, cursor, caps, consumed calls/credits and response bytes. For an
older run parked on a captured `503`, owner **Resume** reads that exact response
locally and finishes the run as failed, even when its call allowance is spent.
It makes no additional vendor request. One-off jobs remain paused on these
statuses; a fresh probe requires a separate bounded job. Authentication errors,
other HTTP statuses, uncertain transport outcomes and parse failures retain their
existing recovery behavior and never gain a fresh scheduled request this way.

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
canonical request target match. A retained unresolved attempt still blocks new
egress; a different query, account or job cannot borrow its response.

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

When a paused periodic GET cannot usefully resume (for example, a retained `404`
or an uncertain body-read failure), the owner can choose **Завершить неполный
проход** in Collection. Confirm the page and category. The confirmation explains
that data, the saved cursor and uncertain charges remain, and the next run follows
the enabled schedule. The action marks only the outer run `failed`; it does not
claim complete coverage, resolve an unknown charge, dispatch a request, reset a
cap or move the schedule deadline. The original stop reason remains in the audit.

The SDK operation is `ofapiCollectionJobFinishIncomplete`, or
`POST /api/v1/admin/ofapi/collection/jobs/{id}/finish-incomplete`, with the current
`expectedRevision`, `expectedState:"paused"`, matching `pageId` and an owner
`reason`. A stale revision/state returns `409`; reload before another action.
Only paused background runs in the eight closed GET categories are eligible,
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
