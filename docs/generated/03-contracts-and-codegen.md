> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 349, 2026-09-15):** `routes.ts` gained the account-link,
> password-sign-in, own-device and own-usage schemas; `errorResponseSchema`
> gained an optional `reason`; `deviceTokenItemSchema` gained
> `lastClientVersion` and `adminUserSchema` gained `registrationState`.
> `KERNEL_SDK_VERSION` is 0.2.0 and `scripts/vendor-sdk.mjs` reads the version
> from the generated meta instead of a literal.
>
> **STALE (Decision 353, 2026-09-15):** the API-key lane no longer exists. The
> `apiKey` contract kind keeps its historical NAME but admits only a device
> token; `authMethod` is `session | device_token`; the `api_keys` routes,
> service, repository functions and CLI group are gone, as are the cookie
> issuance routes and the HTTP create-user/set-password. A bearer matching no
> lane prefix is refused with no lookup. `must_change_password` is retired (no
> gate, no 403 `password_change_required`, `mustChangePassword` a deprecated
> wire constant `false`) and `content_manager` left the wire role enum. The
> `api_keys` table, the column and the PG enum value all stay as facts.

# API contracts, code generation and the SDK boundary

`packages/contracts` is the declarative HTTP boundary. Its Zod registry drives
server validation, auth policy, normalized OpenAPI, contract hashing and the
typed SDK used by the dashboard and vendored into both client repositories.

## Source package

| File | Responsibility |
|---|---|
| `packages/contracts/src/routes.ts` | Shared wire schemas plus the 160-entry `routeSchemas` registry and per-route auth declaration. |
| `authorization-policy.ts` | Deterministic Markdown renderer for the booted route-policy table. |
| `domain-event-cursor.ts` | Canonical Base64URL JSON v2/v3/v4 cursor codecs and recovery proof shapes. |
| `sdk-runtime.ts` | Typed request/response derivation, `KernelClient`, errors, raw calls and stream helpers. |
| `contract-hash.ts` | Generated public hash over the exact normalized OpenAPI bytes served by this build. |
| `generate.ts` | Boots the real route composition with a synthetic no-DB AppContext and writes all artifacts. |
| `generate-sdk.ts` | Deterministically validates the registry/route table and emits `packages/sdk`. |

`packages/contracts/src/index.ts` exports all five runtime contract modules,
including the generated hash. Shared enum/value vocabularies come from
`packages/shared`; money fields use integer wire schemas while DB codecs retain
unit ownership.

## Auth contract

`RouteAuthPolicy` is strict and supports `public`, `hmac`, `monitoring`,
`session`, `any-session`, `owner-session`, `apiKey`, `device-token`,
`pending-device-token`, and `any`, with optional roles and page scope. OpenAPI
security is derived from this value. HMAC remains prose-described because its
raw-body signature is not representable by the declared schemes.

The route registry currently produces 160 operations. Auth declaration tests
and the server's fail-closed policy prevent an undeclared operation from
silently becoming public.

## `pnpm contracts:generate`

`packages/contracts/src/generate.ts` builds the actual Fastify server with an
empty database URL and stubbed DB/platform objects, waits for route
registration, normalizes Swagger output, and writes four artifact families:

1. `reference/agency-hub.openapi.json` — sorted normalized OpenAPI; the credit
   ledger response is normalized to `text/csv`.
2. `packages/contracts/src/contract-hash.ts` — SHA-256 of those exact JSON
   bytes, used by live `/health` as well as the SDK.
3. `docs/generated/authorization-policy.md` — auth rows from the same booted
   route table.
4. `packages/sdk/` — operation manifest, meta/hash, re-exports, package metadata
   and README.

The current hash is
`43ef5d6bc14de1d41965c5b7dd40ea122c8b8325c0f3a3dfb0ec6aabc459d289`;
SDK version is `0.1.0`.

CI runs the generator and then requires zero diff across OpenAPI,
`contract-hash.ts`, `packages/sdk`, and `authorization-policy.md`. This catches
an edited `routes.ts` even if the previously committed generated artifacts were
internally consistent with each other.

## Generated SDK

`packages/sdk/src/operations.ts` is the sorted `{method,path}` manifest.
`meta.ts` exports the hash/version; `index.ts` creates the typed client and
re-exports route schemas, cursor decoder, stream helpers and frame types.

`sdk-runtime.ts` derives every input and success response from the matching Zod
schema. It provides:

- cookie or bearer auth and shared headers;
- encoded path/query construction;
- structured `KernelApiError` categories;
- an `onAuthError` hook for ordinary methods and for raw/SSE 401/403 paths;
- `streamAiGateway`, `streamAiFeature`, `subscribeSyncEvents`,
  `subscribeDomainEvents`, `ofapiRead`, and `decodeDomainEventCursor`.

The AI feature stream frame is a superset of the raw gateway frame because it
can carry the capability-gated prompt debug-input frame.

Six operations lack a plain request/JSON response shape and are excluded from
ordinary client methods: webhook receive, v1/v2 event streams, raw AI gateway
stream, OFAPI wildcard read, and the CSV ledger. They remain addressable by
`client.raw()` and dedicated helpers.

## Vendored client package

`scripts/vendor-sdk.mjs <target-dir>` stages the dependency-free shared subset,
contracts (including `contract-hash.ts`) and generated SDK files; rewrites
workspace imports; compiles with core's TypeScript/Zod; and ships JS,
declarations, package metadata and `kernel-sdk.vendor.json`.

The vendor manifest contains `{contractHash, sourceCommit, source}`. The script
refuses a dirty source tree by default because the commit would not reproduce
the bytes. `--allow-dirty` is explicitly experimental and stamps
`<sha>-dirty`, which cannot masquerade as a clean snapshot.

The in-workspace dashboard resolves `@kernel/sdk` directly. The desktop and
extension consume compiled vendored copies and compare their manifest hash to
core. The health endpoint exposes the same generated hash so release gates can
compare a running build without inferring compatibility from a route-local
authentication response.

## Drift and integrity gates

- Generator/CI freshness ties `routes.ts` to OpenAPI, hash, SDK and policy.
- `generate-sdk.ts` rejects duplicate route keys and registry/registration
  mismatches and is deterministic for identical input.
- Contract-auth tests require valid declarations and OpenAPI security mapping.
- Dashboard architecture tests prevent hand-written API clients where the SDK
  owns the operation.
- Vendoring's clean-tree guard protects source-commit provenance, including
  generator scripts and toolchain inputs rather than only copied sources.
