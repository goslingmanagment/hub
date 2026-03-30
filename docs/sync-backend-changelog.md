# Sync Backend Changelog

## Files changed

### Runtime
- `apps/runtime/src/api/server.ts`
  Added block-oriented sync API routes:
  - `GET /api/v1/sync/overview`
  - `GET /api/v1/pages/:pageLabel/sync/blocks`
  - `GET /api/v1/pages/:pageLabel/sync/blocks/messages`
  - `POST /api/v1/admin/sync/blocks/trigger`
  - `POST /api/v1/admin/sync/blocks/pause`
  - `POST /api/v1/admin/sync/blocks/resume`
  - `POST /api/v1/admin/sync/blocks/reset`
  Also kept legacy `/api/v1/sync/status` and `/api/v1/sync/requests` behavior filtered to the original 7 visible streams.

- `apps/runtime/src/bootstrap.ts`
  Updated the runtime adapter contract so the Fansly adapter exposes `getEarningsAccountsPage()`.

- `apps/runtime/src/services/page-onboarding.ts`
  Persisted Fansly `accountCreatedAt` into page metadata during onboarding.

- `apps/runtime/src/services/sync-control.ts`
  Changed Fansly sync scope resolution:
  - `light` now means only `light`
  - `data` and `all` now include `top_spenders`
  - OnlyFans scope behavior remains unchanged

- `apps/runtime/src/services/sync-monitor.ts`
  Preserved the legacy sync monitor contract by explicitly filtering monitor streams and request rows to the original dashboard-visible set.

- `apps/runtime/src/services/sync/executor-handlers.ts`
  Added the `top_spenders` executor handler, checkpoint parsing/state transitions, monthly bootstrap windowing, weekly fallback for capped months, 7-day steady-state sync, Fansly metadata fallback for `accountCreatedAt`, and DB upserts into the new top spenders table.

- `apps/runtime/src/services/sync/observability.ts`
  Added `top_spenders` to the sync observability stream union.

- `apps/runtime/src/services/sync/shared.ts`
  Updated Fansly metadata refresh to persist `accountCreatedAt`.

### Packages
- `packages/contracts/src/generate.ts`
  Updated generated config defaults to use `FANSLY_DM_MESSAGES_DELAY_MS=5000`.

- `packages/contracts/src/generated/api-types.ts`
  Regenerated API types for the new sync block endpoints.

- `packages/contracts/src/routes.ts`
  Added schemas/types for sync block overview/detail/messages/admin-control endpoints.

- `packages/db/src/index.ts`
  Exported the new top spenders repository helpers.

- `packages/db/src/repositories/crm.ts`
  Kept `PAGE_DM_MESSAGE_HISTORY_LIMIT=25` as the canonical DM history limit and added a reset helper that clears stored DM state for a true message-block reset.

- `packages/db/src/repositories/sync.ts`
  Added `top_spenders` to the control plane, changed cadences, added DM dependency gating, added sync-state config reconciliation for existing rows, and added helpers for checkpoint deletion, status changes, row resets, and manual revision requests that preserve `auth_failed`.

- `packages/db/src/schema.ts`
  Added the `top_spenders` stream enum value, changed the DM stored-message constraint from `75` to `25`, and defined the new `page_top_spenders` table.

- `packages/fansly/src/adapter.ts`
  Added `getEarningsAccountsPage()` for `/account/wallets/earnings/accounts`.

- `packages/fansly/src/types.ts`
  Added Fansly top-spenders response types.

- `packages/shared/src/config.ts`
  Changed the default `FANSLY_DM_MESSAGES_DELAY_MS` from `7500` to `5000`.

### Generated/OpenAPI
- `reference/agency-hub.openapi.json`
  Regenerated OpenAPI with the new sync block routes.

### Tests
- `tests/adapter-fansly-query.test.ts`
  Added query serialization coverage for the new earnings/accounts endpoint.

- `tests/api.integration.test.ts`
  Updated seeded cadence expectations to match the new DM/follower intervals and kept fixture adapters aligned with the backend adapter contract.

- `tests/bootstrap.test.ts`
  Updated runtime default expectations for the lower DM message delay.

