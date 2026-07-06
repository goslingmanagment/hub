> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Overview & Map Index — `core` (the kernel)

This is the top-level map of the `core` backend, regenerated after the Project
Kernel migration (stages 1–35). It states what `core` is, its four process
roles, the end-to-end data flow, an index of every territory document in
`docs/generated/`, the domain glossary, and the technology stack. Every
non-trivial claim is either anchored to a source file or delegated to the
territory doc that documents it in full. This is a synthesis/navigation layer;
read a territory doc for the line-anchored account of its boundary.

## 1. What `core` is

`core` (`/Users/dmitriy/code/core`, package `agency_hub_core`) is the central
backend of an OnlyFans/Fansly agency stack — a Node.js/TypeScript pnpm monorepo
(ESM, TS strict). It owns all platform credentials, the one Postgres store, the
money ledgers, the AI-generation gateway, the sync/projection engine, and the
owner console. Its clients — the ChatGoose desktop app (OnlyFans), the ChatGoose
Firefox extension (Fansly), and the in-repo dashboard — are "userspace": they
hold no vendor keys, assemble no prompts, and compute no money. Everything
privileged happens here, behind the generated SDK.

Platform integrations after the migration:
- **Fansly** — direct REST to `https://apiv3.fansly.com/api/v1` via the
  `packages/fansly` adapter (pasted browser session, page-scoped proxy egress).
- **OnlyFans** — mediated entirely through the third-party **OFAPI** gateway
  (`https://app.onlyfansapi.com/api`): reads, real-time webhooks, and message
  writes. The kernel holds only the vendor API key. The **OnlyMonster**
  aggregator that Pass 1 documented is **retired**; `packages/onlyfans` is an
  empty stub (`08-platform-adapters-and-egress.md`).

Two money units, never mixed without an explicit converter (`packages/shared/src/money.ts:1-12`):
platform/fan money is **mills** (`bigint`, 1 mill = $0.001); AI-plane spend is
**micro-USD** (`integer`, JS number). A third, unrelated "credits" currency meters
what `core` pays OFAPI per API call (`09-ofapi-boundary.md`).

## 2. Process model (four roles)

`apps/runtime/src/startup.ts` runs migrations under advisory lock
`pg_advisory_lock(31415, 27182)` then dispatches by role
(`startup.ts:36-61`; role = `argv[2] ?? AGENCY_HUB_ROLE ?? "worker"`):

| Role | Entry | What it runs |
|---|---|---|
| **api** | `api-runtime.ts` | One Fastify HTTP server (`buildApiServer`), enqueue-only pg-boss (`schedule:false`), the SSE hubs, the SPA host, the heartbeat. Never consumes a queue. |
| **worker** | `worker-runtime.ts` | The pg-boss consumer: sync planner + page-execute loop, OFAPI event/credit/command/dm-analytics workers, canonicalize/projection/tiering sweeps, workboard recompute, telegram report. Fails fast (`process.exit(1)`). |
| **scheduler** | `scheduler-runtime.ts` | Stage 25: the single leader-elected owner of cron registration + pg-boss timekeeping (advisory lock 58212/1). Api and workers run `schedule:false`. |
| **cli** | `cli.ts` | Commander admin program (model/page/sync/user/apikey + tiering/erasure/backfills/reports); builds an ephemeral AppContext, enqueues, closes. |

All roles build the composition root `createAppContext()` (`bootstrap.ts:130`):
config → schema-drift gate → pg `Pool` + Drizzle → the Fansly adapter, the OFAPI
client (when keyed), and the two AI-gateway providers (Anthropic + OpenRouter,
each when keyed). Detail: `01-runtime-and-processes.md`.

## 3. Top-level data flow

Data moves platforms → capture → canonicalization → projections → Postgres →
HTTP/SSE → consumers. The migration inserted a **capture-first spine** between
ingest and read models.

1. **Ingest (two paths).** Pull sync (worker): the planner advances the
   per-`(page, stream)` FSM `page_sync_states` and the executor runs bounded
   chunks of per-stream handlers, registry-dispatched per platform
   (`07-sync-engine.md`, `08-platform-adapters-and-egress.md`). Webhook ingest
   (api): OFAPI pushes to `POST /api/v1/ofapi/webhook`, HMAC-verified and
   journaled (`09-ofapi-boundary.md`).
2. **Capture (DP 7).** Every business fact is journaled verbatim into the
   append-only, partitioned `observations` before any parsing — six producer
   sources (`06-capture-and-canonicalization.md`). Nothing that captured a fact
   is deleted on a schedule (retention is effectively 100 years;
   `18-retention-erasure-tiering.md`).
