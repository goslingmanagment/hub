> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 07 — OFAPI Transport, Webhooks & Commands

**Scope.** This document covers the boundary between `core` and **onlyfansapi.com ("OFAPI")** — the third-party gateway that fronts OnlyFans. It describes the outbound HTTP client, the inbound webhook receiver, the event journal and its SSE fanout ordering, the desktop read-gateway proxy, the command outbox/executor (writes to the platform), egress/proxy selection, account-health signals, and the credit ledger that meters every OFAPI dollar. Files read in full for this territory: `apps/runtime/src/services/ofapi.ts`, `ofapi-read-gateway.ts`, `ofapi-webhooks.ts`, `ofapi-events.ts`, `ofapi-egress.ts`, `ofapi-payloads.ts`, `ofapi-command-outbox.ts`, `ofapi-command-executor.ts`, `ofapi-account-health.ts`, `ofapi-credits.ts` (the credit sink, adjacent to scope), `packages/db/src/repositories/ofapi.ts`, `packages/db/src/repositories/ofapi-commands.ts`. Supporting reads: the OFAPI route registrations in `apps/runtime/src/api/server.ts`, the contract schemas in `packages/contracts/src/routes.ts`, the OFAPI table definitions in `packages/db/src/schema.ts`, client construction in `apps/runtime/src/bootstrap.ts`, and config in `packages/shared/src/config.ts`. Cross-refs: **territory 06** (sync consumes `listChats`/`listChatMessages`/`listTransactions`/`listActiveFans`), **territory 07b** (projections consume settled webhook events), **territory 09** (spend/credits).

---

## 1. The OFAPI HTTP client (`services/ofapi.ts`)

### 1.1 Configuration, auth, transport

The client is created once at boot in `bootstrap.ts:171-179` **only when `config.ofapiApiKey` is set** (otherwise `app.ofapi` is `undefined`). It is built by `createOfapiClient({ baseUrl, apiKey, restDelayMs, onCreditSpend })` (`ofapi.ts:487`).

| Concern | Value | Anchor |
|---|---|---|
| Base URL | `config.ofapiBaseUrl`, default `https://app.onlyfansapi.com/api` | `ofapi.ts:27,493`; `config.ts:116` |
| Auth | `authorization: Bearer <apiKey>` header on **every** request | `ofapi.ts:596-598, 733-736, 835-839, 963-966, 1035-1037, 1114-1117, 1189-1192` |
| Request timeout | 15 s (`OFAPI_REQUEST_TIMEOUT_MS`) for lists/commands/admin | `ofapi.ts:17,599` |
| Proxy-read timeout | 60 s (`OFAPI_PROXY_READ_TIMEOUT_MS`) for the desktop gateway | `ofapi.ts:18,736` |
| Client-wide pacing | `restDelayMs` (default 500 ms, `OFAPI_REST_DELAY_MS`) between request slots, shared across concurrent callers because OFAPI rate limits are **account-global** | `ofapi.ts:19,494,544-557` |
| Retries (list reads) | 3 (`OFAPI_OBSERVED_RETRIES`) via `executeObservedRequest` | `ofapi.ts:20,590` |

`config-registry.ts` marks `ofapiBaseUrl` and `ofapiApiKey` as `editability: NEVER` — the base URL is pinned in code as "the single metered spend tap," and the API key is "a single metered spend tap." `ofapiRestDelayMs` is editable but `runtimeApply: none` (applied only at process boot). A gate test (referenced in the header comment `ofapi.ts:24-26`) enforces that the OFAPI host appears nowhere else in runtime code — every OFAPI call goes through this client.

Two distinct request engines live in this file:
- **Observed list reads** (`observedListRequest`, `ofapi.ts:559-711`) use plain `fetch` wrapped in the shared `executeObservedRequest` retry/telemetry harness. They do **not** attach a proxy dispatcher — sync-side reads go out the hub's default egress route.
- **Everything else** (`proxyReadRequest`, `sendMessageRequest`, typing/unsend/mark-read, and the admin `request`) uses raw `fetch` with a single attempt each.

### 1.2 Outbound OFAPI endpoints called

| Client method | HTTP | OFAPI path | Operation name (ledger) | Notes |
|---|---|---|---|---|
| `createWebhook` | POST | `/webhooks` | `ofapi_webhook_crud` | Admin; body `{endpoint_url, signing_secret, events, account_scope}` |
| `updateWebhook` | PUT | `/webhooks/{id}` | `ofapi_webhook_crud` | Admin |
| `listAccounts` | GET | `/accounts` | `ofapi_admin_accounts` | Admin; **carries no `_meta`** per spec |
| `listChats` | GET | `/{account}/chats` | `ofapi_chats` | limit(def 100), offset, order recent/old |
| `listChatMessages` | GET | `/{account}/chats/{chat}/messages` | `ofapi_chat_messages` | limit(def 100), `order=desc`, `first_id` cursor (inclusive — caller must drop reappearing cursor row, `ofapi.ts:186-190`) |
| `listActiveFans` | GET | `/{account}/fans/active` | `ofapi_fans_active` | limit **clamped to ≤20** (`OFAPI_FANS_PAGE_LIMIT`, `ofapi.ts:22,1311-1313`); wraps `{data:{list,hasMore}}` via `toFansListPage` |
| `listTransactions` | GET | `/{account}/transactions` | `ofapi_transactions` | limit≤100, `startDate`, `marker` cursor |
| `pingBalance` | GET | `/{account}/chats?limit=1` | `ofapi_balance_ping` | Reads a 1-row chat page purely to observe balance (because `/accounts` has no `_meta`) |
| `proxyRead` | GET | caller-supplied allowlisted path | `ofapi_gateway_*` | Desktop read gateway; single attempt; uses page proxy dispatcher |
| `sendTextMessage` | POST | `/{account}/chats/{conv}/messages` | `ofapi_command_send_text` | body `{text}` |
| `sendMediaMessage` | POST | `/{account}/chats/{conv}/messages` | `ofapi_command_send_media` | body `{text, price, mediaFiles[], previews?, lockedText?}` |
| `startTyping` | POST | `/{account}/chats/{conv}/typing` | `ofapi_command_typing_active` | documented free; fallback credits = 0 |
| `unsendMessage` | DELETE | `/{account}/chats/{conv}/messages/{msg}` | `ofapi_command_unsend_message` | body-less |
| `markChatRead` | POST | `/{account}/chats/{conv}/mark-as-read` | `ofapi_command_mark_chat_read` | body-less |

