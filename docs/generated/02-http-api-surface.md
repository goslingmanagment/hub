> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 349, 2026-09-15):** the identity module gained thirteen
> routes — `adminCreateInvite`, `adminCreateAccountLink`,
> `adminListAccountLinks`, `adminRevokeAccountLink`, `adminRevokeDeviceToken`,
> `adminTerminateAllAccess` (owner-session); `authInspectAccountLink`,
> `authRedeemAccountLink`, `authIssueDeviceTokenWithPassword` (public, per-IP
> rate limits 30/10/20 per minute); `authListDevices`, `authRevokeDevice`,
> `authRevokeAllDevices`, `authMyUsage` (any-session). The error boundary now
> serializes a structured `reason` on 401 `unauthorized` and 409 `conflict`,
> and the global 429 message is the neutral "Too many attempts".

> **STALE (Decision 354, 2026-09-15):** user administration now addresses immutable
> IDs through `/admin/users/by-id/:userId`, SDK 0.3 retires username routes,
> migration 0201 adds permanent account deletion and partial login uniqueness,
> and Team state/cache ownership follows IDs. See Decision 354 and
> `docs/runbooks/user-account-deletion.md`; the body predates this change.

# HTTP API surface

The `api` role exposes one Fastify 5 server built by
`apps/runtime/src/api/server.ts`. `packages/contracts/src/routes.ts` is the
schema/auth source; the server composes plugins, one authorization middleware,
ten domain modules, OpenAPI, SSE routes and the dashboard SPA.

## Server shell

`buildApiServer(appContext)` configures:

- Zod request validation and response serialization through
  `fastify-type-provider-zod`;
- cookies, route-local rate limiting, OpenAPI 3.1 and an owner-only Swagger UI
  at `/documentation`;
- `cookieAuth`, bearer and `x-monitoring-token` OpenAPI schemes;
- an `x-client-version` observation hook used for fleet evidence;
- an enqueue-only pg-boss client (`schedule:false`) when a real database URL is
  present; contract generation supplies an empty URL and does not touch DB;
- same-origin static serving from `apps/dashboard/dist`, with an SPA fallback
  that does not swallow `/api/*` or `/documentation` 404s.

The API starts sync, OFAPI-event and OFAPI-command queues only for enqueueing.
Its pg-boss error listener logs rather than terminating the HTTP process.

## Declarative authorization

Every one of the 160 generated operations carries an `auth` declaration.
`buildRoutePolicyIndex()` maps schema-object identity to route key; an `onRoute`
hook records method/path/auth rows, and one `onRequest` hook computes the
verdict before handler execution.

Current auth kinds are:

| Kind | Principal boundary |
|---|---|
| `public` | no principal; health and login/logout-class routes |
| `hmac` | raw-body OFAPI webhook signature, verified by the handler |
| `monitoring` | monitoring token or dashboard session |
| `session` | owner/team-lead cookie session |
| `any-session` | any live human cookie session |
| `owner-session` | owner cookie session |
| `apiKey` | bearer API key or activated device token |
| `device-token` | activated device-token bearer only |
| `pending-device-token` | short-lived enrollment credential, activation only |
| `any` | any authenticated cookie or bearer principal |

`scope:"page"` resolves `params.pageLabel` and checks `canAccessPage` before the
handler. Page identifiers carried in query/body remain service-layer checks.
The server can run policy in `log` or `enforce` mode; missing declarations fail
closed in enforce mode. A cookie principal with `mustChangePassword` is limited
unconditionally to `me`, logout, and password change.

OpenAPI security is derived from the same auth declaration. The generated
route-by-route view is `docs/generated/authorization-policy.md`.

## Error boundary

The server maps:

- request validation to 400;
- response serialization failure to a logged 500;
- `SnapshotRestartRequiredError` to its structured 409 with `replayFloor` and
  `snapshotPath`;
- other `AppError` subclasses to their status/code/message;
- Fastify-shaped errors through unchanged fields;
- unknown failures to `internal_error` 500.

This matters for v1/v2 stream snapshot recovery: a restart-required response is
part of the typed contract rather than a generic conflict.

## Module composition

The server passes `{appContext, auth, boss}` to ten bounded-context modules:

| Module | Current boundary |
|---|---|
| `ops` | `/health`, sync health/status/trigger, config, metrics, incidents, credits, logs and diagnostics. Public health includes `contractHash` and running capabilities. |
| `identity` | Login/logout/me/password, users, API keys, grants, two-phase device enrollment/activation, self-revoke and owner harvest-capability binding. |
| `ai` / `aiAdmin` | Gateway and feature SSE, usage/acceptance, persona catalog, legacy persona compatibility routes, restricted generations and owner persona view/mutation contracts. Owner mutations are deliberately blocked while the legacy LWW lane exists. |
| `ingest` | HMAC webhook, observation/client-harvest intake, OFAPI read gateway and command outbox. Registration is awaited because raw-body setup is asynchronous. |
| `catalog` | Models, pages, credentials, proxies and connection onboarding. |
| `finance` | Revenue, transactions, spenders and reporting. |
| `audience` | Fans, subscriptions/follows/growth, top earners, notes and flags. |
| `conversations` | Fan profiles, thread/message reads and cold/readthrough archive surfaces. |
| `workboard` | Board/lists/contact/snooze/claim/recompute and classifier settings/runs. |
| `events` | v1 and v2 stream/snapshot routes, lifecycle state snapshot and recovery responses. |

The server shell itself keeps the owner-only `/api/v1/openapi.json` route and
SPA hosting. Most JSON routes use `/api/v1`; spender and fan-search surfaces
also use `/api/v2`.

## Streaming and non-JSON paths

- `GET /api/v1/events/stream` is the numeric-fanout v1 SSE stream.
- `GET /api/v1/events/v2/stream` is the per-account domain-event stream.
- Their snapshot routes expose durable state and cursor recovery contracts.
- AI gateway/feature generation is SSE and uses dedicated SDK helpers.
- The OFAPI read gateway is wildcard passthrough with capture/credit controls.
- The owner credit-ledger export returns `text/csv`.

Those operations remain in the route manifest but are excluded from ordinary
JSON SDK methods and reached through `client.raw()` or specialized helpers.