3. **Canonicalize.** A minutely sweep replays observations →
   `domain_events` (gapless per-account seq, content-hash dedup)
   (`06-capture-and-canonicalization.md`).
4. **Project.** Rebuildable read models derive from events/journals: DM
   threads/archive, presence, subscriptions, spend (`10-ofapi-projections.md`);
   transactions → revenue/spend rollups + top spenders
   (`13-financial-and-money.md`); message-archive / fan-earnings / ai-acceptance
   (`06`); workboard state (`14-workboard.md`).
5. **Serve out.** The Fastify API + two SSE stacks (`02-http-api-surface.md`,
   `11-events-and-streaming.md`), the AI gateway (`12-ai-gateway-and-prompts.md`),
   the OFAPI read gateway + command outbox (`09`), the dashboard SPA
   (`20-dashboard-frontend.md`), and outbound Telegram (`16-telegram-notifications.md`).

## 4. Map index

| Doc | Territory |
|---|---|
| `00-overview.md` | This document: role, data flow, index, glossary, stack. |
| `01-runtime-and-processes.md` | Boot/dispatch, `createAppContext`, the four runtimes, leader election, the full pg-boss/cron surface, heartbeat, health, CLI, errors. |
| `02-http-api-surface.md` | The Fastify server shell, plugins, the declarative auth middleware, the ten route modules, error handler, SPA serving. |
| `03-contracts-and-codegen.md` | `packages/contracts` Zod registry + auth policy, `contracts:generate` → OpenAPI + authorization-policy + `@kernel/sdk`, `vendor-sdk.mjs`, the contract hash and drift gates. |
| `04-database-schema.md` | `schema.ts`: 77 tables + 23 enums by domain, money units per column, partitioning, the platform_account_id naming trap. |
| `05-db-repositories-and-migrations.md` | The pg/Drizzle client, the forward-only migrate-runner + schema guard, migrations 0000–0074, the repository layer. |
| `06-capture-and-canonicalization.md` | The observations journal (DP 7), all producers, the canonicalizer families, `domain_events` (gapless seq + content-hash dedup), the projections, the ingest lane. |
| `07-sync-engine.md` | Planner → `page_sync_states` FSM → executor → per-stream handlers; leases, chunk budgets, failure classification, cursors, observability. |
| `08-platform-adapters-and-egress.md` | The platform-core seam + registry, the Fansly adapter, the OnlyFans/OFAPI stub, the Stage 26 egress resolver + pacer, proxies, connection lifecycle, the two ratchets. |
| `09-ofapi-boundary.md` | The onlyfansapi.com boundary: transport + credit metering, webhook ingest, read gateway + capture tee, command outbox/executor, credits/reconciliation, account health, the spend pipeline. |
| `10-ofapi-projections.md` | Webhook/sync → storage: DM projection/archive, presence, subscription, spend projection, the sync-snapshot read model, public-profile resolution. |
| `11-events-and-streaming.md` | The two SSE stacks: v1 OFAPI sync-event fanout and v2 per-account domain-event fanout, the cursor contract, enrichment, snapshots, the smoke consumer. |
| `12-ai-gateway-and-prompts.md` | The Stage 29 gateway (providers/budgets/quota-denied ledger/restricted capture) + the Stage 30 prompt unit (manifest, applyPlatformWording, personas, SDK ban, parity). |
| `13-financial-and-money.md` | The money codec (mills/micro-USD), the finance module, the transactions truth path + rollups, the spenders/reporting services. |
| `14-workboard.md` | The chatter task board: the v2 priority engine, event-driven + nightly recompute, the L1/L2 closing classifier, the tables, the stale scripts. |
| `15-auth-config-and-access.md` | Principals/roles/sessions/api-keys/device-tokens, the auth-policy enforcement, login backoff, and the config system (registry/live/boot/staged/heartbeat). |
| `16-telegram-notifications.md` | The outbound-only Telegram boundary, the daily revenue report, the notification-incidents machinery. |
| `17-ops-observability.md` | Golden signals, the DB disk guard, the ops HTTP module, the reporting export surface. |
| `18-retention-erasure-tiering.md` | The retention doctrine + sanctioned deleters, the Stage 28.4 erasure module (3 planes), Stage 28 tiering + restore drill, partition management. |
| `19-shared-package.md` | `packages/shared` inventory: money, types, the business-day engine, crypto, http-client/proxy, config primitives, the browser/node split. |
| `20-dashboard-frontend.md` | The React/Vite SPA consumer: routing, the `@kernel/sdk` cookie client, auth guards, stores, and how the api role serves it. |
| `21-infra-and-devops.md` | The Docker image, compose topologies, the deploy script + gates, the esbuild bundler, CI, the ratchets, the analytics models. |
| `22-tests-and-fixtures.md` | The Vitest suite (unit/Testcontainers split), the harness, the fixtures, and the in-suite ratchet/pin tests. |
| `23-boundaries-catalog.md` | The consolidated inbound/outbound/storage boundary catalog for stitching the three-project ecosystem. |

