# Stage 20 — Generated SDK + dashboard adoption + cross-repo gates

**Repo(s):** core (+CI wiring in desktop/extension) · **Depends on:** 19 ·
**Passport:** roadmap.md §4, stage 20

**Status header — DP 10 distribution decided (owner-confirmed 2026-07-04):**
**distribution = git-tag installs** (`"@kernel/sdk": "github:<org>/core#sdk-vX.Y.Z"` or a tarball
release asset), NOT a private npm registry. Owner's criteria: not-too-complex, stable (nothing to
break/host), and legible to AI agents. Git-tag installs meet all three — zero new infrastructure,
the mechanism is one line in `package.json` a human or agent reads at a glance, and there is no
registry service that can go down. **Agent-legibility requirement (binding):** the mechanism is
documented in the SDK package README + each consumer repo's CLAUDE.md (Stage 35) as a short
"how the SDK is versioned and pinned" section, so a fresh agent session finds it in one place. A
private registry stays the documented upgrade path only if bump-PR friction ever proves it out —
not now.

## 1. Context

The contract pipeline stops one step short: 129/129 Zod schemas (`packages/contracts/src/routes.ts`,
registry at `:3717`) generate an OpenAPI snapshot plus a 14,753-line `api-types.ts` that
**nothing imports** (verified — only re-exported by `contracts/src/index.ts:2`, zero symbol
consumers), while the dashboard hand-rolls `fetch` through a 69-line wrapper
(`apps/dashboard/src/api/client.ts`, 99 call sites across 16 domain modules) and the desktop
hand-verifies against a committed snapshot from 2026-06-11. This stage completes the pipeline in
the direction that works: generate `@kernel/sdk` **from the Zod contracts directly** (runtime
validation for free; sidesteps the verified `$ref`-less OpenAPI — no `$id`/`addSchema` anywhere),
adopt it fully in the dashboard, and turn cross-repo sync into a failing build.

**Entry criteria restated as facts to verify:**
- Stage 19 exited: contracts carry `auth`; module structure stable; `contracts:generate` clean.
- Special-shape route inventory for the generator (verified): SSE `events/stream` + AI
  `ai/gateway/stream`; snapshot `events/snapshot`; wildcard proxy `ofapi/read/*`
  (`server.ts:1586`); HMAC webhook `POST /ofapi/webhook` (excluded from SDK); cookie-session
  routes vs bearer routes (both auth modes must be pluggable).

**Deliverable:** `packages/sdk` generated as a core build step; dashboard on it end-to-end (old
client deleted, lint-banned); `api-types.ts` deleted; desktop/extension repos carrying pinned
versions + contract-hash drift CI **proven** by a deliberate breaking change failing their
builds; scheduled bump-PR flow.

## 2. Changes

