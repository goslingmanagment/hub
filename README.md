# Agency Hub

Agency Hub is a single-origin dashboard + API for syncing Fansly and OnlyFans page data into PostgreSQL, running background sync workers, and operating the system from one Docker Compose stack.

For v1.0 production:
- the dashboard and API are served from the same origin; production internet exposure should be behind TLS
- the production container runs compiled Node.js output, not `tsx`
- migrations run automatically on API, scheduler, and worker startup under a Postgres advisory lock
- crashed services restart automatically through Docker restart policies
- public process/database health is available at `/api/v1/health`
- detailed sync health at `/api/v1/health/sync` requires an owner or dashboard session, or a configured `HEALTH_SYNC_MONITORING_TOKEN` sent as `x-monitoring-token`
- Swagger/OpenAPI docs at `/documentation` and `/api/v1/openapi.json` require an owner dashboard session

Recurring off-server backups and disaster-recovery restore drills are outside the owner-approved product scope. Do not assume built-in backup or restore scripts exist.

## Production Prerequisites

- Linux server with Docker Engine and Docker Compose plugin
- Git
- A reachable public IP or hostname
- TLS termination through a reverse proxy or load balancer for public dashboard access
- One 32-byte base64 encryption key for stored credentials
- Valid Fansly sessions and/or an `OFAPI_API_KEY` for the pages you will onboard

## Production Files

- `.env.production.example`: canonical production environment template
- `docker-compose.production.yml`: production stack with `postgres`, `api`, `scheduler`, and `worker`
- `scripts/deploy-production.sh`: local build or verified registry pull + remote verification

## First Production Deploy

1. Clone the repo on the server:

```bash
git clone <YOUR_GITHUB_REPO_URL> agency-hub
cd agency-hub
```

2. Create the production env file:

```bash
cp .env.production.example .env.production
```

3. Generate an encryption key and put it into `APP_ENCRYPTION_KEY` in `.env.production`:

```bash
openssl rand -base64 32
```

4. Edit `.env.production` and set at least:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `APP_ENCRYPTION_KEY`
- `TRUST_PROXY=1` when the app is behind the production TLS reverse proxy (one trusted hop; the proxy must append the client address to `X-Forwarded-For` — see `.env.production.example`)
- any optional Telegram values you want enabled
- the complete `SERVICE_EGRESS_PROXY_URL` / `SERVICE_EGRESS_PROXY_USERNAME` /
  `SERVICE_EGRESS_PROXY_PASSWORD` tuple before enabling Telegram delivery or
  ElevenLabs voice synthesis (see
  [`.env.production.example`](.env.production.example))

The default production compose file expects the bundled Postgres container and binds the app to `127.0.0.1:3000`. Put a TLS reverse proxy on the same host in front of that loopback port. Compose reads interpolation values from `.env.production`; the API, scheduler, and worker receive the application environment, while Postgres receives only `POSTGRES_*`.

5. Build and start the stack:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

6. Wait for the API to come up and confirm health:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

`/api/v1/health` should return HTTP `200`. If external monitoring needs detailed per-page sync state, set `HEALTH_SYNC_MONITORING_TOKEN` in the runtime environment and call `/api/v1/health/sync` with that value in the `x-monitoring-token` header. That endpoint may return HTTP `200` or `503`, because it reports real per-page sync state rather than simple process liveness.

7. Create the first owner account. Read the password without echoing or embedding it in the command line, then export the already-populated variable:

```bash
read -r -s -p 'Initial owner password: ' INITIAL_OWNER_PASSWORD
printf '\n'
export INITIAL_OWNER_PASSWORD
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js user add \
  --username owner \
  --role owner \
  --password-env INITIAL_OWNER_PASSWORD
unset INITIAL_OWNER_PASSWORD
```

8. Open the dashboard from the same origin as the API:

```text
https://YOUR_DOMAIN/login
```

