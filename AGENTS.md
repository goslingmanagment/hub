# Agency Hub

The agency's backend: Fansly and OnlyFans sync into Postgres, the API for clients (extensions, desktop),
chatters' AI features, the owner's dashboard. Production is `agency-de` (`root@152.53.191.242`, `/opt/agency-hub`);
`45.8.230.111` is the old server, switched off: start or deploy nothing there.

## Running it and seeing a change
- `pnpm install && pnpm dev` — `.env`, Postgres in Docker, migrations, API + worker + dashboard in one terminal.
- `pnpm dev:seed-client` — dev data: `dev-owner` / `dev-owner-password` (dashboard), `dev-chatter` /
  `dev-chatter-password` (client token), pages `dev-lora-of`, `dev-lora-vip-of`.
- Dashboard: http://localhost:5173 (Vite, proxied to the API) — look at UI changes there, with your own eyes.
- API: `curl localhost:3000/api/v1/health`; the token and sample requests — `docs/runbooks/client-dev-hub.md`.
- AI without spending money: `pnpm dev:fake-ai` + the variables from the same runbook.

## Checks and PRs
- Locally only what you touched: `pnpm typecheck`, `pnpm exec eslint <files>`, `pnpm exec vitest run <files>`.
  Integration tests (`*.integration.test.ts`, need Docker) and the full run are CI's job.
- Open the PR ready + `gh pr merge --auto --squash`; wait for CI with one background command
  (`gh pr checks <n> --watch`). Integration runs on a PR by itself when DB/sync/network is touched; main runs everything.
- CI runs only on GitHub-hosted runners (the repo is public: free, and never on the owner's PC); a full run
  is ~2.5 min. Never use `[skip ci]`: every main commit must have a Quality Gate, without it the deploy refuses.
- Tests check behavior. Do not pin the text of CI, compose, deploy scripts, docs or migration SQL with tests.

## Deploy
- `scripts/deploy.sh` deploys `origin/main` (or `scripts/deploy.sh <sha>`): it fetches, makes a throwaway
  worktree, checks main's green Quality Gate, runs a dist-only deploy, writes a log file and cleans up.
  Prints ≤ 15 lines: version, new migrations, health, log path. Run it in the background.
- `scripts/deploy.sh --dry-run` — everything except the deploy. After a `package.json`/lockfile change:
  `scripts/deploy.sh -- --mode full`. A red main blocks deploys; whoever deploys fixes main.
- You deploy your own merged work yourself. `--skip-ci-gate` — only on the owner's word.

## Dangerous — only when the owner asks
- Writes to the production DB, manual changes on production, deleting data. Reading production is free
  (SSH, the `hub` skill, SQL only in a read-only transaction).
- Money and messages to real people (sends to Fansly/OnlyFans, Telegram).
- Only the owner changes the Fansly request pace (≥ 2 s between requests of one page).

## Code rules
- AI keys, prompts and money accounting live in Hub, not in clients. Platform money is BIGINT mills ($0.001),
  AI spend is micro-USD; only the constructors from `packages/shared/src/money.ts`.
- Captured platform data is journaled in `observations` first; scheduled deletion of facts is forbidden.
- An outgoing platform command gets at most one attempt; never auto-retry an indeterminate send.
- Platform requests go only through the egress resolver (`apps/runtime/src/services/egress`).
- Migrations are forward-only, numbered with the next free number. If the old image runs on the new schema
  unchanged (a new table, a nullable column, an index), the migration's header carries the line
  `-- agency-hub:rollback-compatible — <why>`: then a failed deploy rolls itself back. List it nowhere else.
- After an API contract change — `pnpm contracts:generate` (CI compares). A client that needs the new API
  re-vendors the SDK: `node scripts/vendor-sdk.mjs ../<client>/<path to kernel-sdk>`.
- The money, deletion, erasure and test-DB isolation guards say in their error message which file and line
  to add to — do as it says.

## Good to know
- Don't babysit long rollouts and update windows (`page-browser-update.sh`, an hour of watching): start it,
  then end the turn or do one background check later. No foreground SSH polling loops.
- `docs/` is in `.gitignore`: a new file there needs `git add -f`.
- `vitest run -u <file>` runs and updates the WHOLE suite: put the path before `-u`.
- Keep no decision or session logs; Decision numbers in comments are history, reading them is optional.