Sync-side callers (territory 06): `listChats`/`listChatMessages` in `services/sync/ofapi-dm-sync.ts:547,897`; `listActiveFans` in `services/sync/ofapi-audience-sync.ts`; `listTransactions` in `services/ofapi-transactions-backfill.ts:462`. `pingBalance`/`listAccounts` are also called from `ofapi-credits.ts:403,405` (balance ping) and from webhook registration.

### 1.3 Response shapes and `_meta` parsing

OFAPI wraps most bodies in `{data}` and appends a `_meta` block. `parseResponseMeta` (`ofapi.ts:384-399`) extracts:
- `_meta._credits.used` → `creditsUsed`
- `_meta._credits.balance` → `creditBalance`
- `_meta._cache.is_cached` → `isCached`
- `_meta._rate_limits.remaining_minute` → `rateRemainingMinute`

`toListPage` (`ofapi.ts:419-442`) tolerates both bare `{data:[...]}` (chats) and wrapped `{data:{list,hasMore}}` shapes; pagination cursor is read from `_pagination.next_marker`/`next_page` (a `marker` query param parsed out of the next-page URL). `toFansListPage` (`ofapi.ts:449-472`) handles the fans wrapper. `toAccountRecords` (`ofapi.ts:326-369`) maps `/accounts` entries to `{id, username, displayName, onlyfansName, onlyfansUserId, avatarUrl}`, coalescing many snake/camel field spellings and normalizing avatars via `normalizeOnlyFansAvatarUrl`.

### 1.4 Error handling and retry

`observedListRequest` classifies each HTTP response inside `onResponse` (`ofapi.ts:623-709`):
- **429** → retry, honoring `Retry-After` (clamped: seconds ≤60 s, else exponential `2^n s` ≤30 s, `ofapi.ts:474-485,648-659`).
- **500/502/503/504** → retry with exponential backoff (`ofapi.ts:661-669`).
- Other non-2xx → fail as `OfapiApiError(status, bodySlice)`.
- 2xx non-JSON body → fail.
- Transport errors → retry while retries remain, else `OfapiApiError(null, null)` (`onTransportError`, `ofapi.ts:603-622`).

`OfapiApiError` (`ofapi.ts:29-39`) carries `status`, `body` (truncated to 2000 chars), and `upstreamStatus` — the latter extracted from a wrapped OnlyFans error `{error:"ONLYFANS_COM_ERROR", onlyfans_response:{status}}` by `wrappedOnlyFansStatus` (`ofapi.ts:277-285`), used only on command sends so the executor can distinguish an OFAPI-layer failure from an OnlyFans-layer rejection.

### 1.5 Command send request specifics

`sendMessageRequest` (`ofapi.ts:818-904`) POSTs to `/{account}/chats/{conv}/messages` and requires a message id back (`data.id`, string or number), else throws. For media (`sendMediaMessageRequest`, `ofapi.ts:921-945`): media/preview IDs are converted to wire form by `toWireMediaId` (numeric strings → numbers, `ofapi.ts:814-816`); `lockedText: true` is added when `price>0` and text is non-empty. Typing/unsend/mark-read each make exactly one attempt and treat an empty or `{data:{success:true}}` body as success.

---

## 2. Credit metering — the outbound spend boundary (`ofapi-credits.ts` + db)

Every response that reaches the OFAPI server is reported to an injected `onCreditSpend` sink (`OfapiCreditSpendSink`), so no caller can forget to account for spend. `reportCreditSpend` (`ofapi.ts:499-543`) is invoked on **every** request path, including retry attempts (OFAPI charges each) and error responses that still carry `_meta`.

`resolveOfapiCreditSpend` (`ofapi.ts:144-164`) maps one HTTP response to a ledger delta:
- `_meta._credits.used` present → that value, `estimated=false` (server-reported always wins).
- 2xx without `_meta` → 1 credit, `estimated=true` (the standard uncached charge).
- error without `_meta` but with a balance → 0 credits, `estimated=true` (a free reconciliation anchor).
- error without `_meta` or balance → no row.

The sink itself (`createOfapiCreditSpendSink`, `ofapi-credits.ts:62-91`) is a **no-op unless `OFAPI_CREDIT_LEDGER_ENABLED`** is on. When on, it calls `recordOfapiCreditSpend` (`repositories/ofapi.ts:1234-1258`), which inserts one `ofapi_credit_ledger` row (`source='rest'`) **and** atomically bumps the `ofapi_credit_state` day counter in one transaction. The spend observation carries `{operation, httpStatus, credits, estimated, balanceAfter, requestId, pageId, attemptNumber, isCached}` (`ofapi.ts:121-131`). `pageId` attributes spend to a page in the ledger; admin/global calls leave it null.

