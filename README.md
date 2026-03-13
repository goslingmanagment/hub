# Fansly Connect

CLI-first page-to-PostgreSQL sync pipeline for the current Fansly + OnlyFans milestone.

This repo syncs Fansly page metadata, transactions, subscribers, and followers, plus OnlyFans revenue data via OnlyMonster, into PostgreSQL, then rebuilds daily rollups for reporting. It does not include a dashboard UI.

## What's Included

- Drizzle ORM schema and SQL migrations for the current storage model
- Fansly adapter with auth headers, pagination, retries, proxy support, and request pacing
- OnlyFans adapter backed by OnlyMonster for page lookup, transactions, and chargebacks
- `pg-boss` worker for scheduled sync jobs
- CLI for setup, sync, and verification workflows
- Docker Compose for local PostgreSQL 16

## Workspace Layout

```text
apps/runtime     CLI and worker entrypoints
packages/db      Drizzle schema, migrations, repositories
packages/fansly  Fansly adapter and response mapping
packages/onlyfans OnlyMonster-backed OnlyFans adapter and response mapping
packages/shared  config, logging, money, crypto, time helpers
docs/            PRD, decisions, roadmap
reference/       Fansly OpenAPI spec and real response fixtures
```

## Root Scripts

| Script | Purpose |
| --- | --- |
| `pnpm cli` | Run manual setup, verification, and reporting commands. |
| `pnpm worker` | Start the `pg-boss` scheduler and background sync jobs. |
| `pnpm db:generate` | Generate Drizzle migration files from the schema. |
| `pnpm db:migrate` | Apply migrations to the configured database. |
| `pnpm test` | Run the Vitest suite. |
| `pnpm dev:db` | Start the local PostgreSQL container from `docker-compose.yml`. |

## Prerequisites

- Node.js
- `pnpm`
- Docker for the bundled local PostgreSQL setup, or an existing PostgreSQL instance
- A valid Fansly session bundle for each Fansly page you want to sync
- A valid OnlyMonster token for each OnlyFans page you want to sync
- A 32-byte base64 encryption key for credentials stored at rest

## Quickstart

1. Install dependencies:

```bash
pnpm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Generate an encryption key and set `APP_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

4. Start PostgreSQL:

```bash
pnpm dev:db
```

5. Apply migrations:

```bash
pnpm db:migrate
```

Migrations are not applied automatically on startup. If you point the API or worker at a new or reused local Postgres volume, run `pnpm db:migrate` against that exact `DATABASE_URL` before starting runtime processes.

6. Add a model:

```bash
pnpm cli model add --slug lora --name "Lora"
```

7. Create a Fansly session file. The loader accepts either camelCase or header-style keys. Only `authorization` is required; the other Fansly headers are optional when available:

```json
{
  "authorization": "YOUR_AUTH_TOKEN"
}
```

8. Add a page:

```bash
pnpm cli page add fansly \
  --model lora \
  --label lora-main \
  --session-file ./secrets/lora-main.session.json
```

For OnlyFans via OnlyMonster, use a token file:

```json
{
  "token": "YOUR_ONLYMONSTER_TOKEN"
}
```

```bash
pnpm cli page add onlyfans \
  --model lora \
  --label lora-of \
  --username lora_onlyfans \
  --token-file ./secrets/lora-of.token.json
```

9. Verify the stored session:

```bash
pnpm cli page verify --page lora-main
```

10. Run a full sync:

```bash
pnpm cli sync --page lora-main
```

Example output:

```text
✓ Synced 142 transactions
✓ Synced 3,241 followers (delta: +12)
✓ Built daily rollups
```

11. Inspect 7-day revenue:

```bash
pnpm cli revenue --page lora-main --period 7d
```

Example output:

```text
Page: lora-main
7d net revenue: $1,234.50
  Subscriptions: $890.00
  Tips: $234.50
  Messages: $110.00
```

## Configuration

