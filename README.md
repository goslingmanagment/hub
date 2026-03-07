# Fansly Connect

CLI-first Fansly-to-PostgreSQL sync pipeline for Phase 1.

This repo syncs Fansly page metadata, transactions, subscribers, and followers into PostgreSQL, then rebuilds daily rollups for reporting. It does not include an API server, dashboard, or web UI.

## What's Included

- Drizzle ORM schema and SQL migrations for Phase 1 storage
- Fansly adapter with auth headers, pagination, retries, proxy support, and request pacing
- `pg-boss` worker for scheduled sync jobs
- CLI for setup, sync, and verification workflows
- Docker Compose for local PostgreSQL 16

## Workspace Layout

```text
apps/runtime     CLI and worker entrypoints
packages/db      Drizzle schema, migrations, repositories
packages/fansly  Fansly adapter and response mapping
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
- A valid Fansly session bundle for each page you want to sync
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

9. Verify the stored session:

```bash
pnpm cli page verify --page lora-main
```

10. Run a full sync:

```bash
pnpm cli sync --account lora-main
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
| `FOLLOWER_PAGE_DELAY_MS` | No | Delay between follower pages. Defaults to `5000`. |
| `TRANSACTION_LOOKBACK_DAYS` | No | Backfill window applied to transaction checkpoint resyncs. Defaults to `7`. |

## CLI Reference

### `model add`

Create a local model record that pages attach to.

```bash
pnpm cli model add --slug lora --name "Lora"
```

### `page add fansly`

Register a Fansly page, encrypt its session bundle, and optionally store proxy settings.

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
- `--proxy-url <url>`
- `--proxy-username <username>`
- `--proxy-password <password>`

### `page verify`

Validate the stored session against Fansly and refresh the page metadata snapshot.

```bash
pnpm cli page verify --page lora-main
```

### `sync`

Run sync jobs manually. `all` runs the same light and follower sync services used by the worker.

```bash
pnpm cli sync --account lora-main --scope all
```

Other useful scopes:

```bash
pnpm cli sync --account lora-main --scope light
pnpm cli sync --account lora-main --scope followers
```

### `revenue`

Show net revenue by canonical transaction bucket for a reporting period.

```bash
pnpm cli revenue --page lora-main --period 7d
```

Supported periods:

- `today`
- `7d`
- `30d`
- `all`
- `custom` with `--from YYYY-MM-DD --to YYYY-MM-DD`

Revenue periods are resolved in the `Europe/Moscow` business timezone.

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

Show total spend for a fan on a page using a platform user id or username.

```bash
pnpm cli fan-spend --page lora-main --fan somefan123
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

## Data Notes

- Money is stored as `BIGINT` mills. Conversion to formatted USD happens at the CLI edge.
- Fan identity is canonicalized as `(platform, platform_user_id)` to support future multi-platform ingestion.
- Sync jobs are idempotent and safe to re-run.
- Fansly session bundles and proxy credentials are encrypted at rest with application-layer AES-256-GCM.
- Raw debugging payloads are stored in JSONB and cleaned up after their 180-day retention window.
- The canonical transaction enum includes `post_purchase`, but the Fansly adapter does not populate it in Phase 1. Fansly media sales map to `message_purchase`.

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

- Phase 1 only
- Fansly adapter only
- Revenue rollups are derived from canonical transactions stored in PostgreSQL, not from direct platform exports
- No API server
- No dashboard or web UI

## Additional Docs

- [Product requirements](docs/prd.md)
- [Technical decisions](docs/decisions.md)
- [Roadmap](docs/roadmap.md)
- [Fansly API spec](reference/fansly_api_spec.md)
- [OpenAPI reference](reference/openapi.yaml)
