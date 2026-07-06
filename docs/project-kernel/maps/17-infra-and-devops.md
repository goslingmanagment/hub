> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# 17 — Infrastructure, Build & Deployment

**Scope.** This document covers the build, packaging, and deployment surface of `core`:
`Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`, `docker-compose.production.yml`,
`.dockerignore`, `pnpm-workspace.yaml`, `vitest.config.ts`, `README.md`, the root `package.json`
build/test scripts, the environment templates (`.env.example`, `.env.docker.example`,
`.env.production.example`), the CI workflow (`.github/workflows/ci.yml`), and every file under
`scripts/` (`build-production.mjs`, `db-generate-disabled.mjs`, `dev-local.sh`,
`deploy-production.sh`, and the six `workboard-v2-*.ts` operational scripts). It also reads the
process entry point that Docker launches (`apps/runtime/src/startup.ts`), the worker health-file
writer (`apps/runtime/src/worker-services.ts`), the config/dotenv loader
(`packages/shared/src/config.ts`), and the migration entry points (`packages/db/src/migrate.ts`,
`packages/db/src/migrate-runner.ts`) to trace how images select a role, run migrations, and emit
health, without re-deriving the runtime internals owned by territory 01 (process roles) and 13
(config/secrets). Cross-referenced territories: **01** (API/worker/CLI process roles), **13**
(config surface & secrets), **18** (tests).

---

## 1. The Docker image (`Dockerfile`)

A single multi-stage Dockerfile produces one runtime image shared by every process role. Build
args at the top (`Dockerfile:1-4`): `BUILDPLATFORM`, `NODE_BASE_IMAGE` (default
`node:22-bookworm-slim`), `APP_DEPENDENCY_CHECKSUM` (default `unknown`), `APP_SOURCE_REVISION`
(default `unknown`).

| Stage | Base | Purpose |
|-------|------|---------|
| `target-base` (`Dockerfile:6-13`) | `${NODE_BASE_IMAGE}` | Enables corepack, sets `PNPM_HOME=/pnpm`, `WORKDIR /app`. |
| `prod-deps` (`Dockerfile:15-26`) | `target-base` | Copies root + per-package `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`, then `pnpm install --prod --frozen-lockfile --filter @agency_hub_core/runtime...` and `pnpm rebuild --pending --filter @agency_hub_core/runtime...`. Produces production-only `node_modules` for the target platform. |
| `build` (`Dockerfile:28-44`) | `--platform=$BUILDPLATFORM ${NODE_BASE_IMAGE}` | Copies the whole `apps/`, `packages/`, `scripts/` tree plus tsconfigs and `vitest.config.ts`, runs `pnpm install --frozen-lockfile`, `pnpm rebuild --pending`, then `pnpm build:production`. Pinned to the **build** platform so `esbuild`/dashboard bundling runs natively even when the runtime targets a different arch. |
| `runtime` (`Dockerfile:46-79`) | `${NODE_BASE_IMAGE}` | Final image. |

