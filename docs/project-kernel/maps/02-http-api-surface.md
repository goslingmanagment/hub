> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 02 — HTTP API Surface (client-facing boundary)

**Scope.** This document covers the Fastify HTTP server that is the entire client-facing boundary of `core`: `apps/runtime/src/api/server.ts` (3,584 lines — the single file that constructs the server, registers plugins, establishes per-request auth, and declares every route). It anchors each route to its Zod contract schema in `packages/contracts/src/routes.ts` (the schema *bodies* are Territory 03) and to the auth primitives in `apps/runtime/src/services/auth.ts`. Where a route delegates its authorization or boundary behavior into a service, that service is named and cross-referenced (streaming mechanics are Territory 14; the sync/OFAPI/AI subsystems the routes call into are their own territories). The AI-usage guard nuance was verified by reading `apps/runtime/src/services/ai-usage.ts`.

The server is built by `buildApiServer(appContext)` (`server.ts:423`) and returned to the caller (the API process `apps/runtime/src/api.ts`, per the Territory context). The same builder is used with no `databaseUrl` for offline OpenAPI/contract generation, in which case the pg-boss queue block is skipped (`server.ts:1261`).

---

## 1. Server construction

`Fastify({ loggerInstance, trustProxy }).withTypeProvider<ZodTypeProvider>()` (`server.ts:424-427`). `trustProxy` comes from `appContext.config.trustProxy` (env `TRUST_PROXY`, default `"false"`; a hop count or CIDR narrows which `X-Forwarded-For` hops are trusted — this is what makes `request.ip` honest for the login rate-limit key).

**Zod type provider.** `setValidatorCompiler(validatorCompiler)` and `setSerializerCompiler(serializerCompiler)` from `fastify-type-provider-zod` (`server.ts:429-430`) make every route's `schema` (a `routeSchemas.*` entry) both validate the request and serialize/validate the response against Zod. `decorateRequest("auth")` adds a mutable `request.auth` slot (`server.ts:431`; typed via the `declare module "fastify"` block at `server.ts:271-275`).

**Plugins registered (in order):**

| Plugin | Registration | Purpose / config |
|---|---|---|
| `@fastify/cookie` | `server.ts:433` | Parses/sets the session cookie (`agency_hub_core_session`). |
| `@fastify/rate-limit` | `server.ts:434-441` | `global: false` — off by default; only routes that opt in via `config.rateLimit` are limited. `errorResponseBuilder` returns `{error:"rate_limit_exceeded", message:"Too many login attempts", statusCode:429}`. |
| `@fastify/swagger` | `server.ts:442-474` | OpenAPI 3.1.0 doc, title "Agency Hub Core API" v2.0.0. Declares three securitySchemes: `cookieAuth` (apiKey in cookie `agency_hub_core_session`), `bearerAuth` (http bearer), `monitoringTokenAuth` (apiKey in header `x-monitoring-token`). `createJsonSchemaTransform` skips `/documentation` paths. |
| `@fastify/swagger-ui` | `server.ts:556-561` | Serves interactive docs at `/documentation`; `uiHooks.onRequest: requireOpenApiDocsOwner` — **owner-only** UI. |
| `@fastify/static` | `server.ts:3572-3573` | Registered **only if** a built dashboard `dist` exists (`resolveDashboardDistPath`, `server.ts:329-345`, walks ancestor dirs looking for `apps/dashboard/dist/index.html`). Serves the SPA at prefix `/`, `wildcard:false`. |

**CORS.** No CORS plugin is registered anywhere in this file. The API and SPA are served same-origin (static plugin at `/`), so no cross-origin headers are emitted.

**Body parsing.** The default Fastify JSON parser applies to all routes **except** the OFAPI webhook, which is registered inside an isolated plugin scope (`server.ts:1282-1311`) that installs the repo's only buffer-mode parser: `addContentTypeParser("application/json", {parseAs:"buffer"}, …)` so the HMAC can be computed over the raw request bytes. No global `bodyLimit` is set (Fastify's 1 MB default applies).

