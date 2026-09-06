# OFAPI Smart Links, Pixels and Postbacks

Implements S9a/b/c of the 2026-09-05 coverage refresh. Migration 0165 adds safe configuration snapshots and encrypted owner command intents. New collection categories remain off; no vendor account, production flag or external integration is changed by deployment.

## Read pipeline and consumers

The closed shared catalog adds 28 marketing GET operations: Smart Link list/get, pixels, tags, stats, cohort ARPS, spenders, fans, clicks and conversions; stored and shared tracking/trial inventories; and each legacy link's get/tags/subscribers/spenders/stats/cohort ARPS. Global Smart Link calls retain the selected account as a frozen capture scope. Inventory uses exactly that account filter; a response for another account remains captured and unprojected. Detail reads require retained link ownership evidence from that account. A page rebind cannot reuse old inventory to authorize changes to the previous account.

Collection uses the existing lease, page policy, storage, rate, call, byte and credit governor. Exact response bytes precede decoding. The registered `ofapi.collection_read_response.v1` family emits projection-only `ofapi.read_snapshot_observed` events; the normal watermark projector serves and rebuilds the snapshots. The synchronous read runner now uses that same canonicalizer and projector. Retained responses and rebuilds perform no extra vendor request.

The owner report serves link identities, public URLs, stored `cost` and `tags`, pixels, safe postback settings, attribution series and fan/conversion facts. Money uses mills with explicit net/gross/unspecified basis. Unknown campaign cost remains null, provider input mode/value/currency/source remain distinct from agency expenses. Summary/daily/monthly series are separate. Bots, duplicates and unknown organic classification remain separate. Neither attribution revenue nor cohort values are added to Hub's financial ledger. Public documentation gives a six-hour click-to-subscription window; subsequent linked fan payments remain attribution facts.

The report exposes query windows, observation time and coverage. Offset scans advance through full pages under explicit job caps, but a short page without provider EOF still says unknown coverage. Known pixel links never claim complete team visibility. Cohort success schemas are undocumented: numeric paths remain usable typed provider metrics with unspecified units; no invented cohort periods or mills conversion is applied.

## Owner commands

Five owner-session SDK operations serve the workflow: `ofapiMarketingGet`, `ofapiMarketingPrepare`, `ofapiMarketingDispatch`, `ofapiMarketingPostbacksRefresh` and the local-only `ofapiMarketingRebuild`. Eleven closed actions cover Smart Link creation/deletion, add/remove tags, create/update/disconnect/test pixel, and postback create/update/delete. Postback list/show is an explicit free configuration read.

Preparing retains an encrypted command, credential fingerprint and binding generation. Its preview names the target, changed fields, destination origin, template variables, header names, selected conversion types, known affected links and their incomplete visibility. Pixel tokens, postback header values and body/URL secrets never enter public DTOs or audit metadata. Exact sensitive responses are encrypted before parsing. The command journal is not a reusable pixel-token vault.

Dispatch conditionally claims the prepared intent immediately before one physical request. Repeated or competing dispatches cannot send it twice. Timeouts, capture loss and interrupted dispatch become indeterminate and require a new owner decision; there is no automatic resend. An existing intent cannot move to another credential or page binding. PATCH token/body/header omissions preserve vendor values; replacing a secret requires explicit input. Pixel PATCH affects the shared team pixel, while DELETE disconnects only the selected link. Shared-impact acknowledgement is mandatory, and explicitly account-restricted credentials cannot edit a pixel with unknown team scope.

Pixel test is a separate action requiring external-test acknowledgement. It sends a real event to the ad platform and retains test provenance in its intent/audit trail. It is never a health check or smoke test. CreatorTraffic test requests are refused locally. Confirmed create/update results immediately update safe retained configuration; exact DELETE 204 targets produce tombstones. Creation requires a valid returned remote identity and consistent account scope; malformed 2xx creation remains indeterminate. Collected attribution remains separate from administrative mutation outcomes.

The encrypted `ofapi.marketing_response.v1` journal retains exact response bytes, frozen command/binding/credential and safe baseline configuration. `OFAPI_MARKETING_ADMIN_PROJECTION` is a registered administrative consumer with independent accounting/projection receipts. A confirmed vendor outcome and remote ID settle before either local effect; accounting or projection failure cannot turn success into a transport ambiguity. The owner intent exposes both pending states. The dashboard retries bounded local work, and **Rebuild retained marketing state** resets only derived configuration/receipts and resumes captured responses without vendor egress or re-dispatch. A full postback inventory removes absent rows only with explicit provider EOF evidence and matching credential scope; an ordinary array or single-resource response does not establish completeness.

## Owner review and partial updates

The owner page is `/ofapi-marketing`. Confirmation shows the frozen page/account and the exact safe values: campaign name and trial duration, tags, pixel identifiers/event names, chosen test event and HTTP method. Secret changes show replacement/preservation/clearing actions; token values, full postback URLs, bodies and header values remain hidden. History uses the same retained preview after a page rename or view refresh.