Sign in with the owner account you just created. The dashboard onboarding flow can add models and pages from the browser.

## First Run Notes

- The API, scheduler, and worker start through `apps/runtime/dist/startup.js`, which runs migrations before handing off to the role-specific process.
- Restarting the stack or re-running `docker compose ... up -d --build` is safe. Applied migrations are skipped automatically.
- The worker is a separate service using the same image, so background sync work does not share the API process.

## Operating The System

### Add the first model from the CLI

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js model add \
  --slug lora \
  --name "Lora"
```

### Add pages from the CLI

Fansly:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js page add fansly \
  --model lora \
  --label lora-main \
  --session-file /run/secrets/lora-main.session.json
```

The session file must already exist inside the container if you use the CLI this way. For most first-time production setups, the dashboard onboarding flow is simpler.

OnlyFans via OFAPI:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js page add onlyfans \
  --model lora \
  --label lora-of \
  --username lora_onlyfans
```

`OFAPI_API_KEY` must already be configured in `.env.production`. The CLI resolves the connected OFAPI account and stores the page mapping; it does not accept a per-page OnlyMonster token.

### Trigger a manual sync

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js sync \
  --page lora-main \
  --scope all
```

### Inspect sync state from the CLI

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js sync status
```

## Updating An Existing Deployment

Production updates must go through the deploy helper in the next section. It provides migration preflight checks, local and remote locks, immutable image labels, health verification, and rollback. Do not use `git pull && docker compose up -d --build` as the normal production update path; that bypasses those safeguards.

For a disposable local environment only, rebuilding an existing checkout remains:

```bash
git pull
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

This local-development command rebuilds the image and lets startup handle migrations automatically. It is not the production deployment procedure.

## Remote Deployment From Your Workstation

If you want to build locally and push the image to a remote host over SSH:

```bash
scripts/deploy-production.sh user@server --verify-url https://YOUR_DOMAIN
```

On Apple Silicon workstations, this deploy path still targets `linux/amd64` for amd64 servers. The Docker build compiles the JS/TS artifacts in a native build stage while installing runtime dependencies for the target platform, which avoids running `esbuild` under amd64 emulation during the production build.

By default the script uses `--mode full`:

- it runs migration filename preflight checks before the Docker build
- it acquires local and remote deploy locks so two deploys cannot race over shared production state
- it performs a full Docker image build and does not fall back to dist-only unless `--mode auto` is explicitly requested
- the canonical `node:22-bookworm-slim` base image is validated for `linux/amd64` and used unchanged by BuildKit, so a local alias cannot be mistaken for a private Docker Hub namespace
- every built runtime image is labeled with the dependency checksum and source revision
- after health checks, the running API, scheduler, and worker images must have labels matching the source revision and dependency checksum for this deploy
- after a successful full deploy, the verified candidate is published under a dependency-checksum clean-base tag for future dist-only releases
- BuildKit keeps native-build and target-runtime pnpm/Corepack caches separate; nested host `node_modules` and built `dist` trees stay out of the Docker context, and CI launches the bundled Chromium Headless Shell from the final runtime image

Older deploy wrappers may still pass `--node-base-cache-image` or set
`DEPLOY_NODE_BASE_CACHE_IMAGE`. Both forms remain accepted as deprecated
compatibility shims, emit a warning, and are ignored; only the canonical
`--node-base-image` / `DEPLOY_NODE_BASE_IMAGE` value can select the image used
for validation and the Docker build.

`--mode auto` is available only as an explicit opt-in. In auto mode, if the full build fails before the remote release is modified, the script can fall back to a dist-only overlay build from the clean full image published by the latest successful full deploy for the same dependency checksum. The running production and rollback images are never used as dist bases, so repeated dist-only releases do not accumulate previous artifact layers.

Dist-only mode requires that checksum-keyed clean full image to exist on the remote host. Bootstrap it with a full deploy whenever the tag is absent or the dependency checksum changes. The compatibility override is reserved for a manually retained clean full image that predates dependency labels; it does not permit falling back to the running production image:

