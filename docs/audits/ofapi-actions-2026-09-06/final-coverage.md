# OFAPI owner-action coverage and rollout

**Implemented review stack: 221 of 294 operations (75.17%), up from 140.** The three
new domains contribute **81 unique operations**; **73 remain excluded**. Events
are unchanged: **30 of 32 have canonical handling and consumers**, typing is
intentionally ephemeral, and `fan_summary.completed` remains deferred.

The shared owner-action engine and all three domain batches are integrated in
reviewable branches. `pnpm check` passed with 2,911 unit tests and 9 existing
skips; all 96 selected integration/schema regressions passed. PRs #143, #144 and
#145 extend the preceding #134–#142 coverage stack. They are not a claim of
production deployment or owner activation. Operation coverage means an explicit method/path and
selected useful workflow, not complete optional-parameter parity or a live
provider acceptance test. The [294-row CSV](final-coverage.csv) preserves every
original operation ID, method/path, status, source revision, evidence and reason.

## Count and source boundary

| Source | Operations | New versus baseline | Cumulative |
|---|---:|---:|---:|
| [Frozen completion baseline](../ofapi-completion-2026-09-06/REPORT.md), `41679950c9926bf4137d9002b54a52015fa42740` | 140 | — | 140 |
| [Collections/moderation/native notes](collections.md), `073ade3909ad7bbffeca76cf3604560b3135230f` | 20 | 20 | 160 |
| [Publishing/campaigns/queue](publishing.md), `564af639af796deb033a578c36784eb12421d673` | 27 | 27 | 187 |
| [Account/banking/native automation](../ofapi-account-actions-2026-09-06/README.md), `8b6b04c35c3c6e148283a518328fd82185b428d3` | 34 | 34 | 221 |

No new domain operation overlaps another domain or the baseline. All 81 request
signatures match one original inventory row. The implemented stack contains **127 GET,
45 POST, 11 PUT, 11 PATCH and 27 DELETE** operations. Non-GET is not synonymous
with mutation: username availability, for example, is a POST read.

Counts were checked against the original deployed-revision audit's 294 unique
method/path rows and the final completion matrix's 140 selected rows. Each of
the 81 action mappings in committed pure adapters was evaluated with inert input
and identity/schema/money stubs solely to extract its method/path; every result
matched its domain source manifest and the original inventory. This extraction
performs no application bootstrap, database access or provider request. It does
not replace schema or integration tests. The source evidence in the CSV refers
to the listed immutable commit; later fixes may move its line numbers without
changing operation coverage.

Source manifests: [collections](collection-sources.json),
[publishing](publishing-vendor-evidence.json), and
[account](../ofapi-account-actions-2026-09-06/vendor-operations.json).
The inherited [event matrix](../ofapi-completion-2026-09-06/event-matrix.csv)
remains the exact 32-event inventory. Frozen input SHA-256 values:

- Original `inventory/endpoint-matrix.csv`: `25d102e0fc492b1e97ca7b9dd37a1f147b60d8e2d85ec7277a3d96f036a1fb49`.
- Original `inventory/endpoint-matrix.json`: `c133e5cef5cea2d06502919e531ea06c2215dbea67704933710d96e8c5fcece4`.
- Completion `endpoint-matrix.json`: `8a9b70caa5430384edacc9c5d80664598a162b3a5f722f6c1cc10dac9d8e8710`.
- Completion `event-matrix.csv`: `0f3f8843d9cd64b4677c27ac8bafb6bf8590ab2e5fd6c9bb039eab2b191e3ced`.

## What the expanded actions provide

| Domain | Selected behavior |
|---|---|
| Collections, vault and moderation | Create/update/delete lists, add/clear/remove users, toggle a list-member pin, add/remove vault media, delete vault media, block/unblock and restrict/unrestrict. Native OF notes have independent read/update/clear actions and do not overwrite Hub notes. |
| Publishing and campaigns | Create/update/delete/archive/unarchive/pin posts; create labels and comment actions; create/delete/watch stories; full highlight management; create/update/cancel mass messages; list/count/publish the general queue. Post and campaign schedules use documented provider scheduling. |
| Account and banking | Seven banking/legal/tax reads; payout eligibility, frequency and manual withdrawal request; profile, subscription price, welcome message, geography, DRM and social buttons. A withdrawal receipt confirms a request, not bank settlement. |
| Saved for Later | Read message/post inventories and settings; explicitly enable/update or disable the provider's autosend/autopost schedule. Saving content into these queues uses the publication/campaign action fields. |