Configuration is loaded from environment variables and validated at startup.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string used by the CLI and worker. |
| `APP_ENCRYPTION_KEY` | Yes | Base64-encoded key that must decode to exactly 32 bytes. Used for Fansly sessions and proxy credentials. |
| `APP_ENCRYPTION_KEY_VERSION` | No | Integer version stored with encrypted records. Defaults to `1`. |
| `LOG_LEVEL` | No | Logger level. Defaults to `info`. |
| `FANSLY_BASE_URL` | No | Fansly API base URL. Defaults to `https://apiv3.fansly.com/api/v1`. |
| `ONLYMONSTER_BASE_URL` | No | OnlyMonster API base URL. Defaults to `https://omapi.onlymonster.ai`. |
| `FANSLY_GLOBAL_DELAY_MS` | No | Minimum delay between any two Fansly API requests to the configured host. Defaults to `2500`. |
| `FANSLY_ACCOUNT_LOOKUP_DELAY_MS` | No | Deprecated fallback alias for `FANSLY_GLOBAL_DELAY_MS` when the new variable is unset. |
| `FOLLOWER_PAGE_DELAY_MS` | No | Delay between follower pages. Defaults to `5000`. |
| `TRANSACTION_LOOKBACK_DAYS` | No | Backfill window applied to transaction checkpoint resyncs. Defaults to `7`. |
| `TRANSACTION_RESCAN_CAP_DAYS` | No | Maximum age of pending-aware transaction rescans before the start cursor is clamped. Defaults to `30`. |

## CLI Reference

### `model add`

Create a local model record that pages attach to.

```bash
pnpm cli model add --slug lora --name "Lora"
```

### `model list`

List configured models with their page counts.

```bash
pnpm cli model list
```

### `model revenue`

Show combined net revenue for all pages attached to one model.

```bash
pnpm cli model revenue --slug lora --period 7d
```

### `page add fansly`

Register a Fansly page only after a live Fansly auth check succeeds, then encrypt its session bundle and optionally store proxy settings.

```bash
pnpm cli page add fansly \
  --model lora \
  --label lora-main \
  --session-file ./secrets/lora-main.session.json \
  --proxy-url http://proxy.example:8080 \
  --proxy-username proxy-user \
  --proxy-password proxy-pass
```

Supported flags:

- `--model <slug>`
- `--label <label>`
- `--session-file <file>`
- `--proxy-url <url>` (`http://`, `https://`, and `socks5://` supported)
- `--proxy-username <username>`
- `--proxy-password <password>`

### `page add onlyfans`

Register an OnlyFans page by resolving the page username through OnlyMonster, then encrypt the token and store the matched account metadata.

```bash
pnpm cli page add onlyfans \
  --model lora \
  --label lora-of \
  --username lora_onlyfans \
  --token-file ./secrets/lora-of.token.json
```

Supported flags:

- `--model <slug>`
- `--label <label>`
- `--username <username>`
- `--token-file <file>`
- `--proxy-url <url>` (`http://`, `https://`, and `socks5://` supported)
- `--proxy-username <username>`
- `--proxy-password <password>`

### `page verify`

Validate the stored Fansly session or OnlyMonster account access and refresh the page metadata snapshot.

```bash
pnpm cli page verify --page lora-main
```

### `page list`

List tracked pages with current snapshot counts, last sync timestamps, and masked proxy state.

```bash
pnpm cli page list
```

### `page set-proxy`

Verify the stored page credentials through a new proxy and persist the proxy only if verification succeeds.

```bash
pnpm cli page set-proxy \
  --page lora-main \
  --proxy-url socks5://proxy-user:proxy-pass@127.0.0.1:1080
```

### `page remove-proxy`

Remove the stored proxy assignment for an existing page.

```bash
pnpm cli page remove-proxy --page lora-main
```

### `sync`

Run sync jobs manually. For Fansly, `all` runs the same light and follower sync services used by the worker. For OnlyFans, `all` runs revenue sync only and skips followers.

```bash
pnpm cli sync --page lora-main --scope all
```

