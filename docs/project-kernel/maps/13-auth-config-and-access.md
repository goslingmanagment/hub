> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 13 — Auth, Access Control & Runtime Config

**Scope.** This document covers authentication, authorization, and the runtime
config/flag surface of the `core` backend. Files read in full and documented here:
`apps/runtime/src/services/auth.ts` (login/session/API-key/user-admin service),
`apps/runtime/src/services/app-config-service.ts` (read-only config view + running-flag gate),
`apps/runtime/src/services/staged-config.ts` (advisory-locked staged flag commit + order validator),
`apps/runtime/src/services/effective-config.ts` (live DB→env overlay),
`packages/shared/src/config.ts` (`loadConfig`, env schema, boot invariants, encryption-key parsing),
`packages/shared/src/config-registry.ts` (the descriptor catalog + running-snapshot builder),
`packages/shared/src/config-settings.ts` (override validation, effective-config resolver, `applyBootOverrides`),
`packages/db/src/repositories/auth.ts` (users/sessions/API-keys/assignments/audit repo),
`packages/db/src/repositories/config-settings.ts` (override + audit-log repo),
`packages/db/src/repositories/catalog.ts` (models/pages catalog repo).
Traced beyond scope for boundaries: `apps/runtime/src/api/server.ts` (route guards, cookie handling,
principal resolution), `apps/runtime/src/bootstrap.ts` (`createAppContext`), `apps/runtime/src/services/runtime-heartbeat.ts`
(heartbeat writer), `packages/db/src/repositories/runtime-instances.ts` (`runtime_instances` TTLs),
`packages/db/src/schema.ts` (table DDL), `packages/contracts/src/routes.ts` (Zod payload shapes),
`packages/shared/src/types.ts` (role enum), `apps/runtime/src/cli.ts` (CLI user-admin commands).

---

## 1. Roles

The role universe is `userRoles = ["owner", "team_lead", "chatter", "content_manager"]`
(`packages/shared/src/types.ts:104`). It is materialized as a Postgres enum
`user_role` (`packages/db/src/schema.ts:115`, `userRoleEnum`) and stored on
`users.role` (`schema.ts:152`).

`creatableUserRoles = ["owner", "team_lead", "chatter"]` (`types.ts:106`) is the
subset the API/CLI will create — `content_manager` **cannot be created** via
`createUserAccount` (`auth.ts:222`, rejects roles outside `creatableUserRoles`).

Role capability predicates live in `auth.ts` and are the authoritative gate for
what each role can do:

| Predicate | Roles that pass | Anchor |
|---|---|---|
| `roleNeedsPassword` | `owner`, `team_lead` | `auth.ts:85` |
| `roleCanUseApiKey` | `chatter` | `auth.ts:89` |
| `roleCanUseSession` | `owner`, `team_lead` | `auth.ts:93` |

Consequences of these predicates:
- **`content_manager` can authenticate by neither method** — it is excluded from
  session login (`roleCanUseSession`) and API keys (`roleCanUseApiKey`). It exists
  in the enum but has no working credential path.
