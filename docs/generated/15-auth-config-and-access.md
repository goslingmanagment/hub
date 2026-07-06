> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Auth, Config, and Access

Scope: how the kernel authenticates requests and controls access, then how it
stores and applies configuration. Part one covers principals (session, api key,
device token), the three roles, request resolution and bearer discrimination,
session/cookie mechanics, API-key issuance/rotation, device tokens, password
reset/change, login backoff, the declarative route-authorization middleware,
and the guard functions with page scoping. Part two covers the config system:
the `config_settings` / `config_audit_log` tables, the registry's two orthogonal
axes (editability and runtimeApply), the live overlay, boot-apply, the atomic
live PATCH path, staged flag flips under advisory lock, the running-state gate,
and the heartbeat snapshot. Anchors are `apps/runtime/src/...` unless a
`packages/...` prefix is shown.

## Principals and roles

`AuthPrincipal.authMethod` is `"session" | "api_key" | "device_token"`
(`services/auth.ts:96-100`).

Roles are `owner`, `team_lead`, `chatter` (`content_manager` is mentioned as an
excluded value). Role capability predicates (`auth.ts:102-118`):

| Predicate | Roles | Anchor |
|---|---|---|
| `roleNeedsPassword` | owner, team_lead | `auth.ts:102-104` |
| `roleCanUseApiKey` | chatter only | `auth.ts:106-108` |
| `roleCanUseSession` | owner, team_lead, chatter | `auth.ts:110-114` |
| `roleCanUseDashboard` | owner, team_lead | `auth.ts:116-118` |

## Request resolution and bearer discrimination

`api/request-auth.ts` `createRequestAuth` (`request-auth.ts:39-103`):

- `resolvePrincipal(request)` memoizes on `request.auth`. If the request carries
  `Authorization: bearer <token>` (regex `/^bearer\s+(.+)$/i`) it calls
  `authenticateBearerToken(app, token)` (`request-auth.ts:45-55`). Otherwise it
  reads the cookie `SESSION_COOKIE_NAME` and calls `authenticateSessionToken`
  (`request-auth.ts:57-61`).
- `requirePrincipal` throws `UnauthorizedError` if the principal is null
  (`request-auth.ts:64-70`).
- `hasValidSyncHealthMonitoringToken` does a timing-safe compare
  (`safeStringEquals` / `timingSafeEqual`) of the header `x-monitoring-token`
  against `config.healthSyncMonitoringToken` (`request-auth.ts:72-82`).
- `pageScopeFor(principal)` is `undefined` for owner, else the principal's
  `assignedPageIds` (`request-auth.ts:23-25`).

Bearer discrimination (`auth.ts:996-1001`): a token with prefix
`agency_hub_device_` is treated as a device token; otherwise it is an API key.

## Session and cookie mechanics

- Cookie name `SESSION_COOKIE_NAME = "agency_hub_core_session"` (`auth.ts:56`).
- A session token is `randomToken(32)`, stored as its `sha256Hex` digest;
  `expiresAt = now + sessionTtlDays * 86400s` (`auth.ts:760-766`).
- `authenticateSessionToken` rejects revoked/expired sessions, requires
  `roleCanUseSession`, and calls `touchAuthSession` (`auth.ts:789-807`).
- Logout revokes the session by digest (`auth.ts:829-844`).

## API-key issuance and rotation

`issueChatterApiKey` (`auth.ts:494-570`):

- `API_KEY_PREFIX = "agency_hub_core_"` (`auth.ts:57`),
  `API_KEY_DISPLAY_LENGTH = 10` (`auth.ts:58`).
- The raw key is `agency_hub_core_<randomToken(24)>`; the stored digest is
  `sha256Hex(rawKey)`; `keyPrefix` is the prefix plus the first 10 characters.
- In one transaction: `lockUserForApiKeyRotation`, an optional page grant,
  `createApiKey`, audit `api_key.issued`, then
  `revokeApiKeysByIds(activeKeys, "rotated")` — enforcing a single active key
  per chatter (rotation on issue).
