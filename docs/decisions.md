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
- **C3 spend projection and forward-only apply (2026-06-19):** `OFAPI_SPEND_PROJECTION_SHADOW_ENABLED` gates a separate `ofapi_spend_projection_events` table. It writes comparison rows first: live-captured `transactions.new` becomes integer-mill pending/settled spend input, `messages.ppv.unlocked` is only an estimated purchase signal, and `tips.received` writes `projection_status='blocked'` with `tips_received_live_fixture_required` until a live verified fixture replaces the documented example. Rows are idempotent by domain key and back-project from retained journal rows via the minutely OFAPI sweep. `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED` is a second default-off staged flag (`requires: OFAPI_SPEND_PROJECTION_SHADOW_ENABLED`) that applies only missing `transactions.new` projection rows into the core `transactions` table, creates the fan/page membership, and rebuilds spender/revenue rollups from the affected date. It is forward-only: existing mismatched transaction rows are not overwritten, `messages.ppv.unlocked` remains estimated-only, `tips.received` remains blocked, and desktop sweep cadence is unchanged. Owner-only `GET /api/v1/admin/ofapi/spend/comparison` compares projection rows against current core `transactions` truth over a bounded window and classifies `matched`, `missing_in_core_truth`, page/fan/amount/state mismatches, `ppv_estimated`, `tips_blocked`, `blocked`, and `skipped` rows with sample deltas; comparison normalizes OFAPI `settled` to core `posted`. Production recheck at 2026-06-19 22:55 UTC showed api/worker running shadow+ingest enabled; over 30 days, `transactions.new` matched 11/11 (`302950` gross mills / `242350` net mills), all mismatch buckets were zero, and `messages.ppv.unlocked` remained estimated-only (`ppv_estimated=6`, `278000` gross mills). D6 stays blocked until PPV/tips policy is accepted and the desktop rollback-controlled rollout is explicitly approved.
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

**Production validation status:** implementation is pending deploy and owner-only validation. The
validation route must be `loravievip`/`loravie`; no third-party or paying-fan mark-read action is
allowed.

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