**Global error handler** (`server.ts:576-629`), matched in order:
1. Zod validation errors (`hasZodFastifySchemaValidationErrors`) → `400 {error:"Bad Request", message, statusCode:400}`.
2. Response serialization errors (`isResponseSerializationError`) → logged, `500 {message:"Response validation failed"}`.
3. `AppError` subclasses (from `services/errors.ts`) → `error.statusCode` with `{error: error.code, message, statusCode}`.
4. Any object already shaped `{statusCode, error, message}` → passed through (this catches the rate-limit plugin's 429 and other fastify errors).
5. Fallback → logged, `500 {error:"internal_error", message:"Internal Server Error"}`.

**Global hooks.** `onClose` hooks: one stops pg-boss (`server.ts:1273-1275`), one destroys all active hijacked SSE streams and closes the sync event hub so `server.close()` does not hang on long-lived connections (`server.ts:1315-1322`).

**Not-found handler** (only when static serving is on, `server.ts:3574-3579`): any URL not starting with `/api/` or `/documentation` returns `index.html` (SPA fallback); otherwise a JSON `404 {error:"Not Found"}`.

---

## 2. Authentication & authorization model

Identity is established **lazily, per request** by `resolvePrincipal` (`server.ts:475-499`). It memoizes onto `request.auth` and resolves in this precedence:

1. If an `Authorization: Bearer <token>` header is present, the token is authenticated as an **API key** via `authenticateApiKeyToken` (`auth.ts:675-693`).
2. Otherwise, the `agency_hub_core_session` **cookie** is authenticated via `authenticateSessionToken` (`auth.ts:655-673`).
3. Otherwise `request.auth = null`.

`requirePrincipal` (`server.ts:501-511`) throws `UnauthorizedError` (401) when no principal resolves. Every authenticated route calls it first.

### 2.1 Two credential types, three roles

`AuthPrincipal` = `{ authMethod: "session" | "api_key", user: {id, username, role, assignedPages[]}, assignedPageIds: number[] }` (`auth.ts:79-83`).

- **Session cookie** (`authMethod:"session"`): issued by `POST /auth/login` for roles that `roleCanUseSession` → `owner` or `team_lead` (`auth.ts:93-95`). Token is a `randomToken(32)`, stored as `sha256Hex` digest in `auth_sessions`, TTL `config.sessionTtlDays`. Cookie flags: `httpOnly`, `sameSite:"lax"`, `secure` true in production, `path:"/"` (`applyCookie`, `server.ts:281-291`).
- **API key** (`authMethod:"api_key"`): bearer token prefixed `agency_hub_core_`, only valid for role `chatter` (`roleCanUseApiKey`, `auth.ts:89-91`). Stored as `sha256Hex` digest in `api_keys`; issuing rotates (revokes) prior active keys. This is the credential the **desktop app** and **browser extension** use.
- Roles: `owner`, `team_lead`, `chatter`. `owner` sees all pages; `team_lead` and `chatter` are scoped to assigned pages.

Both `authenticate*` functions re-load the user and re-check the role gate on every call (a `chatter` presenting a session cookie, or an `owner` presenting an api-key, resolves to `null`), and call `touchAuthSession` / `touchApiKey` to update last-used.

### 2.2 Authorization guards (all from `auth.ts`)

| Guard | Rule | Throws |
|---|---|---|
| `requirePrincipal` | any authenticated principal | 401 |
| `requireDashboardUser(p)` | `authMethod==="session"` AND role ∈ {owner, team_lead} | 403 |
| `requireOwner(p)` | dashboard user AND role === owner | 403 |
| `requireApiKeyUser(p)` | `authMethod==="api_key"` (⇒ chatter) | 403 |
| `canAccessPage(p, pageId)` | owner ⇒ always; else `assignedPageIds.includes(pageId)` (returns bool) | route throws `ForbiddenError` |

**Per-page access.** Page-scoped read routes resolve the page via `getPageSummary(appContext, pageLabel)` then check `canAccessPage(principal, page.id)`, throwing `ForbiddenError("Page access denied")` on failure (e.g. `server.ts:864-867`). List/report routes instead pass a **page scope** into the service: `pageScopeFor(principal)` returns `undefined` for owner (no filter) or `principal.assignedPageIds` for everyone else (`server.ts:277-279`). Some page-scoped routes (fan profiles, conversations, spenders) do **not** check access in the handler and instead pass the whole `principal` into the service, which enforces scope internally (e.g. `getPageFanProfile`, `getSpenderList`).

**Monitoring-token bypass.** `GET /health/sync` accepts either a dashboard session or a header `x-monitoring-token` matched with a constant-time compare (`safeStringEquals`, `timingSafeEqual`) against `config.healthSyncMonitoringToken` (env `HEALTH_SYNC_MONITORING_TOKEN`); the token path skips page scoping (`requireSyncHealthAccess`, `server.ts:519-545`).

**OpenAPI docs gate.** `requireOpenApiDocsOwner` (`server.ts:547-554`) guards both `GET /documentation*` (Swagger UI onRequest hook) and `GET /api/v1/openapi.json` — **owner-only**.

### 2.3 Login hardening (`auth.ts`)

`loginWithPassword` (`auth.ts:591-653`) verifies argon2id hashes, runs a **dummy hash verify** on the unknown/ineligible-user path to equalize timing (no username enumeration), and layers an **in-memory per-account escalating backoff** (`assertLoginNotBackedOff`/`recordLoginFailureForBackoff`, `auth.ts:493-589`): 5 free failures, then exponential lock 30 s → 15 min cap, forgotten after 30 min, max 10,000 tracked accounts (state per `AppContext`, lost on restart). Failed logins throw `TooManyRequestsError` (429) or `UnauthorizedError` (401) and best-effort write an `auth.login_failed` audit row. This complements the route-level per-IP limiter (below).

---

## 3. Rate limiting, request limits, streaming

**Rate-limited routes** (all others are unlimited; global rate limiting is off):

| Route | max / window | Key |
|---|---|---|
| `POST /api/v1/auth/login` | 20 / 60 s | per-IP (plugin runs at onRequest, before body parse) — `server.ts:659-663` |
| `POST /api/v1/ofapi/webhook` | `ofapiWebhookRateLimitMax ?? 1000` / `(ofapiWebhookRateLimitWindowSeconds ?? 60)` s | per-IP; custom 429 body "Too many OFAPI webhook deliveries" — `server.ts:1293-1302` |
| `GET /api/v1/ofapi/read/*` | 120 / 1 min | `server.ts:1588-1593` |
| `POST /api/v1/ofapi/commands` | 60 / 1 min | `server.ts:1610-1615` |

**Request-size limit.** No custom `bodyLimit` anywhere — Fastify's default 1 MB applies to all bodies.

**Streaming / hijacked responses** (bypass the Zod serializer; error handler cannot catch post-hijack failures):

- `POST /api/v1/ai/gateway/stream` — SSE `text/event-stream`, `reply.hijack()` (`server.ts:701-803`). Proxies a chatter AI generation from the desktop app to an upstream provider and writes SSE frames; records a terminal usage/cost ledger row in a `finally`. Response schema is `z.unknown()` (200). See §5 and Territory 14.
- `GET /api/v1/events/stream` — SSE sync-event fanout, hijacked (`server.ts:1346-1540`). Details in §6.
- `GET /api/v1/admin/ofapi/credits/ledger.csv` — hijacked `text/csv` download (`server.ts:1676-1705`); sets `Content-Disposition: attachment`, `x-export-row-count`, `x-export-truncated`. The CSV is built *before* hijack so an invalid filter still returns a normal 400.

---

## 4. Complete route catalog

Notation for the **Guard** column: `public` = no auth; `principal` = any authenticated user (`requirePrincipal`); `dashboard` = `requireDashboardUser` (session owner/team_lead); `owner` = `requireOwner`; `api-key` = `requireApiKeyUser` (chatter); `canAccessPage` = per-page owner-or-assigned check in the handler; `svc-scoped` = handler passes `principal` and the service enforces page scope. All routes reference `routeSchemas.<name>` in `packages/contracts/src/routes.ts` (column **Schema**). The **security** field in each schema is documentation-only for OpenAPI; the runtime guard is what the handler actually calls (noted where they differ).

### 4.1 System / health

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/health` | public | `health` | Overall system health; returns 200 or 503 body from `getSystemHealth`. |
| GET | `/api/v1/health/sync` | dashboard **or** `x-monitoring-token` | `healthSync` | Detailed sync health; page-scoped for dashboard users, unscoped for token. 200/503. |
| GET | `/api/v1/openapi.json` | owner | `openApiJson` | OpenAPI spec (`server.swagger()`), post-processed by `normalizeOpenApiDocument` to mark the ledger.csv 200 as `text/csv`. |
| GET | `/documentation`, `/documentation/static/*` | owner | (swagger-ui) | Interactive API docs. |

### 4.2 Auth

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | public, 20/min per IP | `login` | Password login; sets session cookie; returns `{authMethod, user}`. |
| POST | `/api/v1/auth/logout` | public (reads cookie) | `logout` | Revokes session if cookie present, clears cookie; `{ok:true}`. |
| GET | `/api/v1/auth/me` | principal | `me` | Current principal `{authMethod, user}`. |

### 4.3 AI usage & AI gateway (external-client boundary)

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/ai-usage/batch` | api-key (enforced in service) | `aiUsageBatch` | Desktop ingests a batch of chatter AI-usage events. **Discrepancy:** the handler calls only `requirePrincipal` (`server.ts:697`); the api-key gate is enforced *inside* `ingestAiUsageBatch` via `requireApiKeyUser` (`ai-usage.ts:79`). Net effect matches the schema's bearer-only declaration. |
| POST | `/api/v1/ai/gateway/stream` | api-key | `aiGatewayStream` | SSE proxy of one chatter AI generation to the provider; response 200 is `z.unknown()` (hijacked). |

### 4.4 Pages / models / overview (dashboard)

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/pages` | principal | `pages` | Page summaries within scope. |
| GET | `/api/v1/models` | dashboard | `models` | Model summaries within scope. |
| GET | `/api/v1/overview` | dashboard | `overview` | Big composite dashboard payload: counts, 7d/30d revenue w/ deltas, per-page today/7d/30d revenue, new subs/followers today, connection + sync status, setup flags. Assembled inline (`server.ts:1778-1961`) from many DB reads. |
| GET | `/api/v1/overview/revenue` | dashboard | `overviewRevenue` | Aggregate revenue for a period (period/custom from-to). |
| GET | `/api/v1/overview/growth` | dashboard | `overviewGrowth` | Aggregate subscriber/follower growth for a period. |
| GET | `/api/v1/overview/revenue/daily` | dashboard | `overviewRevenueDaily` | Daily revenue series across scope (optional groupByType). |
| GET | `/api/v1/models/:modelSlug/revenue` | dashboard | `modelRevenue` | Model-level revenue for a period. |
| GET | `/api/v1/models/:modelSlug/revenue/daily` | dashboard | `modelRevenueDaily` | Model daily revenue series (404 if model not in scope). |
| GET | `/api/v1/pages/:pageLabel/revenue` | canAccessPage | `pageRevenue` | Page revenue for a period. |
| GET | `/api/v1/pages/:pageLabel/revenue/daily` | canAccessPage | `pageRevenueDaily` | Page daily revenue series. |
| GET | `/api/v1/pages/:pageLabel/transactions` | canAccessPage | `pageTransactions` | Page transactions (limit/offset/type/state). |
| GET | `/api/v1/pages/:pageLabel/subscribers` | canAccessPage | `pageSubscribers` | Page subscriber report. |
| GET | `/api/v1/pages/:pageLabel/subscribers/daily` | canAccessPage | `pageSubscribersDaily` | Page daily subscriber series. |
| GET | `/api/v1/pages/:pageLabel/followers` | canAccessPage | `pageFollowers` | Page follower report. |
| GET | `/api/v1/pages/:pageLabel/followers/daily` | canAccessPage | `pageFollowersDaily` | Page daily follower series. |

### 4.5 Fans / spenders / profiles

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/pages/:pageLabel/fans` | canAccessPage | `pageFans` | Page fan list. |
| GET | `/api/v1/pages/:pageLabel/deleted-fans` | canAccessPage | `pageDeletedFans` | Fans no longer present. |
| GET | `/api/v1/pages/:pageLabel/spender-autolists` | canAccessPage | `pageSpenderAutoLists` | Auto-bucketed spender lists for a page. |
| GET | `/api/v1/pages/:pageLabel/spender-autolists/:bucketKey` | canAccessPage | `pageSpenderAutoListDetail` | Members of one auto-list bucket. |
| GET | `/api/v1/pages/:pageLabel/fans/:platformUserId` | canAccessPage | `pageFanDetail` | Single fan detail on a page. |
| GET | `/api/v1/pages/:pageLabel/fans/:platformUserId/profile` | svc-scoped | `pageFanProfile` | Fan CRM profile (access enforced in `getPageFanProfile`). |
| PUT | `/api/v1/pages/:pageLabel/fans/:platformUserId/profile` | svc-scoped | `upsertFanProfile` | Upsert fan CRM profile (body `{body}`). |
| GET | `/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions` | svc-scoped | `pageFanProfileVersions` | Profile version history. |
| GET | `/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions/:version` | svc-scoped | `pageFanProfileVersion` | One profile version. |
| GET | `/api/v1/pages/:pageLabel/fans/:platformUserId/transactions` | canAccessPage | `pageFanTransactions` | Fan's transactions on this page. |
| POST | `/api/v1/pages/:pageLabel/fans/:platformUserId/notes` | canAccessPage | `createFanNote` | Create a note on a fan (authored by principal). |
| GET | `/api/v1/fans/:platform/:platformUserId` | dashboard | `crossPageFanDetail` | Cross-page fan detail within scope. |
| GET | `/api/v1/fans/:platform/:platformUserId/transactions` | dashboard | `crossPageFanTransactions` | Fan transactions across the fan's in-scope pages. |
| PATCH | `/api/v1/fans/:platform/:platformUserId/flags` | owner | `setFanFlags` | Set fan flags; returns flag rows. |
| GET | `/api/v2/spenders` | svc-scoped (principal) | `spenders` | Spender list (both dashboard and desktop; service scopes by principal). |
| GET | `/api/v2/spenders/:platform/:platformUserId` | svc-scoped (principal) | `spenderDetail` | One spender's detail. |
| GET | `/api/v2/spenders/:platform/:platformUserId/series` | dashboard | `spenderSeries` | Spender time series. |
| POST | `/api/v2/spenders:batch` | svc-scoped (principal) | `spenderBatch` | Batch fetch of spenders by id list. |
| GET | `/api/v2/fans/search` | svc-scoped (principal) | `fansSearch` | Search visible fans. |

### 4.6 Conversations / messages

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/pages/:pageLabel/conversations/:conversationId/profile` | svc-scoped | `pageConversationProfile` | Conversation-linked CRM profile. |
| GET | `/api/v1/pages/:pageLabel/conversations/:platformConversationId/preview` | svc-scoped | `pageConversationPreview` | Last-message preview for a conversation. |
| GET | `/api/v1/pages/:pageLabel/conversations/:conversationId/messages` | svc-scoped | `pageConversationMessages` | Paged conversation messages. |

### 4.7 Workboard (dashboard v1 + v2, AI owner-only)

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/pages/:pageLabel/workboard` | dashboard | `workboard` | v1 workboard report. |
| GET | `/api/v1/pages/:pageLabel/workboard/presence` | dashboard | `workboardPresence` | v1 presence overlay. |
| POST | `/api/v1/pages/:pageLabel/workboard/snooze` | dashboard | `workboardSnooze` | Snooze a fan (v1). |
| DELETE | `/api/v1/pages/:pageLabel/workboard/snooze/:fanId` | dashboard | `workboardUnsnooze` | Unsnooze a fan (v1). |
| GET | `/api/v1/pages/:pageLabel/workboard/v2` | dashboard | `workboardV2` | v2 board report (query filters). |
| GET | `/api/v1/pages/:pageLabel/workboard/v2/lists` | dashboard | `workboardV2Lists` | v2 list definitions. |
| POST | `/api/v1/pages/:pageLabel/workboard/v2/contact` | dashboard | `workboardV2Contact` | Record a contact action. |
| POST | `/api/v1/pages/:pageLabel/workboard/v2/recompute` | dashboard | `workboardV2Recompute` | Trigger board recompute. |
| POST | `/api/v1/pages/:pageLabel/workboard/v2/snooze` | dashboard | `workboardV2Snooze` | Snooze (v2). |
| DELETE | `/api/v1/pages/:pageLabel/workboard/v2/snooze/:fanId` | dashboard | `workboardV2Unsnooze` | Unsnooze (v2). |
| DELETE | `/api/v1/pages/:pageLabel/workboard/v2/contact/:fanId` | dashboard | `workboardV2UndoContact` | Undo a contact. |
| GET | `/api/v1/pages/:pageLabel/workboard/v2/ai` | owner | `workboardV2Ai` | AI settings/cost/verdicts (owner-only per inline comment `server.ts:1180`). |
| PUT | `/api/v1/pages/:pageLabel/workboard/v2/ai/settings` | owner | `workboardV2AiSettings` | Update AI classify settings. |
| POST | `/api/v1/pages/:pageLabel/workboard/v2/ai/classify` | owner | `workboardV2AiClassify` | Run an AI classify pass. |
| GET | `/api/v1/workboard/ai/runs` | owner | `workboardV2AiRuns` | List AI classify runs (global, not page-scoped). |

### 4.8 Sync (dashboard reads + admin controls)

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/sync/status` | dashboard (+canAccessPage if pageLabel) | `syncStatus` | Sync monitor snapshot. |
| GET | `/api/v1/sync/requests` | dashboard | `syncRequests` | Recent sync requests. |
| GET | `/api/v1/sync/overview` | dashboard | `syncOverview` | Sync blocks overview. |
| GET | `/api/v1/pages/:pageLabel/sync/blocks` | canAccessPage | `pageSyncBlocks` | Per-page sync blocks. |
| GET | `/api/v1/pages/:pageLabel/sync/blocks/messages` | canAccessPage | `pageMessagesBlock` | Messages-stream sync block. |
| GET | `/api/v1/admin/sync/runs` | owner | `adminSyncRuns` | List sync runs. |
| GET | `/api/v1/admin/sync/runs/:runId` | owner | `adminSyncRunDetail` | Run detail w/ events + attempts (404 on unknown). |
| POST | `/api/v1/admin/sync/trigger` | owner | `adminSyncTrigger` | Enqueue a page sync (pg-boss); 202 `{accepted, pageLabel, scope}`. |
| POST | `/api/v1/admin/sync/trigger-all` | owner | `adminSyncTriggerAll` | Enqueue sync for all pages; 202 `{accepted, pagesQueued}`. |
| POST | `/api/v1/admin/sync/blocks/trigger` | owner | `adminSyncBlockTrigger` | Trigger one sync block (pg-boss). |
| POST | `/api/v1/admin/sync/blocks/pause` | owner | `adminSyncBlockPause` | Pause a sync block. |
| POST | `/api/v1/admin/sync/blocks/resume` | owner | `adminSyncBlockResume` | Resume a sync block (pg-boss). |
| POST | `/api/v1/admin/sync/blocks/reset` | owner | `adminSyncBlockReset` | Reset a sync block (pg-boss). |

### 4.9 Admin — users, API keys, catalog, connections

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/admin/users` | owner | `adminListUsers` | List users w/ api-key status. |
| POST | `/api/v1/admin/users` | owner | `adminCreateUser` | Create a user (audited). |
| PATCH | `/api/v1/admin/users/:username/password` | owner | `adminSetPassword` | Set password (revokes sessions). |
| POST | `/api/v1/admin/users/:username/pages` | owner | `adminAssignPage` | Assign a page to a user. |
| DELETE | `/api/v1/admin/users/:username/pages/:pageLabel` | owner | `adminUnassignPage` | Unassign a page. |
| GET | `/api/v1/admin/users/:username/api-keys` | owner | `adminListApiKeys` | List a user's API keys (prefix + metadata only). |
| POST | `/api/v1/admin/users/:username/api-keys` | owner | `adminIssueApiKey` | Issue a chatter key (returns raw key once; rotates prior keys). |
| DELETE | `/api/v1/admin/users/:username/api-keys` | owner | `adminRevokeApiKeys` | Revoke all of a user's keys; `{revokedCount}`. |
| GET | `/api/v1/admin/usage/chatters` | owner | `adminChatterUsage` | Aggregated AI usage per chatter. |
| GET | `/api/v1/admin/connections` | owner | `adminConnections` | Connection/verification status per page. |
| GET | `/api/v1/admin/models` | owner | `adminModels` | Admin model list. |
| POST | `/api/v1/admin/models` | owner | `adminCreateModel` | Create model (409 on duplicate slug). |
| PATCH | `/api/v1/admin/models/:modelSlug` | owner | `adminUpdateModel` | Update model. |
| DELETE | `/api/v1/admin/models/:modelSlug` | owner | `adminDeleteModel` | Delete model (409 if it still has pages). |
| GET | `/api/v1/admin/pages` | owner | `adminPages` | Admin page list. |
| POST | `/api/v1/admin/pages` | owner | `adminCreatePage` | Onboard a Fansly/OnlyFans page (verifies creds, enqueues initial sync). |
| PATCH | `/api/v1/admin/pages/:pageLabel` | owner | `adminUpdatePage` | Update page metadata. |
| DELETE | `/api/v1/admin/pages/:pageLabel` | owner | `adminDeletePage` | Delete page. |
| POST | `/api/v1/admin/credentials/verify` | owner | `adminVerifyCredentials` | Verify raw platform creds (calls platform APIs via proxy; returns username/displayName). |
| POST | `/api/v1/admin/proxy/test` | owner | `adminTestProxy` | Test a proxy by fetching `api.ipify.org`; returns egress `{ip}`. |
| POST | `/api/v1/admin/pages/:pageLabel/verify` | owner | `adminVerifyPage` | Re-verify a page's stored creds (light metadata refresh + incident recovery). |
| PATCH | `/api/v1/admin/pages/:pageLabel/credentials` | owner | `adminUpdateCredentials` | Rotate a page's stored credentials. |

### 4.10 Admin — diagnostics (raw SQL)

These four read the DB with hand-written `sql` (drizzle `db.execute`), not via the db package:

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/admin/logs` | owner | `adminLogs` | Sync-run events (query `severity`,`limit`); joins `sync_run_events`→`sync_runs`→`pages`; a specific `after_ineffective` error is normalized to `warn`. |
| GET | `/api/v1/admin/incidents` | owner | `adminIncidents` | Warn/error/anomaly events + 7-day summary by code. |
| GET | `/api/v1/admin/queue/jobs` | owner | `adminQueueJobs` | Reads `pgboss.job` (query `state`,`name`,`limit`). |
| GET | `/api/v1/admin/db/stats` | owner | `adminDbStats` | `pg_stat_user_tables` sizes + `schema_migrations`. |

### 4.11 Admin — config / feature flags

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/admin/config` | owner | `adminConfig` | Effective config view (`buildConfigView`) using the pre-boot env baseline. |
| PATCH | `/api/v1/admin/config` | owner | `adminConfigUpdate` | Live-edit config overrides. Rejects any key not `editable`+`runtimeApply:"live"` (`assertLiveEditableReloadKey`); validates/clamps; one atomic tx w/ `expectedVersion` (409 on conflict); folds registry cost-warnings into the audit note. |
| DELETE | `/api/v1/admin/config/:key` | owner | `adminConfigClear` | Clear one `editable` override (rejects staged/never keys); `expectedVersion` (409). |
| PATCH | `/api/v1/admin/config/staged` | owner | `adminConfigStaged` | Staged boot-flag flips; requires `ack:true` (400 otherwise); ordered enable/disable rules validated inside an advisory-locked tx (`commitStagedConfigChange`); mandatory `expectedVersion` (409); `desired:null` reverts to env. Takes effect only after restart. |

### 4.12 Admin — notifications (Telegram)

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/admin/notifications/settings` | owner | `notificationsSettings` | Telegram settings + derived connection state. |
| PATCH | `/api/v1/admin/notifications/settings` | owner | `notificationsSettingsUpdate` | Update settings; bot token encrypted at rest (`encryptJson`). |
| POST | `/api/v1/admin/notifications/test` | owner | `notificationsTestMessage` | Send a test Telegram message; logs a delivery attempt. |
| POST | `/api/v1/admin/notifications/discover-chats` | owner | `notificationsDiscoverChats` | Call Telegram `getUpdates` to list chat ids. |
| GET | `/api/v1/admin/notifications/incidents` | owner | `notificationsIncidents` | List notification incidents (status/kind/pageLabel filters). |
| POST | `/api/v1/admin/notifications/incidents/:incidentId/resolve` | owner | `notificationsResolveIncident` | Manually resolve an incident; sends a Telegram "Manually resolved". |
| GET | `/api/v1/admin/notifications/reports/preview` | owner | `notificationsReportPreview` | Preview the daily revenue Telegram report text. |
| POST | `/api/v1/admin/notifications/reports/send` | owner | `notificationsReportSend` | Send the daily revenue report now. |
| GET | `/api/v1/admin/notifications/reports/history` | owner | `notificationsReportHistory` | Last 50 daily-report delivery attempts. |

### 4.13 OFAPI — webhook, real-time, credits, read gateway, command outbox

| Method | Path | Guard | Schema | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/ofapi/webhook` | HMAC (no principal), rate-limited | `ofapiWebhookReceive` | Inbound webhook from onlyfansapi.com. Buffer-parsed body; auth by HMAC-SHA256 over raw bytes. See §6. |
| GET | `/api/v1/events/stream` | api-key | `eventsStream` | SSE fanout of sync events for the chatter's pages. See §6. |
| GET | `/api/v1/events/snapshot` | api-key | `eventsSnapshot` | Paginated durable sync-state snapshot for replay-gap recovery. |
| GET | `/api/v1/ofapi/credits/summary` | api-key | `ofapiCreditsChatterSummary` | Page-scoped OFAPI credit spend for the chatter (desktop). |
| GET | `/api/v1/ofapi/read/*` | api-key, 120/min | `ofapiReadGateway` | Allowlisted OFAPI read proxy (desktop compat). See §5. |
| POST | `/api/v1/ofapi/commands` | api-key, 60/min | `createOfapiCommand` | Enqueue a desktop OFAPI write command (outbox). 200 (dedup) or 202 (new); on 202 enqueues a pg-boss execute job. |
| GET | `/api/v1/ofapi/commands/:commandId` | api-key | `getOfapiCommand` | Get one owned command (no message text echoed). |
| POST | `/api/v1/ofapi/commands/:commandId/cancel` | api-key | `cancelOfapiCommand` | Cancel a queued command (idempotent). |
| GET | `/api/v1/admin/ofapi/webhook` | owner | `adminOfapiWebhookStatus` | Webhook registration + page mappings. |
| POST | `/api/v1/admin/ofapi/webhook` | owner | `adminOfapiWebhookRegister` | Register/re-register the team webhook at onlyfansapi.com; auto-maps accounts→pages by username; generates a new signing secret. |
| GET | `/api/v1/admin/ofapi/credits/summary` | owner | `adminOfapiCreditsSummary` | Global OFAPI credit balance/summary. |
| GET | `/api/v1/admin/ofapi/credits/daily` | owner | `adminOfapiCreditsDaily` | Daily credit spend (query `days`). |
| GET | `/api/v1/admin/ofapi/credits/ledger` | owner | `adminOfapiCreditsLedger` | Credit ledger rows. |
| GET | `/api/v1/admin/ofapi/credits/ledger.csv` | owner | `adminOfapiCreditsLedgerCsv` | CSV export (hijacked download; row-cap warning header). |
| GET | `/api/v1/admin/ofapi/spend/comparison` | owner | `adminOfapiSpendComparison` | Compare OFAPI spend vs. internal accounting. |
| GET | `/api/v1/admin/ofapi/dm-archive/status` | owner | `adminOfapiDmColdArchiveStatus` | DM cold-archive job status. |

---

## 5. External-client consumption map

**Browser extension + desktop chat workspace (chatter API-key, bearer).** The `requireApiKeyUser` and `api-key`-declared routes are the external-client surface:
- `POST /api/v1/ai-usage/batch`, `POST /api/v1/ai/gateway/stream` (AI usage reporting + AI generation proxy).
- `GET /api/v1/events/stream`, `GET /api/v1/events/snapshot` (real-time sync + snapshot recovery).
- `GET /api/v1/ofapi/credits/summary`, `GET /api/v1/ofapi/read/*`, `POST /api/v1/ofapi/commands` (+ get/cancel) — the OFAPI custody gateway that desktop clients use instead of talking to onlyfansapi.com directly.
- The `/api/v2/spenders*` and `/api/v2/fans/search` routes take only `requirePrincipal`, so an api-key chatter can call them too; the service scopes results by `principal.assignedPageIds`.

**Dashboard (session cookie).** Everything gated `dashboard` or `owner` (overview, revenue, growth, transactions, subscribers/followers, workboard, sync monitor, all `/admin/*`). The dashboard SPA is served same-origin from `apps/dashboard/dist` by the static plugin.

**No dedicated `/dev` routes exist in this file.** (The context's "any /dev routes" — none are declared here; the only non-`/api` surfaces are `/documentation*` (owner) and the SPA fallback at `/`.)

**AI gateway provider (outbound).** `prepareAiGatewayStream` (`services/ai-gateway.ts`) uses `appContext.aiGatewayProvider.provider`, typed `"anthropic" | "openrouter"` (`ai-gateway.ts:51`); Anthropic request cost is estimated via `estimateAnthropicGatewayRequestCost` (`ai-gateway.ts:181`). If no provider is configured it throws `ServiceUnavailableError` (503). The provider network call and SSE mechanics are Territory 14.

**OFAPI read gateway (outbound).** `executeOfapiReadGatewayRequest` (`services/ofapi-read-gateway.ts`) requires `config.ofapiDesktopReadGatewayEnabled` and `config.ofapiCreditLedgerEnabled` and `app.ofapi.proxyRead` (else 503). It only proxies an allowlist of OFAPI GET paths (chats, chat messages/media, users, transactions, fans, user-lists, vault media/lists, upload status); `/accounts` is synthesized from assigned core page→OFAPI-account mappings and `/whoami` is sanitized. No writes are exposed.

---

## 6. Boundary detail — OFAPI webhook + SSE fanout

**Inbound webhook (`POST /api/v1/ofapi/webhook`).** Counterpart: **onlyfansapi.com** (the OFAPI vendor). The route lives in an isolated plugin scope with a buffer body parser (`server.ts:1282-1311`). The handler passes to `receiveOfapiWebhook(appContext, boss, {rawBody, signatureHeader: headers.signature, idempotencyKeyHeader: headers["x-ofapi-idempotency-key"]})`. Per the schema doc (`routes.ts:3795-3809`): auth = HMAC-SHA256 of raw body (hex) in the `signature` header vs. the registered signing secret; dedup by `x-ofapi-idempotency-key`; body is the envelope `{event, account_id, payload}`, intentionally not schema-validated before signature check. Responses 200/400/401/429/503. Rate-limited per §3. The receiver enqueues pg-boss work; downstream projection is another territory.

**Outbound SSE (`GET /api/v1/events/stream`).** Counterpart: the **desktop app** (chatter api-key). Wire format: `text/event-stream`, frames `id: <fanoutSeq>\nevent: sync\ndata: <JSON SyncEvent>\n\n` (`server.ts:1436`), preceded by `retry: 3000`. Resume via `Last-Event-ID` header or `?lastEventId=` query. Behavior of note:
- Frames are filtered to `principal.assignedPageIds` (`server.ts:1351`).
- If the requested cursor is ahead of, or older than the retained replay window (from `getOfapiFanoutReplayWindow`), the route returns **409** `{error:"sync_snapshot_required", requestedSeq, oldestAvailableSeq, currentSeq, snapshotPath:"/api/v1/events/snapshot"}` (`server.ts:1366-1397`).
- Journal replay pages 500 rows at a time via `listOfapiSyncEventsForReplay`, deduped against live frames by a monotonic seq guard (`server.ts:1422-1539`).
- Heartbeat every 25 s; **auth re-validation every 60 s** (re-runs `authenticateApiKeyToken`; closes the stream if the key is revoked or the page assignment set changes); hard max lifetime **15 min**; a client buffered >1 MB is dropped (`server.ts:1324-1489`).

**`GET /api/v1/events/snapshot`.** Returns durable sync state via `getOfapiSyncSnapshot` for one assigned OFAPI account, paginated by `snapshotCursor`/`pageCursor`; performs no OFAPI calls.

---

## 7. Other boundaries touched by routes in this file

- **pg-boss (outbound queue).** A dedicated `PgBoss` on `config.databaseUrl` is started in the API process (`server.ts:1259-1276`), ensures sync/OFAPI/OFAPI-command queues, and logs (not throws) on connection errors. Routes that enqueue: `/admin/sync/trigger`, `/admin/sync/trigger-all`, `/admin/sync/blocks/{trigger,resume,reset}`, `/admin/pages` (initial onboarding sync), `/ofapi/commands` (execute job), and the webhook receiver. If `boss` is null, sync-trigger routes throw and onboarding returns a `syncQueued:false` warning payload (`server.ts:1743-1775`).
- **Postgres (direct reads/writes).** Most routes go through the db package; four `/admin/*` diagnostics run raw `sql` (§4.10) against `sync_run_events`, `sync_runs`, `pages`, `pgboss.job`, `pg_stat_user_tables`, `schema_migrations`, `notification_incidents`.
- **Telegram (outbound).** `/admin/notifications/*` routes call `sendTelegramTestMessage`, `discoverTelegramChats` (getUpdates), `sendTelegramMessage`, and the daily-report senders; each real send writes a `delivery_attempts` row. Bot token is encrypted with `encryptJson(token, config.encryptionKey, config.encryptionKeyVersion)` before storage.
- **Platform APIs (outbound, via proxy).** `/admin/credentials/verify` calls Fansly (`appContext.adapter.verifySession`) or OnlyFans (`findOnlyFansAccountByUsername`) through a normalized proxy + rate-limit waiter; `/admin/proxy/test` fetches `https://api.ipify.org?format=json` through the candidate proxy to prove egress IP; `/admin/pages` onboarding and `/admin/pages/:pageLabel/verify` refresh page metadata against the platform. Proxy targets are checked with `assertAllowedProxyTarget` (SSRF guard) and error messages are passed through `redactSensitiveText`.
- **Secrets/credentials handled here.** Session cookie value, chatter API keys (raw returned once at issuance), the `x-monitoring-token`, Telegram bot token (encrypted), and platform session/auth blobs submitted to verify/onboard/credentials routes. `config.encryptionKey` + `encryptionKeyVersion` used for at-rest encryption.

---

## 8. Discrepancies & notes

- **`/api/v1/ai-usage/batch` guard location.** The route handler (`server.ts:697`) calls only `requirePrincipal`; the api-key restriction is enforced *inside* `ingestAiUsageBatch` (`ai-usage.ts:79`). A reader scanning `server.ts` alone would not see the api-key gate. Net runtime behavior matches the schema's `bearerOnlySecurity`.
- **Schema `security` is documentation-only.** The `security:` field on each `routeSchemas.*` entry feeds OpenAPI's securitySchemes; it does **not** enforce anything. Enforcement is the guard the handler calls. They are consistent across the surface except where noted above.
- **`/api/v2/spenders*` and `/api/v2/fans/search` are not role-gated at the route** — only `requirePrincipal`. Both session and api-key principals reach them; scoping is delegated to the service via `principal`. (`spenderSeries` is the exception — it is `dashboard`-gated.)
- **Two API version prefixes coexist:** `/api/v1/*` (the bulk) and `/api/v2/*` (spenders + fans search only).
- **`/api/v1/overview` is a fat inline handler** (`server.ts:1778-1961`) that performs many sequential/parallel DB reads and money math in `bigint` mills, rather than delegating to a single reporting service like its siblings.
- **Post-hijack error invisibility.** For the three hijacked responses (ai/gateway/stream, events/stream, ledger.csv) and their `raw.write`s, the global error handler cannot send a JSON error once headers are written; failures are logged and the socket is ended/destroyed.