A mass-message selector freezes IDs/list selectors, not future list membership;
OnlyFans resolves that membership at execution time. A queue receipt does not
prove every recipient received a message. A partial user-list addition retains
exact `added` and `failed` identities. Toggle actions are not desired-state
setters and must not be repeated automatically after an unknown outcome.

## Provider gaps and parameter limits

These gaps are separate from the 73 excluded inventory operations:

- Story **update and scheduling** have no operation/`scheduledDate` field in the
  frozen 294-operation inventory or the live story creation reference checked
  on 2026-09-06. The documented story mutations are create, delete and mark
  watched. The implementation therefore has no invented update route or local
  story scheduler. [Live story reference](https://docs.onlyfansapi.com/api-reference/stories/add-to-story).
- Post creation mentions `price` in preview prose but declares no request price
  property. Paid post **creation** is not claimed. Post update explicitly has
  price and is supported within its whole-USD limit. Treating these two routes
  as covered must not hide this parameter gap. [Create](https://docs.onlyfansapi.com/api-reference/posts/send-post),
  [update](https://docs.onlyfansapi.com/api-reference/posts/update-post).
- Banking support is read-only: the published family contains seven reads and
  no bank-account/identity/DAC7/tax-form writes. Payout configuration/request
  actions are separate documented operations.
- Source discrepancies for array-valued fields, geography clearing, social
  button enums and automatic interval examples are recorded in the domain
  runbooks above. Live public documentation informed the accepted contracts;
  no authenticated live response or real-money action was used as a test.

## Owner activation: actions and native automation

Deployment creates no new collection policy, enables no provider autosend or
autopost, and sends no publication, campaign, withdrawal or subscription.
Verify the active account binding and credential preflight first. The runtime
`OFAPI_EXPECTED_TEAM_SLUG` must match independently confirmed owner evidence.
In **OFAPI Credits → Сверка с провайдером и права ключа**, read the existing local
key declaration, grant the necessary rights in the vendor console and record
known capabilities/account scope for that credential fingerprint. GET actions
need declared `reads`; non-GET actions need `commands`, including POST username
availability. The declaration is not provider permission introspection.

1. After the common plane and selected batch are deployed with pending forward
   migrations, sign in as owner and open **Управление OnlyFans** (`/ofapi-actions`).
2. Select one bound page and one action. Read existing data first when changing
   settings. Complete its typed fields and press **Проверить действие**.
3. Review the frozen page/account, exact values, recipients/media, schedule and
   credit estimate. Press **Выполнить сохранённый запрос** once.
4. Inspect the stored result. **Обновить сохранённый результат** reads local
   evidence; **Обработать сохранённый ответ ещё раз** repairs retained evidence.
   Neither repeats the provider mutation. Unknown outcomes require retained
   receipt investigation, not a fresh duplicate action. **Отменить до отправки**
   cancels a prepared local intent; removing a published post or campaign is a
   separate provider action.

| Workflow | Specific owner step |
|---|---|
| Lists/moderation/native notes | Select only the intended list/users/media. `following` list mutations and subscribe-to-user are unavailable. For `skip_invalid`, review failures individually instead of repeating the whole mixed batch. |
| Posts/stories/highlights/campaigns | Use verified reusable vault IDs or approved owned-upload material from `/ofapi-media`. For a scheduled post/campaign, enter a future date; the form converts local time to UTC. Review campaign membership semantics and the exact send window before execute. |
| Banking and payout | Read bank/legal/tax data and current payout eligibility/balance first. If appropriate, explicitly change payout frequency; submit a separate whole-USD withdrawal request. Follow the retained payout status for settlement. |
| Profile/welcome/geography/DRM | Read the current setting, then prepare that one change. Geography replaces its lists; omission/clearing in profile updates is explicit. Welcome media and price are a separate content action. |
| Autosend | Read `saved_messages_read` and `saved_message_settings_read`; prepare `saved_message_autosend_update` with 6, 12, 24 or 48 hours and execute once. Stop with `saved_message_autosend_disable`. |
| Autopost | Read `saved_posts_read` and `saved_post_settings_read`; prepare `saved_post_autopost_update` with 6, 12, 24 or 48 hours and execute once. Stop with `saved_post_autopost_disable`. |

The provider owns autosend/autopost once enabled. Closing Hub, pausing Hub
collectors or changing a collection mode does **not** disable that schedule.
The new action adapters reserve one provider credit per operation, except
`skip_invalid` list addition reserves up to five. The actual receipt controls
settlement. Development spend was **0 OFAPI credits**; this does not mean owner
execution is free or constrain already accepted provider work.

## Owner activation: collectors stay off until selected

The existing Collection controls retain their server-side policy enforcement.
Open **Settings → Collection**, select one mapped page/category, inspect
binding/key/capture health and its current revision. For each new read category,
first create the bounded task below with explicit call, credit and byte ceilings.
Inspect stored source, coverage, continuation and actual cost. A one-off task
does not enable recurrence. Separately select **Расписание**, set interval,
daily credit limit, calls per run and detail choice, then **Проверить и применить**
and confirm the preview against the current revision. Change one category at a
time. Keep automatic detail fanout off unless explicitly selected.

| Category | First owner-controlled task / enabling step |
|---|---|
| `core_messages` | Preserve the existing chat/history setup. A new policy is a separate preview/apply action; no generic one-off message collector is introduced. |
| `core_payments` | Preserve the existing transaction/chargeback schedule; adopt explicit policy separately. No generic one-off payment collector is introduced. |
| `core_audience` | Preserve the existing active-fan refresh. Expired/following/list reads use the separate category below; no generic one-off core audience job is introduced. |
| `posts_comments` | Start `posts`, one call. Use `post:ID`, `post_comments:ID` and `post_stats:ID` as separate explicit detail tasks. Recurring default: posts and labels. |
| `visitors` | Start `total`, one call and exactly one UTC day; Moscow inputs use 03:00 to 03:00 next day. `users` and `guests` are separate tasks. Recurrence reads the previous UTC day. |
| `tracking_links` | Start `stored_tracking_links`, then `stored_trial_links` separately. Statistics/subscriber detail requires explicit `tracking_link_stats:ID` or `trial_link_subscribers:ID`. Recurrence uses stored inventories. |
| `smart_links` | Start `smart_links`; use returned ULIDs for separate stats/pixels/fans selections. Recurrence refreshes only account-filtered inventory. Mutations and pixel tests use `/ofapi-marketing`. |
| `vault_catalog` | Start `vault_inventory`, one call; then `vault_lists`. Use `vault_item:ID` or `vault_list:ID` explicitly. Recurrence reads inventory/list metadata. |
| `vault_files` | Keep Off. There is no binary-download collector. Open `/ofapi-media`, choose page, save an owned source, select Vault/CDN, preview and approve that upload with frozen byte/credit caps. |
| `balances` | Start `payout_balances`, one call; use `statistics_overview` and `subscriber_statistics` separately with paired dates. Recurrence reads those selected snapshots. |
| `profile_notifications` | Start `me`, `notification_counts` and `fans_expired` separately. For list membership use `user_list:friends` and `user_list_users:friends`; pinned members are separate. Following/latest/top/history/blocked/restricted use explicit selectors. Recurring defaults are profile, expired fans, notifications and counts. |
| `content_history` | Start `stories`, then archive/highlights/mass queue separately. Known IDs and engagement windows are explicit. Recurring defaults are active stories, archive, highlights and mass queue. |

Typed exports remain separately approved: `/ofapi-exports` → choose page/profile
and closed UTC window/caps → Preview → Create quote (`auto_start=false`) → inspect
quote → set maximum start credits → Preview start → Approve start. After
completion, download/verify/import or import reviewed CSV, then inspect saved
rows. Collector pause does not undo an accepted async export/upload; use the
retained task's explicit resume controls, never issue another paid start to
recover a known accepted one.

Optional webhook groups remain separate: in **События и восстановление**, select
one group, **Сохранить выбор**, then **Применить события · платный поток** and verify
remote readback. The 12 optional subscriptions are `subscription_expiry` (1),
`account_lifecycle` (1), `media_uploads` (2), `data_exports` (7), and `engagement`
(1). `accounts.disconnected` needs effective `OFAPI_ACCOUNT_HEALTH_ENABLED` with
`OFAPI_DM_SYNC_ENABLED`; expiry needs `OFAPI_AUDIENCE_SYNC_ENABLED` with
`OFAPI_CREDIT_LEDGER_ENABLED`. Check existing effective boot flags first; any
missing prerequisite is a separately approved deployment configuration change.
Do not enable a flag merely to probe an event, and keep `fan_summary.completed`
unrequested. Enable five-minute delivery-history collection separately if
wanted. It does not authorize paid redelivery. Use explicit preview/approval
for one missing receipt; local replay handles already retained receipts.

Detailed existing collector/boot/export/media/marketing controls remain in the
[baseline owner runbook](../ofapi-completion-2026-09-06/REPORT.md#what-remains-off-and-how-the-owner-enables-it).
No collector was enabled and no production flag was changed for this audit.

## Exact remaining exclusions

The table below accounts for all **73** remaining operations. Reasons are current
for this expansion, rather than the baseline's now-superseded blanket exclusion
of publishing, list changes, banking and account settings.

| Group | Count | Reason |
|---|---:|---|
| Account connection | 8 | Separate connection, credential and 2FA lifecycle; not added to the selected account-settings action screen. The accounts.disconnected event consumer is already covered. |
| Adjacent analytics | 15 | Optional provider aggregates/forecast and extra account metrics remain unselected; existing transaction facts and selected financial snapshots remain the consumer. |
| Chat-wide/destructive/post-send tags | 3 | Account-wide read state, destructive chat deletion and post-send release-form replacement remain separate workflows; selected single-chat actions and send-time attachments are already covered. |
| Internal callbacks | 2 | Provider-internal Vatstack/CoinGate callback, not an outbound Hub operation. |
| Provider AI | 6 | Provider fan summaries and custom categories remain deferred; this expansion does not replace the Hub AI workflow. |
| Legacy marketing/promotions/bundles | 24 | Legacy trial/tracking/shared-link changes, global tags, promotions and subscription bundles remain unselected; existing attribution and Smart Link commands are already covered. |
| Binary downloads/deprecated scrape | 3 | Paid CDN/DRM binary import remains excluded; owned-file upload and vault metadata are covered. Scrape is deprecated. |
| Notification mutations | 2 | Account-wide mark-read and notification-tab reordering remain unselected; notification reads are covered. |
| Public profile discovery | 2 | Public-profile search/onboarding alternatives remain unselected; bound-account and fan reads are covered. |
| Release forms | 5 | Participant invitation/create/rename/hide/mentions workflow remains unselected; existing reference reads and send-time attachments are covered. |
| Subscriptions | 2 | Subscribe-to-user is explicitly forbidden by the owner. Unsubscribe was not requested and is also omitted; following-list mutations are rejected. |
| Webhook deletion | 1 | Registration inventory/update, history, local replay and explicit redelivery are covered; deleting a registration remains unselected. |

| Group | Method | Exact vendor path | Operation ID |
|---|---|---|---|
| Account connection | DELETE | `/api/accounts/{id}` | `disconnectAccount` |
| Account connection | POST | `/api/client-sessions` | `createClientSession` |
| Account connection | POST | `/api/authenticate` | `startAuthentication` |
| Account connection | GET | `/api/authenticate/{attempt_id}` | `pollAuthenticationStatus` |
| Account connection | PUT | `/api/authenticate/{attempt_id}` | `submit2FA` |
| Account connection | POST | `/api/authenticate/{attempt_id}/send-email-to-creator` | `send2FAEMailToCreator` |
| Account connection | POST | `/api/authenticate/{account_id}/reauthenticate` | `reAuthenticateAccount` |
| Account connection | PUT | `/api/authenticate/{account_id}/credentials` | `updateAuthenticationCredentials` |
| Adjacent analytics | GET | `/api/{account}/me/model-start-date` | `getModelStartDate` |
| Adjacent analytics | GET | `/api/{account}/me/top-percentage` | `getTopPercentage` |
| Adjacent analytics | POST | `/api/analytics/financial/transactions/summary` | `getTransactionSummary` |
| Adjacent analytics | POST | `/api/analytics/financial/transactions/by-type` | `getTransactionsByType` |
| Adjacent analytics | POST | `/api/analytics/financial/forecast` | `getRevenueForecast` |
| Adjacent analytics | POST | `/api/analytics/financial/profitability` | `getProfitability` |
| Adjacent analytics | GET | `/api/analytics/financial/profitability/{account}/history` | `getProfitabilityHistory` |
| Adjacent analytics | POST | `/api/analytics/summary/earnings` | `getEarningsOverview` |
| Adjacent analytics | POST | `/api/analytics/summary/historical` | `getHistoricalPerformance` |
| Adjacent analytics | POST | `/api/analytics/summary/comparison` | `getPeriodComparison` |
| Adjacent analytics | GET | `/api/{account}/chargebacks/statistics` | `listChargebackStatistics` |
| Adjacent analytics | GET | `/api/{account}/chargebacks/ratio` | `calculateChargebackRatio` |
| Adjacent analytics | GET | `/api/{account}/statistics/total-transactions` | `calculateTotalTransactions` |
| Adjacent analytics | GET | `/api/{account}/statistics/subscriber-metrics` | `getSubscriberMetrics` |
| Adjacent analytics | GET | `/api/{account}/statistics/statements/earnings` | `getEarnings` |
| Chat-wide/destructive/post-send tags | POST | `/api/{account}/messages/{queue_id}/attach-tags` | `attachTagsReleaseFormsToMessage` |
| Chat-wide/destructive/post-send tags | POST | `/api/{account}/chats/mark-as-read` | `markAllChatsAsRead` |
| Chat-wide/destructive/post-send tags | DELETE | `/api/{account}/chats/{chat_id}` | `deleteChat` |
| Internal callbacks | POST | `/api/webhooks/vatstack` | `handleAVatstackWebhookDeliveryTheseReportTheOutcomeOfValidationsThatCouldNotCompleteSynchronouslyBecauseTheGovernmentRegistryWasDownAtTheTimeOfTheRequest` |
| Internal callbacks | POST | `/api/webhooks/coingate` | `handleACoinGatePaymentCallback` |
| Provider AI | GET | `/api/fan-summary-categories` | `listCustomSummaryCategories` |
| Provider AI | POST | `/api/fan-summary-categories` | `createCustomSummaryCategory` |
| Provider AI | PUT | `/api/fan-summary-categories/{category_id}` | `updateCustomSummaryCategory` |
| Provider AI | DELETE | `/api/fan-summary-categories/{category_id}` | `deleteCustomSummaryCategory` |
| Provider AI | GET | `/api/{account}/fans/{fan_id}/summary` | `getFanSummary` |
| Provider AI | POST | `/api/{account}/fans/{fan_id}/summary` | `generateFanSummary` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/trial-links` | `createFreeTrialLink` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/trial-links/{trial_link_id}` | `deleteFreeTrialLink` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/trial-links/{trial_link_id}/tags` | `addFreeTrialLinkTags` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/trial-links/{trial_link_id}/tags` | `removeFreeTrialLinkTags` |
| Legacy marketing/promotions/bundles | GET | `/api/link-tags` | `listAllLinkTags` |
| Legacy marketing/promotions/bundles | GET | `/api/{account}/promotions` | `listPromotions` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/promotions` | `createPromotion` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/promotions/{promotion_id}` | `deletePromotion` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/promotions/{promotion_id}/stop` | `stopPromotion` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/shared-trial-links/{shared_trial_link_id}` | `revokeSharedFreeTrialLinkAccess` |
| Legacy marketing/promotions/bundles | GET | `/api/{account}/shared-trial-links/{shared_trial_link_id}/tags` | `listSharedFreeTrialLinkTags` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/shared-trial-links/{shared_trial_link_id}/tags` | `addSharedFreeTrialLinkTags` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/shared-trial-links/{shared_trial_link_id}/tags` | `removeSharedFreeTrialLinkTags` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/shared-tracking-links/{shared_tracking_link_id}` | `revokeSharedTrackingLinkAccess` |
| Legacy marketing/promotions/bundles | GET | `/api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` | `listSharedTrackingLinkTags` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` | `addSharedTrackingLinkTags` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` | `removeSharedTrackingLinkTags` |
| Legacy marketing/promotions/bundles | GET | `/api/{account}/bundles` | `listBundles` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/bundles` | `createBundle` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/bundles/{bundle_id}` | `deleteBundle` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/tracking-links/{tracking_link_id}/tags` | `addTrackingLinkTags` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/tracking-links/{tracking_link_id}/tags` | `removeTrackingLinkTags` |
| Legacy marketing/promotions/bundles | POST | `/api/{account}/tracking-links` | `createTrackingLink` |
| Legacy marketing/promotions/bundles | DELETE | `/api/{account}/tracking-links/{tracking_link_id}` | `deleteTrackingLink` |
| Binary downloads/deprecated scrape | POST | `/api/{account}/media/scrape` | `DeprecatedScrapeMediaFromTheOnlyFansCDN` |
| Binary downloads/deprecated scrape | GET | `/api/{account}/media/download/drm/{media_id}` | `downloadDRMProtectedMedia` |
| Binary downloads/deprecated scrape | GET | `/api/{account}/media/download/{cdnUrl}` | `downloadMediaFromTheOnlyFansCDN` |
| Notification mutations | POST | `/api/{account}/notifications/mark-all-as-read` | `markAllNotificationsAsRead` |
| Notification mutations | PUT | `/api/{account}/notifications/tabs-order` | `updateNotificationTabsOrder` |
| Public profile discovery | GET | `/api/profiles/{username}` | `getProfileDetails` |
| Public profile discovery | GET | `/api/search` | `searchProfiles` |
| Release forms | POST | `/api/{account}/release-forms/create-invitation-link` | `createInvitationLink` |
| Release forms | POST | `/api/{account}/release-forms/create-release-form` | `createReleaseForm` |
| Release forms | GET | `/api/{account}/release-forms/mentions` | `listMentions` |
| Release forms | PATCH | `/api/{account}/release-forms/toggle-show` | `hideUnhideReleaseForm` |
| Release forms | PATCH | `/api/{account}/release-forms/rename` | `renameReleaseForm` |
| Subscriptions | POST | `/api/{account}/users/{user_id}/subscribe` | `subscribeToUser` |
| Subscriptions | DELETE | `/api/{account}/users/{user_id}/subscribe` | `unsubscribeFromUser` |
| Webhook deletion | DELETE | `/api/webhooks/{webhook_id}` | `deleteWebhook` |

## Validation boundary

The inventory audit checked 294 unique input/output rows, 81 exact
adapter-to-manifest matches, zero unresolved signatures, zero overlap, 221
covered signatures and 73 excluded signatures. Integration, erasure, UI and
packaged SDK evidence below was then checked on the assembled branches.
These checks use synthetic provider responses; production activation and
provider acceptance remain separate owner steps.

## Acceptance evidence for this expansion

- First action batch: `pnpm check` with 2,880 passing unit tests; 110 selected
  integration/schema cases; owner browser checks at desktop and 390px.
- Publishing batch: `pnpm check` with 2,897 passing unit tests; 84 selected
  integration/schema cases, including media admission and erasure.
- Final account stack: `pnpm check` with 2,911 passing unit tests and the unchanged
  9 skipped tests; 96 selected integration/schema cases, including all new
  account API scenarios. The typecheck ratchet remains at its pre-existing
  1,909 errors across 121 debt files; no new type errors were accepted.
- Isolated vendored SDK compilation passes at 20, 47 and 81 actions. The final
  regression loads the compiled package, checks six client methods and all 81
  actions, and compiles an external consumer with positive and negative type
  assertions. The declaration fix preserves contract hash
  `59deb1b5c836b6cc4f7a6b269684aac660bd239a1d3bfcfdeda43984b620bb6f`.
- Local Playwright used a disposable PostgreSQL database and synthetic provider
  responses: account selection, prepare/execute, partial membership changes,
  a post, exact 4.99 USD review, and native scheduler enable/disable. Final mobile
  console review at 390px confirmed all 15 sections and no horizontal overflow.
- Media custody survives erasure through anonymous token digests and original
  server-assigned operation identities. Raw personal links are erased; prior
  erased reservations cannot be reconstructed retroactively.

The complete exact remaining-exclusion inventory above is intentional; no paid
subscribe-to-user operation or following-list mutation is exposed.
