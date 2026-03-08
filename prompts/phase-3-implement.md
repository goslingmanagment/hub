# Phase 3: OnlyFans Connect — Implementation Prompt

## Goal

Add OnlyFans support via the OnlyMonster API so that Fansly and OnlyFans revenue, chargebacks, chatter metrics, and tracking links are unified in one system. When done, the CLI should show combined revenue for a model that has pages on both platforms.

## Context — Read These First

- **Roadmap (Phase 3 section):** `docs/roadmap.md`
- **Decisions log:** `docs/decisions.md` — especially #15 (BIGINT mills), #11/#12 (platform adapter boundary), #45 (transaction taxonomy), and the Phase Sequencing Change at the bottom
- **OnlyMonster API spec:** `reference/onlymonster_api_spec.md` — endpoints, fields, pagination, type mapping table (with REAL type strings from live data), and the "What OnlyMonster DOES NOT provide" section
- **OnlyMonster OpenAPI JSON:** `reference/onlymonster_openapi.json` — official OpenAPI 3.0 spec from `https://omapi.onlymonster.ai/docs/json`
- **Existing Fansly adapter:** `packages/fansly/src/adapter.ts` — reference for adapter pattern, error handling, proxy support
- **Shared types:** `packages/shared/src/types.ts` — Platform, TransactionType, TransactionState enums
- **DB schema:** `packages/db/src/schema.ts` — current tables, enums, relationships
- **Sync services:** `apps/runtime/src/services/sync/` — transaction, follower, subscriber sync patterns
- **Page onboarding:** `apps/runtime/src/services/page-onboarding.ts` — Fansly onboarding reference
- **CLI:** `apps/runtime/src/cli.ts` — existing commands structure

## What Already Exists

- `packages/onlymonster/` — empty package (just node_modules)
- `platform` enum already includes `"onlyfans"`
- `transactionType` enum already covers all needed types (subscription, tip, message_purchase, post_purchase, stream_tip, chargeback, refund, other)
- `sync_stream` enum has: light, followers, transactions, subscribers, cleanup
- Money is stored as BIGINT mills (1 mill = $0.001). OnlyMonster amounts are in **dollars** — multiply by 1000 to get mills.

## Key Constraints

1. **OnlyMonster auth:** header `x-om-auth-token`. Token stored in `.om-token` file (like Fansly session files). Base URL: `https://omapi.onlymonster.ai`
2. **OnlyMonster API quirks discovered during live testing:**
   - `GET /api/v0/accounts` returns `{"accounts": [...], "nextCursor": "..."}` (not bare array, note `nextCursor` not `cursor`)
   - `GET /api/v0/accounts/{id}` returns `{"account": {...}}` (not bare object)
   - Statistics endpoints return `{"items": [...], "cursor": "..."}` (note: `cursor` here, different from accounts)
   - Metrics use offset-based pagination (`offset` + `limit`), not cursor
   - Amounts are in **dollars** (not cents) — e.g. 4.99, 10, 30, 39
   - **Transaction type strings are capitalized/human-readable** — e.g. `"Tip from"`, `"Payment for message"`, `"Subscription"`, `"Recurring subscription"` (NOT lowercase slugs). See mapping table in `reference/onlymonster_api_spec.md`
   - Transaction status `"loading"` maps to our `"posted"`. All real transactions have `"loading"` status.
   - Chargeback status is always `"undo"`
3. **New DB tables needed:** `chargebacks`, `chatter_metrics`, `tracking_links` — design the schema yourself based on the API spec
4. **New sync_stream enum values needed:** `chargebacks`, `metrics`, `tracking_links` — add via migration
5. **No subscriber/follower sync** for OnlyFans — OnlyMonster doesn't provide these endpoints
6. **Transaction type mapping** is documented in `reference/onlymonster_api_spec.md` (bottom section)
7. **Fan records:** OnlyMonster only gives `fan.id` (platform user ID) in transactions — no usernames or display names. Create fan records from transactions with platform_user_id only.
8. **CLI commands to add:**
   - `page add onlyfans --model <slug> --label <label> --token-file <file>` (mirrors `page add fansly`)
   - `page sync` should work for OnlyFans pages (same `--label` interface)
   - `page revenue` should show combined cross-platform revenue per model
9. **Existing tests:** 41 tests in 8 files, all passing. Don't break them. Add new tests for OnlyMonster adapter and OF sync.
10. **Monorepo structure:** pnpm workspaces. New package: `packages/onlymonster/` with its own `package.json`, `tsconfig.json`, `src/`.

## Milestone

Run `page add onlyfans --model lora --label lora-of --token-file .om-token` to onboard an OF page. Run `page sync --label lora-of` to sync transactions + chargebacks + metrics + tracking links. Run `page revenue --model lora --period 30d` and see combined Fansly + OnlyFans revenue.

## Rules

- Explore the codebase yourself — understand patterns before writing code
- Follow existing conventions (error handling, logging, test structure)
- One migration file for all schema changes
- Integration tests using Testcontainers (same pattern as existing tests)
- Do NOT add subscriber/follower sync for OnlyFans — it's not available
- Commit with a clear message when done
