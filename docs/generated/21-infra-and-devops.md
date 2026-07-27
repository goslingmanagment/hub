> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Infrastructure and Delivery

The repository builds on Node 22 and pnpm workspaces. Its checked-in delivery
surface consists of one multi-stage `Dockerfile`, three Compose files, a local
development bootstrap, a production deployment script, and two GitHub Actions
workflows.

## Production image

The root `Dockerfile` has dependency, build, and runtime stages:

- `prod-deps` installs the production dependency closure for the runtime;
- `build` installs the full workspace and runs `pnpm build:production`;
- `runtime` copies production dependencies, the dashboard build, runtime
  bundle, database bundle, and migrations;
- Playwright Chromium and its operating-system dependencies are installed in
  the runtime image;
- image labels retain the supplied dependency checksum and source revision.

The image's default command starts the worker role. Compose overrides it for
the API and scheduler.

`scripts/build-production.mjs` uses esbuild for the runtime and server-side
packages. It emits separate browser and Node bundles for the shared package and
builds runtime entry points for API, CLI, startup, and worker. The root
`build:production` script runs the typecheck ratchet, that esbuild script, and
the dashboard Vite build.

## Compose topologies

`docker-compose.production.yml` defines four services:

| Service | Process and health boundary |
|---|---|
| `postgres` | Postgres 16 with a persistent volume and `pg_isready` healthcheck |
| `api` | `startup.js api`, bound to host loopback port 3000, checked through `/api/v1/health` |
| `scheduler` | leader-elected scheduler role with a DB-backed heartbeat file healthcheck |
| `worker` | job worker with a heartbeat file plus direct database probe |

All application containers set `TZ=UTC`. The scheduler and worker start after
Postgres is healthy; the worker also waits for the API healthcheck.

The root `docker-compose.yml` is the local stack, including Postgres, a
migrator, API, and worker. `docker-compose.test.yml` supplies the corresponding
test-oriented environment and local credential mounts.

## Production deployment

`scripts/deploy-production.sh` is a non-interactive SSH/Docker deployment. It
defaults to `/opt/agency-hub`, an amd64 build, and full-image mode; `full`,
`dist-only`, and `auto` candidate-build modes are accepted.

The script serializes deployments with ownership-marked local and remote lock
directories. It validates migration file names, computes a dependency checksum
over the Dockerfile, lockfile, workspace file, and package manifests, and labels
candidate images with that checksum and a source revision.

Before promotion it captures the running image, release files, and
`schema_migrations` state for rollback decisions. Full mode builds locally and
loads the image on the remote. Dist-only mode first verifies that the running
image has the same dependency checksum, builds current artifacts locally, and
layers the configured dist and migration paths on that image.

The candidate is interrogated for its public capability manifest. The
`desktop-lifecycle-v2` transition has additional rules in the deploy script:
first enablement requires exact Desktop and Extension evidence, an approved
manifest digest, and a production token/machine inventory check; removal from
an already capable release is rejected. The inventory is checked again before
the one-way promotion point.

The script runs the concurrent harvest lookup migration through
`0096_observations_harvest_lookup_concurrently.sql` with the candidate image
before recreating the stack. Automatic rollback is conditional on the captured
release state and schema delta. Migrations 0013 through 0018 are the explicit
rollback-compatible data/repair allowlist; other new migrations disable the
automatic old-image rollback path. First enablement of
`desktop-lifecycle-v2` also disables automatic capability rollback.

After Compose recreation, verification covers:

- API health and the expected public capability;
- worker and scheduler container health;
- source-revision and dependency-checksum image labels;
- protected sync health when a monitoring token exists;
- same-origin dashboard HTML at `/login`.

A failure after stack recreation enters the guarded rollback path and emits
remote diagnostics.

## Local development

`scripts/dev-local.sh` creates `.env` from the example when absent, replaces
the placeholder encryption key, selects an available API port, starts the local
Postgres service, waits for readiness, and runs migrations. It then launches
the API, worker, and Vite dashboard and terminates the remaining local
processes when one exits or the script receives a signal.

## Continuous integration

`.github/workflows/ci.yml` runs for pull requests, pushes to `main`, and manual
dispatch. Superseded pull-request runs are cancelled; `main` runs always finish.
Three jobs install pinned pnpm/Node 22 dependencies and split the work:

1. `Static checks` — the typecheck ratchet and ESLint; contract generation
   followed by a clean-diff assertion for OpenAPI, contract hash, SDK, and
   authorization policy artifacts; the production build and production Docker
   image build; the Chromium runtime smoke; unit tests.
2. `Integration N/3` — a three-way matrix over the sync-critical prerequisite
   suite, sharded by resolved file (`test:sync-critical:db --shard`), with the
   single-file API selection attached to shard 1. Each shard is its own runner,
   so files stay serial within a shard and every test keeps its own throwaway
   Postgres container.
3. `Quality Gate` — the aggregator. Branch protection requires this exact check
   name, and it fails unless both jobs above succeeded.

Coverage is unchanged from the single-job layout: every step still runs on every
pull request, only spread across runners.

`.github/workflows/nightly.yml` runs daily at 02:20 UTC and on manual dispatch.
Its 90-minute job runs the full Vitest suite, including Testcontainers-backed
integration coverage.

## Source ratchets and analytics

The repository carries source-count ratchets for strict TypeScript debt,
platform branches, raw fetch usage, and money-related float operations. Their
current snapshots live under `scripts/strictness-ratchet.json`,
`scripts/platform-branch-budget.json`, `scripts/raw-fetch-budget.json`, and
`scripts/money-float-budget.json`. The three explicit numeric budgets at this
commit are 50 platform branches, 13 raw fetch sites, and 9 money-float sites.

`scripts/analytics-run.mjs` rebuilds a selected SQL model, or all models, in a
transaction and reports the resulting row count. The checked-in models under
`analytics/models` are `fan_ltv.sql`, `net_revenue_daily.sql`, and
`response_sla.sql`.
