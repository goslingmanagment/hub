> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Boundaries Catalog

`core` is the privileged center of a three-project ecosystem; the desktop app
and Firefox extension are thin clients that talk only to `core`'s HTTP/SSE
surface, and `core` is the sole party that contacts the platforms and vendors.
This document consolidates every boundary `core` has with the outside world,
described from `core`'s side — what it exposes and for whom, what it calls, what
data crosses, and where each is documented in full. It is the stitching map for
the reviewer joining the three projects. Auth kinds referenced here are the
declarative `RouteAuthPolicy` kinds (`03-contracts-and-codegen.md`).

## 1. Inbound HTTP/SSE (things call `core`)

| Boundary | Counterpart | Auth | What crosses | Doc |
|---|---|---|---|---|
| Fastify JSON API `/api/v1` + `/api/v2` (~150 operations) | Dashboard (cookie session); desktop app + extension (bearer API-key / device-token) | `session`/`owner-session`/`any-session` (cookie), `apiKey` (bearer), `any`, `public` | Zod-validated JSON per route; money as integer mills on the wire | `02`, `03`, `15` |
| `POST /api/v1/ofapi/webhook` | onlyfansapi.com (OFAPI) | `hmac` (HMAC-SHA256 over the raw body, current+previous secret) | Raw-buffer event envelope `{event, account_id?, payload}`; idempotency key header; journaled verbatim to `observations` + `ofapi_webhook_events` | `09`, `06` |
| `POST /api/v1/ingest/observations` | desktop app / desktop-harvest | `apiKey` (bearer), `x-client-version` required | Client-captured business facts (ai_acceptance, guard/send audits, ai_spend, credit_spend, harvest.*) journaled verbatim | `06` |
| `GET /api/v1/ofapi/read/*` | desktop app (OnlyFans read proxy) | `apiKey` | Allowlisted OnlyFans read requests, single-attempt proxied through the page's egress; 2xx bodies captured as `readthrough` observations | `09` |
| `POST /api/v1/ofapi/commands` (+ get/cancel) | desktop app (OnlyFans write outbox) | `apiKey` | Command envelopes (send text/media, typing, unsend, mark-read); idempotent enqueue → single-attempt executor | `09` |
| `GET /api/v1/events/stream` + `/events/snapshot` (v1 SSE) | desktop app | `apiKey` | `event: sync` frames filtered to the caller's pages; `fanout_seq` resume; 409 snapshot path | `11`, `10` |
| `GET /api/v1/events/v2/stream` + `/events/v2/snapshot` (v2 SSE) | desktop app / extension | `apiKey` or cookie | `event: domain`/`ephemeral` frames per-account; opaque per-account cursor id; 409 v2 snapshot path | `11` |
| `POST /api/v1/ai/gateway/stream`, `POST /api/v1/ai/features/:feature` (SSE) | desktop app / extension | `apiKey` | Generation request (raw prompt blocks or feature refs) → `event: ai` frames; terminal usage row + verbatim capture | `12` |
| `POST /api/v1/ai-usage/batch` | desktop app (legacy ledger intake) | `apiKey` | AI usage events for the ledger | `12` |
| Health/monitoring: `GET /api/v1/health`, `/api/v1/health/sync` | deploy script, monitors | `public` / `monitoring` (`x-monitoring-token` OR session) | Liveness + per-page sync health | `01`, `17`, `21` |
| Owner console: `/documentation`, `GET /api/v1/openapi.json` | owner | `owner-session` | Swagger UI + OpenAPI JSON | `02`, `03` |
| SPA delivery `/` (+ SPA fallback) | dashboard browser | `public` static | `apps/dashboard/dist` served same-origin so the cookie flows without CORS | `20`, `02` |

## 2. Outbound (things `core` calls)

