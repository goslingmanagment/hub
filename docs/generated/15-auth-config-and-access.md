> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Authentication, authorization, access grants, and configuration

Identity HTTP handlers live in `apps/runtime/src/modules/identity/index.ts`.
Credential and access logic is concentrated in
`apps/runtime/src/services/auth.ts`; route-policy enforcement is in
`apps/runtime/src/api/auth-policy.ts`; configuration spans
`packages/shared/src/config*.ts`, database repositories, the ops admin routes,
and per-process runtime heartbeats.

## Principals and roles

An `AuthPrincipal` has one of three authentication methods: cookie `session`,
bearer `api_key`, or bearer `device_token`. It contains the authenticated user,
the effective assigned page IDs, and method-specific session/token metadata.
A device-token principal may additionally carry an owner-bound Desktop harvest
machine ID.

The shared role vocabulary is `owner`, `team_lead`, `chatter`, and
`content_manager`; the create-user input currently permits owner, team lead, or
chatter. Owners have global page access. Other principals are restricted to
their effective assignments. Dashboard access requires a cookie session and an
owner/team-lead role; owner-only handlers narrow that again. Bearer client lanes
accept API keys or active device tokens. Some self-service credential routes
accept any eligible human cookie session.

## Request authentication and declarative policy

`apps/runtime/src/api/request-auth.ts` reads the signed session cookie or
prefix-discriminated bearer token and memoizes principal resolution per request.
API keys, active device tokens, and pending device-token activation credentials
have distinct prefixes. The pending prefix is admitted only by the activation
auth hook and is not a general application bearer.

Every contract operation declares a `RouteAuthPolicy` in
`packages/contracts/src/routes.ts`. The kinds cover public, webhook secret,
monitoring token, session, API-key/device bearer, any principal, and owner-only
access, with optional page-scope extraction. `apps/runtime/src/api/auth-policy.ts`
evaluates those declarations before handlers. `AUTH_POLICY_ENFORCEMENT` selects
log-only divergence reporting or denial; legacy handler guards remain and
recheck sensitive boundaries.

`packages/contracts/src/authorization-policy.ts` renders the generated policy
table in `docs/generated/authorization-policy.md`. Tests pin that every route
has a declaration and that contract, server, and generated policy stay aligned.

## Sessions and passwords

`POST /api/v1/auth/login` verifies the Argon2 password, applies escalating
per-account backoff, and is also protected by a per-IP Fastify rate limit. It
creates a hashed database session and sends an HTTP-only, same-site `lax`
cookie; production marks it secure. Logout revokes the stored session and
clears the cookie. `/auth/me` accepts any full principal.

Owner routes create users, reset passwords, deactivate/reactivate accounts,
and manage assignments and credentials. Session users can change their own
password after supplying the current password. Password reset, password change,
deactivation, and credential revocation serialize through user mutation locks,
advance device-token epochs where applicable, revoke affected sessions/keys,
and write audit facts in the same database transaction. A disabled user cannot
resolve to a principal even if a credential row remains.

Expired sessions and expired pending device-token reservations are removed by
the scheduled auth cleanup path. Authentication events and administrative
mutations append to `audit_events` through `recordAudit`.

## API keys

API keys are intended for chatter bearer access. Only a digest and display
prefix are stored; the raw key is returned once. The key row binds to a user;
an optional page label on issuance adds that user's page assignment in the same
transaction. Authorization is derived from current assignments when the key is
used. Owner routes list, issue, and revoke keys.
Rotation/revocation and user deactivation are audited transactionally.

## Device-token custody and harvest capability

Device tokens are user-bound bearer credentials stored in `device_tokens`.
The normal token lifetime is 90 days, use can slide expiry in one-day write
increments, and the hard lifetime cap is one year from creation. Digests are
stored rather than raw tokens. Self-service and owner issuance return the token
once; a device token can revoke only itself through the current-token route.

Crash-safe custody uses `pending_device_tokens`. A cookie session reserves a
server-generated pending credential for ten minutes. Activation locks the user
and pending row in a fixed order, atomically moves the digest into
`device_tokens`, and treats a lost activation response retry as idempotent when
the active row already exists. Password resets, revoke-all, and deactivation
advance the user's credential epoch and remove pending reservations so an
in-flight request cannot mint authority afterward.

An owner can bind exactly one active device token for a user to a Desktop
harvest `machineId` through the harvest-capability route. Binding transfers the
machine capability from any previous token in the same transaction.
`requireHarvestDeviceToken` rejects API keys, unbound device tokens, and
caller-supplied machine identities. Harvest routes consume the machine ID from
the resolved principal.

## Page and model access grants

Legacy `user_page_assignments` remain the default read source.
`access_grants` is an append-only grant/revoke fact stream with a projected
effective assignment view. Assignment mutations dual-write the legacy row and
grant facts. `ACCESS_GRANTS_READ_ENABLED` selects which source resolves
effective pages. Model-scope grants expand to page assignments via
`packages/db/src/repositories/access-grants.ts`; owner routes grant/revoke model
access and list the resulting grant history.

`canAccessPage` is the common page predicate. Route-specific services still
resolve labels/IDs and apply it at the data boundary. Revenue routes have an
additional `REVENUE_ROUTE_ROLE_ENFORCEMENT` log/enforce switch because page
membership alone does not make a bearer principal a dashboard revenue reader.

## Configuration registry

`packages/shared/src/config.ts` parses environment variables into `AppConfig`.
`packages/shared/src/config-registry.ts` provides the metadata catalog used by
validation and the dashboard: key/env/field mapping, value kind, default,
subsystem, editability, runtime-apply mode, dependency graph, destructive/cost
labels, and comparison rules.

Editability and application timing are independent:

- `never` keys are not writable through the admin config API;
- `editable` keys use the ordinary audited PATCH path;
- `staged` keys use the staged transition path and dependency/order checks;
- `live` values are overlaid at each wired read site;
- `boot` values apply on process restart through boot override loading; and
- `none` values are displayed/validated but are not dynamically overlaid.

`packages/shared/src/config-settings.ts` validates values, staged transitions,
dependency closure, AI transcript-mode transitions, boot application, and
effective source attribution. Desired overrides and audit history live in
`config_settings` and `config_audit_log` through
`packages/db/src/repositories/config-settings.ts`.

## Admin config API and running truth

`apps/runtime/src/modules/ops/index.ts` exposes owner-only list, ordinary PATCH,
staged PATCH, and override-delete routes. Mutations are audited; staged changes
use `apps/runtime/src/services/staged-config.ts` and an advisory lock so a
dependency group cannot be changed concurrently.

`apps/runtime/src/services/effective-config.ts` applies only wired live values
to request/job reads. `apps/runtime/src/services/runtime-heartbeat.ts` publishes
each API, worker, and scheduler process's sanitized running snapshot and skipped
boot overrides to `runtime_instances`. `apps/runtime/src/services/app-config-service.ts`
combines registry metadata, desired overrides, environment baselines, and fresh
heartbeat snapshots so the dashboard can show source, drift, pending apply,
secret masking, and process disagreement. Stale instance rows fall out by TTL.

The configuration UI is
`apps/dashboard/src/pages/settings/ConfigurationTab.tsx`; user, assignment,
device-token, harvest, and grant controls are under the other settings tabs.
Auth/config behavior is covered by `tests/auth-*.test.ts`,
`tests/device-token-lifecycle.integration.test.ts`,
`tests/harvest-capability.integration.test.ts`,
`tests/identity-grants.integration.test.ts`, and `tests/config-*.test.ts`.
