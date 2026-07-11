# Agency Hub — Technical Decisions

## Quick Reference
| # | Area | Decision |
|---|------|----------|
| 1 | Language | TypeScript + Node.js 22 LTS |
| 2 | Workspace | `pnpm` workspaces monorepo; no Turborepo/Nx in v1; exact package granularity left to the implementer |
| 3 | Backend Framework | Fastify + Zod |
| 4 | Frontend | React 19 SPA with Vite and TanStack Query |
| 5 | Frontend Router | React Router |
| 6 | Frontend Client State | Zustand from day 1 for cross-component UI state |
| 7 | UI Layer | Tailwind CSS + `shadcn/ui` |
| 8 | Database | PostgreSQL 16 |
| 9 | ORM / Query Layer | Drizzle ORM plus handwritten SQL for reporting queries |
| 10 | API Style | REST JSON under `/api/v1` |
| 11 | API Contracts | Zod schemas as source of truth; generate OpenAPI and typed clients from them |
| 12 | Dashboard Auth | Argon2id passwords + HttpOnly Postgres-backed sessions |
| 13 | ChatMuse Auth | Scoped API keys, one per chatter account, hashed and revocable |
| 14 | Authorization | Page-scoped RBAC for `owner`, `team_lead`, `chatter`, `content_manager` |
| 15 | Money | Store monetary amounts as `BIGINT` mills plus `currency` and raw source amount |
| 16 | Time Handling | Store UTC `timestamptz` in DB; use UTC business dates for product analytics |
| 17 | Reporting Period Semantics | Backend computes UTC business-date boundaries; trailing windows include today |
| 18 | Platform Adapters | Strict adapter boundary per platform with canonical normalized DTOs |
| 19 | Fan Identity | `(platform, platform_user_id)` plus per-page relationship rows |
| 20 | Proxy Handling | Per-page proxy configuration in DB, applied inside adapters |
| 21 | Secret Storage | Encrypt platform tokens and proxy credentials at rest |
| 22 | Sync Scheduler | `pg-boss` on Postgres |
| 23 | Worker Role | Separate worker process role via the same image with a different CMD; not a separate service and no RPC |
| 24 | Caching / Redis | No Redis in v1; use Postgres rollups, Postgres prompt cache, and in-memory short-window limiting |
| 25 | ChatMuse Protocol | REST for normal endpoints; SSE only for AI streaming endpoints |
| 26 | AI Gateway | Hub-owned Claude gateway with quotas, cost ledger, provider response IDs, and per-page/model prompt cache |
| 27 | Notifications | DB-backed alerts + queued Telegram Bot API delivery; owner-only critical alerts plus one daily summary destination |
| 28 | Raw Payload Retention | Store mapping-critical and failed payload snapshots as `jsonb` for 180 days |
| 29 | Sync Idempotency | Checkpointed syncs: upsert raw events first, then rebuild projections |
| 30 | Transaction Taxonomy | Compact 9-bucket internal enum with adapter mappings |
| 31 | Notes / Summary History | Append-only notes; summaries append new versions instead of overwriting |
| 32 | Reporting Rollups | Precomputed daily fact tables for revenue, followers, and subscribers |
| 33 | Logging | Pino structured JSON logs |
| 34 | Migrations | Forward-only Drizzle SQL committed to git and run explicitly during deploy |
| 35 | Env Config | Shared typed config with Zod validation at startup |
| 36 | File Storage | Postgres text/JSON only; no binary or object storage in v1 |
| 37 | Testing | Vitest + Testcontainers; Playwright deferred to post-MVP |
| 38 | Deployment | Docker Compose on one VPS with Caddy |
| 39 | CI/CD | GitHub Actions builds, publishes to GHCR, and deploys over SSH |
| 40 | Code Quality | ESLint + Prettier |
| 41 | Backups | Nightly full Postgres backups stored off-VPS, with restore drills |
| 42 | Health Checks | Lightweight `/health` plus token/proxy health checks |
| 43 | Audit Trail | Append-only audit log for sensitive admin actions |
| 44 | Fansly Auth Headers | Only `authorization` header is required; `fansly-client-id`, `fansly-client-check`, `fansly-session-id` are optional — include when available, omit when not |
| 45 | Payout Reversal (16013) | Fansly raw_type 16013 maps to `payout_reversal` — store in transactions for audit, but exclude from net revenue calculations and `daily_revenue` rollups |
| 46 | Revenue Classification | Shared classification metadata in `types.ts` with 4 reporting buckets (revenue, adjustment, unclassified, excluded) + `affectsFanLtv` flag; no DB schema change; query/service/API/CLI layers consume classification; `netEarningsMills = revenue + adjustments + unclassified`; `totalNetMills` kept as deprecated alias |
| 47 | Dashboard Fan Navigation | Keep `fan` as an internal CRM/data model and API concept, but do not ship a standalone dashboard `Fans` section by default; only surface it when the UI delivers spend-ranked or CRM workflows that are clearly distinct from followers/subscribers |
| 48 | OFAPI Real-Time Pipeline | OFAPI webhook receiver (raw-body HMAC, header-based dedupe, journal table) + pg-boss async processing + SSE fanout `GET /api/v1/events/stream` with `Last-Event-ID` replay; pages map to OFAPI accounts via `pages.ofapi_account_id`; ChatMuse profile PUT auto-creates OnlyFans fans |
| 54 | OFAPI Desktop Read Gateway | Default-off chatter-key `GET /api/v1/ofapi/read/*` compatibility gateway with assigned-page ACL, strict path/query allowlist, central credit ledger, and no write/upload/send routes |
| 55 | OFAPI Command Outbox | Core-owned, default-off command intake with stable client ids, page/chatter dedupe, explicit indeterminate outcomes, retry lineage, and a separate execution flag; no generic write proxy |
| 56 | OFAPI Command Executor | Separately staged one-attempt text execution with no automatic retry, page-attributed credit accounting, webhook repair, and terminal payload redaction |
| 57 | DM Aggregate Analytics | Replaceable aggregate-only UTC daily facts over the governed cold archive; no transcript text, media URLs, or fan identifiers |
| 58 | OFAPI Typing Command Custody | Empty-payload `typing_active_v1` command through the core outbox/executor; no retry, no webhook text matching, zero fallback credits, Direct rollback retained |
| 59 | OFAPI Unsend Command Custody | Numeric-target `unsend_message_v1` command through the core outbox/executor; no retry, one DELETE attempt, bounded audit surface, Direct rollback retained |
| 60 | OFAPI Mark-Read Command Custody | Empty-payload `mark_chat_read_v1` command through the core outbox/executor; no retry, one mark-as-read POST, bounded audit surface, Direct rollback retained |
| 61 | OFAPI Media/PPV Send Command Custody | Bounded `send_media_message_v1` command for existing media IDs; one send attempt, same-kind retry lineage, webhook repair by text/price/media-count only, Direct rollback retained |
| 62 | Fansly server-replay gate (Pass 3 Stage 6) | Day-1 probe: all three DP-1 endpoint families (earnings stats, monthly stats, PPV order history) are REPLAYABLE server-side with the single pasted `fansly-client-check`; no per-route anti-bot token needed. Clears kernel-only Fansly capture (DP 1-B) for Stages 16/17 |
| 63 | Kernel retention & redaction stand-down (Pass 3 Stage 1) | All scheduled/automatic destruction of business facts stopped: retention defaults+envs → 36500 d (webhook journal, DM cold archive, sync raw payloads); page_dm prune + command payload self-redaction behind default-OFF env kill-switches; DM-message sync gains raw persistence (`payload_kind='dm_messages'`, 3 paths); consumed-only guard on the journal purge; hourly disk-usage alert (migration 0052, additive enum value) |
| 64 | Pass 3 spec fixup (pre-execution review) | Doc-only amendments: Stage 7/8 key-table insert protocols made implementable (pre-allocated ids + OVERRIDING SYSTEM VALUE); dependency graph tightened (31/32←11, 33←20, soft 26←19, mutual soft 28↔29); Stage 20 method/path recovered by booting buildApiServer; sensitive kinds excluded from the generic lake into lake/restricted |
| 65 | Kernel destruction-door guards + chatter-read-scope (Pass 3 Stage 2) | One-action data-loss doors closed: raw revenue routes role-gated behind REVENUE_ROUTE_ROLE_ENFORCEMENT (log→enforce); messages_history reset refuses 409 until the Stage 10 archive; fact-bearing page DELETE refuses 409; workboard undo → retraction marker; reclassify → soft-supersede append log (partial active unique, migration 0053) |
| 66 | Desktop stop-loss (Pass 3 Stage 4) | Desktop stops destroying facts: usage spool never self-deletes (dead-letter tier; drop path removed at the type level); prune horizons ×10 (messages 50k, spend 310 d, guard-audit 3650 d); purge flow warns kernel-holds-no-copy; `x-client-version` on every hub request (Proposal 4.1). Q5 diff verdict: served 0.1.28 = desktop origin/main@145260a byte-exact, but the desktop repo's local/origin mains diverged 5-and-5 — 0.1.29 release blocked until the owner reconciles |
| 67 | OnlyMonster export is vacuous (Pass 3 Stage 5) | Verify-zero census 2026-07-05: lora-of 685/685 and lora-vip-of 2168/2168 transactions OFAPI-sourced (0 OnlyMonster rows), no OnlyMonster streams in the 7-day sync_runs window, 0 omapi.onlymonster.ai egress. No export to run; no off-box archive created (Q3 declined). Subscription cancellation stays Stage 15; adapter deletion stays Stage 18 |

## Consensus Decisions
- **Language / runtime (12/12):** TypeScript on Node.js 22 LTS keeps API, dashboard, worker, and shared contracts in one well-supported stack.
- **Frontend app shell (12/12):** React SPA with Vite and TanStack Query fits a desktop-only internal dashboard without SSR overhead.
- **Database (12/12):** PostgreSQL is the obvious system of record for relational data, reporting, jobs, and JSONB snapshots.
- **ORM / query layer (12/12):** Drizzle plus handwritten SQL keeps schema definitions in TypeScript while preserving control over reporting queries.
- **Monorepo shape (12/12):** Keep one monorepo with apps and shared packages so shared contracts and domain code stay close to their consumers.
- **Authorization model (12/12):** Page-scoped RBAC matches the PRD's visibility rules and scales cleanly to new modules.
- **Platform adapter boundary (11/12):** Separate platform adapters behind one interface so Fansly and OnlyFans differences stay contained.
- **Deployment baseline (12/12):** Docker Compose on one VPS with Caddy is the right operational baseline for this scale.
- **Testing runner (12/12):** Vitest is the fastest and least controversial test runner for this stack.
- **Env config validation (10/12):** Zod-validated env config should crash fast on bad startup state instead of failing deep in a sync job.
- **Fan identity (10/12):** `(platform, platform_user_id)` matches the PRD and makes ChatMuse fan lookup direct.
- **Rate limiting + usage ledger (10/12):** Durable usage tracking plus a short-window limiter is the right baseline for internal AI features with quotas.

## Arbitrated Decisions
### Workspace Tooling
**Decision:** `pnpm` workspaces only in v1; no Turborepo or Nx.

**Score:** 9/12 chose plain `pnpm` workspaces; 2/12 chose Turborepo; 1/12 was not explicit.

**Why:** Three apps and a small set of shared packages do not justify another build-graph layer yet. Plain `pnpm --filter` workflows stay obvious for humans and AI agents, and the repo can add orchestration later only if build times become a real problem.

**Rejected:** Turborepo is useful only once the repo has measurable build-graph pain. Nx adds even more framework overhead without solving a v1 problem.

### Backend Framework
**Decision:** Fastify + Zod.

**Score:** 9/12 chose Fastify; 3/12 chose Hono.

**Why:** Once REST wins, Fastify is the better boring server: mature plugins, straightforward Zod integration, and first-class structured logging. It is more practical for long-running API and SSE workloads than optimizing for the thinnest possible HTTP layer.

**Rejected:** Hono is viable, but its main advantage here was usually tied to tRPC rather than this project's final architecture.

### API Style
**Decision:** REST JSON under `/api/v1`.

**Score:** 9/12 chose REST + shared schemas / OpenAPI; 3/12 chose tRPC.

**Why:** The dashboard, ChatMuse extension, Telegram jobs, and future scripts all benefit from one plain HTTP contract that works with `fetch`, curl, and generated clients. URL-based versioning is enough for v1, and `/api/v1` keeps the upgrade path explicit if a v2 is ever needed.

**Rejected:** tRPC would couple the transport too tightly to TypeScript consumers and make the extension boundary harder, not easier.

### OpenAPI Generation
**Decision:** Generate OpenAPI from Zod route schemas.

**Score:** 8/12 explicitly specified OpenAPI generation; 2/12 used tRPC; 2/12 shared Zod schemas without OpenAPI.

**Why:** The Zod schemas already exist for validation, so generating OpenAPI adds a stable contract and typed client generation at low cost. That keeps the API inspectable outside the monorepo and avoids drift between dashboard, extension, and scripts.

**Rejected:** Shared Zod schemas without OpenAPI work only as long as every consumer lives in the same tooling context. tRPC removes the universal HTTP contract this project needs.

### Frontend Router
**Decision:** React Router.

**Score:** 7/12 chose React Router; 5/12 chose TanStack Router.

**Why:** This dashboard needs boring, well-known routing more than maximal type cleverness. React Router is easier to search, easier for AI agents to patch correctly, and fully sufficient for a small internal route graph.

**Rejected:** TanStack Router is good technology, but its extra type machinery is a marginal win for this app's routing complexity.

### Frontend Client State
**Decision:** Zustand from day 1 for client-only UI state.

**Score:** 7/12 chose a small Zustand store; 5/12 preferred React local state first.

**Why:** Date ranges, filters, and panel toggles will be shared across unrelated dashboard components almost immediately. Zustand is tiny, avoids prop drilling, and complements TanStack Query instead of overlapping with server state.

**Rejected:** React local state and context are workable, but they become noisy sooner than they save complexity on this dashboard.

### UI Layer
**Decision:** Tailwind CSS + `shadcn/ui`.

**Score:** 6/12 explicitly chose Tailwind + `shadcn/ui`; 6/12 were custom or unspecified.

**Why:** This stack is fast to iterate on, works well with AI-generated UI patches, and keeps component code in the repo instead of behind a dependency boundary. It is the shortest path to a polished internal dashboard without locking the project into a rigid design system.

**Rejected:** Large component libraries add styling gravity the product does not need. A fully custom component system from day 1 is extra effort without user value.

### Dashboard Auth
**Decision:** Argon2id passwords with HttpOnly Postgres-backed sessions.

**Score:** 9/12 chose server-side or opaque cookie sessions; 3/12 chose JWT-style sessions.

**Why:** Fewer than ten dashboard users means the DB lookup cost is irrelevant, while immediate revocation and simpler security semantics are valuable. Argon2id is the right default for password hashing, and Postgres-backed sessions keep auth state explicit and easy to revoke.

**Rejected:** JWT dashboard sessions add token lifecycle and revocation complexity without giving this product a real operational benefit.

### ChatMuse Auth
**Decision:** Admin-issued scoped API keys, one per chatter account, hashed in Postgres and revocable; page access is enforced server-side.

**Score:** 6/12 chose long-lived API keys / personal tokens; 6/12 chose short-lived access tokens with refresh or token exchange.

**Why:** ChatMuse is an internal extension with manually issued credentials, so a pasted API key is the lowest-friction model that still supports revocation and scoping. The backend can enforce per-page access and request-count quotas while always logging token and cost usage in the ledger.

**Rejected:** Access and refresh token flows add rotation, storage, and recovery logic the extension does not need. Per-device credentials would add admin overhead without improving the real threat model.

### Money / Amount Storage
**Decision:** Store all monetary amounts as `BIGINT` mills (`1 mill = $0.001`) in PostgreSQL `bigint` columns, alongside `currency` and the raw source amount.

**Score:** 5/12 chose `BIGINT` mills; 3/12 chose `NUMERIC` + `decimal.js`; 3/12 chose `BIGINT` micros or generic minor units; 1/12 chose integer cents.

**Why:** Fansly already speaks mills, so storing that native unit avoids conversion loss and keeps arithmetic exact; OnlyFans cents convert losslessly by multiplying by 10. Use shared helpers such as `centsToMills`, `millsToDollars`, and `formatMoney` at the edges, and return mills as JSON numbers because the expected range stays comfortably within JavaScript's safe integer limit.

**Rejected:** `NUMERIC` is correct but forces string parsing and decimal ceremony through Drizzle for no gain here. Micros add precision the sources do not need and throw away the "store Fansly natively" advantage. Cents are wrong for this product because they would truncate real Fansly precision.

### Sync Scheduler
**Decision:** `pg-boss`.

**Score:** 7/12 chose `pg-boss`; 3/12 chose BullMQ; 2/12 chose `node-cron`.

**Why:** `pg-boss` delivers durable scheduling, retries, concurrency control, and job visibility without adding Redis. Keeping jobs in Postgres lets the application query queue state directly and keeps operational state in one system.

**Rejected:** BullMQ would force Redis into the baseline stack for no v1 benefit. `node-cron` is too weak once missed runs, retries, and dead jobs matter.

### Worker Separation
**Decision:** Run a separate worker process role using the same Docker image with two CMDs: `node dist/api.js` and `node dist/worker.js`; same codebase, same packages, same DB connection, not a separate service, no RPC, and communication only through `pg-boss` jobs in Postgres.

**Score:** 7/12 chose a separate worker process/container; 5/12 ran jobs in the API process or left the split ambiguous.

**Why:** Long follower syncs and retry-heavy background work should not share an event loop with request handling. The split is operational, not architectural: this is one application deployed in two roles, not a separate service or microservice boundary.

**Rejected:** Running sync jobs in the API process increases the chance that long-running work drags on request responsiveness. A separate service with its own codebase or RPC adds complexity the product does not need.

### ChatMuse Streaming
**Decision:** Use normal REST request/response for standard endpoints and SSE only for AI streaming endpoints.

**Score:** 5/12 included SSE for AI endpoints; 7/12 said REST-only.

**Why:** Fan lookups, notes, and most dashboard APIs are standard REST reads and writes, so they should stay simple. Claude responses can take 3-10 seconds, and SSE is the cheapest way to stream partial AI output without forcing the whole product onto WebSockets.

**Rejected:** REST-only everywhere leaves AI UX stuck behind long spinners. WebSockets are unnecessary for traffic that is still fundamentally request/response.

### Playwright E2E
**Decision:** Defer Playwright E2E to post-MVP.

**Score:** 6/12 included Playwright in v1; 6/12 deferred it.

**Why:** The dashboard UI will change too quickly in the first iteration to justify browser automation churn. The highest-risk v1 behavior is backend correctness around money, sync, and auth, which is better covered by Vitest and Testcontainers.

**Rejected:** A thin smoke suite now would create maintenance work on unstable screens. Skipping browser coverage forever would also be wrong once the UI stabilizes.

### Project Structure Detail
**Decision:** Keep the monorepo shape, but leave the exact app/package split to the implementer based on real code dependencies.

**Score:** 6/12 used many packages; 4/12 used moderate structure; 2/12 used minimal workspaces.

**Why:** Both source documents identified the same broad boundaries, but they disagreed on how aggressively to package them. This reference should lock the architecture and leave package granularity flexible enough to match the actual dependency seams that appear during implementation.

**Rejected:** A fixed minimal split risks turning the API into a grab bag once adapters and worker code grow. A fixed maximal split creates package overhead before the code proves those boundaries are useful.

### Code Quality Tooling
**Decision:** ESLint + Prettier.

**Score:** 1/12 explicitly chose ESLint + Prettier; 2/12 chose Biome; 9/12 were not explicit.

**Why:** ESLint and Prettier are still the safest default for editor support, plugin breadth, CI integration, and AI-generated patches. The boring industry standard is the better choice here than optimizing for tool novelty.

**Rejected:** Biome is promising, but the ecosystem and rule surface are still narrower than the repo is likely to want over time.

### Notification Delivery
**Decision:** Store alerts in the DB first, deliver Telegram notifications asynchronously through `pg-boss`, send critical alerts to the owner only, send one daily summary to a configured destination, and treat recurring failures as one open incident plus one resolved notification.

**Score:** 7/12 chose Telegram Bot API with queued or outbox delivery; 2/12 chose direct Bot API calls without a queue; 1/12 chose a bot framework; 2/12 were not explicit.

**Why:** Persisting alerts first makes the dashboard, Telegram, and job history agree on the same incidents. Queue-backed delivery survives transient Telegram failures, and the open/resolved incident model prevents alert storms for noisy sync or token problems.

**Rejected:** Direct Bot API calls from the failing code path risk lost notifications during outages. Bot frameworks add command and middleware machinery that v1 push notifications do not need.

## Additional Decisions
- **Reporting period semantics:** The backend computes all business period boundaries on UTC business dates, and trailing `7d` and `30d` windows include today so dashboard, Telegram, and exports agree.
- **No Redis in v1:** This is a deliberate choice, not an omission; use Postgres rollups, a Postgres prompt cache, and in-memory short-window limiting until a measured bottleneck says otherwise.
- **Hub-owned AI gateway:** Route all Claude traffic through one backend gateway that records feature, chatter, page, provider response ID, token usage, cost, cache hit, and quota decisions.
- **Raw payload retention:** Store mapping-critical upstream payloads and all failed payloads as `jsonb`, tagged with `mapper_version` and sync run ID, and retain them for 180 days.
- **Sync idempotency and checkpointing:** Every sync should write per-account checkpoints and idempotency keys so reruns can safely upsert raw events first and rebuild derived projections without duplication.
- **Unified transaction taxonomy:** Use one compact internal enum of `subscription`, `tip`, `message_purchase`, `post_purchase`, `stream_tip`, `chargeback`, `refund`, `payout_reversal`, and `other`, then map platform-specific codes inside the adapters.
- **Append-only notes and summaries:** Notes are immutable records, and AI summaries append new versions rather than overwriting prior history.
- **Precomputed rollups:** Maintain daily fact tables for revenue, followers, and subscribers so dashboard and report queries stay simple and consistent.
- **Proxy handling:** Store per-page proxy configuration in the database and apply it inside platform adapters rather than scattering proxy logic across services.
- **Secret encryption:** Encrypt platform tokens and proxy credentials at rest with application-layer encryption so DB leaks and backup exposure do not reveal live secrets in plaintext.
- **Backups:** Run nightly full Postgres backups, keep them off-VPS, and rehearse restores so single-VPS deployment is operationally credible.
- **Health checks:** Provide a lightweight `/health` endpoint and a scheduled token/proxy health check that turns auth death and proxy outages into first-class incidents.
- **Audit trail:** Record login, token issuance and revocation, page assignment changes, payout edits, and note or summary edits as append-only audit events.
- **File storage:** Keep notes, summaries, alerts, raw payload snapshots, and other v1 artifacts in Postgres text/JSONB; do not add binary or object storage yet.
- **Migrations:** Keep Drizzle migrations forward-only, commit the SQL to git, and run them as an explicit deploy step rather than auto-applying them on boot.
- **Logging:** Use Pino structured JSON with request IDs and job IDs so logs are machine-parseable and easy to grep.
- **CI/CD:** Use GitHub Actions to build images, publish them to GHCR, and deploy them to the VPS over SSH.

## Excluded
- **Generic `{ data, error, meta }` success envelopes:** They add wrapper noise without solving a real problem for these internal clients.
- **Full external observability stack in v1:** Pino logs, health checks, DB-backed alerts, and Telegram are enough before adding `Sentry`, `Datadog`, or similar services.
- **UUID-everywhere as a mandatory convention:** Use natural or composite keys where they carry meaning, and keep internal IDs boring unless a specific module needs more.

## Decision Matrix
Historical appendix: this matrix preserves what the 12 source proposals chose and does not override the final rulings above.

Legend for the matrix:

- `GS1` `GS2` `GS3` = `gpt_short_1..3`
- `CF1` `CF2` `CF3` = `codex-full-1..3`
- `OS1` `OS2` `OS3` = `opus_short_1..3`
- `OF1` `OF2` `OF3` = `opus-full-1..3`

