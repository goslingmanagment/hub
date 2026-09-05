# Полная карта покрытия OnlyFansAPI — 5 сентября 2026

Срез кода, без Fansly. `full` означает узкую полноту конкретного endpoint; не готовность целой продуктовой области или production. Основной план: [PLAN.md](../../investigations/ofapi-support-refresh-2026-09-05/PLAN.md).

{"partial": 29, "absent": 256, "full": 6, "intentional exclusion": 3}

294 spec operations; 34 distinct vendor operations have explicit callable integration; provider whoami is synthetic-only in the desktop compatibility gateway.

| Category | Total | Full | Partial | Absent | Excluded | Callable |
|---|---:|---:|---:|---:|---:|---:|
| API Keys | 1 | 0 | 1 | 0 | 0 | 0 |
| Account | 5 | 0 | 1 | 4 | 0 | 1 |
| Analytics - Financial | 5 | 0 | 0 | 5 | 0 | 0 |
| Analytics - Summary | 3 | 0 | 0 | 3 | 0 | 0 |
| Banking | 7 | 0 | 0 | 7 | 0 | 0 |
| Banned Words | 1 | 0 | 0 | 1 | 0 | 0 |
| Blocked / Restricted Users | 2 | 0 | 0 | 2 | 0 | 0 |
| Chargebacks | 3 | 1 | 0 | 2 | 0 | 1 |
| Chat Messages | 10 | 1 | 3 | 6 | 0 | 4 |
| Chats | 10 | 2 | 2 | 6 | 0 | 4 |
| Client Sessions | 1 | 0 | 0 | 1 | 0 | 0 |
| Connect OnlyFans Account | 6 | 0 | 0 | 6 | 0 | 0 |
| Data Exports | 6 | 0 | 3 | 3 | 0 | 3 |
| Endpoints | 2 | 0 | 0 | 0 | 2 | 0 |
| Engagement / Messages | 6 | 0 | 0 | 6 | 0 | 0 |
| Fans | 10 | 0 | 2 | 8 | 0 | 2 |
| Fans - AI Summary | 6 | 0 | 0 | 6 | 0 | 0 |
| Following | 3 | 0 | 0 | 3 | 0 | 0 |
| Free Trial Links | 11 | 1 | 1 | 9 | 0 | 2 |
| Giphy | 2 | 0 | 0 | 2 | 0 | 0 |
| Link Tags | 1 | 0 | 0 | 1 | 0 | 0 |
| Mass Messaging | 6 | 0 | 0 | 6 | 0 | 0 |
| Media | 5 | 0 | 1 | 3 | 1 | 1 |
| Media Vault | 4 | 0 | 2 | 2 | 0 | 2 |
| Media Vault Lists | 7 | 0 | 1 | 6 | 0 | 1 |
| Notifications | 6 | 0 | 0 | 6 | 0 | 0 |
| Payouts | 6 | 0 | 0 | 6 | 0 | 0 |
| Post Comments | 7 | 0 | 0 | 7 | 0 | 0 |
| Post Labels | 2 | 0 | 0 | 2 | 0 | 0 |
| Posts | 9 | 0 | 1 | 8 | 0 | 1 |
| Promotions | 4 | 0 | 0 | 4 | 0 | 0 |
| Public Profiles | 2 | 0 | 0 | 2 | 0 | 0 |
| Queue | 3 | 0 | 0 | 3 | 0 | 0 |
| Release Forms | 7 | 0 | 0 | 7 | 0 | 0 |
| Saved For Later (Messages) | 4 | 0 | 0 | 4 | 0 | 0 |
| Saved For Later (Posts) | 4 | 0 | 0 | 4 | 0 | 0 |
| Settings | 16 | 0 | 0 | 16 | 0 | 0 |
| Shared Free Trial Links | 5 | 0 | 0 | 5 | 0 | 0 |
| Shared Tracking Links | 5 | 0 | 0 | 5 | 0 | 0 |
| Smart Link Postbacks | 5 | 0 | 0 | 5 | 0 | 0 |
| Smart Links | 18 | 0 | 0 | 18 | 0 | 0 |
| Statistics | 6 | 0 | 0 | 6 | 0 | 0 |
| Stored Free Trial Links | 1 | 0 | 1 | 0 | 0 | 1 |
| Stored Shared Free Trial Links | 1 | 0 | 0 | 1 | 0 | 0 |
| Stored Shared Tracking Links | 1 | 0 | 0 | 1 | 0 | 0 |
| Stored Tracking Links | 1 | 0 | 1 | 0 | 0 | 1 |
| Stories | 8 | 0 | 0 | 8 | 0 | 0 |
| Story Highlights | 7 | 0 | 0 | 7 | 0 | 0 |
| Subscription Bundles | 3 | 0 | 0 | 3 | 0 | 0 |
| Tracking Links | 11 | 1 | 2 | 8 | 0 | 3 |
| Transactions | 1 | 0 | 1 | 0 | 0 | 1 |
| Usage | 1 | 0 | 0 | 1 | 0 | 0 |
| User List Collections | 11 | 0 | 2 | 9 | 0 | 2 |
| Users | 8 | 0 | 2 | 6 | 0 | 2 |
| Webhooks | 8 | 0 | 2 | 6 | 0 | 2 |