| Boundary | Direction | Counterpart | What crosses | Doc |
|---|---|---|---|---|
| Fansly REST | outbound reads | `https://apiv3.fansly.com/api/v1` | Account/subscribers/followers/transactions/earnings/messaging; pasted session auth; per-page proxy egress (never direct-IP by contract) | `08`, `07` |
| OFAPI REST | outbound reads + command writes + webhook CRUD | `https://app.onlyfansapi.com/api` | `Bearer` key; chats/messages/fans/transactions/chargebacks reads (credit-metered), message-send/typing/unsend/mark-read writes, webhook registration | `09` |
| OnlyFans.com public profile | outbound scrape | `https://onlyfans.com` | Headless Playwright/chromium through the page proxy, capturing the `/api2/v2/users/u<id>` XHR to resolve fan id → username/displayName (unauthenticated) | `10` |
| Anthropic Messages API | outbound stream | `api.anthropic.com` | AI generations, egressed through the page's proxy; `@anthropic-ai/sdk` (only importer is the gateway provider) | `12` |
| OpenRouter API | outbound stream | `https://openrouter.ai/api/v1/chat/completions` | AI generations for `openrouter:`-prefixed models; raw fetch through the shared proxy dispatcher | `12` |
| Telegram Bot API | outbound only | `api.telegram.org/bot<token>/<method>` | Daily revenue report (PNG + text) and incident alerts; bot token encrypted at rest, DB-over-env; optional proxy egress | `16` |
| ipify / proxy exit-IP checks | outbound | `api.ipify.org` (through proxy) | Proxy validation / exit-IP comparison | `08` |

All platform-bound egress resolves per-page through the Stage 26 egress resolver
(`08-platform-adapters-and-egress.md`); a raw `fetch(` to a platform outside the
resolver fails the raw-fetch ratchet (budget 13). `platform ===` branching
outside the adapter packages is budgeted (49).

## 3. Storage & queue (the boundary everything crosses)

| Boundary | Kind | What crosses | Doc |
|---|---|---|---|
| Postgres (node-postgres `Pool` + Drizzle) | storage | 77 tables / 23 enums; the capture spine (`observations`→`domain_events`) + projections + money truth; monthly RANGE partitioning; all `bigint` columns returned as JS `BigInt` | `04`, `05` |
| pg-boss (same database) | job queue | Sync/OFAPI/workboard/tiering/telegram jobs + all cron (enqueued by api/cli, consumed by worker, cron owned by scheduler) | `01` |
| On-box lake (DuckDB / Parquet) | cold storage | Tiered aged partitions of `observations`/`domain_events` (export→verify→detach); erasure filter-out rewrites | `18` |

## 4. Cross-repo contract boundary

The desktop app, extension, and dashboard consume the kernel through the
generated `@kernel/sdk` — in-workspace for the dashboard, and a compiled vendored
bundle for the out-of-workspace clients. The contract is pinned by
`KERNEL_CONTRACT_HASH` (sha256 over the normalized OpenAPI document); a client's
pinned hash mismatching core@main is a contract-drift build failure. The
human-readable projections of the same registry are
`reference/agency-hub.openapi.json` and `docs/generated/authorization-policy.md`
(`03-contracts-and-codegen.md`). Two prose contracts govern the most
load-bearing client boundaries: the AI gateway (`docs/ai-gateway-contract.md`,
noted stale relative to Stages 29–32 in `12`) and the OFAPI command outbox
(`docs/ofapi-command-outbox-contract.md`).

## 5. Boundary invariants that hold across the ecosystem

- Clients hold **no vendor keys, assemble no prompts, compute no money** —
  every privileged act crosses into `core` (`00`).
- Capture-first (DP 7): inbound business facts are journaled verbatim before any
  parsing; nothing that captured a fact is deleted on a schedule
  (`06`, `18`).
- Outbox discipline: OnlyFans message writes are single-attempt, fail-closed,
  never auto-retried on an indeterminate send (`09`).
- Egress-through-the-resolver: every platform-bound request resolves its
  proxy/egress per page; Fansly must be page-proxied (`08`).
- One money codec: mills (platform) and micro-USD (AI) never mix without an
  explicit converter (`13`, `19`).