Other useful scopes:

```bash
pnpm cli sync --page lora-main --scope light
pnpm cli sync --page lora-main --scope followers
```

OnlyFans limitations:

- `--scope followers` is unsupported and returns an error
- `--scope all` runs the light revenue sync and prints a follower-sync skip message

### `status`

List recent sync runs across pages, optionally filtered to a single page.

```bash
pnpm cli status --limit 20
pnpm cli status --page lora-main --limit 10
```

### `revenue`

Show page-scoped net revenue by canonical transaction bucket for a reporting period.

```bash
pnpm cli revenue --page lora-main --period 7d
```

Supported periods:

- `today`
- `7d`
- `30d`
- `all`
- `custom` with `--from YYYY-MM-DD --to YYYY-MM-DD`

Revenue periods are resolved on UTC business dates.

### `followers`

List currently tracked active followers for a page, newest first.

```bash
pnpm cli followers --page lora-main
```

### `subscribers`

List currently tracked subscribers for a page.

```bash
pnpm cli subscribers --page lora-main
```

### `fan-spend`

Show total creator net from a fan on a page using a platform user id or username.

```bash
pnpm cli fan-spend --page lora-main --fan somefan123
```

### `fans`

Rank fans on a page by creator net.

```bash
pnpm cli fans --page lora-main --limit 20
```

## Worker Behavior

Start the background scheduler with:

```bash
pnpm worker
```

The worker schedules jobs for Fansly pages that already exist in the database when the worker starts:

- hourly light syncs for page metadata, transactions, subscribers, and rollup rebuilds
- follower syncs every 12 hours with the configured inter-page delay
- daily raw payload cleanup

If you add a new page while the worker is already running, restart the worker so that page gets scheduled.

The API, worker, and CLI now fail fast when the runtime database is missing the latest migration or when `sync_runs.stats` does not match the expected `jsonb NOT NULL DEFAULT '{}'` shape. Fix the drift with `pnpm db:migrate` against the same `DATABASE_URL` the process uses.

OnlyFans scheduling is intentionally deferred in this milestone. Use `pnpm cli sync --page <label>` manually for OF pages.

## Data Notes

- Money is stored as `BIGINT` mills. Conversion to formatted USD happens at the CLI edge.
- OnlyMonster amounts are treated as dollars and converted to mills at ingest.
- Fan identity is canonicalized as `(platform, platform_user_id)` to support future multi-platform ingestion.
- Sync jobs are idempotent and safe to re-run.
- Fansly session bundles, OnlyMonster tokens, and proxy credentials are encrypted at rest with application-layer AES-256-GCM.
- Raw debugging payloads are stored in JSONB and cleaned up after their 180-day retention window.
- Fansly story and bundle sale types (`32001`, `32101`) map to `post_purchase`; the bundle-oriented `2016` and `2116` types remain on `message_purchase` until they are reclassified with raw payload evidence.
- OnlyFans pages do not have subscriber/follower list sync in this milestone because OnlyMonster does not expose those endpoints.

## Testing And Verification

Typecheck:

```bash
pnpm exec tsc --noEmit
```

Run tests:

```bash
pnpm test
```

Integration coverage uses Testcontainers. If no working container runtime is available, those tests will be skipped instead of failing the whole suite.

## Current Scope

- Fansly sync plus the OnlyFans revenue milestone via OnlyMonster
- OnlyFans onboarding, manual sync, and model/page revenue reporting
- Fansly-only worker scheduling, follower sync, and subscriber sync
- Revenue rollups are derived from canonical transactions stored in PostgreSQL, not from direct platform exports
- Dashboard UI still out of scope

## Additional Docs

- [Product requirements](docs/prd.md)
- [Technical decisions](docs/decisions.md)
- [Roadmap](docs/roadmap.md)
- [Fansly API spec](reference/fansly_api_spec.md)
- [OnlyMonster notes](reference/onlymonster_api_spec.md)
- [OpenAPI reference](reference/openapi.yaml)