## Covered and partial operations

### GET /api/whoami — partial
Gateway fabricates Hub chatter/team identity. Does not call provider whoami or expose provider key permissions.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:401](../../apps/runtime/src/services/ofapi-read-gateway.ts:401)

### GET /api/accounts — partial
Admin/onboarding calls provider. Desktop list is page-ACL-filtered DB data. Provider list filters and complete account/auth metadata are not exposed.
Evidence: [apps/runtime/src/services/ofapi.ts:1586](../../apps/runtime/src/services/ofapi.ts:1586), [apps/runtime/src/services/page-onboarding.ts:167](../../apps/runtime/src/services/page-onboarding.ts:167), [apps/runtime/src/services/ofapi-read-gateway.ts:416](../../apps/runtime/src/services/ofapi-read-gateway.ts:416)

### GET /api/{account}/chargebacks — full
All documented list query fields have typed transport, bounded sync and canonical financial consumption. Statistics/ratio are separate absent endpoints.
Evidence: [apps/runtime/src/services/ofapi.ts:1677](../../apps/runtime/src/services/ofapi.ts:1677), [apps/runtime/src/services/ofapi-chargebacks-sync.ts:298](../../apps/runtime/src/services/ofapi-chargebacks-sync.ts:298)

### GET /api/{account}/chats/{chat_id}/messages/{message_id} — partial
Exact-message raw read with page ACL, credits and capture. Dedicated full DB-first endpoint/domain read flow remains incomplete.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:224](../../apps/runtime/src/services/ofapi-read-gateway.ts:224), [apps/runtime/src/services/ofapi-read-gateway.ts:499](../../apps/runtime/src/services/ofapi-read-gateway.ts:499)

### DELETE /api/{account}/chats/{chat_id}/messages/{message_id} — full
Dedicated numeric-target unsend command, one attempt, explicit outcome and webhook confirmation implemented.
Evidence: [apps/runtime/src/services/ofapi.ts:1340](../../apps/runtime/src/services/ofapi.ts:1340), [apps/runtime/src/services/ofapi-command-executor.ts:467](../../apps/runtime/src/services/ofapi-command-executor.ts:467), [packages/contracts/src/routes.ts:4391](../../packages/contracts/src/routes.ts:4391)

### GET /api/{account}/chats/{chat_id}/messages — partial
Durable history capture and certified-history fallback exist; filter is missing in gateway. Live message GET has mark-read side effects. Serving mode is gated/configuration-dependent; live activation not verified.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:195](../../apps/runtime/src/services/ofapi-read-gateway.ts:195), [apps/runtime/src/services/ofapi-capture-jobs.ts:1255](../../apps/runtime/src/services/ofapi-capture-jobs.ts:1255), [apps/runtime/src/services/ofapi-capture-contract.ts:342](../../apps/runtime/src/services/ofapi-capture-contract.ts:342)

