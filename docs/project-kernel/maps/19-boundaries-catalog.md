> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 19 — Boundaries Catalog (every contract `core` has with the outside world)

**Scope.** This document is the consolidated, field-level catalog of every point where data crosses into or out of the `core` backend, described from core's side. It is synthesized from the boundary-heavy territory docs (02 HTTP API, 03 contracts, 07 OFAPI transport, 07b OFAPI projections, 08 platform adapters, 09 financial/credits, 10 AI gateway, 12 Telegram, 13 auth/config, 14 events/streaming) and **re-verified against the current source**. Files read to verify boundary specifics: `apps/runtime/src/api/server.ts` (route registration, SSE, pg-boss wiring), `apps/runtime/src/services/ofapi.ts` (OFAPI HTTP client — reads, writes, webhook CRUD, proxyRead), `apps/runtime/src/services/ofapi-webhooks.ts` (webhook receiver + registration), `apps/runtime/src/services/ofapi-events.ts` (event queue + NOTIFY), `apps/runtime/src/services/ofapi-command-executor.ts` (command queue + executor), `apps/runtime/src/services/ai-gateway-anthropic-provider.ts` + `ai-gateway-anthropic.ts` (Anthropic call), `apps/runtime/src/services/telegram.ts` (Telegram Bot API), `apps/runtime/src/services/sync-queue.ts` + `apps/runtime/src/services/ofapi-credits.ts` + `apps/runtime/src/services/ofapi-dm-analytics.ts` + `apps/runtime/src/worker-services.ts` (all pg-boss queue names/schedules/payloads), and `packages/shared/src/config.ts` + `config-registry.ts` (env-var + secret surface). Table-group summaries for Postgres cross-reference Territory 04.

The catalog is organized into ten boundary classes. Every row states **direction**, **transport/protocol**, **authentication**, **the exact data that crosses (key fields)**, **the counterpart**, and a **file anchor**.

---

## 0. Counterpart map (who core talks to)

| Counterpart | Host (default) | core's role | Class |
|---|---|---|---|
| Dashboard SPA | same-origin (`/`) | server | Inbound HTTP (§1) |
| Desktop chat app ("ChatGoose"/"ChatMuse") | same-origin API | server | Inbound HTTP + SSE (§1, §9) |
| Browser extension | same-origin API | server | Inbound HTTP (§1) |
| OFAPI / onlyfansapi.com | `https://app.onlyfansapi.com/api` | client **and** webhook receiver | Inbound webhook (§2) + Outbound REST (§3) |
| OnlyMonster aggregator | `https://omapi.onlymonster.ai` | client (reads OnlyFans data) | Outbound (§4) |
| Fansly private API | `https://apiv3.fansly.com/api/v1` | client | Outbound (§4) |
| OnlyFans.com public profile | `onlyfans.com` (Playwright) | anonymous scraper | Outbound (§4) |
| api.ipify.org | `https://api.ipify.org` | client (egress-IP probe) | Outbound (§4) |
| Anthropic Messages API | `api.anthropic.com` (via `@anthropic-ai/sdk`) | client | Outbound (§5) |
| Telegram Bot API | `https://api.telegram.org` | client | Outbound (§6) |
| Postgres | `DATABASE_URL` | owner of durable state | Storage (§7) + Queue (§8) |

The three platform upstreams and the AI provider egress through undici dispatchers built by `@agency_hub_core/shared` (`createRequestDispatcher` / `createProxyRequestDispatcher`); when a page has a stored proxy, the call routes through it (Territory 15). OFAPI is the only counterpart that is BOTH an inbound and an outbound boundary.

---

## 1. INBOUND — HTTP API consumed by clients

The entire client-facing surface is the Fastify app built by `buildApiServer(appContext)` (`apps/runtime/src/api/server.ts:423`). Two API prefixes coexist: `/api/v1/*` (bulk) and `/api/v2/*` (spenders + fan-search only). There is **no CORS plugin** — API and SPA are same-origin, so the session cookie flows without cross-origin headers. There is **no custom `bodyLimit`** — Fastify's 1 MB default applies everywhere (including the OFAPI webhook). The full ~130-route catalog is Territory 02 §4; this section states the **auth model** and the **external-client consumption split**.

### 1.1 Two credential types, three roles

| Credential | Header/cookie | Roles it authenticates | Issued by | Digest stored |
|---|---|---|---|---|
| **Session** | Cookie `agency_hub_core_session` = `randomToken(32)` base64url | `owner`, `team_lead` (dashboard) | `POST /api/v1/auth/login` | `sha256Hex` in `auth_sessions.token_digest` |
| **API key** | `Authorization: Bearer agency_hub_core_<token>` | `chatter` only (desktop + extension) | `POST /admin/users/:u/api-keys` (owner, returned once) | `sha256Hex` in `api_keys.token_digest` |
| **Monitoring token** | `x-monitoring-token` header | none — bypass for `GET /health/sync` | `config.healthSyncMonitoringToken` (env) | constant-time compared, not stored |

Principal resolution is lazy per request (`server.ts:475-499`): a Bearer header is tried as an API key first, else the session cookie. `owner` sees all pages; `team_lead`/`chatter` are scoped to `assignedPageIds`. The `security:` field on each contract schema is OpenAPI documentation only — the handler's guard call is the real gate (Territory 02 §8).

### 1.2 External-client boundary — which endpoints each client uses