- `authenticateApiKeyToken` requires the chatter role and calls `touchApiKey`
  (`auth.ts:809-827`).

## Device tokens

`auth.ts:913-1001`: `DEVICE_TOKEN_PREFIX = "agency_hub_device_"`; TTL `90d`, hard
cap `365d`, refresh granularity `24h` (sliding expiry)
(`auth.ts:915-920, 978-986`).

## Password reset and change

- `setUserPassword` (admin) (`auth.ts:324-369`): argon2id hash,
  `updateUserMustChangePassword`, revoke all sessions (reason
  `"password_reset"`), audit `user.password_updated`.
- `changeOwnPassword` (self-serve) (`auth.ts:376-408`): verifies the current
  password, hashes the new one, clears `mustChangePassword`, revokes sessions
  (reason `"password_changed"`), audit `user.password_changed_self`.
- Passwords hash via `argon2.hash(..., { type: argon2.argon2id })`.
  `DUMMY_PASSWORD_HASH` (`auth.ts:63-64`) equalizes timing for unknown users.

## Login backoff

Per-account, in-memory, keyed in a `WeakMap` on the `AppContext`
(`auth.ts:633-787`): `LOGIN_BACKOFF_FREE_FAILURES = 5`, `BASE_LOCK_MS = 30_000`,
`MAX_LOCK_MS = 15 * 60_000`, `FORGET_MS = 30 * 60_000`,
`MAX_TRACKED_ACCOUNTS = 10_000`. After 5 failures the lock grows exponentially;
it throws `TooManyRequestsError` (429). This complements the IP-level
`@fastify/rate-limit` on the login route.

## Declarative route authorization

Route authorization is declared per route (in `packages/contracts`) and enforced
by a Fastify hook. `api/auth-policy.ts` `computeAuthPolicyVerdict`
(`auth-policy.ts:76-134`):

- Auth kinds and outcomes:
  - `public` / `hmac` → allow, no principal (`auth-policy.ts:84-86`).
  - `monitoring` with a valid monitoring token → allow (`auth-policy.ts:87-89`);
    otherwise resolve a principal (401 `no_principal` if none).
  - Kind guards (`auth-policy.ts:96-114`): `monitoring` / `session` →
    `requireDashboardUser`; `any-session` → `requireSessionUser`;
    `owner-session` → `requireOwner`; `apiKey` → `requireApiKeyUser`; `any` →
    allow.
- Then the `auth.roles` allowlist (403 `role_not_allowed`,
  `auth-policy.ts:119-121`); and if `auth.scope === "page"` with a `:pageLabel`
  param, `resolvePageAccess` (404 `page_not_found` / 403 `page_access_denied`,
  `auth-policy.ts:123-131`).
- `buildRoutePolicyIndex()` (`auth-policy.ts:39-46`) keys the policy by
  schema-object identity from `routeSchemas` (contracts).

### Enforcement in the server (log vs enforce)

`api/server.ts:284-338`:

- An `onRequest` hook computes the verdict per request.
- `must_change_password` sessions are restricted to
  `MUST_CHANGE_PASSWORD_ALLOWED_ROUTES = {"me", "logout", "authChangePassword"}`,
  enforced UNCONDITIONALLY (`server.ts:262, 315-326`).
- Enforce vs log is toggled by `config.authPolicyEnforcement === "enforce"`
  (`server.ts:263`).
- In log mode, an `onResponse` hook compares the verdict against the actual
  status via `classifyAuthPolicyDivergence`, logging `would-deny` / `would-allow`
  (`server.ts:340-362`, `auth-policy.ts:141-152`).

### Guard functions and page scoping

`auth.ts:846-910`:

