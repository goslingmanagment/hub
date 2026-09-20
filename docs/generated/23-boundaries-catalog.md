> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 370, 2026-09-15):** the API-key lane no longer exists. The
> `apiKey` contract kind keeps its historical NAME but admits only a device
> token; `authMethod` is `session | device_token`; the `api_keys` routes,
> service, repository functions and CLI group are gone, as are the cookie
> issuance routes and the HTTP create-user/set-password. A bearer matching no
> lane prefix is refused with no lookup. `must_change_password` is retired (no
> gate, no 403 `password_change_required`, `mustChangePassword` a deprecated
> wire constant `false`) and `content_manager` left the wire role enum. The
> `api_keys` table, the column and the PG enum value all stay as facts.

# Boundaries Catalog

This catalog joins the repository's network, process, storage, generated-code,
and operator boundaries. It describes what the code at this commit exposes or
calls; behavior of client repositories is outside this source tree.

## Inbound HTTP and browser boundaries

The committed OpenAPI document at
`reference/agency-hub.openapi.json` contains 144 paths and 160 operations.
`packages/contracts/src/routes.ts` supplies each operation's Zod request and
response schemas plus one declarative authorization policy.

| Caller or surface | Entry points | Boundary behavior |
|---|---|---|
| Dashboard browser | static SPA plus JSON API | Runtime serves the built dashboard same-origin. The SDK uses a cookie session; owner-only pages have an additional client route guard and server authorization. |
| Human API sessions | `/api/v1/auth/*`, catalog, reporting, admin routes | Login sets the session cookie. Route policy distinguishes dashboard sessions, any human session, and owner sessions; page-scoped policies resolve and authorize the page before the handler. |
| Bearer clients | capture, AI, OFAPI custody, event and data routes | The `apiKey` contract kind accepts a user API key or active device token. The principal retains user identity and assigned-page scope. |
| Device-token custody | device reservation, activation, current-token revocation, owner administration | Pending tokens authenticate only activation. Active tokens have their own self-revocation lane. Owners can bind one harvest machine ID to a device token. |
| Monitoring | `/api/v1/health`, `/api/v1/health/sync`, `/api/v1/ops/metrics` | Basic health is public. Sync health and metrics accept the monitoring token or an eligible dashboard session. |
| API documentation | `/documentation`, `/api/v1/openapi.json` | Swagger UI and the normalized OpenAPI document are owner-session surfaces. |

`apps/runtime/src/api/server.ts` applies the route-policy middleware and
registers the identity, AI, ingest, catalog, finance, audience, conversations,
events, and operations modules.

### Client capture and lifecycle

`POST /api/v1/ingest/observations` is bearer-only, rate-limited, capped at one
MiB, and requires `x-client-version`. The normal client-capture lane accepts an
API key or device token. A client version recognized as the Desktop harvest
lane additionally requires an active device token with the matching
owner-granted harvest machine capability; the authorized machine ID is passed
into event validation.

`apps/runtime/src/services/public-capabilities.ts` currently advertises
`desktop-lifecycle-v2`. Health responses expose that capability and the kernel
contract hash. `apps/runtime/src/startup.ts` also has image-interrogation modes
used by deployment to print capabilities, print signed-off lifecycle evidence,
and verify the bound production token inventory.

### Webhook and streaming entry points

`POST /api/v1/ofapi/webhook` receives OnlyFans API provider deliveries. It uses
the repository's raw-buffer JSON parser, verifies HMAC-SHA256 over the exact
body, validates the envelope after signature verification, and deduplicates by
the provider idempotency key. The handler journals the delivery before its
best-effort pg-boss enqueue; a journal failure remains a retryable server
failure.

The event module exposes legacy page-filtered sync SSE and v2 canonical-domain
SSE, each with a snapshot endpoint for cold start or replay-gap recovery. V1 is
bearer-only and uses its journal sequence. V2 accepts authenticated cookie or
bearer principals and uses an opaque cursor bound to the granted account set.

The AI module exposes a raw gateway stream and named feature execution. Both
use the core gateway, quota reservation, provider selection, terminal usage
accounting, and restricted prompt/response capture described in
`docs/generated/12-ai-gateway-and-prompts.md`.

### OnlyFans API custody lanes

`GET /api/v1/ofapi/read/*` forwards only allowlisted read requests through the
selected page's egress and captures successful responses. The OFAPI command
routes persist supported write commands as an outbox before worker execution;
the API also exposes lookup and cancellation of those commands. These routes
are bearer and page-grant scoped.

## Outbound network boundaries