- `tests/config.test.ts`
  Updated config default assertions for `FANSLY_DM_MESSAGES_DELAY_MS=5000`.

- `tests/db-write.integration.test.ts`
  Updated test runtime config overrides to use the new DM message delay default.

- `tests/helpers/runtime.ts`
  Updated test app defaults to use the new DM message delay.

- `tests/observability.test.ts`
  Updated runtime config fixtures to use the new DM message delay default.

- `tests/sync-control.test.ts`
  Updated Fansly scope expectations to include `top_spenders`.

- `tests/sync-handlers.test.ts`
  Added unit coverage for top spenders steady-state sync and capped-month weekly splitting.

- `tests/sync-rate-limiter.integration.test.ts`
  Updated seeded Fansly DM message rate-limit expectations to `5000`.

- `tests/sync-rate-limiter.test.ts`
  Updated unit expectations for the new DM message rate-limit default.

- `tests/sync-repository.test.ts`
  Added assertions for `top_spenders` priority ordering and DM dependency gating SQL.

- `tests/sync.integration.test.ts`
  Updated Fansly light/all scope expectations to reflect the new scope semantics and added the top spenders adapter method to fixtures.

- `tests/sync-blocks.test.ts`
  Added unit coverage for sync block overview/detail/manual controls without requiring Docker.

## New files

- `apps/runtime/src/services/fansly.ts`
  Centralizes Fansly metadata helpers, including persisted `accountCreatedAt`.

- `apps/runtime/src/services/sync-blocks.ts`
  New read-model/service layer for 6-block sync status aggregation plus block-level manual trigger/pause/resume/reset actions.

- `packages/db/migrations/0025_sync_prd_alignment.sql`
  Migration for:
  - `top_spenders` enum/table creation
  - DM history pruning to 25 rows per conversation
  - DM stored-count constraint update
  - DM conversation summary recomputation
  - Fansly DM message rate-limit seed update to `5000`

- `packages/db/src/repositories/top-spenders.ts`
  Repository helpers for top spender upsert/delete/count/lookup operations.

- `tests/sync-blocks.test.ts`
  Unit tests for the new block service and manual block controls.

## New API endpoints

### `GET /api/v1/sync/overview`
- Auth: same page-scoped dashboard access rules as the existing sync monitor.
- Request:
  - No body.
- Response:
  - `generatedAt: string`
  - `pages: Array<{ pageId, pageLabel, platform, modelSlug, modelName, username, displayName, blocks }>`
  - `blocks` contains 6 keys:
    - `connection`
    - `top_spenders`
    - `transactions`
    - `subscribers`
    - `followers`
    - `messages`
  - Each block returns:
    - `block`
    - `state`
    - `lastSuccessAt`
    - `progress`
    - `error`
    - `needsAttention`
    - `nextDueAt`
    - `nextRetryAt`
    - `intervals`
    - `metrics`
    - `connectionStatus`
    - `substreams`
  - OnlyFans pages return `state: "not_available"` for unsupported blocks.

### `GET /api/v1/pages/:pageLabel/sync/blocks`
- Auth: page-scoped access.
- Request:
  - Path param `pageLabel`.
- Response:
  - `generatedAt`
  - `page` with the same page metadata and 6 block objects described above.

### `GET /api/v1/pages/:pageLabel/sync/blocks/messages`
- Auth: page-scoped access.
- Request:
  - Path param `pageLabel`.
- Response:
  - `generatedAt`
  - `page` metadata
  - `block`
    - combined status for `dm_conversations` + `dm_messages`
    - `intervals` always include:
      - `{ stream: "dm_conversations", cadenceSeconds: 1800 }`
      - `{ stream: "dm_messages", cadenceSeconds: 86400 }`

### `POST /api/v1/admin/sync/blocks/trigger`
- Auth: owner-only.
- Request body:
  - `{ pageLabel: string, block: "connection" | "top_spenders" | "transactions" | "subscribers" | "followers" | "messages" }`
- Response:
  - `{ accepted: true, action: "trigger", pageLabel, block, revisions }`

### `POST /api/v1/admin/sync/blocks/pause`
- Auth: owner-only.
- Request body:
  - same as trigger
