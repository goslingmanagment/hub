> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Overview and map index — `core`

`core` is the central backend for a single OnlyFans/Fansly agency. It owns the
platform credentials and egress, the Postgres system of record, capture and
projection pipelines, money and vendor-credit ledgers, the AI gateway and
prompt library, the HTTP/SSE contract, and the same-origin owner dashboard.
The desktop app and Firefox extension are userspace consumers of the generated
kernel SDK; privileged platform and AI credentials remain in this repository.

## Runtime shape

`apps/runtime/src/startup.ts` accepts three long-lived roles:

| Role | Composition |
|---|---|
| `api` | Fastify server, enqueue-only pg-boss client, runtime heartbeat, and the API-side scheduler/ops deadman watchdog. |
| `worker` | pg-boss consumers for sync, OFAPI, canonicalization, projections, workboard, telemetry, Telegram, and tiering. It does not register cron. |
| `scheduler` | Advisory-lock leader that owns pg-boss timekeeping and every cron registration; it emits a heartbeat/health file after leadership. |

All three run forward-only migrations before constructing their runtime.
`startup.ts` also exposes machine-readable lifecycle/capability inspection
commands that return before migrations. `apps/runtime/src/cli.ts` is a separate
Commander administrative entrypoint, not a fourth `AGENCY_HUB_ROLE`.

`createAppContext()` in `apps/runtime/src/bootstrap.ts` validates schema head,
loads boot-class config overrides fail-closed after bounded DB-read retries,
and wires the DB, Fansly adapter, optional OFAPI client, egress pacer, Anthropic
provider/page-proxy resolver, and optional OpenRouter provider.

## Platform boundaries

- Fansly calls go through `packages/fansly` and a page-scoped egress context.
  The resolver fails closed when a required page proxy is missing; the shared
  pacer governs request timing.
- OnlyFans reads, webhook delivery, credits, and commands cross the
  onlyfansapi.com boundary implemented under `apps/runtime/src/services/ofapi*`.
  Public-profile resolution is a separate browser-backed path. The former
  OnlyMonster adapter is not an active platform path.
- AI generation crosses the kernel gateway. Provider SDK imports are confined
  to provider modules; prompts, personas, restricted capture, quota accounting,
  and optional debug echo are kernel-owned.

## Data flow

1. Pull sync, OFAPI webhooks/readthrough, and authorized client harvest ingest
   raw material.
2. Fact-bearing inputs enter `observations` with producer/idempotency identity.
3. Canonicalizers append per-account `domain_events`; sequence assignment is
   serialized per account and dedup resolves to either a new or existing event.
4. Rebuildable projections feed DM archive/thread state, fan earnings,
   acceptance, workboard, reporting, and health. Projection debt is recorded
   and swept instead of wedging a sync stream after a post-capture failure.
5. The API serves Zod-validated REST, v1/v2 SSE, AI streams, OpenAPI, and the
   dashboard SPA. The v2 stream uses bounded replay plus snapshot recovery when
   erasure or retention has created a ledger hole.

The two primary append-only spines are range-partitioned. Migrations `0077` and
`0082` cover old/future event ranges, and the partition managers stop monthly
precreation at the 2031 future catch-all.

## Persistence and contracts at this revision

- `packages/db/src/schema.ts` declares 81 `pgTable` definitions and 23
  `pgEnum` definitions.
- `packages/db/migrations/` contains 96 forward-only SQL files through `0096`.
- The contract registry emits 160 operations in
  `packages/sdk/src/operations.ts`.
- `pnpm contracts:generate` emits normalized OpenAPI, the public
  `KERNEL_CONTRACT_HASH`, the authorization-policy table, and `packages/sdk`.
- The current generated contract hash is
  `43ef5d6bc14de1d41965c5b7dd40ea122c8b8325c0f3a3dfb0ec6aabc459d289`.

Platform/fan money uses integer mills (`bigint`, USD ×1000). AI cost uses
integer micro-USD. OFAPI credits are a separate vendor-metering unit. Their
schemas and codecs are not interchangeable.

## Map index

