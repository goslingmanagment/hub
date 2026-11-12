# Agency Hub

The agency's backend: Fansly and OnlyFans sync into Postgres, the API for clients (extensions, desktop),
chatters' AI features, the owner's dashboard. Production is `agency-de` (`root@152.53.191.242`, `/opt/agency-hub`);
`45.8.230.111` is the old server, switched off: start or deploy nothing there.

## Running it and seeing a change
- `pnpm install && pnpm dev` — `.env`, Postgres in Docker, migrations, API + worker + dashboard in one terminal.
- `pnpm dev:seed-client` — dev data: `dev-owner` / `dev-owner-password` (dashboard), `dev-chatter` /
  `dev-chatter-password` (client token), pages `dev-lora-of`, `dev-lora-vip-of`.
- Dashboard: http://localhost:5173 (Vite, proxied to the API) — look at UI changes there, with your own eyes.
- `pnpm dev:demo` — the dashboard alone, every screen full of an invented agency (no Docker, no API):
  http://localhost:5180, `/__demo/role?as=team_lead|chatter` switches the role. Data: `packages/demo/fixtures/`
  (typed by the contracts, checked by `pnpm typecheck`). A new screen or API field gets its fixture there.
- Workboard (`apps/workboard`, the owner's team control, served by Hub at `/workboard/`; design system `packages/ui`):
  `pnpm dev:workboard:demo` → http://localhost:5190/workboard/ on the same demo data (`/workboard/__specimen` — every
  component). Against a local API: `pnpm dev:workboard` (proxies `/api` to :3000). The console's «Команда» is Workboard
  (every old `/team/*` address redirects there, `apps/dashboard/src/lib/workboard.ts`; only «Анкеты» stay in the console);
  the console's dev servers proxy `/workboard` to Workboard's (5190 for `dev:demo`, 5191 for `dev:dashboard`), run it beside.
- API: `curl localhost:3000/api/v1/health`; the token and sample requests — `docs/runbooks/client-dev-hub.md`.
- AI without spending money: `pnpm dev:fake-ai` + the variables from the same runbook.

## Checks and PRs
- Locally only what you touched: `pnpm typecheck`, `pnpm exec eslint <files>`, `pnpm exec vitest run <files>`.
  Integration tests (`*.integration.test.ts`, need Docker) and the full run are CI's job. Every vitest run starts a
  test Postgres when Docker is up; `HUB_TEST_POSTGRES=off pnpm exec vitest run <unit files>` skips it.
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
- Only the owner changes the Fansly request pace (≥ 2 s between requests of one page). An upload's parts (PUTs to S3,
  not Fansly) go outside it, up to 3 at once per page, through the page's browser and proxy (owner, 2026-11-03).

## Code rules
- AI keys, prompts and money accounting live in Hub, not in clients. Platform money is BIGINT mills ($0.001),
  AI spend is micro-USD; only the constructors from `packages/shared/src/money.ts`.
- Captured platform data is journaled in `observations` first; scheduled deletion of facts is forbidden.
- An outgoing platform command gets at most one attempt; never auto-retry an indeterminate send. The one exception:
  an upload part's PUT to S3 — the same presigned URL and bytes — goes up to 3 times (owner, 2026-11-03).
- Platform requests go only through the egress resolver (`apps/runtime/src/services/egress`).
- Migrations are forward-only, numbered with the next free number. If the old image runs on the new schema
  unchanged (a new table, a nullable column, an index), the migration's header carries the line
  `-- agency-hub:rollback-compatible — <why>`: then a failed deploy rolls itself back. List it nowhere else.
- `schema.ts` holds only the tables the query builder uses; a table used through raw SQL is defined by its migration alone.
- After an API contract change — `pnpm contracts:generate` (CI compares). A client that needs the new API
  re-vendors the SDK: `node scripts/vendor-sdk.mjs ../<client>/<path to kernel-sdk>`.
- The money, deletion, erasure and test-DB isolation guards say in their error message which file and line
  to add to — do as it says.