- Response:
  - `{ accepted: true, action: "pause", pageLabel, block }`

### `POST /api/v1/admin/sync/blocks/resume`
- Auth: owner-only.
- Request body:
  - same as trigger
- Response:
  - `{ accepted: true, action: "resume", pageLabel, block }`

### `POST /api/v1/admin/sync/blocks/reset`
- Auth: owner-only.
- Request body:
  - same as trigger
- Response:
  - `{ accepted: true, action: "reset", pageLabel, block, revisions }`

### Block-to-stream mapping
- `connection -> light`
- `top_spenders -> top_spenders`
- `transactions -> transactions`
- `subscribers -> subscribers`
- `followers -> followers` for trigger, and `followers + followers_reconcile` for pause/resume/reset
- `messages -> dm_conversations + dm_messages`

## DB schema changes

- Added sync stream enum value: `top_spenders`
- Added new table: `page_top_spenders`
  - Columns:
    - `platform_account_id`
    - `correlation_account_id`
    - `account_id`
    - `fan_id`
    - `gross_amount_mills`
    - `creator_net_amount_mills`
    - `source_window_started_at`
    - `source_window_ended_at`
    - `last_synced_at`
    - `created_at`
    - `updated_at`
  - Primary key:
    - `(platform_account_id, correlation_account_id)`
  - Index:
    - `(fan_id, platform_account_id)`

- Changed DM message history constraint:
  - `page_dm_conversations.stored_message_count` check from `0..75` to `0..25`

- Migration data repair:
  - prunes stored DM messages to the most recent 25 per conversation
  - recomputes `stored_message_count` and related DM conversation summary fields

- Updated seeded shared rate-limit row:
  - `fansly / dm_messages / global` min spacing `7500 -> 5000`

## Config/default changes

- `FANSLY_DM_MESSAGES_DELAY_MS`
  - default `7500 -> 5000`

- Sync stream cadences in the control plane:
  - `top_spenders`: new stream, `3600`
  - `followers`: `43200 -> 3600`
  - `dm_messages`: `7200 -> 86400`

- DM history storage policy:
  - enforced cap remains `PAGE_DM_MESSAGE_HISTORY_LIMIT = 25`
  - DB constraint now matches the code-level cap

## Behavior changes implemented

- Fansly `light` no longer implicitly triggers `transactions/subscribers/followers`.
- Fansly `data` and `all` now include `top_spenders`.
- DM streams will not run until `light`, `top_spenders`, `transactions`, `subscribers`, and `followers` have each succeeded once for the page.
- Top spenders bootstrap starts from persisted Fansly `accountCreatedAt`.
- Top spenders steady state fetches only the trailing 7 days.
- `needsAttention` is exposed as a derived read-model field when `consecutive_failures >= 3`.
- Connection block exposes simple `connectionStatus: connected | not_connected | error`.
- Legacy guardrails were preserved:
  - subscriber empty-page safety check
  - follower anomaly detection that triggers reconcile
  - `auth_failed` still blocks all streams

## Notable implementation choices

- `needsAttention` was implemented as a derived read-model field, not a new column, per the PRD assumption.
- The legacy sync monitor endpoints were intentionally left on the original 7-stream contract so the existing dashboard/frontend stays unchanged.
- Message block reset clears both checkpoints and stored DM state, because checkpoint deletion alone would not restart message history backfill.
- Top spenders reset clears both checkpoints and stored ranking rows.

## Verification status

- Ran successfully:
  - `pnpm -s typecheck`
  - `pnpm contracts:generate`
  - `pnpm -s vitest run tests/sync-control.test.ts tests/adapter-fansly-query.test.ts tests/sync-repository.test.ts tests/sync-handlers.test.ts tests/sync-blocks.test.ts tests/sync-rate-limiter.test.ts tests/config.test.ts tests/bootstrap.test.ts tests/observability.test.ts`

- Not run here:
  - Docker-backed integration suites such as `tests/api.integration.test.ts`, `tests/sync.integration.test.ts`, and other Testcontainers tests
  - Reason: no working container runtime was available in this environment