**Runtime stage details.** Sets `NODE_ENV=production` and `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
(`Dockerfile:54-55`). Stamps two OCI labels from the build args
(`agency-hub.dependency-checksum`, `agency-hub.source-revision`, `Dockerfile:51-52`) — these labels
are asserted post-deploy (see §5.2). It copies the production `node_modules` from `prod-deps` (root
plus each workspace package, `Dockerfile:66-72`), installs the Playwright chromium browser with
system deps via `node apps/runtime/node_modules/playwright/cli.js install --with-deps chromium`
(`Dockerfile:73`), then copies the compiled outputs from the `build` stage: the Vite dashboard
bundle `apps/dashboard/dist`, the runtime bundle `apps/runtime/dist`, `packages/db/dist`, and the
raw SQL migrations `packages/db/migrations` (`Dockerfile:74-77`).

**Default command.** `CMD ["node", "apps/runtime/dist/startup.js", "worker"]` (`Dockerfile:79`).
Compose files override this per service (see §4).

**Role selection.** `apps/runtime/dist/startup.js` is the entry for both API and worker. In
`resolveRole()` (`startup.ts:35-42`) the role is `process.argv[2] ?? process.env.AGENCY_HUB_ROLE ??
"worker"`; only `"api"` and `"worker"` are accepted, anything else throws. So the second CLI arg
(what every compose `command` passes) wins; `AGENCY_HUB_ROLE` is the env fallback used only when no
arg is given; the ultimate default is `worker`. `main()` (`startup.ts:44-54`) always runs startup
migrations first (§6), then dispatches to `runApiRuntime()` or `runWorkerRuntime()`. On any
unhandled error it calls `process.exit(1)` (not just `exitCode`) so pg-boss timers cannot keep a
zombie alive and Docker's restart policy actually fires (`startup.ts:56-62`).

**Worker health file.** When `WORKER_HEALTH_FILE` is set, `startWorkerServices`
(`worker-services.ts:116,216-225`) writes a JSON document `{ status, timestamp, pid }` to that path
(`writeWorkerHealthFile`, `worker-services.ts:96-103`) once at `ready`, then every
`WORKER_HEALTH_WRITE_INTERVAL_MS = 30_000` ms (`worker-services.ts:54`), and writes `stopping`
during shutdown. The production compose worker healthcheck reads this file's mtime (see §4.3). The
API role does not write a health file; its liveness is the HTTP `/api/v1/health` endpoint.

**`.dockerignore`** (`.dockerignore:1-20`) excludes `node_modules`, `.pnpm-store`, `.git`,
`apps/**/dist`, `coverage`, `output`, `tmp`, `docs`, `drafts`, `reference`, credential material
(`.sessions`, `.om-token`, `.lilly2-session.json`), and all `.env*` files **except**
`.env.example` and `.env.docker.example` (`.dockerignore:6-9`). Real secrets and pre-built dist are
therefore never sent into the build context.

---

## 2. Build pipeline

`pnpm build:production` (`package.json:19`) runs three steps in order: `pnpm typecheck` (`tsc
--noEmit`), `node scripts/build-production.mjs` (server/package bundling), then `pnpm --dir
apps/dashboard build` (Vite dashboard build). `pnpm build` (`package.json:18`) is the dev variant:
typecheck + dashboard build only, no esbuild bundling.

### 2.1 `scripts/build-production.mjs` — esbuild server bundler

Uses `pnpm exec esbuild` to bundle each workspace package into its own `dist/`
(`build-production.mjs:54-91`). Common flags: `--bundle`, `--format=esm`, `--entry-names=[name]`,
`--platform=node`, `--target=node22`. Workspace `@agency_hub_core/*` imports are rewritten to their
`src/index.ts` via `--alias:` (`build-production.mjs:12-18,66-68`). A fixed list of runtime
dependencies is marked `--external` so they resolve from `node_modules` at runtime instead of being
inlined (`runtimeExternal`, `build-production.mjs:20-40`: `fastify` + plugins,
`argon2`, `commander`, `dotenv`, `drizzle-orm`, `pg`, `pg-boss`, `pino`, `socks`, `undici`, `zod`,
`zod-to-json-schema`, `openapi-typescript`). Bundled (non-runtime-external) packages get an ESM
`createRequire` banner (`nodeBundledPackageOptions`, `build-production.mjs:42-45`).

Build order (`build-production.mjs:93-136`): first `Promise.all` cleans all six `dist/` dirs, then
in sequence it bundles `packages/shared` twice — once as a **browser** target
(`platform=browser`, `target=es2022`, entry `src/browser.ts`, no externals) and once as node
(`src/index.ts`) — then `packages/contracts`, `packages/fansly`, `packages/onlyfans`, and
`packages/db` (two entries: `index` and `migrate`). Finally it bundles `apps/runtime` with four
entry points: `api`, `cli`, `startup`, `worker` — these become `apps/runtime/dist/{api,cli,startup,worker}.js`,
the files the Dockerfile CMD and compose commands invoke.

### 2.2 Dashboard build

`pnpm --dir apps/dashboard build` (Vite) produces `apps/dashboard/dist`, copied into the runtime
image (`Dockerfile:74`) and served same-origin by the API (the deploy script verifies `/login`
returns HTML with `id="root"`, §5.2).

### 2.3 `pnpm-workspace.yaml`

Two globs only: `apps/*` and `packages/*`. Package manager pinned in `package.json:5` to
`pnpm@10.30.3` (CI installs the same version, §7). Root `pnpm.overrides` pin `fast-uri@3.1.2`,
`yaml@2.8.3`, and two `brace-expansion` ranges (`package.json:6-12`).

---

## 3. `package.json` script catalog

| Script | Command | Role |
|--------|---------|------|
| `api` (`:15`) | `node --import tsx/esm apps/runtime/src/api.ts` | Dev API (TS via tsx, no build). |
| `api:watch` / `worker:watch` (`:16-17`) | same with `--watch` | Dev hot-reload. |
| `worker` (`:22`) | `node --import tsx/esm apps/runtime/src/worker.ts` | Dev worker. |
| `cli` (`:20`) | `node --import tsx/esm apps/runtime/src/cli.ts` | Dev CLI. |
| `build` (`:18`) | `pnpm typecheck && pnpm --dir apps/dashboard build` | Dev build. |
| `build:production` (`:19`) | typecheck + `build-production.mjs` + dashboard build | Image/CI build. |
| `typecheck` (`:31`) | `tsc --noEmit` | |
| `contracts:generate` (`:21`) | `node --import tsx/esm packages/contracts/src/generate.ts` | Regenerates OpenAPI/contract artifacts. |
| `db:generate` (`:23`) | `node scripts/db-generate-disabled.mjs` | **Intentionally disabled** (see §5.4). |
| `db:migrate` (`:24`) | `node --import tsx/esm packages/db/src/migrate.ts` | Apply migrations (dev/local). |
| `dev` (`:33`) | `bash scripts/dev-local.sh` | One-terminal local stack. |
| `dev:db` (`:34`) | `docker compose up -d postgres` | Postgres only. |
| `dev:dashboard` (`:35`) | `cd apps/dashboard && npx vite` | Vite dev server. |
| `test` / `test:unit` / `test:sync-critical*` / `test:prerequisites` (`:25-30`) | vitest | See §8. |
| `test:watch` (`:32`) | `vitest` | |

Runtime deps live at the repo root (`package.json:51-62`): `fastify` + `@fastify/{cookie,static,swagger,swagger-ui}`,
`fastify-type-provider-zod`, `argon2`, `pg-boss`, `zod-to-json-schema`, `openapi-typescript`.
Dev deps (`:37-50`) include `esbuild@0.25.12` (pinned), `tsx`, `vitest`, `testcontainers`,
`drizzle-kit`, `typescript`, React 19 typings.

---

## 4. Compose topology

Three compose files describe three distinct stacks. All build the same image
(`agency_hub_core/runtime:local` for dev/test, `${RUNTIME_IMAGE:-agency_hub_core/runtime:production}`
for prod).

### 4.1 `docker-compose.yml` — dev host stack

Services: `postgres`, `migrator`, `api`, `worker`.

- **postgres** (`docker-compose.yml:2-17`): `postgres:16`, DB/user/password all hard-coded
  `agency_hub_core`/`postgres`/`postgres`, **port `5432:5432` published to the host**, volume
  `postgres_data`, `pg_isready` healthcheck.
- **migrator** (`:19-30`): builds `.`, runs `node packages/db/dist/migrate.js` once, `env_file:
  .env`, overrides `DATABASE_URL` to the in-network `postgres:5432` DSN and forces
  `SYNC_SHARED_RATE_LIMIT_ENABLED=true`. Waits on `postgres` healthy. Runs to completion; the API
  and worker gate on `service_completed_successfully`.
- **api** (`:31-46`): `node apps/runtime/dist/startup.js api`, **port `3000:3000`**, same env
  overrides, depends on postgres healthy + migrator completed.
- **worker** (`:47-58`): `node apps/runtime/dist/startup.js worker`, no published port; references the
  already-built `agency_hub_core/runtime:local` image (no `build:` key of its own).

### 4.2 `docker-compose.test.yml` — local Docker dev with real credentials

Same four services and topology as the dev stack, differing in three ways
(`docker-compose.test.yml`): `env_file` is **`.env.docker`** (not `.env`), no per-service
`environment:` overrides, and each of `migrator`/`api`/`worker` mounts two host credential files
read-only — `./.sessions:/app/.sessions:ro` and `./.om-token:/app/.om-token:ro`
(`docker-compose.test.yml:24-26,38-40,51-53`). Despite the `.test.yml` name this is the
local-Docker-development stack described in `README.md:275` ("`.env.docker.example` is for local
Docker-based development"), not the vitest test harness — vitest uses Testcontainers, not compose
(§8).

### 4.3 `docker-compose.production.yml` — production stack

Services: `postgres`, `api`, `worker`. **No `migrator` service** — migrations run inside
`startup.js` under an advisory lock on both the API and worker (§6). Interpolation values come from
`--env-file .env.production` (`README.md:60,65`).

- **postgres** (`:2-16`): `postgres:16`, DB/user from `${POSTGRES_DB:-agency_hub_core}` /
  `${POSTGRES_USER:-postgres}`, `POSTGRES_PASSWORD` **required** (`${POSTGRES_PASSWORD:?Set
  POSTGRES_PASSWORD in .env.production}` — compose refuses to start without it). **No published
  port** (loopback-internal only). `pg_isready` healthcheck with a `start_period`.
- **api** (`:18-41`): image `${RUNTIME_IMAGE:-agency_hub_core/runtime:production}`, `build: .`,
  `restart: unless-stopped`, `env_file: .env.production`, command `startup.js api`. **Published only
  on `127.0.0.1:3000:3000`** (loopback; a TLS reverse proxy is expected in front, `README.md:57-60`).
  Healthcheck is a Node one-liner that `fetch`es `http://127.0.0.1:${API_PORT||3000}/api/v1/health`
  and exits non-zero unless `res.ok` (`:30-41`).
- **worker** (`:43-67`): same image, `restart: unless-stopped`, sets
  `WORKER_HEALTH_FILE=/tmp/agency-hub-worker-health.json` (`:49`), command `startup.js worker`,
  depends on `postgres` healthy **and** `api` healthy. Its healthcheck (`:56-67`) is a Node
  one-liner that (a) `fs.statSync` the health file and throws if `Date.now() - mtimeMs > 90000` (90s
  stale window vs the 30s writer interval) and (b) opens a `pg` client on `DATABASE_URL` and runs
  `select 1`. So worker "healthy" = fresh heartbeat file **and** live DB connection.
- Volume `postgres_data` (`:69-70`).

**Port exposure summary.** Dev/test publish Postgres `5432` and API `3000` on all interfaces;
production publishes neither Postgres nor exposes the API beyond `127.0.0.1:3000`.

---

## 5. `scripts/` catalog

### 5.1 `dev-local.sh` — one-terminal local dev

`pnpm dev` → `scripts/dev-local.sh` (`package.json:33`). Flow:

1. If `.env` is missing, `create_env()` copies `.env.example` → `.env` with a freshly generated
   32-byte base64 `APP_ENCRYPTION_KEY` (`node crypto.randomBytes(32).toString('base64')`,
   `dev-local.sh:8-17,88-90`). If `.env` exists but still has the literal placeholder
   `APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key`, it substitutes a real key in place
   (`dev-local.sh:19-24,91-94`).
2. Resolves an API port: reads `API_PORT` from env or `.env` (default 3000) and scans up to +99 for
   a free TCP port via `lsof` (`find_available_port`, `dev-local.sh:65-107`).
3. `pnpm dev:db` (Docker Postgres), waits on `pg_isready` inside the container, then `pnpm db:migrate`
   (`dev-local.sh:109-118`).
4. Starts `pnpm api`, `pnpm worker`, and `pnpm dev:dashboard` as backgrounded jobs, passing
   `API_PORT` to api/worker and `VITE_API_PROXY_TARGET=http://127.0.0.1:<port>` to the dashboard
   (`dev-local.sh:137-147`). A trap cleans up all child process groups on `INT`/`TERM`/`EXIT`
   (`dev-local.sh:120-135`); if any process exits, the script tears the rest down and exits with
   that status (`dev-local.sh:149-167`).

### 5.2 `deploy-production.sh` — local-build / remote-ship / remote-verify

An `ssh`-driven deployer (no CI/CD registry). ~1060 lines; key mechanics:

**CLI/env inputs** (`deploy-production.sh:73-160`, defaults in parens): positional `<user@host>`
(`DEPLOY_REMOTE`); `--app-dir` (`/opt/agency-hub`); `--image` (`agency_hub_core/runtime:production`);
`--mode` `full`|`dist-only`|`auto` (`full`); `--node-base-image` (`node:22-bookworm-slim`);
`--node-base-cache-image` (`agency_hub_core/node:22-bookworm-slim`); `--allow-unlabeled-dist-base`;
`--port` (`3000`); `--verify-url`; `--identity`; `--ssh-port`. Every flag has a `DEPLOY_*` env
equivalent. Build platform is **hard-coded `linux/amd64`** (`:190`).

**Build metadata / tags** (`initialize_deploy_metadata_and_tags`, `:288-302`):
`APP_DEPENDENCY_CHECKSUM` = a SHA-256 over the SHA-256s of a fixed manifest set (`Dockerfile`,
root + all workspace `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`) (`:249-261,772-782`);
`APP_SOURCE_REVISION` = `git rev-parse --short=12 HEAD` with a `-dirty` suffix when the worktree is
dirty (`:784-794`). These become the two image labels baked in §1, and per-run candidate / rollback
/ dist-base tags.

**Locks.** A local lock dir under `$TMPDIR` keyed by a hash of the repo path
(`acquire_local_deploy_lock`, `:304-335`) and a remote lock dir `${APP_DIR}/.deploy.lock`
(`acquire_remote_deploy_lock`, `:370-412`, exits `73` if held) prevent concurrent deploys racing
shared production state. Both record metadata and an `owner` = the run id, and are only removed by
their owner in `cleanup_deploy` (`:343-368`).

**Preflight** (`preflight_migration_files`, `:414-447`): fails if any hidden `.*.sql` files exist
in `packages/db/migrations` (macOS AppleDouble sidecars — `COPYFILE_DISABLE=1` is exported at the top,
`:7`) or if any migration filename does not match `^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$`.

**Build modes** (`build_candidate_image`, `:956-974`):
- `full`: `ensure_node_base_cache` pulls+validates `linux/amd64` node base into a stable local cache
  tag (`:796-836`), `docker build --platform=linux/amd64` with the three build args (`:838-849`),
  then `docker save … | ssh … docker load` streams the image to the host (`:851-854`).
- `dist-only`: refuses unless a rollback image was captured and its
  `agency-hub.dependency-checksum` label matches the current checksum (or
  `--allow-unlabeled-dist-base`) (`validate_dist_only_base`, `:862-886`); runs `pnpm build:production`
  locally, tars only the `dist/`+`migrations` overlay paths (`:263-272`), uploads them, and builds a
  thin `FROM <current-production-image>` overlay image **on the remote host** (`:903-954`).
- `auto`: try full, fall back to dist-only only if the full build fails **before** the remote
  release is modified (`:965-972`).

**Release sync + recreate** (`:1010-1035`): tars a fixed file set to the remote `$APP_DIR`
(`REMOTE_RELEASE_FILES`: `Dockerfile`, `.dockerignore`, `.env.production.example`, `README.md`,
`docker-compose.production.yml`, `scripts/deploy-production.sh`, `:236-247`), validates the remote
has `.env.production` and a valid `docker compose config`, captures the remote `schema_migrations`
baseline (`:1021-1026`), tags the candidate → `IMAGE_TAG`, and runs
`docker compose --env-file .env.production -f docker-compose.production.yml up -d --remove-orphans
--force-recreate --no-build`.

**Verification** (`:1037-1058`): polls `/api/v1/health` for `200` containing `"checks"`
(`wait_for_api_health`, `:678-694`); polls the worker container until its compose healthcheck
reports `healthy` (`wait_for_worker_health`, `:699-719`); asserts both running `api` and `worker`
images carry labels equal to this deploy's revision+checksum (`verify_post_deploy_image_labels`,
`:740-770`); if `HEALTH_SYNC_MONITORING_TOKEN` is set in the remote `.env.production`, polls
`/api/v1/health/sync` for `200`/`503` containing `"pages"` with the token in `x-monitoring-token`
(`:1045-1051,721-738`); and fetches `/login` asserting HTTP 200 + `<!doctype html>` + `id="root"`
(`:1053-1057`).

**Rollback** (`rollback_remote_stack`, `:543-602`): only if a previous image was captured
(`capture_remote_rollback_image`, `:465-475`) **and** the `schema_migrations` set is unchanged
since the pre-deploy baseline, or changed only by an allowlisted set of rollback-compatible data
migrations (`ROLLBACK_COMPATIBLE_MIGRATIONS`, `:223-230`; `schema_migration_delta_allows_rollback`,
`:513-533`). It restores the previous release files, re-tags the rollback image → `IMAGE_TAG`,
recreates the stack, and re-checks API health. On unrecoverable failure it dumps `docker compose ps`
+ 200 lines of `postgres`/`api`/`worker` logs (`dump_remote_diagnostics`, `:459-463`). The
schema-migration capture runs inside the postgres container under `pg_advisory_xact_lock(31415,
27182)` — the same lock keys the app uses at startup (`:607-623`; keys match `startup.ts:8-9`).

Verification can run either directly (`curl` from the workstation to `--verify-url`) or over SSH
(`VERIFY_VIA_SSH=1` when `--verify-url` is omitted, `:192-196,642-676`).

### 5.3 `db-generate-disabled.mjs`

`pnpm db:generate` deliberately errors. The script scans `packages/db/migrations`, computes the next
`NNNN` prefix, prints an instruction to hand-write a numbered SQL file and run `pnpm db:migrate`,
and exits non-zero (`db-generate-disabled.mjs:23-34`). It states the repo intentionally keeps no
Drizzle migration journal in `migrations/meta` and that `drizzle-kit generate` must not be run.

### 5.4 `workboard-v2-*.ts` — operational/analysis scripts (run via `tsx`)

Six one-off scripts not wired into `package.json`; each is invoked directly as
`node --import tsx/esm scripts/<name>.ts`. They import from `@agency_hub_core/db` and
`apps/runtime/src/services/workboard-v2/*`. They read env at runtime (not through the compose stack):

| Script | Env read | Behavior |
|--------|----------|----------|
| `workboard-v2-classify.ts` | `DATABASE_URL`, `ANTHROPIC_API_KEY`, `WB_CLOSING_LLM_MODEL` (default `claude-haiku-4-5`) | Runs the L2 closing classifier for one page against Anthropic, then recomputes (`workboard-v2-classify.ts:9-20`). |
| `workboard-v2-reclassify-page.ts` | `DATABASE_URL`, `ANTHROPIC_API_KEY` | Clears the closing cache, reclassifies backlog, recomputes for one page. |
| `workboard-v2-eval-classifier.ts` | `ANTHROPIC_API_KEY` (no DB) | Offline gold-set eval of the closing classifier; non-zero exit on a false `buy_signal`. |
| `workboard-v2-recompute.ts` | `DATABASE_URL` | Recompute one page or `all`. |
| `workboard-v2-show-verdicts.ts` | `DATABASE_URL` | Read-only: recent classifier verdicts for one page. |
| `workboard-v2-inspect-dialogs.ts` | `DATABASE_URL` | Read-only: dump classified dialogs + verdicts (no writes). |

`ANTHROPIC_API_KEY` and `WB_CLOSING_LLM_MODEL` are consumed by these scripts (and by the config
loader, §9) but are **not present in any `.env.*.example`** — the only Anthropic reference in the
templates is `CHATMUSE_AI_GATEWAY_ENABLED` (`.env.production.example:215`).

---

## 6. Migrate-on-deploy flow

There is no standalone migration step in production compose; migrations run in-process at startup.
`startup.ts:runStartupMigrations` (`startup.ts:11-33`) opens a `pg` pool on `config.databaseUrl`,
takes a session-level `pg_advisory_lock(31415, 27182)` (`MIGRATION_LOCK_KEY_1/2`,
`startup.ts:8-9`), calls `runMigrations({ databaseUrl, db: client })`, then unlocks and closes.
Because both API and worker call this before dispatching to their role (`startup.ts:45-53`), the
advisory lock serializes them so only one applies migrations while the other waits.

`runMigrations` lives in `packages/db/src/migrate-runner.ts` (re-exported by
`packages/db/src/migrate.ts:3`); the migrate runner reads the numbered SQL files via
`resolveMigrationFiles` (`migrations-dir.ts`), asserts unique prefixes and a contiguous applied
prefix (`assertUniqueMigrationPrefixes`, `assertContiguousAppliedPrefix`,
`migrate-runner.ts:13,33`), and records applied ids in the `schema_migrations` table (the table the
deploy script snapshots for rollback safety, §5.2). `migrate.ts` can also run standalone as the
`db:migrate` CLI and as `packages/db/dist/migrate.js` (the dev/test compose `migrator` command,
§4.1). `README.md:96-99` confirms: applied migrations are skipped on re-run; recreating the stack
is safe.

---

## 7. CI (`.github/workflows/ci.yml`)

One workflow, `CI`, one job `quality` on `ubuntu-latest`, triggered on every `pull_request` and on
`push` to `main` (`ci.yml:3-12`). Steps (`ci.yml:14-46`):

1. `actions/checkout@v4`.
2. `pnpm/action-setup@v4` pinned to `10.30.3` (matches `package.json` packageManager).
3. `actions/setup-node@v4` Node 22 with pnpm cache.
4. `pnpm install --frozen-lockfile`.
5. `pnpm typecheck`.
6. `pnpm build:production` (full esbuild + dashboard build).
7. `docker build --target runtime -t agency_hub_core/runtime:ci .` — builds the production Docker
   image to prove the Dockerfile still assembles (no push).
8. `pnpm test:unit` (reliable unit tests).
9. `pnpm test:prerequisites` → `pnpm test:sync-critical` (DB/schema/network integration subset).

There is **no deploy job** — deployment is manual via `scripts/deploy-production.sh` (§5.2). CI runs
the sync-critical DB tests, which require Docker/Testcontainers, on the GitHub runner.

---

## 8. Test harness split (`vitest.config.ts` + `package.json`)

`vitest.config.ts` sets `environment: "node"`, includes `tests/**/*.test.ts`, and applies
`INTEGRATION_TEST_TIMEOUT_MS` (from `tests/helpers/timeouts.ts`) to both hook and test timeouts
(`vitest.config.ts:20-28`). Resolve aliases mirror the workspace `@agency_hub_core/*` packages plus
`@/` → `apps/dashboard/src` and pin `react`/`react-dom`/`react-router` to the dashboard's
`node_modules` (`vitest.config.ts:7-19`). Coverage reporters: `text`, `lcov`.

Test scripts (`package.json:25-30`), all with `NODE_OPTIONS=--max-old-space-size=8192`:

| Script | Selection |
|--------|-----------|
| `test` | `vitest run` — everything. |
| `test:unit` | `vitest run` excluding `*.integration.test.ts`, `schema-guard.test.ts`, `http-client.test.ts`, `network.test.ts` (the non-Docker subset). |
| `test:sync-critical:db` | `--no-file-parallelism` over `*.integration.test.ts` + schema-guard/http-client/network, **excluding** `api.integration.test.ts`. |
| `test:sync-critical:api` | `--no-file-parallelism` `api.integration.test.ts` filtered to a `--testNamePattern` allowlist (auto-queues, initial sync, retry path, sync health, proxy, page credentials, admin verify, sync monitor/block controls, request limits, system health, …). |
| `test:sync-critical` | runs `:db` then `:api`. |
| `test:prerequisites` | alias for `test:sync-critical`. |

Integration tests use **Testcontainers** (`testcontainers` devDep, `package.json:46`), not the
compose files — the compose stacks are for running the app, not the vitest suite (see territory 18).

---

## 9. Environment variable catalog

Templates: `.env.example` (host dev), `.env.docker.example` (local Docker dev), and the fully
annotated `.env.production.example`. All three note "unset values use the runtime defaults from
`packages/shared/src/config.ts`" — the Zod schema in that file is the source of truth; templates are
a subset. Grouped below (names + purpose only).

**Database / core runtime**

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | App DSN for API, worker, CLI, startup migrations. Required. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Bundled Postgres container settings (production compose only; `POSTGRES_PASSWORD` required). |
| `LOG_LEVEL` | pino level (default `info`). |
| `API_HOST` / `API_PORT` | Bind address / HTTP port (defaults `0.0.0.0` / `3000`). |
| `TRUST_PROXY` | How much of `x-forwarded-*` to trust for `request.ip` (login rate-limit key). `false`\|`true`\|hop count\|CIDR allowlist. Default false; `1` for the one-proxy production setup (`.env.production.example:36-46`). |
| `SESSION_TTL_DAYS` | Dashboard session lifetime (default 30). |

**Secrets / credentials**

| Var | Purpose |
|-----|---------|
| `APP_ENCRYPTION_KEY` | Write key for encrypted stored credentials & proxy secrets. base64 → exactly 32 bytes. Required (`config.ts:75,325`). |
| `APP_ENCRYPTION_KEY_RING` | Optional legacy decrypt keys, `version:base64[,…]` (`config.ts:76,326`). |
| `APP_ENCRYPTION_KEY_VERSION` | Version stamped on new encrypted rows (default 1). |
| `HEALTH_SYNC_MONITORING_TOKEN` | Optional token accepted as `x-monitoring-token` for `/api/v1/health/sync`. |

**Fansly sync**

`FANSLY_BASE_URL`, `FANSLY_DEFAULT_DELAY_MS` (+ deprecated aliases `FANSLY_GLOBAL_DELAY_MS`,
`FANSLY_ACCOUNT_LOOKUP_DELAY_MS` — fallback chain in `config.ts:332-336`), `FOLLOWER_PAGE_DELAY_MS`,
`FANSLY_DM_CONVERSATIONS_DELAY_MS`, `FANSLY_DM_MESSAGES_DELAY_MS` (sub-5000 raised to 5000),
`FANSLY_DM_DEEP_BACKFILL_ENABLED` and its `*_MAX_REQUESTS_PER_RUN` / `*_LIVE_REQUESTS_PER_DEEP` /
`*_CONTINUATION_DELAY_MS` / `*_CONTINUATION_JITTER_MS` knobs.

**OnlyFans (OnlyMonster) sync**

`ONLYMONSTER_BASE_URL`, `ONLYFANS_DEFAULT_DELAY_MS`, `ONLYFANS_TOP_SPENDERS_ENABLED`, and the public
profile resolver group `ONLYFANS_PUBLIC_PROFILE_RESOLUTION_ENABLED` / `_ALLOW_DIRECT` / `_PROXY_URL`
/ `_MAX_PER_RUN` / `_DELAY_MS`.

**Shared sync / observability**

`SYNC_SHARED_RATE_LIMIT_ENABLED` (runtime default false, forced `true` in dev/test compose and both
example env files), `SYNC_PAGE_EXECUTOR_CONCURRENCY` (default 4), `SYNC_HTTP_TRACE_FILE`,
`TRANSACTION_LOOKBACK_DAYS`, `TRANSACTION_RESCAN_CAP_DAYS`, `SYNC_OBSERVABILITY_RETENTION_DAYS`,
`HEALTH_SYNC_LIGHT_MAX_AGE_MINUTES`, `HEALTH_SYNC_FOLLOWER_MAX_AGE_MINUTES`.

**OFAPI (onlyfansapi.com)** — mostly default-off feature flags (`.env.production.example:147-225`)

`OFAPI_API_KEY` (admin webhook registration; empty → registration returns 503), `OFAPI_BASE_URL`,
`OFAPI_EVENT_RETENTION_DAYS`, `OFAPI_REST_DELAY_MS`, and flags/budgets:
`OFAPI_DM_PROJECTION_ENABLED`, `OFAPI_DM_SYNC_ENABLED`, `OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN`,
`OFAPI_DM_DAILY_CREDIT_BUDGET`, `OFAPI_CREDIT_FLOOR`, `OFAPI_DM_RECONCILE_INTERVAL_MINUTES`,
`OFAPI_ACCOUNT_HEALTH_ENABLED`, `OFAPI_CREDIT_ALERT_THRESHOLD`,
`OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES`, `OFAPI_CREDIT_LEDGER_ENABLED`,
`OFAPI_BURN_ALERT_CREDITS_PER_HOUR`, `OFAPI_CREDIT_MICRO_USD_PRICE`, `OFAPI_BALANCE_PING_ENABLED`,
`OFAPI_AUDIENCE_SYNC_ENABLED` (+ `_MAX_REQUESTS_PER_RUN`, `_DAILY_CREDIT_BUDGET`,
`_SWEEP_INTERVAL_MINUTES`), `OFAPI_PRESENCE_PROJECTION_ENABLED`,
`OFAPI_DESKTOP_READ_GATEWAY_ENABLED` (requires `OFAPI_CREDIT_LEDGER_ENABLED`).

**AI gateway / Anthropic**

`CHATMUSE_AI_GATEWAY_ENABLED` (default off; when on + `ANTHROPIC_API_KEY` present, core executes
Anthropic streams through `/api/v1/ai/gateway/stream`), `CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT`
(200), `CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT` (5_000_000 = $5.00),
`CHATMUSE_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT` (config-only, `config.ts:151`), `ANTHROPIC_API_KEY`,
`WB_CLOSING_LLM_ENABLED` (gated on `ANTHROPIC_API_KEY` present, `config.ts:434`), `WB_CLOSING_LLM_MODEL`
(default `claude-haiku-4-5`). The last three are consumed by config + the workboard scripts but are
absent from the env templates (§5.4).

**Telegram**

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_PROXY_PAGE_LABEL` (egress via a stored page
proxy), `TELEGRAM_REPORT_HOUR` (UTC hour of the daily revenue report, default 9).

**Docker/compose interpolation-only**

`RUNTIME_IMAGE` (production image tag override), `WORKER_HEALTH_FILE` (set by production compose,
read by the worker healthcheck and health writer). `DOTENV_CONFIG_QUIET` toggles dotenv's quiet
mode (`config.ts:320`).

---

## 10. Boundaries (what crosses the deployment surface)

- **Postgres (storage).** Every runtime process and the deploy script's schema snapshot connect via
  `DATABASE_URL`. On startup the API/worker write to `schema_migrations` under advisory lock
  `(31415, 27182)`; the deploy script reads `schema_migrations` before/after recreate for rollback
  gating (`deploy-production.sh:604-623`). Production Postgres has no published port; dev/test expose
  `5432`.
- **Inbound HTTP: `GET /api/v1/health`.** Public, unauthenticated liveness. Returns
  `{ statusCode, body }` where body includes a `"checks"` object; HTTP 200 or 503
  (`server.ts:631-637`, `getSystemHealth`). Consumed by the production compose api healthcheck, the
  deploy verifier, and external monitors.
- **Inbound HTTP: `GET /api/v1/health/sync`.** Authorized by an owner/dashboard session or
  `x-monitoring-token` = `HEALTH_SYNC_MONITORING_TOKEN`. Returns per-page sync state
  (`"pages"` array), 200 or 503 (`server.ts:639-648`, `getPublicSyncHealth`). Consumed by the deploy
  verifier and external alerting.
- **Filesystem heartbeat (storage).** Worker writes `{ status, timestamp, pid }` to
  `WORKER_HEALTH_FILE` (`/tmp/agency-hub-worker-health.json`) every 30s; the compose worker
  healthcheck reads its mtime with a 90s stale threshold plus a `select 1` DB probe
  (`docker-compose.production.yml:56-67`, `worker-services.ts:96-103,216-238`).
- **Outbound: Docker registry + Playwright CDN (build time).** The Docker build pulls
  `node:22-bookworm-slim` (via the local cache tag in the deploy path) and the runtime stage
  downloads the Playwright chromium browser (`Dockerfile:73`, `deploy-production.sh:796-836`).
- **Outbound: SSH deploy channel.** `deploy-production.sh` opens `ssh <user@host>` to: stream the
  built image (`docker save | ssh docker load`), tar release files into `$APP_DIR`, run remote
  `docker compose … up`, `docker inspect`/`docker tag` for rollback, `psql` inside the postgres
  container for schema snapshots, and `curl` health endpoints. It reads
  `HEALTH_SYNC_MONITORING_TOKEN` from the **remote** `.env.production`
  (`deploy-production.sh:535-541,1018`). Remote host is assumed to already hold a populated
  `/opt/agency-hub/.env.production` (`README.md:205`).
- **Secrets at rest.** `.env` / `.env.docker` / `.env.production` are git/`.dockerignore`-excluded;
  only `*.example` templates ship. Session/token credential files (`.sessions`, `.om-token`) are
  bind-mounted read-only into the local Docker dev stack (`docker-compose.test.yml`) and excluded
  from the build context.

---

## 11. Discrepancies & notes

- **No `DOTENV_KEY` / dotenv-vault scheme exists.** The task brief referenced a `DOTENV_KEY`
  encrypted-env scheme; the codebase has none. Config loading uses the plain `dotenv` package
  (`config.ts:1,317-322`), which reads an unencrypted `.env` from the process CWD. There is no
  `.env.vault` file, no `DOTENV_KEY`, and no `dotenv-vault` dependency anywhere in the repo. The only
  dotenv-related env var is `DOTENV_CONFIG_QUIET` (verbosity).
- **`docker-compose.test.yml` is not the vitest harness.** Its name suggests a test stack, but it is
  the local-Docker **development** stack (`.env.docker`, credential mounts). The automated tests run
  under vitest + Testcontainers (§8), independent of any compose file.
- **`ANTHROPIC_API_KEY`, `WB_CLOSING_LLM_ENABLED`, `WB_CLOSING_LLM_MODEL` are undocumented in the
  templates.** They are valid schema keys (`config.ts:153-155`) and required by the `workboard-v2`
  scripts, yet absent from `.env.example` / `.env.production.example`.
- **`SYNC_SHARED_RATE_LIMIT_ENABLED` default mismatch.** The Zod runtime default is `false`
  (`.env.production.example:111` comment: "Runtime default: false"), but both example env files and
  the dev/test compose files set it to `true`.
- **Default role is `worker`, not `api`.** The Dockerfile `CMD` and `startup.ts` default both
  resolve to `worker` when no role arg/env is supplied; API is only reached when a compose command
  passes `api` explicitly.
- **Migration generation is disabled by design.** `pnpm db:generate` always exits non-zero; the repo
  uses hand-written numbered SQL migrations with no Drizzle journal (§5.3), and the deploy preflight
  enforces the `NNNN_name.sql` filename convention.
