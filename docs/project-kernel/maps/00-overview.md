> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 00 — Overview & Map Index

**Scope.** This document is the top-level map for the `core` backend territory docs. It states what
`core` is, describes its three OS-process roles, narrates the end-to-end data flow (platform ingest →
Postgres → HTTP/SSE → consumers) naming the key files at each hop, indexes every territory doc
(`01`–`18`, including `07b`), defines the cross-cutting domain glossary, and lists the technology
stack. It is a synthesis/navigation layer: every non-trivial claim here is anchored either to a source
file or to the territory doc that documents it in full. Sources read on disk for this overview:
`docs/project-kernel/01-runtime-and-processes.md`, `02-http-api-surface.md`, `06-sync-engine.md`,
`07-ofapi-transport-and-commands.md`, `09-financial-spend-credits.md`, and the digests of all other
territory docs. Facts stated as verified were checked directly against
`apps/runtime/src/startup.ts`, the workspace `package.json` files, and `packages/shared/src/money.ts`.

---

## 1. What `core` is

`core` (`/Users/dmitriy/code/core`, package `agency_hub_core`) is the **backend hub** of an
OnlyFans/Fansly agency stack — a Node.js/TypeScript pnpm monorepo. It ingests creator-account data
from the platforms (OnlyFans via the third-party **OFAPI** gateway at onlyfansapi.com and via the
**OnlyMonster** aggregator at omapi.onlymonster.ai; Fansly directly at apiv3.fansly.com), stores it in
one **Postgres** database, and serves it back to three consumers:

1. a **React dashboard** SPA (session-cookie auth), served same-origin from `apps/dashboard/dist`
   (documented in territory `16`);
2. a **desktop chat workspace** ("ChatMuse"/"ChatGoose") and a **browser extension** (each a separate
   project, chatter **API-key** auth) that consume the real-time SSE sync stream, the AI-generation
   gateway, the OFAPI read gateway, and the OFAPI command outbox;
3. **Telegram** (outbound only) for daily revenue reports and operational incident alerts.