### POST /api/{account}/chats/{chat_id}/messages — partial
Text and existing-media/PPV sends implemented with one-attempt custody. Missing replyToMessageId, independently controlled lockedText, giphyId, rfTag/rfPartner/rfGuest, blockBannedWords and provider Idempotency-Key header. Hub price is integer-only; documented price example 6.97 is rejected. v1 intentionally rejects unknown body fields.
Evidence: [apps/runtime/src/services/ofapi.ts:1227](../../apps/runtime/src/services/ofapi.ts:1227), [apps/runtime/src/services/ofapi.ts:1242](../../apps/runtime/src/services/ofapi.ts:1242), [packages/contracts/src/routes.ts:4302](../../packages/contracts/src/routes.ts:4302), [packages/contracts/src/routes.ts:4366](../../packages/contracts/src/routes.ts:4366), [apps/runtime/src/services/ofapi-command-executor.ts:445](../../apps/runtime/src/services/ofapi-command-executor.ts:445)

### GET /api/{account}/chats — partial
All documented query names are accepted by gateway. Sync uses a narrower query. Live gateway/capture and local conversation material exist; DB-first list serving is not complete.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:181](../../apps/runtime/src/services/ofapi-read-gateway.ts:181), [apps/runtime/src/services/ofapi.ts:1589](../../apps/runtime/src/services/ofapi.ts:1589), [apps/runtime/src/services/sync/ofapi-dm-sync.ts:579](../../apps/runtime/src/services/sync/ofapi-dm-sync.ts:579)

### GET /api/{account}/chats/{chat_id}/media — partial
Gateway raw gallery exists. BREAKING PARAMETER DRIFT: Hub type=photo/gif/video/audio; current OpenAPI type=photos/videos/audios. Documented values are rejected.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:238](../../apps/runtime/src/services/ofapi-read-gateway.ts:238)

### POST /api/{account}/chats/{chat_id}/typing — full
Dedicated empty-payload command, one attempt, credit treatment and outcome handling implemented.
Evidence: [apps/runtime/src/services/ofapi.ts:1268](../../apps/runtime/src/services/ofapi.ts:1268), [apps/runtime/src/services/ofapi-command-executor.ts:461](../../apps/runtime/src/services/ofapi-command-executor.ts:461), [packages/contracts/src/routes.ts:4385](../../packages/contracts/src/routes.ts:4385)

### POST /api/{account}/chats/{chat_id}/mark-as-read — full
Dedicated empty-payload mark-read command, one attempt and explicit outcome implemented.
Evidence: [apps/runtime/src/services/ofapi.ts:1421](../../apps/runtime/src/services/ofapi.ts:1421), [apps/runtime/src/services/ofapi-command-executor.ts:477](../../apps/runtime/src/services/ofapi-command-executor.ts:477), [packages/contracts/src/routes.ts:4399](../../packages/contracts/src/routes.ts:4399)

### POST /api/data-exports — partial
Only chat_messages CSV, one page, pilot_chats/fleet_tail profiles, auto_start=false and fixed columns/options. New export types incl profile visitors absent.
Evidence: [apps/runtime/src/services/ofapi-export-quotes.ts:531](../../apps/runtime/src/services/ofapi-export-quotes.ts:531), [packages/contracts/src/routes.ts:3751](../../packages/contracts/src/routes.ts:3751), [docs/decisions.md:4770](../../docs/decisions.md:4770)

### GET /api/data-exports/{data_export_id} — partial
Status of Hub-owned narrow chat-message export jobs, including 60-minute URL request in progress. No general provider export inventory/status interface.
Evidence: [apps/runtime/src/services/ofapi-export-quotes.ts:593](../../apps/runtime/src/services/ofapi-export-quotes.ts:593), [packages/contracts/src/routes.ts:3840](../../packages/contracts/src/routes.ts:3840)

### POST /api/data-exports/{data_export_id}/start — partial
One stateful start after owner CAS, capped at 50 credits/1000 messages/three chats. Other export types and fleet start are outside current flow.
Evidence: [apps/runtime/src/services/ofapi-export-quotes.ts:560](../../apps/runtime/src/services/ofapi-export-quotes.ts:560), [packages/contracts/src/routes.ts:3794](../../packages/contracts/src/routes.ts:3794), [docs/decisions.md:4770](../../docs/decisions.md:4770)

### GET /api/{account}/fans/all — partial
Only limit/offset/query/online=1/min-total-spent exposed. Missing type, online=0, tips, duration, max_total_spent. Index-backed max-spend coverage metadata is not modeled.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:275](../../apps/runtime/src/services/ofapi-read-gateway.ts:275)

