# Stage 33 — Dashboard modernization

> **SUPERSEDED (decision #112, 2026-07-07) — then #112 REVERSED (decision
> #117, 2026-07-07).** #112 briefly ruled a full rebuild; the owner reversed
> it the same day: `apps/dashboard` is the live, maintained admin surface —
> NOT deprecated, no rebuild, no parity gate (the rebuild launch prompt was
> deleted, tombstone in #117). This stage's task plan still does not execute
> as a stage; its §2 features (grants + device-token admin UI, erasure UI,
> golden-signals, stream-v2 over the polling timers) are BACKLOG items for
> the live dashboard, picked up incrementally.

**Repo(s):** core/dashboard (same repo) · **Depends on:** 20 (SDK adoption this builds on), 21,
22, 28; soft: 24 (v2 proven under fleet load) · **Passport:** roadmap.md §4, stage 33

**Status header.** No deviation. One verified calibration: the `/overview` handler
(`server.ts:1778-1961`, ~183 lines) is not one SQL block but N+1-shaped application-side
aggregation orchestrating many repo queries with in-memory bigint reduction — it dies into the
Stage 28 metrics models either way; the calibration only changes the refactor's shape (replace
orchestration, not one query). Polling inventory (verified): 18 `refetchInterval`/`setInterval`
sites (`adminSync.ts:51-91` 10 s ×5, `adminConfig.ts:17` 30 s, `adminOfapiCredits.ts:15` 60 s,
`adminNotifications.ts:62` 30 s, `dev.ts:74-105`, `AiAnalyticsPage.tsx:28` 2.5–15 s adaptive,
`AiPageDashboard.tsx:215` 3 s).

## 1. Context

The owner console polls 18 endpoints on timers and reads bespoke aggregation; grants, erasure,
and the golden signals have no UI. With stream v2 (21), grants (22), and metrics models +
erasure (28) live, the dashboard sheds polling, serves reports from the same metric definitions
every other consumer uses, and gains the new admin surfaces.

**Entry criteria restated as facts to verify:**
- Metrics models reconciled against current reports (Stage 28's exit — its recorded
  reconciliation table is this stage's license to swap serving).
- v2 stable under desktop fleet load (24 shipped; smoke consumer counters clean).
- Dashboard on the SDK (20) — this stage builds on SDK operations + the v2 SSE helper.
- The uncommitted Credits-page working tree (roadmap §2.7) merged or rebased long ago — verify
  `git status` clean on `apps/dashboard`.

**Deliverable:** polling request volume collapses (server metrics); reports serve from metrics
models with identical numbers; admin UI for grants, erasure (dry-run-first), and golden
signals; workboard tabs fully on the module views.

## 2. Changes

**dashboard — polling → stream v2:** one `useKernelEvents()` subscription (SDK v2 helper,
session auth per Stage 21's route policy) feeding React Query cache invalidation: domain frames
map to query-key invalidations (sync health ← ops events/golden-signal ticks; credits ← ledger
events or a slow 5-min fallback; notifications ← incident events). Polling intervals removed
where a frame covers them; **a slow fallback poll (≥5 min) stays per page as the degraded mode**
(SSE down ≠ blank console). The 18-site inventory is the checklist; each site's replacement or
retained-fallback is recorded in the PR.

**core + dashboard — reporting on models:** `/overview` (and the report endpoints it typifies)
re-serve from Stage 28's model outputs (`analytics_` tables / lake head) behind the same
contracts — response shapes unchanged (SDK types pin them); the 183-line orchestration and
sibling inline aggregations die. Numbers were reconciled in 28; this stage re-checks the diff
anyway (passport rule).

**dashboard — new admin surfaces:**
- **Grants (22):** user detail gains grant history (append-only log view: granted/revoked
  by/when) + model-scope grant management beside the page-scope UI; device-token list/revoke
  beside api-keys.
- **Erasure (28):** owner-only page — scope picker (page/model/fan), **dry-run first** (renders
  the plan: per-plane counts), typed confirmation phrase to execute, then the audit record view.
  The CLI remains the fallback surface.
- **Golden signals (25):** ops page rendering the five lags (current + sparkline from
  `ops_metric_samples`) with alert thresholds shown.
- **Workboard tabs:** finish on module views (23 moved them; this stage removes any leftover v1
  remnants and adopts `workboard.state_changed` frames for live board refresh).

## 3. Schema & data migration

**No schema change. No data migration.** (Serving-path swap + UI only.)

## 4. Client compatibility

- **Dashboard:** the surface itself — visual behavior preserved for existing pages (live updates
  replace refresh ticks); report numbers identical (checked).
- **Desktop / extension:** none — no shared contract changes (report response shapes pinned).
- **Workboard app (34):** unaffected; it has its own surfaces.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** frame→invalidation mapping unit tests; degraded-mode test (SSE closed → fallback
polling at slow cadence, no blank states); erasure UI flow test (dry-run renders plan; execute
requires confirmation; audit view shows the record); grants history view test; report response
shape snapshots unchanged.

**Existing suites:** dashboard page tests (`tests/dashboard-*.test.ts`), overview/report
contract tests.

**Production verification (exit criteria):**
- Polling request volume collapses: server-side per-route request counts for the 18 endpoints,
  before vs after (record the ratio; residual = the slow fallbacks).
- Report numbers identical pre/post (same fixed-window diff as Stages 27/28 used).
- Owner walkthrough of grants/erasure/signals pages recorded (the passport's acceptance).
- SSE connection count: dashboard sessions hold one v2 connection each; no reconnect storms
  over 48 h.

## 6. Rollback

- Frame-driven invalidation is per-page revertable to its old interval (each swap is a small
  commit); the fallback polls are already the degraded mode.
- Report serving can flip back to the legacy handlers for one release (keep them dormant one
  cycle, then delete).
- Admin surfaces are additive. No irreversible step.

## 7. Assumptions

1. **Stage 28's reconciliation holds** — this stage swaps serving, it does not re-derive
   numbers; any diff found here is a 28 regression, escalate there.
2. **v2 under fleet load is proven** (24 + smoke counters) before the dashboard adds its
   connections; dashboard connection count is small (owner/team-lead sessions).
3. **Session-authenticated SSE** is per Stage 21's route policy (`kind:'any'` or session —
   whichever 21 recorded; verify before building the hook).
4. **The dashboard stays in core's repo, served same-origin** (target §10.4) — no CORS/token
   work.
5. **Erasure stays owner-only** with dry-run-first as a UI invariant, mirroring the CLI.

## 8. Task breakdown

1. **`useKernelEvents` + invalidation map + degraded mode; migrate the 18 sites.** *(1
   session)*
2. **Reports onto metrics models (server) + shape-snapshot pins + diff re-check.** *(1 session)*
3. **Grants + device-token admin UI.** *(0.5 session)*
4. **Erasure UI (dry-run/confirm/audit) + golden-signals page.** *(1 session)* *(parallel with
   3)*
5. **Workboard tab remnants + live board frames.** *(≤0.5 session)*
6. **(Last) Deploy; 48 h polling-volume + SSE stability watch; owner walkthrough; record results
   here.** *(ops)*
