# Phase 1: Fansly Connect — Implementation

You are building Phase 1 of Agency Hub from scratch. This is a greenfield TypeScript monorepo.

## Context files (read all before writing any code)

1. `docs/prd.md` — product requirements (focus on sections 1-4: Models, Revenue, Subscribers, Fans)
2. `docs/decisions.md` — all technical decisions (stack, patterns, conventions)
3. `docs/roadmap.md` — Phase 1 features and milestone
4. `reference/fansly_api_spec.md` — Fansly API specification
5. `reference/openapi.yaml` — Fansly OpenAPI spec
6. `reference/responses/` — real Fansly API response fixtures (use these to understand data shapes)

## What you are building

A CLI-first data pipeline that syncs Fansly data into PostgreSQL. No API server, no dashboard, no web UI. Just:
- Database schema
- Fansly platform adapter
- Sync jobs (transactions hourly, followers every 12h)
- CLI for manual operations and verification

## Phase 1 features (from roadmap)

- Add models and attach Fansly pages to them
- Per-page proxy configuration
- Hourly transaction sync: tips, subscriptions, message purchases, post purchases, stream tips, chargebacks, refunds
- Unified transaction type taxonomy (8-bucket enum: subscription, tip, message_purchase, post_purchase, stream_tip, chargeback, refund, other)
- Revenue stored as net (after platform commission); chargebacks separate; pending with status
- Sync active subscribers: usernames, expiry dates, auto-renew status
- Follower sync every 12h: full parse first run, then delta. Rate-limited (~5s pauses, 5-15k per page)
- Fan records from transactions, subscriptions, follows
- Per-page fan spending computed from synced transactions
- Fan identity: (platform, platform_user_id) — explicit core schema rule
- Fans are platform-scoped — never linked cross-platform
- Daily rollups for revenue, subscriber counts, follower counts
- Timestamps: UTC in DB
- Raw payload retention: mapping-critical entities + failed payloads as JSONB, 180 day retention
- Encrypted-at-rest credential storage (platform tokens, proxy credentials)
- Idempotent checkpointed sync (upsert raw events, rebuild projections, safe to re-run)
- CLI: add model/page, trigger sync, view revenue, verify subscribers, inspect fan spending

## Milestone (how to verify Phase 1 is done)

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

$ pnpm cli subscribers --page lora-main
Active: 847
Expiring (7d): 23
New (24h): 8
```

Revenue numbers must match what Fansly shows on the platform.

## Technical decisions (key ones for Phase 1)

These are decided. Do not change them.

- **Runtime:** TypeScript + Node.js 22 LTS
- **Package manager:** pnpm workspaces
- **Database:** PostgreSQL 16
- **ORM:** Drizzle ORM + handwritten SQL for reporting
- **Money:** BIGINT mills (1 mill = $0.001). Fansly native. Column type: `bigint`. Helpers: `centsToMills()`, `millsToDollars()`, `formatMoney()`
- **Scheduler:** pg-boss (Postgres-based, no Redis)
- **Worker:** Separate process role (same image, different CMD: `node dist/worker.js`). For Phase 1, worker and CLI can be the same process.
- **Sync:** Idempotent, checkpointed. Upsert raw events first, then rebuild projections. Safe to re-run.
- **Raw payloads:** Store as JSONB with `mapper_version` and sync run ID. Retain 180 days.
- **Secret storage:** Encrypt platform tokens and proxy credentials at rest (AES-256-GCM or similar)
- **Fan identity:** `(platform, platform_user_id)` composite. No cross-platform linking.
- **Transaction taxonomy:** `subscription | tip | message_purchase | post_purchase | stream_tip | chargeback | refund | other`
- **Logging:** Pino structured JSON
- **Testing:** Vitest + Testcontainers for integration tests
- **Env config:** Zod-validated at startup
- **Docker:** Docker Compose with PostgreSQL
- **Linter:** ESLint + Prettier
- **Migrations:** Forward-only Drizzle SQL, committed to git

## Rules

1. Read the Fansly API spec and response fixtures carefully before designing the schema. Understand the actual data shapes.
2. Do not build anything not listed above. No API server, no React, no dashboard.
3. Write tests for money calculations, sync idempotency, and transaction type mapping.
4. The adapter must handle: pagination, rate limiting (~5s between requests), proxy routing, auth token refresh/failure detection, partial failures.
5. Schema must be designed with Phase 2+ in mind — other platform adapters (OnlyFans) will write to the same tables using the same `platform` field.
6. Keep the project structure clean but don't over-package. Let real dependencies guide the split.