In the three-project ecosystem, `core` is the sole owner of platform credentials, the Postgres store,
the OFAPI spend/credit accounting, and the sync/projection engine; the desktop app and extension are
thin clients that hold a chatter API key and talk only to `core`'s HTTP/SSE surface — they never
contact OnlyFans/Fansly/OFAPI directly (the OFAPI read gateway and command outbox exist specifically to
proxy those on the clients' behalf; territories `02`, `07`).

Money for fan spend is stored as integer **mills** (`1 mill = $0.001`, so `$1 = 1000 mills`), verified
in `packages/shared/src/money.ts` (`millsToDecimalString` divides by `1000n`). A second, unrelated
"credits" currency meters what `core` pays OFAPI for API calls (territory `07`/`09`).

---

## 2. Process model

There are three logical roles reachable through four entry files under `apps/runtime/src/`
(full detail in territory `01`):

| Role | Entry file | pnpm script | Production invocation | What it runs |
|---|---|---|---|---|
| dispatcher | `startup.ts` | — | Docker `CMD` `node apps/runtime/dist/startup.js {api\|worker}` | Runs migrations under advisory lock `pg_advisory_lock(31415, 27182)`, then dispatches to api or worker by role (`startup.ts:35` `resolveRole` = `argv[2] ?? AGENCY_HUB_ROLE ?? "worker"`; verified). |
| **api** | `api.ts` → `api-runtime.ts` | `api`, `api:watch` | via `startup.ts` | One Fastify HTTP server (`buildApiServer`, `api/server.ts:423`); its own **enqueue-only** PgBoss; the SSE sync-event hub; the runtime heartbeat. Serves the SPA + all routes. Never consumes a queue. |
| **worker** | `worker.ts` → `worker-runtime.ts` + `worker-services.ts` | `worker`, `worker:watch` | via `startup.ts` | The single PgBoss **consumer**: sync planner + custom page-execute fetch loop, OFAPI event/credit/command/dm-analytics workers, workboard recompute/classify, Telegram daily-report, raw-payload cleanup. Fail-fast: its pg-boss `error` handler calls `process.exit(1)`. |
| **cli** | `cli.ts` | `cli` | ad hoc / admin | Commander program (`model`/`page`/`sync`/`queue`/`telegram`/`user`/`apikey` + backfills/reports). Each command builds its own `AppContext`, spins an **ephemeral** PgBoss to enqueue (never consumes), then closes. |

**Composition root.** All three roles call `createAppContext()` (`bootstrap.ts:109`), which loads
config (`loadConfig`, `packages/shared/src/config.ts:311`), runs the schema-drift gate
(`assertRuntimeSchemaReady`, `packages/db/src/schema-guard.ts`), builds the node-postgres `Pool` +
Drizzle `db`, and constructs the platform clients: `FanslyAdapter` (`app.adapter`), `OnlyFansAdapter`
(`app.onlyFansAdapter`, → OnlyMonster), the OFAPI client (`app.ofapi`, only when `OFAPI_API_KEY` set),
and the Anthropic AI-gateway provider (`app.aiGatewayProvider`, only when
`CHATMUSE_AI_GATEWAY_ENABLED && ANTHROPIC_API_KEY`). The `AppContext` is threaded through every
service.

**Cross-process invariants** (territory `01` §10): one migration writer at a time (advisory lock
`31415/27182`); exactly one OFAPI event consumer (advisory lock `58211/1` + `OFAPI_EVENT_WORKER_REPLICAS
=== 1`); api/cli enqueue while only the worker registers `boss.work`; heartbeats advertise liveness
only after the api socket listens / after the worker's queues consume.

---

## 3. Top-level data flow

Data moves platforms → ingest → projections → Postgres → HTTP/SSE → consumers. Two ingest paths feed
the same store; several projection layers derive read models; the HTTP/SSE surface serves them out.

### 3.1 Ingest (inbound, worker + api)

**Path A — pull sync (worker).** The planner (`sync/planner.ts` `runSyncPlannerCycle`, on a minutely
`sync.planner` pg-boss cron) advances the per-`(page, stream)` state machine `page_sync_states` and
enqueues one `sync.page.execute` wakeup per runnable page. The executor
(`sync/executor.ts` `startSyncPageExecutor`, a hand-rolled `boss.fetch` loop with per-provider+egress
group concurrency) leases the highest-priority runnable stream and runs one bounded **chunk** of its
handler (`sync/executor-handlers.ts`). Handlers make the **outbound** platform reads:

- **Fansly** via `app.adapter` → `https://apiv3.fansly.com/api/v1` (session auth; account, subscribers,
  followers, transactions, earnings, messaging groups/messages). Territory `08`.
- **OnlyFans via OnlyMonster** via `app.onlyFansAdapter` → `https://omapi.onlymonster.ai`
  (`x-om-auth-token`; account, tracking/trial-link users, transactions, chargebacks, chat messages).
  Territory `08`.
- **OnlyFans via OFAPI** via `app.ofapi` → `https://app.onlyfansapi.com/api` (`Bearer OFAPI_API_KEY`;
  `listChats`, `listChatMessages`, `listActiveFans`, `listTransactions`, `pingBalance`) — credit-metered,
  UTC-day-budget-reserved. Territory `07`.

All outbound platform HTTP goes through per-page proxy/egress dispatchers (undici, territory `15`
`http-client.ts`), an SSRF guard, a shared DB-backed rate-limit waiter (`sync_rate_limits`), and
per-attempt telemetry that lands in `sync_runs` / `sync_http_attempts` / `sync_run_events` /
`sync_raw_payloads` (territory `06`).

**Path B — webhook ingest (api).** OFAPI pushes real-time events to `POST /api/v1/ofapi/webhook`
(`ofapi-webhooks.ts` `receiveOfapiWebhook`). The body is parsed as a **raw Buffer**, authenticated by
`HMAC-SHA256` (`signature` header, current+previous secret), deduped on `x-ofapi-idempotency-key`, and
journaled to `ofapi_webhook_events`; the api's enqueue-only boss then enqueues
`ofapi.events.process.v2`. The single-replica worker settles each row
(`ofapi-events.ts` `processOfapiWebhookEvent`), assigning a settle-ordered `fanout_seq`, deriving a
`SyncEvent` frame (`mapOfapiEventToSyncEvent`), and firing `pg_notify('ofapi_sync_events', rowId)`.
Territories `07`, `14`.

### 3.2 Projections (derive read models from ingested rows)

- **OFAPI webhook → DM / subscription / presence / spend** projections run as post-settle hooks +
  minutely sweeps off the `ofapi_webhook_events` journal, writing `page_dm_threads`/`page_dm_messages`,
  `dm_message_archive`, `page_subscriptions`/`page_fans`/`fans`, presence columns, and the shadow
  `ofapi_spend_projection_events`. Territory `07b`.
- **Financial rollups**: every transaction writer converges on `upsertTransaction` (`transactions`
  table), then rebuilds `revenue_daily`, `fan_spend_daily`, `fan_spend_lifetime` (denormalized onto
  `page_fans.total_creator_net_mills`), and `page_fan_identities` (top spenders), gated by
  `spender_projection_watermarks`. Territory `09`.
- **OFAPI credit ledger**: every OFAPI response reports spend to a sink that writes `ofapi_credit_ledger`
  + bumps `ofapi_credit_state`, plus daily accrual/reconciliation jobs. Territory `07`/`09`.
- **Workboard**: nightly `workboard.recompute` scores `workboard_state` from fans/spend/DM tables; a
  Haiku "closing classifier" writes `wb_closing_cache`. Territory `11`.

### 3.3 Storage (the one boundary everything crosses)

A single Postgres database (node-postgres `Pool` + Drizzle, `packages/db/src/client.ts`; a global
`setTypeParser(20)` returns all `bigint` columns as JS `BigInt`). 61 tables / 25 enums defined in
`packages/db/src/schema.ts`; hand-written numbered migrations `0000`–`0051`
(`packages/db/src/migrate-runner.ts`, applied under advisory lock; `db:generate` is deliberately
disabled). Schema catalog is territory `04`; repositories/migrations territory `05`. pg-boss also lives
in this database (18 queues; enqueue in api/cli, consume in worker).

### 3.4 Serve out (outbound to consumers)

- **HTTP API** — Fastify server `apps/runtime/src/api/server.ts` (~3,584 lines), routes declared with
  Zod contract schemas in `packages/contracts/src/routes.ts` and registered directly with
  `server.get/post/...`. Two prefixes coexist: `/api/v1` (bulk) and `/api/v2` (spenders + fans-search).
  Auth is session-cookie (owner/team_lead) or bearer API-key (chatter); guards in
  `apps/runtime/src/services/auth.ts`. Territory `02`; contracts + codegen territory `03`; auth/config
  territory `13`.
- **SSE sync stream** — `GET /api/v1/events/stream` (chatter key): the api-process hub
  (`services/events-stream.ts`) `LISTEN`s on `ofapi_sync_events`, drains the journal in `fanout_seq`
  order, and writes `event: sync` frames filtered to the caller's assigned pages, with `Last-Event-ID`
  resume and a `409 sync_snapshot_required` gap path backed by `GET /api/v1/events/snapshot`. Territory
  `14`.
- **SSE AI gateway** — `POST /api/v1/ai/gateway/stream` (chatter key): proxies one generation to
  Anthropic (`@anthropic-ai/sdk`, egressing through the page's proxy) and streams `event: ai` frames;
  writes a terminal usage/cost row to `ai_usage_events`. Territory `10`.
- **OFAPI custody gateway** — `GET /api/v1/ofapi/read/*` (allowlisted read proxy) and
  `POST /api/v1/ofapi/commands` (write outbox → `ofapi_commands` → executor → OFAPI POST/DELETE).
  Territory `07`.
- **Dashboard SPA** — served by `@fastify/static` from `apps/dashboard/dist` at `/` with SPA fallback,
  same-origin so the session cookie flows without CORS. The dashboard uses React Query polling, no SSE.
  Territory `16`.
- **Telegram** — daily revenue report (image via Playwright, plain-text fallback) + incident alerts;
  bot token encrypted at rest. Territory `12`.

### 3.5 Boundaries at a glance

| Boundary | Direction | Counterpart | Documented in |
|---|---|---|---|
| Fastify HTTP API (`/api/v1`, `/api/v2`) + SPA | inbound | Dashboard (cookie), desktop/extension (api-key) | `02`, `03`, `13`, `16` |
| `POST /api/v1/ofapi/webhook` (HMAC, raw body) | inbound | onlyfansapi.com (OFAPI) | `07`, `14` |
| `GET /api/v1/events/stream` (SSE `sync`) | outbound/stream | Desktop app | `14`, `07` |
| `POST /api/v1/ai/gateway/stream` (SSE `ai`) → Anthropic | outbound/stream | Desktop app ↔ api.anthropic.com | `10`, `14` |
| OFAPI REST (reads, command writes, webhook CRUD) | outbound | onlyfansapi.com | `07`, `09` |
| Fansly REST | outbound | apiv3.fansly.com | `08`, `06` |
| OnlyFans via OnlyMonster REST | outbound | omapi.onlymonster.ai | `08`, `06` |
| OnlyFans.com public profile (headless Playwright) | outbound | onlyfans.com | `08` |
| Telegram Bot API | outbound | api.telegram.org | `12` |
| Postgres (Drizzle + pg-boss) | storage/queue | one database | `04`, `05`, `01` |

---

## 4. Map index

One row per territory doc under `docs/project-kernel/`. Read a territory doc for the full,
line-anchored account of its boundary.

| Doc | Title | One-line description |
|---|---|---|
| `00-overview.md` | Overview & Map Index | This document: ecosystem role, process model, data flow, index, glossary, stack. |
| `01-runtime-and-processes.md` | Runtime, Processes & Composition | Boot/dispatch (`startup.ts`), `createAppContext`, api/worker/cli runtimes, the complete pg-boss job/schedule surface, health/heartbeat/schema-gate. |
| `02-http-api-surface.md` | HTTP API Surface | The Fastify server: plugins, per-request auth/roles/guards, rate limits, and the complete ~130-route catalog with its boundaries (webhook, SSE, OFAPI gateway). |
| `03-contracts-and-codegen.md` | API Contracts & Client Codegen | `packages/contracts` Zod request/response schemas (`routeSchemas`), the `contracts:generate` pipeline → OpenAPI 3.1 + `api-types.ts`, shared value vocabulary. |
| `04-database-schema.md` | Database Schema | `packages/db/src/schema.ts`: 61 tables, 25 enums, FKs, scoping keys, money-unit and naming discrepancies — the Postgres storage boundary by column. |
| `05-db-repositories-and-migrations.md` | DB Repositories, Client & Migrations | The pg `Pool`/Drizzle client, the numbered-SQL migration runner + schema-guard, and all 27 repository modules + consistency primitives (advisory locks, `FOR UPDATE`, watermarks). |
| `06-sync-engine.md` | Sync Engine | The pull-ingest pipeline: planner → `page_sync_states` FSM → executor → per-stream handlers; cursors, leases, rate limits, chunk budgets, observability, sync-health endpoints. |
| `07-ofapi-transport-and-commands.md` | OFAPI Transport, Webhooks & Commands | The onlyfansapi.com boundary: HTTP client + credit metering, inbound webhook receiver, event settle/fanout, desktop read gateway, command outbox/executor, account health. |
| `07b-ofapi-projections.md` | OFAPI Projections | Webhook/sync → storage: DM thread/message projection + cold archive, presence, subscription projection, sync snapshot read model, REST DM/audience sync, DM daily analytics. |
| `08-platform-adapters.md` | Platform Adapters | Outbound OnlyMonster + Fansly REST adapters (GET-only), the OnlyFans.com Playwright profile resolver, credential/proxy assembly, onboarding/connections/proxy management. |
| `09-financial-spend-credits.md` | Transactions, Spend, Reporting & OFAPI Credits | The money model (mills), the canonical `transactions` upsert + 4 ingest paths, derived revenue/spend rollups + top spenders, reporting/spender services, and the separate OFAPI credit ledger + spend-projection shadow. |
| `10-ai-gateway-and-usage.md` | AI Gateway & Usage Ledger | `POST /ai/gateway/stream` → Anthropic Messages API (per-page proxy), the `/ai-usage/batch` client ledger, `ai_usage_events` (dual-mode), pricing/cost, chatter usage report. |
| `11-workboard.md` | Workboard (v1 & v2) | The chatter task board: v1 report + v2 priority-scoring engine, closing classifier (L1 + L2 Haiku), recompute/classify jobs, and the workboard tables. |
| `12-telegram-notifications.md` | Telegram Reports & Notification Incidents | The Telegram Bot API boundary (sendMessage/sendPhoto/getUpdates), the daily revenue report + hourly self-gating schedule, and `notification_incidents` detection/orchestration. |
| `13-auth-config-and-access.md` | Auth, Access Control & Runtime Config | Roles/sessions/API-keys (argon2id, sha256 digests), authz guards, per-page scoping, `loadConfig` + descriptor registry, live/staged/boot config overrides, secrets held by config. |
| `14-events-and-streaming.md` | Events & SSE Streaming | The three streaming surfaces: the OFAPI sync-event pipeline (fanout_seq ordering, LISTEN/NOTIFY hub, `/events/stream` + `/events/snapshot`), workboard-presence poll, and the AI-gateway SSE. |
| `15-shared-package.md` | Shared Package (`@agency_hub_core/shared`) | Cross-cutting primitives: mills math, AES-256-GCM secret envelope, undici dispatcher factory + retry/SSRF/redaction, time/business-date helpers, types, the server/browser split. |
| `16-dashboard-frontend.md` | Dashboard Frontend | The React/Vite SPA consumer: routing, cookie auth, the typed API client + full outbound endpoint catalog, credential-submission + CSV-download + config-write boundaries. |
| `17-infra-and-devops.md` | Infrastructure, Build & Deployment | The Docker image, esbuild production bundler, compose topologies, script catalog, migrate-on-deploy flow, CI, env-var catalog, and the deploy/health boundaries. |
| `18-tests-and-fixtures.md` | Test Suite & What It Pins Down | Vitest config + unit/Testcontainers/socket split, shared test infra, the boundary-to-test map, subsystem clusters, and the fixture roots. |

---

## 5. Glossary

Domain terms used across the territory docs:

- **mills** — the fan-spend money unit; `1 mill = $0.001`, `$1 = 1000 mills`; stored as `bigint`,
  emitted as JSON numbers via `millsToNumber` (`packages/shared/src/money.ts`). Distinct from **cents**
  (used on `page_dm_messages.total_tip_amount_cents`) and **micro-USD** (used on
  `ai_usage_events.cost_micro_usd` and OFAPI credit pricing; `1 mill = 1000 micro-USD`).
- **credits** (OFAPI) — an unrelated currency metering what `core` pays OFAPI per API call; positive =
  spent, negative = added; tracked in `ofapi_credit_ledger`/`ofapi_credit_state` (territory `07`/`09`).
  Not fan money.
- **page** — one creator account on one platform (`pages` table); the FK target of ~40 child tables.
  Note the naming trap (territory `04`): the child-table column `platform_account_id` is the internal
  `pages.id` FK, but on `pages` itself the TS prop `platformAccountId` maps to the external id column
  `external_page_id`.
- **model** — a person/brand (`models` table) who may own several pages; pages carry `model_id`.
- **fan** / **spender** — a subscriber/payer. Global identity in `fans` (keyed
  `(platform, platform_user_id)`); per-page rollup in `page_fans`; "spender" = a fan viewed through the
  spend/analytics lens (`fan_spend_*`, `page_fan_identities`).
- **stream** — a per-page unit of sync work (`syncStreamEnum`: `light`, `transactions`, `fan_identities`,
  `top_spenders`, `subscribers`, `followers`, `followers_reconcile`, `dm_conversations`, `dm_messages`);
  the sync FSM is one row per `(page, stream)` in `page_sync_states` (territory `06`).
- **OFAPI** — onlyfansapi.com, the third-party gateway fronting OnlyFans (reads, real-time webhooks,
  and message writes). The `core`↔OFAPI boundary is territory `07`. Not to be confused with
  **OnlyMonster** (omapi.onlymonster.ai), a separate OnlyFans aggregator behind `OnlyFansAdapter`
  (territory `08`).
- **egress** — the outbound network path for a page's platform calls, typically a per-page proxy
  (`egress_endpoints`, undici dispatcher). Guarded against SSRF; keyed by an `egressKey` that is also
  the shared rate-limit scope (territory `15`, `06`).
- **projection** — a derived read model recomputed from raw/journal rows: OFAPI webhook →
  DM/subscription/presence/spend projections (territory `07b`), and transactions → revenue/spend
  rollups (territory `09`).
- **workboard** — the chatter-facing prioritized task board of fans to contact; v2 is a scoring engine
  writing `workboard_state`, with a "closing classifier" verdict cache (territory `11`).
- **closing** — the LLM classifier (L1 heuristic + L2 Haiku) that decides whether a DM thread needs a
  reply / is "closed", caching verdicts in `wb_closing_cache` (territory `11`).
- **run** / **attempt** — a **run** is one executor chunk of one stream (`sync_runs`, with outcome +
  `stats`); an **attempt** is one HTTP call within a run, retry-granular (`sync_http_attempts`, written
  by functions named `insertSyncRequestAttempt`). Territory `06`.
- **watermark** / **cursor** — a **cursor** is per-stream resumable pagination state
  (`page_sync_cursors`, accessed by functions named `getCheckpoint`/`upsertCheckpoint`); a **watermark**
  is a rebuild boundary (`spender_projection_watermarks`, `projection_watermarks`) or the SSE
  high-water `fanout_seq`. Territories `06`, `09`, `14`.
- **fanout_seq** — the SSE ordering key/event id, assigned from a SQL sequence at webhook-event
  **settle** time (not receive time) so late settles land ahead of an advanced `Last-Event-ID`
  (territory `14`, `07`).
- **scope keys** — cross-cutting scoping identifiers: a principal's `assignedPageIds` (which pages a
  user may access; owner = all), the `pageScopeFor(principal)` filter, config override
  `(scope_type=global, scope_id=0, key)`, and the pg-boss sync group id
  `buildSyncPageExecuteGroupId(provider, egressKey)`. Territories `13`, `02`, `06`.

---

## 6. Technology stack

Verified from the workspace `package.json` files:

- **Fastify 5** (`fastify ^5.8.5`) with `@fastify/cookie`, `@fastify/static`, `@fastify/swagger`(-ui),
  and `@fastify/rate-limit` — the HTTP server and SPA host.
- **Zod 4 contracts** (`zod ^4.1.5`) via `fastify-type-provider-zod ^6.1.0`; OpenAPI/type codegen via
  `openapi-typescript ^7.13.0` + `zod-to-json-schema`.
- **Drizzle ORM** (`drizzle-orm ^0.45.2`) over **node-postgres** (`pg ^8`); `drizzle-kit` present but
  `db:generate` is deliberately disabled (hand-written SQL migrations).
- **pg-boss 12** (`pg-boss ^12.14.0`) — Postgres-backed job queues (18 queues), sharing the app database.
- **React 19 / Vite 6 dashboard** (`react ^19.1.0`, `vite ^6.3.5`, `@vitejs/plugin-react`).
- **argon2** (`argon2 ^0.44.0`) — password hashing (argon2id), `apps/runtime/src/services/auth.ts`.
- **undici 7 + socks** — outbound HTTP dispatcher/proxy factory (`packages/shared/src/http-client.ts`).
- **@anthropic-ai/sdk** (`^0.100.1`) — the AI provider client (Anthropic Messages API); the only wired
  provider despite an `openrouter` value in the enums.
- **Playwright** (`playwright ^1.60.0`, chromium) — the OnlyFans.com public-profile resolver and the
  Telegram daily-report image renderer.
- **pino** — structured logging with credential redaction (`packages/shared/src/logger.ts`).
- **esbuild** (`esbuild 0.25.12`) — the production server bundler (`scripts/build-production.mjs`).
- **Testcontainers** (`testcontainers ^11.7.2`) + **Vitest 3** — integration tests against a real
  `postgres:16` container; unit tests via Vitest (territory `18`).
- **tsx / TypeScript 5.8** — the run/typecheck toolchain (`node --import tsx/esm ...`).

**Discrepancy — env loading is plain `dotenv`, not dotenv-vault.** The dependency is `dotenv ^17.2.3`
(in `packages/shared` and `apps/runtime`); a repo-wide grep finds **no** `dotenv-vault` dependency, no
`DOTENV_KEY`, and no `.env.vault` file. Config is read from a plain unencrypted `.env`
(`packages/shared/src/config.ts`); the only related env var is `DOTENV_CONFIG_QUIET`. This matches the
findings in territories `13` and `17` and contradicts any "dotenv-vault / encrypted-env" description.
Secrets at rest (platform sessions, proxy auth, Telegram bot token, OFAPI signing secret) are instead
protected by an application-level AES-256-GCM envelope keyed from `APP_ENCRYPTION_KEY`
(`packages/shared/src/crypto.ts`, territory `15`), not by an env-encryption layer.
