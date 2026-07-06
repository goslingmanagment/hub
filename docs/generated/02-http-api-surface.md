> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# HTTP API Surface

The kernel exposes exactly one Fastify HTTP server, built by
`buildApiServer(appContext)` in `apps/runtime/src/api/server.ts` (511 lines) and
run only by the `api` role. Since the kernel migration the server file is a thin
composition shell: it registers plugins, one declarative authorization
middleware, an error handler, and then delegates all route bodies to ten
bounded-context modules under `apps/runtime/src/modules/*`. The route schemas and
their auth declarations live in `packages/contracts` (see
`03-contracts-and-codegen.md`); this document maps the server shell, the
per-request auth pipeline, and the module route surface. The same server also
serves the dashboard SPA same-origin.

## 1. Server construction (`buildApiServer`, `server.ts:148-511`)

- **Fastify init** (`server.ts:149-152`): `loggerInstance` from the AppContext,
  `trustProxy` from config, `.withTypeProvider<ZodTypeProvider>()`. Zod
  validator/serializer compilers are set (`:154-155`); `auth` and `authPolicy`
  request decorators declared (`:156-157`).
- **Plugins**: `@fastify/cookie` (`:170`); `@fastify/rate-limit`
  (`:171-178`, `global:false`, custom 429 body `{error:"rate_limit_exceeded",
  message:"Too many login attempts", statusCode:429}`); `@fastify/swagger`
  (`:179-228`, OpenAPI 3.1.0, "Agency Hub Core API" v2.0.0);
  `@fastify/swagger-ui` at `/documentation`, owner-gated via
  `uiHooks.onRequest: requireOpenApiDocsOwner` (`:247-252`); `@fastify/static`
  (dynamic import) for the SPA (`:498-508`). No `@fastify/cors` is registered —
  the dashboard is served same-origin.
- **Security schemes** (`server.ts:188-204`): `cookieAuth` (apiKey in cookie,
  name `SESSION_COOKIE_NAME`), `bearerAuth` (http bearer), `monitoringTokenAuth`
  (apiKey header `x-monitoring-token`).
- **Swagger transform** (`server.ts:207-227`): strips the declarative `auth`
  block from each schema and DERIVES the operation `security` from it via
  `routeSecurityFromAuth`, so the published document cannot disagree with what
  the middleware enforces.
- **Client-version hook** (`server.ts:162-168`): an `onRequest` hook records the
  desktop's `x-client-version` header via `recordClientVersionObservation`
  (fleet-verify telemetry; tracks and logs, never enforces — see
  `01-runtime-and-processes.md`).
- **pg-boss (enqueue-only)** (`server.ts:367-388`): created only when
  `config.databaseUrl` is set, with `schedule: false` (the api never fires cron —
  Stage 25 moved that to the scheduler role) and an error handler that logs only
  (a transient Postgres blip must not take the api down); it ensures the sync,
  OFAPI-event, and OFAPI-command queues. Skipped entirely during contract
  generation (no DB).
- **Error handler** (`server.ts:397-450`): Zod validation error → 400
  `{error:"Bad Request"}`; response-serialization error → 500 "Response
  validation failed"; `AppError` subclass → `{statusCode, error:code, message}`;
  fastify-shaped `{statusCode,error,message}` passthrough; fallback 500
  `{error:"internal_error"}`.
- **SPA static serving** (`server.ts:498-508`): `resolveDashboardDistPath()`
  walks ancestor dirs of cwd and the module for `apps/dashboard/dist/index.html`
  (`:98-114`); registered `prefix:"/", wildcard:false` with a
  `setNotFoundHandler` SPA fallback — any non-`/api/` non-`/documentation` URL
  returns `index.html`, else a 404 JSON (see `20-dashboard-frontend.md`).

## 2. Declarative route authorization (kernel Stage 19)

One middleware computes one verdict per request from the route schema's `auth`
declaration before any handler runs (`server.ts:254-338`):

- `buildRoutePolicyIndex()` keys the contract `routeSchemas` by schema-object
  identity (`api/auth-policy.ts`). An `onRoute` hook collects a
  `routePolicyTable` (method/url/routeKey/auth) at registration — the same table
  the SDK generator and the authorization-policy document consume
  (`server.ts:270-282`).
- The `onRequest` hook (`server.ts:284-338`) looks up the route's declaration;
  a route with no declaration logs an error and, in enforce mode, is refused
  (the contracts CI gate makes this unreachable — fail-closed if it drifts). It
  calls `computeAuthPolicyVerdict` (`api/auth-policy.ts:76-134`) with resolvers
  for the principal, the monitoring token, and page access.