- `canAccessPage` — owner is always true; otherwise checks `assignedPageIds`.
- `requireDashboardUser` — session plus owner/team_lead.
- `requireSessionUser` — a session principal.
- `requireOwner` — the owner role.
- `requireApiKeyUser` — `api_key` OR `device_token`.
- `enforceRevenueRouteRoleScope` — gated by
  `config.revenueRouteRoleEnforcement` (log/enforce).

No dead-man pause exists in the current code (a grep for `dead.?man` /
`dead man` over `apps/runtime/src` returns no matches).

## Config system

### Tables

`config_settings` — `packages/db/src/schema.ts:2383-2405`. Columns: `id`,
`scope_type` (default `"global"`), `scope_id` (default 0), `key`, `value`
(jsonb `ConfigOverrideValue`), `version` (default 1), `updated_by_user_id` (FK
users), `updated_at`. Unique constraint `config_settings_scope_key_uniq` on
`(scope_type, scope_id, key)`. The default scope is global / 0
(`packages/db/src/repositories/config-settings.ts:10-11`).

`config_audit_log` — `schema.ts:2411-2433`, append-only. Columns: `id`,
`group_id` (uuid — one multi-key patch shares it), `changed_at`, `user_id`,
`scope_type`, `scope_id`, `key`, `old_value`, `new_value`, `old_version`,
`new_version`, `note`. A clear (revert to env) writes null `new_value` /
`new_version`. Indexes on `changed_at` and `group_id`.

### Registry and the two orthogonal axes

`packages/shared/src/config-registry.ts`. `CONFIG_DESCRIPTORS`
(`config-registry.ts:98-220`) holds ~120 descriptors. `RUNNING_SCHEMA_VERSION = 2`
(`config-registry.ts:16`). Lookups `getDescriptor` / `getDescriptorByEnv`
(`config-registry.ts:225-231`), plus `transitiveRequires` DAG walk
(`config-registry.ts:237-249`).

Two orthogonal axes:

- `editability: "never" | "staged" | "editable"` — the policy class
  (`config-registry.ts:40`).
- `runtimeApply: "live" | "boot" | "none"` — the wiring class
  (`config-registry.ts:54`):
  - `live` — re-read each cycle via `loadEffectiveConfig`
    (`services/effective-config.ts`).
  - `boot` — applied once at start via `applyBootOverrides`; effective only after
    a restart.
  - `none` — not DB-overridable (env-only / read-only).

Example descriptors:

| Key | editability / runtimeApply | Notes | Anchor |
|---|---|---|---|
| `transactionLookbackDays` | editable / live | min 1, max 365 | `config-registry.ts:141` |
| `healthSyncLightMaxAgeMinutes` | editable / live | — | `config-registry.ts:144` |
| `fanslyFanEarningsSyncEnabled` | editable / live | — | `config-registry.ts:173` |
| `onlyFansTopSpendersEnabled` | staged / boot | stagedGroup `#50`, order 5, requires `ofapiPresenceProjectionEnabled` | `config-registry.ts:147` |
| `ofapiDmSyncEnabled` | staged / boot | `#49`, order 2, requires `ofapiDmProjectionEnabled`, costWarning | `config-registry.ts:170` |
| `chatMuseAiGatewayEnabled` | staged / boot | `#26`, order 1 | `config-registry.ts:207` |
| `databaseUrl` / `encryptionKey` / `ofapiApiKey` | never / none | secret | — |

Staged descriptors carry `stagedGroup`, `stagedOrder`, and `requires[]`.

### Live overlay

`services/effective-config.ts`:

- `LIVE_CONFIG_KEYS` is derived from descriptors with `runtimeApply === "live"`
  (`effective-config.ts:22-24`).
- `applyEffectiveOverrides` (pure) re-validates and clamps each live override and
  writes it into `AppConfig[configField]` (`effective-config.ts:30-57`).
- `loadEffectiveConfig` is one `getConfigOverrides` read layered over the boot
  config (`effective-config.ts:62-65`) — used by the heartbeat and the health
  read-sites.

### Boot-apply