| # | Area | Grouped choices |
|---|------|-----------------|
| 1 | Language / runtime | TypeScript + Node 22 LTS (`all 12`) |
| 2 | Package manager / workspace tooling | `pnpm` workspaces, no extra orchestrator (`GS1 GS2 GS3 CF1 CF2 CF3 OS2 OF1 OF2`) `9`; `pnpm` + Turborepo (`OS1 OF3`) `2`; not explicit (`OS3`) `1` |
| 3 | Backend framework | Fastify (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `9`; Hono (`OS1 OS2 OF3`) `3` |
| 4 | Frontend app shell | React + Vite + TanStack Query (`all 12`) |
| 5 | Frontend router | React Router (`GS1 GS2 GS3 CF1 CF2 OF1 OF2`) `7`; TanStack Router (`CF3 OS1 OS2 OS3 OF3`) `5` |
| 6 | Local UI state | Small Zustand store (`GS2 CF1 CF2 CF3 OF1 OF2 OF3`) `7`; React local state / no extra store first (`GS1 GS3 OS1 OS2 OS3`) `5` |
| 7 | Styling / component layer | Tailwind + `shadcn/ui` (`OS1 OS2 OS3 OF1 OF2 OF3`) `6`; custom or unspecified (`GS1 GS2 GS3 CF1 CF2 CF3`) `6` |
| 8 | Database | PostgreSQL (`all 12`) |
| 9 | ORM / query layer | Drizzle + handwritten SQL for reporting (`all 12`) |
| 10 | Repo shape | Monorepo with apps + shared packages (`all 12`) |
| 11 | API style | REST + shared schemas / OpenAPI (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `9`; tRPC (`OS1 OS2 OF3`) `3` |
| 12 | Dashboard auth | Server-side or opaque cookie session (`GS1 GS2 GS3 CF1 CF2 CF3 OS2 OF1 OF3`) `9`; JWT-style session (`OS1 OS3 OF2`) `3` |
| 13 | ChatMuse auth | Long-lived API key / personal token (`OS1 OS2 OS3 OF1 OF2 OF3`) `6`; short-lived access token with refresh or token exchange (`GS1 GS2 GS3 CF1 CF2 CF3`) `6` |
| 14 | Authorization model | Page-scoped RBAC (`all 12`) |
| 15 | Secret / token storage | Encrypt at rest (`GS2 CF1 CF2 OF3`) `4`; store in DB without encryption (`OF2`) `1`; not explicit (`GS1 GS3 CF3 OS1 OS2 OS3 OF1`) `7` |
| 16 | Money representation | `BIGINT` mills (`OS1 OS2 OS3 OF1 OF2`) `5`; `BIGINT` micros or generic minor units (`GS2 GS3 CF2`) `3`; `NUMERIC` + `decimal.js` (`GS1 CF1 CF3`) `3`; integer cents (`OF3`) `1` |
| 17 | Financial ingestion model | Normalized records plus raw payload retention (`GS2 GS3 CF1 CF2 CF3 OF1 OF2`) `7`; normalized only / no explicit raw retention (`GS1 OS1 OS2 OS3 OF3`) `5` |
| 18 | Time storage / display | UTC in DB, Moscow for business display/reporting (`GS2 GS3 CF1 CF2 CF3 OF1 OF2 OF3`) `8`; not explicit (`GS1 OS1 OS2 OS3`) `4` |
| 19 | Where business period boundaries are computed | Backend (`GS3 CF2 CF3`) `3`; frontend (`OF2 OF3`) `2`; same timezone rule but location unspecified (`GS2 CF1 OF1`) `3`; not explicit (`GS1 OS1 OS2 OS3`) `4` |
| 20 | Platform integration boundary | Strict adapter interface per platform (`GS1 GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `11`; not explicit (`OS2`) `1` |
| 21 | Proxy handling | Per-page or per-account proxy config in DB, applied inside adapters (`GS2 CF2 CF3 OS3 OF1 OF2 OF3`) `7`; not explicit (`GS1 GS3 CF1 OS1 OS2`) `5` |
| 22 | Deployment baseline | Docker Compose + single VPS + Caddy (`all 12`) |
| 23 | Extra infrastructure | Minimal stack, no Redis / MinIO baseline (`GS1 GS2 GS3 CF1 OS1 OS2 OS3 OF1`) `8`; Redis baseline (`CF2 CF3 OF2 OF3`) `4`; MinIO baseline (`CF2`) `1` |
| 24 | Worker separation | Separate worker process/container (`GS1 GS2 GS3 CF1 CF2 CF3 OS2`) `7`; API process also runs jobs or split not explicit (`OS1 OS3 OF1 OF2 OF3`) `5` |
| 25 | ChatMuse transport | REST `fetch` endpoints (`GS1 GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2`) `10`; tRPC client (`OS2 OF3`) `2` |
| 26 | Streaming AI responses | Plain request/response only (`GS1 OS1 OS2 OS3 OF1 OF2 OF3`) `7`; SSE for AI-only endpoints (`GS2 GS3 CF1 CF2 CF3`) `5` |
| 27 | Rate limiting + usage ledger | Durable Postgres usage ledger plus a short-window limiter (`GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `10`; basic or unspecified (`GS1 OS2`) `2` |
| 28 | Sync scheduler | `pg-boss` (`GS1 GS2 GS3 CF1 CF3 OS1 OF1`) `7`; BullMQ (`CF2 OF2 OF3`) `3`; `node-cron` (`OS2 OS3`) `2` |
| 29 | Sync idempotency | Explicit checkpoints / idempotency keys / upserts (`GS2 GS3 CF1 CF2 OF1`) `5`; not explicit (`GS1 CF3 OS1 OS2 OS3 OF2 OF3`) `7` |
| 30 | Caching strategy | No Redis baseline; Postgres rollups/prompt cache, maybe tiny in-process cache (`GS1 GS2 GS3 CF1 OS1 OS2 OS3 OF1`) `8`; Redis-backed cache layer (`CF2 CF3 OF2 OF3`) `4` |
| 31 | Reporting / read models | Precomputed daily fact tables / rollups (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `8`; mostly compute on read or not explicit (`GS1 OS1 OS2 OF3`) `4` |
| 32 | Testing runner | Vitest (`all 12`) |
| 33 | Browser E2E coverage | Thin Playwright smoke suite (`GS1 GS2 GS3 CF1 CF2 CF3`) `6`; no browser E2E initially (`OS1 OS2 OS3 OF1 OF2 OF3`) `6` |
| 34 | Error handling + logging | Pino structured logs, typed errors, Telegram alerts (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `9`; lighter / not explicit (`GS1 OS1 OS2`) `3` |
| 35 | External error SaaS | Sentry (`GS2 CF2`) `2`; no external SaaS or not stated (`10`) |
| 36 | Notification delivery | Telegram Bot API with queued / outbox delivery (`GS2 GS3 CF1 CF2 CF3 OF1 OF2`) `7`; direct Bot API helper without queue (`OS1 OS3`) `2`; grammY / bot framework (`OF3`) `1`; not explicit (`GS1 OS2`) `2` |
| 37 | Database migrations | Forward-only Drizzle SQL migrations (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `9`; not explicit (`GS1 OS1 OS2`) `3` |
| 38 | Migration execution | Explicit deploy step (`GS2 CF1 CF3 OF1 OF2`) `5`; auto on startup / app boot (`CF2 OF3`) `2`; not explicit (`GS1 GS3 OS1 OS2 OS3`) `5` |
| 39 | Environment config | Zod-validated typed env config (`GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `10`; not explicit (`GS1 OS2`) `2` |
| 40 | Fan identity | `(platform, platform_user_id)` plus per-page relationship rows (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `10`; not explicit (`OS1 OS2`) `2` |
| 41 | Notes / summary history | Append-only note and summary history (`GS2 OF1`) `2`; not explicit (`10`) |
| 42 | File / object storage | Postgres text / JSONB only, no object storage in v1 (`GS2 GS3 CF1 OS3 OF1 OF2 OF3`) `7`; S3 / MinIO now (`CF2 CF3`) `2`; not explicit (`GS1 OS1 OS2`) `3` |
| 43 | Raw payload retention | Keep selected raw payload snapshots (`GS2 GS3 CF1 CF2 CF3 OF2`) `6`; not explicit (`GS1 OS1 OS2 OS3 OF1 OF3`) `6` |
| 44 | AI gateway / provider boundary | Central Hub-owned provider gateway with cost tracking (`GS3 CF3 OS1 OS3 OF1 OF2 OF3`) `7`; not explicit or partial (`GS1 GS2 CF1 CF2 OS2`) `5` |
| 45 | Transaction taxonomy | Unified cross-platform enum with adapter mapping tables (`OF1 OF2 OF3`) `3`; not explicit (`9`) |
| 46 | Backup / restore | Nightly Postgres backups plus restore drills (`GS3 CF2 CF3 OF1`) `4`; lighter backup mention (`OS1`) `1`; not explicit (`7`) |
| 47 | Code quality tooling | Biome (`OF1 OF3`) `2`; ESLint + Prettier (`CF2`) `1`; not explicit (`9`) |
| 48 | Architecture docs | ADRs + per-package READMEs (`CF2`) `1`; not explicit (`11`) |
| 49 | Monitoring / health checks | Lightweight health endpoint + uptime checks (`OF3`) `1`; not explicit (`11`) |
| 50 | Internal ID convention | UUID-heavy internal IDs (`CF3 OF3`) `2`; serial / mixed / not explicit (`10`) |
| 51 | API response envelope | Generic `{ data, error, meta }` envelope (`OF1 OF2`) `2`; direct resource DTOs or not explicit (`10`) |

## Linked Decisions
| Package | Decisions | Consequence |
|---------|-----------|-------------|
| **No Redis** | `pg-boss` + Postgres rollups/prompt cache + in-memory short-window limiting | One fewer baseline service, and queue state, cache state, and business state stay queryable in Postgres. |
| **REST + SSE Split** | OpenAPI from Zod + generated typed clients + REST for normal endpoints + SSE for AI streaming only | Most APIs stay simple HTTP while long-running AI responses stream without adopting WebSockets everywhere. |
| **Separate Worker Role** | Same image, two CMDs, shared packages, shared DB, no RPC | Heavy background work is isolated operationally without creating a second service boundary. |
| **BIGINT Mills** | Fansly-native mills + OF cents ×10 + integer math + one formatter/conversion layer | Money stays exact in SQL and JS without `decimal.js` or `NUMERIC` string plumbing. |
| **Hub-Owned AI Gateway** | Centralized Claude access + quotas + cost ledger + prompt cache | ChatMuse usage, billing, caching, and provider integration stay enforceable in one place. |


## Phase Sequencing Change (2026-03-08)

**Decision:** Phase 4 (OnlyFans Connect) now executes before Phase 3 (Dashboard).

**Rationale:** Dashboard should ship with both Fansly and OnlyFans data from day one. Building the dashboard first would mean retrofitting OF support later — more rework, more risk. OF Connect is backend-only and smaller scope, making it a natural predecessor.

**New order:** Phase 1 → Phase 2 → Phase 4 → Phase 3 → Phase 5+

**Impact:** Phase 3 now depends on Phase 2 + Phase 4. PRD numbering swapped (Phase 3 = OF Connect, Phase 4 = Dashboard in PRD; roadmap keeps original names with updated deps).

## Revenue Classification Split (2026-03-09)

**Decision #46:** Replace the single `totalNetMills` revenue model with explicit Revenue / Adjustments / Unclassified / Net Earnings, driven by shared classification metadata.

### Reporting Buckets (in `packages/shared/src/types.ts`)

| Bucket | Canonical Types | Description |
|--------|----------------|-------------|
| `revenue` | subscription, tip, message_purchase, post_purchase, stream_tip | Clean business revenue |
| `adjustment` | chargeback, refund | Post-sale corrections |
| `unclassified` | other | Ambiguous types pending audit |
| `excluded` | payout_reversal | Platform-internal, not income |

Each type also carries `affectsFanLtv: boolean` — fan LTV uses different rules than revenue reporting.

### Fan LTV Rules (separate from revenue)

- revenue types: affect LTV ✅
- chargeback, refund: reduce LTV ✅
- other (fan-linked): temporarily affects LTV ✅ (until audit)
- payout_reversal: does NOT affect LTV ❌

Fan LTV uses an **exclude-list** (only `payout_reversal` excluded), not a whitelist. This preserves current LTV values until `other` is audited.

### Revenue Metrics

- `revenueMills` — sum where bucket = revenue
- `adjustmentMills` — sum where bucket = adjustment
- `unclassifiedMills` — sum where bucket = unclassified
- `netEarningsMills` = revenueMills + adjustmentMills + unclassifiedMills (reconciliation total, must match ledger)

`totalNetMills` remains as a deprecated alias of `netEarningsMills` for rollout safety.

### API Contract Shape

```
summary: { revenueMills, adjustmentMills, unclassifiedMills, netEarningsMills }
breakdown: [{ canonicalType, bucket, netAmountMills }]
comparison: { summary, delta }
```

### What Does NOT Change

- No gross revenue model — system stays on `net_amount_mills`
- No DB schema migration — `canonical_type` is source data, classification is product logic
- No moving OF chargebacks to original sale date — chargeback stays on chargeback timestamp
- No hiding `payout_reversal` from `/transactions` — ledger stays auditable
- No change to pending vs posted semantics (deferred)
- `daily_revenue` schema unchanged — materialization logic uses shared classifier instead of hardcoded special cases

### Follow-up (not blocking)
- Audit `other` bucket: Fansly raw types 18001, 18002, 24101 (referral, leaderboard) may be real revenue
- After audit: remap to proper canonical types or adjust classification
- Consider `classifiedNetEarningsMills` (revenue + adjustments only) as optional derived metric

**Rationale:** Current code treats everything except `payout_reversal` as "revenue", mixing chargebacks into revenue metrics. This must be fixed before Phase 4 (Dashboard) to avoid shipping incorrect financial data. The shared classification approach avoids DB migration and keeps the change in query/service/API/CLI layers only.


## OFAPI Real-Time Pipeline (2026-06-11)

**Decision #48:** Core becomes the real-time hub for the ChatGoose desktop app ("ChatMuse"): an onlyfansapi.com (OFAPI) webhook receiver plus an SSE fanout, with pg-boss carrying the async processing. Scope and shape (brief: ChatGoose desktop `docs/SPEC.md` §9.2 + its live-captured fixtures, copied to `tests/fixtures/ofapi-webhooks/`):

- **Receiver `POST /api/v1/ofapi/webhook`:** authenticates by `HMAC-SHA256(rawBody, signing_secret)` from the `signature` header (hex, timing-safe compare), over the raw bytes — the route lives in its own Fastify plugin scope with the repo's only `parseAs: "buffer"` body parser. Dedupe key is the `x-ofapi-idempotency-key` header (`evt_<40 hex>`; live-verified — the body has no event id), enforced by a unique index on `ofapi_webhook_events.idempotency_key`. The handler does two indexed statements plus one `boss.send` and acks well under OFAPI's 15 s timeout; a minutely sweep job re-enqueues rows whose enqueue was lost.
- **Journal `ofapi_webhook_events` (migration 0027, additive):** full envelope JSONB + derived `sync_event` JSONB + resolved `platform_account_id`, settled by the worker as processed/skipped/failed (settle guarded on `status='pending'`, so a retry racing the sweep settles exactly once). The SSE event id is `fanout_seq`, assigned in **settle order** inside the settle transaction — receive-time bigserial ids would make late settles (pg-boss retries, the sweep) invisible to clients whose `Last-Event-ID` already advanced past them. Retention defaults to 7 days (`OFAPI_EVENT_RETENTION_DAYS`), pruned by a daily 02:30 UTC job.
- **Queue throughput hardening (2026-06-20):** webhook processing uses the
  `ofapi.events.process.v2` queue with `exclusive` policy keyed by journal event id and fetches
  batches of 100 into one sequential handler. This preserves the single-worker settle-order
  invariant while preventing sweep duplicates and removing the pg-boss idle poll between every
  event. The original standard-policy queue is retired in place; retained old jobs are not
  executed, and pending journal rows converge through the v2 minutely sweep.
- **Single-worker startup guard (2026-06-21):** the event fanout design remains single-replica
  until settle ordering is redesigned for HA. `OFAPI_EVENT_WORKER_REPLICAS` defaults to `1`, and
  the worker refuses to register the OFAPI event handlers when it is configured to any other value.
  This is a loud operational guard, not a horizontal-scaling implementation.
- **Account→page mapping:** new nullable unique `pages.ofapi_account_id`. Owner-only admin flow (`GET/POST /api/v1/admin/ofapi/webhook`) registers the webhook at OFAPI with `account_scope: global` and a freshly generated signing secret (stored as an `encryptJson` envelope, same custody as the Telegram bot token; the previous secret is kept and accepted as a rotation grace window, since registration rotates remotely before persisting locally), then auto-maps OFAPI accounts to OnlyFans pages by unambiguous username match; everything else is reported back for manual resolution. Events for unmapped accounts are journaled but not fanned out.
- **Fanout `GET /api/v1/events/stream`:** chatter API-key auth only, frames filtered to the chatter's assigned pages. Frames are core's copy of the desktop `SyncEvent` union (`syncEventSchema` in contracts; `accountId` = OFAPI `acct_…` id) plus a `messageDeleted` extension. Live path: worker `pg_notify`s journal ids on commit; the API process holds one shared LISTEN connection that re-reads the journal from its delivery watermark after every (re)connect, so frames settled during LISTEN gaps still reach connected clients. Replay: `Last-Event-ID` header (or `lastEventId` query param) reads forward from the journal by `fanout_seq`; subscribe-before-replay buffering (deduped by the exact replayed id set) closes the gap between catch-up and live. Streams are capped at 15 minutes so key revocation and page reassignment take effect on reconnect, and slow consumers (>1 MB buffered) are dropped — clients resume via `Last-Event-ID`.
- **Journal-only events:** `transactions.new` is subscribed and journaled (future OF analytics enrichment) but not fanned out — the desktop has no frame for it and a chat-list hint would trigger credit-charged refetches.

**Also shipped with this change (ChatMuse pre-P4 prerequisites):** `PUT …/fans/{platformUserId}/profile` auto-creates the fan + page membership for OnlyFans pages instead of 404 (core's OnlyFans sync is transactions-only, so non-spenders were unwritable; reads and Fansly stay strict), and `POST /api/v1/ai-usage/batch` skips events with invalid `completedAt` per-event, reporting a new `invalidCount`, instead of failing the whole batch.

**Rationale:** Webhooks are ~100× cheaper than polling OFAPI (1 credit/100 events vs 1 credit per uncached call) and the desktop needs push for its P3 milestone. SSE (not websockets) per decision #25. Async processing via pg-boss keeps the receiver inside OFAPI's delivery timeout and reuses existing worker/retry/cron infrastructure; LISTEN/NOTIFY bridges worker→API across the two-container deployment without new infrastructure.


## OFAPI OnlyFans DM Sync + Account Health (2026-06-11)

**Decision #49:** OnlyFans pages get the same core DM features Fansly pages have — DM history in `page_dm_threads`/`page_dm_messages`, conversation previews, workboard eligibility, sync-blocks observability, account-health alerting — fed by onlyfansapi.com on top of the decision-#48 webhook journal. Implements Phases 1–3 of `docs/ofapi-integration-plan.md` (Phase 4 deferred); core stays read-only toward OnlyFans, OnlyMonster transactions/audience sync and the ChatMuse SSE contract are untouched. Each phase ships behind its own default-off flag: `OFAPI_DM_PROJECTION_ENABLED`, `OFAPI_DM_SYNC_ENABLED`, `OFAPI_ACCOUNT_HEALTH_ENABLED`.

- **Phase 1 — live DM projection (webhook-first, D1/D2):** a post-settle step projects settled `messages.received/sent/deleted`, `messages.ppv.unlocked`, and `tips.received` journal rows for OFAPI-mapped OnlyFans pages into the platform-agnostic DM store via the existing `page-dm` repo helpers — conversation id = fan's OnlyFans user id, HTML stripped to plain text (journal keeps the raw payload for `OFAPI_EVENT_RETENTION_DAYS`), heads advance forward-only, unread heuristic (fan message increments, model head reply zeroes; workboard keys off `last_message_sender_role`, so the heuristic is non-load-bearing until reconcile corrects it). Projection bookkeeping lives on the journal row (`projection_status/_error/_attempts`, migration 0028) and the minutely sweep retries pending/failed rows (attempt cap 5) — settle/fanout (`fanout_seq`, SSE) is byte-for-byte untouched, by construction: the projection runs only after the settle transaction commits and never throws into it. DM-type rows are stamped `projection_status='pending'` at receive time regardless of the flag, so enabling later back-projects the journal still inside retention. `messages.deleted` deletes the held row and recounts (Fansly has no vanished-message handling to mirror — this is the plan's stated fallback); `ppv.unlocked` stamps the new `page_dm_messages.purchased_at`; `tips.received` raises the held message's tip total monotonically (annotations survive REST re-walks because already-stored rows are never re-upserted). The `messages_live` block reads webhook ingest freshness (age of last settled `messages.*` event, display-only, conservative 24 h staleness); the workboard queue/snooze endpoints accept OnlyFans pages and the v2 recompute includes OFAPI-mapped ones (`resolveAccessibleFanslyPage` was Fansly-only — the "comes free from D3" assumption in the plan was wrong for the workboard read path).
- **Phase 2 — bootstrap + reconcile (REST, budgeted, D3/D4/D5):** OFAPI-mapped pages route their `dm_conversations`/`dm_messages` executor streams to OFAPI REST handlers; the parked OnlyMonster polling path stays untouched behind `ONLYFANS_DM_POLLING_ENABLED` for unmapped pages (the executor skip, the planner force-pause, and the stream filter all exempt eligible pages — pages paused before the flag flip need one manual resume from the sync dashboard). The client (`listChats`/`listChatMessages`) paces requests client-wide (`OFAPI_REST_DELAY_MS`, 500 ms), honors 429 `retry-after`, and records `_meta` credits/rate into `sync_http_attempts` via `executeObservedRequest`. dm_conversations does one offset-checkpointed full chats walk (limit 100, recent-first), then page-1 reconciles every `OFAPI_DM_RECONCILE_INTERVAL_MINUTES` (6 h): unread counts are taken as authoritative, heads only ever advance (a fresher webhook projection is never regressed), diverged chats get a `dm_messages` follow-up. dm_messages walks per-conversation `order=desc` with the `first_id` cursor — live-doc-verified as *inclusive*, so the cursor echo is dropped — straight down to the retention tier (200 regular / 1000 spender from existing `fan_spend_lifetime` data, plan recommendation 4) with Fansly coverage transitions (exhausted/overlap → `complete`, cap → `partial_window`; no deep-backfill pacing — OFAPI is an official API, the Fansly quota dance is unnecessary). Budgets (D4): per-chunk request cap (`OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN`), UTC-day credit ceiling (`OFAPI_DM_DAILY_CREDIT_BUDGET`) and last-observed balance floor (`OFAPI_CREDIT_FLOOR`) tracked in the new `ofapi_credit_state` singleton (migration 0029; credits are account-global, so deliberately not per page); request-cap blocks yield normally, budget/floor blocks park the stream for an hour. Admin trigger/pause/resume/reset and the `messages_history` block work unchanged (D3, verified by tests).
- **Phase 3 — account health + credit ops (D9):** `accounts.*` events project post-settle into `pages.ofapi_auth_status`/`ofapi_auth_changed_at` (raw event suffix, forward-only by receive time; migration 0030), overlaid on the `connection` block — action states (`authentication_failed`, `otp_code_required`, `face_otp_required`) flip the chip to error; `session_expired` alerts but does not (OFAPI fires it after silent recovery). Alerts reuse the notification-incident machinery (debounced, Telegram-backed, gated by the existing `syncFailureAlertsEnabled`): per-page `ofapi_auth` incidents resolve on `connected/reconnected`; account-global `ofapi_low_credit` (last `_meta` balance < `OFAPI_CREDIT_ALERT_THRESHOLD`) and `ofapi_webhook_silence` (no journaled events for `OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES` = 12 h conservative default while mapped pages exist; silent when the journal is empty — no baseline) run from the minutely OFAPI sweep. Global incidents carry no page, so `notification_incidents.platform_account_id` became nullable (they don't appear in the page-joined incident listing; the Telegram alert plus the admin endpoint are their surface). `GET /api/v1/admin/ofapi/webhook` now reports per-page auth status, last-event ages, and the credit balance/day-spend (the only API-surface change, as planned).

**Plan deltas:** migrations are hand-written numbered SQL (`0028`–`0030`) — the repo has no drizzle-kit meta journal, so `pnpm db:generate` does not apply (0027 was hand-written too, the plan/launch-prompt instruction was stale); `page_dm_messages.purchased_at` plus an `(account, message id)` index were added because nothing existed to "mark purchased" (plan said mark, schema had no column); workboard read-path acceptance required the `resolveAccessibleDmPage` resolver + recompute-list change noted above. Phase 0 measurement (events/day by type over the live journal) could not run in the implementation session — no authorized access to the live DB; informational only, the §4 credit math is unchanged.

**Rationale:** Webhooks already deliver complete message payloads (decision #48), so live DM ingest costs ~nothing; REST is reserved for bootstrap/reconcile under explicit credit budgets with the balance read for free from every response's `_meta`. Reusing the Fansly-built DM store, retention tiers, coverage statuses, sync blocks, and incident alerting means OnlyFans pages light up across previews/workboard/dashboard with no new tables for DM data and no new dashboard pages.


## OFAPI Credit Ledger + OnlyFans Audience/Presence/Top-Spender Parity (2026-06-12)

**Decision #50:** OnlyFans pages close the remaining feature gaps with Fansly — subscribers, fan presence, top spenders — and OFAPI credit spend becomes fully accounted and visible. Implements Phases 1–5 of `docs/ofapi-parity-plan.md` (Phase 0 is the owner's ops runbook; §6 non-goals untouched) on top of decisions #48–#49. Core stays read-only toward OnlyFans; the webhook subscription (17 event types), receiver semantics, settle/fanout ordering (`fanout_seq`), and the ChatMuse SSE contract are byte-for-byte unchanged. Each phase ships behind its own default-off flag: `OFAPI_CREDIT_LEDGER_ENABLED`, `OFAPI_AUDIENCE_SYNC_ENABLED`, `OFAPI_PRESENCE_PROJECTION_ENABLED`, `ONLYFANS_TOP_SPENDERS_ENABLED` (the Phase 2 page is owner-gated UI over Phase 1 data and shows a disabled notice while the ledger flag is off).

- **Phase 1 — credit ledger + reconciliation + alerts (D1–D6):** append-only `ofapi_credit_ledger` (migration 0031; sources `rest | webhook_accrual | external | refill | adjustment`, positive = spent). The client itself is the single spend tap (D1, enforced by a gate test keeping `OFAPI_BASE_URL`/the host inside `ofapi.ts` + `config.ts`): both request paths — including the plain admin path, now operation-tagged (`ofapi_webhook_crud`, `ofapi_admin_accounts`) — parse `_meta` on every response that reached the server, retries included, and report through an injected `onCreditSpend` sink that writes the ledger row and the `ofapi_credit_state` day counter in one transaction (D2; the dm-sync guard skips its own counter write when the ledger owns it, and keeps the pre-ledger behavior with the flag off). Server-reported credits always win (D3); a 2xx without `_meta` books an `estimated` 1-credit row; error responses without `_meta` book nothing — reconciliation absorbs hidden charges and empirically answers whether errors bill (plan rec. 1). Daily 00:40 UTC accrual posts `ceil(events/100)` per completed UTC day from our own journal (idempotent via a partial unique index on `accrual_day`, backfills the retention window, `occurred_at` inside the accrued day so daily/burn aggregates attribute correctly). Hourly bank-style reconciliation walks balance observations (≥60 s apart, |residual| < 1 ignored, cursor + drift on `ofapi_credit_state`) and decomposes drift into `external`/`refill` rows; in-window "known spend" excludes prior `external`/`refill` rows (their ids postdate the windows they describe). New debounced `ofapi_burn_rate` incident on trailing-hour spend (all sources except refills) over `OFAPI_BURN_ALERT_CREDITS_PER_HOUR` (300), from the minutely sweep. Optional daily balance ping (`OFAPI_BALANCE_PING_ENABLED`, 00:05 UTC) anchors quiet days.
- **Phase 2 — credit usage UI (D7):** owner-only `/ofapi-credits` page fed by exactly three `requireOwner` routes: `credits/summary` (balance, UTC-day spend by source, per-stream budgets whose park states mirror the executor guards, floor, 7-day forecast, open `ofapi_*` incidents, reconciliation cursor, last posted accrual day, and the current UTC day's pending webhook estimate as `ceil(today_webhook_events / 100)` kept separate from posted spend), `credits/daily` (dense per-day spend by source, balance series — newest-2000-capped — refill markers, and the operation/page breakdowns, so the breakdown period selector rides this one query and D7's three-route budget holds), `credits/ledger` (filtered, paginated, page-labeled). New-page checklist followed (breadcrumbs, owner sidebar entry, `contracts:generate`, route + dashboard render tests); the stacked daily bars are a generic shared `StackedBarChart`.
- **Desktop-facing C2 endpoint (2026-06-19):** `GET /api/v1/ofapi/credits/summary` is bearer chatter-key only and scoped to the key's current page assignments. It returns assigned-page REST credits from page-attributed ledger rows plus webhook credit estimates derived from assigned-page journal event counts for today and the current seven-day UTC window. It deliberately omits owner-only global balance, refills, external drift, and adjustments; owner/global accounting stays on `/api/v1/admin/ofapi/credits/*`.
- **C3 spend projection and staged apply (2026-06-19):** `OFAPI_SPEND_PROJECTION_SHADOW_ENABLED` gates a separate `ofapi_spend_projection_events` table. It writes comparison rows first: live-captured `transactions.new` becomes integer-mill pending/settled spend input, `messages.ppv.unlocked` is only an estimated purchase signal, and `tips.received` writes `projection_status='blocked'` with `tips_received_live_fixture_required` until a live verified fixture replaces the documented example. Rows are idempotent by domain key and back-project from retained journal rows via the minutely OFAPI sweep. `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED` is a second default-off staged flag (`requires: OFAPI_SPEND_PROJECTION_SHADOW_ENABLED`) that applied only missing `transactions.new` projection rows into the core `transactions` table in its first implementation, created the fan/page membership, and rebuilt spender/revenue rollups from the affected date. The 2026-06-19 implementation was forward-only: existing mismatched transaction rows were not overwritten, `messages.ppv.unlocked` remained estimated-only, `tips.received` remained blocked, and desktop sweep cadence was unchanged. Owner-only `GET /api/v1/admin/ofapi/spend/comparison` compares projection rows against current core `transactions` truth over a bounded window and classifies `matched`, `missing_in_core_truth`, page/fan/amount/state mismatches, `ppv_estimated`, `tips_blocked`, `blocked`, and `skipped` rows with sample deltas; comparison normalized OFAPI `settled` to core `posted`. Production recheck at 2026-06-19 22:55 UTC showed api/worker running shadow+ingest enabled; over 30 days, `transactions.new` matched 11/11 (`302950` gross mills / `242350` net mills), all mismatch buckets were zero, and `messages.ppv.unlocked` remained estimated-only (`ppv_estimated=6`, `278000` gross mills). D6 stays blocked until PPV/tips policy is accepted and the desktop rollback-controlled rollout is explicitly approved.

- **C3 ingest correction (2026-06-21):** `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED` stays default-off and must remain off until terminal/reversal comparison is clean. The apply path is now terminal-only: pending/loading `transactions.new` rows stay shadow-only; `settled` and `reversed` rows are selected until core transaction truth matches the normalized state. Existing transaction rows are updated when the terminal state, amount, sender, or canonical type differs. Reversed rows are represented as posted `refund` adjustments with negative gross/net mills, and comparison normalizes reversed amounts and state the same way. `new_subscription` maps to core `subscription` spend; `messages.ppv.unlocked` remains estimated-only and `tips.received` remains blocked pending a verified live money fixture.
- **Phase 3 — audience (D6/D8):** the `subscribers` stream gains an OnlyFans branch for OFAPI-mapped pages: a budgeted `fans/active` offset sweep (hard 20/page cap per the OpenAPI validation; `{data:{list,hasMore}}` unwrapped with a bare-array fallback) every `OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES` (1440), checkpointed in `page_sync_cursors`, feeding the same `fans`/`page_fans`/`page_subscriptions` tables — `subscribedOnData` prices in dollars → mills, renew/ends from `expiredAt`, auto-renew = `status != "Set to Expire"`, tier null, no `*Summ` money (D8). End of sweep mirrors the Fansly generational expiry, guarded against an unexpectedly-empty first page and against contradictory pagination (empty page + `hasMore`), both refusing destructive finalization. The sweep has its own request cap and daily ceiling (`OFAPI_AUDIENCE_*`; ledger-attributed `ofapi_fans_active` spend when the ledger is on, global-counter fallback otherwise) plus the shared floor. Between sweeps, a post-settle `subscriptions.new/renewed` projection (same invariants and journal bookkeeping as the DM projection, stamped `pending` regardless of the flag) upserts the subscription forward-only — the webhook carries no dates, so the sweep owns renew/expiry. Stream plumbing mirrors the DM-polling gate (planner force-pause + request filter for non-eligible pages; the executor skips gracefully if a manual resume races a run in); the audience sync block lights up for eligible pages. **Load-bearing:** dependency evaluation became platform-aware — OnlyFans DM streams never depend on `subscribers`/`followers`/`top_spenders`, so a permanently-paused audience row can never dependency-block the decision-#49 DM sync (regression-tested).
- **Phase 4 — presence (D9):** `users.online`/`users.offline` journal rows project post-settle into the existing presence store (`page_fans.external_presence_*`) for known fans only — unknown ids are skipped, never fetched. `last_seen_online_at` carries the right value for both directions ("now" on online, the historical lastSeen on offline) and the store's `greatest()` semantics keep out-of-order events from regressing. The DM projection folds message-payload partner `lastSeen` into the same store in its existing journal pass (plan rec. 5), and the Phase 3 sweep contributes per-fan `lastSeen` — all under a new `ofapi_last_seen` source now in the workboard presence contract enum. `workboard-presence` gains a DB-read-only OnlyFans branch (refresh is a no-op, no platform credentials needed) for eligible pages; everything else keeps the verbatim Fansly-only rejection, and workboard v2 gates are untouched.
- **Phase 5 — top spenders (D10):** the `top_spenders` stream gains an OnlyFans branch computing rankings **from the existing transactions table** (zero OFAPI credits): the same month-window bootstrap + trailing-7-day steady state as Fansly, anchored on the earliest spender-relevant transaction, written into the same `page_fan_identities` store with `fan:{platformUserId}` identities; windows never split (a DB aggregate has no provider cap). The aggregation reuses the spenders-v2 transaction filter, so window sums reconcile with `fan_spend_daily`. `top_spenders` joins the OnlyFans financials block; the Top Supporters page needed no work — it reads the platform-agnostic spenders-v2 projections.

**Plan deltas:** (1) the balance ping cannot use `GET /accounts` — the OpenAPI spec shows it returns a bare array with **no `_meta`** — so it reads `chats?limit=1` on the first mapped page (same 1-credit cost, guaranteed balance anchor) and falls back to `listAccounts` defensively; (2) `fans/active` wraps the page as `{data: {list, hasMore}}` and hard-caps `limit` at 20 (prose says 50, validation wins) — the client maps both shapes; (3) the breakdown-by-operation/page tables ride the `credits/daily` route so the API surface stays at exactly three routes (D7); (4) the "rankings store the Fansly stream fills" is `page_fan_identities` — per-identity gross/net for the latest processed window, no rank column or top-N retention — and the Top Supporters page reads transactions-derived spenders v2, so the OnlyFans handler matches the store's real semantics and the acceptance check became reconciliation between the two; (5) the platform-aware `SYNC_STREAM_DEPENDENCIES` change wasn't in the plan but is required by its own invariants (above); (6) the DM stream's daily ceiling keeps decision #49's global-day-counter semantic ("keep the D4-style guard"), so with the ledger on, audience/admin spend counts toward it — audience's own ceiling (300) below the DM ceiling (500) preserves DM headroom, and the audience ceiling itself is ledger-attributed per D6; (7) live-verification caveats stand: `fans/active` renew/expire/"Set to Expire" semantics, the subscription webhook's `{PRICE}` formatted string, and OFAPI's real webhook-charging cadence are coded defensively and should be checked against live responses per plan §7 before trusting field-level numbers; (8) two stale tests were corrected in passing — the OnlyFans workboard 400 expectation that decision #49 had already obsoleted, and a dm-sync diverged-head test whose fixed fixture dates stopped qualifying once the wall clock passed them.

**Rationale:** The ledger turns the only authoritative signal (`_meta._credits.balance`) into a checkbook that fully decomposes spend into core/webhooks/external/refills without inventing price tables, while the day counter keeps budget checks cheap and the single client-side tap makes unaccounted spend structurally impossible. Audience, presence, and top spenders reuse the Fansly-built stores, blocks, and admin controls end to end — the only new read surface is the one owner credit page — and the webhook journal keeps doing the heavy lifting: subscriptions and presence ride events that are already paid for, the audience sweep costs ~20 credits per 400-fan page per day, and top spenders cost nothing at all.


## Mixed-Platform Revenue Windows: Disclose, Don't Align (2026-06-13)

**Decision #51:** The OnlyFans trailing revenue offsets (`ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS` in `packages/shared/src/time.ts`: `7d` spans 8 calendar days, `30d` spans 31 — one day longer than the defaults other platforms use) stay exactly as they are, and mixed-platform reports disclose the difference instead of aligning it away (audit B2). Every revenue report (`overview`, `model`, `page`) now carries a required `platformWindows` array with the exact `from`/`to` and comparison bounds each platform contributed; the top-level `from`/`to` remains the union (unchanged); and the dashboard Overview renders a footnote whenever a displayed total combines windows of different widths.

**Rationale:** The offset was introduced by `153bc96` ("Fix OnlyFans revenue rollups and resync recovery", 2026-03-09) with no recorded rationale — presumably to absorb vendor data lag — and has been in production math since. Changing the numbers now would silently shift every OnlyFans `7d`/`30d` total against history and against whatever operational expectation motivated the offset. Disclosure keeps the revenue math byte-for-byte identical while making the metadata and the UI honest: the response names each platform's real window, and the Overview says so wherever a mixed sum (and its vs-previous delta) is displayed.


## OFAPI DM Cold Archive (2026-06-19)

**Decision #52:** Core adds a separate forward-only cold DM archive, distinct from both the raw OFAPI webhook journal and the capped hot `page_dm_threads` / `page_dm_messages` operational store. The first implementation is gated by the default-off staged boot flag `OFAPI_DM_COLD_ARCHIVE_ENABLED` (`requires: OFAPI_DM_PROJECTION_ENABLED`) and writes only message-shaped future webhook deliveries (`messages.received`, `messages.sent`, `messages.deleted`) in the post-settle path. It deliberately has no historical bulk backfill and no separate archive sweep over retained journal rows.

- **Schema:** migration `0037_dm_message_archive.sql` creates `dm_message_archive`, keyed by `(platform, ofapi_account_id, platform_message_id)`, with page/account/chat/fan/message ids, sender role, text, integer-mill PPV/tip amounts, source event metadata (`source_idempotency_key`, `source_journal_id`, `source_fanout_seq`, `source_received_at`), normalized media metadata, tombstone `deleted_at`, retention metadata, and timestamps. There is no FK to `ofapi_webhook_events` because the journal is pruned after `OFAPI_EVENT_RETENTION_DAYS`; archive rows keep their own durable source metadata.
- **Forward-only behavior:** the archive hook runs from `processOfapiWebhookEvent` after the settle transaction commits, before/alongside the existing best-effort projections, and catches/logs failures without changing settle/fanout/projection state. Message replays are idempotent; a later message-shaped event may fill a prior tombstone's missing fields, but it never clears `deleted_at`. The existing DM projection sweep can still back-project the hot operational store, but it does not call the cold archive, so enabling this flag later does not bulk-archive retained historical journal rows.

- **Retry/status correction (2026-06-21):** cold archive attempts now mark the source journal row with `archive_status`, `archive_attempts`, `archive_error`, and `archived_at`. The post-settle attempt first marks `pending`, then records `archived`, `skipped`, or `failed`; the minutely OFAPI sweep retries `pending`/`failed` archive rows up to the archive attempt cap. Rows that settled while the archive flag was off remain `archive_status='none'`, so enabling the flag later still does not bulk-archive old retained journal rows. The owner status endpoint surfaces pending/failed archive counts, the latest archive error, and the retry cap.

- **Deleted-message retention:** `messages.deleted` is an archive tombstone, not a transcript erasure request. The governed archive may retain previously archived text and sanitized media metadata for the configured retention window, while every deleted message row must carry `deleted_at` explicitly and must never be resurrected by a later message-shaped replay.
- **Media and money:** cold storage stores stable media metadata only (`id`, type, readiness/locked state, dimensions/duration when present). It never stores signed/raw CDN URLs, media blobs, or full raw webhook payloads. Money uses integer mills, matching core transaction/revenue storage.
- **Governance surface:** `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS` defaults to 3650 days; the existing OFAPI cleanup queue purges expired archive rows by `retain_until`. Owner-only `GET /api/v1/admin/ofapi/dm-archive/status` exposes the enabled flag, retention days, row/tombstone counts, last archived/source timestamps, archive lag, and policy markers: owner-only ACL, source-journal audit, daily retention purge, no raw transcript export endpoint yet, stable-media-metadata-only storage.

**Non-goals:** no historical bulk `GET /messages` backfill, no media download/storage, no raw transcript export API, no analytics dashboard scanning raw archive rows directly, and no desktop spend-sweep or polling cadence change. Historical import still needs explicit owner/admin acceptance of read-state risk, budget, retention, ACL, audit, purge/export, and backfill controls.


## OFAPI Sync Snapshot and Replay-Gap Recovery (2026-06-19)

**Decision #53:** The SSE fanout distinguishes an empty replay from a cursor that has fallen
behind journal retention. `GET /api/v1/events/stream` checks the durable fanout sequence
high-water and the oldest retained journal row before hijacking the response. A stale
`Last-Event-ID` receives HTTP `409 sync_snapshot_required`; a cursor ahead of the server receives
HTTP `400`. The sequence high-water is read from `ofapi_webhook_events_fanout_seq`, so gap
detection still works if every journal row has been pruned.

- **Snapshot endpoint:** chatter-key `GET /api/v1/events/snapshot` is scoped to one assigned OFAPI
  account and paginated by internal thread id. The first page captures `snapshotCursor` before
  reading projection state; later pages reuse that cursor. The client persists it only after every
  account/page is applied, then reconnects SSE from that cursor. Events settled after cursor
  capture are replayed normally, so concurrent snapshot reads cannot lose them.
- **State and coverage:** the snapshot contains current hot chat heads/messages, cold-archive
  deltas and tombstones after the requested cursor, current account-auth state, page/account
  coverage, source timestamps/sequences, and explicit omissions. Presence and typing are omitted
  as ephemeral state. `resumeAllowed=false` when either DM projection or the cold archive is
  disabled, preventing a partial durable snapshot from advancing the client cursor.
- **Bounded behavior:** no OFAPI request, historical message backfill, media download, or raw signed
  media URL is introduced. Thread pages are bounded (`limit<=50`); hot-message retention remains
  the existing 200/1000 per-thread policy, while archive rows are included only when they overlay
  the hot window or are deltas after the client's requested sequence.

**Rationale:** replay retention is an implementation bound, not a correctness policy. A silent
empty replay allowed a long-offline desktop to claim live freshness after skipping durable events.
The 409 plus snapshot/tail protocol makes the gap explicit while preserving page ACLs, idempotent
apply, and the existing polling fallback until desktop snapshot recovery is deployed.


## OFAPI Desktop Read Gateway (2026-06-19)

**Decision #54:** The first C6 custody slice is a default-off, read-only compatibility gateway at
`GET /api/v1/ofapi/read/*`, enabled by `OFAPI_DESKTOP_READ_GATEWAY_ENABLED` only when the OFAPI
credit ledger is enabled. The desktop's existing OFAPI client can use this prefix as its base URL:
account-scoped GET paths and JSON response shapes remain unchanged, while the desktop sends its
revocable chatter key to core instead of receiving the unscoped vendor key.

- **Fail-closed allowlist:** only the desktop's current reads are accepted: chats/messages/chat
  media, users/mass-list, transactions, fans, user lists, vault metadata/lists/items, and async
  upload status. Every path segment and query name/value is validated and bounded before an OFAPI
  request. There is no wildcard method proxy: POST/PUT/PATCH/DELETE, sends, unsends, likes,
  mark-read, typing, and uploads are absent.
- **ACL and account discovery:** `/accounts` is synthesized from the caller's current assigned
  OFAPI-mapped pages, and `/whoami` is a sanitized core identity. Account-scoped reads return 404
  unless the OFAPI account maps to an assigned page, avoiding account-existence disclosure.
- **Spend and retry ownership:** the existing core OFAPI client remains the only vendor network
  chokepoint and records every response under a bounded `ofapi_gateway_*` operation with page
  attribution. Known-free upload-status polls record zero credits. Gateway reads make exactly one
  upstream attempt and preserve response JSON, credit/rate headers, HTTP status, and Retry-After;
  the desktop remains the idempotent-read retry authority during migration. Core-wide pacing and a
  120 requests/minute gateway route limit bound request pressure.
- **Rollout boundary:** this slice does not switch desktop production, remove the local OFAPI key,
  or proxy any command. Direct desktop mode remains the rollback path until the command outbox,
  indeterminate write handling, media uploads, production SLO/runbook, and explicit desktop
  gateway switch are complete.

## OFAPI Command Outbox Contract (2026-06-19)

**Decision #55:** Core owns a versioned command outbox before it owns any desktop write. The first
slice is intake/read/cancel only behind `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED`; it cannot call OFAPI.
Vendor execution is a separate dependency-gated flag,
`OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED`, and is not enabled or implemented by the intake slice.
There is no generic path/method proxy.

- **Initial command:** `send_text_message_v1` only. The request carries
  `clientCommandId` (UUID), OFAPI `accountId`, numeric `conversationId`, non-blank text up to
  10,000 characters, and optional `retryOfCommandId`. Media, PPV, uploads, typing, mark-read,
  likes, unsend, and arbitrary vendor payloads are not accepted by this version.
- **API ownership:** chatter-key `POST /api/v1/ofapi/commands` creates or deduplicates a command;
  `GET /api/v1/ofapi/commands/{commandId}` reads one command owned by that chatter;
  `POST /api/v1/ofapi/commands/{commandId}/cancel` cancels only `queued` commands. Responses never
  echo message text. Account ids must map to a page currently assigned to the chatter.
- **States:** core persists `queued`, `in_flight`, `confirmed`, `failed_retryable`,
  `failed_terminal`, `indeterminate`, and `cancelled`. `draft/local_pending` remains desktop-local.
  Intake creates only `queued`; cancel transitions only `queued -> cancelled`. An executor may later
  claim `queued -> in_flight`, with at most one in-flight command per page/conversation lane.
- **Dedupe:** unique key `(page_id, chatter_user_id, client_command_id)` with a minimum 400-day
  retention horizon. Repeating the same canonical request returns the existing command with
  `deduplicated=true`; reusing the id with a different account, conversation, kind, retry lineage,
  or payload hash is `409 conflict`. Core never derives the id from message text.
- **Retry lineage:** retries are new commands with new client ids. `retryOfCommandId` must refer to a
  command owned by the same chatter on the same page/conversation and already in
  `failed_retryable`, `failed_terminal`, `indeterminate`, or `cancelled`. Core never auto-retries an
  `indeterminate` command.
- **Outcome rule:** any execution attempt that may have reached OFAPI becomes `indeterminate`
  unless a response or matching `messages.sent` event proves a terminal outcome. Definite
  pre-delivery failure may become `failed_retryable`; policy/validation rejection becomes
  `failed_terminal`; a vendor response or matched webhook confirms the command. Retry decisions
  remain human-visible and create a new command.
- **Audit/privacy:** the outbox stores the versioned payload for later execution, but read APIs,
  logs, diagnostics, and audit metadata expose only ids, state, payload hash, timestamps, attempt
  count, error code/class, and verifier result. Message text is never logged or returned by command
  status endpoints. The purge/export policy is defined in
  `docs/ofapi-command-outbox-contract.md`: terminal rows must eventually tombstone payload text
  while retaining non-text audit metadata, and owner/admin exports must exclude command text.
  Runtime purge now redacts old terminal payloads from the minutely command sweep; raw payload
  export remains out of scope.

**Rollback:** disabling command intake rejects new commands while retaining existing audit rows.
Disabling future execution parks queued commands and prevents new claims; it never changes a
previously `in_flight`/terminal record or makes desktop retry automatically.

**C6b1 implementation:** migration `0038_ofapi_command_outbox.sql`, the `ofapi_commands` repository,
strict core-owned contracts, and chatter-key create/read/cancel routes implement the non-executing
slice. `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` is default-off and requires the read gateway. The
schema enforces one in-flight row per page/conversation lane for the future executor, but this
slice has no code path that transitions to `in_flight` or calls OFAPI.

**Production rollout (2026-06-19):** revision `ea81511d92de` was first deployed with the staged
flag off and returned `503` to a real chatter-key create. After an audited version-1 staged
override and a second canonical deploy, both API and worker heartbeats reported read gateway and
command outbox enabled with no skipped overrides. A harmless command validated create/dedupe/
mismatch/unassigned/read/idempotent-cancel behavior, ended `cancelled` with zero attempts, created
no credit-ledger row, and leaked no payload text to responses or logs. No vendor send was attempted
or authorized. Executor rollout remains a separate decision requiring a controlled test fan.

## OFAPI Command Executor (2026-06-19)

**Decision #56:** Vendor execution is a separate default-off staged boot dependency,
`OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED`, requiring the command outbox. The worker may issue only
the versioned text-send command through the core OFAPI client, with global pacing, page-attributed
credit accounting, and exactly one HTTP attempt per durable row. Lost queue wakeups are recovered
by a minutely sweep; a stale `in_flight` row becomes `indeterminate`, never `queued`.

- A valid 2xx response carrying a message id confirms the command. Definite 4xx rejection is
  terminal; 429 is human-retryable; transport failures, timeout, 408, 5xx, and ambiguous/malformed
  success are indeterminate.
- No raw vendor error body or message text may enter logs, status responses, or verifier metadata.
- A settled `messages.sent` webhook may repair an in-flight/indeterminate outcome only for one
  unique account + conversation + normalized-text candidate inside a bounded attempt window.
  Ambiguous matches do nothing. The executor does not add a `GET /messages` verifier.
- Execution is deployed off first. Production enablement requires an explicitly controlled test
  fan, one harmless approved send, proof of one vendor/ledger attempt, response/webhook
  confirmation, and rollback proof. Desktop writes do not switch before that gate.

**C6b2 implementation:** migration `0039_ofapi_command_execution.sql` adds attempt timestamps,
queued/verifier indexes, and an at-most-one-attempt constraint. The API enqueues only after durable
insert; zero-retry pg-boss execution plus a minutely recovery sweep drive the worker. The core
OFAPI client now has one typed text-send method with global pacing and page-attributed ledger
reporting. Status responses expose attempt timestamps, and settled `messages.sent` events run the
unique-match verifier as a best-effort post-settle step. The execution flag remains default-off;
implementation does not authorize a production send.

**Default-off production rollout (2026-06-19):** revision `47a36525e653` was deployed and verified
with API/worker healthy. Migration `0039` and the new schema columns/constraint are present.
Runtime heartbeats reported outbox enabled, execution disabled, and no skipped overrides. A real
chatter-key command validated create/read/cancel while staying `attempt_count=0`; no execute job,
`ofapi_command_send_text` ledger row, payload-text log, or vendor send was observed.
Non-live recovery UX and payload purge/export policy are now defined in the command contract; the
runtime payload purge is implemented; desktop transport UI and controlled live send remain pending.

**Payload redaction rollout (2026-06-19):** revision `bbd42e844f36` deployed migration `0041`
and the minutely sweep redaction path with execution still disabled. Production validation proved
the new column/index, active API/worker flags (`outbox=true`, `execution=false`), zero command-send
ledger rows, zero old terminal unredacted production rows, and a rollback-only redaction smoke that
left no synthetic row behind.

## OFAPI Typing Command Custody (2026-06-20)

**Decision #58:** The first non-text desktop write centralized after text sends is the advisory
typing beacon. It extends the existing command outbox instead of adding a generic write proxy.

- **Command kind:** `typing_active_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, durable dedupe, and one-attempt executor as text commands. Payload is exactly
  `{}`.
- **No retry/recovery:** typing is lossy and cosmetic. `retryOfCommandId` is rejected, desktop does
  not need status recovery UI for a missed beacon, and re-sending typing later is a fresh command.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/typing` through the core
  OFAPI client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** the endpoint is documented free, so a successful response without `_meta` records
  zero estimated fallback credits under operation `ofapi_command_typing_active`; provider
  `_meta._credits.used` still wins if returned.
- **Verifier/privacy:** `messages.sent` webhook repair applies only to `send_text_message_v1`.
  Typing rows confirm only from the endpoint response, keep `platform_message_id=null`, and expose
  only non-payload audit fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new typing claims
  just like text commands. Desktop Direct write transport remains the rollback path until all write
  kinds are centralized and production-soaked.

**Production validation:** revision `405fe9e41bff` deployed through the canonical dist-only path
with migration `0043_ofapi_command_typing_active.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` created command
`729fb32c-c313-4481-9c7c-c64963ec8df3`, which reached `confirmed` after one vendor attempt,
kept payload `{}`, kept `platform_message_id=null`, and wrote one `ofapi_credit_ledger` row under
`ofapi_command_typing_active` with HTTP 200, zero credits, and `estimated=false`. Bounded log/API
checks contained only command/page/kind/outcome metadata. The rollback drill staged execution
`false`, recreated API/worker, proved command `e2d9024f-84e7-44df-a8e4-cd768d58ee49` stayed
queued with zero attempts and no new ledger row, cancelled it, then restored execution `true`.
Final API/worker heartbeats reported outbox `true`, execution `true`, AI gateway `true`, and zero
skipped overrides. The temporary validation key was revoked and its page assignment removed.

## OFAPI Unsend Command Custody (2026-06-20)

**Decision #59:** The next safe non-text write centralized after typing is unsend for already-sent
creator messages. It extends the existing command outbox instead of adding a wildcard DELETE proxy.

- **Command kind:** `unsend_message_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, durable dedupe, and one-attempt executor as other command kinds. Payload is
  exactly `{ "messageId": "<numeric OnlyFans message id>" }`.
- **No retry/recovery:** unsend is destructive and a second DELETE after an ambiguous first attempt
  can produce a different platform result. `retryOfCommandId` is rejected; any second unsend is a
  visible human action after checking the conversation state.
- **Vendor request:** one
  `DELETE /api/{accountId}/chats/{conversationId}/messages/{messageId}` through the core OFAPI
  client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** operation `ofapi_command_unsend_message` records page-attributed OFAPI credit
  observations from `_meta`; a successful response without `_meta` falls back to the normal
  one-credit estimated REST assumption.
- **Verifier/privacy:** text/webhook matching applies only to `send_text_message_v1`. Unsend rows
  confirm only from the DELETE response in this slice; `messages.deleted` remains the downstream
  projection/tombstone evidence. APIs and logs can include command id, page id, command kind, and
  target platform message id, but never message text or media URLs.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new unsend claims.
  Desktop Direct write transport remains the rollback path until all write kinds are centralized
  and production-soaked.

**Production validation:** revision `8d75e4f94d93` deployed through the canonical dist-only path
with migration `0044_ofapi_command_unsend_message.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` first created a fresh owner-owned text
message (`c6f73e57-8b51-4c13-aef7-6ced300390f5`, platform id `10090438628342`), then created
unsend command `21cd8d41-8383-40b2-8418-7ca01067ea85`. The unsend command reached `confirmed`
after one vendor attempt, kept payload `{"messageId":"10090438628342"}`, recorded
`platform_message_id=10090438628342`, and wrote one `ofapi_credit_ledger` row under
`ofapi_command_unsend_message` with HTTP 200, one credit, and `estimated=false`. Webhook journal
rows for the target message included projected `messages.sent`, `messages.received`, and paired
`messages.deleted` events. Bounded log/API checks contained no text canary, payload, media URL, or
signed CDN fields. The rollback drill staged execution `false`, recreated API/worker, proved
command `358ad76c-3670-494a-800f-b99fe35b5474` stayed queued with zero attempts and no new ledger
row, cancelled it, then restored execution `true`. Final heartbeats reported outbox `true`,
execution `true`, AI gateway `true`, and zero skipped overrides. The temporary validation key was
revoked and its page assignment removed.

## OFAPI Mark-Read Command Custody (2026-06-20)

**Decision #60:** The next safe command after unsend is explicit chat mark-read. It has no
message text/media payload, but it still mutates OnlyFans read state, so it extends the existing
command outbox instead of adding a generic write proxy.

- **Command kind:** `mark_chat_read_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, durable dedupe, and one-attempt executor as other command kinds. Payload is
  exactly `{}`.
- **No retry/recovery:** mark-read is a state mutation. `retryOfCommandId` is rejected; any later
  mark-read is a fresh explicit action from the desktop open/read workflow.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/mark-as-read` through the
  core OFAPI client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** operation `ofapi_command_mark_chat_read` records page-attributed OFAPI credit
  observations from `_meta`; a successful response without `_meta` falls back to the normal
  one-credit estimated REST assumption.
- **Verifier/privacy:** webhook text matching applies only to `send_text_message_v1`. Mark-read rows
  confirm only from the POST response in this slice. APIs and logs can include command id, page id,
  and command kind, but never message text, media URLs, or arbitrary vendor response fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new mark-read claims.
  Desktop Direct write transport remains the rollback path until all write kinds are centralized
  and production-soaked.

**Production validation:** revision `8fb9a9bc8393` deployed through the canonical dist-only path
with migration `0045_ofapi_command_mark_chat_read.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` created mark-read command
`be5c38b9-2697-4bc1-81de-957ec8db2368`. The command reached `confirmed` after one vendor
attempt, kept payload `{}`, kept `platform_message_id=null`, and wrote one `ofapi_credit_ledger`
row under `ofapi_command_mark_chat_read` with HTTP 200, one credit, `estimated=false`, and
`attemptNumber=1`. Bounded worker log checks contained command/page/kind metadata only and no
payload, text, media URL, signed CDN field, or conversation/account text. The rollback drill staged
execution `false`, recreated API/worker, proved command
`4bbd0943-5e56-4500-9125-38928b89ebd9` stayed queued with zero attempts and no new ledger row,
cancelled it, then restored execution `true`. Final heartbeats reported outbox `true`, execution
`true`, AI gateway `true`, and zero skipped overrides. The temporary validation key was revoked and
its page assignment removed.

**Decision #61:** The next safe send-write slice after text/typing/unsend/mark-read is
media/PPV message send using already-existing OFAPI media identifiers. It does not centralize
desktop local file upload. Upload still requires a separate file-byte, storage, MIME, and audit
design.

- **Command kind:** `send_media_message_v1`, with the same `clientCommandId`, account,
  conversation, page/chatter ACL, durable dedupe, one-attempt executor, and same-kind retry lineage
  as text commands.
- **Payload:** `text` may be empty; `price` is `0` or an integer from `3` through `200`;
  `mediaFiles` is a non-empty bounded array of numeric vault IDs or `ofapi_media_*` IDs; `previews`
  is a bounded subset of `mediaFiles`. Payload rejects URLs, file bytes, arbitrary vendor paths,
  reply-to fields, and unknown fields.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/messages` through the core
  OFAPI client. Core maps numeric vault IDs to numbers, preserves `ofapi_media_*` strings, omits
  empty `previews`, and derives `lockedText=true` only when `price > 0` and caption text is
  non-blank.
- **Retry/recovery:** retry is allowed only from an owned terminal/indeterminate media command in
  the same lane. A retry is a new command row and never a second attempt on the same row.
- **Accounting:** operation `ofapi_command_send_media` records page-attributed OFAPI credit
  observations from `_meta`; missing `_meta` follows the existing one-credit estimated REST
  fallback.
- **Verifier/privacy:** a `messages.sent` webhook may repair an in-flight/indeterminate media
  command only when account, conversation, normalized caption text, price, media count, time
  window, and uniqueness all match. APIs/logs may include command id, page id, kind, and platform
  message id, but never payload text, media IDs, media URLs, file names, or arbitrary vendor body
  fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new media command
  claims. Desktop Direct write transport remains the rollback path until upload and any other
  remaining write kinds are centralized and production-soaked.

**Production validation:** revision `2dbb5f407c52` deployed through the canonical dist-only path
with migration `0046_ofapi_command_send_media_message.sql` applied at
`2026-06-20 05:02:06.041099+00`; API and worker image labels matched the revision and dependency
checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`. The owner-only route
was `lora-vip-of` page 9 to `loravie` conversation `518588958`. A governed archive lookup found an
existing owner media id without URLs. Free media command `8360d753-3c2a-420d-9621-6221e1d65cf0`
confirmed after one attempt, `price=0`, `media_count=1`, `preview_count=0`, and platform message id
`10091143135310`. Ledger row `20` recorded `ofapi_command_send_media`, page 9, HTTP 200, one
credit, `estimated=false`, and `attemptNumber=1`. Cleanup used already validated unsend command
`c4a8ef8d-8ab7-4f7a-ac90-225bde2ce746`; ledger row `21` recorded the DELETE and webhooks
`16680`-`16683` projected sent/received/deleted evidence for platform message id `10091143135310`.
API/worker log checks over the validation window found no caption canary, media id, `mediaFiles`,
`mediaUrl`, signed/CDN/download URL, or filename fields. The rollback drill staged execution
`false` at config version 10, recreated API/worker, proved media command
`756d2124-4d23-4ad6-9367-ddd5709f97dc` stayed queued with `attempt_count=0` and no new media ledger
row, cancelled it, then restored execution `true` at version 11. Final heartbeats reported outbox
`true`, execution `true`, AI gateway `true`, zero skipped overrides, and zero nonterminal commands.
The temporary validation key was revoked and its page assignment removed; the validation user has
zero active keys and no assigned pages.

## ChatMuse AI Gateway Contract (2026-06-19)

**Decision #26 update:** The first ChatMuse AI gateway slice is a default-off, chatter-key,
SSE-streaming provider gateway. Desktop continues to build prompt blocks and parse/render results;
core takes custody of provider keys, chatter/page authorization, quota decisions, provider network,
and the durable cost ledger. This is a prompt-streaming v1, not yet a core-owned transcript/context
builder.

- **Wire contract:** `docs/ai-gateway-contract.md` defines the planned
  `POST /api/v1/ai/gateway/stream` request and SSE frame shapes. The exported zod schemas live in
  `packages/contracts/src/routes.ts` as `aiGateway*` contracts before any runtime route is added.
- **Feature compatibility:** gateway `feature` uses the existing `ai_usage_feature` closed enum:
  `fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `scan`, `ping`, and
  `hi-greeting`. Desktop-only `compare` stays local orchestration and maps to the underlying
  feature operations.
- **Ledger/quotas:** runtime implementation must reserve quota before provider network and record
  one terminal ledger row keyed by `(userId, clientRequestId)` with page, feature, model, provider,
  provider response id, tokens, integer micro-USD cost, cache markers, quota decision, and outcome.
- **Privacy:** raw prompt text, transcript text, generated reply text, and raw provider error bodies
  may stream through runtime but must not be persisted in logs, diagnostics, audit, or the ledger.
- **Rollback:** local desktop provider keys remain supported until the gateway is deployed,
  production-validated, and disabling the gateway flag demonstrably restores direct mode.

**R4b runtime gate:** `CHATMUSE_AI_GATEWAY_ENABLED` is now a default-off, staged boot-applied flag
and `POST /api/v1/ai/gateway/stream` exists as a chatter-key route. With the flag off it returns
`503` before page lookup, quota reservation, provider network, or ledger writes. With the flag on,
it verifies page assignment/platform and still returns `503` before provider execution until the
next runtime slices add Anthropic streaming, quota reservation, and durable ledger rows.

**R4c ledger storage:** migration `0040_ai_gateway_usage_ledger.sql` extends
`ai_usage_events` with nullable gateway metadata (`page_id`, provider/provider response id,
micro-USD cost, approximate-cost marker, quota decision, and terminal gateway outcome) while
preserving the existing `(user_id, client_event_id)` idempotency key. Direct desktop
`/api/v1/ai-usage/batch` events continue to store default cost `0` and null gateway fields.
Runtime provider execution and quota enforcement remain pending and default-off.

**R4d quota preflight:** the gateway now checks ledger-backed UTC-day usage per
`(chatter_user_id, page_id)` before provider execution. `CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT`
defaults to `200` and `CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT` defaults to `5000000` ($5.00);
either set to `0` blocks provider attempts. Over-quota requests return `429 rate_limit_exceeded`
before Anthropic/OpenRouter network and before any new ledger write. Atomic provider-attempt
reservation/finalization remains part of the provider execution slice.

**R4e pricing utility:** the gateway has a pure Anthropic pricing helper for terminal ledger rows.
It prices the desktop-supported `anthropic:*` ChatMuse models in integer micro-USD, includes
prompt-cache read/write rates, marks aggregate cache-write usage approximate when the provider does
not supply a 5m/1h breakdown, and rejects unsupported models instead of silently underpricing them.
The helper is not yet wired to a live provider call; it is the cost basis for the upcoming terminal
usage row.

**R4f Anthropic adapter groundwork:** core can now build an Anthropic Messages streaming request
from the gateway body without calling the provider. The builder mirrors desktop direct-mode tuning:
`5m` prompt-cache blocks use provider-default ephemeral cache markers, `1h` blocks are explicit,
adaptive thinking omits temperature, `claude-opus-4-8` omits sampling parameters, and usage is
normalized into the terminal ledger cost shape. This is still default-off groundwork; runtime route
fanout, cancellation, atomic reservation/finalization, and production validation remain pending.

**R4g SSE provider seam:** `POST /api/v1/ai/gateway/stream` can now emit `event: ai` SSE frames
from an injected provider after chatter-key auth, page authorization, and quota preflight. The
production app context intentionally does not create a provider yet, so the route remains
fail-closed with `503` before external provider network. Provider failures become bounded error
frames with no prompt/provider-body echo; terminal usage ledger writes remain pending until the
real provider execution and quota reservation/finalization slice.

**R4h terminal ledger finalization:** provider-seam streams now write one terminal gateway ledger
row for completed, failed, or cancelled attempts. The row stores page, provider, provider response
id when observed, usage/cost, quota decision, cache-hit marker, regeneration marker, duration, and
gateway outcome without prompt or response text. Existing `(user_id, client_event_id)` idempotency
dedupes repeated terminal writes, but duplicate provider-attempt prevention still needs an atomic
reservation slice before live provider execution is production-ready.

**R4i atomic reservation:** the gateway now reserves `(user_id, client_event_id)` in
`ai_usage_events` before provider execution. A duplicate `clientRequestId` returns `409 conflict`
before provider execution and cannot start a second paid call. Terminal handling updates the same
row.

**R4j Anthropic provider execution:** core now has a real Anthropic Messages streaming adapter
behind the default-off gateway. It is instantiated only when `CHATMUSE_AI_GATEWAY_ENABLED=true` and
`ANTHROPIC_API_KEY` is configured, maps provider text/thinking/usage events into gateway frames,
uses the same abort signal as the SSE route, and relies on the R4i reservation plus R4h finalizer
for ledger state. Direct-host production validation was blocked by provider egress policy; the
proxy-routed R4m path below is the validated production route.

**R4k stale reservation recovery:** before quota preflight on an authorized gateway request, core
marks null-outcome gateway reservations older than 30 minutes as terminal `failed` rows with
zero token/cost counts and a nonnegative duration. `completed_at` remains the original reservation
time so quota and audit attribution stay on the acceptance day. Recovery logs only the recovered
row count and stale threshold; prompt text, generated text, and provider bodies remain excluded.

**Default-off production rollout (2026-06-19):** revision `bf249a4c33c0` is deployed to production
with the AI gateway still disabled. API and worker image labels match
`agency-hub.source-revision=bf249a4c33c0`; both containers are healthy, the gateway ledger columns
exist, and production has `0` gateway ledger rows / `0` stale open reservations. Latest api/worker
heartbeats show `chatMuseAiGatewayEnabled=false`, `anthropicApiKey=unset`, request cap `200`,
micro-USD cap `5000000`, `ofapiDesktopCommandExecutionEnabled=false`, and `skippedOverrides=0`.
Live provider validation remains blocked on an approved small prompt and must not send a platform
message.

**R4l owner usage reporting:** owner `GET /api/v1/admin/usage/chatters` and the dashboard Usage
page now surface gateway ledger cost/outcome metadata: per-chatter micro-USD cost, approximate-cost
marker, gateway request/outcome/open-reservation counts, provider cost breakdown, and per-feature
cost fields. The report remains metadata-only and does not expose prompts, generated replies, or
raw provider bodies.

**R4m proxy-routed Anthropic provider execution:** production Anthropic calls no longer use the
server host IP. After chatter/page authorization, the gateway resolves the page's stored
`egress_endpoints` proxy and passes an undici dispatcher-backed fetch to the Anthropic SDK for that
request. Missing page proxy returns `503` before quota reservation, ledger insertion, or provider
network, so there is no direct-host fallback. Production validation proved SSE streaming, terminal
ledger metadata, prompt/output log redaction, and staged flag rollback; desktop Hub AI still needs a
separate desktop rollout/default decision.

**R4l production rollout (2026-06-19):** revision `736d37c66549` is deployed default-off. API and
worker labels match the revision, health checks pass, latest heartbeats still show
`chatMuseAiGatewayEnabled=false` and `anthropicApiKey=unset`, and production reporting code
successfully returned the new cost/gateway fields against real data (`rowCount=5`, `activeRows=2`,
`totalGatewayRequests=0`, `openReservations=0`).

**2026-06-20 live validation outcome:** the configured Anthropic key and
`claude-sonnet-4-6` model returned 200 from the operator workstation, but the same non-generating
models probe from the production API container returned `403 Request not allowed`. One controlled
gateway request therefore finalized as `failed` with zero tokens/cost and bounded metadata only.
The production key and staged gateway flag were rolled back; desktop Direct AI remains active. The
next validation path is the R4m proxy-routed gateway, not direct production-host egress.

**2026-06-20 proxy-routed validation outcome:** revision `1ff3ebc42d55` was deployed and API/worker
labels matched the source revision. The controlled page `lora-vip-of` was bound to an existing
stored proxy route; runtime proxy diagnostics showed proxy exit IP `171.22.220.242` versus direct
host IP `45.8.230.111`. With `chatMuseAiGatewayEnabled=true`, one owner-scoped non-mutating SSE
request (`8f6d988c-86bd-48dd-b8c8-7370dd7970a8`) completed with frame counts `meta=1`,
`content_delta=2`, `usage=1`, `done=1`, `error=0`. Its ledger row recorded provider `anthropic`,
model `anthropic:claude-sonnet-4-6`, outcome `completed`, provider response id present, `39` input
tokens, `19` output tokens, `402` micro-USD, quota accepted, and page `lora-vip-of`; schema/log
checks showed no prompt or generated text persisted. The staged rollback drill set gateway `false`
and a valid request returned `503` with zero ledger rows, then gateway was restored to staged
`true`. Final heartbeats show read gateway `true`, command execution `true`, AI gateway `true`, and
zero skipped overrides. The temporary validation chatter key was revoked after the test.

## DM Aggregate Analytics Groundwork (2026-06-20)

**Decision #57:** analytics starts with a replaceable aggregate-only table over the governed,
forward-only cold archive. Migration `0042_dm_message_daily_aggregates.sql` adds one row per
page/UTC day with inbound/outbound/deleted counts, distinct conversation count, paid outbound and
tip counts/mills, message time bounds, and source fanout high-water. It stores no transcript text,
media metadata/URLs, or fan identifiers.

An exclusive `ofapi.dm-analytics.rebuild` worker rebuilds the latest 32 UTC days hourly. Rebuild is
delete-and-replace inside one transaction, so webhook replay and tombstone changes converge without
double counting. The table is disposable derived state; rollback pauses the schedule and leaves
the archive untouched.

This is groundwork, not permission to infer unsupported metrics. Response-time pairing, PPV
unlock funnels, revenue attribution windows, and AI-generation-to-send linkage require explicit
identity contracts before implementation. Historical DM `GET /messages` backfill remains out of
scope.

**Production rollout:** revision `1d7be970bbd1` deployed through the canonical dist-only process
with matching API/worker image labels and dependency checksum. Migration 0042 is applied and the
exclusive queue exists. A one-off production rebuild wrote 5 aggregate rows from 779 archive rows
(`355` inbound, `417` outbound, `7` deleted, `4` paid outbound); aggregate privacy-column count was
zero and cold archive media URL leakage count was zero. Webhook pending returned to zero after the
deploy and command nonterminal rows remained zero.

## Fansly Server-Replay Gate — Pass 3 Stage 6 (2026-07-04)

**Decision #62:** Kernel-only Fansly capture (DP 1-B) is unblocked for the two endpoint
families only the extension called: per-fan earnings stats (`/account/wallets/earnings/stats/accounts`),
monthly earnings stats (`.../monthlystats/accounts`), and PPV order history (`/media/orderhistory`).
The day-1 live probe proves core can replay all three server-side with the **single pasted
`fansly-client-check`** — the per-route anti-bot token the extension harvests per route is NOT
required for these families. The `routeChecks` per-route-bundle contingency in the Stage 6 spec
stays unbuilt.

**Evidence (day-1, 2026-07-04):** `fansly:replay-probe --page lilly-1 --page lilly-2 --calls 1`
run read-only from a one-off container off the production image (bind-mounted patched `cli.js`,
page egress + DB-backed pacing; running api/worker never restarted). Per family, both pages:

| Family | lilly-1 | lilly-2 | verdict |
|---|---|---|---|
| earnings/stats/accounts | 200 success | 200 success | replayable |
| earnings/monthlystats/accounts | 200 success | 200 success | replayable |
| media/orderhistory | 400 code 99 | 400 code 99 | replayable — the 400 is a param error on the bare probe (no `accountMediaId`), NOT a 401/403 auth rejection; the session validated server-side |

**Zero auth rejections on either page.** Confirms owner Q2 ("токен не нужен, это безопасно").

**Still open:** the ≥5-day check-longevity re-probe (run once/day; measures whether the pasted
check rots on these routes faster than on core's live routes). Day-1 replayability is sufficient
for the Stage 16 go/no-go; the longevity number feeds the cadence/degradation design.

## Kernel Retention & Redaction Stand-Down — Pass 3 Stage 1 (2026-07-05)

**Decision #63:** The kernel no longer schedules deletion of its own business facts. One
stage branch (`kernel/stage-01-retention-redaction-standdown`, five checkpoint commits)
delivers, effective the next deploy:

- **Retention raised to effectively-forever (36500 d)** for the OFAPI webhook journal,
  the DM cold archive, and sync raw payloads — env *and* code defaults both change, so a
  missing env can never re-enable a short purge. `retentionDate()`/`dmRetentionDate()`
  now stamp far-future; the cleanup jobs stay in place as no-ops.
- **Kill-switches (default OFF):** `PAGE_DM_PRUNE_ENABLED` gates the per-conversation
  `page_dm_messages` prune at all four call sites (two sync finalizes, OFAPI DM sync
  finalize, projection live-ingest refresh); `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED`
  gates the terminal-payload self-redaction inside `sweepOfapiCommands` (at the redaction
  call, which runs before the execution-enabled check). Registry rows added (env-only,
  `NEVER`/`none`); the two retention knobs' registry defaults/labels now tell the truth.
- **DM-message raw persistence (new capture, flagged per spec §7.5):** all three
  DM-message fetch paths persist raw pages with `payload_kind='dm_messages'`
  (OnlyMonster + Fansly persist `page.raw`; the OFAPI client exposes no raw envelope, so
  that path persists the unfiltered item records). Union-only type change; the DB column
  is free text.
- **Consumed-only purge guard:** `deleteExpiredOfapiWebhookEvents` refuses rows whose
  `projection_status`/`archive_status` is `pending`/`failed` regardless of age.
- **Disk-usage alert:** hourly worker cron (`db.disk-usage.check`, :15 UTC) compares
  `statfs("/")` usage against `DISK_USAGE_ALERT_PERCENT` (default 80) and pages the owner
  through the existing Telegram incident layer (`db_disk_usage` kind, one alert per state
  change; Postgres size included as context).

**Deviation from the spec:** §3 declared "no schema change", but §2's "reuse the existing
alert-monitor pattern" requires the incident-kind enum value — **migration 0052**
(`ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'db_disk_usage'`),
additive-only, same pattern as migrations 0030/0031. Rollback story unchanged (an unused
enum value is inert; everything else is env/flag-guarded).

**Verification (local):** `pnpm typecheck` clean; full `pnpm test` suite green —
**166 files, 1398/1398** (Testcontainers applied migration 0052). Behavior-change tests:
prune no-op over a >cap conversation, redaction-off leaves >7 d terminal payloads intact,
purge guard deletes old consumed / refuses old unconsumed, DM sync chunk writes
`dm_messages` raw rows, disk alert opens/resolves on threshold crossings. One existing
test updated to the new truth: the OFAPI backfill-cap test now expects 201 stored
messages (fetch-side window cap still bounds the backfill; finalize no longer prunes).

**Prod exit (§3.8) pending owner deploy:** env `OFAPI_EVENT_RETENTION_DAYS=36500` +
`OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS=36500` in `/opt/agency-hub/.env.production`,
standard deploy (ships 0052), optional idempotent re-stamp of pre-deploy
`sync_raw_payloads.retain_until`, then the §5 V1–V5 checks (exact SQL in the stage
file's `## Progress` block). **Risk carried forward:** fact tables now grow without
bound by design — the disk alert is the containment; retention tiering returns as a
safe cache policy in Stage 28. No off-box backup (Q3) unchanged and now covers strictly
more data.

## Pass 3 Spec Fixup — pre-execution review findings (2026-07-05)

**Decision #64:** An owner-run architecture review of the Pass 3 stage corpus (three
subagents + spot verification against code) surfaced spec defects that would trip a
blind executing session. Verified against the cited files and applied as doc-only
amendments to `docs/project-kernel/pass3/` (roadmap §4 passports, §5 table + tracks,
and the affected stage headers/sections; this entry committed on branch
`kernel/pass3-spec-fixup` — the kernel docs themselves live outside version control):

- **Stage 7/8 key-table insert protocols** were unimplementable as written (key row
  inserted first while `observation_keys.observation_id` / `domain_event_keys.event_id`
  are NOT NULL and the identity id does not exist yet). Fixed: pre-allocate the id via
  `nextval(pg_get_serial_sequence(…))`, the key insert carries it, the journal/event
  row inserts with `OVERRIDING SYSTEM VALUE`. No rollback branch — the protocol stays
  composable inside the webhook receiver's transaction.
- **Dependency graph tightened:** 31 and 32 gain hard dep 11 (their entry criteria
  already required the capture lane); 33 gains hard dep 20 (dashboard-on-SDK is its
  substrate); 26 gains soft 19 (ESLint config); 28 ↔ 29 gain mutual soft deps (28's
  acceptance-rate metric needs 29's class; 29's content tables rely on 28's lake
  exclusion + erasure reach).
- **Stage 20 method/path source fixed:** `routeSchemas` carries neither; the generator
  recovers `{method, path}` by booting `buildApiServer` and joining registered routes
  to registry keys by schema-object identity (the proven `generate.ts` pattern), with a
  both-ways reconciliation assertion; explicit registry fields stay the fallback.
- **Sensitive kinds excluded from the generic lake:** Stage 28's exporter exclusion
  list gains a kind granularity (initially `desktop.guard_audit`); excluded kinds
  export to `lake/restricted/…` (same manifest/verify discipline, restricted access)
  so DETACH still loses nothing. Stage 11 records the kind on that list.

**Reviewed and declined** (recorded so they are not re-litigated): splitting Stage 29
into provider/budgets vs content capture — the mutual soft deps suffice; a
`sensitivity_class` substrate before Stage 7 — DP 6-A full-content capture is an
accepted owner decision and kind-level lake exclusion covers the gap; reordering 22
before 11 — it would stall the capture track, and the lane's rate limit, body cap, and
kind allowlist stand (a per-principal volume alert on `desktop.unknown:*` is noted as
cheap hardening at execution time); resizing Stage 23 — its spec already carries the
claim-lease schema, attribution, compensating-event undo, and v1-route removal the
review believed missing.

## Kernel Destruction-Door Guards + Chatter-Read-Scope — Pass 3 Stage 2 (2026-07-05)

**Decision #65:** The two classes of one-action data loss are closed, on branch
`kernel/stage-02-destruction-doors` (based on the `kernel/pass3-spec-fixup` tip so this log
stays linear; five checkpoint commits + one test-fixup commit):

- **Chatter-read-scope gate.** The four raw revenue/transaction routes (page revenue,
  transactions, revenue/daily, per-fan transactions) now require a dashboard session role
  (owner/team_lead) via `enforceRevenueRouteRoleScope`, layered after the existing
  `canAccessPage` page scope. `REVENUE_ROUTE_ROLE_ENFORCEMENT` starts in `log`
  (serve + `would-deny` log, the 48 h observation window) and flips to `enforce` (403) by env.
  The chatter-facing spenders board is untouched (regression-tested). **Entry criterion
  verified in client code, not assumed:** desktop calls core only for `/api/v1/pages`, fan
  profiles, and OFAPI read lanes; the extension calls pages/profiles/`ai-usage/batch` and
  builds its spenders board against Fansly directly — neither touches the gated routes.
- **Reset door.** `resetSyncBlock` refuses `messages_history` with 409 before touching any
  state (it would hard-delete every stored DM for the page); it returns with the Stage 10
  archive. Checkpoint (`audience`) and top-spender (`financials`) resets stay available.
- **Page-delete door.** Admin page DELETE refuses 409 while the page holds transactions or
  DM history (`getPageBusinessFactPresence` handler check; the 38 CASCADE FKs are Stage 13's
  RESTRICT flip). Empty pages still delete. `pages.deleted_at` lands as unwritten substrate
  for Stage 13.
- **Workboard undo/reclassify.** `deleteLastWorkboardContact` → `retractLastWorkboardContact`
  (marks `retracted_at`; both contact-log readers exclude retracted rows).
  `clearClosingCacheForPage` → `supersedeClosingCacheForPage` (marks `superseded_at`;
  verdicts become an append log; all five closing-cache joins and three scans read active
  rows only).

**Deviation from the spec (§3):** the spec's migration sketch was ADD-COLUMN-only, but its §2
supersede design ("keep prior verdicts … let the new run write fresh rows") is impossible
under the existing full `UNIQUE (platform_account_id, platform_message_id)` on
`wb_closing_cache` with an upsert writer. **Migration 0053** therefore also converts that
unique into a **partial unique index on active rows** (`WHERE superseded_at IS NULL`), and
the upsert targets it via `targetWhere`. Additive-safe: existing rows are all active; no
rewrite; rollback keeps the columns harmlessly.

**Verification (local):** `pnpm typecheck` clean; full `pnpm test` **166 files, 1402/1402**
(Testcontainers applied migration 0053; schema-guard green). New tests: 4-route gate in
log/enforce + owner-session + spenders regression; reset 409 + audience/financials resets
still 200; fact-bearing delete 409 / empty delete 200; undo retraction with reader
exclusion; supersede + fresh-run reinsert with reads returning only the active verdict. Two
existing tests were updated to the new truth (admin CRUD delete now meets the guard;
sync-blocks unit reset test documents the refusal).

**Prod exit (§3.8) pending owner:** merge the chain (stage-01 → pass3-spec-fixup →
stage-02), deploy (ships 0053; no env change — `log` is the default), review 48 h of
`would-deny` logs (expected zero legitimate hits given the client-code grep), then set
`REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce` + restart and run the §5 smoke checks (chatter-key
403 probe, fact-bearing delete refusal, retraction/supersede marker queries — exact
commands in the stage file's `## Progress`). **Risk carried forward:** none new; the
messages_history reset stays unavailable until Stage 10, and Stage 13 must reconcile with
`pages.deleted_at` rather than adding a second tombstone column.

## Desktop Stop-Loss — Pass 3 Stage 4 (2026-07-05)

**Decision #66:** The desktop stops destroying facts daily — the client-side twin of Stage 1.
Desktop repo branch `kernel/stage-04-desktop-stop-loss` (three checkpoint commits off local
main 5d298d4; full `pnpm check` green):

- **Usage spool never self-deletes** (d0c094c): the legacy drop-after-3-failures rule is
  retired. Failed events keep persisted attempts and park in a dead-letter tier after the 3rd
  failure — retried on app start and on an hourly sweep, never removed. `kind:'dropped'` is
  gone from the onError union (compile-time proof). Backoff extends to a capped [5 s..60 m].
  HTTP-400 quarantine kept and now exportable (diagnostics `usageQuarantine`: count +
  payloads). Core's `(userId, clientEventId)` dedup absorbs re-sends.
- **Prune horizons ×10** (4a2bfcf): messages 5,000 → 50,000 per chat; spend 31 d → 310 d;
  guard-audit TTL 90 d → 3,650 d. Constants only, mechanisms kept, pin tests added.
- **Purge warning + version header** (e79a259): the DangerZone purge flow now states the
  kernel holds no copy of local messages/transactions/telemetry and offers diagnostics export
  inline (the false "next sync rebuilds it" reassurance corrected); every hub request carries
  `x-client-version` (Proposal 4.1, accepted 2026-07-04), injected from main so
  packages/shared stays platform-pure — the fleet-version exit signal and Stage 11's
  producer version.

**Deviations:** (1) the spec's "purge flow renderer test" is unimplementable — the desktop
repo has no component-test infrastructure (no jsdom/@testing-library, zero .test.tsx);
coverage = the typed i18n catalog + unchanged confirm logic. (2) The Q5 artifact diff used a
macOS dir-build instead of `pnpm dist:win` (the script hard-asserts win32) — valid because
the asar payload is the platform-independent bundled JS, proven below.

**Q5 artifact-diff verdict (the assumption was FALSE):** the served
`ChatGoose-Setup-0.1.28.exe` (sha512 matches latest.yml) contains an app payload
**byte-identical to a clean build of desktop `origin/main@145260a`** ("release: bump desktop
to 0.1.28"; sole delta = CRLF in index.html from the Windows CI checkout). Nothing exists
only in the artifact — but 0.1.28 is NOT a version-bump-only build: **the desktop repo's
local main and origin/main have diverged 5-and-5**. Inside 0.1.28 and missing locally:
01b25e7 (activity-panel mockup fixture), e8016da (Online snapshot staleness fix), 62d00fb
(Hub confirmed-send projection fix), 5ebf171 (live OFAPI read-transport switching fix).
Local-only and missing from origin: b1dd980, 77d5014, 84038b8 + two doc commits. Per the
stage spec §7.1 the 0.1.29 release is **blocked until the owner reconciles the branches**
(merge/rebase, then rebase the stage branch — one likely small conflict in
apps/desktop/src/main/index.ts — then bump 0.1.28 → 0.1.29, tag, windows-build workflow).
Exact steps in the stage file's `## Progress`.

**Risk carried forward:** local DBs grow ~10× slower-bounded (accepted; DangerZone shows
dbBytes); `usage_events` spool grows unbounded while the hub is unreachable (accepted,
disk-bounded, surfaced in diagnostics); the desktop branch divergence is a NEW standing risk
until reconciled — every desktop session before the merge builds on a main that lacks four
production fixes.

## OnlyMonster Export Is Vacuous — Pass 3 Stage 5 (2026-07-05)

**Decision #67:** The passport's full historical export has nothing to operate on, verified live
(00:47 UTC, read-only):

- **V1 provenance census:** every OnlyFans transaction is OFAPI-sourced — `lora-of` 685/685,
  `lora-vip-of` 2168/2168, **0 rows** with non-`ofapi:` raw_type on either page.
- **V2 stream census (7 days):** only shared planner streams (light, followers, transactions,
  top_spenders, subscribers, dm_conversations, dm_messages, followers_reconcile) — no
  OnlyMonster-specific stream; V1's zero rows proves no OnlyMonster writer ran regardless.
- **Egress:** 0 calls to `omapi.onlymonster.ai` in api+worker logs (caveat: containers were
  recreated tonight so log history is short; Q1's 48 h check of 2026-07-04 found the same zero).

No export job is built; no data moves. **Standing risks carried forward:** (1) no off-box backup
of any kind exists (Q3 declined, owner-accepted) — re-raise no later than Stage 28; (2) the
OnlyMonster subscription, if still billed, is cancellable at the owner's discretion and is tracked
in Stage 15; (3) the dead OnlyMonster adapter code stays in-repo until Stage 18's seam. If any
later census finds an OnlyMonster-sourced row, this entry is superseded per append-only law and
the full-export spec (preserved in this stage file's history) re-activates.

## Phase A Close-Out — Stages 1, 2, 3, 5 Exited (2026-07-05 ~01:40 UTC)

**Decision #68:** All four stages prod-verified in one owner-compressed session (windows
shortened at explicit owner instruction — "i don't want to wait", "do everything now"):

- **Stage 1 exited.** V1: 0 rows match the purge predicate (semantic proof) and the journal
  grew 80,128→80,705 with the oldest row (2026-06-27 03:59) untouched post-deploy; the first
  live 02:30 UTC run remains armed as redundant confirmation. V2 (shortened 48 h→~1 h live
  traffic): 0 of 29,765 baseline conversations decreased; prune structurally disabled. V3: no
  new redactions (kill-switch off). V4: dm_messages raw captures flowing (1→4 rows). V5: disk
  drill passed live (incident #25, Telegram sent, threshold restored). 471,389 raw payloads
  re-stamped far-future.
- **Stage 2 exited.** Deployed in log mode; 0 `would-deny` in all api logs; flipped to
  `enforce` (owner go); live probe: 4×403 on the gated routes with a fresh chatter key
  (revoked after 60 s), 200 on spenders and the bearer surface. Deviations: 48 h log window
  shortened (~30 min + client-repo grep evidence); the dashboard UX smokes (page-delete
  click, workboard undo marker) deferred to natural use — code paths integration-tested.
- **Stage 3 exited.** V1 census: all 15 staged flags running-on on both live instances; V2
  876 archive rows/24 h; V3 28/28 spend-shadow projected; V4 ledger/balance healthy (47,338
  credits, zero incidents); V6 budgets enforcing + burn alert armed. V5 (read-gateway 200)
  recorded on combined evidence — flag running-on, bearer surface proven post-deploy, fleet
  chatter key in daily use — the direct 200 probe rides the next desktop session (no
  ofapi/read traffic in the overnight log window). dm_messages stuck-conversation anomaly
  re-surfaced as an independent ops item.
- **Stage 5 exited** per decision #67 (verify-zero; nothing to export).

Unblocked: Stages 7 (in flight), 13 (Q1), and the Phase-A-gated chain. Stage 4's exit still
awaits the desktop branch reconciliation (decision #66).

## Desktop Mains Reconciled — Stage 4 Unblocked (2026-07-05)

**Decision #69:** The desktop repo's diverged mains (5-and-5, found by the Stage 4 Q5
artifact diff, decision #66) were reconciled *in-session* — the owner delegated the
remaining human items ("you could do human items"). Merge commit `e8e7b93` on local main;
safety pointer `backup/main-pre-reconcile-20260705`.

The divergence turned out to be two sessions independently fixing the same two bugs a day
apart, so the merge was semantic, not mechanical:

- **Hub confirmed-send projection:** origin's `send/engine.ts` fix (62d00fb, Jul 1)
  auto-composed with local's deeper insert-if-absent DB projection (b1dd980, Jul 2) — both
  test sets pass together.
- **OFAPI read runtime:** local's validate-before-swap design (77d5014 — candidate
  bootstrap, rollback on activation failure, `onOfapiRuntimeConfigChanged` routing) was
  kept over origin's fingerprint-based live switch (5ebf171) — two complete alternative
  implementations; mixing them piecemeal was rejected. Origin's dep name
  `onOfapiReadConfigChanged` and its plumbing are gone.
- **Ported, not lost:** origin's one non-overlapping renderer fix (e8016da, Online snapshot
  staleness) — `['online', accountId]` invalidation on chats/messages/fans db:changed —
  re-implemented inside local's extracted `dbInvalidation.ts` helper with test-table rows.

Verification: full `pnpm check` green on merged main (1,958 tests) and again on the rebased
stage branch `kernel/stage-04-desktop-stop-loss` @ `69a72bf` (1,965 tests) — the arbiter
was that BOTH sides' tests must pass in one tree. Remaining for Stage 4 exit (owner-only):
merge stage branch, bump 0.1.29, tag, **push** (both repos' local mains are now ahead of
origin — core by 21+ commits), feed verify per stage §5.

## Owner-Delegated Release Session — Core Pushed, Desktop 0.1.29, Stage 7 Fully Live (2026-07-05 ~02:50 UTC)

**Decision #70:** The owner delegated the remaining pipeline actions ("continue please you
can do everything yourself"), with each gated capability individually re-confirmed
(AskUserQuestion: "Deploy now" for the core deploy; "Full release" + "read-only prod
SELECT" for the desktop release and coverage check; the day-2 probe command was pasted by
the owner verbatim):

- **Stage 6 day-2 probe:** verdicts identical to day-1 on both lilly pages — zero auth
  rejections; no check-rot after ~24 h. Days 3–5 remain (once daily via the deployed CLI).
- **Stage 7 build-complete slice deployed:** main fast-forwarded to 5c69c9c
  (3b tail: account_lookup/probe/tracking/trial/dm_conversations/fans_active captures;
  4b: ten admin routes through recordAudit) and deployed dist-only at ~02:47 UTC — health,
  sync-health, dashboard delivery verified. Interim coverage read (02:51 UTC): 13 kinds
  emitting; dm_conversations already the top pull producer (116 rows in minutes);
  schedule-bound kinds (fans_active, identity pages, command_result, operator) pending
  their natural triggers. Suite on the slice: 168 files / 1413 tests green.
- **Core pushed:** origin/main 1a06b5d..5c69c9c — prod = origin = local for the first time
  this phase.
- **Desktop 0.1.29 released:** reconciled main merged with the stage-04 branch (69a72bf),
  bump commit 91d3c2d, final `pnpm check` green on the release commit (1,965 tests), tag
  v0.1.29 pushed (145260a..91d3c2d) — windows-build run 28727409498 publishes to the feed.
  Stage 4 §5 verification (feed serves 0.1.29; x-client-version on ai-usage batches within
  7 days; diagnostics on one Win + one macOS machine) starts once CI lands.

Remaining owner-independent tails: Stage 7 48 h reconciliation (~2026-07-07 morning),
Stage 6 days 3–5.

## Stage 13 Green-Local — Provenance, Currency, Single-Writer Gate (2026-07-05)

**Decision #71:** Stage 13 built and green-local in one session on
`kernel/stage-13-transactions-provenance` (5021ac2; suite 169 files / 1417 tests).
Migrations 0055 (provenance columns, writer seed, backfill, `wrong_transactions_writer`
incident kind) + 0056 (22 of 42 pages.id FKs → RESTRICT, classification recorded in the
migration comment). Two deviations from the spec text, both recorded in the stage
`## Progress`:

1. **`source_observation_id` carries no FK constraint.** `observations` is partitioned
   with PK `(id, received_at)`; PostgreSQL cannot FK a partitioned table on `id` alone —
   the same limitation that forced the `observation_keys` companion in 0054. The column
   is a documented plain bigint; the OFAPI ingest populates it TODAY (not a follow-up)
   by resolving the webhook delivery key through `findObservationByKey`.
2. **The writer-seed invariant continues at the write paths** (elaboration beyond the
   spec): `createPlatformPage` births Fansly pages with `transactions_writer='fansly'`;
   `setPageOfapiAccountId` assigns `'ofapi'` when unassigned. Without this, every page
   created after the migration would refuse its own writer until Stage 14 — including
   live onboarding. An explicit assignment is never overridden.

Also notable: the Stage 2 handler-level 409 on fact-bearing page deletion is REPLACED by
tombstone semantics per the spec's §5 (delete = `status='deleted'`, facts and config
remain — a two-way door; only a raw SQL DELETE is refused, now at the FK level). The
gate refuses NULL-writer pages for every writer; the OFAPI ingest skips only the refused
page (rows stay pending and re-list), other pages keep applying.

Remaining for exit: deploy (migrations 0055+0056), then §5 production checks — source
coverage split, per-page/month revenue totals identical, wrong-writer probe, ingest
flowing post-deploy.

## Stage 13 Deployed + Verified (2026-07-05 ~03:45 UTC)

**Decision #72:** Stage 13 merged to main (d410573) and deployed (owner-confirmed
"Deploy now"); migrations 0055+0056 applied; containers healthy, health + sync-health
green. §5 verification (read-only, same session):

- **Source coverage 100%**: 15,413 rows — fansly:rest 12,560 / ofapi:rest 2,701 /
  ofapi:webhook 152; zero NULLs; zero 'onlymonster' (consistent with #67).
- **Revenue totals byte-identical**: per-page/month count+gross+net snapshot diff
  before vs after migration = empty (106 rows).
- **Writer seed = running reality**: 5 fansly pages → 'fansly', 2 onlyfans → 'ofapi';
  zero wrong_transactions_writer incidents — the gate is live and silent.
- **FK flip exact**: pg_constraint shows 22 RESTRICT / 16 CASCADE FKs on pages —
  precisely the recorded classification.
- **Ingest backlog zero**: all 152 projected transactions.new events applied; the
  overnight max(created_at) (23:00 UTC) reflects quiet hours, not a stall.

The wrong-writer probe requirement is satisfied by the integration suite (no staging
env exists; tests/transactions-writer-gate.integration.test.ts proves refusal +
incident + lossless re-apply end-to-end). Exit flips when the next live webhook spend
lands post-deploy (proving the gated write path in production traffic).

## Stage 8 Green-Local — Domain Events, Canonicalization, Replay (2026-07-05)

**Decision #73:** Stage 8 built green-local in one session on `kernel/stage-08-domain-events`
(4 slices, tip 422fc81; suite 174 files / 1439 tests). **Ordering deviation, owner-instructed
("do not wait"):** built while Stage 7 is deployed+live but not yet exited — the same
compression as Stage 7-on-Stage-1 (#68). The DEPLOY waits for Stage 7's 48 h exit (~07.07);
nothing ships until then.

Delivered: migration 0057 (domain_events partitioned monthly by occurred_at, 2024-01→2026-12
plus a MINVALUE catch-all; gapless-seq and dedup companions per the same partitioned-unique
limitation as 0054); the append protocol proven gapless under 8-way concurrency; webhook /
sync-pull / command-result canonicalizer families with the binding dedup-key table; the
CROSS-PRODUCER DEDUP HEADLINE PROVEN in CI (one DM as webhook delivery + REST page → two
observations, ONE message.received event, replay appends zero); minutely sweep as the replay
executor; events:replay CLI.

Scope decisions recorded in the stage `## Progress`: tips.received undeclared (unverified
fixture — first replay customer); fansly DM pages undeclared (direction needs the page's own
account id — not decidable by a pure function; a later canonicalizer version threads a
context table); onlymonster pages undeclared (vendor retiring, zero prod rows);
subscriber/follower/audience pages next version. One trap for posterity: ORDER BY with a bare
column name resolves to the SELECT's ::text alias → lexicographic sort that looks exactly
like sequence gaps; qualify the column.

Remaining for exit: deploy after Stage 7 exits, days-long type-coverage watch, staging
replay drill, canonicalization-lag p95 baseline.

## Stage 9 Green-Local — Read-Gateway Capture + Attribution (2026-07-05)

**Decision #74:** Stage 9 built green-local on `kernel/stage-09-read-gateway-capture`
(15a0509, branched off the Stage 8 tip for a linear 8→9 merge chain; suite 174 files /
1442 tests). Same ordering deviation as #73 (owner "do not wait"): deploy waits for
Stage 7's exit, chained behind Stage 8.

Delivered: producer 4 — every gateway 2xx response teed into the journal post-respond
(bounded queue, joinable drainer, verbatim body, path-template kind, chatter principal);
fail-open bounded to this producer only, with a drop counter and the new
read_gateway_capture incident kind at threshold. Attribution: migration 0058 adds
ofapi_credit_ledger.actor_user_id; the principal threads gateway → proxyRead → spend
sink → ledger; background REST spenders stay NULL (system). The review's
gateway-attribution gap (§4.4) is closed at both halves.

Deviations recorded in the stage `## Progress`: the <1 ms enqueue micro-benchmark is
skipped as CI-flaky (the guard is structural — a bounded array push); the gateway p95
baseline moves to the deploy step (measured immediately before, same method as after).

Remaining for exit: deploy after Stage 7 (behind Stage 8), 24 h observation-count vs
gateway-request reconciliation, p95 comparison.

## Stage 10 Green-Local — Platform-Neutral Message Archive (2026-07-05)

**Decision #75:** Stage 10 built green-local on `kernel/stage-10-message-archive` (94bf6ca,
off the Stage 9 tip — linear 8→9→10 merge chain; suite 175 files / 1446 tests). This is the
FIRST stage built on an UNDEPLOYED substrate (green-local Stage 8's domain_events); the risk
was flagged to the owner beforehand and the owner instructed to continue ("please do
everything you need and continue now"). Deploys strictly after 8+9 deploy and their
canonicalizers verify live.

Delivered: migration 0059 (message_archive with the Stage 13 RESTRICT fact policy +
projection_seq_watermarks — the spec's watermark table name was taken by the spender
rebuild timestamps, recorded deviation); event-fed writer behind per-account seq watermarks
(received/sent insert, deleted tombstone; ppv_unlocked a recorded v1 no-op); minutely
sweep; one-command rebuild proven to reproduce identical counts from the ledger (the §5.2
template proof, first of its kind); idempotent backfills from dm_message_archive and the
hot table (the single cents→mills conversion, explicit); replay-driven source 3 = Stage 8's
events:replay by construction; owner/team_lead-gated read/search endpoints (chatter 403,
team_lead page-scoped).

Remaining for exit: deploy (after the 7→8/9 chain), prod backfills, 48 h per-conversation
coverage (hot ≤ archive, both platforms present), desktop-visible spot-check.

## Stage 16 Green-Local — Fansly Earnings & PPV Streams, Capture Side (2026-07-05)

**Decision #76:** Stage 16 built green-local on `kernel/stage-16-fansly-earnings` (adefc1a,
chain 8→9→10→16; suite 176 files / 1447 tests). Central deviation, capture-first: the parse
side (adapter typing, `fan.earnings_observed`/PPV canonicalizers, the fan_earnings_stats
projection writer, the read endpoint) is DEFERRED to a canonicalizer-v2 slice AFTER the
single-page ramp captures a live payload corpus — the shapes are probe-grade unknown and
guessing schemas pre-ramp is precisely what capture-now-parse-later exists to avoid. The
projection TABLE ships now (0061) so v2 is code-only. Observations lose nothing; replay
fills events retroactively.

Design findings: the order-history endpoint is per-fan and CURSORLESS — the "back-scroll"
is a checkpointed keyset walk over page_fans (new listPageFanNativeIds), cursor resets on
exhaustion = incremental refresh. Ramp gates are live-editable rather than boot-staged
(ramp flips must not need restarts — staged-by-process, live by mechanism). Bulk streams
are deliberately absent from SYNC_DOMAIN_POLICY supporting lists: a flag-off stream must
not degrade the page's block-health UX to "catching up".

Remaining for exit: deploy with the chain (flags off = inert), single-page ramp 48 h
(lilly-1/lilly-2 — sessions probe-proven), canonicalizer v2 + projection from the captured
corpus, fleet enable, 2-week incident watch.

## Stage 17 Green-Local — Fansly Backscroll Backfill (2026-07-05)

**Decision #77:** Stage 17 built green-local on `kernel/stage-17-backscroll` (29e49d4,
chain 8→9→10→16→17; suite 176 files / 1448 tests). Same deviation family (#73–#76).

Delivered: (1) the Fansly DM canonicalizer Stage 8 had deliberately deferred — sync-pull v2
resolves message direction against a per-run page→native-account-ref context map, keeping
canonicalizers pure (the context is an argument, not a lookup inside); tips stay in mills;
missing own-ref rows are recoverable via events:replay (recorded edge). (2) The semantics
audit CONFIRMED the spec's suspicion: the deep-backfill walk was depth-capped by
stored_message_count < retention_limit, not walk-to-exhaustion (value ordering was already
spender-first, pre-satisfying the spec). Extension per extend-don't-replace: live-editable
fanslyDeepBackfillIgnoreRetentionLimit (12th live key) lifts the cap for the exhaustion
crawl. (3) fansly:backscroll-report manifest CLI — the exit criterion reads from it.

Design note recorded: manual "sync all" expands via domain lists, which deliberately
exclude the bulk streams — scope requests never hammer them; they ride the recovery/planner
cadence.

Remaining for exit (ops, after the chain deploys): flip the cap knob, weeks-long crawl,
weekly manifest watch, §5 prod checks at 100% exhausted.

## Stage 16 Parse Side Landed — Extension-Proven Shapes (2026-07-05)

**Decision #78:** The owner asked for the canonicalizer without waiting for the ramp
("can we do canonicalizer somehow now"). Resolution: the deferral's premise was "no
trusted shape source until live capture" — but a trusted source EXISTS: the extension
parses these exact responses in production daily. Shapes derived from its parsers
(chatgoose `shared/types.ts`), units confirmed mills by core's own treatment of the same
endpoint family. The ramp's role flips from discovery to verification.

Landed on the Stage 17 branch (600284b; suite 177 files / 1449 tests): sync-pull v3 —
`fan.earnings_observed` per fan per window with content-hashed dedup (unchanged snapshot
re-fetch appends zero, CI-proven) and `message.ppv_unlocked` with a composite key
(deviation: order-history rows carry NO order id — `ppv:<fan>:<media|bundle>:<createdAt>`);
the `fan_earnings_stats` projection writer (watermark pattern, on-demand fan upserts,
forward-only observed_at) in the projection sweep + `projection:rebuild`. Stage 16's
remaining deferral shrinks to: adapter typed schemas (cosmetic post-ramp) + the owner-grade
read endpoint (Stage 33 or a later slice).

## Stage 13 Exited — Live Webhook Spend Through the Gate (2026-07-05)

**Decision #79:** Stage 13 flips to **exited** (prod-verified 2026-07-05 ~11:40 UTC).
The §5 exit condition — the first live daytime webhook spend writing through the
single-writer gate — was met twice over: a $4.99 subscription at 08:36 UTC and a
$13.00 message purchase at 10:28 UTC, both stamped `source='ofapi:webhook'` with
`source_observation_id` attached. Zero `wrong_transactions_writer` incidents; the two
`transactions.new` webhook observations since deploy map 1:1 to the two written rows
(no ingest backlog). Verified in a read-only session authorized by the owner.

Consequence: Stage 14 (OFAPI transactions truth + historical backfills) is unblocked —
its dependencies 13+5+3 are now all exited — and its build starts immediately per the
owner's standing "continue without waiting".

Same session, for the record: Stage 7 interim coverage healthy (webhook 3,130 obs /
9 kinds, pull 1,662 / 9 kinds since the 02:47 deploy; `command_result`/`operator` at
zero — traffic-dependent, watch at Monday's reconciliation). Read-gateway p95
baseline-by-logs is NOT available (no gateway lines in api logs in 24 h) — Monday's
pre-deploy baseline needs an active probe instead. The live `onlyfans/dm_messages`
bug is now evidenced: pages lora-of/lora-vip-of have NEVER succeeded; ~400 attempts/24 h
on `GET /:accountId/chats/:chatId/messages` (limit=100) all abort on the client-side
timeout — diagnosis proceeding as non-stage work.

## Stage 14 data-exports lane evaluation — verdict (2026-07-05)

**Decision #80 (part 1, spec task 7):** POST /api/data-exports was priced on paper
against the marker-walk REST cost using the vendored spec. Facts: creating an export
costs 0 credits (status `calculating_credits`; scraping types charge after the fact,
per-export dynamic pricing), and the flow is async (create → start → poll → download).
The REST marker-walk baseline: the pages' ENTIRE current history is 685 + 2,170 rows
≈ 29 pages of 100 ≈ ~30 credits for a full re-walk — a rounding error against the
200/day backfill budget. Verdict: **do not adopt now.** The lane only wins if the
depth probe (task 2) reveals a large pre-2025-09 tail that needs a bulk pull; the
"one live probe" (create a transactions-type quote, never start it, delete) rides the
same owner-gated ops window as the depth probe. Re-evaluate then; otherwise closed.

## Stage 14 Green-Local — Built Same Day Its Dependencies Exited (2026-07-05)

**Decision #80 (part 2):** Stage 14 build complete on `kernel/stage-14-ofapi-transactions`
(off the Stage 17 tip — the chain stays linear 8→9→10→16→17→14; deploy still rides
Stage 7's exit). **Suite 179 files / 1458 tests green.** Five slices:

1. **Day-budget guard on the backfill CLI** (DP 2's binding condition): new 'backfill'
   scope in reserveOfapiDayCredits (own counter pair, migration 0062), knob
   `ofapiBackfillDailyCreditBudget` (default 200), reserve-before-every-request via the
   shared createOfapiRestGuard; refusal stops the walk with an explicit
   `budget_exhausted` stop reason ("resume tomorrow"; re-runs converge).
2. **Explicit fee/VAT/tax capture** (migration 0063): verified live shape —
   transactions.new carries fee_amount/vat_amount/tax_amount dollars-float
   (gross − fee = net; VAT buyer-side). Carried contract → shadow row → truth ingest →
   REST backfill; fill-only upsert semantics (an omitting writer never erases).
3. **tips.received UNBLOCKED**: 3 natural webhooks landed 2026-06-30..07-03 — the
   passport's condition. Two traps the prod probe settled: top-level `user_id` is the
   CREATOR (constant across tippers per page) — the fan is `payload.user.id`; and tips
   ALSO arrive as transactions.new (412 truth rows), so tips.received maps as an
   estimated shadow SIGNAL (never ingest truth — no double-count). Legacy blocked rows
   self-heal through the regular sweep (re-list filter + shared domain key). New benign
   comparison status `tips_signal`. Follow-up unlocked, deferred: declaring
   tips.received in the Stage 8 canonicalizer family (a version bump; ledger loses
   nothing meanwhile).
4. **Chargebacks via OFAPI**: daily 03:10 UTC reconcile behind
   `ofapiChargebacksReconcileEnabled` (boot, default off). Collision trap solved:
   payment.id is the ORIGINAL transaction's id → chargebacks write under
   `{payment.id}:chargeback`, never demoting the settled row (CI-proven). Gross/net/
   fees negated (OnlyMonster shape); writer-gate enforced per page; backfill budget lane.
   First run walks full history, then a trailing 90-day window.
5. **fan_identities OFAPI branch**: tracking/trial-link users via 4 new client methods
   behind `ofapiFanIdentitiesSyncEnabled` (boot, default off), audience budget lane.
   Recorded simplification: no cross-run cursor — links are few, upserts idempotent,
   runs converge across cadence under the per-run request cap.

Remaining (ops, not build): depth probe per page + conditional top-up (task 2, live
credits — owner-gated window), the data-exports live quote (#80 part 1), deploy with
the chain (migrations 0062+0063 additive-inert), §5 checks over a week.

**Also fixed same session (live prod bug, outside the plan):** lora-of/lora-vip-of
dm_messages NEVER succeeded — the chat-messages read is scraped server-side and scales
with chat size, so the two largest conversations always exceeded the 15 s client abort
(~400 futile attempts/24 h). Fix: 60 s slow-lane timeout for `ofapi_chat_messages` only
(46216dd). Rides the chain deploy; cherry-pickable onto main if wanted sooner.

## Post-Stage-14 tail: tips canonicalizer v2 + Stage 4 fleet-verify gap (2026-07-05)

**Decision #81:** Two same-day follow-ups on the chain (both ride the Monday deploy):

1. **ofapi-webhook canonicalizer family v1→2** (23f8aed): tips.received declared from
   the live-verified shape — its own `tip.received` event (dedup `tip:<notificationId>`,
   fan = payload.user.id), distinct from `transaction.posted` so money is never counted
   twice. The parse_version-0 tips observations waiting in prod become the sweep's first
   real replay customers; NB the version bump re-scans the whole webhook corpus once
   (dedup keys make it append-zero; paced at 20 pages/family/minute).
2. **Stage 4 exit-gap fix** (9613c9e): the fleet-verify check ("x-client-version: 0.1.29
   from every active machine in core logs") had NO data source — core never logged the
   header (fastify doesn't serialize headers; no proxy in compose). New bounded observer
   logs one "Desktop client version observed" line per (version, remote address); after
   Monday's deploy the check greps those lines — ~5 days of fleet data before the 07-12
   deadline. Interim fleet check today was therefore impossible by construction, not by
   traffic.

## Stage 11 Core Side Green-Local — Chain Now Seven Stages Deep (2026-07-05)

**Decision #82:** Stage 11's core side built same session (ceb6cc4; suite 180 files /
1462 tests green after fixing one stale registry-dispatch pin the tips-v2 bump
invalidated). Ordering deviation, same recorded pattern as #73–#75: Stage 4 is
released-not-exited (0.1.29 on the feed, fleet verify pending 07-12 with the data
source #81 just created) and Stage 7 deployed-not-exited. The chain is now
**8→9→10→16→17→14→11**, tip `kernel/stage-14-ofapi-transactions` @ ceb6cc4 — all of
it additive and flag-inert, still one Monday deploy.

Substance: `POST /api/v1/ingest/observations` per spec §2 exactly (bearer-only,
version header required, 1..100 / 1 MB / 120-min caps, whole-batch atomic,
`{accepted, duplicates}` via the Stage 7 key protocol — duplicate re-send CI-proven
free); unknown kinds journal as `desktop.unknown:<kind>`; canonicalizer family
`client_capture` is registration+validation only BY DESIGN — zero domain events until
Stage 29 (the family version is Stage 29's replay hook; flagged in review per spec).
No schema change. The 3c handoff memo (wire contract verbatim + client obligations:
quarantine-on-400, purge-notice-before-wipe, whole-batch resend) landed as a NEW file
in the desktop repo: `docs/project-kernel/pass3-stage-11-wire-contract.md` (untracked
— the 3c/Stage 12 executor commits it with its work).

Exit (ops): deploy with the chain → desktop uploader release (3c) → §5: ≥1 production
desktop end-to-end, duplicates=all on re-send, offline-drain drill, a week of spool
telemetry (which also gates Stage 12's harvest).

## Stage 12 Built — Both Halves, Same Day (2026-07-05)

**Decision #83:** Stage 12 (desktop local-DB harvest) built across both repos in one
session, grounded in a full desktop-schema exploration. Ordering deviation as before
(deps 11/8/10 green-local-not-exited; the fleet run is ops after the chain deploys).

**Core glue** (dd006b2, on the chain): lane accepts `harvest.<table>` kinds verbatim
under `producer='desktop-harvest@<version>'`; account resolution moved to INGEST
(payload.ofapiAccountId → pages.ofapi_account_id — harvest events carry no pageLabel
and NULL-account observations never canonicalize). client-capture family v2:
harvest.messages parses with Stage 8 dedup-key parity — CI-proven cross-producer
collapse (webhook + harvest → 2 observations, 1 event) while pre-epoch history appends
with tombstones. RECORDED DEVIATION: harvest.fan_transactions is validation-only, not
"candidate events" — the ledger's transaction events start at the webhook epoch, so
historical harvest events would ALL append as noise; the meaningful dedup surface is
the transactions TRUTH table (the desktop's own sweep calls OFAPI
GET /{account}/transactions — same id space), which is what `harvest:reconcile`'s
residue query joins (report-only; NULL-account rows always residue).

**Desktop half** (ac5fbb9 on `kernel/stage-12-harvest` off 0.1.29): harvest module with
rowid walkers, DETERMINISTIC UUIDv5 ids keyed on natural PKs (not rowids — VACUUM),
cursors persisted only after the covering 2xx, 400-quarantine + capped-backoff retry,
per-machine manifest for reconciliation, Danger-Zone start/pause UI with polled
progress, and the purge guard: purge REFUSES while a started harvest is incomplete
(the spec's one binding ordering rule, encoded). New hub client method
postIngestObservations; harvest client sends x-client-version 'harvest-<app version>'.
`pnpm check` green (typecheck, lint, 762+1206 tests). The Stage 11 wire-contract memo
is committed in the desktop repo alongside.

Exit (ops, after chain deploy + a desktop release carrying this): fleet inventory via
diagnostics exports → one machine first → manifests reconcile via harvest:reconcile →
re-run no-op proof → archive coverage predates webhook epoch → residue review. Local
prune policies stay at Stage 4 caps until manifests reconcile.

**Decision #84:** Pre-merge adversarial review of the ENTIRE unmerged surface (core
chain 8→9→10→16→17→14→11→12-glue + desktop harvest branch) ran Saturday 2026-07-05,
before Monday's one-pass merge/deploy — four independent reviewers, one per slice,
each handed the slice's invariants. Six real defects found, all fixed and re-verified
same day (core fcc06cf, suite 181 files / 1466 tests; desktop a639876, 762+1209):

- SECURITY, ingest lane (Stage 11): page resolution was global — any bearer key could
  attribute observations to any page, and harvest.* kinds were trusted from ANY
  client version, so a live client could journal harvest.messages verbatim and the
  sweep would mint FORGED message.* domain events for arbitrary pages. Fixed at both
  layers: resolution now scoped to the principal's assigned pages (owner
  unrestricted; out-of-scope → NULL account, which never canonicalizes), and the
  harvest namespace + the client-capture canonicalizer both gate on the
  desktop-harvest@ producer.
- Chargebacks (Stage 14): a truncated first full-history walk wrote partials, locking
  the page into the 90-day window forever (pre-90d chargebacks silently lost). First
  walk is now all-or-nothing; next-day run redoes it on a fresh budget.
- Desktop harvest (Stage 12): the 400-quarantine path was dead code (probed .kind;
  HubError carries .reason) — deterministic 400s would retry forever with no
  artifact; STARTED_KEY persisted before uploader validation — one Start click with
  Hub unconfigured armed the purge guard permanently; no byte budget vs the hub's
  1 MiB bodyLimit — heavy rows could 413-wedge the walk. All three fixed (900 KB
  chunk splits; oversize single events quarantine-and-skip, surfaced by reconcile's
  walked>uploaded gap). Plus: live-sync retention prunes now FREEZE while a harvest
  is incomplete (they raced the walk — rows could die before reaching the kernel),
  and purge failures surface in the UI instead of silently closing the dialog.
- Stale test pin: canonicalize-sweep expected parse_version 1 for client_capture —
  stale since dd006b2's v2 bump; the last full core suite run predated the glue
  commit. Lesson recorded: re-run the FULL suite after the last commit of a session,
  not before it.

Chain tips moved: core merge target is now `kernel/stage-14-ofapi-transactions` @
fcc06cf; desktop release branch is `kernel/stage-12-harvest` @ a639876. Runbook
updated. Also added post-deploy belt-and-braces: spot-check the 5 legacy blocked
tips rows' domain_key values after the first sweep (they must match the shared
`tip:<notificationId>` construction for self-heal).

**Decision #85:** Review wave 2 — the four chain slices wave 1 didn't cover (Stages
8/9/10/16/17, built in earlier sessions and never independently reviewed) got the
same four-reviewer adversarial treatment. TEN more defects, all fixed + full suite
green same evening (478eaf8; 182 files / 1472 tests, clean re-run after the final
edit per the #84 lesson):

- Stage 8 CRITICAL: the minutely sweep had zero fault isolation — one poison row or
  transient DB error wedged canonicalization for ALL families forever (the failing
  row retries first every tick). Now per-row + per-family isolation, errored counter.
- Stage 10 CRITICAL: archive writer read only price (dollars) — every Fansly tip
  (tipAmountMills, MILLS) and harvest tip (tipAmount, dollars) archived as ZERO,
  permanent under first-writer-wins. Tip resolution now covers all three producer
  shapes. Also: out-of-order tombstones were dropped (now tombstone-first stub +
  content hydration, content_pending column in unreleased 0059, backfills hydrate);
  non-atomic reset could leave an archive permanently empty behind a stale watermark
  (now transactional).
- Stage 16 CRITICAL ×2: purchase-history keyset walk had no lease fencing (only
  such loop in the file) and no per-fan isolation — one deleted fan's 404 wedged the
  walk on that fan forever. Both fixed; fan-scoped 400/404/410 skip with anomaly,
  auth/rate-limit still propagate. stableHash replacer-array bug (nested
  breakdown[].type silently excluded) fixed NOW while dedup-key changes are free
  (prod has no domain events until the deploy).
- Stage 17: idle-path deep-backfill selection ignored the retention-limit knob.
- Stage 9: capture-drop incident latch could stick shut permanently when the
  incident open failed (rejection-based reset was unreachable — the open path
  swallows errors); boolean-return re-arm now.

Clean verdicts worth keeping: Stage 8 append protocol race-safe + gapless under
concurrency; domain_events partitions self-heal via the daily 03:10 job (3-month
lead + incident); Stage 9 tee/drainer/attribution clean; Stage 10 cents→mills ×10
single-point + archive endpoints properly page-scoped; Stages 16/17 flags-off fully
inert, mills discipline clean, migrations additive.

Chain tip moves again: merge target = kernel/stage-14-ofapi-transactions @ 478eaf8
(+ this decision commit). Both waves together: 16 defects found by review after
"test-green" — the pre-merge adversarial pass earns its place in the standard
stage-execution loop.

**Decision #86:** Review wave 3 — trust-but-verify over the fix commits themselves
(three skeptical verifiers, one per fix commit fcc06cf/478eaf8/a639876). The fixes
held on 12 of 14 pointed probes; two real gaps IN THE FIXES found and closed
(core 9d30bb2, desktop 3a1087f; suites 182/1474 and 762+1211, both green):

- CRITICAL (self-suspected, verifier-confirmed at 90): purchase-history per-fan
  isolation conflated systemic failures with fan-scoped ones. A Fansly
  param-contract drift (HTTP 400 + app code 99 — probe-proven systemic) would skip
  EVERY fan, dedupe hundreds of skips into ONE warn anomaly, stamp the completion
  checkpoint, and repeat the zero-capture "success" every cadence, alert-free.
  Now: code 99 propagates; skips advance the cursor locally only (failed walks
  resume); mass-skip circuit breaker fails the run loudly when no fan succeeded.
- Chargebacks first-walk starvation: the all-or-nothing guard (#84) + the 20-page
  per-run cap = a >2000-row history could NEVER complete, discarding daily forever
  with info-only logging. First walks now cap at 200 pages (20k rows), blocked
  pages log at warn.
- Desktop sub-bar flags taken: garbage local timestamps degrade to epoch
  client-side (one unparseable observedAt would 400-wedge a whole table's harvest
  permanently — whole-batch atomicity); quarantine-write failure no longer masks
  the original 400; prune-freeze got its missing regression test.

Verified-clean worth recording: tombstone-stub protocol correct under replay and
rebuild (false ON CONFLICT WHERE = no-op, no overwrite); incident latch re-arm
cannot spam Telegram (incidentKey idempotence); stableHash single call site;
ingest scoping safe for empty assignments; no import cycles; desktop byte
accounting UTF-8-correct; prune-freeze binding window provably zero-length.

FINAL Monday tips: core kernel/stage-14-ofapi-transactions @ 9d30bb2 (+ this
decision), desktop kernel/stage-12-harvest @ 3a1087f. Three-wave total: 18 defects
after "test-green", 2 of them defects in earlier fixes — the verify-the-fix pass
is not optional.

## Stage 19 Session 1 — Declarative Authorization Landed, Extraction Next (2026-07-05)

**Decision #87:** Stage 19 (API decomposition + declarative authorization) started on
branch `kernel/stage-19-api-decomposition` off the Stage 14 chain tip (23e827c) —
a SEPARATE branch, not part of Monday's merge chain. §8 tasks 1, 2, 4, 5 of 6 are
done at 3cb9598; full suite after the last code commit: **186 files / 1504 tests
green** (baseline 182/1474). What shipped:

- **Auth vocabulary + verdict middleware (d189b67).** Every one of the 132
  routeSchemas entries (spec said 129 — stages 10/11 added routes; the 129/128
  off-by-one reconciled: the webhook registers inside its own plugin scope for the
  buffer body parser, coverage is exactly 1:1) carries
  `auth: {kind, roles?, scope?}` transcribed from the verified in-handler guards.
  The verdict engine (`apps/runtime/src/api/auth-policy.ts`) REUSES the legacy
  guard functions in try/catch — decision parity by construction, not
  re-implementation. `AUTH_POLICY_ENFORCEMENT` env (default `log`, registry
  editability NEVER, mirroring Stage 2's key): log mode records the verdict and
  logs `would-deny`/`would-allow` divergence onResponse; enforce denies before any
  handler. Deploying this is INERT.
- **Contracts CI gate (same commit).** A contracts unit test fails any
  routeSchemas entry without a valid declaration (zod-strict, self-tested), plus a
  pinned review of the 37 `scope:"page"` keys. Linter-independent by design.
- **OpenAPI security derived from auth (4b8af34).** `routeSecurityFromAuth` +
  swagger-transform injection; the four hand-set security constants and their 128
  per-entry lines are gone. SEVEN operations changed in
  `reference/agency-hub.openapi.json`, all justified: the 4 Stage 2 revenue routes
  stop advertising bearer keys production has refused since the enforce flip
  (the doc was lying about the tightening), and `upsertFanProfile` + the two
  profile-versions routes now admit both auth methods their handlers actually
  accept (the doc was lying about acceptance). `api-types.ts` unchanged. The
  `auth` block itself is stripped from the wire document.
- **Policy table + introspection (same commit).** An onRoute collector exposes
  `server.routePolicyTable` (method/path/routeKey/auth) — the same introspection
  Stage 20's SDK generator needs; `pnpm contracts:generate` renders
  `docs/generated/authorization-policy.md` (docs/ is untracked; the table
  regenerates from any checkout).
- **ESLint bootstrap (3cb9598).** First linter in core: flat config whose ONLY
  rules are the `modules/<name>/index.ts` import walls, dormant until extraction
  populates `modules/`, probe-verified to fire; `pnpm lint` wired into CI.

**Deviation from spec §2 (recorded):** in-handler guard calls are NOT deleted as
modules migrate. The whole stage deploys as one unit — deleting guards at
extraction would leave routes unprotected during the log-only window (middleware
observing, guards gone) and would leave the 48 h divergence diff with nothing to
compare against. Guard deletion is a separate cleanup slice AFTER the production
enforce flip; `REVENUE_ROUTE_ROLE_ENFORCEMENT` retires in that same slice, not
before.

Client-compat facts re-verified before annotating (Explore over both client
repos): desktop and extension call `pages`, fan-profile GET/PUT, and
`ai-usage/batch` with BEARER keys — those routes are declared `any`/`apiKey`, not
`session`; the extension on `bar-tone-menu` no longer calls spenders/fans-search
at all (drift vs Stage 2's baseline, no action needed — declarations mirror
handlers, not clients). `ai-usage/batch` is apiKey-only de facto
(requireApiKeyUser inside the service), declared accordingly.

Remaining: Task 3 — extract the ten modules with handlers VERBATIM (guards
intact), buildApiServer as composition root, per-module role-matrix tests,
relative-sibling lint walls (3–4 sessions); then Task 6 ops (inert deploy → 48 h
log window → enforce flip → cleanup slice). Steps sketched in the stage's
`## Progress` block.

## Stage 19 Session 2 — Eight of Ten Modules Extracted (2026-07-05)

**Decision #88:** Task 3 (module extraction) is 8/10 done on
`kernel/stage-19-api-decomposition` @ 72ca544; full suite after the last
extraction commit: **186 files / 1505 tests green**. server.ts shrank
3,768 → 2,063 lines. One verified checkpoint commit per module — each gated on
typecheck + an EMPTY `contracts:generate` diff + targeted suites + the new
role matrix: workboard (2ba8c15, with the extraction scaffold), identity
(383e649), ai (9f985a6), events (245df9b, the whole SSE lifecycle),
conversations (f88d611), ingest (a0718f6), audience (bc17a6a), finance
(72ca544, incl. the overview aggregate and getRevenueDailySeries).

Mechanics that bind the remaining work:
- **Handlers moved byte-verbatim, guards intact** (deviation #87 holds). The
  scaffold is `api/request-auth.ts` (createRequestAuth: the closure helpers
  factored out unchanged; also pageScopeFor + auditCtx) + `modules/context.ts`
  (ApiServer type — the logger generic must be AppContext["logger"], not
  FastifyBaseLogger — and ApiModuleContext {appContext, auth, boss}); pg-boss
  now boots before any route registers so modules can carry it.
- **normalizeOpenApiDocument sorts spec.paths.** Extraction shuffles route
  registration order and swagger's paths object follows it; the one-time
  reorder diff (identity commit) was proven content-equal by
  canonicalized-JSON comparison (121 path templates both sides). The byte-gate
  is registration-order-independent from here on.
- **Sorting decisions vs target §6.1** (recorded, not silent): read gateway +
  ofapi commands → ingest (observation-producing custody lanes, kept with the
  webhook receiver); the credits family → ops; overviewGrowth → audience;
  the overview dashboard aggregate → finance; openApiJson stays in the
  composition root next to swagger.
- **Per-module role matrix** added to tests/auth-policy.integration.test.ts:
  one representative route per module × four principals × BOTH enforcement
  modes with log/enforce status parity asserted — behavior-level, so it holds
  through the rest of the extraction untouched.
- Verbatim-move exceptions: crossPageTransactions keeps its unused
  platformByLabel local; serializePageMetric temporarily duplicated in finance
  (server.ts copy still feeds serializeAssignedPage until catalog moves).

Remaining for Task 3 (next session, resume map in the stage's `## Progress`):
catalog (14 routes; onboarding/credentials handlers + the
queueInitialOnboardingSync helper family), ops (40 routes, ~1,300 lines), the
relative-sibling ESLint walls once the layout is final, and a dead-import
sweep. Then Task 6 (inert deploy → 48 h log window → enforce flip → guard
cleanup).

## Stage 19 Session 3 — Extraction Complete, server.ts Is a Composition Root (2026-07-05)

**Decision #89:** Task 3 is DONE. All ten target-§6.1 modules now own their
routes; `apps/runtime/src/api/server.ts` is a **497-line composition root**
(fastify setup, the declarative-auth middleware + routePolicyTable collector,
the requestAuth factory, pg-boss, module registration, swagger/openapi, the
error handler, SPA static serving) — down from 3,768 lines at the stage's
start. Full suite after the last commit: **186 files / 1505 tests green**.
Session commits, each gated on typecheck + an empty `contracts:generate` diff
+ targeted suites + the role matrix:

- 963db99 **catalog** (14 routes): model/page CRUD with the Stage 13 tombstone
  delete, onboarding + the queueInitialOnboardingSync helper family (boss via
  module ctx), credentials verify (public adapter surface only, per the
  safeguard scope rule), proxy test, page-verify recovery, credentials-update
  audit. serializeAssignedPage/rethrowAdminCatalogError/
  isAdminPageVerifyBadRequest moved with it.
- c8b8137 **ops slice 1** (23): health pair, the OFAPI credits family
  including the hijacked CSV export, sync monitor + per-page blocks, the eight
  admin sync triggers, connections.
- 00fed94 **ops slice 2** (17): admin logs/queue/db-stats/incidents (raw-sql
  reporting with the severity normalization), the Telegram notifications
  surface, and the config surface (live PATCH, editable clear, advisory-locked
  staged flips) — extraction complete.
- cd2c17e **relative-sibling ESLint walls**, now that the layout is final
  (every module = one modules/<name>/index.ts). Gotcha worth keeping: minimatch
  `*` matches `..`, so the sibling group needs `!../../**` or every
  `../../services/…` import trips the wall. Probe-verified: a sibling internal
  import errors; `../<other>/index.ts` and parent traversal pass; the repo
  lints clean.

With #87/#88: Stage 19's §8 tasks 1–5 are all done. What remains is **Task 6
(ops) only**: owner deploy (INERT — AUTH_POLICY_ENFORCEMENT defaults to log,
no migrations in this stage) → 48 h log window (grep api logs for
`auth-policy would-deny|would-allow`; zero unexplained divergence per module)
→ flip AUTH_POLICY_ENFORCEMENT=enforce + restart + re-probe → the
guard-deletion cleanup slice (in-handler requireX calls the middleware
subsumes; REVENUE_ROUTE_ROLE_ENFORCEMENT retires with
enforceRevenueRouteRoleScope) → stage exits. This branch is NOT part of
Monday's merge chain; it merges independently after the chain lands.

## Stage 20 Session 1 — @kernel/sdk Built, Streams Helpers Live, api-types Dead (2026-07-05)

**Decision #90:** Stage 20 started on `kernel/stage-20-generated-sdk` off the
Stage 19 tip (ordering deviation in the #73–#75 pattern — owner: "continue it
and next stages, don't worry about time checking"; Stage 19 is green-local,
not deployed). §8 tasks 1, 2, 4 of 6 are done at e268f53; full suite
**188 files / 1525 tests green**.

- **@kernel/sdk (e18aa4e).** Design decision worth recording: the generated
  package is deliberately TINY — an operations manifest (method/path per
  registry key, recovered from Stage 19's `server.routePolicyTable` with a
  total-join assertion), the contract hash, and re-exports; there is no mass
  codegen. Every moving part lives in `packages/contracts/src/sdk-runtime.ts`,
  where per-operation methods and request/response types are MAPPED
  generically off `typeof routeSchemas` (z.input in, z.output out) and
  responses are runtime-validated with the same schemas the server enforces.
  Cookie/bearer auth with a 401/403 hook; KernelApiError taxonomy; `raw()`
  escape hatch; exclusions = webhook, both SSE streams, the wildcard read
  gateway, the CSV export. **The contract hash is sha256 of the normalized
  OpenAPI document, not the manifest** — a renamed response field must move
  it (the cross-repo drift drill's property), pinned by test. Core has no
  package version, so the SDK base is "0.1.0" and the hash is the real
  identity; release tags own versioning (Task 6). DP 10 git-tag pinning is
  documented in the generated README.
- **Stream helpers (3149f2f).** `subscribeSyncEvents` wraps the v1 protocol
  (Last-Event-ID resume, per-frame validation, 409 → onSnapshotRequired,
  deliberately no auto-reconnect — the server bounds stream lifetime and v1
  clients own the loop); `streamAiGateway` parses `event: ai` frames;
  `ofapiRead` is the thin wildcard passthrough. Conformance proven on fake
  streams (split chunks, heartbeat noise, invalid frames) and against the
  LIVE server — seeded journal events replayed through the helper, an
  ahead-of-journal cursor produced the parsed snapshot-required payload.
- **api-types.ts deleted (e268f53, Task 4 done early).** 14,753 dead lines +
  the openapi-typescript dependency; verified consumer-free first. Types now
  flow from the SDK's mapped inference; the OpenAPI document remains the
  published artifact.

Remaining: Task 3 (dashboard adoption ×16 modules, delete client.ts, lint
ban), Task 5 (drift gates in desktop/extension + the prove-the-gate drill),
Task 6 (release ops — note: external git-tag installs need the runtime
bundled from contracts at publish time; decide there). Resume map in the
stage's `## Progress`.

## Stage 20 Session 1 Addendum — Dashboard Adopted Same Session (2026-07-05)

**Decision #91:** Task 3 landed in the same session (2d536cf): the dashboard
runs end-to-end on @kernel/sdk. All 15 domain modules re-implemented over the
typed operations through one `src/api/sdk.ts` (cookie mode); `client.ts` and
`utils.ts` deleted; the two `ApiError` consumers moved to `KernelApiError`;
the CSV download rides `raw()`; React Query keys are byte-stable and the
workboard-v2 comma-joined `status` wire shape is preserved. The SDK's
`onAuthError` gained an OPERATION argument so a failed `login` stays a form
error while expired sessions still redirect. Where hooks take looser types
than the contracts (period/platform/bucketKey strings), localized
`Parameters<typeof kernel.X>[0][...]` casts keep hook signatures unchanged.
Two recorded mechanics: (1) the lint ban is a TEST
(tests/dashboard-sdk-ban.test.ts — no direct fetch in src/api, no client
resurrection, every module through ./sdk.js) because the dashboard tree is
not ESLint-covered — the same mechanism substitution as the contracts auth
gate; (2) `@kernel/sdk` needs FOUR alias registrations (dashboard
tsconfig/vite, root vitest, tsconfig.base — root tsc follows test imports
into dashboard sources and cascades phantom errors without the base mapping).
Dashboard `tsc -b` + `vite build` green; dashboard suite 18 files/113 green;
full suite after the last commit: **189 files / 1528 tests green**.

Stage 20 remaining: Task 5 (drift gates in desktop/extension CI + weekly
bump-PR + the prove-the-gate drill — cross-repo, owner-visible PRs) and
Task 6 (release step: sdk-vX.Y.Z tags; bundle the contracts runtime into the
tag artifact for external installs — decide there).

## Stage 21 Built Whole — Event Stream v2 Beside Untouched v1 (2026-07-06)

**Decision #92:** Stage 21 (event stream v2) built completely in one session on
`kernel/stage-21-event-stream-v2` @ 0d28077 (chain 19→20→21; ordering
deviation in the standing #73–#75 pattern — the substrate is green-local
Stage 8, deploy follows the chain). §8 tasks 1–5 all done in four commits;
full suite after the last commit: **192 files / 1542 tests green**, with the
v1 SSE suite byte-untouched — the compatibility invariant's proof.

What shipped:
- **Frame + cursor (a29a420).** Frame `{accountId, accountSeq, type,
  occurredAt, data}` with `type` contractually open (unknown-type tolerance is
  explicit, tested). The resume cursor is OPAQUE base64url
  `{v:2, w:{<account>: <highSeq>}}` — strict decoder (unknown version,
  malformed JSON, non-canonical base64 all rejected), deterministic encoder.
  v2 routes declared `kind:"any"` (execution decision the spec delegated —
  the dashboard consumes v2 in Stage 33). SDK gained `subscribeDomainEvents`.
- **Fan-out (56e0f82).** One `pg_notify` per (account, batch) inside the
  append transaction — commit-fired, payload advisory. `createDomainEventHub`
  carries the v1 hub's exact discipline (notify = wake-up only, serialized
  drain, watermark advances only after broadcast) generalized to per-account
  watermarks with a dirty-account set and reconnect rebaselining.
- **Endpoints (a39288b).** v2 stream/snapshot beside byte-identical v1:
  grant-scoped account universe (owner = all), per-account replay + buffered
  live tail, re-auth for BOTH credential kinds, and the per-account 409 —
  ahead-of-head AND below-retained-floor, with the floor COMPUTED from
  retained rows (min account_seq), so Stage 28's tiering needs no code change
  here; the conformance test prunes synthetically and also proves the exact
  floor edge resumes cleanly.
- **Smoke instrument (0d28077).** Permanent worker-side consumer over the same
  hub+replay code path, durable checkpoint (migration 0064: cursor +
  frames/gap/duplicate counters), restart-resume proven without recount, a
  synthetic seq gap counted as the bug signal. Runs unconditionally like the
  Stage 7/8 sweeps (read-only besides its row).

Recorded deviations: (1) v2 snapshot is the grant-checked fresh-cursor
handshake; the spec's "current projection state per account" payloads ride the
consumer stages (24/33) additively — Stage 21's only consumer needs exactly
the cursor reset. (2) The smoke consumer tails the hub in-process rather than
HTTP-self-connecting (auth/URL wiring to self adds ops surface; the wire
framing is covered by the CI conformance suite).

Exit (Task 6, ops): deploy migration 0064 + dist → 24 h smoke window with
zero gaps/duplicates (`select * from domain_events_smoke_checkpoint`) →
dual-stream load measurement → the first-ever Fansly frame observed on v2 →
v1 desktop connections unaffected.

## Stage 22 Built — Identity: Sessions, Device Tokens, Grants, Attribution (2026-07-06)

**Decision #93:** Stage 22 built (§8 tasks 1–5) on the chain branch
(commits c4dbcc6 + 89dc253 + a fixture fix, after Stage 21 on
`kernel/stage-21-event-stream-v2` — chain 19→20→21→22; standing ordering
deviation). Full suite after the last commit: **193 files / 1547 tests
green**. Migration **0065**.

What shipped and the execution decisions inside it:
- **All-roles sessions with the dashboard door unmoved.** `roleCanUseSession`
  (login capability) opens to chatters; a NEW `roleCanUseDashboard` keeps
  `requireDashboardUser` at owner/team_lead — the spec's "chatter dashboard
  login remains BLOCKED" is a role split, not a route change. New vocabulary
  kind **"any-session"** (any live cookie session) covers the self-serve auth
  surface; verdict via new `requireSessionUser`.
- **must_change_password** rides admin set-password (invite flow v1); the
  gate is enforced UNCONDITIONALLY in the policy hook (allowlist =
  me/logout/change-password) — deliberately outside the Stage 19 log/enforce
  comparison since it is new behavior with no legacy guard to diverge from.
  `changeOwnPassword` verifies the current password, clears the flag, and
  revokes every session (re-login required — recorded semantic).
- **Device tokens**: `agency_hub_device_` prefix, digest-stored, sliding 90 d
  expiry (bump throttled to ≥1 d gains) hard-capped at 365 d from creation;
  `authenticateBearerToken` prefix dispatch in resolvePrincipal and BOTH SSE
  re-auth branches; `requireApiKeyUser` widened to accept device tokens —
  execution decision: keep the kind name "apiKey", zero route re-annotation.
  Nothing is ever attributed to a bare device (the principal is the owning
  human). Self-issue on any-session + the owner admin trio.
- **Grants**: append-only `access_grants` (revoke = stamp; org scope reserved
  per DP 9-A single-tenant, recorded as the invariant); the projection
  reproduces `listUserPageAssignments`' exact row shape with model grants
  expanding to present AND FUTURE pages at read time. EXECUTION
  INTERPRETATION RECORDED: the spec's "assignments become read-only
  immediately" would break continuous parity, so assign/unassign and the
  api-key page-bind DUAL-WRITE (grant + legacy row) until
  ACCESS_GRANTS_READ_ENABLED flips reads AND freezes legacy writes;
  `grants:parity` CLI (exit 1 on any diff) is the flip gate.
- **Attribution**: workboard contacts (`acted_by_user_id`) and snoozes
  (`created_by_user_id`) threaded from the acting principal; manual sync
  triggers VERIFIED already attributed by Stage 7 4b's recordAudit.
- **Deferred to Task 6 ops, with reasons**: content_manager TS removal (a
  surviving prod row with the TS value removed would 500 response
  serialization — prod row check first), and the model-grant dashboard list
  UI (routes + history endpoint exist; Stage 33 owns admin UI expansion —
  minimal-surface rule).

The §5 grid runs live: chatter password login + the must-change flow end to
end, dual-credential parallel acceptance + expiry + revoke independence,
model grants reaching a page created AFTER the grant (grants read path) while
the legacy path correctly ignores them until the flip, stamped revokes
answering the access-history query, both read paths agreeing after
unassign, attribution rows populated.

Exit (Task 6): deploy 0065 → prod smokes (chatter login, dual-credential
round-trip, history query recorded, `grants:parity` = 0) → read-path flip →
content_manager row check → assignment-table drop ships a release later,
owner-acknowledged.

## Stage 23 Built — Workboard Becomes a Kernel Module, v1 Retired (2026-07-06)

**Decision #94:** Stage 23 built (§8 tasks 1–5) on the chain branch
(commits 377b528 → 4a4054a → 69baf3f → 6318372 → 2c9a124 on
`kernel/stage-21-event-stream-v2` — chain 19→20→21→22→23; standing ordering
deviation, deps 21+22 green-local). Full suite after the last commit:
**188 files / 1527 tests green** (the count drops from 193 because six v1
test files retire with the feature; one stage suite added). Migration
**0066** (workboard_claim_leases).

What shipped and the execution decisions inside it:
- **Module move + platform neutrality (Task 1).** The ten engine files
  git-mv'd byte-for-byte into `apps/runtime/src/modules/workboard/`;
  `resolveAccessibleWorkboardPage` replaces the Fansly-only accessor — the
  read-side platform throw is gone, so the OnlyFans boards the engine always
  scored now serve. The v2 route summaries drop the "Fansly page" wording
  (OpenAPI text-only).
- **Event-driven recompute; the sweep is demoted to reconciler (Task 2).**
  A worker-side domain-event-hub subscriber maps fan-relevant events
  (message.*/transaction.posted/subscription.*/presence.*/fan.* with a
  fanIdentityRef) to pg-boss jobs debounced per fan: singletonKey
  `<accountId>:<fanIdentityRef>`, startAfter 5 s — bursts collapse to one
  run. The job resolves the platform-native ref via findPlatformFan; an
  unknown fan is a recorded skip (the reconciler covers it). The nightly
  recomputeAllWorkboardPages now returns `changed` as the
  **workboard_reconcile_drift** counter (warn >0 / info =0; target zero).
- **Claim leases (Task 3).** Soft coordination, NOT access control (DP 4c):
  one live row per (page, fan); a second chatter's claim STEALS the lease
  (last-writer-wins, never blocks); release stamps; TTL default 30 min,
  request-capped at 240; expiry read-filtered. Routes are
  kind:"any-session" + scope:"page" (chatters claim their own work — page
  access is the boundary, not the dashboard door). Live claims ride the
  board response (`claims[]`); both sides audit via recordAudit
  (fan_claimed / fan_released — released only when a live lease existed).
- **Module-emitted domain events (Tasks 3+4).** `workboard.state_changed`
  on REAL tab transitions only (before/after snapshot incl. removals) and
  `workboard.contact_retracted` on undo — NAMING DEVIATION RECORDED: the
  spec wrote `contact.retracted`; namespaced to match state_changed. Both
  carry observationId **0 sentinel** (module-emitted, no source
  observation) and time-based dedupKeys (identical transitions can
  legitimately recur). `retractLastWorkboardContact` now returns whether a
  row was stamped — the compensating event is emitted only on true (undo of
  nothing is not a fact).
- **v1 retired (Task 5).** Consumer inventory gate passed: the four v1
  routes had dashboard-only consumers (desktop repo grep clean — spec §4
  re-verified). Routes, contracts, schemas, and types removed; absence
  pinned twice (contract test: no routeSchemas entry = 404; api.integration
  404 probe mirroring the crm-retirement precedent).
  `services/workboard.ts`, `services/workboard-presence.ts`,
  `repositories/workboard.ts` deleted; `unsnoozeWorkboardFan` moved
  VERBATIM into the v2 repository (the snooze v1/v2 duplication collapses
  to the module's). Dashboard: `/pages/:label/workboard` renders the v2
  board; `/workboard/v2` joins `/crm` as a legacy redirect; ONE
  platform-neutral sidebar entry (OnlyFans boards visible — §5 exit
  criterion). The v1 page + view-model/theme + four components die.
- **Presence panel consequence (recorded).** The v1 presence endpoint's
  on-demand Fansly follower refresh died with the panel; presence still
  flows through follower sync + OFAPI webhooks into
  `external_presence_at`, surfacing as the v2 board's `online` flag — the
  ofapi-presence suite now proves projection→board-online end to end.

Tests: stage suite (lease lifecycle incl. steal/expiry, claim/unclaim
services + audit + board surfacing, state_changed real-transitions-only,
contact_retracted once-only, OnlyFans board read, hub→job mapping with
relevance filtering + ordered-delivery proof, job-side fan resolution);
five suites moved off v1 (worker mocks, auth-policy matrix,
identity-grants attribution, api.integration, ofapi-presence).

Exit (Task 6 ops): deploy 0066 with the chain → staging latency harness
(p95 event→board within the 5 s debounce) → two-user lease drill → one
week of reconciler drift = 0 → prod 404 probe on the four v1 paths.

## Stage 24 Built — Desktop Becomes a Pure Kernel Client (2026-07-06)

**Decision #95:** Stage 24 built (§8 tasks 1–5) across BOTH repos in one
session. Desktop branch `kernel/stage-24-sdk-stream-v2` (off the stage-12
harvest tip): 8045339 → 0fbac28 → 05ad6de → 21ccd97 → 4b99d21 → 053ae24 →
4de27b3. Core (chain branch): ddbae06 → 1f2511e → f0680ee → 5cf9ef5 →
907315b. Suites after the last code commits: **core 188/1530**, **desktop
772 (shared) + 1223 (app)**, full `pnpm check` green.

Execution decisions and deviations:
- **SDK distribution = compiled vendored bundle** (core
  `scripts/vendor-sdk.mjs` → desktop `packages/kernel-sdk`, js+d.ts, zod the
  only dependency, contract hash + source commit in kernel-sdk.vendor.json).
  This implements Stage 20 Task 6's "bundle contracts runtime for external
  installs": consumers see declarations only (skipLibCheck), so their
  stricter compiler flags never re-litigate core source. Git-tag installs
  (DP 10) replace the MECHANISM at the release step — the `@kernel/sdk`
  import surface is identical. Core-side enablers: sdk-runtime optional
  props gained `| undefined` (exactOptionalPropertyTypes-clean), the
  network wrap now preserves abort/timeout in error.code, and the generated
  index re-exports the runtime surface (routeSchemas, stream helpers,
  cursor codec) that in-workspace consumers reached via contracts directly.
- **Task 1 (SDK delegation).** The 971-line hand client became a delegation
  layer behind the SAME HubClient interface/HubError taxonomy; per-timeout
  memoized SDK clients over a bridged fetch (no shared timeout slot to
  race); the HubFetch seam kept so every test fixture survived. Send-engine
  suites passed UNCHANGED (the done-check). Two leniencies died as drift
  now fails loudly: absent page fields / missing invalidCount are contract
  violations; a payload echo on command responses is contract-stripped
  rather than rejected (the desktop-state invariant holds by construction).
  The desktop's stricter parseable-completedAt gate was re-added on top of
  the contract element (core deliberately accepts and burns those as
  invalidCount; the reporter must pre-wire-reject).
- **Core-side v2 consumability (the #92 "payloads ride Stage 24" tail).**
  Serve-time only, ledger rows byte-identical, all additive (OpenAPI doc
  unchanged): frames carry fanRef/conversationRef/messageRef + accountRef
  (pages.ofapi_account_id); message.received/sent frames whose source
  observation is an OFAPI webhook message get `payload` = the SAME
  normalized message the v1 fanout serves (normalizeOfapiSyncMessage over
  the source observation; batched per replay page, order-preserving on the
  live path) — without it every live message would cost a read-gateway
  round trip (credits + latency = crown-jewel regression). **Typing rides a
  new `event: ephemeral` lane** forwarded from the v1 fanout hub: never
  ledgered (append-only is the wrong home for a 5-second hint), no id line,
  never advances the cursor, live-only.
- **Task 2 (stream v2).** hub-sync keeps its proven discipline verbatim
  (parser/watchdog/backoff/auth-stop/handle-then-checkpoint) and swaps
  protocol: opaque cursor under NEW key hubSync.v2Cursor (v1 lastEventId
  retained for the fallback window); mapDomainFrame translates canonical
  types onto the existing SyncEvent union so handleHubEvent is untouched;
  unknown types checkpoint without emitting (forward-compat rule —
  deliberate difference from v1's no-checkpoint on unknown). RECORDED
  MAPPING FACTS: readStateChanged was always local-only (server never sent
  it); subscriptions.renewed's v1 chat-list nudge has no ledger source —
  accepted loss, polling cadence covers it. v2 gap recovery = fresh-cursor
  handshake + per-account list-only head refresh through polling (the v2
  snapshot carries no projection pages per #92; the spec's "same
  page-and-apply structure" was written before that deviation).
  hubSyncProtocol ('v2' default / 'v1' fallback) rides the settings file,
  no UI, deleted after fleet confirmation.
- **Task 3 (device tokens).** One-time sign-in in Settings → Hub: main
  logs in, captures the session cookie off the raw response (no cookie jar
  in the main process), issues the device token through the SDK client's
  static-headers seam (label = machine name), stores keychain
  hubDeviceToken, logs the one-time session out. resolveHubCredential
  (device token preferred, chatter key fallback) feeds ALL hub consumers;
  the config fingerprint includes the resolved credential so issuance
  reconnects everything live.
- **Task 4 (direct-read removal, DP 8).** ofapiReadTransport collapsed to
  z.literal('hub') — readField's corrupt-row fallback IS the 'direct'
  coercion (pinned by test). ofapiKey left SECRET_NAMES and the COMPILER
  drove the full sweep (deeper than the spec's file list, recorded): Keys
  UI row, key-test provider, settings patch route, keyMeta entry, dev env
  seeding. deleteDecommissionedSecrets removes the keychain file on every
  boot — version rollback cannot restore direct reads (intended). Grep
  gate: 'direct' survives only in the AI transport enum (Stage 31) and the
  frozen outbox migration DDL (third legitimate remnant, recorded).
- **Task 5.** Break-glass + rollout runbook committed kernel-side
  (docs/runbooks/desktop-hub-outage-break-glass.md): kernel-down ⇒ local
  cache only; owner-issued temporary key never lands on chatter machines;
  team-key rotation after fleet confirm; macOS manual-update note;
  per-machine v1 flip instructions.

Exit (Task 6 ops): staged release one machine → 48 h → fleet; production
verification per §5 (zero desktop v1 SSE connections feeds Stage 25's
entry, read-gateway volume per machine unchanged, grep gates, one-week
chat-freshness watch); then kernel-side team OFAPI key rotation.

## Stage 25 Build Half — Scheduler Role, Ordering Proof, Golden Signals (2026-07-06)

**Decision #96:** Stage 25 tasks 1–3 built on the chain branch (077aa08 →
60110cd → 98d4819 → e76c866). Tasks 4–5 stay gated as specced: the
consumer-zero sweep + singleton-assertion removal + 2-worker rollout need
the Stage 24 fleet off v1 (prod verification), and the fanout_seq/v1
retirement migration is the owner-gated LAST step. Full suite after the
last code commit: **191 files / 1538 tests green**. Migration **0067**.

- **Scheduler role (Task 1).** resolveRole gains 'scheduler'; cron
  registration collapses into services/schedules.ts (the ONE place),
  invoked only by the leader-elected scheduler runtime (session advisory
  lock ns 58212, stateless standby retrying every 10 s). pg-boss v12 fires
  cron from any instance with `schedule: true` (the default — verified in
  the pinned version's source), so workers AND the api now construct with
  `schedule: false`; the scheduler is the one timekeeper. A leader whose
  lock session dies exits immediately (a successor may already be firing).
  The scheduler also creates queues (idempotent) so a fresh environment
  has no boot-order race. Compose gains the scheduler service; worker-2
  scale-out mechanics documented in place for the Task 4 rollout.
  FIX FOUND BY THE FULL SUITE: a terminated lock session left its pool
  client checked out — pool.end() hung; onDeath now destroys the corpse.
- **Ordering property harness (Task 2).** Three racing sweep runners over
  a live growing corpus across three accounts re-prove Stage 8's
  invariants under multi-runner churn (per-account seq gapless 1..K, dedup
  collapse to one event), including a runner dying mid-load. The
  real-process staging chaos drill (kill -9) is Task 4's ops step.
- **Golden signals (Task 3).** ops_metric_samples (p50/p95, minutely,
  rolling 14-day prune until Stage 28) + golden_signal_lag incident kind
  (pg enum + contracts). Five lags over a trailing 10-minute window:
  capture (webhook receipt→settle), canonicalization (observation→event),
  projection (backlog age above each watermark), command settle
  (enqueue→finalize), SSE delivery — EXECUTION INTERPRETATION RECORDED:
  the smoke checkpoint keeps no per-frame receipt stamps, so SSE delivery
  = checkpoint staleness (bounds the same failure mode: a wedged
  consumer). p95 thresholds flip the existing incident latch (one alert
  per state change); GET /api/v1/ops/metrics (monitoring gate) serves the
  series + thresholds + smoke counters. Cron rides the scheduler; the
  sample job runs on workers.

Exit (Tasks 4–5, ops/owner-gated): golden-signal baselines recorded on
the singleton topology BEFORE the rollout; staging two-worker soak +
chaos drill; consumer-zero sweep over v1/fanout_seq/sync_event; singleton
assertion deleted; 2 workers + scheduler live in prod; then the
retirement migration (fanout_seq + sync_event columns dropped) under
explicit owner go.

## Stage 27 Built — Money Codec, Footgun Class Dead by Construction (2026-07-06)

**Decision #97:** Stage 27 tasks 1–3 built in one session on the chain branch
(06a06d9). Task 4 is ops (deploy → report-totals byte-diff for a fixed
window → CI gates). Full suite after the commit: **192 files / 1548 tests
green, unchanged expectations** (the spec's "any expectation change = a bug
found" held — none changed). No schema change, no data migration (Q6).

Execution decisions:
- Brands are compile-time only: Mills = bigint brand; **MicroUsd = number
  brand** (recorded adaptation — the spec sketched bigint, but
  cost_micro_usd is an int column flowing as JS number everywhere; a bigint
  brand would have been churn masquerading as safety).
- **ONE already-mills constructor** (`millsFromInteger`) absorbs the deleted
  `toMills` byte-for-byte, instead of the sketched `millsFromDbBigint` —
  pg returns numeric columns as strings and Fansly hands mills-native
  numbers, so three near-duplicate constructors would have re-created the
  ambiguity the stage kills. The audit classified ALL 27 toMills call sites
  as already-mills (repo rows; Fansly wallet balances, subscription prices,
  transaction amounts — Fansly is mills-native on the wire); none parsed
  dollars.
- `dollarsToMills` survives as an honest ALIAS of `millsFromDollars`
  (~80 call sites; the name states its unit — churn without safety gain).
  `millsFromCents` bridges the _cents column (×10); the column itself stays
  cents per the spec's accepted-debt ruling.
- Four float sites rewrote through the codec with value-preservation
  property tests: ofapi-dm-archive usdToMills (pinned over 2-decimal wire
  dollars — the domain where Math.round(x*1000) and the toFixed(3) parse
  agree exactly), telegram whole-dollar rounding (millsToRoundedDollars),
  snapshot + workboard mills→dollar numbers (millsToDollarsNumber).
- AI plane: pricing result typed MicroUsd via microUsdFromDbInt; converters
  millsToMicroUsd (exact) / microUsdToMills (lossy, truncation named).
- Enforcement: eslint no-restricted-syntax bans toMills reintroduction; the
  float-site ratchet rides the TEST SUITE (tests/money-ratchet.test.ts vs
  scripts/money-float-budget.json, budget 9, only decreases) — first
  burn-down target recorded: ofapi-dm-sync's dollars→cents write. Boundary
  suffix audit: contracts money fields all unit-suffixed already; the
  pattern matches were counters — no additive twins needed.

Exit (Task 4 ops): deploy with the chain → §1 report-totals snapshot
re-run, diff = 0 (dashboard revenue endpoints + Telegram digest, fixed
window) → grep-zero + gates green in CI.

## Stage 18 Started — Platform Seam Live in the Dispatch Path (2026-07-06)

**Decision #98:** Stage 18 tasks 1 + 6 complete, task 2/3's handler SPLIT
done (relocation pending), on the chain branch (e24fa9c → 8a7b08d).
Ordering deviation recorded: dep Stage 15 = the owner's OnlyMonster
subscription cancel (commercial action); its verify-zero half EXITED with
Stage 5 (#67, zero rows/streams/egress), so code-side work is safe. Full
suite after the last commit: **193 files / 1555 tests green**.

- **packages/platform-core** (target §4.1): PlatformAdapter /
  PlatformCapabilities / SessionCustodyDescriptor + createPlatformRegistry
  + a two-way conformance check (declared streams ↔ pull handlers).
  RECORDED DECISIONS: capabilities.streams speaks TODAY'S sync-stream
  vocabulary (the DB sync_stream enum owns those names; the target's
  canonical renames are a separate later migration — mapping in the
  package README); the pull-handler type is the adapter's generic
  parameter so platform-core stays app-agnostic (executor types live in
  apps/runtime, where the two adapters are assembled —
  apps/runtime/src/platforms/registry.ts).
- **The registry is live in the dispatch path**: executeStreamChunk's
  stream switch became registry dispatch — an undeclared stream for a
  platform now fails loudly instead of running the wrong platform's
  handler (the old switch ignored the platform entirely). Capabilities are
  parity-pinned against getSyncStreamsForPlatform + resolveStreamsForScope
  (drift fails the suite before Task 4 swaps the planner over).
- **All six mixed handlers split per platform** (light, top_spenders,
  transactions, subscribers, dm_conversations, dm_messages) — branch
  bodies verbatim, narrowing kept via assertion guards (`!==` — invisible
  to the ratchet by design: assertions, not branches), the transactions
  windowing prelude duplicated into both halves. Per-platform pull maps
  route straight to the halves; the old execute*Chunk names remain as
  compat shells for the three platform-agnostic test suites.
- **Ratchet**: scripts/check-platform-branches.mjs vs
  platform-branch-budget.json — day-one strict `platform ===` count
  recorded: **64** (self-excluding the ratchet's own test); wrapped into
  the registry suite.

REMAINING (next sessions): test re-point + shell deletion (ratchet drops);
exclusive-handler relocation into platforms/ modules; Task 3 —
onlyfans-ofapi adapter assembly (webhook/commands halves) + OnlyMonster
deletion (packages/onlyfans + bootstrap adapter/onlyFansAdapter fields +
AdapterLike); Task 4 — planner capability wiring (NOTE:
getSyncStreamsForPlatform's page-sync.ts:902 use is db-package-internal —
app callers move to capabilities, the db-internal list stays pinned);
Task 5 — platforms reference table + 7-column enum→text migration
(staging rehearsal + reverse REQUIRED before prod); Task 7 ops.

## Stage 18 Build Side Complete — OnlyMonster Deleted, Enum Retired (2026-07-06)

**Decision #99:** Stage 18's build half is complete on the chain branch
(c8d93d0 "18.5 OnlyMonster deleted" → a476139 "18.6 platforms reference
table"). Two commits, −7,742 lines net on the first. Physical
handler-relocation is DEFERRED (recorded below) — the seam's semantic
guarantees are all live and test-pinned.

**18.5 — OnlyMonster deletion (Task 3 tail):**
- `packages/onlyfans` deleted whole (adapter, mappers, errors, types) +
  workspace dep + `ONLYMONSTER_BASE_URL` config key/registry row.
  `onlyFansDefaultDelayMs` KEPT — the sync rate-limiter still paces
  OF egress with it (platform pacing, not vendor plumbing).
- `bootstrap.ts`: `onlyFansAdapter` field/construction/close gone.
  `adapter: AdapterLike` (Fansly) KEPT for now — its retirement rides the
  relocation leg (below), where the registry becomes the only adapter
  surface.
- **OF pages resolve token-less**: `resolvePageContext`'s OnlyMonster
  decrypt arm died; OF pages return `{ auth: { token: "" }, proxy,
  egressKey }` without requiring stored credentials (they have none).
  `resolveExecutorPageContext` = pure delegation now.
- **Credential surfaces re-pointed to OFAPI-era semantics:**
  verify-credentials matches `ofapi.listAccounts()` by username
  (route + test); update-credentials OF variant → 400 ("no stored
  credentials to update"); page proxies → 400 for OF (egress is
  vendor-side); CLI `page add onlyfans` lost --token-file/--proxy-*.
  Contract OF variants shrunk accordingly (createPage = {platform,
  username(+modelSlug,label)}; updateCredentials = {platform} tag only).
- **Failed-payload mapper tag** `onlymonster-phase3-v1` kept byte-identical
  as a local constant in sync/shared.ts (recorded rows stay comparable);
  honest re-tagging for OFAPI streams can ride a later leg.
- Tests: OFAPI-era onboarding fixtures (happy path also pins an EMPTY
  credential vault; ambiguity → 409 — the old "first match wins" behavior
  is deliberately dead; tx atomicity re-proven via the
  pages_ofapi_account_uniq constraint firing mid-transaction); OnlyMonster
  adapter/lookup/mapper/token-file tests deleted; sync-handlers pins the
  transactions skip stub (webhook-sourced). Ratchet 55 → 48.

**18.6 — platforms reference table (Task 5):**
- Migration 0068: `platforms(key, display_name, adapter_version)` seeded
  fansly/onlyfans; the 7 enum columns (pages.platform, fans.platform,
  dm_message_archive.platform, sync_http_attempts/sync_run_events/
  sync_rate_limits/page_fan_external_notes.provider) → text USING ::text
  + FK to platforms(key); DROP TYPE platform last.
- **Rehearsed locally on postgres:16: up → down → up, all clean.** The
  down file lives at docs/runbooks/0068-platforms-reference-down.sql (it
  CANNOT live in packages/db/migrations — the runner pattern-matches and
  applies every .sql there, and its filename regex rejects dotted
  suffixes). Staging rehearsal on a prod copy before deploy remains
  OWNER-GATED (passport rule).
- Drizzle: platformEnum died; columns are text(..., {enum}) so TS
  narrowing is unchanged; workboard-v2's raw `'fansly'::platform` casts
  dropped (type gone). GOTCHA fixed: the integration reset helper
  truncated ALL public tables — platforms is reference data pages FK
  into, so resetIntegrationDatabase now excludes it.

**RECORDED DEVIATION — relocation deferred:** the spec's remaining build
items (§2: handler bodies into packages/fansly-adjacent +
packages/onlyfans-ofapi modules; AppContext.adapter retirement with ~31
consumers re-pointed; webhook/commands halves declared on the adapter;
shared/types platforms const → registry-derived) are pure file/naming
motion with zero semantic delta — the isolation properties they serve are
already delivered by the split halves + registry dispatch + conformance
pins. Doing that churn mid-chain, right before Stage 26 rewires the same
modules' transport layer (resolveEgress), would move the same lines twice.
It goes to a dedicated mechanical session (compiler-driven), possibly
folded into Stage 26's entry. Wiring an adapter `webhook/commands` surface
NOW, with no consumer re-pointed to it, would be API surface without users
— declined on scope discipline.

**Stage 18 remaining after this:** relocation leg (above) + Task 7 ops
(staging rehearsal of 0068 on a prod copy, staged deploy Fansly-first,
48 h telemetry diff) — owner-gated.

**Full suite after the last code commit: 186 files / 1512 tests green**
(chain tip 24dee3e). The suite itself earned its keep twice on the way:
run 1 caught two stale pins still exercising the retired OnlyMonster
credentials arm of the metadata backfill (re-pinned to OFAPI-only
semantics in 24dee3e), and the first post-migration run caught
resetIntegrationDatabase truncating the platforms seed rows. File/test
counts dropped vs #98 (193/1555 → 186/1512) because OnlyMonster's own
test files went down with the package — deletions, not regressions.

## Stage 26 Build Half — Egress Seam, Class Pacing, Auth-Dead Pause (2026-07-06)

**Decision #100:** Stage 26's build side on the chain branch (d7ea175
"26.1 resolver+pacer+ratchet" → ed99b16 "26.2 auth-dead pause"). Ordering
deviation as #98/#99: built on green-local Stage 18 (dep). Tasks 1/2/4/5
complete; Task 3 PARTIAL (recorded below); Task 6 = ops.

**26.1 — the egress seam (Tasks 1+2+5):**
- packages/platform-core/egress.ts owns the SHAPE (EgressScope page|vendor,
  EgressContext, three priority classes); services/egress/resolver.ts is
  THE resolver with the recorded address policies: page scope = the page's
  proxy identity; vendor "ofapi" = vendor-direct (today's behavior, now
  written down instead of being an accident of bare fetch); vendor
  "fansly" = REFUSED (Fansly egress is direct-to-platform and must be
  page-scoped by construction). No default path — unknown scopes throw.
- **Pacing design decision (the naive version FAILED its own property
  test):** the existing reserve primitive pushes every locked row to
  scheduledAt+spacing, so a single-pass [vendor, class] reservation drags
  the vendor horizon out to bulk's backlog — interactive gained nothing.
  The mechanism that works is TWO-PHASE BULK: bulk waits out its own class
  row first, then claims the vendor row only when the send is imminent.
  Bulk's entire backlog lives in class:bulk; the vendor row only ever
  holds imminent sends; interactive pays in-flight sends, never the queue.
  Aging floor = claim-at-reservation (later arrivals can't push scheduled
  work). Vendor caps preserve today's effective rates (ofapi 500 ms;
  fansly 0 — there IS no cross-proxy Fansly cap today and seeding one
  would newly serialize proxies; the row exists as a knob).
- Migration 0069: sync_rate_limits.priority_class (additive, default
  'bulk').
- OFAPI client lanes: reads=interactive, commands=commands, list
  sync=bulk; admin request() stays unpaced (today's behavior). Rollout
  knob EGRESS_PACER_MODE off|shadow|enforce (default off — deploy inert;
  registry row added). Shadow computes the class-aware decision
  fire-and-forget — zero latency added, failures swallowed, diff logged as
  component=egress_pacer_shadow.
- Enforcement: undici value-import lint wall (egress modules +
  shared/http-client + pre-seam fansly adapter exempt; flat-config gotcha:
  the wall lives INSIDE the existing no-restricted-syntax rule because a
  second block would silently replace the toMills ban for overlapping
  files) + scripts/check-raw-fetch.mjs ratchet, day-one budget 13
  (ofapi 7 + fansly adapter 1 = Task 3 targets; telegram 4 + anthropic 1 =
  recorded non-platform exceptions). ofapi-fan-identities' local `fetch`
  closure renamed fetchPage (ratchet false positive).

**26.2 — auth-dead pause (Task 4, re-scoped per the spec's status header:
detection was already typed, the SEMANTICS were the gap):**
- pausePageSyncForAuth: whole page → FSM paused + blocker_kind='auth'
  stamped. The stamp is the reversibility contract:
  clearPageSyncAuthBlock (already in the re-verify recovery path) matches
  exactly the auth pause and never touches deliberately-paused streams
  (top-spenders/dm-polling feature gates).
- Direct-sync 401/403: executor parks the FULL stream set after the fenced
  per-stream block (before: one stream blocked, the rest kept burning
  against dead auth). Via getSyncStreamsForPlatform, NOT the registry —
  executor→registry would deepen the registry⇄executor-handlers value
  cycle (and broke sync-executor.test.ts's closed module mock; caught
  in-session).
- OFAPI accounts.*: action-required statuses pause; connected/reconnected
  release (vendor-signaled re-verify); session_expired stays alert-only.
- Commands fail fast: auth-dead page settles failed_terminal
  (ofapi_auth_action_required) BEFORE any HTTP — one-attempt discipline
  untouched, the attempt is never spent. Gated on
  OFAPI_ACCOUNT_HEALTH_ENABLED (stale ofapi_auth_status must not fail
  sends when the projection isn't running).
- Pinned: planner drops the paused page within one cycle
  (listRunnablePageSync), both resume paths, no-HTTP fail-fast.

**RECORDED — Task 3 partial:** the three behaviors' ADDRESS policies are
now explicit in the resolver and their PACING lanes ride the pacer hook
(shadow/enforce). The remaining physical adoption (createOfapiClient
requiring an EgressContext input; the Fansly adapter receiving transports
from the resolver instead of building dispatchers from the same factories)
is deferred to the mechanical relocation session shared with Stage 18's
deferral (#99) — the same modules move; identical factories mean identical
addresses today, and the ratchet (13→0 trajectory) keeps the debt visible.

**Task 6 ops (owner-gated):** deploy inert (0069 additive, mode=off) →
flip shadow → 48 h diff review (egress_pacer_shadow logs) → per-vendor
enforce cutover → staging saturation proof (interactive p95 flat under
bulk) → auth-dead drill (staged credential kill or next natural death).

**Full suite after the last code commit: 189 files / 1528 tests green**
(chain tip 4e2dcdd). The ratchets guarded their own stage: the first full
run caught the resolver's platform ternary raising the Stage 18 branch
count 48→49 — replaced with a vocabulary map (followup 4e2dcdd).

## THE BIG DEPLOY — Chain 0057–0069 Live in Prod (2026-07-06)

**Decision #101 (owner-directed "deploy and do what you need"):** the entire
built backlog — stages 8, 9, 10, 11, 12-glue, 14, 16, 17, 19, 20, 21, 22,
23, 24-core, 25, 27, 18, 26 — merged to main (fast-forward 05b6f3e →
aa522c8 + deploy-prep commits) and DEPLOYED to prod in one pass, migrations
0057–0069. Owner point-confirms per gate (deploy scope + shadow flip; probe
credential; six flag flips) — the #70 pattern held throughout.

**Pre-deploy evidence:**
- Stage 7 reconcile snapshot (28 h window, deploy moved earlier by owner):
  pull 11 producers both platforms, webhook 10.7k; `operator` source proven
  LIVE by the probe-credential audit rows (user.created + api_key.issued);
  `command_result` wired-but-no-traffic (watch: first natural desktop send).
  Formal 48 h close-out stays post-hoc queryable (observations timestamped).
- p95 baseline (20 gateway reads, probe chatter key): p50 0.964 s / p95 1.869 s.
- **0068 rehearsal on a REAL prod copy** (passport): server-side dump→restore
  into kernel_rehearsal (7.1 GB), migrations 0057–0069 forward clean, 0068
  9.6 s (432k sync_http_attempts rewrite — the prod lock window), DOWN-path
  proven (enum restored), re-apply 9.4 s. Rehearsal DB dropped after.
- First-ever OFF-BOX BACKUP: 3.0 GB pg_dump -Fc on the dev machine
  (scratchpad; 37 min over SSH). The accepted no-backup risk now has one
  point-in-time exception.
- Deploy-prep commit 4363d3c: the FIRST production build since Stage 18
  caught three stale packages/onlyfans refs (build-production.mjs,
  deploy-production.sh manifest/overlay/dist-Dockerfile, Dockerfile) and
  Buffer in the SDK cursor codec (dashboard tsc) → isomorphic
  TextEncoder/btoa rewrite, suites green.

**Deploy:** full image build (lockfile changed), nohup-detached (tool
timeouts must never kill a stack recreate). EGRESS_PACER_MODE=shadow set in
.env.production pre-restart (Stage 26 48 h shadow window started at deploy).
Stack recreate brought up agency-hub-scheduler-1 (Stage 25 role; compose
synced by the deploy script). Migrations applied at boot (advisory-locked):
schema_migrations 69, platforms seeded, enum platform GONE.

**Post-deploy verification:**
- Scheduler: leadership acquired, schedules registered, timekeeper running.
- Golden signals sampling (ops_metric_samples rows within minutes).
- p95 after: p50 0.962 s (byte-flat) / p95 1.059 s (improved) — Stage 9's
  capture tee costs nothing. read-gateway captured EXACTLY 20 observations
  for the 20 probe reads (1:1 — Stage 9 exit evidence). Probe key revoked.
- Shadow pacer logged 20 egress_pacer_shadow decisions (Stage 26 lane live).
- archive:backfill ran (2 archive + 34 hot batches).
- Workboard v2 serving (deploy script's same-origin dashboard check).

**LIVE DEFECT FOUND AND FIXED WITHIN THE HOUR (2dc8e3f):** the first sweep
appended 1,428 events — all PULL-family. The golden-signal canonicalize
breach fired immediately (Stage 25's alarm working as designed) on a stuck
4,000-row re-scan loop: webhook observations journal with account_id NULL
and only the vendor ref (native_account_ref = acct_…, capture-first by
design), but the sweep's unmapped check read row.accountId — the ENTIRE
webhook corpus (11k rows) skipped forever, and the keyset scan burned its
whole page budget on the same stuck rows (new observations starved). Fix:
the run context builds an inverse page map (platform-scoped over BOTH
platform_account_id and ofapi_account_id — OF pages' external id is empty
in the OFAPI era) and the driver resolves the ref before the check;
genuinely unmapped refs keep the skip-and-retry self-heal. Pinned by a
prod-shape test. Redeployed (dist-only path): backlog fully drained in 3
ticks — 10,836 events, live lag 55 s, tip.received events present,
remaining 1,988 pending rows = undeclared kinds (typing) by design.

**Staged flips (owner-confirmed, runbook step 6), written with audit rows:**
fanslyFanEarningsSyncEnabled + fanslyPurchaseHistorySyncEnabled +
fanslyNewStreamPageAllowlist="lilly-1,lilly-2" (Stage 16 lilly ramp),
fanslyDeepBackfillIgnoreRetentionLimit (Stage 17),
ofapiChargebacksReconcileEnabled + ofapiFanIdentitiesSyncEnabled (Stage 14,
boot-apply → worker bounced). GOTCHA: SSH heredoc quoting silently wrote
NOTHING on the first attempt (verify-after-write caught it); file+scp+psql -f
is the reliable path.

**Ops watches armed:** Stage 7 48 h close-out (~01:50 UTC 07-07, post-hoc
query); first natural command_result; Stage 16 shapes on lilly pages;
chargebacks first run 03:10 UTC; Stage 26 shadow diff review (~48 h);
Stage 19 would-deny log window → enforce flip; Stage 8/9/10 telemetry
windows per stage Progress blocks; desktop fleet x-client-version (07-12).

## Stage 28 First Slice — Ops Retention Bounded, Prune Returns Gated (2026-07-06)

**Decision #102:** Stage 28 Task 5 built and deployed same-day (1f8ead8;
suite 191 files / 1531 tests green). The other half of the deploy day: the
by-model earnings view (owner request — overviewRevenueByModel endpoint +
Overview "Earnings by model" card with trend sparklines) shipped in the
same window (7c4f81e + closed-mock followup 7ee5494).

- **sync_runs bounded** — the reverse-direction retention bug (unbounded
  growth, no deleter) closed: 30-day sweep, 'running' rows exempt,
  children cascade, raw payloads keep rows and null the link. 0070 index.
- **ops_metric_samples** 90 days (was the 14-day Stage 25 stopgap).
- **Prune = cache policy again**: flag default ON (kill-switch semantics
  kept one release), runtime-gated on archive coverage (archive ≥ hot per
  conversation, cached 15 min, fails closed, logs held-state). Prod env
  pins nothing → the coverage query is now the deciding gate in prod.
- **Redaction switch retired for good** — flag, sweep arm, repo fn
  deleted; terminal command payloads are permanent business facts.
- **Deleter enumeration** — the sanctioned scheduled deleters are exactly:
  30d observability sweep, 90d samples prune, coverage-gated DM cache
  prune, pg-boss archival. Any new SQL-deleting file fails the pin test.

**RECORDED for Task 1:** DuckDB ships as a runtime dependency (the
scheduler container runs exports); nothing is tierable until ~2027-01
(6-month hot window over data that starts 2026-07) — the tiering job lands
drill-tested on synthetic partitions ahead of need.

## Stage 28 Build Push — Tiering + Restore Drill + Metrics Models (2026-07-06)

**Decision #103:** same-day continuation of #102 — Stage 28 Tasks 1, 2, and
3's first slice built and drill-proven (d63b7ae → 82bbc63 → a066b48 +
build fix 5c505a3); deployed with the retention slice.

- **Tiering (Task 1):** export→verify→detach in that absolute order;
  detached partitions PARK in tiered_pending_drop — no DROP exists in code
  (owner-gated behind the drill, §6's one irreversible step). Exporter =
  NDJSON → DuckDB COPY TO PARQUET with explicit per-table schemas.
  postgres_scanner REJECTED (recorded): extension install needs network at
  run time; json+parquet ship inside @duckdb/node-api and work offline in
  prod and Testcontainers alike. Restricted kinds (desktop.guard_audit)
  export to lake/restricted under the same manifest/verify discipline.
  GOTCHAS BANKED: @duckdb/node-api must be a RUNTIME dependency (the
  scheduler-fired worker job runs exports) AND an esbuild external (native
  bindings can't bundle — the deploy's full image build caught it);
  ATTACH PARTITION demands LIKE … INCLUDING ALL (CHECK constraints);
  identity columns need OVERRIDING SYSTEM VALUE on restore.
- **Restore drill (Task 2):** from Parquet alone — staging rebuild, counts
  vs manifest AND the parked table, re-attach. The DROP gate is automated;
  the parked originals stay untouched until the owner rules.
- **Metrics models (Task 3 slice):** net_revenue_daily reconciles EXACTLY
  with revenue_daily (pinned — this is Stage 33's serving-swap gate);
  fan_ltv; response_sla. Models read hot Postgres only until lake data
  exists (~2027-01) — recorded, the lake UNION is additive then.
- Nothing is tierable in prod until ~2027-01 (hot window 6 months over
  data starting 2026-07): the daily 04:40 UTC cycle no-ops until the first
  partition ages out, with the whole path already drill-tested.

**Remains in Stage 28:** Task 4 (erasure CLI + erasure_log migration) and
Task 6 ops (first prod cycle, plateau watch, §5 exit criteria).

**Decision #104 (2026-07-06, session continuation):** Stage 28 **Task 4
built and drill-proven** — the audited break-glass erasure. `erasure:run`
CLI (dry-run default; `--execute` demands `--confirm <scopeRef>` verbatim),
migration 0071 `erasure_log`, `services/erasure/`. Build order within the
stage held: the erasure lands only after tiering existed, because erasure
must reach EVERY plane history can live in — hot tables, attached ledger
partitions, **detached-but-parked tables in tiered_pending_drop** (a
parent-table DELETE never reaches those — caught at design time), and the
Parquet lake (filter-out rewrite, manifest re-checksum, an `erasures[]`
record inside the manifest).

- **Semantics rulings (recorded):** catalog rows (models/pages/users)
  survive — erasure removes captured facts and derived projections, not the
  agency's own records; offboarding is a different act. The `fans` row IS
  captured identity and goes. Fan-scope transactions are ANONYMIZED (fan
  linkage + vendor identifiers nulled), never deleted — the money moved and
  aggregates must stay truthful; page/model scope deletes the page's
  transactions outright.
- **No post-erasure projection rebuilds** — deliberate deviation from the
  stage doc's letter: once partitions tier, a full account rebuild replays
  hot events only and would DESTROY projection rows sourced from detached
  months. Erasure purges projection rows directly; non-resurrection is
  structural (source observations/events are gone) and the drill proves it
  by replaying projections after the erase.
- **Observation exclusivity:** an observation dies only if no OTHER fan's
  events reference it; shared batch captures survive and are counted in
  plan + tombstone (`sharedObservationsKept`) — residual risk visible, not
  hidden. Undeclared kinds (parse_version 0) are reached by payload text
  match (quoted-JSON always; bare-numeric with boundaries).
- **Loud-failure curation:** the fan-FK stance is introspected from
  pg_constraint at run time; an unmapped non-cascade FK to `fans` fails the
  plan with the table name — a new table can't silently join the fan graph
  without an erasure ruling. (fan_earnings_stats RESTRICTs fans — cleared
  before the fans row by curated order.)
- **Audit is service-level dual-write:** audit_events + operator
  observation with account_id NULL — the erasure's own trail is
  structurally unreachable by a re-run of itself.
- **Drill (tests/erasure.integration.test.ts):** synthetic fan A vs
  bystander B on one page, facts across every plane including a parked
  partition and lake parquet+manifests; dry-run plan == executed counts
  EXACTLY; B and the shared observation survive; manifests re-stamped with
  fresh checksums; idempotent re-run converges to zero everywhere.
- **Gotchas banked:** drizzle sql`` expands arrays to `($1, $2, …)` — write
  `in ${arr}`; `any(${arr})` and `in (${arr})` both break (malformed array
  literal / record comparison). A negated ledger pred needs
  `not coalesce((pred), false)` — NULL conversation_ref silently ate the
  shared-lineage guard under three-valued logic.
- retention-deleters allowlist gains services/erasure as the ONE sanctioned
  non-scheduled deleter.

**Remains in Stage 28:** Task 6 ops only (first prod tiering cycle
~2027-01, plateau watch, §5 exit criteria). Erasure stays unused until a
real request; the drill is the rehearsal.

**Decision #105 (2026-07-06, same session as #104):** Stage 29 **Tasks 1–5
all built green-local** — AI gateway hardening + the DP 6-A restricted
capture class. Migration 0072. Key rulings:

- **generation_ref = the gateway's existing requestId** (already exposed on
  the meta frame) — assumption 3 verified, no envelope change; it is the
  acceptance correlation key end-to-end.
- **user_id NULL = system lane** on ai_usage_events (DROP NOT NULL, the
  Stage 9 credit-ledger precedent) — the classifier's nightly spend books
  without a synthetic user.
- **Denials are ledger facts:** every quota/budget breach writes a
  quota_denied row AND throws the typed error (HTTP 429 `quota_denied`).
  Client-visible taxonomy change recorded: gateway quota paths no longer
  return `rate_limit_exceeded`. Quota 429 still outranks
  provider-unconfigured 503 (pre-Stage-29 ordering preserved; reservation
  rows carry provider NULL until one resolves).
- **Per-feature budgets are GLOBAL per day** (JSON config map), not
  per-user — the point is "the nightly classifier run fits", and the
  per-user/page daily quota already exists one layer up.
- **Classifier egress stays DIRECT** (no page proxy) in the internal lane —
  byte-identical to the retired SDK call; prompts/model/params carried over
  byte-for-byte; @anthropic-ai/sdk now import-banned outside the gateway
  provider files (ESLint paths ban + importer-list pin test).
- **Acceptance feed is a projection, not a canonicalizer** — acceptance
  rows are a side table, not domain events; the pure-parser discipline of
  the canonicalize driver stays intact. Watermark = account_id 0 sentinel
  over observation ids; correlation best-effort until Stage 31.
- **All outcomes captured** in ai_generation_content (a cancelled stream's
  partial completion is still a fact); restricted tables lake-excluded by
  construction (pin test) and inside the erasure reach (fan scope via
  conversation_ref, page scope via page_id).
- **OpenRouter with no vendor SDK** — fetch-based SSE through the SAME
  page-proxy fetch wrapper as Anthropic (raw-fetch ratchet stays 13);
  prefix routing; ships implemented-but-unkeyed until OPENROUTER_API_KEY
  lands; pricing catalog is provisional pending the §5 invoice week.
- ai-usage batch lane marked deprecated (successor = gateway finalize;
  removal gated on Stage 31 fleet cutover).

**Remains in Stage 29:** Task 6 ops (deploy 0072+0071 together, §5 probes,
invoice reconciliation week). NOTE: Stage 28.4 (#104) is committed and
pushed but NOT yet deployed — the deploy gate needs an owner confirm; 0071
and 0072 ride the next deploy window together.

**Decision #106 (2026-07-06, same session):** Stage 30 **Tasks 1–3 core
built green-local** (full suite 1675/1675) — the prompt unit migrated
byte-for-byte from the desktop (@ 1db76a4ae13d) with its 123 regression
tests green kernel-side unchanged; manifest with per-file source hashes;
0073 ai_personas; the feature-service route with the fast-reply pilot
proven end-to-end over Stage 29's gateway internals. Context loaders
reconstruct the vendor message shape from archive rows and run the MIGRATED
normalizer/formatters — parity by construction, with three NAMED gaps (PPV
purchased-state, ledger-derived spending sums, media labels) as Task 5
checkpoints. PRE-FREEZE DEVIATION recorded: the owner has not yet declared
the prompt-freeze window; the snapshot is re-verifiable against the
recorded commit, and Task 5's parity sign-off is the gate before any
client cutover. Remaining: Task 4 (other features + persona seeds), Task 5
(parity + sign-off, owner-gated), Task 6 (ops; 0071+0072+0073 deploy
together at the next owner-confirmed window).

**Decision #107 (2026-07-06, same session):** Stage 30 **Task 4 built** —
all seven inventoried features serve through `/api/v1/ai/features/:feature`
(suite 1676/1676). FEATURE_POLICIES migrated with verbatim values (one
recorded adaptation: the Settings-coupled window resolver became kernel
bucket defaults seeded from the desktop's); the kernel registry is DERIVED
from the policies, so prompt behavior, model delegation, earnings
inclusion, and the product gates (draft required, deep minimum 30,
hi-greeting ≤10 lock, ping segment analysis) have ONE source of truth.
Remaining in Stage 30: Task 5 parity harness + freeze capture + sign-off
(OWNER GATE: declare the prompt freeze), persona seeding + extension
inventory (rides the freeze), Task 6 deploy/smoke/latency.

**Decision #108 (2026-07-06, owner-confirmed):** Stage 30 **prompt freeze
DECLARED and parity SIGNED OFF.** The owner confirmed both gates in one
structured confirm: (a) production deploy of the built backlog (0071
erasure_log + 0072 AI restricted class + 0073 ai_personas + Stages
28.4/29/30 code), (b) the prompt freeze — no tuning in either client repo
until parity sign-off.

**Parity sign-off (passport rule: assembled prompts, not outputs):**
- Freeze guard: desktop HEAD == frozen snapshot 1db76a4ae13d; all 24
  migrated files' SOURCES re-hash exactly to the manifest's recorded
  sha256 values.
- Assembly parity: 9 fixtures across all seven features (tone/mode
  branches, draft, ping segments, fan bio) — kernel `buildPrompt` output
  is BYTE-IDENTICAL to the live desktop `buildPrompt` imported from the
  sibling checkout. Zero differences.
- Harness: tests/ai-feature-parity.test.ts (skips where the sibling repo
  is absent) + the authoritative runnable
  `node --import tsx/esm scripts/ai-parity-signoff.ts` (exit-coded).
- CAVEAT recorded: this proves ASSEMBLY parity. Context-VALUE parity for
  the three named loader gaps (PPV purchased-state, ledger-derived sums,
  media labels) is a Stage 31 cutover checkpoint against live traffic —
  the harness level is what the passport requires for this stage's exit.
- `ai:personas-seed` CLI upserts the bundled personas into ai_personas
  (idempotent; run post-deploy).

Client cutover stages (31/32) are now unblocked on the parity side.

**Decision #109 (2026-07-06, owner-confirmed window):** the Stage 28.4 /
29 / 30 backlog is **DEPLOYED to production** (root@45.8.230.111).
Sequence: full-chain deploy (image from 6bba967-era tree; migrations
0071_erasure_log + 0072_ai_restricted_class + 0073_ai_personas applied at
startup under the advisory lock — schema_migrations 73; all containers
healthy incl. scheduler) followed by a dist-only redeploy of HEAD 0541b22
(the first image snapshot missed the ai:personas-seed CLI by minutes —
gotcha: the docker build context snapshots at launch; anything committed
after the deploy starts needs a follow-up dist-only pass).

Post-deploy verification:
- erasure_log / ai_generation_content / ai_acceptance_events / ai_personas
  all exist; erasure and capture tables empty (nothing invoked — correct).
- Route smoke: /api/v1/ai/restricted/generations → 401 (exists,
  owner-gated); POST /api/v1/ai/features/fast-reply → 400 on empty body
  (exists, contract-validating).
- Personas seeded via ai:personas-seed: builtin:lora (7,049 chars).
- Golden-signal volume gauges live: ai_content_rows=0,
  ai_content_bytes≈40KB (empty-relation baseline) sampling minutely.
- Prod now serves: the erasure CLI (unused until a real request — the
  drill is the rehearsal), the hardened gateway (budgets + quota_denied +
  restricted capture on every generation INCLUDING the nightly classifier,
  whose next run books spend under workboard-closing), and all seven
  kernel feature services (no client consumes them until 31/32).

Stage 29's remaining exit items (production probes + invoice week) and
Stage 30 Task 6's smoke-per-feature + latency numbers run against this
deployment.

**Decision #110 (2026-07-06):** Stage 30 **EXITED** — production smoke of
every feature service via the new `ai:feature-smoke` CLI (lora-of,
conversation 310112051, as admin). Headline: **kernel context+prepare =
77–159 ms** across all features — the only latency added vs client-local
assembly; provider time dominates identically in either mode (DP 5 holds
with two orders of magnitude of headroom; this is Stage 31's comparison
number). fast-reply 2.0s total / $0.024; deep features on their tuned
models (fan-summary Opus, 123s, $0.24). hi-greeting correctly 400-gated on
a long conversation — the migrated product gate firing in production.
Every smoke generation landed in ai_generation_content with its ledger
row. All §5 exit criteria met: byte-diff proof, parity sign-off (#108),
per-feature smoke with recorded latency, sanitize regressions green.
Stages 31/32 fully unblocked. Smoke spend ≈ $0.48 total (three quick
features ran twice — a parse-retry re-ran them; completions captured both
times, recorded honestly).

**Decision #111 (2026-07-06):** Stage 31 BUILD COMPLETE (Tasks 1–4) on
desktop branch `kernel/stage-31-ai-cutover` @ 40e8e65 — the desktop's
local AI machinery is deleted; the kernel feature lane is the only path.
Highlights: the deletions sweep (a5ca0a0, −10,693 lines: shared prompts/
+ llm/, provider clients, both legacy gateway lanes, context loader,
model-selector UI; `aiGatewayTransport` collapsed to
`z.literal('feature')` — the ofapiReadTransport precedent, third and
last application); acceptance lifecycle (shown/copied/inserted/
sent+edited) on the Stage 11 capture spool with the
operationId+requestId correlation pair; personas as kernel CRUD with the
local KV as offline cache; spend priced by the gateway usage frame (the
mapGatewayUsage costMicroUsd omission caught and fixed in f3e9bfc —
coordinator tests had injected cost directly and masked it); vendor keys
decommissioned (out of SECRET_NAMES, secret files deleted on boot —
unrecoverable by rollback; KeySettings dead; the hub connection probe,
collaterally deleted by the sweep, rebuilt hub-only); usage lane in
drain mode (no producer; reporter kept one release for parked rows;
db.counts.usageEvents in the diagnostics export is the drain gauge).
Suites 538 + 1100 green; 3 grep gates pin the cutover. NOT RELEASED —
Task 5 (pilot workday → staged fleet 0.1.31 → §5 verification → owner
comms + upstream vendor-key revocation) is owner-gated and additionally
gated on 0.1.30 fleet adoption.

**Decision #112 (2026-07-07):** Dashboard REBUILD instead of modernization —
owner decision superseding Stage 33's incremental approach ("visual behavior
preserved, response shapes unchanged"). The owner wants a FULL NEW dashboard,
designed and built in its own Claude session with its own PRD; the current
`apps/dashboard` is DEPRECATED — it keeps serving until the new one reaches
parity sign-off, then is deleted. Stage 33's substantive requirements carry
over as PRD inputs, not as constraints on shape: reports served from the
Stage 28 metrics models, grants + device-token admin UI, erasure UI
(owner-only, dry-run-first), golden-signals page, live updates over stream
v2 instead of the 18 polling timers. Launch prompt:
`docs/project-kernel/prompts/prompt-dashboard-rebuild.md`. The Stage 33
in-flight branch (kernel/stage-33-dashboard, unpushed: the useKernelEvents
bridge + polling-site sweep) was ABANDONED; its verified ground truth
(polling inventory, the v2 event-lane facts) is preserved in the launch
prompt instead.

**Deploy log (2026-07-06/07, owner-run chain "deploy, check, test, release"):**
dist-only deploys of main → prod (three passes: f4ae42e enablers; 26a5b2e
window params; 535cfb8 the walk). Verified: health green; the Fansly
feature smoke on lilly-1 generated end-to-end with the captured prompt
containing "Fansly" and ZERO "OnlyFans" (named substitution live);
top-spenders route serving (401 unauth). FOUND + FIXED (the Stage 16 ramp
doing its job): fan_earnings capture never returned data — Fansly's
earnings endpoints answer PER FAN (correlationAccountId); a windowed call
without one returns [] (probe-confirmed: with a fan id → 21 rows). Capture
reworked as a spender-scoped checkpointed walk (page_fans net>0, two calls
per fan, concatenated chunk journals). purchase_history remains blocked on
its own param contract (order-history wants accountMediaId — the per-fan
walk shape needs rework; circuit breaker failing loudly as designed).
Desktop fleet-version telemetry was reset by the container restarts —
0.1.30 adoption check pending fresh traffic.

**Extension 1.6.0 RELEASED (2026-07-06 ~19:40 UTC):** signed xpi live on
https://ext.gosling-agency.ru/updates.json (sha256:0729e450…, gecko ≥142,
753 KB). The Stage 32 cutover ships: kernel-only AI (vendor host
permissions gone from the manifest), device-token sign-in, kernel spenders
board (lifetime gross from fan_earnings_stats), acceptance telemetry,
x-client-version producer identity. Old versions keep working until
update. §5 week-watch from here: fleet on the version header, kernel-only
network panel + measured Fansly quota drop, chatter walkthrough,
acceptance observations under producer chatgoose-extension@1.6.0. The
NEXT release deletes the board fallback (spendersLegacyRebuild) and the
legacy chatter-key path.

**Family law (recorded per Stage 35, 2026-07-06 — binding family-wide):**
(a) **Anti-deletion rule** — removing or superseding any hand-curated
document requires a tombstone entry in the owning repo's decision log;
deprecated specs get a banner, never deletion (generated docs under
`docs/generated/` are exempt — they are regenerated, not curated).
(b) **Updated-in-change** — hand-curated docs are updated in the same
change that invalidates them. (c) **Cross-repo decisions live in THIS
log**; client repos reference entries by number, never copy them. Client
logs exist as of today: desktop `docs/decisions.md` (D1–D5), extension
`docs/decisions.md` (E1–E7). NUMBERING NOTE (append-only honesty): this
log has historical gaps — #27–#45 and #47 were never written (the era
between the v1 build log and the OFAPI integration entries) and one
duplicate #80 exists; numbers are never reused or renumbered.
TOMBSTONE (recorded retroactively): the 2026-07-02 cleanup deleted the
OFAPI feature-plan doc, the deploy-audit report, and the pre-deploy fix
reports (contents survive in the memory of the working sessions and in
this log's entries #48–#53); the Workboard v3 PRD and brief were deleted
2026-06-10 by owner decision and are unrecoverable (reflog expired) —
lesson recorded in the owner's project notes.

**Decision #113 (2026-07-07, Stage 35 Task 3):** The family CI floor and
toolchain are harmonized. (1) Core ESLint grew from the Stage 19 bootstrap
to the family standard — js/ts recommended + the desktop's hygiene rules
(no-unused-vars with `_` escapes, consistent-type-imports, no-explicit-any
as ERROR) layered under the architecture walls (module boundaries #19,
money-constructor ban #27, undici-outside-egress ban #26, vendor-AI-SDK
ban #29); the 162-violation backlog was burned to zero (no eslint-disable
waivers; the locking.ts unsafe-finally rewrite preserves all five
outcome matrices byte-identically). (2) Core gains `pnpm check`
(typecheck + lint + test:unit + dashboard build) — the same command
clients run. (3) One toolchain family-wide: pnpm pinned via
`packageManager` = 10.33.1 in all three repos (workflows read the pin —
no duplicated versions in CI), engines.node >= 22, TypeScript ^6 and
vitest ^4 everywhere (core 5.8→6 dropped the deprecated `baseUrl` for
relative `paths`; vitest 4 required a constructible class mock in
bootstrap.test.ts and honest spyOn casts in fansly-dm-fixtures).
(4) STRICTNESS RATCHET: `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess` are ON in tsconfig.base.json; the surfaced
debt (2058 errors, 136 files — 84% is `possibly undefined` from indexed
access, mostly tests; the deprecated dashboard's share dies with the
rebuild) is snapshotted per-file in `scripts/strictness-ratchet.json`
and enforced by `scripts/check-strictness-ratchet.mjs`, which IS
`pnpm typecheck`: a file over its budget fails, a new file with errors
fails, and a shrink demands the snapshot be shrunk in the same change
(both directions drill-verified). The count only goes down; zero debt
makes typecheck plain tsc again. (5) CI: core PRs additionally run the
sync-critical subset now selected by a `[sync-critical]` title tag
(the drift-prone 16-fragment `--testNamePattern` allowlist is retired;
the tag selects the same 19 tests — verified by `vitest list`); a new
nightly workflow runs the FULL Testcontainers suite including the
projection rebuild-from-fixtures proofs. (6) Desktop gets its first PR
CI (`ci.yml` running `pnpm check`, green locally before commit) — the
zero-PR-CI era is over; the extension already had lint-in-check from
Stage 32 and moved to TS 6 — where the first check run FAILED on the
deprecated `baseUrl` (TS5101) and the failure was initially masked by a
piped exit code; the vestigial `baseUrl` was removed and the full check
re-verified green with an unmasked exit. Lesson, family-wide: never read
a suite's result through a pipe — `cmd | tail` reports the pipe's exit,
not the suite's.

**Decision #114 (2026-07-07, Stage 35 Tasks 4–6 — the closing stage is done):**
Maps regenerated into `docs/generated/` in all three repos (core 24 /
desktop 12 / extension 18, banner-pinned to commit, Pass 1 originals
banner-superseded, map prompts carry a committed regeneration addendum);
client CLAUDE.md files rewritten/created to post-migration truth with SDK
versioning-and-pinning sections; release-hygiene asserts live in both
release paths (extension deploy.sh proven against the live feed; desktop
windows-build.yml). Orientation drills — a fresh session per repo, CLAUDE.md
as sole entry — PASS ×3 with file:line-verified answers; every doc defect
they surfaced was fixed in-change (core map index routing; extension MV2→MV3,
stale gateway-contract pointer flagged, E3 correction; desktop SPEC
§6.2/§8.6 superseded banners + precedence note). The regeneration itself
found and fixed a shipped extension bug (E8: options-page device-token
sign-in unreachable — missing protocol case; next release must also migrate
the 4 legacy-key-only hub ops before deleting the chatter-key path).
Family CI green same-day: core 28824417152, desktop PR #1 28824630105
(first-ever PR CI, on a real draft PR), extension 28825364090. With this,
the 35-stage Project Kernel migration's documentation standard is in force:
CLAUDE.md + decisions.md + docs/generated/ are the living surface;
docs/project-kernel/ is the archive.

**Decision #115 (2026-07-07, GPT-5.5 xhigh release audits — owner-directed):**
Codex (gpt-5.5, xhigh) audited three surfaces before tonight's releases.
(1) CORE lint burn-down (#113): CONFIRMED behavior-neutral — all
locking.ts outcome paths equivalent, no cleanup regressions. (2) Its three
core findings against Stage 31/32 code: [fixed] the fan_earnings walk could
overshoot the chunk request budget by one — hasRequestCapacity(count) now
reserves both per-fan calls up front (chunk-budget.ts + walk, pinned in
tests/chunk-budget.test.ts); [fixed] clientContext accepted for ANY platform
— now fansly-only per the Stage 32 rationale (OnlyFans context is
kernel-fresh; a bearer could fabricate transcript/spend), 400 otherwise,
integration block moved to a fansly page + OF-rejection pin; [OPEN — owner
call] persona upsert/archive routes are `apiKey`-auth (any chatter/device
bearer can edit the GLOBAL persona system blocks; stage-32 spec said
owner/team-lead-gated). Deliberate tension: the desktop's persona
sync/editor runs under chatter credentials — gating writes to owner breaks
that flow. Options when decided: (a) accept for the trusted single-tenant
team, (b) role-gate writes and move desktop persona sync to an owner-run
step, (c) per-user personas. Not changed tonight. (3) DESKTOP 0.1.31 and
EXTENSION 1.7.0 findings: fixed in their repos (desktop: device-token-only
AI gate, stale copy, pre-build tag assert; extension E10: Bearer-"set"
poisoning, key-gated token flow, null-safe bearer). Desktop finding
"vendor-key-only installs stranded" judged vacuous: 0.1.30 reads are
hub-only, a working install necessarily has hub credentials.

**#115 persona-auth RESOLVED (2026-07-07, owner):** ACCEPTED AS IS — persona
upsert/archive stay `apiKey`-auth. Rationale: single-tenant (DP 9-A), the
bearer set is the agency's own trusted team, and the desktop's persona
sync/editor legitimately runs under chatter credentials. Revisit only if the
team grows beyond trusted operators or a per-user persona design lands.

**Decision #116 (2026-07-07, owner via identity-planning session):** Family
credential ruling — HUMANS authenticate with username+password (one per
person) and per-device tokens (`agency_hub_device_`, minted by the person's
own sign-in in each client); ROBOTS (probes, scripts) use API keys
(`agency_hub_core_`). Keys leave the HUMAN onboarding path; they never leave
the kernel. Concretely:
(a) **Chatter password provisioning moves into the live dashboard** (the gap
that stranded token adoption: chatter creation offered no password field, no
set-password control existed, so tokens were unissuable without CLI/devtools).
Ships as: optional password on chatter creation + "Set password" in the
chatter detail modal, both riding the existing
`PATCH /api/v1/admin/users/:username/password`. If a dashboard rebuild
proceeds (#112), this is parity scope.
(b) **`must_change_password` stays FROZEN for chatters** until a self-serve
change-password surface exists somewhere: the gate's allowlist
(me/logout/authChangePassword) correctly blocks device-token issuance, and no
client or chatter-reachable page renders a change-password form — a flagged
chatter would be stranded. The allowlist is NOT widened (that would hollow the
flag); provisioning always sends `mustChangePassword: false`.
(c) **Client key-fallback deletion gate** (replaces "after fleet migration"
with something checkable): (1) provisioning UI live in prod, (2) every active
chatter holds a device token with `last_used_at` fresher than 14 days,
(3) one week fleet-wide without CG-HUB-03. Then, as one kernel-declared step:
the extension executes its E9 deletion, the desktop adds `hubApiKey` to
decommission-on-boot. Dashboard "Issue Key" survives — for automation.
(d) **The workboard is not an input to this plan.** Owner stated in this
session that the workboard direction is deprecated (the v2 dashboard page
included); identity work must not wait on Stage 34. OPEN ADJUDICATION left
with the owner, not resolved here: reconcile #112 (dashboard rebuild ruling)
and the Stage 34 progress note (2026-07-07 "DPs RESOLVED") with the stated
deprecations — both entries currently read as active plans.
Client-side counterparts: extension E12 (hub-failure diagnostics) already
recorded; extension E9 deletion and the desktop probe fix reference this
entry.

**Decision #117 (2026-07-07, owner):** #112 REVERSED; workboard direction
CLOSED — the #116d open adjudication is resolved. (1) The dashboard rebuild
is CANCELLED: `apps/dashboard` is NOT deprecated — it is the live, maintained
admin surface (the owner runs the agency from it daily). The #112 carry-over
features (grants + device-token admin UI, erasure UI, golden-signals page,
stream-v2 replacing the polling timers) become BACKLOG items for the live
dashboard — incremental work, no rebuild, no parity gate. TOMBSTONE:
`docs/project-kernel/prompts/prompt-dashboard-rebuild.md` AND the PRD
workspace `docs/project-kernel/dashboard/` (skeleton prd.md + README) deleted
in this change (the prompt's verified ground truth — the polling inventory and
v2 event-lane facts — originated in the abandoned Stage 33 branch notes;
re-derive from code if needed); CLAUDE.md header and SESSIONS.md harness
table updated in the same change. Consequence for #113: the strictness-ratchet debt attributed
to "the deprecated dashboard's share dies with the rebuild" is REAL debt now
and burns down like everything else. (2) The workboard direction is
DEPRECATED (owner, same session — including the dashboard's Workboard v2
page as a product direction; the page keeps serving as-is): Stage 34 stays a
placeholder with a deprecation banner, its 2026-07-07 "DPs RESOLVED" progress
note is historical, the design-pass prompt and PRD skeleton are banner'd and
must not be run. No identity/auth work waits on a chatter web surface —
chatter password self-service remains owner-managed (dashboard Set password,
#116) unless the owner later orders a standalone change-password page.

**Decision #118 (2026-07-07, owner):** Stage 28.4 page-scope erasure also
purges the page's config/secret rows (`page_credentials`,
`egress_endpoints`). Soft delete (#72) stays a two-way door and deliberately
keeps them; erasure is the one-way door and previously left encrypted secrets
present-but-unreachable forever (all credential readers/deleters are
active-gated, and the erasure target list omitted both tables). DP 7
unaffected — these are config, not captured facts; the erasure module is
already on the retention-deleters allowlist. Regression: the page-scope
erasure drill in `tests/erasure.integration.test.ts` seeds both rows and
pins their `hot:*:delete` targets. Origin: external review finding R2-1
(the reviewer's delete-in-soft-delete fix was rejected as reversing #72).

## External-Review Fix Batch Deployed — Stage 26 Shadow Window Restarted (2026-07-07)

Three automated reviews of main (`0ebf936..1a06b5d`, `..05b6f3e`,
`..1ea4e10`) produced 25 findings; all verified in-repo before acting
(five parallel audit agents). 21 fixed across 17 commits
(`15c53ae..0d60fe9`) plus #118 (`d3a581d`); 4 no-action: R1-2 stale
(already fixed by 5021ac2/0056), R1-6 benign by design (capture-first),
R1-8 deprecated surface (#117), R3-5 optional Drizzle hygiene. Three
reviewer-proposed fixes were REJECTED and replaced: delete-children-in-
soft-delete (reverses #72 — replaced by #118 erasure coverage), inner
page_fans join in the AI name lookup (blanks un-linked fans — platform
filter instead), skip-observation-on-stale-finalize (drops a captured
fact — the idempotency key already dedupes the race).

Headline fixes: the shadow egress pacer is isolated to `shadow:vendor:*`
rows and shadow bulk claims only its class row — **all Stage 26
shadow-diff data collected before this deploy is invalid; the 48 h
observation window restarts at this deploy, and the enforce cutover must
be judged only on post-2026-07-07 numbers.** Observation idempotency keys
are per-fetch (`page:stream:run:requestSeq.N`) — multi-page chunks
journal fully (`fan_earnings_monthly` had been dropped every chunk).
Global notification incidents (null page) are listable and manually
resolvable. SDK `onAuthError` fires for raw()/SSE 401s. Webhook
transaction provenance survives REST backfill. Tombstoned pages leave the
visible-model surface. CI regenerates contracts and fails on drift; three
guard tests joined the `[sync-critical]` PR slice (19→22).
`fansly:replay-probe` refuses verdicts on dry-run/zero-call runs. The
fan_earnings walk yields `request_budget`, not null. Write eligibility
requires an active page (backfill + spend sweep). Incident resolve texts
are exhaustive per kind. Ten auth flows commit mutation+audit atomically
(`withAuditTransaction`). The #116 provisioning flow is extracted and
unit-tested. AI-context money rides `millsToDollarsNumber`. Dynamic
undici imports are lint-banned; the two ipify diagnostics ride an
`undiciRequest` re-export from http-client.

Deploy: dist-only `d3a581dc2861` (~19:00 UTC). Script verified API
health, worker healthcheck, and image labels; the `/api/v1/health/sync`
gate then timed out 8× — post-restart worker catch-up plus autovacuum
made the visible_pages aggregation exceed the 30 s per-attempt cap, and
each abandoned attempt left its query running server-side (17 stacked
backends at peak, a self-amplifying loop). The script was deliberately
stopped before exhausting retries to prevent an auto-rollback of a
healthy stack (locks released cleanly; no rollback ran); the two
remaining gates were completed by hand: sync-health 200 with pages
(56 s → 34 s as the backlog drained), `/login` 200 with the root mount.
Deploy-script follow-up for a future session: the sync gate's 30 s
per-attempt cap is too tight for cold-start churn — raise its max_time
or make the API cancel the query when the client disconnects.

Still open after this batch: prompt-1-map re-runs for
`docs/generated/00-overview.md` (claims TS 5.8/Vitest 3; repo is on
TS 6/Vitest 4) and `18-retention-erasure-tiering.md` (generator-emitted
trailing whitespace) — fresh session, hand-edit banned by their banners.

## Project-Review Fix Batch: the 4 Surviving Findings (2026-07-08)

The Workflow-orchestrated project review (5 finder passes → adversarial
verify → 7 confirmed findings, run before the external-review batch
landed) was re-checked against `d0a4651`: two findings were already
resolved by that batch (revenue-route enforcement is live in `enforce`
on prod via `REVENUE_ROUTE_ROLE_ENFORCEMENT`; the AddChatterModal
orchestration was fixed by R3-7), one narrowed to a P4 residue (the
strictness ratchet's fail-open now only affects partial-workspace runs,
where the shrink check is skipped). The remaining four were re-confirmed
by a fresh adversarial verifier agent against ground truth, then fixed
in `22687a0..4d87146` (each commit carries the full failure analysis):

- **P1** deleted page → perpetual schedule/lease/throw/reclaim churn
  (~2–3 min cycle, forever). Planner/lease queries now require
  `p.status='active'`; the executor parks (not throws) on a missing
  page; the DELETE route pauses the page's streams. `22687a0`.
- **P2** historical `active_subscribers` decayed retroactively: the
  full-history rebuild gated on `is_current=true`. Retired rows now
  count through `least(ends_at, last_seen_at)`. Projection rebuild
  self-heals prod on the next sweep — no migration. `a651836`.
- **P2** the scheduler had no healthcheck and no deploy gate: heartbeat
  file written only after a successful instance-heartbeat upsert +
  compose healthcheck + `wait_for_scheduler_health`. Standby entries
  must not carry the healthcheck. Follow-up (small, separate): golden-
  signal alert on the sync planner queue's newest-job age, for the
  healthy-process/dead-timekeeper wedge. `7243593`.
- **P3** the Subscribers "All" chip/header showed the filtered total;
  both now ride a dedicated unfiltered `{limit:1}` count. `4d87146`.

Verification: `pnpm check` green; red-green proven for both new
integration pins (they fail on the pre-fix queries); 11 adjacent
integration suites (196 tests) green under Docker.

**Decision #119 (2026-07-08, owner):** #117 clause (2) NARROWED — the
workboard closure was recorded wider than the owner's intent. What is
deprecated is the workboard INSIDE core: the dashboard's Workboard v2 page
as a product direction (the page keeps serving as-is — unchanged from #117).
The STANDALONE workboard application (Stage 34, DP 4a = B) is an ACTIVE
direction again — the owner wants it built. The 2026-07-07 resolutions in
the Stage 34 progress note are REINSTATED as decisions of record: **DP 4b =
kernel sessions** (no IdP, no browser device tokens), **DP 4c = per-page
grants** (the existing `assignedPageIds` enforcement shape), hosting = same
VPS at `workboard.gosling-agency.ru`, repo `~/code/workboard`, v1
Fansly-only. The #117 tombstone banners on the design-pass prompt
(`docs/project-kernel/prompts/prompt-workboard-design.md`), the PRD skeleton
(`docs/project-kernel/workboard/prd.md`), and the Stage 34 placeholder are
replaced with pointers here in the same change; CLAUDE.md header and the
SESSIONS.md harness table updated likewise. Entry criterion unchanged:
owner-approved PRD (the design pass stops there) before any Stage 34 code.
#116d's identity ruling is unaffected: no identity/auth work waits on the
workboard; chatter password self-service remains owner-managed (#116) until
the app actually ships a change-password surface. Same day, executing this
decision: the repo `~/code/workboard` was scaffolded (family standard from
day one — CLAUDE.md, AGENTS.md pointer, `docs/decisions.md` with the family
law + W1, README, PRD skeleton at `docs/prd.md`; that repo's docs are NOT
gitignored) and the separate launch-prompt ritual was DROPPED (owner: "не
усложняем") — the new repo's CLAUDE.md carries the rules and decided
inputs, its PRD skeleton the section briefs and seeded owner questions; the
design pass is now just a fresh session in `~/code/workboard` asked to
write the PRD. The core copies (design-pass prompt, PRD skeleton, workspace
README) carry retirement banners and are frozen history. The founding
inputs were then RE-CONFIRMED by the owner in a structured interview
(2026-07-08, doubting the 07-07 record): login/password against core,
per-page grants, Fansly-only v1, same-VPS subdomain — all stand; NEW: v1 is
desktop-browser-only; board UX shape deliberately OPEN (the PRD proposes
variants with mockups). Recorded as W1 in the new repo's log.

**Decision #120 (2026-07-10, owner):** AI gateway daily caps raised and the
quota denial made legible end-to-end. Trigger: on 2026-07-09 the lora-vip-of
chatter hit the 200-requests/day cap (23:27–23:50 UTC, 25 `quota_denied`
ledger rows; the desktop showed only the generic CG-HUB-02 card). (1) Default
daily caps per chatter/page UTC day: requests 200 → **500**, cost
$5 → **$10** (5M → 10M micro-USD). Both moved together deliberately — at the
observed ~$0.011/request, 500 requests ≈ $5.3 would have silently hit the old
cost cap ~470 requests in. Changed in the zod env defaults + config registry +
runtime constants; prod sets no env overrides, so the deploy carries them.
(2) SDK stream helpers (`streamAiFeature`/`streamAiGateway`) now classify
non-2xx openings via `categoryForStatus` instead of an auth/server/validation
ternary — a 429 reaches clients as `rate_limit` with the body's `quota_denied`
code (previously it surfaced as "validation"). (3) Desktop (0.1.31+): new
`HubFailureReason` 'quota' → new **CG-HUB-03** ("Daily AI generation limit
reached… resets at midnight UTC"); hub timeouts/connection drops in the AI
feature lane map to CG-NET-02/CG-NET-01 instead of CG-HUB-02; the CG-HUB-02
recovery text no longer promises "sync retries automatically" (false for
generation and for one-attempt outbox sends). Follow-ups noted, not done: the
Fansly extension shares the CG-HUB-02 blindness (own repo/session); kernel
product-gate 400s are still string-matched by the desktop (`mapKernelGateError`)
and deserve structured codes; the dock could pre-warn from the quota frame's
`remainingRequestsToday`.

*Same night, executing #120's follow-ups:* the kernel's four product gates
now throw `ProductGateError` with machine codes (`gate_min_messages`,
`gate_hi_greeting_limit`, `gate_ping_active`, `gate_draft_required`; messages
unchanged); desktop (9b1334a) and extension (fed6a84, bar-tone-menu) map those
codes structurally with the message match kept as a pre-#120 fallback; the
extension got its own quota card (`hub_quota_exceeded` / CG-HUB-09 — its
CG-HUB-03 was already taken by the legacy family); and the desktop dock
pre-warns from the meta quota frame (amber strip at ≤25 requests left,
`quotaRemainingRequests` on operation:complete). Deployed/released separately
per gate.

## Fast-Reply Freshness Wave 1 — Erasure Fence Semantics + Readthrough Reconcile (2026-07-10)

**Decision #121 (2026-07-10, owner):** the PR4 erasure non-resurrection fence
is **MATERIAL-TIME-BOUNDED**, not permanent. Retained `ofapi_webhook_events`
payloads and REST readthrough observations can recreate erased
`dm_message_archive` / `page_dm_messages` rows when a sweep replays them
after an erasure; every archive material writer (webhook, REST readthrough,
tombstone) and the page_dm projection writer now checks the executed-erasure
tombstones before writing, serialized against a running erasure through a
dedicated two-int advisory-lock namespace (writers take a shared try-lock
and DEFER on miss; erasure takes exclusive locks per resolved page id,
sorted, at the top of its delete transaction). The fence blocks only
material with `source_received_at` / `message_created_at` **at or before
the erasure's `started_at`** — erasure cleans the PAST; a still-active
erased fan's new messages are captured normally (DP-7 preserved). PERMANENT
fencing (erasure as a de-facto fan block) was considered and NOT chosen.
The predicate matches `dry_run = false` regardless of `completed_at`
(mid-flight-died runs stay fenced fail-closed); page/model scopes match by
the RESOLVED page ids stored in the plan jsonb (`plan.resolvedPageIds` —
`pages.label` is mutable, so a rename must not disarm the fence); fan
scopes match by immutable fan ref. Fence hits stamp the journal row
`skipped` / `erasure_fenced`; fenced readthrough items are dropped and the
observation still stamps (the backlog gauge must not latch over rows that
can never project). Recorded waivers: (1) the null-ref tombstone stub is
the DOCUMENTED CONTENTLESS SURVIVOR — delete webhooks carry no fan refs, so
a fan-scope fence cannot reach the stub; it survives with message id only
and the fence blocks any later hydration; (2) `ofapi_webhook_events.payload`
is not an erasure target anywhere (pre-existing; owner decision pending);
(3) the subscription/presence/spend projections replay the same retained
journal but are OUT of the Wave-1 fence scope (aggregate/status rows, not
fan transcripts) — owner-acknowledged.

*Same wave, an implementation choice worth recording:* the widened
readthrough capture (`ofapi_gateway_chat_messages_v2`, envelope with
chatId/conversationRef/cursors) is emitted only while
`OFAPI_DM_READTHROUGH_RECONCILE_ENABLED` is on; with the flag off the
capture keeps today's v1 shape. Capture-first is preserved either way (both
kinds journal the response verbatim); the gate keeps the
`obs_backlog_readthrough_v1` health floor honest — v2 rows only accumulate
while something consumes them, so the golden-signal latch never fires over
a lane that is deliberately dark, and a rollback stops v2 accumulation
instead of latching a permanent incident.

**Decision #122 (2026-07-10, owner):** the Wave-2 DM corrections program
ships as ONE staged boot flag `OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED`
(staged group #122) plus unflagged writer changes. Mechanism: every material
write to `dm_message_archive` computes `material_fingerprint` (sha256 over
material fields only; columns land in migration 0076), `material != emitted`
is the queryable repair signal, and a minutely reconciler drains it into the
ledger — FIRST events for REST/command-only rows that never reached
`domain_events`, SUPERSEDING events (same event type, new account_seq, dedup
key `msg:<dir>:<id>:<fingerprint>`, `supersedesEventId` + fingerprint in the
event DATA, `emitted_event_id` stamped back on the archive row) for rows
whose material advanced past what was emitted. HARD PRECONDITION, order
load-bearing: `corrections:backfill-fingerprints` runs to completion BEFORE
the flag flips — enabling against NULL fingerprints mass-appends redundant
superseding events for the entire history. Sends-as-facts ships ACTIVE (no
flag), engaged only on the direct-confirm path while
`ofapiDmColdArchiveEnabled` is on: confirmed sends write fill-grade
`source='command'` archive rows a later webhook upgrades, and the raced
direct-confirm/webhook seam ships fixed with it (a lost failure race no
longer journals a false `failed_*` fact). The Fansly 1970 repair
(`events:repair-fansly-1970`) is the FIRST superseding consumer — a one-shot
owner CLI campaign; rows it cannot resolve
(`missingObservation`/`missingItem`/`outOfRange`) stay 1970 BY DESIGN
(source facts unreachable; timestamps are never guessed). Rollback
semantics: flag off + restart stops the sweeps (fingerprint columns are
passive bookkeeping, re-enabling resumes from the repair signal); appended
superseding events and the 1970 repair are FACTS in the append-only ledger —
no rollback, "stop" means don't run further; migration 0076 is additive and
image-rollback compatible. Deploy ritual: image+0076 → backfill (dry-run →
real, review `drainOpen` bound) → flag #122 → 1970 campaign (size → dry-run
→ real), per `docs/runbooks/fastreply-freshness.md`.

**Decision #123 (2026-07-10, owner-authorized blanket, recorded by the
session):** W2.1 lineage intake for the corrections reconciler. The Wave-2
reconciler lineage-skipped 100% of the initial drain on prod: OFAPI webhook
observation intake only began ~2026-07-05 (#49), and `ofapi_webhook_events`
retains ~14 days (the Wave-2 spec's "36500d" assumption was wrong), so
17,172 pre-#49 archive rows had no observation to anchor first events to —
8,549 of them with no surviving journal payload at all. Resolution, in
order of honesty: (1) surviving journal rows (live table or the frozen
`ofapi_webhook_events_w2_lineage_snapshot`, 138,082 rows) are journaled
VERBATIM as webhook-source observations under the row's ORIGINAL
idempotency key — the reconciler's primary lookup resolves them unchanged;
(2) journal-less rows get an operator-source reconstruction observation
whose payload is the archive row's material head — the cold archive IS the
journal's durable copy by design, so this is late intake of a retained
fact, not fabrication; the reconciler gains a fallback lookup arm for the
operator lane. "Never fake lineage" stands: ids and timestamps are the
row's own, and rows resolving neither way stay skip-and-counted. The
intake kinds (`ofapi_webhook_lineage_backfill`,
`dm_archive_material_reconstruction`) are registered with NO canonicalize
family — events come from the reconciler under canonical dedup keys. Same
decision covers the two sweep repairs: the reconcile cursor persists
across runs (skipped rows retry once per full cycle instead of
head-blocking the signal — the 2026-07-10 starvation), and lineage skips
log ONE aggregated warn per sweep with a sample instead of a line per row
(500/min against the pre-#49 backlog). Ritual: `corrections:intake-lineage
--dry-run` → real → re-enable `OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED` →
watch the drain; the snapshot table stays until the drain completes and
its drop is a separate owner decision.

**Decision #124 (2026-07-10, W3.1 / B6+A35 — REVERSES the Stage-26 recorded
direct fallback):** Fansly egress fails CLOSED. Stage 26 recorded "a page
without a proxy egresses direct under egress key `direct`" as the address
policy and pinned it in `tests/egress-resolver.integration.test.ts`; on prod
that fallback was reachable silently — `resolveEgress` was dead code, the real
path (`resolveStoredPageContext` → `FanslyAdapter.getDispatcher(null)`)
returned the direct undici agent with no throw, no log, no incident
(`proxy_failed` only fires when `hasProxy`), and erasure purges
`egress_endpoints`, so an erased-but-syncing page burned the shared VPS IP —
model-ban class risk. New policy, enforced in three layers: (1)
`resolveStoredPageContext` refuses a proxyless Fansly page with a typed
`ProxyMissingError` (409 `proxy_missing`) AND opens a `proxy_missing`
notification incident (new kind, migration 0078) — the sync executor parks
the stream as `manual_action_required`/`proxy_missing` instead of
hot-retrying; (2) belt: `FanslyAdapter.getDispatcher` throws
`FanslyProxyMissingError` on a null proxy, so no code path can direct-dispatch
Fansly traffic; (3) `resolveEgress` refuses proxyless fansly-vendor page
scopes and the Stage-26 test pin is FLIPPED to expect-refusal. The incident
resolves on the next successful chunk or verification with a proxy present.
`setPageProxy` (the repair path) resolves with an explicit
`allowMissingProxy` escape hatch — it verifies through the NEW proxy, never
the stored null. OnlyFans pages are untouched (egress is vendor-side at
OFAPI; proxyless OF pages still resolve with egress key `direct`). A page
that loses its proxy now stops syncing LOUDLY — that stop is intended;
operational precondition (E2): assign proxies to any active proxyless Fansly
pages BEFORE deploying this, or their sync parks at the first chunk.

**Decision #125 (2026-07-10, W3.2 / A4+A23 — outbox queued-TTL semantics):**
queued-only OFAPI command rows expire to `cancelled` after a TTL. The sweep
re-enqueued queued rows forever with no age bound, and while execution was
disabled it returned early — rows parked invisibly (`command_settle` samples
only finished attempts) and fired hours late on re-enable: a stale DM to a
fan. The desktop's cancel route has zero product callers (A23), so nothing
client-side drains a parked queue. Semantics: at the TOP of every minutely
sweep — deliberately BEFORE the execution-disabled early return, because a
parked queue is the exact bug window — rows still `queued` with
`attempt_count = 0` and `created_at` older than the TTL are UPDATEd to
`cancelled` with `last_error_code = 'expired_queued_ttl'`. This reuses the
existing state (no migration, no contract change, no client re-vendor): the
desktop already renders `cancelled`, and it is already in
`RETRYABLE_SOURCE_STATES`, so an expired send stays chatter-retryable. Each
expiry is journaled via `recordCommandResultObservation` under
`cmd:<id>:cancelled` — the same idempotency key a client cancel would use, so
the two paths dedupe into one fact. Belt: `claimQueuedOfapiCommand` carries a
`created_at >= now - TTL` predicate, so an execute job racing the sweep can
never fire a stale send. TTL = 10 minutes (`QUEUED_COMMAND_TTL_MS`), pinned
to the desktop's `VERIFY_AUTO_STOP_AGE_MS`: the kernel must never execute a
queued row the desktop has already stopped watching (15 min would leave a
5-min blind execution window). Overridable live via the non-staged
`ofapiQueuedCommandTtlMs` registry row (env
`OFAPI_QUEUED_COMMAND_TTL_MS`, floor 60s), read per sweep — no restart, no
staged flag: the guard ships fail-closed deliberately. One-attempt law
untouched: only never-attempted rows expire; anything past claim stays the
one-attempt/indeterminate machinery's territory. Fail direction is closed —
worst case a legitimately-queued-but-stale send cancels and the chatter
retries; strictly better than an hours-late duplicate DM.

**Decision #126 (2026-07-10, user offboarding — deactivation tombstone, never
DELETE):** users (chatters, staff) are never hard-deleted; offboarding sets a
`users.disabled_at` tombstone (migration 0079), mirroring the Stage 13 pages
soft-delete standard. Hard delete is structurally impossible anyway
(`ofapi_commands.chatter_user_id` is RESTRICT) and undesirable: gateway spend,
audit events, and command attribution reference `users.id` and must survive
offboarding. `adminDeactivateUser` (owner-only) sets the tombstone and revokes
every credential — API keys, device tokens, sessions, reason
`user_deactivated` — in ONE transaction with the `user.deactivated` audit row.
Fail-closed belt: `getAuthenticatedUserById` returns null for a tombstoned
row, so all three authenticate paths (session, api-key, device-token) die at
the principal root even if a credential row somehow survived; login folds
disabled into the invalid-credentials branch (same 401 + dummy argon2 verify +
backoff — no enumeration oracle). A tombstoned user is frozen: password set,
key/device-token issuance, and page assignment all refuse with 400 until
`adminReactivateUser` clears the tombstone. Reactivation restores password
login ONLY — revoked keys/tokens stay revoked (issue fresh ones); the username
stays reserved (unique) while tombstoned, deliberately: recreating it would
silently inherit the old row's attribution history. Owners cannot be
deactivated, nor can the caller deactivate itself. Sibling change, same
motivation (honest admin surface): `adminListUsers` now carries
`lastActiveAt = max(api-key last_used, device-token last_used)` — the key-only
column showed "Never" for every #116 password+device-token chatter.

**Decision #128 (2026-07-11, B5 — recurring DB backups declined, risk accepted):**
The 2026-07-08 audit's B5 finding (decision #41 "nightly off-box Postgres backups +
restore drills" never implemented) was resolved by the owner as ACCEPTED RISK, not
implementation — same call as 2026-07-04, re-confirmed after the 2026-07-10 reboot
purged the only ad-hoc dump from /private/tmp. Consequence, stated plainly: loss of the
VPS (disk failure, provider incident, compromise) = permanent loss of ALL platform
history since the last manual dump, for a system whose own invariants promise 100-year
retention; Stage-28 tiering is on the same volume and provides zero protection. No
recurring cron/timer/provider-snapshot job exists on prod (verified 2026-07-11: root
crontab none, no backup timers/containers). The only restore point is a manual
`pg_dump -Fc` (latest: ~/backups/agency-hub/, 2026-07-11, 4.8 GB, taken from prod rev
ea9ac13). Owner may reverse this by implementing #41 at any time; until then B5 is
CLOSED as accepted-risk. Supersedes the "P1-if-absent" open state in the audit addendum.

**Decision #129 (2026-07-11, B7 — erasure completeness moot: erasures will not be executed):**
Owner ruling on the audit's B7 (erasure module misses sync_raw_payloads /
ofapi_webhook_events / ofapi_spend_projection_events + the W2.1 snapshot table) and the
pending #121 waiver: the agency does not intend to execute data-erasure requests at all
— "такого не будет никогда, мы не будем это исполнять". Verified prod fact 2026-07-11:
erasure_log has ZERO non-dry-run rows; the gap has never fired and stays latent. The
erasure module remains in the tree untouched (capture-first: nothing is deleted), but no
W6 remediation wave will be built; the three surviving stores are sanctioned as-is. If
this policy ever reverses (a real deletion request arrives), the fix recipe is preserved
in fix-plan-FINAL-2026-07-10.md §W6 (variant b) and MUST ship before executing that
request — an erasure run under today's module would falsely report completeness.
Resolves the #121 pending waiver. B7 CLOSED (policy), not fixed (code).

**Decision #130 (2026-07-11, W5 — observability truthfulness: per-signal latch,
wedge gauges, ops deadman, sweep cursor):** four related semantics changes from
the audit's B8/A25/A53/B3, one deploy (migration 0080). (1) Golden-signal
incidents split per metric — incident key `golden_signal_lag:global:<metric>`
(kind unchanged); a standing breach on one signal no longer masks or falsely
resolves the others; the legacy shared key is resolved once at the first
post-deploy sampler run. Absence semantics: a metric that emits NO sample this
run keeps its latch exactly as-is — the old code resolved the shared latch on
"no breaches", so a completely dead pipeline sent "✅ Resolved". (2) Always-emit
wedge gauges `capture_pending_age` (oldest unprocessed webhook, 10-min
threshold) and `command_queued_age` (oldest queued+unattempted command, 15-min
threshold — the W3.2 TTL sweep cancels at 10, so a breach means the sweep
itself is dead); a missing SSE smoke-checkpoint row latches as a failed probe
instead of disappearing. `acceptance_events_1h` rides along as a
threshold-free liveness gauge (D9). (3) New api-side ops watchdog
(`ops-watchdog.ts`, kinds `scheduler_silent`/`ops_sampler_silent`): pages when
the scheduler heartbeat or the sampler goes >3 min silent, 5-min boot grace
for deploy restarts — a dead scheduler used to stop ALL cron with zero pages.
(4) The canonicalize sweep resumes from a per-family in-memory cursor with
wrap-to-head (#123 semantics; CLI/replay runs bypass it), so a stuck cohort at
the scan head can no longer starve fresh observations; the 4000/min ceiling
stays (throughput bound, not a starvation trap). Ride-alongs: boot-override
read is now retry-3-then-RETHROW (A31 — a crash-looping container is visible,
a silently flags-off "healthy" api is not); sampler indexes per the Stage-0
EXPLAIN (BRIN on the append tables, partial btree on the bounded lookups);
metric-sample prune moved from every minute to hourly.

**Decision #131 (2026-07-11, W7.2 / A33 — tombstoned pages keep their revenue
history):** consciously revises the Stage-13 "active-only" reader choice FOR
HISTORICAL AGGREGATES. Every revenue surface (overview/model reports, finance
module series, Top Spenders scopes, Telegram digest) previously derived its
page set from active-only readers, so tombstoning a page silently dropped its
ENTIRE revenue history from every rollup while the facts stayed in
`transactions` — totals lied by the page's lifetime net. New split:
navigation/status surfaces stay on the active-only readers; revenue
attribution goes through `listRevenuePages` / `listRevenueModels` /
`findRevenueModel` / `listRevenueScopePages` (no status filter, status
exposed). Page-scoped detail routes still 404 on tombstones — retired pages
stay hidden as PAGES; only rollups keep their history. Contract: additive
optional `status` on `pageRevenueItemSchema` ('active'|'deleted') and
`modelRevenueItemSchema` ('active'|'retired' — retired = zero active pages);
dashboard badges render them. Growth reports deliberately stay active-only (a
tombstoned page's frozen follower counts are not current growth). Expected
visible effect at deploy: all-time totals jump UP by retired pages' lifetime
revenue — that jump IS the fix.

**Decision #132 (2026-07-11, W7.3+W7.4 / A21+B4+A47 — negation guards, sticky
suppression, pending settle-or-expire):** three writers mint negative money
rows (`<id>:reversal` from the webhook truth ingest and the REST backfill,
`<id>:chargeback` from the chargebacks reconcile) with per-suffix dedup and
no settled-original check — structurally double-countable (both flags are ON
in prod; Stage-0 census 2026-07-11: 0 double pairs, 9 orphan reversals
≈ −$114.95). Guards now run inside the existing per-page spend lock:
(Guard 1/B4) an active other-suffix twin ⇒ the new negative writes INACTIVE
as `superseded_duplicate_negation` (first negative wins; repair pin: the
:reversal is canonical, the :chargeback twin deactivates); (Guard 2/A21) no
active POSTED original under the base id ⇒ inactive as
`reversal_without_settled_original`; a late-arriving settled original
reactivates AT MOST ONE suppressed negative (earliest row) via the explicit
fixup — the ONLY reactivation path. (Guard 0, mandatory) `upsertTransaction`'s
conflict-set used to reset `is_active=true` on every re-upsert — any webhook
redelivery would resurrect a deactivated twin; the two guard reasons are now
STICKY through the conflict-set (`missing_from_sync_window` deliberately
stays re-activatable — re-appearance is its designed recovery). Repair CLI
`money:repair-negations` (dry-run first) deactivates the census anomalies and
rebuilds rollups. (W7.4/A47) OFAPI pending rows now settle-or-expire like the
Fansly anchor: daily 03:25 UTC `ofapi.pending.reconcile` (+ CLI
`ofapi:pending-reconcile`) rescans stale (>7d) pendings through the existing
credit-guarded REST backfill, then retires what a fresh scan of the window no
longer reports — displayed revenue stops carrying dead pendings (census: 156
stale rows, ≈$2,804 net). Migration 0081 (two enum values). Also in this
wave (W7.1/B1, forward-only): the Anthropic provider preserves the 5m/1h
cache-write breakdown from message_start when a usage delta lacks it — the
1h component was priced at the 5m rate (37.5% under-recorded); historical
rows are identifiable (`cache_write_tokens>0 AND cost_approximate=true`) and
stay unmutated (append-only ledger).

**Decision #133 (2026-07-11, W8 — stream-state visibility, canonicalizer
tail, E5 re-journal):** (1) A12/A20 kernel side: `pageTopSpenders` gains an
additive `source` block `{streamState: ramped|flag_off|not_allowlisted|
unsupported_platform, lastSyncedAt, consecutiveFailures}` — `builtAt:null/
entries:[]` was indistinguishable from "no spenders" for a non-ramped page.
The Stage 16 allowlist gate is EXTRACTED to `sync/fansly-stream-gate.ts` and
shared by the executor and the reporter (one function, no drift; empty CSV =
all pages allowed). `top_spenders`/`fan_earnings`/`purchase_history` join
`MONITORED_SYNC_STREAMS` (snapshot/CLI visibility) but stay OUT of block
health (BLOCK_TASKS / SYNC_DOMAIN_POLICY unchanged — a flag-gated stream must
not degrade block UX). Response-schema-only contract change; no client
re-vendor (W9 takes the field only if it ships the richer copy). (2) A48:
`subscriptions.renewed` joins the OFAPI webhook family (same notification
envelope as subscriptions.new → `subscription.renewed`), canonicalizer v2→3 —
the bump DELIBERATELY replays webhook history so pre-fix renewals backfill;
safe because W5.3's sweep cursor (#130) is live and dedup keys are stable.
(3) A49 REFUTED, fallback NOT enabled: the proposed workboard-recompute
fallback (message.* with null fanIdentityRef → conversationRef) required
Fansly conversationRef to be the thread partner; it is the messaging GROUP id
(`item.groupId` — a different id space; the groups payload carries
`partnerAccountId` separately). A fixture pin in canonicalize-sync-pull.test
documents the refutation; revisit only if that pin ever fails. (4) A43:
the fan_earnings walk now persists its cursor with purchase_history's
hold-back discipline — persisted cursor advances only past SUCCESSFUL fans, a
zero-success chunk leaves the checkpoint untouched, the mass-skip breaker
stays armed. (5) A46 (forward-only): `transaction.posted` event data gains
`amountUnit` — `"mills"` (Fansly) / `"dollars"` (OFAPI float) — on
NEWLY-emitted events only; pre-fix events are immutable facts, consumers
branch on platform where the field is absent. No sync-pull version bump (a
replay would only dedupe). (6) Partitions (A13 remainder): occurred_at clamps
at canonicalize time to [2024-01-01, now+2mo]; out-of-window values fall back
to observation.receivedAt (never a guessed boundary) with the raw value
preserved as `occurredAtRaw` in event data; migration 0082 adds
`domain_events_future`/`observations_future` FROM '2031-01-01' TO MAXVALUE —
named outside the tiering `_YYYY_MM` regex (0077 precedent) so they are
structurally undetachable, and monthly pre-creation stops before 2031 (the
shrinking lead pages the owner ahead of the hand-off). (7) A30+A32: the dead
`ONLYFANS_PUBLIC_PROFILE_*` flags and their boot-crash OR-invariant are
DELETED (zero callers — they could only crash boot, never enable anything;
the resolver module and its capture tables remain untouched);
`assertClearableKey` now also rejects `runtimeApply==='boot'` keys (the two
EDITABLE boot flags could bypass the staged ritual via generic DELETE); the
ConfigurationTab `config-<key>` anchor is keyed on `runtimeApply==='boot'`
(kills the duplicate ids on editable boot keys AND gives staged non-boot keys
an anchor). (8) E5/A22: one-shot CLI `observations:rejournal-collisions`
re-journals the ~40k pull observations swallowed by the pre-f8c4409
chunk-constant idempotency key (window 2026-07-05T01:50Z..07-07T18:00Z) —
verbatim from `sync_raw_payloads`, producer `rejournal:a22`, per-raw-row keys
(idempotent), append-only; the sweep consumes the rows and domain_event_keys
dedup makes re-canonicalization of already-seen facts a no-op. Dry-run first,
counts per stream.

**Decision #134 (2026-07-11, W10 / B10+A37+A51 — message-archive shadow
rebuild machinery):** the Stage-10 one-command rebuild (delete + event
replay) is retired as structurally lossy: the replay reads only ATTACHED
domain_events partitions (tiering detaches months >6mo; the watermark
advances past missing seqs silently) and the reset destroys legacy-seed rows
(`source_event_id IS NULL AND backfill_source IN
('dm_message_archive','hot_table')`) — for pruned hot originals those rows
are the ONLY copy. The build spec had already rejected in-place rebuild and
hash-equality-as-proof; the shipped replacement is a staged SHADOW build
(migration 0083, `message_archive_shadow`, same shape, distinct index
names). R0 `archive:rebuild-preflight`: per-account census — event-sourced
rows, legacy seeds by source, unrecoverable-if-dropped (the corrected query
INCLUDING dm_message_archive as an origin — the audit's version omitted it),
detached-partition census (pg_inherits vs tiered_pending_drop AND
detached-in-public 0077 leftovers). R1 (dispatched from `projection:rebuild
message_archive`, replacing the W1 unconditional throw, --account kept): per
account, ONE restartable transaction — legacy-seed LIFT first (verbatim
copy, provenance preserved; lift-before-replay reproduces the live table's
first-writer precedence exactly), then event replay from seq 0 behind a HARD
detached-partition gate (checked at start AND end of the transaction — a
tiering detach mid-build aborts instead of shipping a short replay), then
account-scoped backfill re-run; the existing writers were parameterized with
a two-value whitelisted target table. R2 `archive:rebuild-verify`:
set-difference proof (shadow ⊇ old on the archive key) + per-column material
comparison with bounded samples; NONZERO MISSING ROWS FAILS (exit 1) and the
switch re-checks the same condition inside its transaction. R3
`archive:rebuild-switch` (owner-gated, dry-run default, sweep worker paused
for the window — runbook `docs/runbooks/message-archive-rebuild.md`): one
transaction under the rebuild advisory lock — old → message_archive_retired_
<ts> (KEPT; capture-first — its drop is a separate owner decision), shadow →
message_archive, canonical index/constraint/sequence names follow the live
table, and the projection watermark is FORCE-reset (delete+reinsert — the
guarded upsert would keep a higher stale watermark and skip events) to the
shadow's replay high-seq. No erasure during a rebuild window (W6 ⟂ W10); E5
re-journal runs before any prod run. Ride-alongs: (A51) `text_plain` is now
derived through `normalizeDmMessageText` in the projection writer — the
event ledger stays verbatim, and the shadow replay heals pre-strip rows for
free (verify flags those diffs `healedHtml`); (A37)
`rebuildFanEarningsProjection`'s two autocommit deletes now run in one
transaction — a crash between them left an empty projection behind a stale
watermark, permanently and silently.

**Decision #135 (2026-07-11, A2a / dm_messages wedge — the 0026 upper bound
falls, the floor stays):** `page_dm_threads_stored_message_count_check`
becomes `>= 0` only (migration 0084). The 0026 cap (`BETWEEN 0 AND 1000`)
encoded retention POLICY as an integrity constraint, and Stage 1's prune
stand-down (`PAGE_DM_PRUNE_ENABLED=false`; hot DM history nondecreasing
until Stage 28) turned it into a time bomb: the moment an at-cap
conversation receives a new message, the finalize recount
(`finalizePageDmConversationMessageSync` writes COUNT(*) into the bounded
column) throws 23514 and the page's ENTIRE dm_messages stream wedges —
candidate selection re-pins the same conversation (stale-head priority 0)
every run. lora-1/lora-2 were down 2026-07-05..07-11 exactly this way
(310/265 failed runs; seven threads at the cap, two already at 1025 physical
rows via the paging-branch commits that land before the failing finalize).
NOT the trigger: Stage 17 backscroll and the cap-lift flag — the first
failure predates the Stage 17 commit by 8 hours; they only widen the blast
radius, which is why `fanslyDeepBackfillIgnoreRetentionLimit` goes OFF as
containment while this repair lands (its own gate and window, #70 ritual).
The upper bound does NOT come back as a number: it returns only WITH the
bounded-hot-cache protocol (durable PPV home first — `message_archive` has
no `purchased_at` and the AI union upgrades `is_opened` from the hot row;
then per-eviction archive coverage and atomic evict/recount/checkpoint),
because until pruning is a cache policy any DB ceiling re-arms the same
wedge. Counter repair for the two mismatched threads (1825, 13294712) is a
separate owner gate: pause those two dm_messages streams → lease drain →
row-locked recount → resume (no shared advisory-lock contract exists with
the executor — leases own that path; a repair racing a live finalize would
just lose its recount).

**Decision #136 (2026-07-11, AI features read the stored fan dossier —
kernel-side, fail-open, staged):** Every feature-lane prompt whose policy
says so now injects the latest `fan_profiles` body (the Scan dossier the
extension pushes via `upsertFanProfile`) — the kernel looks up its OWN
store; the INJECTION needs no wire-contract change, so the Fansly extension
and the desktop get the behavior without an SDK re-vendor. (The same-day
review fixes below did extend the upsert/profile contract with OPTIONAL
generatedAtMs/sourceGeneratedAt fields — non-strict schemas, compatible in
either deploy order.) New `FeaturePolicy.usesFanProfile`
gates it per feature: ON for fast-reply (compare inherits — its cards ride
the fast-reply feature), improve-draft, help-me, ping; OFF for fan-summary
(it GENERATES the dossier — feeding it back is circular), chat-review (must
judge the chatter independently of a stored opinion) and hi-greeting (a cold
opener must not show unexplained familiarity — revisit after observation).
Runtime rollout/rollback rides `chatMuseAiFanProfileContextFeatures`
("none" | "all" | CSV, live-wired like the union mode). DEFAULT IS "none":
a deploy alone never activates the feature — ramp with deliberate flips
`fast-reply` → `fast-reply,ping` → `all`; rollback is "none", no deploy. The lookup is STRICTLY fail-open (on the Fansly clientContext path
it is the generation's only fans-table read, so a fan_profiles hiccup must
degrade to "no section", never a failed Reply) and resolves the fan exactly
like the spend/name loaders (`fans` by platform + platform_user_id, R3-2),
plus a `deleted_detected_at IS NULL` guard; Fansly group chats
(conversationRef = groupId) get no dossier — accepted. The dossier is
COMPILED, not pasted (`context/fan-profile.ts`): parsed into the
fan-summary template's sections — production dossiers are RUSSIAN markdown
(`## N. ДОСЬЕ/ПОРТРЕТ/…`; the template says "Write in Russian" and the
dashboard's parseFanProfile pins the shape), so the matcher carries RU+EN
aliases plus stem matching on H1/H2 lines only (H3 subheadings and list
bullets never split). FINANCIAL PROFILE always dropped (fresh
spend/subscription data rides its own blocks); volatile sections (STAGE AND
TRAJECTORY, OPEN LOOPS, STRATEGY) dropped once the dossier is older than
`chatMuseAiFanProfileVolatileMaxAgeDays` (default 21 — stable facts age
well, stale open loops mislead); whole sections shed by keep-priority
against the 10k-char target; hard mid-text cut only at 20k; unrecognized
shapes get a bounded 10k head. Age is measured from the SOURCE generation
time: `fan_profiles.source_generated_at` (migration 0087; upsert contract
gains optional `generatedAtMs`, profile responses gain optional
`sourceGeneratedAt` — both non-strict-safe in either deploy order) with
`created_at` fallback for legacy rows — `created_at` alone is the hub
APPEND time, and a delayed client re-push must not zero the dossier's age. The prompt section ("## Fan Dossier", dated,
"the transcript is authoritative" framing, escaped `<fan_dossier>` body)
rides the dynamic 5m block after the subscription section — the 1h static
prefix stays fan-agnostic and no cache anchor moved, so live caches survive
the deploy. Second post-freeze template change after #127: fast-reply /
improve-draft / help-me / ping (+ templates.ts, builder.ts,
feature-policies.ts) re-pinned in prompt-manifest.json with this decision's
note; fan-summary.md untouched. Observability: debug-level "ai feature
dossier injected" (version/age/chars/truncated/droppedSections — never the
body), warn on lookup failure, and a `fanProfile` entry in
params.contextManifest on BOTH context paths (the Fansly clientContext lane
has no transcript manifest, but the dossier audit still lands). Same-day P1
hardening: the write-side dedupe/ordering is ATOMIC in the kernel —
appendFanProfile's advisory-locked transaction no-ops an identical body
(lost-ack re-push) and rejects a sourced write that is not newer than the
stored latest (client preflight GETs remain an optimization; legacy writes
without generatedAtMs keep append semantics); generatedAtMs is
contract-bounded to 2100-01-01 and future skew past 5 minutes clamps to
server "now" so a broken client clock can't pin volatile sections fresh.
**Decision #139 — RESERVED for the in-flight AUTH_POLICY_ENFORCEMENT ruling
(authored in the ai/ping-silence session, uncommitted at the time of this
write; renumbered twice: its original #135 was taken by A2a, and its #136
reservation was taken by the fan-dossier decision above before this merge
landed — #137/#138 are also taken below). If that session lands its entry
under a different number, this placeholder is released.**

**Decision #137 (2026-07-11, A2b / #135 follow-through — projection debt,
health truthfulness):** the two systemic gaps behind the #135 wedge close.
(1) A finalize/checkpoint failure in the Fansly dm_messages chunk no longer
fails the chunk: the message upsert commits in its own owned transaction,
the thread-summary recompute + checkpoint ride a second one, and when only
that second step fails (and it is NOT a PageSyncLeaseLostError — fencing
stays fatal, as do capture and message-upsert failures) the failure is
recorded as a `projection_debt` row (0085: kind + platform_account_id +
conversation_id + attempts, one live row per target via a partial unique
index, resolution = resolved_at, never deleted per DP 7), the cursor pin is
cleared, and the loop continues. A 5-minute sweep re-runs the recompute
(enforceRetention via the same isPageDmPruneAllowed gate the executor uses)
and resolves; conversations whose thread vanished resolve trivially.
(2) /health/sync stops lying: a stream in `retrying`/`scheduled` with
consecutive_failures >= 10 now pushes `${stream}:retry_wedged` and degrades
the page exactly like a failed stream (the #135 incident ran 251-270
consecutive failures while health said ok), and any page with unresolved
projection debt pushes `projection_debt`. New issue strings only — the
response schema is already z.array(z.string()), no contract regen. Known
residual, accepted: a conversation with open debt is re-selected first each
chunk and burns ~1 request per pass until the sweep repairs it — visible
via the issue + the projectionDebtRecorded chunk stat; skipping open-debt
conversations in candidate selection is a possible follow-up, deliberately
NOT taken now (the failure mode it would guard against is speculative, the
extra join is not).

**Decision #138 (2026-07-11, OF poison-chat wedge — per-conversation
circuit breaker):** OFAPI dm_messages gets chat-level fault isolation
(0086: page_dm_message_sync_health — failure_count, error_class,
next_retry_at = now + min(5min·2^(n-1), 6h), quarantine_until = now+6h from
the 4th failure; PK = conversation_id, cascades with the thread; rows clear
on a successful sync of the conversation, re-admission is implicit when the
windows lapse). Candidate selection LEFT JOINs the table and skips open
windows; the pinned-conversation path (which used to make the poison chat
the FIRST fetch of every run, forever — three successive poison chats on
one page, ~3350 attempts / ~35h of 60s aborts over 9 days, last_ok never
stamped) now checks the pin's health row and clears the pin, which also
unwedges the two wedged pages on deploy with no manual cursor surgery.
Error taxonomy is deliberately conservative — chat-isolatable is ONLY
status=null+abort/timeout (`vendor_opaque_timeout`) and a single 5xx
(`vendor_5xx`); 401/403 stay page-level (vendor contract has not proven a
chat-local 403), 429 stays with the page-level backoff, any other 4xx or
non-OFAPI error rethrows, and 3+ DISTINCT conversations failing
timeout/5xx in one run rethrows (vendor outage, not poison — no
mass-quarantine). A first-page timeout at the default limit probes limit 20
then 5 as SINGLE attempts (retries=0 plumbed through the client) before
recording the failure — a giant chat may survive a smaller vendor scrape
window; a probed-down limit sticks for that chat for the run. The
exhaustion stamp (last_ok) stays reachable and honest: skippedQuarantined
(counted at chunk END) and perChatFailures ride the run stats. Ride-along:
the dashboard ConfigurationTab gained a boolean live-flag editor (toggle +
the same costWarning confirm gate; the #135 containment flip had to be done
via psql because boolean live keys rendered an editable-looking chip with
no editor). The string live keys still have no editor — known, follow-up.

**Addendum to #137/#138 (2026-07-11, same-day live findings):** (1) #137's
retry_wedged check was scoped to retrying/scheduled — prod immediately
demonstrated the gap: a 425-streak dm_messages flipped to
pending/backfilling between failures and /health/sync went back to 200/ok.
The streak only resets on a real success, so the check now fires in every
state except paused (deliberate operator state) and failed (already
degrades via failedStreams). (2) #138's adaptive-probe result was
remembered only per-run: every new run re-paid up to 4x60s default-limit
timeouts before re-probing down (observed live: ~5-6 min per run for a
5-20 message page). Migration 0088 adds
page_dm_message_sync_health.preferred_page_limit — probe success records
the working limit, conversation starts seed from it, and
clearConversationSyncHealth preserves it (a giant chat's incremental head
fetches need the small limit too; the row is dropped only when nothing
sticky remains). (3) The probe-eligible first fetch (default limit, no page
stored this run) is now a SINGLE attempt: a 60s hang is the giant-chat
signature, fast transport blips rethrow into the executor's stream retry.
(4) 0087 was taken by the scan-dossier session's fan_profiles migration
while this one was in flight — the sticky-limit migration shipped as 0088;
#139 stays free for the dossier ruling.

**Second addendum to #137/#138 (2026-07-11, the streak is not the signal):**
the retry_wedged widening survived exactly one partial run in production —
`yieldPageSync` resets `consecutive_failures = 0` (and the last-error
fields) on EVERY partial yield, so the moment the breaker keeps a stream
moving, the page-level streak goes quiet while poison chats still sit in
backoff with `succeeded_at` NULL. Preserving the streak across yields would
be wrong the other way (the stream genuinely progresses). The durable
carrier is the breaker table itself: health now pushes
`dm_messages:coverage_degraded` for any page holding
`page_dm_message_sync_health` rows with `failure_count > 0` — those rows
clear only when THEIR conversation actually syncs. Consequence for
incident semantics: `succeeded_at` alone proves nothing while
`skippedQuarantined > 0` (the chunk legitimately returns satisfied once
every currently-eligible candidate is drained); full-coverage proof =
succeeded_at stamped AND zero failing breaker rows AND zero conversation
head/archive gaps. retry_wedged stays for streams with no breaker
(Fansly), where the streak still carries the wedge.
