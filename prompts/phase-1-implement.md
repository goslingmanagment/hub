# Phase 1: Fansly Connect — Implementation

## Read these files first
1. `docs/prd.md` — product requirements (focus on sections 1-4: Models, Revenue, Subscribers, Fans)
2. `docs/decisions.md` — all technical decisions (stack, patterns, conventions)
3. `docs/roadmap.md` — Phase 1 features and milestone
4. `reference/fansly_api_spec.md` — Fansly API specification
5. `reference/openapi.yaml` — Fansly OpenAPI spec
6. `reference/responses/` — real Fansly API response fixtures (study these to understand actual data shapes)

## What you are building

Phase 1 from `docs/roadmap.md`. A CLI-first data pipeline that syncs Fansly data into PostgreSQL.

**No API server, no dashboard, no web UI.** Just:
- Database schema (Drizzle ORM + migrations)
- Fansly platform adapter (auth, pagination, rate limiting, proxy, error handling)
- Sync jobs via pg-boss (transactions hourly, followers every 12h)
- CLI for manual operations and verification
- Docker Compose with PostgreSQL

## Milestone

```
$ pnpm cli sync --account lora
✓ Synced 142 transactions
✓ Synced 3,241 followers (delta: +12)
✓ Built daily rollups

$ pnpm cli revenue --page lora-main --period 7d
Page: lora-main
7d net revenue: $1,234.50
  Subscriptions: $890.00
  Tips: $234.50
  Messages: $110.00
```

Revenue numbers must match what Fansly shows on the platform.

## Key constraints

- Money stored as BIGINT mills (Fansly native). Use conversion helpers at edges.
- Fan identity: `(platform, platform_user_id)`. Schema must support future OnlyFans adapter writing to the same tables.
- Sync must be idempotent — safe to re-run without duplicates.
- Platform tokens encrypted at rest.
- Raw payloads stored as JSONB for debugging (180 day retention).
- Adapter must handle: pagination, ~5s rate limiting between requests, proxy routing, auth failures, partial sync failures.

## Rules

1. Read the Fansly API fixtures in `reference/responses/` before designing the schema — understand actual data shapes.
2. Do not build anything outside Phase 1 scope (no API server, no React, no Telegram).
3. Write tests for: money calculations, sync idempotency, transaction type mapping.
4. All technical decisions are in `docs/decisions.md` — follow them, don't reinvent.
