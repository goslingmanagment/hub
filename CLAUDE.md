# CLAUDE.md — Agency Hub (goose/hub)

The agency's backend, called "core" or "the kernel" in the docs: platform data
(messages, fans, transactions, subscriptions), the money ledgers, the AI
gateway, and the owner dashboard. Clients are the OnlyFans desktop app
(`~/code/goose/of-desktop`) and the Fansly extension (`~/code/goose/fansly-ext`);
they consume this repo through a vendored SDK and hold no keys, prompts, or
money logic. Production: one VPS, Docker (api + worker + scheduler + Postgres),
DB `agency_hub_core`, deployed by `scripts/deploy-production.sh`.

## Where the truth is

- `docs/decisions.md` — every technical decision, append-only. Quick-ref table
  at the top, then grep the entry by number. Record new decisions there in the
  same change. `docs/` is gitignored with an allowlist: `git add -f` new files.
- `docs/error-handling.md` — the error taxonomy shared with the clients.
- `docs/generated/00-overview.md` — code maps; most date from 2026-07-15,
  check the banner before trusting one.
- `docs/agent-read-skill.md` — read-only access to production data.
- `docs/migration-history/` — archive of the 35-stage kernel migration: the
  WHY behind the architecture, not current status.
- `reference/agency-hub.openapi.json` — the contract clients see.
- `SESSIONS.md` — multi-session work.

## Layout and checks

pnpm workspace: `apps/runtime` (Fastify API + worker + CLI), `apps/dashboard`
(React SPA, same origin), `packages/*` (contracts, db, sdk, shared, fansly,
platform-core, hub-agent-cli). ESM, TS strict, tests in root `tests/`.

- `pnpm check` = typecheck + lint + unit tests + dashboard build.
- Integration tests (`tests/*.integration.test.ts`) need Docker Desktop
  (Testcontainers); CI runs them on every PR. Don't run two vitest suites
  at once.
- Invariants are pinned by tests and ratchet scripts (retention deleters,
  auth declarations, platform-branch budget, prompt manifest, raw fetch).
  When one fails, read its message: it says what to update.
- CI is expensive (~46 machine-minutes per push, Decision 359): push WIP with
  `[skip ci]` in the commit message, let CI run on the push that is ready for
  review, re-run failed jobs rather than the workflow. Never put `[skip ci]`
  in a PR title or body: the squash commit inherits it and main skips the
  image build.

## Things that bite

- Money: platform amounts are BIGINT mills ($0.001), AI spend is micro-USD.
  Use the constructors in `packages/shared`; never mix the units.
- Facts are journaled into `observations` before parsing and never deleted
  on a schedule; projections are rebuildable, facts are not.
- ORDER BY with a bare column name resolves to a SELECT alias: qualify
  columns (`o.id`).
- Outbox: one attempt, fail closed; never auto-retry an indeterminate send.
- Platform requests go through the egress resolver (per-page proxy); a direct
  request to Fansly can get a model banned.
- Migrations in `packages/db/migrations` are forward-only; take the next
  number from the directory.
- Contracts: edit `packages/contracts/src/routes.ts`, run
  `pnpm contracts:generate`; clients re-vendor with `scripts/vendor-sdk.mjs`
  only when they need new operations.
- The deploy build context is snapshotted at launch; commits made after a
  deploy starts need another deploy.