Additional credit machinery in `ofapi-credits.ts` (also runs only when the ledger flag is on; scheduled from `ensureOfapiCreditSchedules`, `ofapi-credits.ts:423-434`):
- **Webhook accrual** (`runOfapiWebhookAccrual`, daily 00:40 UTC): one idempotent ledger row per completed UTC day at `ceil(events/100)` credits (`webhookAccrualCredits`, `ofapi-credits.ts:94-96`), counted from the journal (`countOfapiWebhookEventsReceivedBetween`). Idempotent via a partial unique index on `accrual_day` (`schema.ts:2047-2049`).
- **Reconciliation** (`runOfapiCreditReconciliation`, hourly at :05): walks balance observations, computes `residual = prevBalance − knownSpend − observedBalance`, and posts `external` (positive drift) / `refill` (negative) rows. Webhook burn is estimated per window from the journal (`events/100`) rather than read from accrual rows, to avoid double-counting (`ofapi-credits.ts:186-334`).
- **Burn monitor** (`runOfapiCreditBurnMonitor`, from the minutely OFAPI sweep): trailing-hour spend vs `OFAPI_BURN_ALERT_CREDITS_PER_HOUR` (default 300), debounced through notification incidents (`ofapi-credits.ts:341-381`).
- **Balance ping** (`runOfapiBalancePing`, daily 00:05 UTC, default off): one 1-credit `pingBalance` on a mapped page to anchor reconciliation on quiet days (`ofapi-credits.ts:390-410`).

`ofapi_credit_ledger.source` ∈ `{rest, webhook_accrual, external, refill, adjustment}` (`schema.ts:2000-2006`). Positive credits = spent, negative = added. The `ofapi_credit_state` singleton (id=1) tracks per-UTC-day `spent_credits`, `audience_spent_credits` (a separate reservation counter for the audience sweep), `last_balance`/`last_balance_at`, and the reconciliation cursor (`schema.ts:1980-1998`). `reserveOfapiDayCredits`/`settleOfapiDayCreditReservation` (`repositories/ofapi.ts:1052-1145`) atomically reserve estimated credits against a scope's day counter (`global` or `audience`) before a request and settle to actuals after — used by budget guards near the cap. See territory 09 for the reporting/reconciliation surface built on this ledger.

---

## 3. Desktop read gateway — inbound HTTP + outbound proxy (`ofapi-read-gateway.ts`)

**Inbound route:** `GET /api/v1/ofapi/read/*` (`server.ts:1586-1606`). Bearer chatter-key auth (`requireApiKeyUser`), rate-limited 120/min. The wildcard path and query are handed to `executeOfapiReadGatewayRequest(app, principal, {rawPath, rawQuery})`.

**Gating** (`ofapi-read-gateway.ts:365-373`): requires **both** `ofapiDesktopReadGatewayEnabled` and `ofapiCreditLedgerEnabled` true, and `app.ofapi.proxyRead` to exist, else `503`.