**core — `packages/sdk` + generator** (`packages/contracts/src/generate-sdk.ts`, run by an
extended `contracts:generate`):
- Emits per-operation typed methods from `routeSchemas` (name = registry key): params/query/body
  typed by the source Zod schemas (imported, not duplicated), responses **runtime-validated**
  with the same schemas (the desktop's hand-practice automated).
- **Method/path source** — `routeSchemas` entries carry neither (schemas + `auth` only after
  Stage 19). The generator recovers `{method, path}` per key the way `generate.ts` already
  does: boot `buildApiServer` (`generate.ts:8-55`) and collect registered routes via an
  `onRoute` hook, joining each route back to its `routeSchemas` key by schema-object identity
  (`routeOptions.schema === routeSchemas[key]`). A generator assertion fails on any unjoined
  route or unused key (the same 128/129 reconciliation as Stage 19's CI gate). Fallback if
  introspection proves brittle: add explicit `method`/`path` fields to the registry entries.
- Auth plumbing: cookie mode (dashboard) and bearer mode (clients) behind one
  `createKernelClient({ baseUrl, auth })`; 401 hook; retry/error taxonomy (`KernelApiError`
  with typed categories: auth/validation/conflict/rate-limit/server — mapped from status +
  error envelope).
- SSE helpers: `subscribeSyncEvents({ lastEventId, onFrame, onSnapshotRequired })` wrapping the
  v1 contract (frame union from `syncEventSchema`, `routes.ts:2924-2934`; 409 →
  `sync_snapshot_required` flow; Last-Event-ID resume) — v2 added in Stage 21; AI stream helper
  for `ai/gateway/stream`.
- Escape hatches: per-route `raw()` access + an explicit exclusion list (webhook, `ofapi/read/*`
  wildcard gets a thin passthrough helper), documented per passport.
- Versioning: SDK version = core version + **contract hash** (sha256 over the generated surface)
  embedded in the package; `sdk-vX.Y.Z` git tags published by the release step.
- The OpenAPI artifact (`reference/agency-hub.openapi.json`) continues as documentation;
  `generate.ts:58` stops emitting `api-types.ts`; the file + its re-export are **deleted**
  (14,753 dead lines).

**core — dashboard adoption** (`apps/dashboard`): the 16 `src/api/*` domain modules re-implement
over SDK operations (mechanical: each `api.get<T>(url)` → the typed operation; `T` casts die —
types now flow from the SDK); `client.ts` deleted; ESLint (Stage 19's config) bans
`import … from "./client.js"` and direct `fetch` in `src/api/`; React Query keys/hooks unchanged
(same data shapes — `z.infer` types are identical by construction).

**cross-repo — drift gates (CI wiring only; adoption is Stages 24/32):**
- Desktop: CI job pins `@kernel/sdk` version + asserts its embedded contract hash against
  core@main's published hash (a tiny fetch script); failure = drift. Scheduled weekly bump-PR
  (GH Action opening a PR updating the pin).
- Extension (still npm/commonjs until Stage 32): a standalone `check-kernel-contract.mjs` doing
  the same hash comparison — no SDK import required (passport's note honored).
- The gate is **proven**: a deliberate breaking change on a core branch (rename one response
  field) must fail both client repos' drift jobs before this stage exits.

## 3. Schema & data migration

**No schema change. No data migration.**

## 4. Client compatibility

- **Dashboard:** internal-only change; same requests on the wire (paths/bodies identical — the
  SDK is generated from the same schemas the server enforces). Visual/behavioral diff expected:
  none; React Query cache keys preserved.
- **Desktop / extension:** untouched at runtime — they gain CI gates only; their hand-written
  clients keep working until Stages 24/32.
- **Workboard:** the SDK is its future substrate (Stage 34) — nothing to do now.

**Compatibility invariants (target §14):** none touched; the SDK consumes existing contracts, it
does not change them.

## 5. Tests & verification

**New tests:** SDK round-trip suite — every operation validated against fixtures (generated
request → server (test instance) → response validates against schema); auth-mode tests (cookie +
bearer); SSE helper conformance against the v1 protocol tests; generator determinism (two runs →
identical output, hash stable); dashboard smoke (vite build + the existing page tests over the
SDK).

**Existing suites:** dashboard test suite (`tests/dashboard-*.test.ts` naming) green; full API
suite untouched.

**Production verification (exit criteria):**
- Dashboard runs on the SDK only: lint ban green, `client.ts` gone, `grep -r "fetch(" src/api`
  = 0.
- A deliberate breaking change on a branch fails desktop + extension drift CI (screenshot/log
  recorded here — gate proven, not assumed).
- `api-types.ts` deleted; `contracts:generate` output stable in CI.
- One dashboard release cycle in production with no API-shape incidents.

## 6. Rollback

- Dashboard adoption is per-domain-module revertable (git); the old client can be restored from
  history in minutes.
- SDK generation is additive build output; disabling the generator restores the status quo.
- Drift gates are CI-only — disable the job to unblock an emergency in a client repo.
- No irreversible step (deleting `api-types.ts` is git-recoverable and provably unused).

## 7. Assumptions

1. **Zod contracts remain 129/129 the source of truth** and `zod@^4` stays the pinned major in
   both contracts and SDK consumers (version skew between zod majors across repos is the one
   known sharp edge — pin and document).
2. **The dashboard's `z.infer` types are exactly the SDK's** (same schemas) — adoption is
   type-neutral by construction; any type error during migration is a latent bug being surfaced,
   not SDK breakage.
3. **Git-tag distribution is acceptable to the owner** (Status header proposal); the desktop/
   extension repos can install from a git host they already access.
4. **The extension stays npm/commonjs until Stage 32** — its gate is the standalone script, not
   an SDK install.
5. **`readonly` publishing constraints:** the SDK package contains generated code only; no
   hand-edits (banner + CI check, per target §12.2 machine-generated rules).

## 8. Task breakdown

1. **Generator + `packages/sdk` (operations, auth, error taxonomy) + determinism test.** *(1–1.5
   sessions)*
2. **SSE/AI stream helpers + conformance tests.** *(0.5–1 session)*
3. **Dashboard adoption ×16 modules + lint ban + delete old client.** *(1–1.5 sessions)*
4. **Delete `api-types.ts` + generator cleanup.** *(≤0.2 session)*
5. **Drift gates in both client repos + bump-PR action + prove-the-gate drill.** *(0.5–1
   session)*
6. **(Last) Release; one dashboard production cycle; record gate-proof + results here.** *(ops)*

---

## Progress

**Session 1 (2026-07-05 night, branch `kernel/stage-20-generated-sdk` off the Stage 19 tip
5f83cb1 — ORDERING DEVIATION like #73–#75, owner "continue it and next stages": built on
green-local Stage 19, deploy follows Stage 19's):**

Pre-flight drift notes: registry is 132 keys (spec's 129 — stages 10/11 added routes);
`api-types.ts` confirmed consumer-free (index re-export only); core package.json has NO version
field → SDK base version pinned "0.1.0", real identity = KERNEL_CONTRACT_HASH; release-step tags
own versioning (Task 6).

§8 checklist:
- [x] **Task 1** (e18aa4e) — generator + `packages/sdk` + runtime + determinism. DESIGN: the
  generated package is deliberately tiny (operations manifest recovered from Stage 19's
  `server.routePolicyTable` with a total-join assertion + contract hash + re-exports + README
  documenting DP 10 git-tag pinning); ALL moving parts live in
  `packages/contracts/src/sdk-runtime.ts` — per-operation methods and request/response types are
  MAPPED generically off `typeof routeSchemas` (z.input request / z.output response), no mass
  codegen. Runtime response validation against the same schemas; cookie/bearer auth + 401/403
  hook; KernelApiError taxonomy; `raw()` escape hatch; exclusion list
  {webhook, eventsStream, aiGatewayStream, ofapiReadGateway, adminOfapiCreditsLedgerCsv}.
  **Contract hash = sha256 of the normalized OpenAPI document** (NOT the manifest) so
  schema-shape renames move it — the drift-drill property, pinned by test.
- [x] **Task 2** (3149f2f) — `subscribeSyncEvents` (Last-Event-ID resume, frame validation,
  409→onSnapshotRequired, no auto-reconnect by design), `streamAiGateway` (event:ai frames),
  `ofapiRead` passthrough. Conformance on fake streams + LIVE server (seeded journal replay
  through the helper; ahead-of-journal cursor → parsed snapshot payload).
- [x] **Task 3** (2d536cf, same session) — dashboard fully on the SDK: 15 domain modules over
  `src/api/sdk.ts` (cookie mode; onAuthError got an OPERATION key arg so a failed `login` stays a
  form error while expired sessions redirect); client.ts + utils.ts DELETED; ApiError consumers →
  KernelApiError; CSV download via raw(); React Query keys byte-stable; workboard v2 keeps the
  comma-joined `status` wire shape. Loose hook params vs strict contracts resolved with localized
  `Parameters<typeof kernel.X>[0]["query"|"params"|"body"]` casts (hook signatures unchanged).
  MECHANISM SUBSTITUTION (recorded): the lint ban is a TEST (tests/dashboard-sdk-ban.test.ts —
  no direct fetch in src/api, no client resurrection, every module through ./sdk.js) because the
  dashboard tree is not ESLint-covered; same precedent as the contracts auth gate. Aliases added
  in dashboard tsconfig/vite, root vitest, and tsconfig.base (root tsc follows test imports into
  dashboard sources — without the base mapping it cascades phantom implicit-any errors).
  Dashboard `tsc -b` + `vite build` green; dashboard suite 18 files/113 green.
- [x] **Task 4** (e268f53) — `api-types.ts` deleted (14,753 lines) + openapi-typescript dep
  dropped + generator emission removed. Done EARLY (before Task 3): verified consumer-free, so
  adoption order doesn't depend on it.
- [ ] **Task 5** — drift gates in desktop/extension + bump-PR action + prove-the-gate drill
  (breaking change must fail both repos' CI). Cross-repo; needs owner-visible PRs.
- [ ] **Task 6** — ops: release step publishing `sdk-vX.Y.Z` tags; one dashboard prod cycle.
  NOTE for the release step: external git-tag installs need the SDK to carry its runtime — either
  bundle contracts into the tag artifact or vendor sdk-runtime at publish; decide there.

Key facts for resuming sessions:
- SDK tests: tests/sdk-runtime.test.ts (fake fetch/streams, 13) + tests/sdk.integration.test.ts
  (live server round-trips both auth modes, SSE conformance, determinism, 7).
- `createClient` (generated index) = `createKernelClient(kernelOperations, options)`.
- Node-side cookie flows: pass `headers: { cookie }` (fetch has no jar); browser uses
  `auth: { mode: "cookie" }` → credentials: "include".

**Session 1 addendum — Task 3 landed same session (2d536cf).** Remaining: Task 5 (drift gates in
desktop/extension CI + weekly bump-PR action + prove-the-gate drill — cross-repo, owner-visible)
and Task 6 (release step: sdk-vX.Y.Z tags; bundle the contracts runtime into the tag artifact for
external installs). Full suite after the last commit: decisions.md #91.
