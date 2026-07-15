# Stage 19 — API decomposition + declarative authorization

**Repo(s):** core · **Depends on:** — (hard); recommended after 18 · **Passport:** roadmap.md §4,
stage 19

**Status header — one enabler added (flag for sign-off):** the passport's "lint-enforced import
boundaries (the desktop's `no-restricted-imports` pattern)" requires a linter; **core has none**
(verified — no eslint/biome config exists). This stage bootstraps a minimal ESLint flat config
whose ONLY rules are the module-boundary restrictions (+ the auth-declaration gate as a
contracts-package unit test, linter-independent). Full family lint standard remains Stage 35's.

## 1. Context

`server.ts` is 3,583 lines with 128 route registrations against 129 `routeSchemas` entries, and
authorization is ~150 imperative in-handler calls (`requirePrincipal`/`requireDashboardUser`/
`requireOwner`/`requireApiKeyUser`/`canAccessPage` — e.g. `server.ts:808-816,865-867,1350`).
"Who can do what" is unananswerable without reading every handler, and the chatter-reads-revenue
class of hole (interim-patched in Stage 2) can silently return. This stage decomposes the API
into bounded-context modules and makes every route carry a declarative `auth` block enforced by
one middleware; a route without one fails CI.

**Entry criteria restated as facts to verify:**
- Route inventory frozen for the stage's duration (no concurrent route-adding stages in flight —
  sequencing rule 6 analog).
- Contract tests green; `contracts:generate` clean (`package.json:21` →
  `packages/contracts/src/generate.ts`).
- Stage 2's interim gates deployed (`REVENUE_ROUTE_ROLE_ENFORCEMENT` in `enforce`) — they are
  re-expressed declaratively here and the env dies.
- If Stage 18 shipped: module extraction lands on the post-seam layout; if not, extraction still
  proceeds (the passport keeps 18 soft).

**Deliverable:** ten modules under `apps/runtime/src/modules/` each owning routes+service+repo
wiring; `auth` blocks on all 129 schemas enforced by one middleware; a generated policy table in
`docs/generated/`; behavior change ZERO for well-behaved clients (proven by log-only diff).

## 2. Changes

**core — module extraction** (`apps/runtime/src/api/server.ts` → `apps/runtime/src/modules/`):
per target §6.1 — `identity` (auth/sessions/users/api-keys), `catalog` (models/pages/credentials/
proxies), `ingest` (webhook receiver, Stage 11 lane, observations admin), `conversations`
(threads/messages/archive/fan profiles), `finance` (transactions/revenue/spenders/reporting),
`audience` (fans/subscriptions/follows/presence), `workboard`, `ai` (gateway/usage), `ops` (sync
health/credits/incidents/config/diagnostics), `events` (stream+snapshot). Each module exports
`registerRoutes(scope, ctx)` + a service interface; `buildApiServer` (`server.ts:423`) becomes
the composition root. **Move-don't-rewrite**: handler bodies relocate intact; route paths and
schemas byte-identical (`routeSchemas` keys unchanged — the OpenAPI diff gate proves it).

**core — declarative auth** (`packages/contracts/src/routes.ts` + one middleware):
- Every `routeSchemas.X` entry gains
  `auth: { kind: 'session'|'apiKey'|'any'|'owner-session'|'monitoring'|'public'|'hmac',
  roles?: Role[], scope?: 'page'|'none' }`. The vocabulary must cover the verified specials:
  webhook HMAC (`/ofapi/webhook`), monitoring token (`requireSyncHealthAccess`, `server.ts:531`),
  swagger owner-gate (`:547`), login/health `public`.
- One `onRequest` middleware per module scope resolves the principal (existing
  `resolvePrincipal`, `server.ts:475-499`), checks `kind`/`roles`, and resolves `scope:'page'`
  via the proven `assignedPageIds` shape (`auth.ts:82`, `canAccessPage` `auth.ts:712-718`,
  `pageScopeFor` `server.ts:277-278`) — **before any handler runs**. In-handler guard calls are
  deleted as each module migrates (the middleware subsumes them); `canAccessPage` remains for
  param-derived page ids (the middleware handles declared `:pageLabel` params generically).