**Allowlist parsing** (`resolveOfapiReadGatewayRequest`, `ofapi-read-gateway.ts:148-342`): the path is split into decoded segments (each ≤200 chars, no `/`, `\`, `.`, `..`), and matched against a fixed read-only allowlist. Account id must match `^acct_[A-Za-z0-9]+$`. Query params are validated per-endpoint (integer ranges, enums, regex text rules); unknown params are rejected with `400`. Recognized resources and their operation names:

| Path shape | Operation | Notable query rules |
|---|---|---|
| `accounts` | (synthesized locally) | no query |
| `whoami` | (synthesized locally) | no query |
| `{acct}/chats` | `ofapi_gateway_chats` | limit 1–100, offset, order, filter, query, skip_users |
| `{acct}/chats/{id}/messages` | `ofapi_gateway_chat_messages` | first_id/last_id mutually exclusive, order coupling checked |
| `{acct}/chats/{id}/messages/{id}` | `ofapi_gateway_chat_message` | no query |
| `{acct}/chats/{id}/media` | `ofapi_gateway_chat_media` | type enum, limit, offset |
| `{acct}/users/list` | `ofapi_gateway_users_list` | `ids` = up to 10 comma-separated numeric IDs |
| `{acct}/users/{id}` | `ofapi_gateway_user` | no query |
| `{acct}/transactions` | `ofapi_gateway_transactions` | type enum, marker, startDate regex |
| `{acct}/fans/{all\|active}` | `ofapi_gateway_fans_{all\|active}` | limit 1–20, offset, query, `filter[online]=1`, `filter[total_spent]` (bracket keys re-serialized verbatim to OFAPI, `ofapi-read-gateway.ts:261-266`) |
| `{acct}/user-lists`, `.../users` | `ofapi_gateway_user_lists`/`_user_list_users` | limit, offset |
| `{acct}/media/vault` (+ `/lists`, item) | `ofapi_gateway_vault_*` | `delete-media` explicitly rejected (`:314-315`) |
| `{acct}/media/uploads/{id}/status` | `ofapi_gateway_upload_status` | fallbackCredits=0 (free) |

**Synthesized responses (no OFAPI call):**
- `whoami` → `{api_key:{name:"Agency Hub chatter: <username>"}, team:{name:"Agency Hub", slug:"agency-hub"}}` (`ofapi-read-gateway.ts:376-385`).
- `accounts` → built from the chatter's **assigned** core page mappings only, shaped like OFAPI accounts: `{id: ofapiAccountId, is_authenticated, authentication_progress: ofapiAuthStatus, display_name, onlyfans_username, onlyfans_user_data:{name,username,avatar}}` (`:390-407`). `is_authenticated` derives from `ofapiAuthStatusNeedsAction`.

**Proxied responses:** the target account must be assigned to the caller (`:409-412`, else `404`). Egress is resolved via `resolveOfapiEgressContext` (§4), then `app.ofapi.proxyRead(context, {operation, pathname, query, fallbackCredits, fallbackEstimated})` runs a **single** upstream GET (desktop remains the retry authority during migration, `ofapi.ts:218-230`). The raw `{status, body, headers}` is returned to the client; a subset of headers (`content-type`, `retry-after`, `x-ofapi-credits-*`, `x-rate-limit-*`) is forwarded (`ofapi.ts:784-797`). A transport-level `OfapiApiError` (`status===null`) is mapped to `503`; the egress dispatcher is always closed in `finally`.

---

## 4. Egress / proxy selection (`ofapi-egress.ts`)

`resolveOfapiEgressContext(app, {pageId, ofapiAccountId})` (`ofapi-egress.ts:18-49`) loads the page (`findPageById`), asserts it is an `onlyfans` page whose `ofapiAccountId` matches, resolves its stored proxy config (`resolveStoredProxyConfig`), and builds an undici `Dispatcher` via `createProxyRequestDispatcher`. It returns `{dispatcher, egressKey, close()}`. `egressKey` comes from `resolveStoredProxyEgressKey` (`page-context.ts:175-182`) — the proxy's `rateLimitScopeKey` or a key derived from the proxy URL — used as the rate-limit scope for the account's egress. A page with no configured proxy yields a `503` ("requires a configured page proxy").

**Discrepancy — egress is only applied on the desktop read path.** Only `proxyReadRequest` consumes `context.dispatcher` (`ofapi.ts:738-740`). The sync DM/audience reads build their `OfapiRequestContext` with only `{requestObserver, pageId}` and **no** `dispatcher`/`egressKey` (`sync/ofapi-dm-sync.ts:506-509`), and the command executor passes only `{pageId}` (`ofapi-command-executor.ts:246-280`). So sync list reads and command writes travel the hub's **direct** egress, despite the `OfapiRequestContext.dispatcher` comment stating "Account-scoped OFAPI reads must use the page egress dispatcher so large response bodies do not go through the hub VPS direct route" (`ofapi.ts:63-65`). Only the desktop gateway currently honors that.

---

## 5. Inbound webhooks — the key inbound boundary (`ofapi-webhooks.ts`)

### 5.1 Receiver route

**Route:** `POST /api/v1/ofapi/webhook` (`server.ts:1291-1310`). Called by onlyfansapi.com, **not** by API clients. The body is parsed **as a raw Buffer** (a dedicated content-type parser at `server.ts:1284-1289` keeps the raw bytes so the HMAC is computed over exactly what OFAPI signed). Rate-limited by `OFAPI_WEBHOOK_RATE_LIMIT_MAX` (default 1000) per `OFAPI_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS` (default 60). The handler forwards `{rawBody, signatureHeader: headers.signature, idempotencyKeyHeader: headers["x-ofapi-idempotency-key"]}` to `receiveOfapiWebhook`.

### 5.2 Receiver logic (`receiveOfapiWebhook`, `ofapi-webhooks.ts:104-191`)

1. Load `ofapi_webhook_config` singleton; `503` if the webhook was never registered.
2. **Verify HMAC** (`verifyOfapiSignature`, `ofapi-webhooks.ts:74-86`): the `signature` header must be 64 hex chars; `HMAC-SHA256(rawBody, signingSecret)` compared with `timingSafeEqual`. Both the current and the previous signing secret are accepted (registration rotates the secret at OFAPI before persisting locally, so in-flight deliveries may still carry the old one, `:118-129`). Failure → `401` and a warning (a sustained run means secret divergence; OFAPI drops deliveries after 5 retries).
3. Require the `x-ofapi-idempotency-key` header (≤255 chars), else `400`.
4. Parse the body as JSON, then validate against `ofapiWebhookEnvelopeSchema` = `{event: string, account_id?: string|null, payload: unknown}` (`ofapi-payloads.ts:11-15`). The event id is **not** in the body — dedup runs on the header. Invalid JSON/envelope → `400`.
5. **Journal** via `insertOfapiWebhookEvent` (`repositories/ofapi.ts:45-62`): inserts into `ofapi_webhook_events` with `onConflictDoNothing` on `idempotency_key`. The full envelope is stored in `payload`. `projectionStatus` is set to `pending` iff the event type is a DM, subscription, or presence projection candidate (`isOfapiDmProjectionEventType || isOfapiSubscriptionProjectionEventType || isOfapiPresenceProjectionEventType`, `:168-172`), else `none` — so enabling a projection flag later lets the sweep pick up still-retained journal rows.
6. **Duplicate** (insert returned nothing) → ack `{received:true, duplicate:true}` with no further work.
7. Otherwise best-effort enqueue `sendOfapiEventProcessJob(boss, created.id)`; a failure is only logged (the minutely sweep re-enqueues). Ack `{received:true, duplicate:false}`.

The header comment notes this path stays well under OFAPI's 15 s delivery timeout: two indexed statements plus one pg-boss send.

**Inbound event set** (`OFAPI_WEBHOOK_EVENTS`, `ofapi-webhooks.ts:40-58`): `messages.received`, `messages.sent`, `messages.deleted`, `messages.ppv.unlocked`, `tips.received`, `transactions.new`, `subscriptions.new`, `subscriptions.renewed`, `users.typing`, `users.online`, `users.offline`, `accounts.connected`, `accounts.reconnected`, `accounts.session_expired`, `accounts.authentication_failed`, `accounts.otp_code_required`, `accounts.face_otp_required`.

### 5.3 Webhook registration (admin, outbound to OFAPI)

**Routes:** `GET /api/v1/admin/ofapi/webhook` (status) and `POST /api/v1/admin/ofapi/webhook` (register) — cookie/owner auth (`server.ts:1557-1573`).

`registerOfapiWebhook` (`ofapi-webhooks.ts:264-328`):
- Generates a fresh 32-byte signing secret (`randomToken(32)`).
- Calls `client.updateWebhook(existingId, ...)` or `client.createWebhook(...)` with `{endpointUrl, signingSecret, events: OFAPI_WEBHOOK_EVENTS, accountScope:"global"}`. A failure → `503`.
- Persists to `ofapi_webhook_config` (`upsertOfapiWebhookConfig`) with the **encrypted** signing secret (`encryptJson` with the current key version) and the old encrypted secret in `previous_encrypted_signing_secret` as a grace window.
- **Account→page mapping** (`mapOfapiAccountsToPages`, `:210-262`): fetches `client.listAccounts()` and OnlyFans pages; maps an OFAPI account to a page only on an **unambiguous, single** case-insensitive username match to a page that has no mapping yet, writing `pages.ofapi_account_id` via `setPageOfapiAccountId`. Ambiguous/unmatched accounts and unmapped pages are reported back for manual resolution. Returns `{mapped, unmatchedAccounts, unmappedPages}` in the response, plus `signingSecretMask` (first 4 chars + `…`).

`getOfapiWebhookStatus` (`:330-380`) returns config metadata (masked secret), per-page mapping/auth status/last-event age, and current credit state (`lastBalance`, `lastBalanceAt`, `spentToday`).

---

## 6. Event processing & SSE fanout ordering (`ofapi-events.ts`)

### 6.1 Queues, schedules, singleton worker

| Queue const | Name | Policy | Notes |
|---|---|---|---|
| `OFAPI_EVENT_PROCESS_QUEUE` | `ofapi.events.process.v2` | exclusive, retryLimit 2, 30 s backoff | `singletonKey=eventId` prevents duplicate jobs per event |
| `OFAPI_EVENT_SWEEP_QUEUE` | `ofapi.events.sweep` | exclusive | scheduled `* * * * *` (minutely) |
| `OFAPI_EVENT_CLEANUP_QUEUE` | `ofapi.events.cleanup` | standard | scheduled `30 2 * * *` UTC |

The processing worker (`startOfapiEventWorker`, `:434-505`) asserts **exactly one replica** (`OFAPI_EVENT_WORKER_REPLICAS` must be 1, `:376-383`) and takes a **Postgres advisory lock** (namespace 58211, key 1) so only one process ever settles rows — this preserves the single-worker fanout-order invariant. It works batches of up to `OFAPI_EVENT_PROCESS_BATCH_SIZE` (100) and re-sorts each batch by ascending `eventId` (`sortOfapiEventJobs`, `:80-84`) before processing, because pg-boss does not guarantee batch order.

### 6.2 Processing one event (`processOfapiWebhookEvent`, `:276-344`)

1. Load the journal row; skip if not `pending`.
2. Re-validate the envelope; invalid → settle `failed`.
3. Resolve the page from `ofapiAccountId` via `findPageByOfapiAccountId`; no page/no account_id → settle `skipped`.
4. Derive the SSE frame via `mapOfapiEventToSyncEvent`, then validate it against `syncEventSchema`. Unmappable / journal-only event types → settle `skipped`.
5. In a transaction: `settleOfapiWebhookEvent(status='processed', platformAccountId, syncEvent, ...)` (guarded on `status='pending'` so a sweep race settles exactly once), which assigns `fanout_seq` from `nextval('ofapi_webhook_events_fanout_seq')` (`repositories/ofapi.ts:79-109`); then `pg_notify('ofapi_sync_events', <rowId>)` fires on commit (`:341`).
6. **After** the settle commit, `runPostSettleOfapiProjections` (`:94-109`) runs best-effort, never-throwing post-settle steps: command verification, DM cold archive, DM/subscription/presence/spend projections, and account health.

**`fanout_seq` = settle-ordered SSE cursor.** Because `fanout_seq` is assigned when a row is *settled* (not when received), late settles (retries, sweep) still land ahead of every already-advanced `Last-Event-ID`, so no advanced consumer misses them (`schema.ts:2112-2116`). Data problems settle terminally (`skipped`/`failed`, no retry); only infra errors propagate to pg-boss retries.

### 6.3 Event → SyncEvent frame mapping (`mapOfapiEventToSyncEvent`, `:117-220`)

This is the shape that flows to desktop over SSE (territory 07b/desktop). Requires `account_id`. Per event:

| Webhook event | SyncEvent frame `type` | Key fields extracted from payload |
|---|---|---|
| `messages.received` | `messageReceived` | chatId = `payload.fromUser.id`, messageId = `payload.id`, normalized `message` |
| `messages.sent` | `messageSent` | chatId = `payload.toUser.id`, messageId, normalized `message` |
| `messages.deleted` | `messageDeleted` | messageId |
| `messages.ppv.unlocked` | `ppvUnlocked` | chatId + messageId from the chat-link (`firstId=`) in payload text |
| `tips.received` | `tipReceived` | chatId, messageId, `amountUsd` = `payload.amountGross` |
| `subscriptions.new`/`renewed` | `chatListUpdated` | account only |
| `users.online`/`offline` | `presence` | chatId = `payload.fan.id`, `online`, `lastSeenAt` |
| `users.typing` | `typing` | chatId = `payload.id` |
| `accounts.connected`/`reconnected`/`session_expired` | `accountAuthChanged` | `authenticated:true` |
| `accounts.authentication_failed`/`otp_code_required`/`face_otp_required` | `accountAuthChanged` | `authenticated:false` |
| `transactions.new` and unknown types | (null — journaled, not fanned out) | — |

`transactions.new` is deliberately journaled but never fanned out (desktop has no frame for it and a chat-list hint would trigger credit-charged refetches, `:111-116`). Note `session_expired` maps to `authenticated:true` because OFAPI fires it after a silent recovery.

### 6.4 Sweep and cleanup

The minutely sweep (`:454-490`) does much more than re-enqueue lost events (`sweepPendingOfapiEvents` re-sends jobs for `pending` rows older than 30 s, `:346-360`): it also drives the DM projection sweep, DM cold-archive sweep, subscription/presence/spend projection sweeps, the account-health monitor, and the credit burn monitor — all in one job. Cleanup (`:492-498`) deletes journal rows past `OFAPI_EVENT_RETENTION_DAYS` (default 7, `:68,362-372`) and purges the DM cold archive.

### 6.5 SSE consumers (cross-ref)

The `ofapi_sync_events` NOTIFY channel and `listOfapiSyncEventsForReplay` (`repositories/ofapi.ts:896-932`) are consumed by `services/events-stream.ts` and the SSE route `GET /api/v1/events/stream` (`server.ts:1346`, `1511`). Replay is page-filtered by the chatter's assigned pages and driven by `fanout_seq` after the `Last-Event-ID`. `getMaxOfapiFanoutSeq`/`getOfapiFanoutReplayWindow` expose the durable high-water. Full SSE handling belongs to a sibling territory.

---

## 7. Payload parsing (`ofapi-payloads.ts`)

Shared helpers, extracted to avoid a circular import between the event processor and the DM projection. Key facts:
- `ofapiWebhookEnvelopeSchema` (`:11-15`) — the wire envelope; the event id is header-only.
- `idToString` (`:27-35`) — OnlyFans ids arrive as numbers in message payloads and strings in notification payloads; SyncEvent serializes all as strings.
- `notificationChatId` (`:79-83`) — fan id from `payload.user.id` or the `/my/chats/chat/<fanId>` link; `payload.user_id` is deliberately **not** a fallback (in live captures it holds the creator's id, not the fan).
- `extractMessageIdFromNotification` (`:73-75`) — parses `firstId=<msgId>` out of the notification chat link.
- `normalizeOfapiSyncMessage` (`:175-218`) — builds the rich `message` object embedded in `messageReceived`/`messageSent` frames: `{id, text, createdAt, isSentByMe, price, isOpened?, isNew?, isTip?, tipAmountUsd?, tipText?, mediaCount?, media[], replyTo?}`. Media items are normalized to `{id, type, isReady, locked, durationSeconds?}` (`normalizeSyncMediaItem`, `:133-151`; `locked = media.canView === false`). Requires `id`, `chatId`, and a parseable `createdAt` or returns null.

---

## 8. Command outbox & executor — the outbound WRITE-to-platform boundary

### 8.1 Command kinds and payloads

Five versioned kinds (`OfapiCommandKind`, `schema.ts:25-30`; `ofapi-command-outbox.ts:19-24`):

| Kind | Payload | Retryable? | OFAPI call |
|---|---|---|---|
| `send_text_message_v1` | `{text}` | yes | POST messages |
| `send_media_message_v1` | `{text, price, mediaFiles[], previews[]}` | yes | POST messages |
| `typing_active_v1` | `{}` | no | POST typing |
| `unsend_message_v1` | `{messageId}` | no | DELETE message |
| `mark_chat_read_v1` | `{}` | no | POST mark-as-read |

### 8.2 Command intake (`ofapi-command-outbox.ts`)

**Routes:** `POST /api/v1/ofapi/commands` (create, rate 60/min), `GET /api/v1/ofapi/commands/:commandId`, `POST /api/v1/ofapi/commands/:commandId/cancel` — all bearer chatter-key (`server.ts:1608-1647`). Request bodies validated by `createOfapiCommandBodySchema`, a discriminated union on `kind` (`routes.ts:3290-3327`) with strict fields: `accountId` `^acct_[A-Za-z0-9]+$`, `conversationId` `^[0-9]{1,30}$`, media IDs `^([0-9]{1,30}|ofapi_media_[A-Za-z0-9_-]{1,128})$`, price int 0 or 3–200, mediaFiles 1–50, previews ≤50 and a subset of mediaFiles.

`createOfapiCommand` (`:191-265`):
- Requires `ofapiDesktopCommandOutboxEnabled` (else `503`, `:113-117`).
- Resolves the account to a page **assigned to the caller** (`resolveAssignedPage`, `:119-133`; else `404`).
- Only `send_text`/`send_media` may carry `retryOfCommandId`; the retry source must be an owned command in the same conversation, same kind, and in a retryable state (`failed_retryable`, `failed_terminal`, `indeterminate`, `cancelled` — `RETRYABLE_SOURCE_STATES`, `:71-76`), else `409`.
- Computes `payloadHash = sha256(kind, accountId, conversationId, payload, retryOfCommandId)` (`canonicalHash`, `:135-160`).
- `createOrGetOfapiCommand` (`repositories/ofapi-commands.ts:36-79`) inserts with `onConflictDoNothing` on `(page_id, chatter_user_id, client_command_id)`. On a lost race it reads the existing row; the service then verifies canonical fields match — a mismatch means the same `clientCommandId` was reused for a different command → `409` (`:248-259`).
- Returns `202` (new) or `200` (dedup); the route then enqueues `sendOfapiCommandExecuteJob` when execution is enabled (`server.ts:1620-1629`).

Cancel (`cancelOfapiCommand`, `:284-322`) only transitions `queued`→`cancelled` (idempotent if already cancelled; `409` otherwise). Views (`toView`, `:162-183`) never echo message text, only metadata (`payloadHash`, `platformMessageId`, error codes, timestamps).

### 8.3 Command lifecycle & executor (`ofapi-command-executor.ts`)

**Queues:** `OFAPI_COMMAND_EXECUTE_QUEUE` = `ofapi.commands.execute` (standard, **retryLimit 0** — exactly one vendor attempt), `OFAPI_COMMAND_SWEEP_QUEUE` = `ofapi.commands.sweep` (exclusive, minutely). Enqueue uses `singletonKey=commandId, retryLimit:0` (`:116-125`).

State machine (`ofapi_commands.state`, `schema.ts:1087-1095`): `queued → in_flight → {confirmed | failed_retryable | failed_terminal | indeterminate}`, plus `cancelled`. A DB check constraint caps `attempt_count ≤ 1` (`schema.ts:1159-1161`), and a partial unique index `ofapi_commands_one_in_flight_lane_uniq` on `(page_id, conversation_id) where state='in_flight'` enforces **one in-flight command per conversation lane** (`schema.ts:1111-1113`).

`executeOfapiCommand` (`:216-325`):
- No-op unless `ofapiDesktopCommandExecutionEnabled` (`:88-92,221-223`).
- Re-reads the row; must be `queued`; must have the client method available (`canExecuteCommandKind`, `:127-143`) else stays queued (`client_unavailable`).
- `claimQueuedOfapiCommand` (`ofapi-commands.ts:136-166`) atomically flips `queued`→`in_flight`, `attempt_count=1`; the lane unique index is the final concurrency authority (a `23505` returns null → not claimed).
- Re-validates the payload from the DB (`textPayload`/`mediaPayload`/`unsendPayload`, `:145-214`) with the same bounds as intake; a bad payload throws `OfapiApiError(422)`.
- Calls the matching client method with context `{pageId}` only.
- **Success** → `finalizeOfapiCommand(state='confirmed', platformMessageId, verifierResult:{source:'ofapi_response',confirmedAt})` from states `['in_flight','indeterminate']`.
- **Failure** → `classifyOfapiCommandFailure` (`:44-86`) maps status to outcome: **429** → `failed_retryable` (`ofapi_rate_limited`); **400/401/403/404/409/422** → `failed_terminal` (`ofapi_http_<n>`); **2xx-but-threw** → `indeterminate` (`ofapi_ambiguous_success`); any other status or transport-null → `indeterminate`. Uses `upstreamStatus ?? status` so an OnlyFans-layer status wins. Finalizes from `['in_flight']`.

### 8.4 Confirmation via webhook (`verifyOfapiCommandFromSentWebhook`, `:401-486`)

Called as a post-settle step for `messages.sent` events. It extracts `conversationId` (`payload.toUser.id`), `platformMessageId` (`payload.id`), normalized text, media count, and price, then finds in-flight/indeterminate command candidates for the same account+conversation whose `attempt_started_at` falls within `[receivedAt − 10 min, receivedAt + 5 s]` (`listOfapiCommandVerificationCandidates`, `ofapi-commands.ts:269-289`). It confirms a command only on an **exact single** match (text equal for text; text+price+mediaFiles.length for media); ambiguous/zero matches are logged and left. On a single match it `finalizeOfapiCommand(state='confirmed', verifierResult:{source:'messages.sent', eventId, receivedAt})`. This is the reconciliation path when the direct executor response was `indeterminate`.

### 8.5 Sweep, stale recovery, redaction (`sweepOfapiCommands`, `:327-364`)

Minutely: (1) marks `in_flight` rows older than 2 min as `indeterminate` (`worker_attempt_stale`, `markStaleInFlightOfapiCommandsIndeterminate`); (2) **redacts payloads** of terminal rows (`confirmed`/`failed_*`/`cancelled`) older than 7 days — text payloads become `{text:""}`, others `{}`, and `payload_redacted_at` is stamped (`redactTerminalOfapiCommandPayloads`, `ofapi-commands.ts:237-267`); (3) when execution is enabled, re-enqueues up to 100 queued commands. Dedupe rows carry a 400-day `dedupe_expires_at` horizon (`ofapi-commands.ts:53`).

---

## 9. Account health signals (`ofapi-account-health.ts`)

All gated by `OFAPI_ACCOUNT_HEALTH_ENABLED` (default off). Two paths:

**Post-settle auth projection** (`applyOfapiAccountHealthEvent`, `:72-121`): for `accounts.*` events, advances `pages.ofapi_auth_status`/`ofapi_auth_changed_at` **forward-only by receive time** (`advancePageOfapiAuthStatus`, `repositories/ofapi.ts:1942-1964` — an out-of-order older event is skipped). It then opens/resolves a per-page Telegram-backed incident: alert statuses = `session_expired` + the action-required set `{authentication_failed, otp_code_required, face_otp_required}`; recovered statuses = `{connected, reconnected}`. `session_expired` alerts for visibility but is not treated as action-required (`ofapiAuthStatusNeedsAction`, `:56-58`, also used by the read gateway's `is_authenticated`). Never throws into the event processor.

**Minutely health monitor** (`runOfapiAccountHealthMonitor`, `:128-194`, runs inside the OFAPI sweep): reads an effective-config snapshot and checks two silent-failure modes — **low credit balance** (`getOfapiCreditState.lastBalance < OFAPI_CREDIT_ALERT_THRESHOLD`, default 1000) and **webhook silence** (`now − latestEventReceivedAt > OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES`, default 720, only while mapped pages exist and a baseline event exists). Both open/resolve debounced global incidents via `notification-incidents`. A zeroed threshold resolves any open incident rather than leaving it stale.

---

## 10. Data stores this territory owns

| Table | Purpose | Key columns / anchor |
|---|---|---|
| `ofapi_webhook_events` | Journal of every inbound delivery; SSE source | `idempotency_key` (unique), `event_type`, `ofapi_account_id`, `platform_account_id`, `payload`, `sync_event`, `fanout_seq` (settle-ordered SSE id), `status`, projection/archive bookkeeping, `received_at` — `schema.ts:2119-2170` |
| `ofapi_webhook_config` | Singleton (id=1) webhook registration | `external_webhook_id`, `endpoint_url`, `account_scope`, `events`, `encrypted_signing_secret`, `previous_encrypted_signing_secret` — `schema.ts:1964-1974` |
| `ofapi_commands` | Durable command outbox | `client_command_id`, `page_id`, `chatter_user_id`, `ofapi_account_id`, `conversation_id`, `kind`, `payload`, `payload_hash`, `state`, `attempt_count≤1`, `platform_message_id`, `verifier_result`, `dedupe_expires_at`, `payload_redacted_at` — `schema.ts:1070-1175` |
| `ofapi_credit_ledger` | Append-only credit movement | `source`, `operation`, `page_id`, `http_status`, `credits`, `estimated`, `balance_after`, `request_id`, `accrual_day`, `details` — `schema.ts:2015-2051` |
| `ofapi_credit_state` | Singleton budget/reconcile state | `spent_credits`/`spend_day`, `audience_spent_credits`, `last_balance`, reconcile cursor — `schema.ts:1980-1998` |
| `ofapi_spend_projection_events` | Shadow spend projection (C3) | `domain_key` (unique), `source_event_type`, `journal_id`, `page_id`, amounts in mills, `event_status` — `schema.ts:2057-2110` (owned/consumed by territory 07b/09) |
| `pages.ofapi_account_id`, `.ofapi_auth_status`, `.ofapi_auth_changed_at` | Account↔page mapping and auth state | written by mapping + health projection |

---

## 11. Boundary summary (what crosses, direction, counterpart)

**Outbound to OFAPI (onlyfansapi.com), `Bearer <OFAPI_API_KEY>`:**
- Reads: chats, chat messages, active fans, transactions, accounts, balance ping — GET, list shapes with `_meta` credit/rate telemetry. Counterpart: sync engine (territory 06), balance ping.
- Desktop proxy reads: allowlisted GET resources through the page proxy dispatcher, single attempt, raw JSON relayed to the desktop client.
- Writes (commands): send text/media message (POST, returns platform message id), typing (POST), unsend (DELETE), mark-read (POST). One attempt each; charged per response.
- Admin: create/update webhook (POST/PUT `/webhooks` with signing secret + subscribed events), list accounts (GET).
- Every response (2xx and error-with-`_meta`, retries included) emits a credit-spend observation recorded to `ofapi_credit_ledger` when the ledger flag is on.

**Inbound from OFAPI:**
- `POST /api/v1/ofapi/webhook` — HMAC-SHA256 (hex `signature` header) over raw body, deduped on `x-ofapi-idempotency-key`, envelope `{event, account_id, payload}`. Journaled to `ofapi_webhook_events`, acked within OFAPI's 15 s window.

**Inbound from desktop/extension clients (bearer chatter key):**
- `GET /api/v1/ofapi/read/*` (allowlisted proxy reads), `POST/GET /api/v1/ofapi/commands[...]` (command outbox), `GET /api/v1/ofapi/credits/summary`.

**Inbound from dashboard owner (cookie):**
- `GET/POST /api/v1/admin/ofapi/webhook` (status/register), `GET /api/v1/admin/ofapi/credits/*` (territory 09).

**DB / queue / stream:**
- Postgres: the six OFAPI tables above + `pages` columns; `transactions` read for financial-truth summaries.
- pg-boss queues: `ofapi.events.process.v2`, `ofapi.events.sweep`, `ofapi.events.cleanup`, `ofapi.commands.execute`, `ofapi.commands.sweep`, `ofapi.credits.{accrual,reconcile,balance-ping}`.
- Postgres `NOTIFY ofapi_sync_events` → SSE fanout in `events-stream.ts` (territory 07b/desktop).
- Telegram (via `notification-incidents`): account-auth, low-credit, webhook-silence, and burn-rate incidents.

**Secrets/credentials:** `OFAPI_API_KEY` (env, never editable at runtime); webhook signing secret generated locally, stored AES-encrypted (`encryptJson`) in `ofapi_webhook_config`, with a previous-secret grace window; page proxy credentials resolved per egress context.

**Feature flags (env, mostly default off):** `OFAPI_CREDIT_LEDGER_ENABLED`, `OFAPI_DESKTOP_READ_GATEWAY_ENABLED`, `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED`, `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED`, `OFAPI_ACCOUNT_HEALTH_ENABLED`, `OFAPI_BALANCE_PING_ENABLED`; tunables `OFAPI_REST_DELAY_MS`, `OFAPI_EVENT_RETENTION_DAYS`, `OFAPI_EVENT_WORKER_REPLICAS` (must be 1), `OFAPI_WEBHOOK_RATE_LIMIT_{MAX,WINDOW_SECONDS}`, `OFAPI_CREDIT_ALERT_THRESHOLD`, `OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES`, `OFAPI_BURN_ALERT_CREDITS_PER_HOUR`.