- **Enforcement mode** is `config.authPolicyEnforcement` (`log` | `enforce`,
  `server.ts:263`). In `enforce`, a denying verdict throws
  `UnauthorizedError`/`NotFoundError`/`ForbiddenError` by status code. In `log`,
  the `onResponse` hook (`server.ts:340-362`) compares the verdict against the
  actual reply status via `classifyAuthPolicyDivergence` and logs `would-deny` /
  `would-allow` where the middleware diverges from the legacy in-handler guards
  (which remain in place until a post-flip cleanup).
- **must_change_password** (`server.ts:315-326`): a `session` principal flagged
  `mustChangePassword` may only touch `{me, logout, authChangePassword}`, enforced
  UNCONDITIONALLY (new behavior, no legacy guard to diverge from).

Auth `kind` semantics, roles, and page scope are documented in
`03-contracts-and-codegen.md` and `15-auth-config-and-access.md`; the rendered
per-route table is `docs/generated/authorization-policy.md` (owned by
`contracts:generate`, not by this regeneration).

## 3. Module registration and the route surface

The server registers ten modules in order (`server.ts:452-485`), each a
`register<Name>Routes(server, moduleContext)` where `moduleContext =
{appContext, auth: requestAuth, boss}` (`modules/context.ts:30-35`,
`server.ts:391-395`). `routeSchemas` holds ~150 named operations across the two
prefixes `/api/v1` (bulk) and `/api/v2` (spenders + fans-search); the full,
line-anchored per-route detail lives in each module's territory doc.

| Module (`apps/runtime/src/modules/`) | Boundary it serves | Territory doc |
|---|---|---|
| `ops` (~1,209 lines) | health, OFAPI credits summary/daily/ledger.csv/spend-comparison/dm-archive, sync runs/trigger/blocks, admin logs/queue/db-stats/incidents, config live-PATCH + staged-flip, notifications dashboard | `17-ops-observability.md`, `15`, `09` |
| `identity` | auth/login/logout/me, user CRUD, page assign/unassign, API keys, device tokens, self-serve password change, model grants | `15-auth-config-and-access.md` |
| `ai` + `aiAdmin` | `POST /ai/gateway/stream`, `POST /ai/features/:feature`, `POST /ai-usage/batch`, owner-only restricted generations + persona CRUD | `12-ai-gateway-and-prompts.md` |
| `ingest` (awaited) | `POST /ingest/observations`, `POST /ofapi/webhook` (raw-buffer/HMAC), OFAPI read gateway + command outbox | `06-capture-and-canonicalization.md`, `09` |
| `catalog` | models/pages/credentials/proxies/onboarding | `08-platform-adapters-and-egress.md` |
| `finance` | overview/model/page revenue, transactions, spender auto-lists, `/api/v2/spenders`, per-fan/cross-page transaction walks | `13-financial-and-money.md` |
| `audience` | fans/subscribers/followers/growth, per-page top-spenders (fan_earnings snapshot), fan notes/flags, `/api/v2/fans/search` | `13`, `10` |
| `conversations` | fan profiles/versions, DM thread previews/messages, cold archive reads | `10-ofapi-projections.md`, `06` |
| `workboard` | v2 board read/lists/contact/recompute/snooze/claim, closing-classifier admin | `14-workboard.md` |
| `events` | `GET /events/stream` + `/events/snapshot` (v1 SSE), `GET /events/v2/stream` + `/events/v2/snapshot` (v2 SSE) | `11-events-and-streaming.md` |

`server.ts` itself keeps only the owner-gated `GET /api/v1/openapi.json`
(`:488-493`) and the SPA fallback outside the modules.

## 4. Boundaries visible at this surface

- **Inbound HTTP/JSON** from the dashboard (cookie session), and the desktop
  app / extension (bearer API-key or device-token), Zod-validated per route.
- **Inbound HMAC webhook** at `POST /api/v1/ofapi/webhook` (raw-buffer body,
  auth kind `hmac`; `09-ofapi-boundary.md`).
- **Inbound monitoring** at the health/sync endpoints (auth kind `monitoring`:
  `x-monitoring-token` OR a dashboard session).
- **Outbound SSE streams**: the v1 sync stream, v2 domain-event stream, and the
  AI-gateway stream (each a dedicated stream helper, excluded from the plain SDK
  method surface; `11-events-and-streaming.md`, `12-ai-gateway-and-prompts.md`).
- **Same-origin SPA delivery** of `apps/dashboard/dist`.

The consolidated cross-project boundary catalog is `23-boundaries-catalog.md`.