- **Log-only first** (Stage 2's proven pattern): `AUTH_POLICY_ENFORCEMENT=log|enforce` — in
  `log`, the middleware computes its verdict, compares with what the handler's legacy guards
  decide, and logs divergences; after 48 h of zero unexplained divergence per module, flip.
  Stage 2's `REVENUE_ROUTE_ROLE_ENFORCEMENT` env retires into the declarations.
- **CI gate:** a `packages/contracts` unit test iterates all `routeSchemas` keys and fails on
  any entry without `auth` — linter-independent, cannot be skipped silently.
- OpenAPI: `generate.ts` derives `security` from `auth` — the spec stops being able to lie;
  the generated **policy table** (`docs/generated/authorization-policy.md`: route × kind × roles
  × scope) is emitted by the same generator run, with the standard machine-generated banner.

**core — ESLint bootstrap (enabler):** flat config at repo root; rules: `no-restricted-imports`
walls (modules import each other only via `modules/<name>/index.ts`; nothing outside `ingest`
imports repositories of another module's tables — enforced by path patterns), plus the
`platform ===` and egress bans arriving in later stages hook in here. `pnpm lint` added to CI
alongside `typecheck`.

## 3. Schema & data migration

**No schema change. No data migration.** (The policy table is a generated doc, not DB state.)

## 4. Client compatibility

- **Desktop:** zero change — its routes (`ai-usage/batch`, `ai/gateway/stream`, `events/*`,
  `ofapi/credits/summary`, `ofapi/read/*`, `ofapi/commands*` — Stage 2's verified inventory)
  declare `kind:'apiKey'` with today's exact semantics; the log-only diff proves no tightening
  hits them.
- **Extension:** zero change — spenders/fan-search/fan-profiles stay `apiKey`+page-scope
  (Stage 2's carve-out honored declaratively).
- **Dashboard:** zero change — session routes keep `requireDashboardUser`-equivalent
  declarations; admin stays owner.
- **Workboard:** n/a (module routes get declarations like everything else).

**Compatibility invariants (target §14):** chatter bearer keys, fan-profile PUT/GET, read-gateway
path shape, SSE endpoints — all unchanged; any tightening beyond Stage 2's is deliberate and
listed in the stage's completion note (passport rule).

## 5. Tests & verification

**New tests:** per-module role-matrix integration tests (each auth kind × a representative route:
correct 200/401/403 grid); the no-`auth`-entry CI gate (self-tested by adding a schema without
auth in a fixture); middleware scope test (chatter key + unassigned page → 403; owner bypass);
policy-table generation snapshot test.

**Existing suites:** the full API integration suite (`tests/api.integration.test.ts` + friends)
green with zero expectation changes — the whole point.

**Production verification (exit criteria):**
- 48 h log-only: zero unexplained divergence between middleware verdicts and legacy guards, per
  module, then enforce.
- Generated policy table diffed route-by-route against pre-stage observed behavior — every
  difference is either Stage 2's known tightening or listed + justified.
- Well-behaved clients unaffected: desktop/extension error rates flat across the flip (server
  4xx metrics by route).

## 6. Rollback

- `AUTH_POLICY_ENFORCEMENT=log` reverts enforcement instantly, module by module if needed.
- Module extraction is mechanical relocation — revertable per module; route paths never changed.
- No schema, no data, no irreversible step.

## 7. Assumptions

1. **§2.6's client route inventories are still current** (re-grep both client repos for route
   strings at execution — same check Stage 2 specified).
2. **129/129 Zod contracts remain the single route source** (`routes.ts:3717` registry); no
   route exists outside `routeSchemas` (verify: 128 registrations vs 129 schemas — reconcile the
   off-by-one at execution; one schema may be unused or one route double-registered).
3. **No new principal kinds yet** — the middleware's `kind` vocabulary is designed to accept
   `deviceToken` additively in Stage 22 without re-touching declarations.
4. **Stage 2's gates are live** and their semantics are the floor the declarations must
   reproduce exactly.
5. **The swagger/docs owner-gate and monitoring-token specials** stay as-is, expressed in the
   vocabulary rather than as hook exceptions.

## 8. Task breakdown

1. **Auth vocabulary + middleware + log-only plumbing + CI no-auth gate.** *(1 session)*
2. **Annotate all 129 schemas** (mechanical, from the current in-handler guards; the off-by-one
   reconciled). *(1 session)*
3. **Module extraction ×10** (parallelizable in pairs; each module: move routes+service wiring,
   delete subsumed guards, role-matrix test). *(3–4 sessions)*
4. **ESLint bootstrap + boundary rules.** *(0.5 session)* *(parallel)*
5. **Policy-table generation + OpenAPI security derivation.** *(0.5 session)*
6. **(Last) Deploy log-only → 48 h diff review per module → enforce; record the policy diff and
   results here.** *(ops)*

---

## Progress

**Session 1 (2026-07-05, branch `kernel/stage-19-api-decomposition` off the Stage 14 chain tip 23e827c):**

Pre-flight (all §7 assumptions re-verified against code):
- Route inventory TODAY: **132 routeSchemas keys ↔ 132 registrations, 1:1** (spec's 129/128
  off-by-one RECONCILED: the webhook registers via `instance.post` inside its own plugin scope
  for the buffer body parser — my count, not a dangling schema; stages 10/11 added archive/ingest
  routes since the spec was written).
- Client inventories re-grepped (Explore agent): desktop (kernel/stage-12-harvest) calls pages,
  fan-profile GET/PUT, auth/me, ai-usage/batch, ingest/observations, ofapi credits/read/commands,
  ai gateway stream, events stream+snapshot — ALL bearer-key ⇒ those routes must be kind:"any" or
  "apiKey", NOT "session". Extension (bar-tone-menu) calls pages, conversation profile GET, fan
  profile PUT, ai-usage/batch with bearer keys; it does NOT call spenders/fans-search on this
  branch (baseline drift noted, no action — declarations mirror handlers, not clients).
- ai-usage/batch is apiKey-only DE FACTO (requireApiKeyUser inside services/ai-usage.ts:79).
- Page-scope semantics uniform: findPageSummaryByLabel→404, canAccessPage→403 (services'
  resolveAccessiblePage/resolveAccessibleDmPage/resolveAccessibleFanslyPage all reduce to this).
- Stage 2 gates: prod runs REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce (exited #68) — declarations
  reproduce it as kind:"session" on the 4 revenue routes.

§8 checklist:
- [x] **Task 1** — vocabulary + middleware + log-only plumbing (commit d189b67).
  RouteAuthPolicy zod schema in contracts; `apps/runtime/src/api/auth-policy.ts` verdict engine
  REUSES the legacy guards in try/catch (parity by construction); onRequest verdict hook +
  onResponse divergence log (would-deny = deny&<400, would-allow = allow&401/403);
  AUTH_POLICY_ENFORCEMENT env (default "log", registry editability NEVER like Stage 2's);
  schema-object-identity index (same join generate.ts uses).
- [x] **Task 2** — all 132 schemas annotated (same commit d189b67). Distribution: public 3,
  monitoring 1, hmac 1, any 6, any+page 17, apiKey 10, session 16, session+page 17,
  owner-session 58, owner-session+page 3. CI gate: tests/contracts-auth-declarations.test.ts
  (valid-shape parse + self-test + pinned review of the 37 scope:"page" keys).
  OpenAPI BYTE-IDENTICAL: swagger transform strips `auth`; contracts:generate produced zero diff.
- [ ] **Task 3** — module extraction ×10 (NOT started; see deviation below). NEXT SESSION'S JOB.
- [x] **Task 4** — ESLint bootstrap (commit 3cb9598). eslint + @typescript-eslint/parser root dev
  deps; eslint.config.mjs flat config with ONLY the modules/<name>/index.ts import walls
  (specifier-glob form; verified to fire on a probe file; DORMANT until Task 3 populates
  modules/). `pnpm lint` + CI step after Typecheck. Relative-sibling walls (`../<module>/…`)
  deferred to Task 3 when the layout depth is known.
- [x] **Task 5** — policy table + security derivation (commit 4b8af34). routeSecurityFromAuth
  in contracts; swagger transform injects derived security (hand-set constants deleted, 128
  lines); onRoute collector exposes server.routePolicyTable (Stage 20's SDK generator reuses
  this method/path introspection); generate.ts writes docs/generated/authorization-policy.md.
  **SEVEN justified OpenAPI security diffs** (reference/agency-hub.openapi.json committed):
  4 revenue routes cookie+bearer→cookie-only (documents Stage 2's enforced truth);
  upsertFanProfile bearer→cookie+bearer, pageFanProfileVersions + …/Version cookie→
  cookie+bearer (documents what the handlers actually accept). api-types.ts unchanged.
  tests/contracts-route-security.test.ts rewritten to pin declarations + derivation.
- [ ] **Task 6** — ops: deploy log-only → 48 h per-module diff review → enforce → THEN the
  guard-deletion cleanup slice (see deviation).

**DEVIATION (recorded for decisions.md):** §2's "in-handler guard calls are deleted as each
module migrates" is UNSAFE as written: the whole stage deploys as one unit, so deleting guards
during extraction would leave routes with NO enforcement during the log-only window (middleware
logs, guards gone) and nothing for the divergence diff to compare against. Resolution: Task 3
moves handlers VERBATIM (guards intact); guard deletion is a separate post-enforce-flip cleanup
slice. Protection continuity > code cleanliness.

Key implementation facts for resuming sessions:
- Middleware hooks live in server.ts right after the swaggerUi registration (BEFORE any route
  registration — fastify routes capture hooks at registration time).
- Enforce-mode denial happens BEFORE querystring validation (onRequest); log-mode legacy answers
  can be 400-first — grid tests must pass valid queries to reach legacy guards.
- tests/helpers/runtime.ts gained authPolicyEnforcement + revenueRouteRoleEnforcement overrides
  (both default "log"; integration test pins revenue gate to "enforce" = prod reality).
- Testcontainers suite pattern: startIntegrationTestDatabase() returns null without Docker —
  guard every test with a skip helper.

**Session 1 END STATE:** branch tips at 3cb9598 (4 commits: d189b67 Tasks 1+2, 4b8af34 Task 5,
3cb9598 Task 4, + decision entry). Tasks 1/2/4/5 DONE, full suite result in decisions.md #87.
**Next session = Task 3**: extract the 10 modules (identity, catalog, ingest, conversations,
finance, audience, workboard, ai, ops, events) from server.ts into apps/runtime/src/modules/,
handlers VERBATIM with guards INTACT (deviation above), buildApiServer becomes the composition
root, per-module role-matrix tests, add the relative-sibling lint walls. routeSchemas keys and
paths must stay byte-identical (OpenAPI diff gate). Then Task 6 ops (deploy checklist below).

**Task 6 deploy sketch (owner-gated, after Task 3):** no migrations; deploy is inert
(AUTH_POLICY_ENFORCEMENT defaults to log). 48 h log window: grep api logs for
`auth-policy would-deny` / `auth-policy would-allow` — zero unexplained divergence per module →
set AUTH_POLICY_ENFORCEMENT=enforce in /opt/agency-hub/.env.production + restart → re-probe
(chatter key on an owner route → 403, revenue route → 403, assigned page reads → 200) →
REVENUE_ROUTE_ROLE_ENFORCEMENT env retires with the guard-deletion cleanup slice, not before.

**Session 2 (2026-07-05 late, Task 3 module extraction — 8 of 10 modules DONE):**

Commits (one per module, each verified: typecheck + contracts:generate byte-diff empty + targeted
suites + role matrix): 2ba8c15 scaffold+workboard(15), 383e649 identity(11)+deterministic path
sort, 9f985a6 ai(3), 245df9b events(2+SSE state), f88d611 conversations(9), a0718f6 ingest(8),
bc17a6a audience(12), 72ca544 finance(17). server.ts 3,768 → 2,063 lines; 55 registrations left.

Scaffold facts (binding for the remaining extractions):
- `apps/runtime/src/api/request-auth.ts`: createRequestAuth(appContext) → {resolvePrincipal,
  requirePrincipal, hasValidSyncHealthMonitoringToken, requireSyncHealthAccess, pageScopeFor} —
  helper bodies verbatim; also exports pageScopeFor + auditCtx (shared with un-extracted admin
  routes). `apps/runtime/src/modules/context.ts`: ApiServer type (logger generic must be
  AppContext["logger"], NOT FastifyBaseLogger) + ApiModuleContext {appContext, auth, boss}.
- pg-boss creation MOVED UP in buildApiServer (before any route registers) so moduleContext can
  carry it; onClose stop hook unchanged.
- **normalizeOpenApiDocument now SORTS spec.paths** — extraction shuffles registration order and
  swagger follows it; the one-time reorder diff was proven content-equal by canonicalized-JSON
  comparison (121 path templates). From now on the byte-gate is registration-order-independent.
- Module sorting decisions vs target §6.1: read gateway + ofapi commands → **ingest**
  (observation-producing custody lanes, keeps OFAPI custody with the webhook receiver);
  ofapiCreditsChatterSummary + adminOfapiCredits* → ops (credits); overviewGrowth → audience;
  overview (the big aggregate) → finance; openApiJson stays in the composition root.
- Role-matrix test (tests/auth-policy.integration.test.ts, "per-module role matrix"): one
  representative route per module × {anon,chatter,lead,owner} × BOTH enforcement modes with
  status parity asserted — module-agnostic, survives the remaining extraction untouched.
- Verbatim-move exception log: crossPageTransactions keeps its unused platformByLabel local
  (moved as-is); serializePageMetric duplicated into finance (server.ts copy still feeds
  serializeAssignedPage until catalog extracts).

REMAINING (next session):
- [ ] **catalog** (14 routes): pages, models, adminModels×4, adminPages×4, adminVerifyCredentials,
  adminTestProxy, adminVerifyPage, adminUpdateCredentials. Heavier handlers (onboarding,
  credentials verify, proxy test); needs queueInitialOnboardingSync + initialSync helpers
  (currently server.ts ~914-964; they use boss + requestPageSync), serializeAssignedPage,
  serializePageMetric, isAdminPageVerifyBadRequest, resolvePageContext, onboardFansly/OnlyFansPage,
  saveProxy, assertAllowedProxyTarget, encryptJson, storeFanslySession...
- [ ] **ops** (40 routes, ~1,300 lines): health/healthSync, sync monitor/blocks (5), adminSync×8,
  adminConnections, adminLogs/Queue/DbStats/Incidents, notifications×9, adminConfig×4,
  ofapiCreditsChatterSummary + adminOfapiCredits×6 + spend comparison + dm-archive status.
  Uses recordAudit, requireSyncHealthAccess, boss (sync triggers), drizzle `sql` (db stats).
- [ ] After both: prune remaining dead server.ts imports; add relative-sibling eslint walls
  (`../<other-module>/…` group patterns per final layout); consider modules/README.md pointer.
- [ ] Full-suite gate after the last extraction commit, then Task 6 ops (deploy checklist above).

**Session 3 (2026-07-05 night — TASK 3 COMPLETE, all ten modules extracted):**

Commits: 963db99 catalog (14 routes incl. onboarding + queueInitialOnboardingSync helper family,
credentials verify on the adapter's public surface only, proxy test, Stage 13 tombstone delete);
c8b8137 ops slice 1 (23: health pair, OFAPI credits family incl. hijacked CSV export, sync
monitor + per-page blocks, admin sync triggers, connections); 00fed94 ops slice 2 (17: admin
logs/queue/db-stats/incidents raw-sql reporting, Telegram notifications surface, config surface —
live PATCH / editable clear / advisory-locked staged flips); cd2c17e relative-sibling eslint
walls (gotcha: minimatch `*` matches `..`, so the sibling group needs `!../../**` or every
`../../services/…` import trips it — probe-verified precise).

**END STATE: server.ts = 497-line composition root** (fastify setup + auth-policy middleware +
routePolicyTable collector + requestAuth factory + boss + module registration + swagger/openapi +
error handler + SPA static). All ten target-§6.1 modules own their routes verbatim, guards
intact (deviation #87). Full suite after the last commit: see decisions.md #89.

§8 checklist state: Tasks 1,2,3,4,5 DONE. Remaining = **Task 6 (ops)** only:
1. Owner deploy (inert: AUTH_POLICY_ENFORCEMENT defaults to log; NO migrations in this stage).
2. 48 h log window: grep api logs for `auth-policy would-deny|would-allow`; zero unexplained
   divergence per module.
3. Flip AUTH_POLICY_ENFORCEMENT=enforce in /opt/agency-hub/.env.production + restart; re-probe
   (chatter on owner route → 403, revenue → 403, assigned page reads → 200).
4. AFTER the flip: the guard-deletion cleanup slice (remove in-handler requireX calls the
   middleware subsumes; retire REVENUE_ROUTE_ROLE_ENFORCEMENT env + enforceRevenueRouteRoleScope).
5. Then flip stage row to exited with the prod evidence.