### GET /api/{account}/fans/active — partial
Only limit/offset/query/online=1/min-total-spent exposed. Missing type, online=0, tips, duration, max_total_spent. Index-backed max-spend coverage metadata is not modeled. Audience consumer ignores nextPageUrl and advances by returned item count; 19 items with next offset 20 saves offset 19. Empty+hasMore resets sweep despite withheld generation expiry.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:275](../../apps/runtime/src/services/ofapi-read-gateway.ts:275), [apps/runtime/src/services/ofapi.ts:1636](../../apps/runtime/src/services/ofapi.ts:1636), [apps/runtime/src/services/sync/ofapi-audience-sync.ts:440](../../apps/runtime/src/services/sync/ofapi-audience-sync.ts:440)

### GET /api/{account}/trial-links — partial
List + bounded identity discovery exist. Only limit/offset; missing date range, sort/field and synchronous.
Evidence: [apps/runtime/src/services/ofapi.ts:1738](../../apps/runtime/src/services/ofapi.ts:1738), [apps/runtime/src/services/sync/ofapi-fan-identities.ts:311](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:311)

### GET /api/{account}/trial-links/{trial_link_id}/subscribers — full
List with limit/offset consumed by checkpointed identity discovery.
Evidence: [apps/runtime/src/services/ofapi.ts:1754](../../apps/runtime/src/services/ofapi.ts:1754), [apps/runtime/src/services/sync/ofapi-fan-identities.ts:375](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:375)

### GET /api/{account}/media/uploads/{upload}/status — partial
Read-only status is supported; upload creation, durable upload job and media_uploads webhook lifecycle are absent.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:342](../../apps/runtime/src/services/ofapi-read-gateway.ts:342), [apps/runtime/src/services/ofapi-capture-contract.ts:81](../../apps/runtime/src/services/ofapi-capture-contract.ts:81)

### GET /api/{account}/media/vault — partial
Read-only raw vault listing/capture. No complete OF vault catalog/synchronization or upload lifecycle.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:305](../../apps/runtime/src/services/ofapi-read-gateway.ts:305)

### GET /api/{account}/media/vault/{media_id} — partial
Raw media details/capture. No complete OF media-asset lifecycle.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:330](../../apps/runtime/src/services/ofapi-read-gateway.ts:330)

### GET /api/{account}/media/vault/lists — partial
Raw lists only. Missing lightweight query and all provider list mutation workflows.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:320](../../apps/runtime/src/services/ofapi-read-gateway.ts:320)

### GET /api/{account}/posts — partial
Real post list capture/materialization exists: limit/offset/publish-date-desc with overlap validation. Missing query/pinned/counters/minimumPublishDate/alternate order; no interactive post CRUD/stats/comments workflow.
Evidence: [apps/runtime/src/services/ofapi-capture-jobs.ts:1272](../../apps/runtime/src/services/ofapi-capture-jobs.ts:1272), [apps/runtime/src/services/ofapi-capture-contract.ts:198](../../apps/runtime/src/services/ofapi-capture-contract.ts:198), [apps/runtime/src/services/canonicalize/onlyfans-post-media.ts:1](../../apps/runtime/src/services/canonicalize/onlyfans-post-media.ts:1)

### GET /api/{account}/stored/trial-links — partial
Stored list used by reconciliation; missing include_smart_links/search/tags filters and full trial attribution APIs. cost/tags are retained in raw items but omitted from typed link-stat projection. Related subscriber/spender URLs are ordinary paid endpoints, not free stored people lists.
Evidence: [apps/runtime/src/services/ofapi.ts:1788](../../apps/runtime/src/services/ofapi.ts:1788), [apps/runtime/src/services/ofapi-link-stats-sync.ts:401](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:401)

### GET /api/{account}/stored/tracking-links — partial
Stored list used by reconciliation; missing include_smart_links/search/tags filters and explicit per-link stats/cohort operations. cost/tags are retained in raw items but omitted from typed link-stat projection. Related subscriber/spender URLs are ordinary paid endpoints, not free stored people lists.
Evidence: [apps/runtime/src/services/ofapi.ts:1772](../../apps/runtime/src/services/ofapi.ts:1772), [apps/runtime/src/services/ofapi-link-stats-sync.ts:400](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:400)