## 5. Glossary

- **mills / micro-USD** — platform money is mills (`bigint`, 1 mill = $0.001);
  AI spend is micro-USD (`integer`); constructed only via the named codecs in
  `packages/shared/src/money.ts`. Distinct from cents (a few DM columns) and OFAPI
  **credits**.
- **credits (OFAPI)** — an unrelated currency metering what `core` pays OFAPI per
  API call (`ofapi_credit_ledger`/`ofapi_credit_state`). Not fan money.
- **page** — one creator account on one platform (`pages`); the FK target of ~40
  child tables. Naming trap: a child column `platform_account_id` is the internal
  `pages.id` FK, while `pages.external_page_id` holds the external account id.
- **model** — a person/brand (`models`) who may own several pages.
- **fan / spender** — a subscriber/payer; global identity `fans`
  (`(platform, platform_user_id)`), per-page rollup `page_fans`; "spender" = a
  fan viewed through the spend/analytics lens.
- **stream** — a per-page unit of sync work; 11 canonical streams
  (`08-platform-adapters-and-egress.md`); the FSM is one row per `(page, stream)`
  in `page_sync_states`.
- **observation** — a verbatim captured business fact in the append-only journal
  (DP 7); six producer sources.
- **domain event** — the canonical, gapless-per-account, content-hash-deduped
  event derived from observations (`domain_events`).
- **projection** — a rebuildable read model derived from observations/events.
- **egress** — the outbound network path for a page's platform calls, resolved
  per-page through the Stage 26 resolver; Fansly must always be page-proxied.
- **OFAPI** — onlyfansapi.com, the third-party OnlyFans gateway (reads, webhooks,
  message writes). Distinct from the retired OnlyMonster.
- **workboard / closing** — the prioritized chatter task board and its LLM
  "closing" classifier (L1 heuristic + L2 Haiku).
- **fanout_seq** — the v1 SSE ordering key, assigned at webhook settle time.
- **cursor (v2)** — the opaque per-account watermark map that is the v2 SSE event
  id (`packages/contracts/src/domain-event-cursor.ts`).
- **staged flag** — a boot-class config flag flipped one at a time under a global
  advisory lock, gated on the running fleet state (`15-auth-config-and-access.md`).

## 6. Technology stack

- **Fastify 5** (+ `@fastify/cookie`, `@fastify/static`, `@fastify/swagger`(-ui),
  `@fastify/rate-limit`) — the HTTP server and SPA host.
- **Zod 4 contracts** via `fastify-type-provider-zod`; OpenAPI/type codegen via
  the in-house `contracts:generate`.
- **Drizzle ORM** over **node-postgres**; hand-written numbered SQL migrations
  (0000–0074) are authoritative; `db:generate` is deliberately disabled.
- **pg-boss** — Postgres-backed job queues, sharing the app database; cron owned
  by the scheduler role only.
- **React 19 / Vite 6 / Tailwind v4 dashboard**, consuming `@kernel/sdk`.
- **argon2** (argon2id) — password hashing.
- **undici 7 + socks** — the outbound HTTP dispatcher/proxy factory with an SSRF
  guard.
- **@anthropic-ai/sdk** — the Anthropic gateway provider (lint-/test-banned
  elsewhere); OpenRouter is a raw-fetch second provider.
- **Playwright / chromium** — the OnlyFans public-profile resolver and the
  Telegram daily-report image renderer.
- **DuckDB / Parquet** — the tiering lake export + restore drill.
- **esbuild** — the production server bundler; **Testcontainers + Vitest 3** — the
  integration/unit test split; **tsx / TypeScript 5.8** — the run/typecheck
  toolchain.
- Secrets at rest (platform sessions, proxy auth, Telegram token, OFAPI signing
  secret) are protected by an application-level AES-256-GCM envelope keyed from
  `APP_ENCRYPTION_KEY` (`packages/shared/src/crypto.ts`); env is loaded via plain
  `dotenv`.
