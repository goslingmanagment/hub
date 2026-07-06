> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Infra & DevOps

Build and deploy for the `agency_hub_core` monorepo (pnpm workspaces, pnpm
10.33.1, Node 22, ESM). This map covers the multi-stage Dockerfile, the three
docker-compose files, the owner-gated `deploy-production.sh` and its ordered
gates, the esbuild production bundler, the local dev bootstrap, the two GitHub
workflows, the budget ratchets, and the analytics models.

## Dockerfile (`/Dockerfile`, single multi-stage build)

- Build args: `NODE_BASE_IMAGE=node:22-bookworm-slim`, `APP_DEPENDENCY_CHECKSUM`,
  `APP_SOURCE_REVISION`. Corepack enables pnpm.
- Stages: `target-base` → `prod-deps`
  (`pnpm install --prod --frozen-lockfile --filter @agency_hub_core/runtime...`) →
  `build` (runs on `$BUILDPLATFORM`, `pnpm build:production`) → `runtime`
  (`NODE_ENV=production`, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`).
- Labels `agency-hub.dependency-checksum` and `agency-hub.source-revision`
  (`:51-52`) carry the build-arg values.
- `Dockerfile:72` installs Playwright chromium `--with-deps`. The runtime stage
  copies the dashboard dist, runtime dist, and db dist + migrations.
- `CMD ["node","apps/runtime/dist/startup.js","worker"]` (`:78`) — the default
  role is the worker; compose overrides the command per service.

## docker-compose files (DB name `agency_hub_core`, Postgres 16)

- `docker-compose.production.yml` — services:
  - **postgres** (`postgres:16`, DB `${POSTGRES_DB:-agency_hub_core}`, requires
    `POSTGRES_PASSWORD`, healthcheck `pg_isready`; volume `postgres_data`).
  - **api** (`startup.js api`, published `127.0.0.1:3000:3000`, healthcheck GETs
    `/api/v1/health`).
  - **scheduler** (`startup.js scheduler`, leader-elected via advisory lock —
    comment `:43-46`).
  - **worker** (`startup.js worker`,
    `WORKER_HEALTH_FILE=/tmp/agency-hub-worker-health.json`; healthcheck asserts
    the health file is fresh (<90s) and DB `select 1`).
  - Comments describe scale-out `worker-2` / `scheduler-standby`.
- `docker-compose.yml` (dev) — postgres (published `5432:5432`; user/db/pass
  `postgres`/`agency_hub_core`/`postgres`), a **migrator** service
  (`migrate.js`, `SYNC_SHARED_RATE_LIMIT_ENABLED:true`), api (`3000:3000`),
  worker. `env_file: .env`; image `agency_hub_core/runtime:local`.
- `docker-compose.test.yml` — same shape, `env_file: .env.docker`, mounts
  `.sessions` and `.om-token` read-only.

## `scripts/deploy-production.sh` (~37KB, `set -euo pipefail`)

Fully non-interactive: gates are `fail()` aborts, not yes/no prompts.

- Defaults: `APP_DIR=/opt/agency-hub`,
  `IMAGE_TAG=agency_hub_core/runtime:production`,
  `BUILD_MODE=full` (full | dist-only | auto),
  `NODE_BASE_IMAGE=node:22-bookworm-slim`, `HTTP_PORT=3000`,
  `BUILD_PLATFORM=linux/amd64`; each has a `DEPLOY_*` env-var equivalent.
- **Ordered gates:**
  1. `initialize_deploy_metadata_and_tags` — computes
     `APP_DEPENDENCY_CHECKSUM` (sha256 over `DEPENDENCY_MANIFEST_FILES`,
     including the Dockerfile, lockfile, and every package.json),
     `APP_SOURCE_REVISION` (`git rev-parse --short=12` plus `-dirty` when the
     tree is dirty), and a `DEPLOY_RUN_ID`.
  2. `acquire_local_deploy_lock` — mkdir lock under `TMPDIR`; fails if held
     ("Local deploy lock exists. Remove … only after confirming no deploy is
     active.").
  3. `preflight_migration_files` — rejects hidden `.*.sql`; enforces the
     `^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$` migration-file naming.
  4. `acquire_remote_deploy_lock` — mkdir `${APP_DIR}/.deploy.lock` over SSH,
     exits 73 if held.
  5. validate remote docker →
     `capture_remote_rollback_image` (tags the running api/worker image as the
     rollback image) → `capture_remote_release_files` (tar snapshot) →
     `build_candidate_image`.
- **Build context (full vs dist-only):**
  - full mode — local `docker build --platform linux/amd64` with the
    checksum/revision build-args, then `docker save | ssh docker load`.
  - dist-only — local `pnpm build:production`, then
    `create_dist_overlay_context` generates an overlay Dockerfile `FROM` the
    rollback image, copying `DIST_OVERLAY_PATHS` (dashboard / runtime /
    contracts / db / fansly / platform-core / shared dist + db/migrations;
    prunes `._*` and `.DS_Store`); the tar is uploaded and built on the remote.
    `validate_dist_only_base` refuses if the dependency checksum changed
    ("Dist-only deploy refused: dependency checksum changed") unless
    `--allow-unlabeled-dist-base`.
- **Migration / schema safety:** `capture_remote_schema_migrations` reads the
  `schema_migrations` table under `pg_advisory_xact_lock(31415, 27182)` into
  before/after files (`SCHEMA_BASELINE_CAPTURED`). The
  `ROLLBACK_COMPATIBLE_MIGRATIONS` allowlist is `0013…0018` (data/repair
  migrations); a rollback proceeds only if the schema delta is empty or is
  limited to allowlisted migrations.
- **Recreate + verify:** promote candidate → `IMAGE_TAG`, then
  `docker compose … up -d --remove-orphans --force-recreate --no-build`, then in
  order: `wait_for_api_health` (`/api/v1/health` == 200 containing `"checks"`,
  60×2s) → `wait_for_worker_health` (compose healthcheck `healthy`, 60×3s) →
  `verify_post_deploy_image_labels` (api + worker labels match revision +
  checksum) → `wait_for_sync_health` (`/api/v1/health/sync` with
  `x-monitoring-token` from `HEALTH_SYNC_MONITORING_TOKEN`, accepts 200/503
  containing `"pages"`) → dashboard delivery check (`/login` == 200 containing
  `<!doctype html>` and `id="root"`). Any failure after recreate triggers
  `rollback_remote_stack`.
- **Roles deployed:** postgres, api, worker (+ scheduler per compose). Compose is
  invoked as `RUNTIME_IMAGE=… docker compose --env-file .env.production
  -f docker-compose.production.yml`.

## `scripts/build-production.mjs`

esbuild bundler. Cleans the dist output for runtime plus five packages, then
builds:
- `packages/shared` twice — a browser build (`browser.ts`,
  `platform=browser`, `es2022`) and a node build (`index.ts`).
- contracts, fansly, platform-core, db (`index` + `migrate`), and runtime
  (`api`, `cli`, `startup`, `worker` entrypoints).

The `runtimeExternal` list (`:20-42`) keeps native/Fastify/pg/drizzle/zod and
similar packages external. Node bundles receive a `createRequire` banner.
Workspace aliases resolve to the `src/*.ts` sources.

## `scripts/dev-local.sh`

Bootstraps `.env` from `.env.example` (generating `APP_ENCRYPTION_KEY`), picks a
free API port starting at `API_PORT` (default 3000, scanning +99), starts docker
postgres (`pnpm dev:db`), waits on `pg_isready … agency_hub_core`, runs
`pnpm db:migrate`, then backgrounds `pnpm api`, `pnpm worker`, and
`pnpm dev:dashboard` (with `VITE_API_PROXY_TARGET` pointed at the chosen port).
A trap cleans up on exit.

## GitHub workflows (`.github/workflows/`)

Only two workflows exist.

- **ci.yml** — name "CI". Triggers: `pull_request` (any) and `push` to `main`.
  Job "Quality Gate" (ubuntu-latest): checkout → `pnpm/action-setup@v4` →
  node 22 (pnpm cache) → `pnpm install --frozen-lockfile` → `pnpm typecheck`
  (the strictness ratchet) → `pnpm lint` (family standard + architecture walls)
  → `pnpm build:production` → `docker build --target runtime -t
  agency_hub_core/runtime:ci .` → `pnpm test:unit` → `pnpm test:prerequisites`
  (the sync-critical subset).
- **nightly.yml** — name "Nightly". Triggers: `schedule` cron `"20 2 * * *"`
  (02:20 UTC daily) and `workflow_dispatch`. Job "Full suite (Testcontainers)",
  `timeout-minutes: 90`: install → `pnpm test` (full unit + integration +
  rebuild-from-fixtures proofs + in-suite ratchet scripts). Its header comment
  (`:1-7`) notes PRs run only the sync-critical subset and the nightly run is the
  backstop.

## Ratchets

The strictness ratchet backs `tsconfig.base.json`'s `exactOptionalPropertyTypes`
and `noUncheckedIndexedAccess`; the budget ratchets each pair a checker script
with a JSON snapshot whose count may only decrease.

| Ratchet | Script | Budget file / value | Enforces |
|---|---|---|---|
| Strictness | `scripts/check-strictness-ratchet.mjs` (= `pnpm typecheck`) | `scripts/strictness-ratchet.json` (≈1,900+ `error TS…` across ~130 files) | Per-file `tsc --noEmit` error budget; unlisted files must be clean; total may only shrink (then re-run `--update` and commit) |
| Platform branches | `scripts/check-platform-branches.mjs` | `platform-branch-budget.json` = 49 (Stage 18) | Counts `platform ===` sites outside adapter packages (+1 noted for Stage 32 `applyPlatformWording`) |
| Raw fetch | `scripts/check-raw-fetch.mjs` | `raw-fetch-budget.json` = 13 (Stage 26) | Counts raw `fetch(` in `apps/runtime/src` + `packages` outside `services/egress/`; target 0 |
| Money float | (no separate script; enforced by test) | `scripts/money-float-budget.json` = 9 (Stage 27) | `Math.round` over money operands outside the codec |

- `scripts/check-strictness-ratchet.mjs` — runs `tsc --noEmit`, tallies
  `error TS…` per file against the snapshot. `pnpm typecheck` = this script;
  `--update` writes a sorted snapshot. Largest budgets include
  `tests/api.integration.test.ts` (328), `tests/db-write.integration.test.ts`
  (246), `tests/notification-incidents.integration.test.ts` (107),
  `tests/workboard-v2.integration.test.ts` (95),
  `apps/runtime/src/services/sync/executor.ts` (24),
  `packages/shared/src/time.ts` (26),
  `apps/runtime/src/services/spenders.ts` (20), `apps/runtime/src/cli.ts` (17);
  dashboard debt includes `lib/format.ts` (29) and `pages/OfapiCreditsPage.tsx`
  (6).
- The platform-branch and raw-fetch checker scripts are also executed from
  inside the test suite (see the tests map).

## Analytics (`analytics/models/` + `scripts/analytics-run.mjs`)

- `scripts/analytics-run.mjs` — a dbt-style runner invoked as
  `pnpm analytics:run <model>|all`. Each `analytics/models/<name>.sql` owns an
  `analytics_<name>` table, rebuilt atomically (drop + create in a transaction).
  Requires `DATABASE_URL`; prints rows and elapsed ms.
- Three models (each labeled "MACHINE-GENERATED OUTPUT TABLE", Stage 28 v1):
  - `fan_ltv.sql` → `analytics_fan_ltv` — LTV per platform fan (net mills,
    excludes `payout_reversal`).
  - `net_revenue_daily.sql` → `analytics_net_revenue_daily` — net revenue by
    page/model/day, an independent recompute reconciling with `revenue_daily`.
  - `response_sla.sql` → `analytics_response_sla` — chat response median/p95
    minutes derived from `message_archive`.
