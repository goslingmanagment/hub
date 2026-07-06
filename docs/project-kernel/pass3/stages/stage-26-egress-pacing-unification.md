# Stage 26 — Egress & pacing unification; auth-dead pause

**Repo(s):** core · **Depends on:** 18 (adapter seam owns the client factory); soft: 19 (its
ESLint config carries the egress ban) · **Passport:** roadmap.md §4, stage 26

**Status header — one verified correction:** the passport's "typed auth-death detection (not
substring matching)" is **already true**: direct-sync auth errors are status-code checks
(`isAuthError` = 401/403, `executor.ts:66-68`; Fansly `adapter.ts:530-538`; OnlyFans
`packages/onlyfans/src/adapter.ts:437-444`) and OFAPI auth statuses are an exact Set
(`OFAPI_AUTH_ACTION_REQUIRED_STATUSES`, `ofapi-account-health.ts:30-34`). What's missing is not
typing but **semantics**: auth death lands as `blocked` (`blockPageSync`,
`executor.ts:501-516`), not `paused`, and OFAPI-webhook-signaled auth death doesn't pause the
page's REST streams at all. The stage's auth-dead work is the *pause wiring*, re-scoped
accordingly.

## 1. Context

Three egress behaviors coexist (verified): gateway reads ride the per-page proxy dispatcher
(`proxyReadRequest` sets `init.dispatcher = context.dispatcher`, `ofapi.ts:713-741`); background
OFAPI DM/list sync and **command sends** hit the OFAPI gateway with plain `fetch` — no proxy
(`ofapi.ts:593`, `:1179-1187`); Fansly sync uses its own proxy path. One process-global 500 ms
slot serializes ALL OFAPI traffic (`OFAPI_DEFAULT_REST_DELAY_MS=500`, `ofapi.ts:19,546-557`,
single client instance `bootstrap.ts:171-176`) — a chatter's open chat can queue behind a
backfill. This stage funnels every outbound platform call through one `resolveEgress(account)`
seam with per-account pacing and three priority classes, and wires auth-death to pause + incident.

**Entry criteria restated as facts to verify:**
- Stage 18 stable (adapters own their transports; `platform-core` exists).
- A generated egress inventory reviewed: every outbound call site (grep undici/fetch/dispatcher
  across `apps/runtime` + adapter packages; the three behaviors above are the known set — the
  inventory proves there's no fourth).
- Note for the OFAPI paths: egress consistency to the **vendor gateway** matters less than
  direct-to-platform (Fansly) — but the single-resolver rule applies to both (one policy, no
  default path); record the per-vendor address policy in the resolver.

**Deliverable:** `resolveEgress(account)` as the only HTTP-client path (lint/ratchet-proven);
per-account pacing with interactive > commands > bulk classes; interactive p95 unchanged while a
backfill saturates bulk (staging proof); auth-dead pages pause within one planner cycle with an
incident.

## 2. Changes

**core — the resolver** (`packages/platform-core/egress.ts` + `services/egress/`):
`resolveEgress(account | vendorScope)` → `{ dispatcher, egressKey, pace(class) }`; built from
the existing pieces — proxy resolution (`egress_endpoints` table `schema.ts:218-230`,
`resolveStoredProxyConfig`/`buildProxyEgressKey`, `page-proxies.ts:20-27,256-257`), dispatcher
factories (`packages/shared/src/http-client.ts:40-42,55-96,124-135`), SSRF guard
(`proxy-validation.ts:16-41` — unchanged, stays where it is). The three behaviors migrate onto
it: gateway reads (already per-page — adopt the seam), OFAPI DM/list sync + command sends (gain
an explicit vendor-scope egress context — whether they proxy per-page or per-vendor is the
**recorded address policy**, owner-visible, not an accident of `fetch`), Fansly adapter (adopts
formally). The client factory **requires** an egress context — no default path.

**core — pacing with priority classes:** the DB-backed waiter generalizes
(`sync_rate_limits (provider, scope, egress_key, min_spacing_ms, next_available_at)`,
`schema.ts:503-519`; `reserveSyncProviderRateLimit`, `repositories/sync.ts:2053`): budgets keyed
`(vendor, account)` with a vendor-global cap layered above; three classes — `interactive`
(gateway reads, presence) > `commands` > `bulk` (sync/backfills) — implemented as class-scoped
rows + an **aging floor** for `bulk` (a bulk waiter's scheduled slot may be delayed by higher
classes but never beyond a cap — starvation containment). The 500 ms process-global slot
(`ofapi.ts:546-557`) is replaced by: vendor-global cap row (preserving today's effective
500 ms/vendor rate) + per-account fairness beneath it. **Shadow mode first:** for 48 h the new
waiter computes decisions and logs them while the old policy enforces; diff, then cut over
(passport containment).

**core — auth-dead pause wiring:** on typed auth death — direct-sync 401/403 (`executor.ts:501`)
AND OFAPI `accounts.authentication_failed` events (`ofapi-events.ts:213`,
`ofapi-account-health.ts:56-58`) — the page's streams go to FSM `paused` (vocabulary exists:
`page_sync_status` enum `schema.ts:61-68`; `pausePageSync`, `page-sync.ts:1809`) with
`blocker_kind='auth'` retained for diagnosis; planner already skips paused states (verify — if it
only skips `blocked`, extend); incident opened (existing `notifyAuthFailedIncident` /
`notifyOfapiAuthIncident` — dedup via incident keys); **resume** on successful re-verify
(credential paste flow already re-verifies — wire the unpause there). Quota stops burning on
dead sessions; commands for a dead page fail fast with a typed error instead of spending a
one-attempt send.

