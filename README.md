# Agency Hub

Agency Hub is a single-origin dashboard + API for syncing Fansly and OnlyFans page data into PostgreSQL, running background sync workers, and operating the system from one Docker Compose stack.

For v1.0 production:
- the dashboard and API are served from the same origin; production internet exposure should be behind TLS
- the production container runs compiled Node.js output, not `tsx`
- migrations run automatically on API and worker startup under a Postgres advisory lock
- crashed services restart automatically through Docker restart policies
- public process/database health is available at `/api/v1/health`
- detailed sync health at `/api/v1/health/sync` requires an owner or dashboard session, or a configured `HEALTH_SYNC_MONITORING_TOKEN` sent as `x-monitoring-token`
- Swagger/OpenAPI docs at `/documentation` and `/api/v1/openapi.json` require an owner dashboard session

Backups are intentionally deferred in this release hardening pass. Do not assume built-in backup or restore scripts exist yet.

## Production Prerequisites

- Linux server with Docker Engine and Docker Compose plugin
- Git
- A reachable public IP or hostname
- TLS termination through a reverse proxy or load balancer for public dashboard access
- One 32-byte base64 encryption key for stored credentials
- Valid Fansly sessions and/or OnlyMonster tokens for the pages you will onboard

## Production Files

- `.env.production.example`: canonical production environment template
- `docker-compose.production.yml`: production stack with `postgres`, `api`, and `worker`
- `scripts/deploy-production.sh`: local build + remote ship + remote verify helper

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

The default production compose file expects the bundled Postgres container and binds the app to `127.0.0.1:3000`. Put a TLS reverse proxy on the same host in front of that loopback port. Compose reads interpolation values from `.env.production`, while only the API and worker receive the full app environment; Postgres receives only `POSTGRES_*`.

5. Build and start the stack:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

6. Wait for the API to come up and confirm health:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

`/api/v1/health` should return HTTP `200`. If external monitoring needs detailed per-page sync state, set `HEALTH_SYNC_MONITORING_TOKEN` in the runtime environment and call `/api/v1/health/sync` with that value in the `x-monitoring-token` header. That endpoint may return HTTP `200` or `503`, because it reports real per-page sync state rather than simple process liveness.

7. Create the first owner account. Pass the password through an environment variable or a file so it does not appear in shell history:

```bash
export INITIAL_OWNER_PASSWORD='change-me-now'
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js user add \
  --username owner \
  --role owner \
  --password-env INITIAL_OWNER_PASSWORD
```

8. Open the dashboard from the same origin as the API:

```text
https://YOUR_DOMAIN/login
```

Sign in with the owner account you just created. The dashboard onboarding flow can add models and pages from the browser.

## First Run Notes

- The API and worker both start through `apps/runtime/dist/startup.js`, which runs migrations before handing off to the role-specific process.
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

OnlyFans via OnlyMonster:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml exec api \
  node apps/runtime/dist/cli.js page add onlyfans \
  --model lora \
  --label lora-of \
  --username lora_onlyfans \
  --token-file /run/secrets/lora-of.token.json
```

The token file must already exist inside the container if you use the CLI this way.

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

When the server already has the repo checked out:

```bash
git pull
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

This is the intended update path. It rebuilds the production image, recreates the containers, and lets startup handle migrations automatically. No separate migration command is required.

## Remote Deployment From Your Workstation

If you want to build locally and push the image to a remote host over SSH:

```bash
scripts/deploy-production.sh user@server --verify-url https://YOUR_DOMAIN
```

On Apple Silicon workstations, this deploy path still targets `linux/amd64` for amd64 servers. The Docker build compiles the JS/TS artifacts in a native build stage while installing runtime dependencies for the target platform, which avoids running `esbuild` under amd64 emulation during the production build.

By default the script uses `--mode auto`:

- first it tries a full Docker image build
- the Node base image is read through a stable local cache tag, `agency_hub_core/node:22-bookworm-slim`, to avoid re-resolving Docker Hub metadata on every deploy
- every built runtime image is labeled with the dependency checksum and source revision
- if the full build fails before the remote release is modified, the script can fall back to a dist-only overlay build from the currently running production image
- dist-only fallback is allowed only when the current production image carries the same dependency checksum label

For the first deploy from an older unlabeled production image, use the override only after confirming that `Dockerfile`, package manifests, and `pnpm-lock.yaml` are compatible with the running image:

```bash
scripts/deploy-production.sh --mode dist-only --allow-unlabeled-dist-base \
  user@server --verify-url https://YOUR_DOMAIN
```

Use `--mode full` when runtime dependencies, Dockerfile structure, Playwright/system dependencies, or package installation behavior changes.

What the script does:

- builds `agency_hub_core/runtime:production-candidate` locally, or as a verified dist-only overlay on the remote host
- streams a locally built image to the remote host with `docker load`
- syncs release files into `/opt/agency-hub` by default
- runs `docker compose --env-file .env.production -f docker-compose.production.yml up -d --remove-orphans --force-recreate --no-build`
- verifies `/api/v1/health`, `/api/v1/health/sync`, and same-origin dashboard delivery at `/login`
- if verification fails after the stack is recreated, rolls back to the previous remote image when one was captured and `schema_migrations` did not change during the failed deploy, then prints `docker compose ps` plus recent `postgres`, `api`, and `worker` logs automatically

The script assumes the remote server already has `/opt/agency-hub/.env.production` populated.

## Backups

Built-in backup automation is not shipped in this release hardening pass. Use your existing VPS or Postgres backup tooling until Agency Hub backup/restore scripts are implemented.

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

Use `.env.production.example` for production. It documents every supported runtime variable, the expected format, and the default behavior.

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