## One home for each thing
Hub is the home of the agency's WORK objects; the ledger keeps accounting, ContentOps keeps files. Before adding a
table, a screen or a computation, find the thing's home here — a second home for the same thing is a bug.
The one map of the whole system — every part, entity, door between parts, sign-in and copy — is `~/code/SYSTEM.md` on
the owner's machine (outside this repository); a change that moves a home or adds a door updates it in the same task.
- **People**: the registry (`apps/runtime/src/services/people`, tables `people`, `person_*`). A login is not a person
  (`person_logins`); never rename `users.username`: scripts outside the repo match by it. Pay terms are money:
  owner-only, never serialised into anyone else's session. Where a person is paid (`person_payout_details`, written by
  the person on Workboard «Начало», `services/people/start.ts`) is the person's own session's and the owner's card's only.
  A newcomer's way to the first shift is read live from the facts (`start.ts`), never ticked by hand.
- **Whose a sale is**: only `apps/runtime/src/services/sale-rule.ts`, written to `sale_homes` (`sale-homes.ts`);
  schedule slots and «left the team» come from the people registry. Never compute it anywhere else. Screens follow
  it from the date in `sale_rule_switch` (null: the old computation); where a home's share lands (the person's work by
  any of their logins, or their own money of the sale's day) is `homeCredit` (`sale-rule-screens.ts`) on every screen.
- **Shifts**: rows with a stable id in `shifts` (`shift-rows.ts`); what a shift IS stays `chatter-shifts.ts`.
- **What waits for a person**: a matter (`services/matters.ts`, table `matters`): opened and closed by its reason
  key, one writer per kind, closes itself when the cause is gone. No new list, counter or inbox beside it. An
  object's history goes to `object_events`.
- **A shift's report**: `services/shift-handins.ts` (tables `shift_handin_*`; a handed-in version is immutable, the
  newest is the report). Three doors, one service: Workboard «Смена», the extension (it opens the same screen), an
  agent key «со слов» (`hub shift-report …`). Behind the person's right `submits_shift`. Sums only through
  `reportSums`; the ledger takes versions through `agentShiftReportsFeed` and accrues, Hub never does.
- **What people say about a sale**: claims, agreements and the owner's decisions (`services/sale-claims.ts`, tables
  `sale_claims`, `sale_owner_decisions`). They reach the rule as its inputs (`sale-homes.ts`), never around it; a
  claim alone moves no home. Hub is their only home: what the chat agent records «со слов» comes through
  `services/sale-decisions-door.ts` (`hub sale decide|ask|…`), a decision on a known sale through the owner's own path
  (`applySaleDecision`), its cancel through `cancelSaleDecisionApplied`; the ledger reads them from Hub and writes none.
  Whoever writes whose a sale is (a decision made, replaced, cancelled or tied; an agreement) or a report's version
  from its draft takes `lockSaleSettlements` first in the transaction — then decisions and claims, then reports —
  reads there what it writes from, and never holds it across a call to the ledger.
- **A sale's chain of money** (whose, shift, report, accrual, payout): one read, `services/sale-chain.ts`
  (`saleChain`, agents `agentSaleChain` / `hub sale-chain`), it computes nothing anew and says «неизвестно» when a
  source does not answer. Shown only by `SaleChainTrigger` (`packages/ui/src/components/SaleChain.tsx`): the sale's amount.
- **A custom order**: `services/custom-orders/` (table `custom_orders`, code `K-123`): one order from the fan's chat
  to the fan's hands. Doors: the extension's fan panel, Workboard «Кастомы», agents (`hub custom …`); ContentOps
  reads orders and reports files, it never closes one. Its checks (`custom-orders/checks.ts`) are the one writer of
  what waits about an order; who leads customs is `customsLeadOwner` (`custom-orders/readers.ts`).
- **People's pay**: the ledger's. Hub only reads it (`ledgerGet`: a person's days, the payout calculation, checks,
  report days, the month card) and shows it; `payMillsOf` (`services/ledger-payouts.ts`) is the one conversion. No
  pay number is computed in Hub, and none reaches a session that does not see it today.
