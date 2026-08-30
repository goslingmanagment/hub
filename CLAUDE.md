# CLAUDE.md — Agency Hub "core" (the kernel)

The central backend of an OnlyFans/Fansly agency: source of truth for platform
data (messages, fans, transactions, subscriptions), the money ledgers, the AI
gateway that serves every client's generation, and the owner console. Clients —
the ChatGoose desktop app (OnlyFans, `~/code/goose/of-desktop`), the
ChatGoose Firefox extension (Fansly, `~/code/goose/fansly-ext`), and the dashboard in
this repo — are "userspace": they hold no vendor keys, assemble no prompts, and
compute no money; everything privileged happens here, behind the generated SDK.
(Renamed 2026-07-30: `core` → `goose/hub`, `chatgoose` → `goose/fansly-ext`,
`chatgoose_desktop_fable` → `goose/of-desktop`; GitHub repo names unchanged.)
Production: one VPS (Docker: api + worker + scheduler + Postgres 16), deployed
by `scripts/deploy-production.sh` (owner-gated).

**The Project Kernel migration (35 stages) is complete and in production; its
historical record lives in `docs/migration-history/` (per-stage specs, roadmap,
execution log) — living docs are `docs/` + `docs/generated/`. `apps/dashboard`
is the live, maintained admin console (#117 reversed the #112 rebuild); the
standalone workboard app lives in its own repo, `~/code/goose/workboard` (#119). Do
not maintain a hand-written "current state" narrative in this file — statuses
date instantly; current truth lives in `docs/decisions.md` (append-only,
quick-ref table up top), Git tags, and production itself.**

## Read these before designing or building anything

| Doc | What it answers |
|---|---|
| `docs/decisions.md` | Every technical decision, numbered, append-only — scan the Quick Reference table up top, then grep the full entry by number; includes the family law (anti-deletion, updated-in-change) and cross-repo rulings clients reference |
| `docs/error-handling.md` | The family-wide error taxonomy, retry laws, client mappings, ledger/incident policy, and boundary/redaction rules |
| `docs/generated/` | Machine-generated reference (auth policy table + 24 code maps) — start at `00-overview.md`, it indexes which map covers what; regenerate, never hand-edit; each file's banner says how (`REGENERATION-PROMPT.md` there is the generator) |
| `docs/migration-history/stages/` | The 35 stage specs of the Project Kernel migration — the WHY behind most of today's architecture; superseded ones carry banners |
| `docs/migration-history/execution-log.md` | Per-stage status board of the migration |
| `docs/runbooks/` | Operational rituals — incl. the break-glass direct-read runbook (DP 8) and go-live checklists |
| `docs/ai-gateway-contract.md`, `docs/ofapi-command-outbox-contract.md` | The two most load-bearing client contracts in prose |
| `reference/agency-hub.openapi.json` | The generated OpenAPI snapshot — the contract clients see |

## Hard rules (each exists because something broke without it)

- **Money:** amounts are BIGINT **mills** (1 mill = $0.001) for platform money
  and **micro-USD** for AI spend; construct through the named constructors in
  `packages/shared` — never hand-roll arithmetic or mix units (Stage 27; the
  units differ by 10³ and a silent mix has happened).
- **Capture first, never scheduled deletion (DP 7):** business facts are
  journaled verbatim into `observations` before any parsing; nothing that
  captured a fact is deleted on a schedule (retention is 100 years; the only
  sanctioned deleters are enumerated in `tests/retention-deleters.test.ts` and
  the Stage 28.4 erasure module). If you add a `delete from`, that pin fails —
  that is the point.
- **Canonicalize, don't parse in place:** observations → `domain_events`
  (gapless per-account seq, content-hash dedup) → projections. Projections are
  rebuildable; facts are not. ORDER BY with a bare column name resolves to a
  SELECT alias — **qualify columns** (`o.id`), this trap shipped twice.
- **Outbox discipline:** one attempt, fail closed, never auto-retry an
  indeterminate send — a duplicate DM to a fan is worse than a missed one.
- **No kernel write API without a principal.** Every mutation route declares
  auth in `packages/contracts/src/routes.ts` (`kind` + optional page scope);
  the declarations are pinned by `tests/contracts-auth-declarations.test.ts`.
- **Single-tenant (DP 9-A):** this system serves one agency. No tenant columns,
  no multi-org abstractions — deliberately.
- **Platform branches are budgeted:** `platform ===` outside the adapter
  packages is counted by `scripts/check-platform-branches.mjs` against
  `scripts/platform-branch-budget.json` — the count may only decrease; a
  deliberate new branch bumps the budget WITH a written justification.
- **Egress through the resolver only (Stage 26):** every platform-bound
  request resolves its proxy/egress key per page; a raw fetch to a platform
  from anywhere else fails the raw-fetch ratchet. Fansly pages MUST go through
  their own proxy — a direct-IP request risks a model ban.
- **Vendor AI SDKs live only in the gateway providers** (`@anthropic-ai/sdk`
  is lint-banned elsewhere); every generation goes through the Stage 29
  gateway: budgets, quota-denied ledger rows, verbatim prompt capture
  (restricted class, owner-only routes), gateway-priced spend.
- **Staged flags flip one at a time**, each with its own verification window
  (the #70 ritual). Config flips are live (`config_settings`), audited, and
  never bundled.
- **Prompt unit is frozen:** the kernel's prompt library was byte-migrated
  from the desktop (Stage 30 manifest pins sha256 per file); a fansly page
  gets the platform word swapped at assembly (`applyPlatformWording`) in
  STATIC sources only — runtime data (transcripts, bios) is never rewritten.
  Any prompt edit updates `prompt-manifest.json` or the drift pin fails.
- **Migrations are forward-only**, numbered (next after 0117), applied by the
  deploy script; never edit an applied migration. Take the next number by
  listing `packages/db/migrations` at PR time, not from this line.
- **Contracts drive everything:** edit `packages/contracts/src/routes.ts`,
  then `pnpm contracts:generate` (regenerates the SDK surface + OpenAPI).
  Client repos consume a VENDORED compiled SDK — re-vendor with
  `node scripts/vendor-sdk.mjs <client>/vendor/kernel-sdk` (or
  `../of-desktop/packages/kernel-sdk`) only when they need the
  new operations; the drift gates in each client pin the contract hash.

## Conventions

- pnpm workspace: `apps/runtime` (Fastify API + worker + CLI), `apps/dashboard`
  (React SPA, served same-origin; being rebuilt), `packages/{contracts,db,sdk,
  shared,fansly}`. ESM everywhere, TS strict.
- `pnpm check` = typecheck + lint + unit tests + build. Integration tests
  (`tests/*.integration.test.ts`) need **Docker Desktop** (Testcontainers) and
  run nightly in CI; don't run two vitest suites in parallel (Testcontainers
  port clash). Ratchet scripts (platform branches, retention deleters, raw
  fetch) run inside the test suite.
- Tests live in root `tests/`; no drizzle-orm imports inside tests; SSE tests
  need listen+fetch (not inject).
- Prod read-only diagnostics need no permission: the Agent Read Plane
  (`read_only` role), `/health*`, SSH for logs/status only (`docker ps/logs`,
  `journalctl`, `df`), psql **only via the `read_only` role — never the app
  user or superuser**. Everything that mutates prod (deploys, flag flips,
  restarts, psql writes, editing files on the VPS) stays **owner-gated**:
  prepare everything, then ask with a structured confirmation per gate. DB name
  on prod is `agency_hub_core`. The deploy build context snapshots at launch —
  commits made after a deploy starts need a dist-only follow-up.
- The dashboard's `@/*` alias in the ROOT tsconfig matches extensionless
  imports only; `@tanstack/react-query` is not resolvable from root tests —
  mock the api layer.

## Sessions

Multi-session work is the norm here — see `SESSIONS.md` for the runbook
(restartable prompts, one-repo-per-session boundaries, the stage-execution
harness in `docs/migration-history/stage-execution-harness.md`).