**core — enforcement:** ESLint rule (Stage 19's config): no `undici`/global-`fetch` imports
outside `packages/platform-core/egress` + the resolver's own modules; plus a ratchet script for
transitively-reachable raw `fetch(` (day-one count recorded, must decrease to 0).

## 3. Schema & data migration

```sql
-- 00NN_egress_priority_classes.sql
ALTER TABLE sync_rate_limits ADD COLUMN priority_class text NOT NULL DEFAULT 'bulk'
  CHECK (priority_class IN ('interactive','commands','bulk'));
-- vendor-global cap rows seeded for 'ofapi' + 'fansly' (min_spacing preserved from current values)
```
No data migration; profile rows are re-seeded idempotently at boot
(`ensureSyncProviderRateLimitProfile` pattern, `sync.ts:2003`).

## 4. Client compatibility

- **Desktop:** chat reads can only improve under load (interactive class); command latency
  unchanged (one-attempt discipline untouched — crown jewel 2 explicitly not weakened; the only
  command-path change is *which dispatcher/pacer*, never retry semantics).
- **Extension / dashboard / workboard:** none visible.

**Compatibility invariants (target §14):** outbox intake semantics untouched; read-gateway path
shape untouched. Platform-safety crown jewel 4 is the stage's whole point — per-account address
consistency becomes construction, not convention.

## 5. Tests & verification

**New tests:** resolver unit (no-context call throws; per-account key stability); class
scheduling property test (interactive slot never waits behind bulk backlog; bulk aging floor
honored); shadow-mode diff harness; auth-dead integration — a 401 fixture pauses the page's
streams within one planner cycle + incident row + commands fail fast + unpause on re-verify;
lint/ratchet self-tests.

**Existing suites:** sync executor, command executor (one-attempt semantics pinned), gateway,
Fansly adapter suites — all green.

**Production verification (exit criteria):**
- Lint + ratchet prove no direct fetch outside the resolver (CI green, count 0 or on-trajectory
  with the recorded budget).
- Staging: interactive read p95 unchanged while a synthetic backfill saturates bulk (numbers
  recorded).
- 48 h shadow diff reviewed → cut over → 48 h enforced with sync telemetry flat
  (`sync_runs` outcome ratios unchanged).
- An auth-dead page (staged credential kill on staging; or the next natural death in prod)
  pauses within one planner cycle and alerts; per-account egress-address consistency verified in
  logs (egress key ↔ address sampling).

## 6. Rollback

- Shadow mode IS the rollback posture — flip enforcement back to the old policy (env) at any
  point in the window; per-account cutover, never global (passport).
- Pause wiring reverts to block-only by code revert; incidents unaffected.
- Migration is additive (a default-valued column); no destructive step.

## 7. Assumptions

1. **Per-page proxy assignment remains the egress-identity mechanism** (`egress_endpoints`);
   vendor-gateway paths (OFAPI) keep their recorded address policy — the resolver makes the
   policy explicit rather than changing it silently.
2. **Vendor rate-limit shapes** per the vendored OFAPI spec (roadmap §2.3) — the vendor-global
   cap preserves today's effective rates on day one; tuning is a knob change later.
3. **Planner pause semantics**: `paused` states are skipped by the planner (verify at execution;
   the pause/resume sweep precedents exist — `onlyfans-dm-polling.ts:97-117`).
4. **Stage 18's seam is stable** — adapters expose their transport needs through
   `platform-core`; no handler builds its own client anymore.
5. **The one-attempt command discipline is untouchable** (crown jewel) — any test flake around
   command pacing resolves in favor of the old behavior.

## 8. Task breakdown

1. **Egress inventory generation + resolver + factory-requires-context + SSRF unchanged.** *(1
   session)*
2. **Priority classes in the waiter + vendor caps + aging floor + shadow mode.** *(1–1.5
   sessions)*
3. **Migrate the three behaviors onto the resolver (per-account cutover order: Fansly → gateway
   reads → OFAPI background → commands last).** *(1 session)*
4. **Auth-dead pause + resume wiring + fail-fast commands.** *(0.5–1 session)* *(parallel with
   2)*
5. **Lint rule + ratchet + budgets.** *(≤0.5 session)*
6. **(Last) Shadow 48 h → diff review → cutover → staging saturation test + prod checks; record
   results here.** *(ops)*

## Progress

**Session 1 (2026-07-06, chain branch `kernel/stage-21-event-stream-v2` @ ed99b16; decision
#100; ordering deviation: built on green-local Stage 18 per the #98/#99 pattern):**

§8 status — **Tasks 1, 2, 4, 5 DONE; Task 3 PARTIAL (recorded); Task 6 = ops.**

- [x] **Task 1** (d7ea175) — egress inventory generated (three known behaviors confirmed; no
  fourth; telegram + anthropic recorded as non-platform exceptions; one false positive — a
  local closure named `fetch` — renamed). platform-core owns the egress SHAPE;
  services/egress/resolver.ts is THE resolver with recorded address policies (page = proxy
  identity; vendor:ofapi = vendor-direct; vendor:fansly = REFUSED). No default path.
- [x] **Task 2** (d7ea175) — migration 0069 priority_class; class rows + vendor caps on the
  existing DB waiter. DESIGN CORRECTION recorded in #100: single-pass [vendor, class]
  reservation drags the vendor horizon out with bulk's backlog (reserve pushes every locked
  row to scheduledAt+spacing) — the working mechanism is TWO-PHASE BULK (class slot first,
  vendor claim only at imminent send). Shadow mode = EGRESS_PACER_MODE (off default,
  deploy inert); shadow decisions are fire-and-forget + logged (egress_pacer_shadow).
- [x] **Task 4** (ed99b16) — pausePageSyncForAuth parks the whole page (paused +
  blocker_kind='auth'); direct-sync 401/403 + OFAPI action-required statuses wire in;
  connected/reconnected + credential re-verify release; commands fail fast
  (ofapi_auth_action_required) without spending the attempt. Planner-skip pinned via
  listRunnablePageSync.
- [x] **Task 5** (d7ea175) — undici value-import lint wall + raw-fetch ratchet
  (scripts/check-raw-fetch.mjs, budget 13 day-one). GOTCHA: the wall lives inside the
  EXISTING no-restricted-syntax rule — a separate flat-config block replaces (not merges)
  the rule for overlapping files and would have silently dropped the Stage 27 toMills ban.
- [ ] **Task 3 PARTIAL** — address policies explicit + pacing lanes live (reads=interactive,
  commands=commands, sync=bulk). Physical client-factory adoption (createOfapiClient takes
  an EgressContext; Fansly adapter receives transports instead of building them from the
  same factories) DEFERRED to the mechanical relocation session shared with Stage 18 #99 —
  identical factories mean identical addresses today; the ratchet keeps the debt visible
  (13 → 0 trajectory).
- [ ] **Task 6 ops (owner-gated):** inert deploy (0069 additive + mode=off) → shadow flip →
  48 h egress_pacer_shadow diff review → per-vendor enforce cutover → staging saturation
  proof (interactive p95 flat while bulk saturates) → auth-dead drill + egress-address
  sampling.

Gotchas for future sessions: the pacer's two phases must not be merged back into one
reservation (the property test in tests/egress-resolver.integration.test.ts fails if they
are); test helper zeroes ofapiRestDelayMs so pacing tests pin their own cap; executor must
not import platforms/registry (module-cycle + closed mocks in sync-executor.test.ts).