- **`chatter` uses only API keys**; `owner`/`team_lead` use only cookie sessions.
- On create, `owner`/`team_lead` **require** a password and `chatter`/others **must
  not** send one (`createUserAccount`, `auth.ts:226`–`232`; the "does not accept a
  password in Phase 2" message).

---

## 2. Authentication

### 2.1 Session model (owner / team_lead)

Password login is `loginWithPassword` (`auth.ts:591`):
1. Per-account escalating backoff is checked first (`assertLoginNotBackedOff`, §2.4).
2. `findUserByUsername` (`packages/db/src/repositories/auth.ts:53`).
3. If the user is missing, cannot use a session (`roleCanUseSession`), or has no
   `passwordHash`, a **dummy** argon2 verify runs against `DUMMY_PASSWORD_HASH`
   (`auth.ts:47`, a fixed `$argon2id$…` hash) to equalize timing against the
   wrong-password path (anti-enumeration), then throws `UnauthorizedError`
   (`auth.ts:603`–`611`).
4. Otherwise `argon2.verify(user.passwordHash, password)` (`auth.ts:614`).
5. On success: mint a session token = `randomToken(32)` (32 random bytes,
   base64url — `packages/shared/src/crypto.ts:76`); store only its
   `sha256Hex` digest (`crypto.ts:72`) via `createAuthSession`
   (`repositories/auth.ts:116`); `expiresAt = now + sessionTtlDays*24h`
   (`auth.ts:627`). Returns `{ sessionToken, expiresAt, authMethod:"session", user }`.

Password hashing is **argon2id** everywhere (`argon2.hash(..., { type: argon2.argon2id })`
at `auth.ts:240`, `auth.ts:278`). Hashes live in `users.password_hash`
(nullable text, `schema.ts:153`).

**Session cookie** (`SESSION_COOKIE_NAME = "agency_hub_core_session"`, `auth.ts:40`):
set in `applyCookie` (`server.ts:281`) with `httpOnly: true`, `sameSite: "lax"`,
`secure: isProduction ? true : "auto"`, `path: "/"`, `expires = now + sessionTtlDays*24h`.
Cleared on logout via `clearCookie` (`server.ts:293`, path `/`).

`auth_sessions` table (`schema.ts:1469`): `id`, `user_id` (FK→users, cascade),
`token_digest` (unique), `expires_at`, `last_seen_at` (defaults now), `created_at`,
`revoked_at`, `revoked_reason`. Indexed on `user_id` and `expires_at`.

Session validation is `authenticateSessionToken` (`auth.ts:655`):
`findAuthSessionByDigest(sha256Hex(token))`; **rejects** when the row is missing,
`revokedAt` is set, or `expiresAt <= now`; then re-loads the user and re-checks
`roleCanUseSession` (so a demoted user's session stops working); `touchAuthSession`
updates `last_seen_at`. Returns an `AuthPrincipal { authMethod:"session", user, assignedPageIds }`.

Logout (`logoutSessionToken`, `auth.ts:695`) looks up the session by digest and
calls `revokeAuthSession(id, "logout")` (`repositories/auth.ts:135`), writing
`revoked_at`/`revoked_reason`. Password reset revokes **all** of a user's live
sessions with reason `"password_reset"` inside the same transaction as the hash
update (`setUserPassword`, `auth.ts:279`–`301`; `revokeAuthSessionsForUser`,
`repositories/auth.ts:148`).

**Discrepancy / gap:** `cleanupExpiredSessions` (`auth.ts:489`, wrapping
`deleteExpiredAuthSessions`, `repositories/auth.ts:162`) exists but **is never
called** anywhere in `apps/`, `packages/`, or a worker job. Expired rows are only
ignored at authentication time (the `expiresAt <= now` check), never physically
deleted. Revoked/expired session rows therefore accumulate.

### 2.2 API keys (chatter)

Minting is `issueChatterApiKey` (`auth.ts:368`). It requires the target user to
be `roleCanUseApiKey` (chatter). The raw key is
`` `agency_hub_core_${randomToken(24)}` `` (`API_KEY_PREFIX = "agency_hub_core_"`,
`auth.ts:41`; body = 24 random bytes base64url, `auth.ts:391`). The stored
**display prefix** is `agency_hub_core_` + the first 10 chars of the body
(`API_KEY_DISPLAY_LENGTH = 10`, `auth.ts:42`/`393`). Only `sha256Hex(rawKey)` is
persisted as `token_digest` (`auth.ts:394`). All of this happens in one
transaction that:
- Takes `SELECT … FOR UPDATE` on the user row (`lockUserForApiKeyRotation`,
  `repositories/auth.ts:181`) to serialize rotation.
- Optionally assigns a page (`assignUserToPage`) when `pageLabel` is supplied.
- Inserts the new key (`createApiKey`, `repositories/auth.ts:166`).
- **Revokes every previously-active key** for that user with reason `"rotated"`
  (`revokeApiKeysByIds`, `auth.ts:422`) — so a chatter has at most one live key.

The **raw key is returned exactly once** in the HTTP response
(`issuedApiKeyResponseSchema = { key, keyPrefix, assignedPages }`,
`routes.ts:1978`); it is never retrievable again.

`api_keys` table (`schema.ts:1489`): `id`, `user_id` (FK→users cascade),
`key_prefix` (unique), `token_digest` (unique), `last_used_at`, `created_at`,
`revoked_at`, `revoked_reason`, indexed on `user_id`.

Validation is `authenticateApiKeyToken` (`auth.ts:675`):
`findApiKeyByDigest(sha256Hex(token))`; **rejects** when missing or `revokedAt`
set (note: API keys have **no expiry** column — only revocation); re-loads user
and re-checks `roleCanUseApiKey`; `touchApiKey` updates `last_used_at`. Returns
`AuthPrincipal { authMethod:"api_key", … }`.

Revocation: `revokeUserApiKeys` (`auth.ts:438`) revokes all a user's live keys
(default reason `"revoked"`); used by the API (`server.ts:2489`) and CLI
(`cli.ts:1428`). `AdminUserApiKeyStatus` (surfaced in `listUsersDetailed`) exposes
`activeKeyPrefix`, `activeKeyCount`, `activeKeyCreatedAt`, `activeKeyLastUsedAt`
(`auth.ts:149`) — never the raw key or digest.

### 2.3 Principal resolution in the API server

`resolvePrincipal` (`server.ts:475`) decides the auth method per request:
- If an `Authorization: Bearer <token>` header is present → `authenticateApiKeyToken`
  (`server.ts:490`). Bearer path is **API-key-only** (chatter).
- Else the `agency_hub_core_session` cookie → `authenticateSessionToken`
  (`server.ts:494`). Cookie path is **session-only**.
- Result is memoized on `request.auth` (decorated at `server.ts:431`; typed at
  `server.ts:271`). `requirePrincipal` throws `UnauthorizedError` (401) when null.

Contract security tags in `routes.ts`: `cookieOnlySecurity` (`routes.ts:3513`),
`bearerOnlySecurity` (`3514`), `cookieOrBearerSecurity` (`3515`),
`dashboardOrMonitoringTokenSecurity` (`3519`). These drive the OpenAPI doc only;
the runtime gate is the guard functions below.

### 2.4 Brute-force controls

Two layers:
1. **Per-IP** `@fastify/rate-limit` on `POST /auth/login` — `max: 20 / 60s`
   (`server.ts:659`). Registered global-off (`server.ts:434`) with a custom 429
   body `{ error:"rate_limit_exceeded", … }`.
2. **Per-account escalating backoff**, in-memory, keyed per `AppContext` via a
   `WeakMap` (`loginBackoffRegistries`, `auth.ts:511`). After
   `LOGIN_BACKOFF_FREE_FAILURES = 5` (`auth.ts:505`) consecutive failures, a lock
   of `30s * 2^(failures-5)` up to `15min` applies (`auth.ts:506`–`507`,
   `553`–`558`); entries are forgotten after 30min idle and the map is capped at
   10 000 tracked usernames (`auth.ts:508`–`509`). The username key is
   `trim().toLowerCase()` (`auth.ts:522`) and applies to unknown usernames alike so
   the 429 carries no enumeration signal (`auth.ts:526`–`528`). State is process-local;
   a restart resets it.

Failed logins are best-effort audited as `auth.login_failed` with only
`{ username }` metadata (`recordFailedLoginAuditBestEffort`, `auth.ts:176`); the
insert failing does not block the 401 response.

---

## 3. Authorization

### 3.1 Guard functions (`auth.ts`)

| Guard | Enforces | Anchor |
|---|---|---|
| `requireDashboardUser` | `authMethod === "session"` AND `roleCanUseSession` | `auth.ts:720` |
| `requireOwner` | `requireDashboardUser` + `role === "owner"` | `auth.ts:729` |
| `requireApiKeyUser` | `authMethod === "api_key"` | `auth.ts:736` |
| `canAccessPage(principal, pageId)` | `owner` → always true; else `pageId ∈ assignedPageIds` | `auth.ts:712` |

`requireApiKeyUser` checks only the auth method, but since `authenticateApiKeyToken`
already narrows to chatters, an `api_key` principal is always a chatter.

### 3.2 Per-page access

`user_page_assignments` table (`schema.ts:1451`): `id`, `user_id` (FK→users
cascade), `platform_account_id` (FK→pages cascade), `created_at`; unique on
`(user_id, platform_account_id)`; indexed on the page. Loaded per user by
`listUserPageAssignments` (`repositories/auth.ts:102`), which joins
`pages`+`models` to return `{ pageId, label, platform, modelSlug, modelName }`.

An `AuthPrincipal` carries `assignedPageIds` (`auth.ts:82`); the built
`AuthenticatedUser.assignedPages` is the richer per-page projection (`auth.ts:59`).

**Owner vs everyone else on page scope:** `pageScopeFor` (`server.ts:277`) returns
`undefined` (= all pages) for `owner` and `assignedPageIds` for any other role.
`canAccessPage` grants owner every page; `team_lead` (though it can use the
dashboard) is scoped to its assignments, same as it would be for any non-owner.
Page-scoped routes call `canAccessPage` per request (~15 call sites, e.g.
`server.ts:865`, `880`, `897`, …) and 404/403 on a page the principal cannot see.

### 3.3 Route enforcement map (this territory's endpoints)

All under `apps/runtime/src/api/server.ts`. Auth-admin and config endpoints are
**owner-only, cookie-only**.

| Route | Guard | Handler → service |
|---|---|---|
| `POST /api/v1/auth/login` | none (rate-limited) | `loginWithPassword` → sets cookie (`server.ts:650`) |
| `POST /api/v1/auth/logout` | none | `logoutSessionToken` → clears cookie (`server.ts:673`) |
| `GET /api/v1/auth/me` | `requirePrincipal` (cookie or bearer) | returns `{authMethod, user}` (`server.ts:684`) |
| `GET /api/v1/admin/users` | `requireOwner` | `listUsersDetailed` (`server.ts:2389`) |
| `POST /api/v1/admin/users` | `requireOwner` | `createUserAccount` (`server.ts:2405`) |
| `PATCH /api/v1/admin/users/:u/password` | `requireOwner` | `setUserPassword` (`server.ts:2414`) |
| `POST /api/v1/admin/users/:u/pages` | `requireOwner` | `assignPageToUser` (`server.ts:2426`) |
| `DELETE /api/v1/admin/users/:u/pages/:p` | `requireOwner` | `unassignPageFromUser` (`server.ts:2442`) |
| `GET /api/v1/admin/users/:u/api-keys` | `requireOwner` | `listApiKeysForUsers` (`server.ts:2455`) |
| `POST /api/v1/admin/users/:u/api-keys` | `requireOwner` | `issueChatterApiKey` (`server.ts:2473`) |
| `DELETE /api/v1/admin/users/:u/api-keys` | `requireOwner` | `revokeUserApiKeys` (`server.ts:2484`) |
| `GET /api/v1/admin/config` | `requireOwner` | `buildConfigView` (`server.ts:3144`) |
| `PATCH /api/v1/admin/config` | `requireOwner` | `setConfigOverridesAtomic` (live) (`server.ts:3191`) |
| `DELETE /api/v1/admin/config/:key` | `requireOwner` | `clearConfigOverride` (`server.ts:3247`) |
| `PATCH /api/v1/admin/config/staged` | `requireOwner` | `commitStagedConfigChange` (`server.ts:3280`) |

Every admin write records an audit event via `auditCtx(principal)` = `{ source:"api",
actorUserId: principal.user.id }` (`server.ts:2383`).

Cross-references: bearer/API-key routes `POST /api/v1/ai/gateway/stream` and
`POST /api/v1/ai-usage/batch` gate on `requireApiKeyUser` (`server.ts:705`,
`server.ts:697` via `requirePrincipal`) — see territory 10. Page-scoped read/sync
routes use `canAccessPage`/`pageScopeFor` — see territory 02. The sync-health
endpoint accepts EITHER a dashboard session OR an `x-monitoring-token` header
(`requireSyncHealthAccess`, `server.ts:531`; token compared with `timingSafeEqual`
via `safeStringEquals`, `server.ts:513`, against `config.healthSyncMonitoringToken`).

### 3.4 CLI as a second admin surface

`apps/runtime/src/cli.ts` calls the same service functions directly against the DB
(no HTTP, no principal): `createUserAccount` (`cli.ts:1312`), `listUsersDetailed`,
`setUserPassword`, `assignPageToUser`, `unassignPageFromUser`, `issueChatterApiKey`,
`revokeUserApiKeys`, `listApiKeysForUsers`. Audit events from the CLI carry whatever
`AuditContext` the CLI passes (its own `source`), not `"api"`.

---

## 4. Runtime config: `loadConfig` and boot invariants

`loadConfig(env, options)` (`config.ts:311`) is the single env parser. Unless
`options.loadDotEnv === false`, it merges the ambient `.env` via the plain `dotenv`
package (`config.ts:1`, `317`). **There is no `DOTENV_KEY`/dotenvx encrypted-env
layer** in this codebase — secrets are read from plain process env / `.env`.
`DOTENV_CONFIG_QUIET` only silences dotenv logging.

The env schema is one big `z.object` (`config.ts:73`–`158`) with typed coercion.
`ENV_CONFIG_KEYS` (`config.ts:163`) exports its key list so a parity test can assert
the descriptor registry matches it.

**Boot invariants enforced during `loadConfig` / `createAppContext`:**
- `parseEncryptionKey` requires `APP_ENCRYPTION_KEY` to base64-decode to **exactly
  32 bytes** (`config.ts:456`), else throws.
- `parseEncryptionKeyRing` parses `APP_ENCRYPTION_KEY_RING` as
  `version:base64,version:base64,…`, rejecting malformed entries, duplicate
  versions, and a ring entry whose version equals `APP_ENCRYPTION_KEY_VERSION` but
  whose bytes differ from `APP_ENCRYPTION_KEY` (`config.ts:465`–`509`). The write
  key is always merged in.
- `checkPublicProfileResolutionInvariant` (`config.ts:285`): OF public-profile
  resolution may be on only with a proxy OR allow-direct (an OR the registry's
  `requires` list can't express). Thrown at boot (`config.ts:345`).
- `checkSyncConcurrencyInvariant` (`config.ts:301`): `SYNC_PAGE_EXECUTOR_CONCURRENCY
  > 1` requires `SYNC_SHARED_RATE_LIMIT_ENABLED = true`. Re-checked in
  `createAppContext` (`bootstrap.ts:126`), which throws.
- Fansly DM conversation/message delays are floored to `MIN_FANSLY_DM_DELAY_MS = 5000`
  (`config.ts:260`, applied at `374`–`375`).
- `TRUST_PROXY` is parsed into `false` / `true` / a hop-count integer / a raw CIDR
  string (`config.ts:55`–`71`), consumed by Fastify (`server.ts:426`).
- `wbClosingLlmEnabled` is forced false unless an `ANTHROPIC_API_KEY` is present
  (`config.ts:434`) — a derived AND-gate.
- `telegramEnabled` is derived: bot token AND chat id both set (`config.ts:350`).

`AppConfig` (the parsed result, `config.ts:167`) is the in-process config object
threaded everywhere via `AppContext.config`.

---

## 5. The descriptor registry (`config-registry.ts`)

`CONFIG_DESCRIPTORS` (`config-registry.ts:98`) is a flat, pure-data catalog: one
`ConfigDescriptor` per env var (plus a few derived/alias entries). It is the
keystone the dashboard renders generically and the API serializes.

Each descriptor carries **two orthogonal axes** (`config-registry.ts:38`–`54`):
- **`editability`** = policy class: `never` (ops-only: secrets/infra/SSRF-class),
  `staged` (gated rollout flip), `editable` (safe operational knob).
- **`runtimeApply`** = wiring class: `live` (re-read each work cycle via
  `loadEffectiveConfig`, no restart), `boot` (applied once at process start via
  `applyBootOverrides`, i.e. the staged-flag set), `none` (not overridable via the
  DB overlay at all — env-only/read-only).

Other descriptor fields: `kind` (`boolean`/`number`/`string`/`url`/`secret`/`derived`/
`alias`/`complex`), `subsystem`, `label`, `default`, `configField` (the `AppConfig`
field it lands in), `comparable` (feeds drift detection), `min`/`max`/`enumValues`,
`costWarning`, `destructive`, and the staged-rollout fields `stagedGroup`,
`stagedOrder`, `requires`.

`transitiveRequires(key)` (`config-registry.ts:222`) walks a descriptor's `requires`
chain (nearest-first) — shared by the staged validator and the boot fail-safe so
the requires graph has one source of truth.

### 5.1 Editable knobs (`editability: "editable"`)

These accept overrides. Live (`runtimeApply: "live"`, applied without restart):
`transactionLookbackDays`, `transactionRescanCapDays`, `healthSyncLightMaxAgeMinutes`,
`healthSyncFollowerMaxAgeMinutes`, `ofapiDmReconcileIntervalMinutes`,
`ofapiCreditAlertThreshold`, `ofapiWebhookSilenceThresholdMinutes`,
`ofapiBurnAlertCreditsPerHour` (registry lines 140–181). All other `editable`
descriptors are `runtimeApply: "none"` (editable but only picked up at restart, e.g.
`logLevel`, `sessionTtlDays`, the Fansly delays, `ofapiDmDailyCreditBudget`,
`ofapiCreditFloor`, ChatMuse gateway caps, Workboard closing-LLM caps).

### 5.2 Staged flags (`editability: "staged"`, `runtimeApply: "boot"`)

The boot-applied flag set, grouped and ordered with `requires` prerequisites. The
full chain (registry lines 146, 168–194, 201):

| Key | stagedGroup / order | requires |
|---|---|---|
| `ofapiDmProjectionEnabled` | #49 / 1 | — |
| `ofapiDmSyncEnabled` | #49 / 2 | `ofapiDmProjectionEnabled` |
| `ofapiAccountHealthEnabled` | #49 / 3 | `ofapiDmSyncEnabled` |
| `ofapiDmColdArchiveEnabled` | #52 / 1 | `ofapiDmProjectionEnabled` |
| `ofapiCreditLedgerEnabled` | #50 / 1 | `ofapiAccountHealthEnabled` |
| `ofapiBalancePingEnabled` | #50 / 2 | `ofapiCreditLedgerEnabled` |
| `ofapiAudienceSyncEnabled` | #50 / 3 | `ofapiCreditLedgerEnabled` |
| `ofapiPresenceProjectionEnabled` | #50 / 4 | `ofapiAudienceSyncEnabled` |
| `onlyFansTopSpendersEnabled` | #50 / 5 | `ofapiPresenceProjectionEnabled` |
| `ofapiSpendProjectionShadowEnabled` | #51 / 1 | `ofapiCreditLedgerEnabled` |
| `ofapiSpendTransactionIngestEnabled` | #51 / 2 | `ofapiSpendProjectionShadowEnabled` |
| `ofapiDesktopReadGatewayEnabled` | #54 / 1 | `ofapiCreditLedgerEnabled` |
| `ofapiDesktopCommandOutboxEnabled` | #55 / 1 | `ofapiDesktopReadGatewayEnabled` |
| `ofapiDesktopCommandExecutionEnabled` | #56 / 1 | `ofapiDesktopCommandOutboxEnabled` |
| `chatMuseAiGatewayEnabled` | #26 / 1 | — |

These flags gate the OFAPI/sync/AI-gateway behaviors documented in territories 07
and 10. Note `onlyFansPublicProfileResolutionEnabled`, `onlyFansPublicProfileAllowDirect`,
`onlyFansDmPollingEnabled`, and `wbClosingLlmEnabled` are `editability: "staged"` but
`runtimeApply: "none"` (registry lines 130, 131, 135, 201) — staged policy, but **not**
overridable through the DB overlay (env-only).

### 5.3 Running snapshot

`buildRunningSnapshot(config, skippedOverrides)` (`config-registry.ts:283`)
serializes what a process actually holds into a sanitized, versioned
`RunningSnapshot { schemaVersion, values, skippedOverrides }`
(`RUNNING_SCHEMA_VERSION = 2`, `config-registry.ts:16`). **Secrets and complex
values are reduced to `{ value:null, masked:true, state:"set"|"unset" }`** here —
this is the only place a secret leaves the process, and it never carries the real
value. Alias entries report `{ value:null }`. This snapshot is what the heartbeat
persists (§7).

---

## 6. Override overlays: live, staged, boot

### 6.1 Single-override validation (`config-settings.ts`)

`validateConfigOverride(key, value)` (`config-settings.ts:24`) is the server-side
gate for the **live/editable** path: rejects unknown/non-editable keys, type
mismatches, non-integers, empty strings, and enum misses; **clamps** numbers to
`min`/`max` and returns the clamped value; trims strings. `url/secret/derived/alias/
complex` are never editable (fail-closed default, `config-settings.ts:79`).

`validateStagedOverride(key, value)` (`config-settings.ts:170`) is the gate for the
**staged/boot** path: legal only for `runtimeApply === "boot"` keys with a boolean
value.

`collectCostWarnings(keys)` (`config-settings.ts:90`) pulls each key's registry
`costWarning` so it can be folded into the audit note server-side (durable evidence,
never trusting the client).

`resolveEffectiveConfig(config, overrides)` (`config-settings.ts:130`) layers
validated overrides over env and tags each value `env`/`override` — restricted to
`editable` keys so it can never serialize a secret.

### 6.2 Live overlay at read time (`effective-config.ts`)

`LIVE_CONFIG_KEYS` (`effective-config.ts:22`) is derived from the registry as exactly
the `runtimeApply === "live"` descriptors. `applyEffectiveOverrides(config, overrides)`
(`effective-config.ts:30`) clones `AppConfig` and, for each live key with an override
that re-validates, writes the validated value into `configField`. `loadEffectiveConfig(db, config)`
(`effective-config.ts:62`) = one `getConfigOverrides` read + the pure overlay. This
is called by the heartbeat (`runtime-heartbeat.ts:80`), health, and OFAPI credit
services so `running` == what the process actually consumes.

### 6.3 Boot overlay at process start (`config-settings.ts`)

`applyBootOverrides(config, overrides)` (`config-settings.ts:237`) is run **once** in
`createAppContext` (`bootstrap.ts:148`). For each `boot` descriptor with an override:
validate (boolean), tentatively write onto a clone, else record a `SkippedOverride`.
It **always** (even with zero overrides) then:
1. Normalizes the **staged requires graph** on the merged config: any boot flag ON
   while a transitive prerequisite is OFF is forced to `false` (not reverted to env,
   because env itself may be the invalid `true`) and recorded as skipped
   (`config-settings.ts:304`–`321`). This means **boot never starts a
   dependent-on/prerequisite-off graph**, however that state arose (stale override,
   hand-edited row, or the env config itself).
2. Re-checks the merged boot invariants (`checkBootInvariants`, `config-settings.ts:200`);
   if an applied override broke one, the offending keys revert to env and it re-checks
   (guarded by `applied.length > 0`).

Returns `{ config, skipped }`; hands back the **original config identity** when nothing
net-changed. In `bootstrap.ts`, a failed `getConfigOverrides` read is non-fatal — it
falls back to `applyBootOverrides(rawConfig, new Map())` so the requires-graph
normalization still runs (`bootstrap.ts:151`–`160`).

`AppContext` carries both `config` (post-boot-apply) and `rawConfig` (pre-boot-apply
env baseline) plus `bootSkipped` (`bootstrap.ts:80`–`91`, `185`–`188`). Handlers thread
`rawConfig` as the env baseline for the view and staged validation
(`server.ts:3152`, `3302`).

### 6.4 Staged commit with advisory lock (`staged-config.ts`)

`validateStagedTransition(input)` (`staged-config.ts:69`) is the pure order validator.
Rules: (1) every patched key must be a boot descriptor, no duplicates; (2) compute the
resulting desired graph (patch value, else current DB-desired baseline); (3) **ENABLE**
requires every transitive prerequisite to be BOTH desired-on AND **running-on**
(`runningState === "on"`) — a prerequisite merely desired-on, or enabled in the same
patch, does not satisfy it; (4) **DISABLE** requires no transitive dependent to remain
desired-on. It returns a precise error naming the offending key.

`commitStagedConfigChange(db, input)` (`staged-config.ts:189`) runs the entire
read-validate-write inside one transaction holding a transaction-scoped advisory lock
`STAGED_CONFIG_ADVISORY_LOCK_KEY = 6_041_703_182_546_001n` (`staged-config.ts:154`,
acquired via `pg_advisory_xact_lock`). Inside the lock it re-reads overrides +
active instances, runs `validateStagedTransition` against `getRunningFlagState`
(the applied truth), then applies patches via `applyConfigPatchesInTx`. A validation
failure throws `BadRequestError` (400, rolls back, releases the lock); a version
conflict propagates for the handler's 409. **The live PATCH path does NOT take this
lock** — its single-key writes are order-irrelevant.

---

## 7. Config persistence & audit (`config-settings.ts` repo + schema)

`config_settings` table (`schema.ts:2203`): `id`, `scope_type` (default `"global"`),
`scope_id` (bigint NOT NULL default 0), `key`, `value` (jsonb `ConfigOverrideValue`),
`version` (int default 1), `updated_by_user_id` (FK→users, set-null), `updated_at`;
unique on `(scope_type, scope_id, key)`. Only the **global scope** (`scope_type="global"`,
`scope_id=0`) is used today (`config-settings.ts:10`–`11`); the scope columns are
future-proofing for per-page overrides.

`config_audit_log` table (`schema.ts:2231`): append-only. `id`, `group_id` (uuid — one
per multi-key patch), `changed_at`, `user_id` (FK→users set-null), `scope_type`,
`scope_id`, `key`, `old_value`, `new_value`, `old_version`, `new_version`, `note`. A
CLEAR (revert to env) is recorded with `new_value`/`new_version` null.

`getConfigOverrides(db, scope?)` (`config-settings.ts:33`) returns
`Map<key, {value, version}>` for a scope. `applyConfigPatchesInTx` (`config-settings.ts:114`)
is the per-key `SELECT … FOR UPDATE` (in **sorted key order** to avoid deadlock) →
optimistic version check (`expectedVersion` vs current, 0 = new row) → upsert (bump
version) or clear (delete) → audit insert. A brand-new-key insert race is caught via
Postgres `23505` and mapped to `ConfigOverrideVersionConflictError` (`config-settings.ts:210`).
`setConfigOverridesAtomic` (`config-settings.ts:98`) wraps it in its own transaction
(the live PATCH path); `clearConfigOverride` (`config-settings.ts:269`) is the single-key
clear. `ConfigOverrideVersionConflictError` (`config-settings.ts:53`) → HTTP 409 at the
handlers. `listConfigAudit` (`config-settings.ts:324`) exists **but has no route or
caller** in `apps/`/`packages/` src — there is currently no config-audit read endpoint.

---

## 8. Read-only config view & running-flag gate (`app-config-service.ts`)

`buildConfigView(db, envBaseline)` (`app-config-service.ts:310`) reads all instances
(`listAllInstances`) + overrides (`getConfigOverrides`) and calls the pure
`assembleConfigView(rows, nowMs, overrides, envBaseline)` (`app-config-service.ts:250`).
The view classifies each instance active/stale using `INSTANCE_STALE_TTL_MS = 3*60_000`
(`runtime-instances.ts:13`), computes per-role status (active/stale/missing) for
`EXPECTED_ROLES = ["api","worker"]` (`app-config-service.ts:22`), and, per descriptor,
builds a `ConfigItem` carrying: env name, kind, editability, runtimeApply, `source`
(env/override), `desired`, `runningState`, `desiredEffective`, `overrideVersion`,
`pendingApply`, `drift`, `live`, and the per-instance `running` values.

`getRunningFlagState(activeInstances, key)` (`app-config-service.ts:50`) is the applied
truth for a boot flag: `"on"` only when EVERY expected role has an active instance and
every active instance reports the key boolean-`true`; `"unknown"` when a role is
missing, there are no active instances, or any instance reports a schema-mismatched or
absent key (fail-closed); else `"off"`. This is what the staged validator (§6.4) gates
on, and what makes an ordered enable require the prerequisite to be actually **running**,
not merely desired. `RUNNING_SCHEMA_VERSION` mismatch on a heartbeat row surfaces the
instance as `"unknown (stale snapshot)"` and keeps `pendingApply` true.

---

## 9. The catalog repository (`catalog.ts`)

`packages/db/src/repositories/catalog.ts` owns the models/pages catalog that page
access is granted against. It is CRUD for `models` and `pages` plus their credential/
proxy side tables; it does not itself do auth, but `user_page_assignments` FKs into
`pages`, and `findPageSummaryByLabel` (imported in `auth.ts:38`) is how
assign/unassign resolve a page label to an id.

Tables and key columns:
- `models` (`schema.ts:141`): `id`, `slug` (unique), `name`, `sort_order`, `created_at`.
- `pages` (`schema.ts:158`): `id`, `model_id` (FK→models cascade), `platform` enum,
  `commission_rate` (default 0.2 for OnlyFans else 0 — `catalog.ts:14`), `label`
  (unique), `external_page_id` (`platformAccountId`), `ofapi_account_id` (unique),
  `ofapi_auth_status`/`ofapi_auth_changed_at`, `username`, `display_name`,
  `follower_count`, `subscriber_count`, `earnings_balance_mills` (bigint mills),
  `metadata` jsonb, sync timestamps. Unique `(platform, external_page_id)`.
- `page_credentials` (`schema.ts:207`): encrypted platform session + `key_version`
  (upserted by `storePlatformCredentials`, `catalog.ts:210`).
- `egress_endpoints` (proxy per page): `url`, `encrypted_auth`, `key_version`,
  `rate_limit_scope_key` (upserted by `storeProxyConfig`, `catalog.ts:237`).

Notable behaviors: `createPlatformPage` (`catalog.ts:157`) inserts the page + a
`spender_projection_watermarks` seed row in one transaction; duplicate label →
`DuplicatePageLabelError` (via PG `23505`). `updatePageMetadata` (`catalog.ts:555`)
enforces platform-account identity immutability (`PlatformAccountIdentityImmutableError`,
`catalog.ts:18`) and uniqueness (`PlatformAccountIdentityConflictError`, `catalog.ts:32`).
`deleteModelBySlug` refuses to delete a model that still has pages (`ModelHasPagesError`,
`catalog.ts:75`). These catalog errors are remapped to HTTP 409/404 by
`rethrowAdminCatalogError` (`server.ts:394`). Encrypted credentials/proxy auth use the
`APP_ENCRYPTION_KEY(_RING)` sourced in §4; the plaintext values never appear in the
config view (secrets are masked in the running snapshot).

---

## 10. Secrets & credentials carried by config

| Secret | Env var(s) | Sourcing | Where consumed |
|---|---|---|---|
| Postgres DSN | `DATABASE_URL` | env/.env (required) | `createPool` (`bootstrap.ts:134`); pg-boss (`server.ts:1262`) |
| At-rest encryption key + ring | `APP_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY_RING`, `APP_ENCRYPTION_KEY_VERSION` | env/.env; parsed to 32-byte Buffers + version map (`config.ts:456`–`509`) | encrypt/decrypt of page creds, proxy auth, Telegram creds |
| OFAPI key | `OFAPI_API_KEY` | env/.env | OFAPI client (`bootstrap.ts:171`); single metered spend tap |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | env/.env; **DB `telegram_settings` overrides env** at runtime (encrypted bot token) — see registry notes at `config-registry.ts:149`–`155` | Telegram notifier |
| Anthropic | `ANTHROPIC_API_KEY` | env/.env | Workboard closing LLM + ChatMuse AI gateway provider (`bootstrap.ts:179`) |
| Sync-health monitoring token | `HEALTH_SYNC_MONITORING_TOKEN` | env/.env | `x-monitoring-token` header check (`server.ts:522`) |

All of these have registry descriptors with `editability: "never"`,
`runtimeApply: "none"`, and `kind: "secret"`/`"complex"` (registry lines 100–103, 145,
149–150, 163, 200), so they are **read-only** in the config surface and appear only as
set/unset in the view. There is **no encrypted-env (DOTENV_KEY) layer** — plain `dotenv`.

---

## 11. Boundaries summary (data crossing this territory)

**Inbound HTTP (counterpart = dashboard browser or admin CLI operator):**
- `POST /auth/login` — in: `{username(≤254), password(≤1024)}` (`routes.ts:204`);
  out: `Set-Cookie: agency_hub_core_session=<32-byte token>` + `{authMethod:"session", user}`.
- `POST /auth/logout` — in: session cookie; out: `Set-Cookie` clear + `{ok:true}`.
- `GET /auth/me` — in: cookie or `Authorization: Bearer <api key>`; out: `{authMethod, user{id,username,role,assignedPages[]}}`.
- Admin user routes (owner-only): create user `{username, role, password?}`; set
  password `{password}`; assign/unassign page `{pageLabel}`; issue key `{pageLabel?}`
  → **one-time `{key, keyPrefix, assignedPages[]}`**; list/revoke keys.
- Admin config routes (owner-only): GET view; PATCH live `{patches:[{key,value,expectedVersion?}], note?}`;
  DELETE `?expectedVersion&note`; PATCH staged `{patches:[{key,desired:bool|null,expectedVersion}], note?, ack:true}`.

**Inbound HTTP with API-key bearer (counterpart = chatter desktop/extension):** the
principal-resolution and `requireApiKeyUser` gate for `/ai/gateway/stream` and
`/ai-usage/batch` (territory 10).

**DB reads/writes (counterpart = Postgres):**
- Auth repo: `users`, `auth_sessions`, `api_keys`, `user_page_assignments`,
  `audit_events` (append-only audit of login/logout/user/key/page events).
- Config repo: `config_settings` (override overlay, global scope only),
  `config_audit_log` (append-only).
- Heartbeat: `runtime_instances` (`role`, `instance_id`, `started_at`, `last_seen_at`,
  `image_tag`, `running` jsonb `RunningSnapshot`) — written by `upsertInstanceHeartbeat`
  every 60s per process (`runtime-heartbeat.ts:17`,`84`), reaped by `reapStaleInstances`.
- Catalog repo: `models`, `pages`, `page_credentials`, `egress_endpoints`,
  `spender_projection_watermarks`.

**Secrets crossing process boundary:** only as masked set/unset state in the config
view's running snapshot (`buildRunningSnapshot`, `config-registry.ts:300`–`302`); raw
secret values never leave the process via this territory.

**No outbound HTTP, Telegram, or AI-provider calls originate in this territory** — it
governs who may call those (via roles/flags) and holds the credentials, but the egress
itself lives in territories 07 (OFAPI/sync), 10 (AI gateway), and the Telegram notifier.

---

## 12. Notable discrepancies flagged

1. `cleanupExpiredSessions` / `deleteExpiredAuthSessions` are **never invoked** — no
   scheduled job purges expired `auth_sessions`; they are only ignored at auth time.
2. `listConfigAudit` (`config-settings.ts:324`) has **no HTTP route or caller** — the
   config audit trail is written but not exposed for reading in the app.
3. `content_manager` is a valid `user_role` enum value but has **no working credential
   path** (excluded from both session and API-key predicates) and cannot be created via
   the API (`creatableUserRoles` excludes it).
4. The heartbeat docstring (`runtime-heartbeat.ts:52`–`56`) still describes "Stage A"
   deriving `running` from the immutable boot config; the code actually derives it from
   `loadEffectiveConfig` (the live overlay) — the comment lags the implementation.
5. `team_lead` can use the dashboard but is **page-scoped** exactly like other
   non-owner roles (`pageScopeFor`/`canAccessPage` grant all-pages only to `owner`).
