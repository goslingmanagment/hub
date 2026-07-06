> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 10 — AI Gateway & Usage Ledger

**Scope.** This document covers the ChatMuse AI gateway (a streaming proxy from external clients through `core` to the Anthropic API) and the AI usage ledger. Files read in full: `apps/runtime/src/services/ai-gateway.ts`, `apps/runtime/src/services/ai-gateway-anthropic.ts`, `apps/runtime/src/services/ai-gateway-anthropic-provider.ts`, `apps/runtime/src/services/ai-gateway-pricing.ts`, `apps/runtime/src/services/ai-usage.ts`, `packages/db/src/repositories/ai-usage.ts`. Boundary tracing also reads: the route registrations and SSE handler in `apps/runtime/src/api/server.ts` (`/api/v1/ai/gateway/stream`, `/api/v1/ai-usage/batch`, `/api/v1/admin/usage/chatters`), the Zod contracts in `packages/contracts/src/routes.ts`, the `ai_usage_events` table in `packages/db/src/schema.ts` and migrations `0003_ai_usage_events.sql` / `0004_ai_usage_feature_scan.sql` / `0040_ai_gateway_usage_ledger.sql`, the provider wiring in `apps/runtime/src/bootstrap.ts`, auth in `apps/runtime/src/services/auth.ts`, proxy resolution in `apps/runtime/src/services/page-context.ts`, config in `packages/shared/src/config.ts` / `config-registry.ts`, and the dashboard `apps/dashboard/src/pages/UsagePage.tsx`. Cross-references: territory 02 (routes/contracts), territory 13 (auth/API keys).

---

## 1. Two subsystems sharing one table

This territory contains two distinct data paths that both persist to the single Postgres table **`ai_usage_events`**:

1. **Client-reported usage batches** — external chat clients run their own AI calls (against provider keys they hold locally), then POST already-computed token counts to `POST /api/v1/ai-usage/batch`. These rows carry token counts but **no cost and no page scope** (see §7). This path is always active.