| File | Territory |
|---|---|
| `00-overview.md` | Runtime shape, data flow, current counts, and this index. |
| `01-runtime-and-processes.md` | Startup, composition root, API/worker/scheduler roles, queues, health, and CLI. |
| `02-http-api-surface.md` | Fastify shell, authorization middleware, module registration, REST/SSE/SPA boundaries. |
| `03-contracts-and-codegen.md` | Zod registry, auth policy, OpenAPI/hash/SDK generation, vendoring and drift gates. |
| `04-database-schema.md` | Current schema families, recent structural additions, enums, partitions, and money columns. |
| `05-db-repositories-and-migrations.md` | DB client, migration runner including non-transactional migrations, schema guard, and repository layer. |
| `06-capture-and-canonicalization.md` | Observation producers, canonicalizers, correction lineage, domain-event append and projectors. |
| `07-sync-engine.md` | Eleven-stream FSM, planning/execution, chunk budgets, page handoff, breaker and health state. |
| `08-platform-adapters-and-egress.md` | Provider seam, Fansly adapter, OFAPI-backed OnlyFans path, resolver, proxies and pacing. |
| `09-ofapi-boundary.md` | OFAPI transport, webhook journal, credits, read gateway, command outbox and lifecycle snapshot. |
| `10-ofapi-projections.md` | DM/readthrough/corrections material, fan/profile/spend projections and snapshot state. |
| `11-events-and-streaming.md` | v1 replay floor, v2 domain-event replay/snapshot recovery, cursors, suppression and SSE clients. |
| `12-ai-gateway-and-prompts.md` | AI providers, quotas, prompt construction, personas, dossier context and debug echo. |
| `13-financial-and-money.md` | Mills/micro-USD, transaction truth, negation guards, pending reconciliation and reporting. |
| `15-auth-config-and-access.md` | Sessions, API/device credentials, deactivation, grants, staged config and capability enrollment. |
| `16-telegram-notifications.md` | Telegram delivery and incident notification paths. |
| `17-ops-observability.md` | Health floors, golden signals, watchdogs, incidents, sync status and admin diagnostics. |
| `18-retention-erasure-tiering.md` | Capture retention, sanctioned deletion, erasure fencing/resolution and lake tiering. |
| `19-shared-package.md` | Shared money, types, time, crypto, HTTP/proxy, config and platform primitives. |
| `20-dashboard-frontend.md` | React dashboard, generated SDK use, auth and administration surfaces. |
| `21-infra-and-devops.md` | Build, compose, deployment/migration/lifecycle gates, CI and operational scripts. |
| `22-tests-and-fixtures.md` | Vitest/Testcontainers suites, fixtures, ratchets and contract pins. |
| `23-boundaries-catalog.md` | Consolidated inbound, outbound, storage and client boundary catalog. |

`docs/generated/authorization-policy.md` is generated separately by
`pnpm contracts:generate` from the same booted route table.

## Vocabulary

- **page** — an internal creator account row; many legacy child columns named
  `platform_account_id` actually reference internal `pages.id`.
- **stream** — one of the 11 values in `sync_stream`, with durable per-page FSM
  state in `page_sync_states`.
- **observation** — captured raw material plus producer/idempotency identity.
- **domain event** — canonical per-account event with an append-only sequence.
- **projection debt** — unresolved rebuildable projection work recorded after
  capture has succeeded.
- **cursor** — v1 uses a numeric fanout id; v2 uses canonical Base64URL JSON
  cursor versions with strict scope/topology checks, not a MAC signature.
- **capability** — a public running-build promise. At this revision the runtime
  advertises `desktop-lifecycle-v2` and `/health` also exposes contract hash.

## Toolchain

The repository is an ESM pnpm workspace (`pnpm@10.33.1`) on Node 22+, with
TypeScript 6, ESLint 10, Vitest 4, Fastify 5/Zod 4, Drizzle/node-postgres,
pg-boss 12, React 19/Vite 6/Tailwind 4, esbuild, Testcontainers, undici/SOCKS,
Playwright/Chromium, DuckDB/Parquet, Anthropic SDK, and a raw-fetch OpenRouter
provider. `pnpm check` runs the strictness ratchet, lint, unit suite, and
dashboard build.