**Desktop chat app + browser extension (chatter API-key, bearer).** These are the only clients that authenticate with an API key. They consume:

| Method | Path | Data in | Data out | Anchor |
|---|---|---|---|---|
| POST | `/api/v1/ai/gateway/stream` | `{clientRequestId(uuid), feature, pageLabel, platform, platformUserId, conversationId, model, reasoningEffort, temperature?, maxTokens?, isRegeneration, prompt.systemBlocks[], prompt.userBlocks[]}` each block `{text, cache:1h\|5m\|none}` | SSE `event: ai` frames (§9) | `server.ts:701-803` |
| POST | `/api/v1/ai-usage/batch` | `{events:[1..100]}` each `{clientEventId, feature, model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, conversationId?, durationMs?, isCacheHit, isRegeneration, completedAt}` — **no cost field** | `{receivedCount, insertedCount, invalidCount, dedupedCount}` | `server.ts:697`; gate inside `ai-usage.ts:79` |
| GET | `/api/v1/events/stream` | `Last-Event-ID` header or `?lastEventId` cursor | SSE `event: sync` frames (§9) | `server.ts:1346-1540` |
| GET | `/api/v1/events/snapshot` | `{accountId, afterSeq, snapshotCursor?, pageCursor, limit}` | durable chat snapshot JSON `{version, snapshotCursor, threads[], hot+archive messages merged, unresolvedTombstones[], coverage, nextPageCursor}`; **money in USD dollars** | `server.ts` (`getOfapiSyncSnapshot`) |
| GET | `/api/v1/ofapi/credits/summary` | (page scope from principal) | page-scoped REST + estimated webhook credits only (owner balance/refill omitted) | Territory 09 |
| GET | `/api/v1/ofapi/read/*` | allowlisted OFAPI GET path + query (120/min) | raw `{status, body, headers}` proxied from OFAPI (§3) | `server.ts:1588` |
| POST | `/api/v1/ofapi/commands` | discriminated union on `kind` (send_text/send_media/typing/unsend/mark_read) `{clientCommandId, accountId(^acct_), conversationId(^[0-9]{1,30}$), payload...}` (60/min) | 202 (new, enqueues execute job) / 200 (dedup) / 409 (client-id payload mismatch) | `server.ts:1610` |
| GET/POST | `/api/v1/ofapi/commands/:id`, `.../cancel` | command id | owned command (no message text echoed); cancel only queued rows | Territory 07 |
| GET | `/api/v2/spenders*`, `/api/v2/fans/search` | list/detail/batch query | spender/fan metrics (service scopes by `principal.assignedPageIds`) | Territory 09 |

Note: `/api/v1/ai-usage/batch` calls only `requirePrincipal` in the handler; the api-key requirement is enforced *inside* `ingestAiUsageBatch` (`ai-usage.ts:79`) — net behavior matches the bearer-only contract. `/api/v2/spenders*` and `/api/v2/fans/search` are reachable by both session and api-key principals.

**Dashboard SPA (session cookie, `credentials:include`, no auth header, no CSRF).** Everything gated `dashboard` or `owner`: `/overview*`, `/pages/:label/{revenue,transactions,subscribers,followers,fans,spender-autolists,workboard,conversations}`, `/models*`, `/sync/*`, and the entire `/admin/*` surface (users, api-keys, config/flags, notifications/Telegram, OFAPI webhook/credits/spend, sync runs, connections, credentials verify/rotate, diagnostics). The SPA is served same-origin from `apps/dashboard/dist` by `@fastify/static` (`server.ts:3572`) with SPA fallback to `index.html`. The dashboard uses **no SSE/WebSocket** — all "live" data is React Query polling (Territory 16). There are **no `/dev` routes** in the server; the only non-`/api` surfaces are owner-gated `/documentation*` and the SPA fallback.

### 1.3 Rate-limited inbound routes

Global rate limiting is off; only these opt in (`@fastify/rate-limit`, `global:false`):

| Route | max / window | Key |
|---|---|---|
| `POST /api/v1/auth/login` | 20 / 60 s | per-IP (plus per-account in-memory escalating backoff in `auth.ts`) |
| `POST /api/v1/ofapi/webhook` | `ofapiWebhookRateLimitMax ?? 1000` / `ofapiWebhookRateLimitWindowSeconds ?? 60` s | per-IP |
| `GET /api/v1/ofapi/read/*` | 120 / 60 s | per-principal |
| `POST /api/v1/ofapi/commands` | 60 / 60 s | per-principal |

### 1.4 Inbound HTTP that triggers live outbound calls

These owner-only routes cross a second boundary synchronously (detailed in §3–§6): `POST /admin/credentials/verify` and `POST /admin/pages` (onboard) and `POST /admin/pages/:label/verify` call Fansly/OnlyMonster/OFAPI through a page proxy; `POST /admin/proxy/test` fetches `api.ipify.org`; `/admin/notifications/*` call Telegram; `POST /admin/ofapi/webhook` registers the webhook at OFAPI. `GET /api/v1/health/sync` accepts either a dashboard session or the `x-monitoring-token` (constant-time compare); the token path skips page scoping.

---

## 2. INBOUND — OFAPI webhooks

The single inbound webhook boundary. Counterpart: **onlyfansapi.com** (OFAPI vendor), which delivers OnlyFans platform events.