| Counterpart | Code anchors | Data and transport |
|---|---|---|
| Fansly REST | `packages/fansly/src/adapter.ts`, `apps/runtime/src/services/page-context.ts` | Stored Fansly session headers, page-scoped proxy dispatcher, paginated account/audience/transaction/earnings/DM reads, and observed retry metadata. Default base URL is `https://apiv3.fansly.com/api/v1`. |
| OnlyFans API provider | `apps/runtime/src/services/ofapi.ts`, `apps/runtime/src/services/ofapi-egress.ts` | Bearer-key management and account APIs, webhook registration, read gateway calls, sync reads, and queued command writes through page egress. Default base URL is `https://app.onlyfansapi.com/api`. |
| OnlyFans public site | `apps/runtime/src/services/onlyfans-public-profiles.ts` | Headless Playwright opens `onlyfans.com` through the page proxy and observes the public profile API response used to resolve fan metadata. |
| Anthropic | `apps/runtime/src/services/ai-gateway-anthropic-provider.ts` | Streaming Messages API generations through the resolved page proxy. |
| OpenRouter | `apps/runtime/src/services/ai-gateway-openrouter-provider.ts` | Streaming chat-completion requests to `https://openrouter.ai/api/v1/chat/completions` for `openrouter:` models. |
| Telegram Bot API | `apps/runtime/src/services/telegram.ts`, `apps/runtime/src/services/telegram-report.ts` | Chat discovery, test and incident text messages, and daily report image/text delivery; the database bot token is encrypted and an optional proxy can supply egress. |
| ipify | `apps/runtime/src/cli.ts` | Operator proxy diagnostics query `https://api.ipify.org` through an explicit dispatcher. |

Platform request transport is resolved from page context through
`apps/runtime/src/services/egress/resolver.ts` and the platform adapters. Shared
dispatchers and redaction live in `packages/shared/src/http-client.ts` and
`packages/shared/src/proxy.ts`.

## Storage, queue, and filesystem boundaries

| Boundary | Consumers | Stored state |
|---|---|---|
| Postgres | API, worker, scheduler, CLI | Catalog and credentials, capture journal, canonical events, projections, financial ledger, auth, configuration, audits, incidents, erasure logs, and runtime heartbeats. Database access is split between Drizzle repositories and explicit SQL where partitioning, locks, or operational queries require it. |
| pg-boss schemas in Postgres | API enqueue, scheduler registration, worker consumption | Sync, projection, OFAPI, reporting, retention, and operations jobs plus schedules and archival tables. |
| On-box lake | tiering, erasure, restore drill | Parquet and JSON manifests for detached `observations` and `domain_events` partitions under `LAKE_DIR`, with a separate restricted subtree. |
| Runtime filesystem | API image and health checks | Dashboard build assets are served by the API. Worker and scheduler write heartbeat files whose freshness is checked by Compose. |

The API, scheduler, and worker are separate runtime roles sharing Postgres.
Scheduler leadership uses a session advisory lock; singleton and lease rules in
the repositories and pg-boss coordinate work across processes.

## Generated and cross-repository contract boundary

`pnpm contracts:generate` boots the registered API without a live database and
regenerates four coupled products from the same route registry:

- `reference/agency-hub.openapi.json`;
- `packages/contracts/src/contract-hash.ts`;
- the generated client under `packages/sdk`;
- `docs/generated/authorization-policy.md`.

The generated SDK performs typed requests and runtime response validation.
`KERNEL_CONTRACT_HASH` is the SHA-256 of the normalized OpenAPI JSON and is also
returned in runtime health. `packages/sdk/README.md` declares git-tag
distribution for out-of-workspace consumers; this repository does not contain
or verify those consumers' installed versions.

The production deployment boundary in `scripts/deploy-production.sh` uses SSH,
Docker images, Compose release files, schema snapshots, and external Desktop
and Extension receipts. Candidate capability interrogation and exact evidence
checks occur before image promotion; post-deploy health confirms the promoted
capability.

## Boundary-wide representations

- Platform money crosses JSON contracts as integer mills; AI cost uses integer
  micro-USD. Conversion is centralized in `packages/shared/src/money.ts`.
- Vendor and client facts enter the capture journal before derived projections
  consume them; provider-specific canonicalization runs after capture.
- Page grants accompany authenticated principals and are rechecked by
  page-scoped middleware or handlers when page identity comes from a query or
  request body.
- Stored vendor credentials and Telegram secrets are encrypted at rest; API
  responses expose masked or derived forms rather than the stored plaintext.
- Prompt and response bodies use restricted capture tables rather than the
  general observation lake.