2. **The AI gateway** — external clients send a prompt to `POST /api/v1/ai/gateway/stream`; `core` executes the Anthropic call on their behalf (using `core`'s own `ANTHROPIC_API_KEY`), streams the result back as SSE, and writes a reserve→finalize ledger row that DOES carry provider, page, cost, and outcome. This path is **default-off**, gated by the `chatMuseAiGatewayEnabled` flag AND the presence of `anthropicApiKey` (`apps/runtime/src/bootstrap.ts:179-183`).

A row is distinguishable as a **gateway** row (versus a batch row) by the predicate `provider IS NOT NULL OR gateway_outcome IS NOT NULL OR quota_accepted IS NOT NULL` (`packages/db/src/repositories/ai-usage.ts:333-337, 386-390`). Batch rows leave all three NULL.

---

## 2. Inbound boundary — `POST /api/v1/ai/gateway/stream`

**Counterpart:** external client apps (the desktop chat workspace / browser extension), authenticated as a chatter API key. **Direction:** inbound HTTP request → SSE response stream.

### 2.1 Auth
Route handler `apps/runtime/src/api/server.ts:701-706`: resolves a principal via `requirePrincipal`, then `requireApiKeyUser(principal)` — **bearer API-key only**, no cookie session. API keys resolve only to users whose role is `chatter` (`authenticateApiKeyToken` → `roleCanUseApiKey`, `apps/runtime/src/services/auth.ts:682, 89-91`). Contract security is `bearerOnlySecurity` (`packages/contracts/src/routes.ts:3782`). The Authorization header must be `Bearer <token>`; the token is SHA-256-digested and matched against stored API-key digests (`auth.ts:675-693`). There is **no per-client-app identity** — desktop app and extension both present the same chatter's API key; the only client-supplied idempotency identifier is `clientRequestId`.

### 2.2 Request body (`aiGatewayStreamBodySchema`, `packages/contracts/src/routes.ts:1788-1804`, `.strict()`)

| Field | Type / constraint | Use |
|---|---|---|
| `clientRequestId` | `uuid` | Idempotency key; becomes `client_event_id` in the ledger reservation. |
| `feature` | enum `AiUsageFeature` | Selects per-feature max-tokens/temperature (§4). |
| `pageLabel` | string 1–120 | Resolves the creator page (proxy + access check). |
| `platform` | `fansly`\|`onlyfans` | Must equal the stored page's platform. |
| `platformUserId` | string 1–255 | **Accepted but never read** server-side (see §10). |
| `conversationId` | string 1–255, nullable/optional | Stored on the reservation row. |
| `model` | string 1–100 | Pricing-table key, e.g. `anthropic:claude-sonnet-4-6` (§3.2). |
| `reasoningEffort` | enum `off`\|`low`\|`medium`\|`high`\|`max` | Drives adaptive-thinking config (§4). |
| `temperature` | number 0–2, optional | Overrides the per-feature default. |
| `maxTokens` | int 1–100000, optional | Overrides the computed `max_tokens`. |
| `isRegeneration` | boolean | Stored on the reservation; feeds regen-rate stats. |
| `prompt.systemBlocks` | 1–64 blocks | Anthropic `system` blocks. |
| `prompt.userBlocks` | 1–64 blocks | Anthropic single user-message content. |

Each **prompt block** (`aiGatewayPromptBlockSchema`, routes.ts:1783-1786, `.strict()`): `{ text: string 1–100000, cache: "1h"|"5m"|"none" }`.

### 2.3 Preflight (`prepareAiGatewayStream`, `apps/runtime/src/services/ai-gateway.ts:128-269`)
Sequential gates, each throwing a typed error mapped to an HTTP status:
1. Flag off → `ServiceUnavailableError` (503) if `chatMuseAiGatewayEnabled !== true` (`ai-gateway.ts:133`).
2. `findPageByLabel(pageLabel)`; if missing, not accessible to the principal (`canAccessPage`), or platform mismatch → `NotFoundError` (404) (`ai-gateway.ts:137-144`).
3. Resolve the page's stored proxy (`resolveStoredProxyConfig`, decrypts stored proxy auth); if none → `ServiceUnavailableError` (503) "requires a configured page proxy" (`ai-gateway.ts:146-150`).
4. Sweep stale reservations older than 30 min (`markStaleAiGatewayReservationsFailed`, `AI_GATEWAY_STALE_RESERVATION_MS = 30*60*1000`) (`ai-gateway.ts:152-162`).
5. `evaluateAiGatewayQuota` — per `(userId, pageId)` UTC-day totals; if `remainingRequestsToday <= 0` or `remainingMicroUsdToday <= 0` → `TooManyRequestsError` (429) (`ai-gateway.ts:164-171`). Defaults: 200 requests/day, 5,000,000 micro-USD/day ($5.00).
6. Provider not configured (`app.aiGatewayProvider` unset) → `ServiceUnavailableError` (503) (`ai-gateway.ts:172-174`).
7. Per-request cost ceiling: `estimateAnthropicGatewayRequestCost(input)` (worst-case estimate, §3.3); unknown model → `BadRequestError` (400) "Unsupported ChatMuse AI gateway model"; estimate over `chatMuseAiGatewayRequestMicroUsdLimit` (default 5,000,000 micro-USD) or a limit of 0 → `TooManyRequestsError` (429) (`ai-gateway.ts:175-187`).
8. `reserveAiGatewayUsageEvent` — INSERT ... ON CONFLICT DO NOTHING keyed on `(userId, clientRequestId)`; if a row already exists → `ConflictError` (409) "request id is already reserved" (`ai-gateway.ts:188-203`).

On success it mints an internal `requestId` (`randomUUID`) and returns a `PreparedAiGatewayStream` with a `meta` frame, a lazy `stream(signal)` generator, and `recordTerminal(...)`.

### 2.4 SSE response (handler `apps/runtime/src/api/server.ts:701-803`)
`reply.hijack()`; writes raw headers `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`. Each frame is serialized as `event: ai\ndata: <JSON>\n\n` (`serializeAiGatewaySseFrame`, `ai-gateway.ts:271-273`). An `AbortController` is aborted when the raw socket emits `close` (client disconnect), which propagates into the provider call.

Frame types (`aiGatewayStreamFrameSchema`, discriminated on `type`, routes.ts:1821-1857):

| `type` | Fields | Source |
|---|---|---|
| `meta` | `requestId`, `clientRequestId`, `feature`, `pageLabel`, `model`, `provider`, `providerResponseId` (always `null` here), `quota` `{accepted, remainingRequestsToday, remainingMicroUsdToday}` | Emitted first, before any provider I/O. |
| `content_delta` | `text` | Anthropic `content_block_delta` / `text_delta`. |
| `reasoning_delta` | `text` | Anthropic `content_block_delta` / `thinking_delta`. |
| `usage` | `usage` (6 numeric fields), `providerResponseId`, `cacheHit` | Anthropic `message_delta.usage` (fallback: `message_start.usage`). |
| `error` | `code`, `message`, `retryAfterMs` | Emitted on stream failure or missing usage. |
| `done` | `stopReason` | Terminal frame; buffered and written last. |

Handler bookkeeping (`server.ts:735-802`): tracks `terminalUsage`, `terminalProviderResponseId`, `terminalCacheHit`, `streamedContent`, `terminalOutcome`. If content streamed but no `usage` frame arrived, it forces `terminalOutcome = "failed"` and writes an `error` frame `code:"provider_usage_missing"` (`server.ts:752-762`). A thrown error while aborted → outcome `cancelled`; otherwise `failed` + `error` frame `code:"provider_stream_failed"` (`server.ts:766-781`). In the `finally` block it always calls `stream.recordTerminal(...)` (§2.5) and closes the socket.

### 2.5 Terminal ledger write (`recordTerminal`, `ai-gateway.ts:241-267`)
Calls `finalizeAiGatewayUsageEvent`, UPDATE-ing the reserved row (matched by `userId` + `clientEventId = clientRequestId`) with the observed `inputTokens`/`outputTokens`/`cacheWriteTokens`/`cacheReadTokens`, `costMicroUsd`, `costApproximate`, `providerResponseId`, `gatewayOutcome` (`completed`|`failed`|`cancelled`), `durationMs` (wall-clock `Date.now()-startedAt`), `isCacheHit`, and `completedAt = now` (overwriting the reservation's `completedAt`). If usage is null it substitutes a zeroed usage object.

---

## 3. Outbound boundary — the Anthropic Messages API

**Counterpart:** `api.anthropic.com` via `@anthropic-ai/sdk`. **Direction:** outbound HTTPS, streaming. Implemented in `apps/runtime/src/services/ai-gateway-anthropic-provider.ts`.

### 3.1 Client construction, credentials, and egress
The provider is created in `bootstrap.ts:179-183` only when `chatMuseAiGatewayEnabled && anthropicApiKey`, using `createPageProxyAnthropicClientResolver(config.anthropicApiKey)`. Per request, the resolver (`ai-gateway-anthropic-provider.ts:125-142`):
- Requires the page's `proxy` (`ProxyConfig`); if absent, throws.
- Builds an undici proxy `Dispatcher` via `createProxyRequestDispatcher(proxy)` (`packages/shared/src/http-client.ts:124`) and wraps `fetch` so the SDK egresses through it (`createAnthropicGatewayProxyFetch`).
- Instantiates `new Anthropic({ apiKey, fetch })` (`createSdkClient`, lines 111-123). **Secret:** `ANTHROPIC_API_KEY` (config field `anthropicApiKey`, env `ANTHROPIC_API_KEY`, `editability: NEVER`, `config-registry.ts:200`).
- Returns a `release()` that closes the dispatcher after the stream ends (`finally`, line 211-213).

Net effect: `core` calls Anthropic with **its own** API key, but the TCP egress is routed through the **creator page's configured proxy** (so the outbound IP matches the page's proxy, not `core`'s host). The request is `POST https://api.anthropic.com/v1/messages` (SDK default) with `stream: true` and the route's `AbortSignal`.

### 3.2 Request shape sent to Anthropic (`buildAnthropicGatewayStreamRequest`, `ai-gateway-anthropic.ts:186-211`)
```
{
  model: <providerModelId>,          // bare id, e.g. "claude-sonnet-4-6"
  stream: true,
  max_tokens: <input.maxTokens ?? tuning.maxTokens>,
  system:   [ {type:"text", text, cache_control?:{type:"ephemeral", ttl?:"1h"}} ...],
  messages: [ { role:"user", content: [ <same text-block shape> ... ] } ],
  temperature?: <number>,            // omitted for adaptive-thinking or sampling-removed models
  thinking?: {type:"adaptive", display:"summarized"},
  output_config?: {effort: <low|medium|high|max>}
}
```
Prompt-block cache mapping (`toAnthropicGatewayTextBlocks`, lines 136-156): `cache:"1h"` → `cache_control:{type:"ephemeral", ttl:"1h"}`; `cache:"5m"` → `cache_control:{type:"ephemeral"}` (no ttl); `cache:"none"` → plain text block.

**Model resolution (`resolveAnthropicGatewayModel`, `ai-gateway-pricing.ts:83-90`):** the client-supplied `model` string is used **verbatim as the pricing-table key**, which is prefixed with `anthropic:`. The bare `providerModelId` is what goes to the SDK. Clients must therefore send the prefixed form (e.g. `anthropic:claude-opus-4-8`). Unknown keys throw → surfaced as 400.

**Referenced Claude models (`ANTHROPIC_PRICING`, `ai-gateway-pricing.ts:26-75`):** `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-haiku-4-5` (each keyed as `anthropic:<id>`).

### 3.3 Consuming the Anthropic event stream (`stream`, `ai-gateway-anthropic-provider.ts:158-215`)
Iterates `client.messages.create(...)` async events:
- `message_start` → captures `message.id` as `providerResponseId`; stashes `message.usage` as fallback.
- `content_block_delta` → `text_delta.text` → `content_delta` frame; `thinking_delta.thinking` → `reasoning_delta` frame.
- `message_delta` → captures `stop_reason`; if `usage` present, emits a `usage` frame immediately (`usageEmitted = true`).
- After the loop, if usage was seen only at `message_start` (not emitted), emits a fallback `usage` frame; then emits `done` with the captured `stopReason`.

`usageFrame` (lines 82-102) normalizes Anthropic usage (`normalizeAnthropicGatewayUsage`, `ai-gateway-anthropic.ts:243-268`) and computes cost (`estimateAiGatewayUsageCost`). Anthropic usage fields consumed: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and the breakdown `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. `cacheHit` = `cache_read_input_tokens > 0`.

### 3.4 The `openrouter` provider is declared but not implemented
The `provider` union is `"anthropic" | "openrouter"` across the service, DB type, and contract (`ai-gateway.ts:51`, `repositories/ai-usage.ts:9`, routes.ts:1829). Only `createAnthropicAiGatewayProvider` exists; **no OpenRouter code path produces the `"openrouter"` value**. The provider recorded in the ledger is always `app.aiGatewayProvider.provider`, i.e. `"anthropic"`.

---

## 4. Per-feature tuning (`ai-gateway-anthropic.ts:56-184`)

`AiUsageFeature` values (`packages/shared/src/types.ts:112-122`): `fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `scan`, `ping`, `hi-greeting`.

| feature | `FEATURE_MAX_TOKENS` (non-adaptive) | `ANTHROPIC_ADAPTIVE_MAX_TOKENS` | `FEATURE_TEMPERATURES` |
|---|---|---|---|
| fast-reply | 800 | 8000 | 0.65 |
| improve-draft | 800 | 8000 | 0.65 |
| help-me | 1200 | 16000 | 0.45 |
| fan-summary | 8192 | 24000 | 0.4 |
| chat-review | 1600 | 16000 | 0.25 |
| scan | 8192 | 24000 | 0.4 |
| ping | 800 | 8000 | 0.65 |
| hi-greeting | 800 | 8000 | 0.7 |

**Adaptive models** (`ANTHROPIC_ADAPTIVE_THINKING_MODELS`): `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-8`. **Sampling-params-removed models** (`ANTHROPIC_SAMPLING_PARAMS_REMOVED_MODELS`): `claude-opus-4-8`.

`resolveAnthropicGatewayRequestTuning` (lines 162-184):
- `maxTokens` = adaptive table if the model is adaptive, else the feature table.
- If **not adaptive** OR `reasoningEffort === "off"`: send `temperature` — **unless** the model is in the sampling-removed set (`claude-opus-4-8`), in which case only `maxTokens` is returned (no temperature, no thinking).
- Otherwise (adaptive + effort ≠ off): send `thinking:{type:"adaptive", display:"summarized"}` and `output_config:{effort}`, **no temperature**.

Note the interaction: `claude-opus-4-8` is both adaptive and sampling-removed, so with `reasoningEffort:"off"` it uses the adaptive max-tokens table but sends neither temperature nor thinking.

---

## 5. Pricing & cost accounting (`ai-gateway-pricing.ts`)

`AnthropicGatewayPricing` per model carries five USD-per-million rates: `inputUsdPerMillion`, `outputUsdPerMillion`, `cacheWrite5mUsdPerMillion`, `cacheWrite1hUsdPerMillion`, `cacheReadUsdPerMillion`.

| model | input | output | cacheWrite5m | cacheWrite1h | cacheRead |
|---|---|---|---|---|---|
| sonnet-4-6 / sonnet-4-5 | 3 | 15 | 3.75 | 6 | 0.3 |
| opus-4-8 / opus-4-6 / opus-4-5 | 5 | 25 | 6.25 | 10 | 0.5 |
| haiku-4-5 | 1 | 5 | 1.25 | 2 | 0.1 |

**Cost formula (`estimateAiGatewayUsageCost`, lines 92-133):** `costMicroUsd = round(Σ tokens_i × rate_i)`. Because `tokens × (USD per 1,000,000 tokens)` numerically equals **micro-USD** (1e-6 USD), the stored `cost_micro_usd` is in **micro-USD**. **This is a different unit from the "mills" ($0.001 = 1000 micro-USD) used elsewhere in `core`.** UI formatting divides by 1,000,000 to show dollars (`UsagePage.tsx:47`).

Cache-write reconciliation: if no 5m/1h breakdown is supplied, all `cacheWriteTokens` are priced at the 5m rate and `costApproximate = true` when any exist; if a breakdown is supplied but its parts don't sum to the total, it reconciles (clamping 1h to the total, remainder to 5m) and sets `costApproximate = true`.

**Worst-case pre-flight estimate (`estimateAnthropicGatewayRequestCost`, `ai-gateway-anthropic.ts:213-241`):** input tokens are estimated from prompt text at `APPROX_CHARS_PER_TOKEN = 4` (`ceil(len/4)`, min 1 per block); output tokens are assumed to equal `max_tokens`; cache-write tokens come from `5m`/`1h` blocks. The result is always `costApproximate: true` and gates gate #7 in §2.3.

---

## 6. Inbound boundary — `POST /api/v1/ai-usage/batch`

**Counterpart:** external chat clients batching locally-computed usage. **Direction:** inbound HTTP. Handler `apps/runtime/src/api/server.ts:694-699` → `ingestAiUsageBatch` (`apps/runtime/src/services/ai-usage.ts:74-128`). Bearer API-key only (`requireApiKeyUser`, enforced inside the service, `ai-usage.ts:79`); contract security `bearerOnlySecurity` (routes.ts:3767).

**Body (`aiUsageBatchBodySchema`, routes.ts:1767-1769):** `{ events: [aiUsageEventInputSchema] }`, 1–100 events. Each event (routes.ts:1752-1765): `clientEventId` (1–255), `feature`, `model` (1–100), `inputTokens`/`outputTokens`/`cacheWriteTokens`/`cacheReadTokens` (int 0–100,000,000), optional `conversationId`/`durationMs`, `isCacheHit`, `isRegeneration`, `completedAt` (string). **No cost field is accepted** → batch rows persist with `cost_micro_usd = 0` (`insertAiUsageEvents` defaults `event.costMicroUsd ?? 0`, `repositories/ai-usage.ts:210`) and `page_id`/`provider`/`gateway_outcome`/`quota_accepted` NULL.

**Processing:** `parseCompletedAt` (lines 25-36) rejects events whose `completedAt` is unparseable or more than `COMPLETED_AT_FUTURE_SKEW_MS` (5 min) in the future — these are counted as `invalidCount` and **skipped, not fatal** (deliberate: a poison event must not reject the whole batch, comment at lines 22-24). Valid events go to `insertAiUsageEvents`, INSERT ... ON CONFLICT DO NOTHING on `(userId, clientEventId)`; the returned inserted count is `insertedCount`. **Response (`aiUsageBatchResponseSchema`):** `{ receivedCount, insertedCount, invalidCount, dedupedCount }` where `dedupedCount = receivedCount − invalidCount − insertedCount` (rows dropped as conflicts).

---

## 7. Reporting boundary — `GET /api/v1/admin/usage/chatters` and the dashboard

**Counterpart:** the React dashboard (owner user). **Direction:** inbound HTTP (read). Handler `apps/runtime/src/api/server.ts:2397-2403` → `getAdminChatterUsageReport` (`ai-usage.ts:130-149`). **Cookie session, owner only** (`requireOwner`); contract security `cookieOnlySecurity` (routes.ts). Query `{from?, to?}` business dates (must be supplied together); default range is the last 7 business days in **Moscow time** (`MOSCOW_TIME_ZONE`, `ai-usage.ts:38-72`).

Aggregation is `listChatterUsageSummary` (`repositories/ai-usage.ts:347-586`), which restricts to `users.role = 'chatter'` and runs three SQL passes over `ai_usage_events` filtered by `completed_at ∈ [from, toExclusive)`:
- **Totals per chatter:** `totalGenerations`; summed `input/output/cacheWrite/cacheRead` tokens; summed `costMicroUsd` + `bool_or(costApproximate)`; gateway counters — `gatewayRequestCount` (rows where provider/outcome/quotaAccepted not null), `completed`/`failed`/`cancelled`/`quotaDenied` counts, `openReservationCount` (provider not null AND quotaAccepted=true AND outcome null); `regenerateRatePct` and a `warning` boolean (regen rate > 30%).
- **Feature breakdown per chatter:** per-feature request counts, token sums, cost, `sharePct`, `regenerateRatePct`; the top feature is picked as `featureBreakdown[0]`.
- **Provider breakdown per chatter:** rows where `provider IS NOT NULL`, grouped by provider, with request count and `costMicroUsd`.

Response type `ChatterUsageSummaryRow[]` is rendered by **`apps/dashboard/src/pages/UsagePage.tsx`** (`useAdminChatterUsage`): a per-chatter table with feature columns, total, cost (`formatMicroUsd`, dollars with `~` prefix when approximate), and regen %; expandable rows show per-feature token/cost detail plus a "Gateway:" line (requests/completed/failed/cancelled/open + provider breakdown) only when `gateway.requestCount > 0`. Since batch rows have `cost_micro_usd = 0` and no gateway fields, in the default (gateway-off) state cost columns are $0 and no gateway line appears.

---

## 8. Storage boundary — table `ai_usage_events` (`packages/db/src/schema.ts:1508-1584`)

Base table created in `0003_ai_usage_events.sql`; the `feature` enum value `scan` added in `0004_ai_usage_feature_scan.sql`; the gateway columns added in **`0040_ai_gateway_usage_ledger.sql`** (storage-only migration — its header notes that adding the columns does not enable gateway execution).

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | |
| `user_id` | bigint → `users.id` ON DELETE CASCADE, NOT NULL | scope owner (the chatter). |
| `page_id` | bigint → `pages.id` ON DELETE SET NULL | gateway-only; NULL for batch rows (added in 0040). |
| `client_event_id` | text NOT NULL | idempotency; unique with `user_id`. |
| `feature` | enum `ai_usage_feature` NOT NULL | 8 values incl. `scan`. |
| `model` | text NOT NULL | for gateway rows, the prefixed key (e.g. `anthropic:claude-...`). |
| `provider` | text `anthropic`\|`openrouter` (nullable) | gateway-only (0040). |
| `provider_response_id` | text nullable | Anthropic `message.id` (0040). |
| `input_tokens`/`output_tokens`/`cache_write_tokens`/`cache_read_tokens` | integer NOT NULL, each `>= 0` (check) | |
| `cost_micro_usd` | integer default 0 NOT NULL, `>= 0` | micro-USD; 0 for batch rows (0040). |
| `cost_approximate` | boolean default false NOT NULL | (0040). |
| `quota_accepted` | boolean nullable | set `true` on reservation (0040). |
| `gateway_outcome` | text `completed`\|`failed`\|`cancelled`\|`quota_denied` (nullable) | set on finalize/sweep (0040). |
| `conversation_id` | text nullable | |
| `duration_ms` | integer nullable, `>= 0` when set | wall-clock. |
| `is_cache_hit` / `is_regeneration` | boolean default false NOT NULL | |
| `completed_at` | timestamptz NOT NULL | reservation time until finalize overwrites it. |
| `ingested_at` | timestamptz default now() NOT NULL | |

Constraints/indexes: `unique(user_id, client_event_id)`; indexes on `(user_id, completed_at)`, `(page_id, completed_at)`, partial `(provider, provider_response_id) WHERE provider_response_id IS NOT NULL`, and `(completed_at)`; check constraints enforcing the `provider` and `gateway_outcome` enums and non-negative token/cost/duration values.

### DB operations catalog (`packages/db/src/repositories/ai-usage.ts`)

| function | op | keying / effect |
|---|---|---|
| `insertAiUsageEvents` (186) | INSERT … ON CONFLICT DO NOTHING | batch rows; conflict target `(user_id, client_event_id)`; returns inserted count. |
| `reserveAiGatewayUsageEvent` (229) | INSERT … ON CONFLICT DO NOTHING | gateway reservation: zero tokens, `quota_accepted=true`, `gateway_outcome=null`, `completed_at=reservedAt`; returns `true` iff exactly one row inserted. |
| `finalizeAiGatewayUsageEvent` (266) | UPDATE | matches `(user_id, client_event_id)`; writes tokens/cost/outcome/duration/providerResponseId/completedAt; returns `true` iff one row updated. |
| `markStaleAiGatewayReservationsFailed` (296) | UPDATE | sets `gateway_outcome='failed'` + computed `duration_ms` for rows `provider IS NOT NULL AND quota_accepted=true AND gateway_outcome IS NULL AND completed_at < reservedBefore`; returns count. |
| `getAiGatewayDailyUsageTotals` (321) | SELECT count + sum(cost) | per `(user_id, page_id)` within `[from, toExclusive)` over gateway rows; feeds quota. |
| `listChatterUsageSummary` (347) | 3× SELECT aggregate | admin report (§7). |

The DB-repo type `AiGatewayOutcome` includes `quota_denied`, but **no code in this territory writes `quota_denied`** — quota denials throw `TooManyRequestsError` before any row is inserted (`ai-gateway.ts:169-171`). It exists only in the enum/check and is counted by the report if ever present.

---

## 9. Configuration & feature flags (`packages/shared/src/config.ts`, `config-registry.ts`)

| config field | env var | default | notes |
|---|---|---|---|
| `chatMuseAiGatewayEnabled` | `CHATMUSE_AI_GATEWAY_ENABLED` | `false` | Master gate; `editability: STAGED`, `runtimeApply: "boot"` (staged group `#26`). Gates both the preflight and provider construction. |
| `chatMuseAiGatewayDailyRequestLimit` | `CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT` | `200` | Per user+page UTC-day request cap; 0 blocks all. |
| `chatMuseAiGatewayDailyMicroUsdLimit` | `CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT` | `5000000` | Per user+page UTC-day cost cap ($5.00). |
| `chatMuseAiGatewayRequestMicroUsdLimit` | `CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT` | `5000000` | Per-request worst-case cost ceiling. |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | (unset) | Secret; `editability: NEVER`. Also gates the Workboard closing LLM. Provider is only built when both this and the flag are set. |

Non-finite/negative numeric limits fall back to the `DEFAULT_*` constants (`ai-gateway.ts:24-27, 87-93`).

---

## 10. Cross-project boundary summary

| Boundary | Direction | Counterpart | Data crossing |
|---|---|---|---|
| `POST /api/v1/ai/gateway/stream` (request) | inbound | desktop app / extension (chatter API key) | prompt blocks (system+user text, cache hints), model key, feature, pageLabel, platform, reasoningEffort, temperature, maxTokens, clientRequestId, conversationId, isRegeneration. |
| `POST /api/v1/ai/gateway/stream` (response) | outbound (SSE) | same client | `event: ai` frames: meta (incl. quota), content_delta, reasoning_delta, usage (tokens+cost), error, done. |
| Anthropic Messages API | outbound HTTPS (streaming) | `api.anthropic.com` via `@anthropic-ai/sdk`, egressing through the **page's proxy** using `core`'s `ANTHROPIC_API_KEY` | request: model, max_tokens, system/messages text blocks w/ ephemeral cache_control, optional temperature/thinking/output_config. response: SSE `message_start`/`content_block_delta`/`message_delta` events with text, thinking, usage, stop_reason. |
| `POST /api/v1/ai-usage/batch` | inbound | chat clients (chatter API key) | up to 100 usage events: feature, model, token counts, conversationId, durationMs, flags, completedAt. |
| `GET /api/v1/admin/usage/chatters` | inbound (read) | dashboard (owner session) | query date range → per-chatter aggregate (tokens, cost, feature/provider/gateway breakdown, regen rate). |
| `ai_usage_events` table | storage (R/W) | Postgres | batch inserts, gateway reserve/finalize, stale-sweep updates, quota + report reads. |
| Page proxy secret | internal read | `proxy_configs` (decrypted via `resolveStoredProxyConfig`) | proxy URL + decrypted username/password used to build the undici dispatcher for the Anthropic egress. |

---

## 11. Discrepancies & notes

- **`platformUserId` is accepted but unused.** The gateway body requires `platformUserId` (routes.ts:1793) but `prepareAiGatewayStream` never reads it and it is not forwarded to Anthropic nor stored (grep confirms no reference in the gateway service beyond the schema). Fan scoping in the ledger is by `page_id` only.
- **`cost_micro_usd` is micro-USD, not mills.** Despite the codebase's prevailing "mills" money unit ($0.001), this ledger's cost is in micro-USD (1e-6 USD). 1 mill = 1000 micro-USD. The `usdPerMillion × tokens` formula yields micro-USD directly.
- **Batch usage events never carry cost.** The batch contract has no cost field, so those rows are always `cost_micro_usd = 0`; only gateway-executed rows contribute non-zero cost to the admin report.
- **`openrouter` provider is vestigial.** The value appears in every provider union/enum/check but has no implementation; only Anthropic is wired. Recorded provider is always `anthropic`.
- **`quota_denied` outcome is never written** by this territory's code; quota failures throw before a row exists. The value exists only in the enum/check and report counters.
- **Single table, two semantics.** `ai_usage_events` mixes client-batched rows (page/provider/gateway/cost all null-or-zero) and gateway rows; downstream queries disambiguate with the `provider/gateway_outcome/quota_accepted IS NOT NULL` predicate. Migration `0040`'s comment explicitly states adding the columns does not enable gateway execution — execution remains gated by `chatMuseAiGatewayEnabled` + `anthropicApiKey`.
- **Reservation `completed_at` semantics shift.** During the open window a reservation's `completed_at` equals the reservation time (so it participates in the same-day quota and can be swept after 30 min); `finalizeAiGatewayUsageEvent` overwrites it with the true completion time.