| Field | Value |
|---|---|
| Route | `POST /api/v1/ofapi/webhook` (`server.ts:1282-1311`, isolated plugin scope) |
| Body parser | **buffer-mode** (`addContentTypeParser("application/json", {parseAs:"buffer"})`) — the repo's only raw-body parser, so HMAC is over the exact bytes |
| Envelope | `{event: string, account_id?: string, payload: object}` |
| Auth | HMAC-SHA256, **hex** digest in the `signature` header, computed over the raw request bytes, compared with `timingSafeEqual` against the current signing secret **and** the previous secret (rotation grace) (`ofapi-webhooks.ts:74-139`) |
| Dedup | `x-ofapi-idempotency-key` header (required, ≤255 chars); `insertOfapiWebhookEvent` does `ON CONFLICT(idempotency_key) DO NOTHING` (`ofapi-webhooks.ts:141-173`) |
| Validation order | signature check FIRST, then `JSON.parse`, then Zod `ofapiWebhookEnvelopeSchema` (`ofapi-webhooks.ts:153`) — the body is deliberately not Zod-validated *before* the signature check |
| Side effects | journals a row into `ofapi_webhook_events` (raw payload + `event_type` + `ofapi_account_id` + `projection_status` pending/none) then enqueues pg-boss `ofapi.events.process.v2` `{eventId}` (`sendOfapiEventProcessJob`, `ofapi-webhooks.ts:182`); if `boss` is null, the minutely sweep will pick it up |
| Ack | `200 {received:true, duplicate:bool}` returned within OFAPI's 15 s delivery timeout |
| Failure codes | 503 (webhook not registered), 401 (bad/missing/non-hex signature), 400 (missing idempotency key / non-JSON / not an envelope), 429 (rate limit) |

**Subscribed event set** (`OFAPI_WEBHOOK_EVENTS`, 17 types, `ofapi-webhooks.ts:40-58`): `messages.received`, `messages.sent`, `messages.deleted`, `messages.ppv.unlocked`, `tips.received`, `transactions.new`, `subscriptions.new`, `subscriptions.renewed`, `users.typing`, `users.online`, `users.offline`, `accounts.connected`, `accounts.reconnected`, `accounts.session_expired`, `accounts.authentication_failed`, `accounts.otp_code_required`, `accounts.face_otp_required`. The worker maps a subset to SSE `SyncEvent` frames; `transactions.new` and analytics/unknown types are journaled-only (no SSE fanout) but still drive credit accrual and spend projection.

---

## 3. OUTBOUND — OFAPI REST (onlyfansapi.com)

All OFAPI HTTP goes through the single client `createOfapiClient` (`apps/runtime/src/services/ofapi.ts`), built only when `OFAPI_API_KEY` is set (`app.ofapi` is otherwise `undefined`). Auth = `Authorization: Bearer <OFAPI_API_KEY>` to `OFAPI_BASE_URL` (default `https://app.onlyfansapi.com/api`). Read calls: 15 s timeout, 3 observed retries, 500 ms client-global pacing (`ofapi.ts:17-27`). Every response carries `_meta._credits.{used,balance}`, `_cache.is_cached`, `_rate_limits.remaining_minute`; the client's `onCreditSpend` sink writes one `ofapi_credit_ledger` row per billed response (including retries and errors that carry `_meta`).

### 3.1 Read gateway calls (what core fetches)

| Direction | Method + path | Params | Data out (fields consumed) | Caller | Anchor |
|---|---|---|---|---|---|
| out | `GET /{acct}/chats` | `limit, offset, order, pageIndex` | chat heads: fan `id/username/name`, `unreadMessagesCount`, `lastMessage{id,createdAt,isSentByMe,text}` | DM sync bootstrap/reconcile, read gateway | `ofapi.ts:170` |
| out | `GET /{acct}/chats/{chatId}/messages` | `limit, firstId (inclusive cursor), pageIndex` | message objects: `id, text, createdAt, isSentByMe, price, isTip, replyToMessage` | DM message backfill | `ofapi.ts:180` |
| out | `GET /{acct}/fans/active` | `limit (clamped ≤20), offset, pageIndex` | active fans: `id, subscribedOnData{price,regularPrice,subscribeAt,renewedAt,expiredAt,status}, subscribePrice, lastSeen` | audience/subscriber sweep | `ofapi.ts:195` |
| out | `GET /{acct}/transactions` | `limit, startDate, marker, pageIndex` | paginated transaction history | REST transaction backfill (CLI, OFAPI-only OnlyFans pages, ≤1000 pages) | `ofapi.ts:204` |
| out | `GET /accounts` | — | `OfapiAccountRecord[]` `{id, username, displayName, onlyfansName, onlyfansUserId, avatarUrl}` (no `_meta`) | webhook registration mapping, OnlyFans metadata backfill fallback | `ofapi.ts:169` |
| out | `pingBalance` → `GET /{acct}/chats?limit=1` | — | minimal chats page; balance read from `_meta` (1-credit reconciliation anchor on idle days) | credit balance-ping job | `ofapi.ts:217` |
| out | `proxyRead` → allowlisted `GET` | validated pathname + query | raw `{status, body, headers}` relayed to desktop; single attempt, 60 s timeout, **through the page's proxy dispatcher** | desktop read gateway `/api/v1/ofapi/read/*` | `ofapi.ts:221` |