### GET /api/{account}/tracking-links/{tracking_link_id}/subscribers — full
List with limit/offset consumed by checkpointed identity discovery.
Evidence: [apps/runtime/src/services/ofapi.ts:1720](../../apps/runtime/src/services/ofapi.ts:1720), [apps/runtime/src/services/sync/ofapi-fan-identities.ts:364](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:364)

### GET /api/{account}/tracking-links/{tracking_link_id}/spenders — partial
Spender list consumed by identity discovery; new minSpend filter absent. Confirmed mapping defect: identity mapper reads item.id, while spender schema uses onlyfans_id; official 3-row example produces zero identity inserts.
Evidence: [apps/runtime/src/services/ofapi.ts:1720](../../apps/runtime/src/services/ofapi.ts:1720), [apps/runtime/src/services/sync/ofapi-fan-identities.ts:364](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:364)

### GET /api/{account}/tracking-links — partial
List + bounded identity discovery exist. Only limit/offset; missing date range, with_deleted, sortby/sort, pagination and synchronous.
Evidence: [apps/runtime/src/services/ofapi.ts:1704](../../apps/runtime/src/services/ofapi.ts:1704), [apps/runtime/src/services/sync/ofapi-fan-identities.ts:307](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:307)

### GET /api/{account}/transactions — partial
Transaction data pipeline exists. Gateway lacks tipsSource; sync/backfill lacks type and tipsSource. Financial normalization exists independently of provider analytics APIs.
Evidence: [apps/runtime/src/services/ofapi.ts:1656](../../apps/runtime/src/services/ofapi.ts:1656), [apps/runtime/src/services/ofapi-read-gateway.ts:260](../../apps/runtime/src/services/ofapi-read-gateway.ts:260), [apps/runtime/src/services/ofapi-transactions-backfill.ts:511](../../apps/runtime/src/services/ofapi-transactions-backfill.ts:511)

### GET /api/{account}/user-lists — partial
Read-only raw list. Missing view query; no provider list CRUD or durable list/membership management workflow.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:287](../../apps/runtime/src/services/ofapi-read-gateway.ts:287)

### GET /api/{account}/user-lists/{userListId}/users — partial
Read-only raw members list; no durable list/membership sync or management workflow.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:294](../../apps/runtime/src/services/ofapi-read-gateway.ts:294)

### GET /api/{account}/users/list — partial
Raw batch-user lookup and capture (up to ten ids). Not a full durable identity-refresh/CRM workflow.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:245](../../apps/runtime/src/services/ofapi-read-gateway.ts:245), [apps/runtime/src/services/ofapi-capture-contract.ts:73](../../apps/runtime/src/services/ofapi-capture-contract.ts:73)

### GET /api/{account}/users/{username} — partial
Raw user lookup and capture. Does not by itself prove complete durable user-model support. Reserved static paths blocked/restricted can collide with this matcher.
Evidence: [apps/runtime/src/services/ofapi-read-gateway.ts:251](../../apps/runtime/src/services/ofapi-read-gateway.ts:251)

### POST /api/webhooks — partial
Create exists, with fixed event selection and accountScope but no account_ids. New provider events are not yet selected.
Evidence: [apps/runtime/src/services/ofapi.ts:1570](../../apps/runtime/src/services/ofapi.ts:1570), [apps/runtime/src/services/ofapi-webhooks.ts:283](../../apps/runtime/src/services/ofapi-webhooks.ts:283), [packages/contracts/src/routes.ts:5684](../../packages/contracts/src/routes.ts:5684)

### PUT /api/webhooks/{webhook_id} — partial
Update exists for registration reconciliation; enabled/account_ids and full event-catalog support absent.
Evidence: [apps/runtime/src/services/ofapi.ts:1578](../../apps/runtime/src/services/ofapi.ts:1578), [apps/runtime/src/services/ofapi-webhooks.ts:314](../../apps/runtime/src/services/ofapi-webhooks.ts:314), [packages/contracts/src/routes.ts:5699](../../packages/contracts/src/routes.ts:5699)