`packages/shared/src/config-settings.ts` `applyBootOverrides`
(`config-settings.ts:237-358`): for each `boot` descriptor with an override, it
validates the boolean via `validateStagedOverride` (`config-settings.ts:170-182`)
and writes onto a clone. It ALWAYS normalizes the transitive requires graph —
any dependent turned ON whose prerequisite is OFF is forced FALSE and recorded as
skipped, even from env alone (`config-settings.ts:296-321`). It then re-checks
boot invariants (`checkBootInvariants`, `config-settings.ts:200-212`), reverting
offending keys, and returns `{ config, skipped }` (preserving the original
identity when the net result is unchanged).

Invocation (`bootstrap.ts:167-181`): `getConfigOverrides(db)` →
`applyBootOverrides(rawConfig, overrides)`; a DB read failure falls back to
`applyBootOverrides(rawConfig, new Map())` (still normalizing the graph). The
`AppContext` carries `config` (boot-applied), `rawConfig` (pre-boot env), and
`bootSkipped` (`bootstrap.ts:96-128`).

### Atomic live PATCH path

`packages/db/src/repositories/config-settings.ts`:
`setConfigOverridesAtomic` / `applyConfigPatchesInTx`
(`config-settings.ts:98-236`). Per key it runs `SELECT … FOR UPDATE` in sorted
key order (deadlock-safe), checks the optimistic `expectedVersion`
(`ConfigOverrideVersionConflictError`), upserts bumping the version by 1 (or to
1); a clear deletes and audits null. Each patch writes a `config_audit_log` row.
There is NO advisory lock on the live path (`config-settings.ts:96-97`).

### Staged flag flips under advisory lock

`services/staged-config.ts`:

- `STAGED_CONFIG_ADVISORY_LOCK_KEY = 6_041_703_182_546_001n` — a single global
  mutex for all staged mutations (`staged-config.ts:154`).
- `validateStagedTransition` (pure, `staged-config.ts:69-144`): boot-only keys,
  no duplicates; ENABLE requires every transitive prerequisite to be both
  desired-on AND running-on (`getRunningFlagState === "on"`); DISABLE requires no
  transitive dependent to remain desired-on.
- `commitStagedConfigChange` (`staged-config.ts:189-232`): `db.transaction` →
  `select pg_advisory_xact_lock(6041703182546001)` → re-read overrides + active
  instances INSIDE the lock → validate → `applyConfigPatchesInTx`. A validation
  failure raises `BadRequestError` (rolls back → 400). The live PATCH path does
  NOT take this lock.

### Running-state gate

`services/app-config-service.ts`:

- `getRunningFlagState(activeInstances, key)` (`app-config-service.ts:50-73`)
  returns `on` / `off` / `unknown`, fail-closed: it requires EVERY
  `EXPECTED_ROLES = ["api", "worker"]` (`app-config-service.ts:22`) to have an
  active instance reporting the flag true.
- `assembleConfigView` / `buildConfigView` (`app-config-service.ts:250-319`)
  build the dashboard Configuration view from heartbeat rows plus overrides; the
  staleness cutoff is `INSTANCE_STALE_TTL_MS = 3 * 60_000`
  (`packages/db/src/repositories/runtime-instances.ts:13`).

### Heartbeat snapshot

`services/runtime-heartbeat.ts`: `HEARTBEAT_INTERVAL_MS = 60_000`,
`HEARTBEAT_STOP_TIMEOUT_MS = 5_000` (`runtime-heartbeat.ts:17-18`). Each beat
calls `loadEffectiveConfig` →
`buildRunningSnapshot(effectiveConfig, app.bootSkipped)` →
`upsertInstanceHeartbeat` (role, `instanceId = randomUUID()`, `startedAt`,
`imageTag = IMAGE_TAG ?? GIT_SHA`) plus an idempotent `reapStaleInstances`
(`runtime-heartbeat.ts:57-98`). `buildRunningSnapshot`
(`config-registry.ts:298-328`) masks secret/complex values to set/unset and
maps aliases to null.