`proxyRead` is the ONLY OFAPI read that uses `context.dispatcher` (the page egress proxy); the sync DM/audience reads and the command executor pass no dispatcher, so those calls egress directly from the hub VPS (Territory 07 discrepancy #1).

### 3.2 Command-executor calls (what core WRITES back to the platform)

Dispatched by the pg-boss `ofapi.commands.execute` worker (`ofapi-command-executor.ts`), exactly one attempt each (`retryLimit:0`); context passes only `{pageId}` (no proxy dispatcher). Gated by `ofapiDesktopCommandExecutionEnabled`.

| Kind | Method + path | Body sent to platform | Returns | Anchor |
|---|---|---|---|---|
| send_text | `POST /{acct}/chats/{conv}/messages` | `{text}` | platform message id | `ofapi.ts:233` |
| send_media | `POST /{acct}/chats/{conv}/messages` | `{text, price, mediaFiles[], previews[]}` | platform message id | `ofapi.ts:241` |
| typing | `POST /{acct}/chats/{conv}/typing` | empty | `{success:true}` (documented free; 0 credits if no `_meta`) | `ofapi.ts:249` |
| unsend | `DELETE /{acct}/chats/{conv}/messages/{msg}` | empty (only `messageId` in path) | `{success:true}` | `ofapi.ts:256` |
| mark_read | `POST /{acct}/chats/{conv}/mark-as-read` | empty | `{success:true}` | `ofapi.ts:264` |

### 3.3 Webhook CRUD (admin/outbound to OFAPI)

| Direction | Method + path | Body | Returns | Anchor |
|---|---|---|---|---|
| out | `POST /webhooks` / `PUT /webhooks/{id}` | `{endpoint_url, signing_secret (randomToken(32)), events[17 types], account_scope:"global"}` | `{id}` — the external webhook id | `ofapi.ts:167/168`, `ofapi-webhooks.ts:264-328` |

Registration (`POST /api/v1/admin/ofapi/webhook`, owner) generates a fresh 32-byte signing secret, registers/updates at OFAPI, encrypts the new secret + retains the previous one (rotation grace) in `ofapi_webhook_config`, then calls `GET /accounts` and auto-maps accounts→pages by **unambiguous** username match (`ofapi-webhooks.ts:210-262`).

---

## 4. OUTBOUND — Fansly / OnlyFans (adapters + proxies)

Two hand-mirrored adapter classes (no shared interface) plus one anonymous scraper. All adapter methods are GET-only (read ingestion); **no code writes to Fansly or OnlyMonster**. Constructed once per `AppContext` from boot config base URLs. Each request egresses through the page's optional proxy dispatcher and is paced by the shared DB-backed rate-limit waiter (`sync_rate_limits`, when `syncSharedRateLimitEnabled`).

| Counterpart | Base URL (default) | Auth | Key endpoints & data | Anchor |
|---|---|---|---|---|
| **OnlyMonster aggregator** (`OnlyFansAdapter`, `app.onlyFansAdapter`) | `https://omapi.onlymonster.ai` | header `x-om-auth-token = <page OnlyMonster token>` | `GET /api/v0/accounts`, `accounts/:id`, `platforms/onlyfans/accounts/:pid/{transactions,chargebacks,tracking-link-users,trial-link-users}`, `accounts/:id/fans`, `accounts/:id/chats/:chatId/messages`. Money in **dollars**; time bounds ISO | Territory 08 §2 |
| **Fansly private API** (`FanslyAdapter`, `app.adapter`) | `https://apiv3.fansly.com/api/v1` | headers `authorization` + `fansly-client-ts/-client-id/-client-check/-session-id` (page browser session); every request adds `ngsw-bypass=true` | `GET /account/me`, `/account` (ids ≤100), `/account/wallets/earnings/transactions`, `/account/wallets/earnings/accounts`, `/subscribers` (status 3,4), `/account/:id/followersnew`, `/messaging/groups`, `/group/:id`, `/message`. Envelope `{success, response, error}`; time bounds **ms-epoch**; money **integer units** | Territory 08 §3 |
| **OnlyFans.com public profile** | `onlyfans.com` (headless Playwright Chromium) | **anonymous** (empty storageState, spoofed Chrome UA) | navigate `onlyfans.com/u<id>`, read XHR `/api2/v2/users/u<id>` → `{id, username(handle), name(displayName)}` | Territory 08 §4 |
| **OFAPI listAccounts** (fallback) | `https://app.onlyfansapi.com/api` | Bearer `OFAPI_API_KEY` | `app.ofapi.listAccounts()` — OnlyFans metadata backfill when OnlyMonster creds unavailable | Territory 08; §3 above |
| **api.ipify.org** | `https://api.ipify.org?format=json` | none (through candidate proxy) | egress `{ip}` — `POST /admin/proxy/test`; CLI egress-IP probe | Territory 08 §10 |

Naming caveat (Territory 08 §0): the `@agency_hub_core/onlyfans` package / `OnlyFansAdapter` / `app.onlyFansAdapter` do **not** talk to OnlyFans.com — they talk to the third-party OnlyMonster aggregator. `app.adapter` (unqualified) is the **Fansly** adapter. The only direct OnlyFans.com contact is the anonymous Playwright resolver. Proxy targets are SSRF-guarded (`assertProxyTargetAllowed` rejects localhost/private/loopback/link-local/CGNAT/ambiguous hosts) and error text runs through `redactSensitiveText` (Territory 15).

---

## 5. OUTBOUND — Anthropic AI provider

Two independent subsystems reach Anthropic; both use `ANTHROPIC_API_KEY` and egress through a page proxy dispatcher, but they are separate code paths (not one shared client).

### 5.1 AI gateway — `POST /api/v1/ai/gateway/stream`

Built only when `chatMuseAiGatewayEnabled` (env `CHATMUSE_AI_GATEWAY_ENABLED`) AND `ANTHROPIC_API_KEY` are set; else the route returns 503. `appContext.aiGatewayProvider.provider` is typed `"anthropic" | "openrouter"` but only Anthropic is implemented; recorded provider is always `anthropic` (Territory 10 #4).

| Field | Value |
|---|---|
| Transport | `@anthropic-ai/sdk` `client.messages.create(body, {signal})`, `POST /v1/messages`, `stream:true` (`ai-gateway-anthropic-provider.ts:112-215`) |
| Egress | via `createProxyRequestDispatcher(page.proxy)` — **throws if the page has no proxy** (`ai-gateway-anthropic-provider.ts:129-131`) |
| Auth | `new Anthropic({apiKey: ANTHROPIC_API_KEY})` |
| Request (`buildAnthropicGatewayStreamRequest`, `ai-gateway-anthropic.ts:189-210`) | `{model (bare providerModelId), stream:true, max_tokens, system: text blocks with cache_control {type:ephemeral, ttl:1h}, messages:[{role:user, content: text blocks with cache_control {type:ephemeral} (5m)}], temperature?, thinking?{type:adaptive, display:summarized}, output_config?{effort}}` |
| Response (SSE consumed) | `message_start` (→ providerResponseId, initial usage), `content_block_delta` (`text_delta` → content, `thinking_delta` → reasoning), `message_delta` (→ `stop_reason`, `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation.ephemeral_5m/1h}`) |
| Cost | `estimateAiGatewayUsageCost(model, usage)` → **micro-USD** (1e-6 USD, NOT mills); written to `ai_usage_events.cost_micro_usd` in a terminal ledger row |

The client-supplied `model` string is used verbatim as the pricing-table key (e.g. `anthropic:claude-sonnet-4-6`); the bare `providerModelId` is sent to the SDK. `platformUserId` is required by the contract but never read/sent/stored (Territory 10 #1).

### 5.2 Workboard closing classifier (L2) — direct, NOT the gateway

The nightly closing classifier constructs `new Anthropic({apiKey})` directly (`closing-classifier.ts:143`, Territory 11), NOT through `aiGatewayProvider`. Request: model (default Haiku via `WB_CLOSING_LLM_MODEL`), `max_tokens:1536`, `temperature:0`, strict system prompt, user turn = JSON `[{id, messages:[{role,text≤500}]}]` up to 15 threads. Response: JSON `[{id, state, needs_reply, reason≤160}]` + usage tokens. Skipped entirely without `ANTHROPIC_API_KEY`. The two subsystems only share the `ANTHROPIC_API_KEY` secret.

---

## 6. OUTBOUND — Telegram Bot API

Counterpart: `https://api.telegram.org/bot<token>/<method>` (`telegram.ts:46`). Credentials: bot token + chat id resolved per-field, DB (`telegram_settings`, encrypted at rest) overriding env `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Optional egress through a named page's proxy when `telegramProxyPageLabel` is set. A DB token that fails to decrypt silently falls back to the env token (Territory 12 #4).

| Direction | Method + endpoint | Payload | Response consumed | Purpose | Anchor |
|---|---|---|---|---|---|
| out | `POST /sendMessage` | JSON `{chat_id, text, parse_mode:"HTML"?, disable_web_page_preview:true}` | `{ok, result.message_id, description}` | incident open/resolve alerts, manual-resolve notice, plain-text revenue report fallback; 10 s timeout, ≤3 attempts, retry on 429/5xx honoring Retry-After | `telegram.ts:373` |
| out | `POST /sendPhoto` | multipart `{chat_id, caption?(HTML), parse_mode?, photo=PNG blob "report.png"}` | `{ok, result.message_id}` | rendered daily revenue report image (Playwright chromium); 30 s timeout | `telegram.ts:500` |
| out | `GET /getMe` | none | `result.username` | validate token in chat discovery | `telegram.ts:183` |
| out | `GET /getUpdates` | none (no offset — non-consuming peek) | updates → distinct chats `{id,type,title}` | interactive chat discovery (`POST /admin/notifications/discover-chats`); never a webhook | `telegram.ts:199` |

Every real send writes a `telegram_delivery_attempts` row `{kind, status(sent/failed/skipped), notification_incident_id?, report_date?, message_id?, error?}`. Bot token is redacted from all logs (`bot[REDACTED]` on `api.telegram.org` paths). `parse_mode:"MarkdownV2"` exists in the type union but is never used; incident messages send with no `parse_mode`.

---

## 7. STORAGE — Postgres (the durable shared-state boundary)

One `pg.Pool` on `DATABASE_URL` + Drizzle (`packages/db/src/client.ts`; no SSL/tuning, global `setTypeParser(20)` → all bigints as JS `BigInt`). 61 tables, 25 enums (Territory 04). Every process (api, worker, cli) reads/writes the same schema. Migrations are hand-written `NNNN_name.sql` applied one-transaction-each under `pg_advisory_lock(31415,27182)` at startup (Territory 05). The table groups that constitute the cross-process contract:

| Table group | Representative tables | Direction / role | Territory 04 ref |
|---|---|---|---|
| Identity & credentials | `models`, `pages`, `page_credentials` (encrypted session, `key_version`), `egress_endpoints` (proxy url + `encrypted_auth`) | core-owned; `pages.id` is FK target for ~40 tables | §2 |
| Auth & access | `users` (argon2id `password_hash`), `auth_sessions` (`token_digest`), `api_keys` (`key_prefix`+`token_digest`), `user_page_assignments`, `audit_events` | write on login/admin; read per request | §10 |
| Sync engine state | `sync_runs`, `sync_http_attempts`, `sync_run_events`, `page_sync_states` (lease FSM), `page_sync_cursors`, `sync_rate_limits`, `sync_raw_payloads` (retain_until TTL) | worker read/write; dashboard read | §4 |
| Fans & audience | `fans`, `page_fans`, fan aliases/notes/profiles/flags/summaries, `page_follows`, `page_subscriptions` | sync/projection write; dashboard+desktop read | §5, §6 |
| DM projection | `page_dm_threads`, `page_dm_messages` (tips in **cents**), `dm_message_archive` (mills; source provenance), `dm_message_daily_aggregates` | webhook+REST write; snapshot read | §7 |
| Transactions & revenue | `transactions` (canonical, mills), `revenue_daily`, `fan_spend_daily`, `fan_spend_lifetime`, `page_fan_identities`, `daily_followers/subscribers`, `projection_watermarks` | ingest write; reporting read | §9 |
| OFAPI webhook/credit | `ofapi_webhook_events` (journal, `fanout_seq`), `ofapi_commands` (outbox), `ofapi_webhook_config` (encrypted signing secret + previous), `ofapi_credit_ledger`, `ofapi_credit_state`, `ofapi_spend_projection_events` | §2, §3, §9 above write | §8, §13 |
| AI usage & workboard | `ai_usage_events` (cost **micro-USD**), `wb_llm_usage_daily`, `wb_closing_cache/settings`, `wb_classifier_runs`, `workboard_state`, `workboard_contact_log`, `workboard_snoozes` | gateway/classifier/recompute write; dashboard read | §11, §12 |
| Notifications | `notification_incidents`, `notification_incident_recoveries`, `telegram_settings` (encrypted bot token), `telegram_delivery_attempts` | detectors write; Telegram send logs | §3 |
| Runtime & config | `runtime_instances` (heartbeat RunningSnapshot), `config_settings` (override overlay), `config_audit_log` | every process heartbeats; owner config PATCH writes | §14 |

**Secrets at rest** (AES-256-GCM `EncryptedEnvelope`, keys from `APP_ENCRYPTION_KEY[_RING/_VERSION]`, Territory 15 §2): `page_credentials.encrypted_session` (Fansly session bundle or OnlyMonster token), `egress_endpoints.encrypted_auth` (proxy creds), `ofapi_webhook_config.encrypted_signing_secret` (+previous), `telegram_settings.encrypted_bot_token`. Only ciphertext/digests persist; plaintext exists only in-memory in request contexts.

Four `/admin/*` diagnostics routes bypass the db package and run hand-written `sql` against `sync_run_events`/`sync_runs`/`pages`, `pgboss.job`, `pg_stat_user_tables`/`schema_migrations`, `notification_incidents` (Territory 02 §4.10).

---

## 8. QUEUE — pg-boss jobs (internal-but-durable boundary)

pg-boss runs on the same `DATABASE_URL` (schema `pgboss`). The **worker** process registers all consumers; the **API** and **CLI** processes start their own PgBoss for **enqueue only** (API: `server.ts:1259-1276`, logs on error; worker error handler `process.exit(1)`). Complete queue catalog:

| Queue | Schedule (cron / tz) | Payload | Policy / notes | Consumer | Anchor |
|---|---|---|---|---|---|
| `sync.planner` | `* * * * *` (no tz pinned) | none | standard; advances `page_sync_states`, enqueues wakeups | worker `boss.work` | `sync-queue.ts:111` |
| `sync.planner.dlq` | — | — | dead-letter | — | `sync-queue.ts:63` |
| `sync.page.execute` | on-demand (wakeup) | `{platformAccountId:number}` | `singletonKey=String(platformAccountId)`; `group.id=buildSyncPageExecuteGroupId(provider,egressKey)`, groupConcurrency 1; **consumed via hand-rolled `boss.fetch` loop**, not `boss.work` | worker `startSyncPageExecutor` | `sync-queue.ts:174` |
| `sync.page.execute.dlq` | — | — | dead-letter | — | `sync-queue.ts:67` |
| `fansly.raw-payload-cleanup` | `0 2 * * *` (no tz pinned) | none | deletes expired `sync_raw_payloads` + observability rows (both platforms despite "fansly" name) | worker | `worker-services.ts:141` |
| `telegram.daily-report` | `0 * * * *` **UTC (hourly)** | none | self-gates on report hour + report-date dedup; `retryLimit 2`; name says "daily" but fires hourly (Territory 12 #1) | worker | `sync-queue.ts:121` |
| `workboard.recompute` | `0 3 * * *` UTC | none | standard, `retryLimit 1`; recompute all pages | worker | `sync-queue.ts:152` |
| `workboard.classify-closing` | `0 1 * * *` UTC | none | standard, `retryLimit 1`; L2 Anthropic classifier; skipped without `ANTHROPIC_API_KEY` | worker | `sync-queue.ts:151` |
| `ofapi.events.process.v2` | on-demand (receiver + sweep) | `{eventId:number}` | `policy:exclusive`, `singletonKey=String(eventId)`, `batchSize 100`; **single-replica worker** (asserts `OFAPI_EVENT_WORKER_REPLICAS===1` + advisory lock `(58211,1)`); settle-orders the batch by eventId | worker | `ofapi-events.ts:227/262` |
| `ofapi.events.sweep` | `* * * * *` UTC | none | exclusive; re-enqueue stuck-pending rows + run projections | worker | `ofapi-events.ts:251` |
| `ofapi.events.cleanup` | `30 2 * * *` UTC | none | standard; prune journal beyond `ofapiEventRetentionDays` (~7d) | worker | `ofapi-events.ts:252` |
| `ofapi.credits.balance-ping` | `5 0 * * *` UTC | none | exclusive; 1-credit balance anchor | worker | `ofapi-credits.ts:431` |
| `ofapi.credits.accrual` | `40 0 * * *` UTC | none | exclusive; webhook credit accrual `ceil(events/100)` | worker | `ofapi-credits.ts:432` |
| `ofapi.credits.reconcile` | `5 * * * *` UTC (hourly) | none | exclusive; reconcile ledger vs server balance | worker | `ofapi-credits.ts:433` |
| `ofapi.commands.execute` | on-demand (command intake) | `{commandId:string}` | `policy:standard`, `retryLimit 0` (exactly one platform write attempt), `singletonKey=commandId` | worker | `ofapi-command-executor.ts:99/120` |
| `ofapi.commands.sweep` | `* * * * *` UTC | none | exclusive; recover stale in-flight, terminal payload redaction | worker | `ofapi-command-executor.ts:113` |
| `ofapi.dm-analytics.rebuild` | `10 * * * *` UTC | none | standard; unconditional (not flag-gated) rebuild of 32-day aggregate window | worker | `ofapi-dm-analytics.ts:49` |

Enqueue sites in the API process: `/admin/sync/trigger(+all)`, `/admin/sync/blocks/{trigger,resume,reset}`, `/admin/pages` onboarding, `/ofapi/commands` (execute), and the webhook receiver.

---

## 9. STREAMING — SSE out to clients

Three independent SSE surfaces, all hijacking the raw socket (bypass the Zod serializer). Detailed in Territory 14; the dashboard uses none of them.

### 9.1 `GET /api/v1/events/stream` — OFAPI sync fanout

| Field | Value |
|---|---|
| Counterpart | desktop chat app `EventSource` (chatter API-key, bearer) |
| Wire | `text/event-stream`, frames `id: <fanout_seq>\nevent: sync\ndata: <JSON SyncEvent>\n\n`, preceded by `retry: 3000`, `: keep-alive` comments |
| SyncEvent union | `messageReceived`, `messageSent`, `messageDeleted`, `ppvUnlocked`, `tipReceived`, `chatListUpdated`, `presence`, `typing`, `accountAuthChanged` |
| Filtering | frames filtered to `principal.assignedPageIds` |
| Resume | `Last-Event-ID` header or `?lastEventId`; strict `> cursor`; journal replay 500 rows/page, deduped by a monotonic-seq guard |
| Gap 409 | `{error:"sync_snapshot_required", statusCode:409, requestedSeq, oldestAvailableSeq, currentSeq, snapshotPath:"/api/v1/events/snapshot"}` when the cursor is outside the retained ~7-day window |
| Lifecycle | 25 s heartbeat, auth re-validation every 60 s (closes on revocation or page-assignment change), hard 15 min max lifetime, >1 MB buffered → dropped |
| Source | in-process hub `createSyncEventHub` (`events-stream.ts`) that LISTENs on Postgres channel `ofapi_sync_events` and drains the journal in `fanout_seq` order; the actual byte-writing lives in `server.ts:1346-1540` |

`presence`/`typing` frames DO get `fanout_seq` and ARE SSE-replayable; they are only excluded from the snapshot endpoint (Territory 14 #3).

### 9.2 `POST /api/v1/ai/gateway/stream` — AI generation relay

Request-scoped `event: ai` frames (`meta`, `content_delta`, `reasoning_delta`, `usage`, `error`, `done`) relaying one Anthropic generation (§5.1). Separate transport from the sync stream — no hub, journal, replay, or heartbeat. `meta` frame carries `{requestId, clientRequestId, feature, pageLabel, model, provider, quota{accepted, remainingRequestsToday, remainingMicroUsdToday}}`; `usage` frame carries the 6 usage fields + `providerResponseId` + `cacheHit`; a terminal usage+cost `ai_usage_events` row is written in `finally`.

### 9.3 `GET /api/v1/admin/ofapi/credits/ledger.csv` — hijacked CSV

Owner. Hijacked `text/csv` download with `Content-Disposition: attachment`, `x-export-row-count`, `x-export-truncated` (≤50k rows); the CSV is built before hijack so a bad filter still returns a normal 400.

**Internal streaming primitive (not a client boundary):** the worker fires `pg_notify('ofapi_sync_events', <journal row id>)` inside the settle transaction (`ofapi-events.ts:341`); the API hub consumes the channel to drain the journal. The payload (row id) is deliberately ignored — delivery is a serialized forward drain in `fanout_seq` order.

---

## 10. SECRETS / CONFIG — how credentials and flags enter the system

Config is loaded by `loadConfig` from plain `dotenv` (`packages/shared/src/config.ts` — **no `DOTENV_KEY`/dotenvx encrypted-env layer exists**, contrary to some briefs; only `DOTENV_CONFIG_QUIET` is read). Two override axes exist on top of env: live overlay (`config_settings`) and staged boot flags (Territory 13).

### 10.1 Secrets entering via env (all `editability:never`, masked set/unset in the config view)

| Env var | Purpose | Boundary it feeds |
|---|---|---|
| `DATABASE_URL` | Postgres connection | §7, §8 |
| `APP_ENCRYPTION_KEY` (+`_RING`, +`_VERSION`) | 32-byte AES-GCM key(s) for at-rest envelopes | §4, §6, §7 secrets |
| `OFAPI_API_KEY` | Bearer for OFAPI REST | §3 (client built only if set) |
| `ANTHROPIC_API_KEY` | Anthropic auth | §5 (gateway + classifier built/run only if set) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram (DB `telegram_settings` overrides these) | §6 |
| `HEALTH_SYNC_MONITORING_TOKEN` | monitoring-token bypass for `/health/sync` | §1.1 |

Platform session credentials (Fansly session, OnlyMonster token) and proxy creds do NOT enter via env — they are submitted through owner admin routes (`/admin/credentials/verify`, `PATCH /admin/pages/:label/credentials`, `/admin/pages` onboarding), AES-encrypted, and stored in `page_credentials`/`egress_endpoints`. The OFAPI webhook signing secret is generated in-process (`randomToken(32)`) at registration and stored encrypted.

### 10.2 Feature flags entering the system

Base URLs (`FANSLY_BASE_URL`, `ONLYMONSTER_BASE_URL`, `OFAPI_BASE_URL`) and behavioral knobs come from env with registry defaults (`config-registry.ts`). The boundary-gating flags (all default **off** unless noted) — env name → effect:

- `CHATMUSE_AI_GATEWAY_ENABLED` (+ per-day/per-request micro-USD & request limits) → gates §5.1.
- `OFAPI_DESKTOP_READ_GATEWAY_ENABLED` + `OFAPI_CREDIT_LEDGER_ENABLED` → gate `/ofapi/read/*` (§3.1 proxyRead).
- `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` / `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED` → gate command intake / execution (§3.2).
- `OFAPI_DM_SYNC_ENABLED`, `OFAPI_DM_PROJECTION_ENABLED`, `OFAPI_DM_COLD_ARCHIVE_ENABLED`, `OFAPI_AUDIENCE_SYNC_ENABLED`, `OFAPI_PRESENCE_PROJECTION_ENABLED`, `OFAPI_SPEND_PROJECTION_SHADOW_ENABLED`, `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED`, `OFAPI_ACCOUNT_HEALTH_ENABLED`, `OFAPI_BALANCE_PING_ENABLED` → gate OFAPI projections/credit machinery.
- `OFAPI_EVENT_WORKER_REPLICAS` (must be 1) → §8 single-replica invariant.
- `WB_CLOSING_LLM_ENABLED` / `WB_CLOSING_LLM_MODEL` (default Haiku) → §5.2 classifier.
- `SYNC_SHARED_RATE_LIMIT_ENABLED` → §4 shared rate-limit waiter.
- `TELEGRAM_PROXY_PAGE_LABEL` → §6 proxy egress; `TELEGRAM_REPORT_HOUR` → report scheduling.

Live-editable (`editability:editable`, `runtimeApply:"live"`) keys are patched via `PATCH /admin/config` with optimistic `expectedVersion`; staged boot flags via `PATCH /admin/config/staged` (advisory-locked, takes effect on restart). Secrets are never editable and are masked as set/unset in the config view.

---

## 11. Cross-cutting notes for the reviewer

- **OFAPI is the pivot.** It is simultaneously an inbound webhook source (§2), an outbound read client (§3.1), an outbound platform-write executor (§3.2), and a billed metering counterpart (each REST response writes a credit-ledger row). Everything OFAPI is behind default-off flags.
- **Money units differ per boundary.** Canonical `transactions` and cold `dm_message_archive` use **mills** ($0.001); hot `page_dm_messages` tips use **cents**; AI usage `cost_micro_usd` and OFAPI credit pricing use **micro-USD** (1e-6 USD); the `/events/snapshot` payload emits **USD dollars**; Fansly upstream sends integer units, OnlyMonster sends dollars.
- **The desktop app never talks to OnlyFans/OFAPI directly** — it goes through core's custody gateway (`/ofapi/read/*`, `/ofapi/commands`, `/events/stream`, `/events/snapshot`). The dashboard talks only to core over same-origin cookie-authed HTTP with no streaming.
- **Egress proxying is per-page.** Fansly, OnlyMonster, OFAPI `proxyRead`, Anthropic (both paths), and optionally Telegram all route through the page's stored proxy dispatcher; OFAPI sync reads and command writes are the exceptions that egress directly from the hub.
- **No DOTENV_KEY / encrypted-env layer** exists; at-rest secret encryption is AES-256-GCM via `APP_ENCRYPTION_KEY`, applied only to the four credential columns in §7.