- **What the server says to people in Telegram**: `services/people-messages/` (outbox `people_messages`). Two locks:
  the env token and the enabled kinds; a kind is a row in `packages/contracts/src/people-message-kinds.ts`. No other
  code sends a person a message; nothing about a fan goes into a personal message.
- **The menu and every screen's address**: ONE table, `packages/ui/src/screens.ts`, for the console and Workboard. A
  screen is a row there; an address that moved gets a redirect, never a second screen.
- **The groups of «Ждут вас»**: one table, `packages/contracts/src/waiting-groups.ts` (which group a kind is in, the
  group's title, order and tone). The Home's chips, the menu's number and the list are built from it; a new kind
  gets its group there (a test fails when one has none), never a second mapping on a screen.
- **Sign-in**: `services/signin-handoff.ts`. Cookies are host-only; a session crosses names by a one-time code; a
  cookie-authenticated change is taken only from the console's and the team's names (`api/origin-check.ts`). Other
  services redeem a code with their own key (`signin:<service>`), they never get the session.
- **Whose an agent key is**: the agent person it is linked to (`person_agent_keys`, one writer: `insertPersonAgentKey`
  in `packages/db/src/repositories/people.ts`). An agent holds ONE live key at a time: the services (ledger, TaskIndex,
  ContentOps) learn only the agent from Hub (`agentKeyIntrospect`) and give a key that agent's rights, so a second
  key of the agent would carry them too. A key no agent holds (a reporter, a mirror) is inactive in the services.
- **Pages agents write for people**: agent reports (`services/agent-reports.ts`, `hub report put`).
- **Whether routines and copies work**: «Система → Состояние» (`services/system-state.ts`, tables `system_routines`,
  `system_copies`): a reporter sends its whole list (`write:system_state`, the Mac's is `scripts/system-state/`), Hub
  adds its own schedules and judges; a problem is a matter.
- Lists in CHECK constraints (agent-key capabilities, person rights) are rewritten whole by every migration that
  widens them: at rebase take the union with main's. A migration's number must be above main's highest: the runner
  refuses a lower one once a higher one is applied.
- Copies of the data: `docs/runbooks/business-backup.md`. Do not deploy while the nightly dump runs (05:20 Moscow,
  about 13 minutes): a migration would wait behind it. Each deploy answers 502 to chatters' extensions for 2–3
  seconds: batch merged work into one deploy rather than deploying every PR.

## Good to know
- What AI money went to (Hub's ledger, by feature/model/effort/window/chatter/page/key/branch, unit costs, dearest calls,
  setting changes): `ssh root@152.53.191.242 'docker exec agency-hub-api-1 node /app/apps/runtime/dist/cli.js ai:spend --from YYYY-MM-DD [--to …] [--json]'`
  (default: yesterday, Moscow). The owner's page: Деньги → Расходы → ИИ.
- Model questionnaires from gosling-agency.ru (public `POST /api/v1/model-applications`; sensitive personal data:
  read them on the server, copy them nowhere): `ssh root@152.53.191.242 'docker exec agency-hub-api-1 node
  /app/apps/runtime/dist/cli.js model-applications:list'`, then `model-applications:show <id> [--json]`; fillings
  in progress (last 24 h): `model-applications:live [--show <session>]`.
- Don't babysit long rollouts and update windows (`page-browser-update.sh`, an hour of watching): start it,
  then end the turn or do one background check later. No foreground SSH polling loops.
- `docs/` is in `.gitignore`: a new file there needs `git add -f`.
- `vitest run -u <file>` runs and updates the WHOLE suite: put the path before `-u`.
- Keep no decision or session logs; Decision numbers in comments are history, reading them is optional.
- Live Fansly for research — the agency's test model (`FANSLY_TEST_MODEL_*` in secrets.env) in a headless Firefox, from
  your own chat-extension worktree: `pnpm see:session --bare` (click anything; every request and socket frame with its
  body in `s.net` / `net.json`; chat-extension `tools/see/README.md`). The post flow taken there:
  `~/code/8-docs/2026-10-24-fansly-post-flow.md`. Its fans are real: a send, a publication, money — owner's «да» first.