Pixel edits compare against the form baseline and send only changed fields. Untouched or unknown event names remain omitted; creating a pixel also leaves blank optional fields to provider defaults. Explicit controls clear a saved event-source URL, postback body or all headers. The safe configuration projection keeps variable names per template field so clearing one field removes its variables without losing names from fields the owner preserved; local rebuild reproduces that result. CreatorTraffic test controls are disabled with a reason. Attribution tables derive net/gross from the amount actually shown and distinguish false flags from unknown values.

## Spend and activation

No paid probes were used. Smart Link public operations and stored inventories are documented free. They reserve zero only through the closed allowlist, bypassing stale balance/floor denial while retaining physical call, storage and policy limits. Actual reported credits still settle the durable attempt, including contradictory nonzero receipts. Legacy per-link subscribers/spenders/stats/get reads reserve one credit; cohort ARPS reserves one until the vendor publishes successful cost evidence. A stored related URL never silently triggers a paid fan walk.

After owner-approved deployment, enable one category at a time:

1. In Collection Controls choose one bound OnlyFans page. Keep `Smart links` off initially and create one bounded one-off job selecting `smart_links`, for example max 2 calls / 2 credits / 1 MB. Inspect account scope, raw/canonical completion and the owner marketing inventory.
2. Copy the returned ULID into a separate one-off selector such as `smart_link_stats:ULID`, `smart_link_pixels:ULID`, `smart_link_tags:ULID` or `smart_link_fans:ULID`. For analytics choose an explicit window. Keep small call/byte caps; detailed fan/click walks are explicit.
3. Once verified, set only `Smart links` to Scheduled, choose interval and limits, save against the current policy revision, and observe one run. Default scheduling discovers inventory only; it does not fan out every detail operation. Pause retains checkpoints and raw responses.
4. In a separate enablement window, exercise `Tracking links` with `stored_tracking_links`, `stored_trial_links`, and optionally `stored_shared_tracking_links` / `stored_shared_trial_links`. Inspect stored cost/tags before requesting paid selectors such as `tracking_link_stats:123`, `trial_link_subscribers:123`, or `tracking_link_cohort_arps:123`. Enable that category separately only after its own verification.
5. Read pixels/postbacks before preparing any change. Review the safe preview, shared scope and changed fields. Apply only the exact prepared command. Use a separate explicit Pixel Test when the owner actually intends to send an external test event.

Page erasure removes populated page-owned marketing intents/configuration/projection receipts, captures and read projections through the existing governed erasure inventory. Shared global postback configuration is team-level administrative evidence; it contains no fan records in the public cache. It does not recreate erased page read projections.

## Vendor discrepancies and boundaries

Verified 2026-09-06 against the pinned OpenAPI and live official docs:

- [Stored shared tracking links](https://docs.onlyfansapi.com/api-reference/stored-shared-tracking-links/list-stored-shared-tracking-links) and [stored shared trial links](https://docs.onlyfansapi.com/api-reference/stored-shared-free-trial-links/list-stored-shared-free-trial-links) describe free cache reads, while copied response examples report one credit. Documented admission is zero; actual response accounting wins.
- [Smart Link tags](https://docs.onlyfansapi.com/api-reference/smart-links/list-smart-link-tags) use a root `tags` array; legacy link tags use `data.tags`. Neither is guessed to be a normal data array.
- [Smart Link cohort ARPS](https://docs.onlyfansapi.com/api-reference/smart-links/get-smart-link-cohort-arps) and legacy cohort pages publish request fields but no successful response schema. Numeric evidence is retained with unknown units and requested revenue basis; no paid probing fills this documentation gap.
- The [Smart Links V2 guide](https://docs.onlyfansapi.com/introduction/guides/onlyfans-meta-pixel-smart-links) describes dashboard-only traffic-source editing, Meta spend connections, pre-landers and public shares. Public CRUD for these is not invented. First purchase pixel semantics exclude the initial subscription payment and do not define the first Hub financial transaction.
- Legacy tracking/trial creation/deletion and share-access writes remain outside this batch: S9a first reads existing links, and S12 makes those writes conditional on a later workflow. Smart Link creation and the explicitly required Pixel/Postback writes are implemented here.

## Validation

The focused UI/backend suite passes 34/34 tests, including 14 PostgreSQL integration regressions. It covers token-only and partial pixel updates, provider defaults, concrete rendered confirmations and acknowledgement gates, frozen review scope, secret custody, explicit body/header clearing and exact rebuild, confirmed outcomes through local failures, malformed 2xx creation, inventory completeness, capture/canonical snapshots and populated erasure.

`pnpm check` is green: 263 unit files, 2,835 passed and 9 existing skips; strictness ratchet, lint and dashboard production build are green. Independent dashboard TypeScript checking also passes. Parent integration performs browser QA. No production settings or collectors were enabled, and no live vendor probes were used.
