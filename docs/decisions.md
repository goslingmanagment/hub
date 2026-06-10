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
- **Account→page mapping:** new nullable unique `pages.ofapi_account_id`. Owner-only admin flow (`GET/POST /api/v1/admin/ofapi/webhook`) registers the webhook at OFAPI with `account_scope: global` and a freshly generated signing secret (stored as an `encryptJson` envelope, same custody as the Telegram bot token; the previous secret is kept and accepted as a rotation grace window, since registration rotates remotely before persisting locally), then auto-maps OFAPI accounts to OnlyFans pages by unambiguous username match; everything else is reported back for manual resolution. Events for unmapped accounts are journaled but not fanned out.
- **Fanout `GET /api/v1/events/stream`:** chatter API-key auth only, frames filtered to the chatter's assigned pages. Frames are core's copy of the desktop `SyncEvent` union (`syncEventSchema` in contracts; `accountId` = OFAPI `acct_…` id) plus a `messageDeleted` extension. Live path: worker `pg_notify`s journal ids on commit; the API process holds one shared LISTEN connection that re-reads the journal from its delivery watermark after every (re)connect, so frames settled during LISTEN gaps still reach connected clients. Replay: `Last-Event-ID` header (or `lastEventId` query param) reads forward from the journal by `fanout_seq`; subscribe-before-replay buffering (deduped by the exact replayed id set) closes the gap between catch-up and live. Streams are capped at 15 minutes so key revocation and page reassignment take effect on reconnect, and slow consumers (>1 MB buffered) are dropped — clients resume via `Last-Event-ID`.
- **Journal-only events:** `transactions.new` is subscribed and journaled (future OF analytics enrichment) but not fanned out — the desktop has no frame for it and a chat-list hint would trigger credit-charged refetches.

**Also shipped with this change (ChatMuse pre-P4 prerequisites):** `PUT …/fans/{platformUserId}/profile` auto-creates the fan + page membership for OnlyFans pages instead of 404 (core's OnlyFans sync is transactions-only, so non-spenders were unwritable; reads and Fansly stay strict), and `POST /api/v1/ai-usage/batch` skips events with invalid `completedAt` per-event, reporting a new `invalidCount`, instead of failing the whole batch.

**Rationale:** Webhooks are ~100× cheaper than polling OFAPI (1 credit/100 events vs 1 credit per uncached call) and the desktop needs push for its P3 milestone. SSE (not websockets) per decision #25. Async processing via pg-boss keeps the receiver inside OFAPI's delivery timeout and reuses existing worker/retry/cron infrastructure; LISTEN/NOTIFY bridges worker→API across the two-container deployment without new infrastructure.