```bash
scripts/deploy-production.sh --mode dist-only --allow-unlabeled-dist-base \
  user@server --verify-url https://YOUR_DOMAIN
```

Use the default `--mode full` when runtime dependencies, Dockerfile structure, Playwright/system dependencies, or package installation behavior changes.

What the script does:

- obtains a per-run candidate by local full build, verified dist-only overlay, or immutable GHCR digest pull
- builds each dist-only image as the clean full image plus one four-layer dashboard/runtime/database/migrations artifact overlay
- streams a locally built image to the remote host with `docker load`
- syncs release files into `/opt/agency-hub` by default
- by default verifies that PostgreSQL and shared Compose infrastructure are unchanged, then recreates `api worker scheduler` and, once the API is healthy (startup migrations done), the Fansly Sync Engine's `sync` container on its own, so the old engine keeps running through the migrations; `--recreate-scope stack` explicitly restores whole-stack recreation for infrastructure updates
- verifies `/api/v1/health`, worker, scheduler and sync container health, running image labels, `/api/v1/health/sync`, and same-origin dashboard delivery at `/login`
- if verification fails after the stack is recreated, rolls back to the previous remote image when one was captured and `schema_migrations` did not change during the failed deploy, then prints `docker compose ps` plus recent `postgres`, `api`, `worker`, and `sync` logs automatically

### Deploy a prebuilt image (pull mode)

CI builds the runtime image and runs its Chromium, native-library and startup
smoke checks, but it no longer publishes images: production images are built
on the server (`--mode full` or `dist-only`). Pull mode needs an image that
someone published to GHCR manually, by immutable digest, from the exact commit
being deployed.

Check out that exact commit in a clean working copy (including no untracked
release inputs), authenticate the VPS to GHCR with package-read access once,
and use the digest of that manually published image:

```bash
scripts/deploy-production.sh --mode pull \
  --pull-image ghcr.io/goslingmanagment/hub/runtime@sha256:<64-hex-digest> \
  user@server --verify-url https://YOUR_DOMAIN
```

Replace the digest placeholder; a mutable tag is refused. Pull mode does not
need a local Docker daemon or build. Before any service is stopped, it verifies
Linux/amd64, source revision and the shared dependency checksum against the
local checkout. Release files and the production-pinned CLI come from that
same checkout. A pulled image does not need or publish a dist-only clean base.
The existing migration, lifecycle, rollback and health gates still apply;
publishing an image does not authorize a production deployment.

`--recreate-scope apps` is the default for **all** build modes. It refuses an
absent/unhealthy PostgreSQL container, a changed PostgreSQL service/image or
changed project/network/volume/config/secret definitions. This check happens
before quiesce and again before promotion. Ordinary app releases preserve the
PostgreSQL container and Compose's existing health dependencies. For a reviewed
infrastructure update, explicitly use `--recreate-scope stack`. Rollback retains
its existing whole-stack recovery semantics.

Log entries include UTC timestamps and phase durations. `Production verified`
appears after the server checks, before local CLI installation; a CLI failure
still cannot roll back a healthy production deployment.

The Dockerfile keeps changing revision/checksum ARGs after Chromium installation,
so a new source revision can reuse that expensive layer. This Dockerfile change
requires one new full build for the old dist-only path; use the already measured
winpc SSH route for that transitional upload. `auto` keeps its previous full-first
behavior; explicitly select `dist-only` when using a compatible retained base.

The script assumes the remote server already has `/opt/agency-hub/.env.production` populated.

The development and local-test `postgres` services deliberately have no restart
policy. Start the development DB with `pnpm dev:db` (or as part of `pnpm dev`)
and stop local stacks when they are not needed so Docker Desktop can enter
Resource Saver. Container logs are bounded everywhere with Docker's rotating
`local` driver: local Compose keeps `10m` × 3 files per container, production
Compose keeps `20m` × 5.

