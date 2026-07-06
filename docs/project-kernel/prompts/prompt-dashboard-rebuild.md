# Dashboard rebuild — design + build prompt (decision #112)

You are rebuilding the owner console (`apps/dashboard`) of this repo FROM
SCRATCH. The owner ruled (decision #112) that the existing dashboard is
deprecated: it keeps serving untouched until your replacement reaches parity
sign-off, then it is deleted. You are not modernizing it — do not inherit its
information architecture, component structure, or visual language unless the
PRD deliberately chooses to.

## Process

1. **PRD first.** Start with a product pass: read the ground truth below,
   verify it against the code (the map is not the territory), then write
   `docs/project-kernel/dashboard/prd.md` — audience, jobs, information
   architecture, page inventory with priorities, liveness model, visual
   direction, build stages. STOP for owner review before building. Ask the
   owner concrete product questions where the answer changes the design
   (there are open ones listed below); do not pad the PRD with options you
   would not recommend.
2. **Build in stages** after PRD approval, one reviewable slice at a time,
   on branches named `kernel/dashboard-rebuild-*`. Commit only your own
   files, never `git add -A` (the owner keeps unrelated deletions parked in
   the tree). `docs/` is gitignored — commit docs with `git add -f`.
3. **Parity exit**: the old app is deleted only after the owner signs off
   that the new one covers the surfaces he actually uses. The deletion is
   its own reviewed commit.

## Hard constraints (survive the rewrite)

- **Same repo, same origin** (target §10.4): served by core, session-cookie
  auth, no CORS/token machinery.
- **SDK-only API access** (kernel Stage 20): every call through the
  generated `@kernel/sdk` client (typed ops, runtime-validated responses).
  Direct fetch in the API layer is lint-banned today — keep that rule.
- **Numbers come from the kernel's canonical sources**: reports must serve
  from the Stage 28 metrics models (`analytics_` tables — reconciled against
  legacy reports at Stage 28 exit); AI spend/usage from the Stage 29 gateway
  ledger. No client-side re-aggregation of raw rows where a model exists.
- **Documentation for AI agents** (DP 10-A): the new app ships with a
  docs page/file that keeps future agents oriented (structure, conventions,
  where numbers come from).
- Mills vs micro-USD: 1 mill = $0.001; use the shared formatters
  (`formatUsdFromMills`) — never hand-roll currency math.

## Ground truth (verified 2026-07-07 — re-verify, don't trust)

**Current page inventory** (App.tsx): Login, Overview, PageDetail,
SpenderAutoList, DeletedFans, Subscribers, Followers, FanProfile,
TopSupporters, WorkboardV2 (tabs incl. AI closing), Usage, OfapiCredits,
AiAnalytics, Settings (config surface, staged flips), Notifications,
dev/{Log, Queue, DbStats, Incidents, SyncStatus}.

**Liveness today**: 18 polling timers (10 s × 8 sync-health sites, 30 s
config/notifications/incidents, 60 s credits, adaptive 2.5–15 s / 3 s on the
AI run pages). Replace with **one stream-v2 SSE subscription per session**
feeding cache invalidation, plus slow ≥5-min fallback polls as the degraded
mode.

**Stream v2 facts** (verified): `GET /api/v1/events/v2/stream`, auth kind
`any` (session cookie works, same-origin fetch sends it), SDK helper
`subscribeDomainEvents` (opaque cursor, server-bounded ~15 min lifetime —
client owns the reconnect loop; 409 → snapshot-required → resubscribe fresh
and sweep the cache once). Frame vocabulary is BUSINESS events only:
`message.received/sent/deleted/ppv_unlocked`, `presence.*`,
`transaction.posted`, `tip.received`, `subscription.started`,
`fan.earnings_observed`, `command.settled`, `account.auth_changed`,
`workboard.state_changed/contact_retracted/fan_claimed/fan_released`.
**There is NO ops/incident/credits/golden-signal lane in v2** — incidents
and ops metrics must either keep a real poll or get a kernel-side event
lane (a PRD question; adding a lane is core work, decide deliberately).

**Requirements carried over from the superseded Stage 33 spec** (PRD
inputs, not shape constraints):
- Reports on metrics models with a pre/post diff check (numbers identical).
- Grants admin: per-user grant history (append-only log view), model-scope
  grants beside page-scope, device-token list/revoke beside api-keys
  (kernel Stage 22 routes exist).
- Erasure UI: owner-only, scope picker (page/model/fan), **dry-run first**
  (per-plane counts), typed confirmation to execute, audit record view
  (kernel Stage 28.4 routes exist; the CLI stays the fallback).
- Golden signals: the five lags, current + sparkline from
  `ops_metric_samples`, thresholds shown (Stage 25).
- Workboard live refresh from `workboard.*` frames.

**Open product questions for the owner** (ask during the PRD pass):
1. Audience split — is this console owner-only, or do team leads get a
   subset? (Affects IA and the auth gates on every page.)
2. Which current pages does he actually use vs. tolerate? (The rebuild is
   the moment to cut dead surfaces, not port them.)
3. Does he want a kernel-side ops/incident event lane (live incidents
   without polling), or are 60 s polls fine for ops surfaces?
4. Visual direction: keep the current utilitarian look or a fresh design
   language? Any reference products?
5. The extension's Stage 32 release checklist and desktop fleet watches
   surface in ops docs today — should the new console absorb fleet/release
   visibility (client versions seen, drain counters)?

## Repo mechanics

- `pnpm typecheck` (root tsc; the `@/*` alias in root tsconfig only matches
  extensionless imports — `@/lib/x`, not `@/lib/x.js`), `pnpm test`
  (vitest; dashboard tests live in `tests/dashboard-*.test.ts` and
  `@tanstack/react-query` is NOT resolvable from root tests — mock the api
  layer or duck-type), `pnpm lint`, `pnpm contracts:generate` after any
  contract change (regenerates the SDK surface; re-vendor to clients only
  when they need the new ops).
- Migrations are forward-only, next number after 0074; Docker Desktop
  needed for Testcontainers integration tests.
- The prod deploy is owner-gated (`scripts/deploy-production.sh` — never
  run it yourself; prepare and hand off).