## Backups

Recurring off-server backups, restore drills and backup-provider monitoring are intentionally outside the owner-approved product scope. Loss of the VPS can mean loss of the stored history; that risk was explicitly accepted. Reopening a backup program requires a new owner decision and is not an implicit implementation blocker.

## Monitoring

- API/process health: `GET /api/v1/health`
- Public sync health: `GET /api/v1/health/sync`
- Dashboard login: `GET /login`

Examples:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl -i -H "x-monitoring-token: $HEALTH_SYNC_MONITORING_TOKEN" \
  http://127.0.0.1:3000/api/v1/health/sync
```

`/api/v1/health/sync` includes per-page state, failed/stalled stream counts, sync freshness ages, and issue codes that are suitable for external uptime or alerting systems.

## Troubleshooting

### API or worker keeps restarting

Check container logs:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=200 api
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=200 worker
```

Common causes are an invalid `DATABASE_URL`, a bad `APP_ENCRYPTION_KEY`, or missing page credentials.

### `/api/v1/health` is not healthy

- Confirm Postgres is up:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
```

- Confirm the app can connect to the DSN in `.env.production`.
- Confirm the `postgres` service credentials match the `DATABASE_URL`.
- If you deployed with `scripts/deploy-production.sh`, inspect the `docker compose ps` output and recent service logs that the script prints automatically after a verification failure.

### `/api/v1/health/sync` returns `503`

That means the app is running but one or more pages are stale or have failed/stalled streams. Inspect:

```bash
curl -s -H "x-monitoring-token: $HEALTH_SYNC_MONITORING_TOKEN" \
  http://127.0.0.1:3000/api/v1/health/sync
docker compose --env-file .env.production -f docker-compose.production.yml exec api node apps/runtime/dist/cli.js sync status
```

### Dashboard route shows a 404 or blank page

- Confirm `apps/dashboard/dist` exists in the image by rebuilding the stack with `--build`.
- Confirm you are opening the API origin itself, for example `http://SERVER_IP:3000/login`.
- Do not put the dashboard behind a separate origin for this release.

## Configuration

Use `.env.production.example` as the reviewed production baseline. The runtime
schema and `packages/shared/src/config-registry.ts` remain authoritative for the
complete variable set and defaults; do not assume an older copied template is
complete. Destructive retention settings must match the registry before every
deploy.

For local development:

- `.env.example` is for running services directly on the host
- `.env.docker.example` is for local Docker-based development
- `docker-compose.yml` remains the dev-only compose stack and is unchanged by the production release path

## Local Development

The production work did not replace the existing dev flow.

```bash
pnpm install
pnpm dev
```

`pnpm dev` creates a local `.env` from `.env.example` if needed, generates a local `APP_ENCRYPTION_KEY`, starts the Docker Postgres service, waits for it, runs migrations, then starts the API, worker, and dashboard in one terminal. Use `Ctrl+C` to stop the local Node/Vite processes.

For client development (chat-extension, desktop), `pnpm dev:seed-client` fills that local database with a keyless OnlyFans setup (users, pages, fans, chats, money) and `pnpm dev:fake-ai` stands in for the AI provider; see `docs/runbooks/client-dev-hub.md`.

### CI integration shards

CI splits `pnpm test:sync-critical:db` with `--shard=k/N`. The root Vitest
config packs the files by measured duration from `tests/ci/shard-weights.json`
instead of by count, and starts shard 1 with the time of the
`pnpm test:sync-critical:api` step it also runs. A test file without a weight
takes the median and still runs. Each shard logs its plan
(`Weighted shard k/N: … predicted`). When shard durations drift apart,
regenerate the weights from a few recent green full runs on the PC pool and
commit the file:

```bash
node scripts/ci-shard-weights.mjs <run-id> <run-id> <run-id> --write
```
