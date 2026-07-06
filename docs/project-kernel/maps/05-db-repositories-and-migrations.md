> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 05 — DB Repositories, Client & Migrations

**Scope.** This document covers the `@agency_hub_core/db` package's read/write layer over Postgres and its migration machinery. Files read in full or in depth: `packages/db/src/client.ts`, `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/src/migrate-runner.ts`, `packages/db/src/migrations-dir.ts`, `packages/db/src/schema-guard.ts`, `packages/db/drizzle.config.ts`, `scripts/db-generate-disabled.mjs`, all 27 repository modules under `packages/db/src/repositories/` (`ai-usage.ts`, `auth.ts`, `catalog.ts`, `config-settings.ts`, `dm-analytics.ts`, `dm-message-archive.ts`, `egress.ts`, `fan-metadata.ts`, `fan-page-identity.ts`, `fan-profiles.ts`, `fans.ts`, `notifications.ts`, `ofapi.ts`, `ofapi-commands.ts`, `ofapi-sync-snapshot.ts`, `onlyfans-public-profiles.ts`, `page-dm.ts`, `page-sync.ts`, `reporting.ts`, `runtime-instances.ts`, `search.ts`, `spenders.ts`, `sync.ts`, `sync-context.ts`, `telegram-settings.ts`, `top-spenders.ts`, `transactions.ts`, `workboard.ts`, `workboard-v2.ts`), and the migration SQL catalog `packages/db/migrations/0000..0051`. Table/column shapes themselves are owned by **Territory 04 (schema.ts)**; this territory documents the functions that read and write those tables and the migration files that create them. `packages/db/src/schema.ts` (94 KB) is imported by every module here but is not re-described.

---

## 1. Client, pool, and package surface

### `client.ts` (17 lines)
The entire DB client is:
```ts
pg.types.setTypeParser(20, (value) => BigInt(value));   // OID 20 = int8/bigint → JS BigInt, process-global
export function createPool(connectionString: string) { return new Pool({ connectionString }); }
export function createDb(pool: Pool) { return drizzle(pool, { schema }); }
export type Database = Omit<ReturnType<typeof createDb>, "$client">;
```
- **Pool config is minimal**: a bare `new Pool({ connectionString })` from the `pg` package. There is **no SSL configuration, no `pg-native` binding, no pool-size / timeout tuning, and no connection-string parsing** in this file (`client.ts:8-9`). Callers pass `config.databaseUrl` straight through.
- The global `setTypeParser(20, …)` (`client.ts:6`) means **all bigint columns deserialize as JS `BigInt`** everywhere in the process (money in mills, `*_seq` counters, etc.). Repositories frequently `BigInt(...)`/`::bigint`-cast to match.
- `Database` (the drizzle instance minus `$client`) is the type every repository function takes as its first argument. A drizzle transaction handle is passed as `tx as unknown as Database` throughout so repo helpers compose inside transactions.
- **Discrepancy vs. task brief:** `getConfigOverrides` is *not* in `client.ts`; it lives in `config-settings.ts:33`. There is no SSL/native-pg handling to document here.

### `index.ts` — public exports
`index.ts` re-exports `client.ts`, `schema.ts`, `schema-guard.ts`, and 24 repository modules. Notably **NOT directly listed** in `index.ts`: `egress.ts`, `search.ts`, `page-sync.ts`. Of these, `page-sync.ts` is re-exported transitively because `sync.ts:46` does `export * from "./page-sync.ts"`; `egress.ts` and `search.ts` are internal helpers imported only by other repos (`reporting.ts`, `page-sync.ts`, `sync.ts` import `egressKeySql`; `spenders.ts` imports the `search.ts` helpers). `migrate.ts` / `migrate-runner.ts` / `migrations-dir.ts` are **not** exported from `index.ts` — apps import the migration runner by explicit path (`apps/runtime/src/startup.ts:3`).

### Who constructs the pool/db (callers)
- `apps/runtime/src/bootstrap.ts:134` — `createPool(rawConfig.databaseUrl)` → `assertRuntimeSchemaReady(pool)` → `createDb(pool)` → one `getConfigOverrides(db)` read to layer staged "boot" config over env config.
- `apps/runtime/src/startup.ts:13` — separate pool used only to run migrations at process start.

---

## 2. Migration system

Migrations are **hand-written numbered SQL files** in `packages/db/migrations/`, applied by a custom runner (no Drizzle journal).

### `migrations-dir.ts` — file discovery
- `resolveMigrationFiles()` looks in `process.cwd()/packages/db/migrations` first, then the module-relative `../migrations`, returning the first that resolves (`migrations-dir.ts:50-69`).
- Filenames must match `/^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$/` (`migrations-dir.ts:8`); any non-matching `.sql` throws. Files are sorted lexicographically (`.sort()`, `migrations-dir.ts:31`) — the 4-digit zero-padded prefix makes lexicographic order = numeric order.

### `migrate-runner.ts` — `runMigrations()`
- Acquires a **session-level Postgres advisory lock** `pg_advisory_lock(31415, 27182)` (`MIGRATION_LOCK_KEY_1/2`, `migrate-runner.ts:10-11,77`) so only one process migrates at a time; unlocked in `finally`.
- Creates `schema_migrations (id text primary key, applied_at timestamptz default now())` if absent (`migrate-runner.ts:99-104`). Each already-applied file id is a row.
- **Ordering / integrity guards:**
  - `assertUniqueMigrationPrefixes` — two files sharing a 4-digit prefix throws (`migrate-runner.ts:13-31`).
  - `assertContiguousAppliedPrefix` — the set of *applied* files must form a contiguous prefix of the sorted file list; an applied higher-numbered file with an un-applied lower-numbered file throws "Out-of-order migration detected" (`migrate-runner.ts:33-52`). (This guards against a lower-numbered migration being inserted after later ones already ran; it does **not** require numeric contiguity — see the 0005 gap below.)
- **Idempotency / atomicity:** for each un-applied file, runs `begin` → the raw SQL file → `insert into schema_migrations` → `commit`; on error `rollback` and rethrow (`migrate-runner.ts:124-139`). One migration = one transaction. Already-applied files are skipped.
- Two invocation modes: pass `{ db }` (an existing client — used at boot) or let it open its own pool from `loadConfig().databaseUrl` (`migrate-runner.ts:143-149`).

### `migrate.ts` — CLI entry
Thin wrapper: `runMigrations()` when run as main module (`pnpm db:migrate` → `node --import tsx/esm packages/db/src/migrate.ts`, `package.json:24`).

### Boot-time double-lock (cross-file behavior)
`apps/runtime/src/startup.ts:runStartupMigrations()` acquires `pg_advisory_lock(31415, 27182)` on a client **itself**, then calls `runMigrations({ databaseUrl, db: client })` which acquires the **same** lock keys again on that same session (`startup.ts:16-25`). Because Postgres advisory locks are re-entrant per session, the nested lock succeeds; only one unlock level is released inside the runner and the outer level in `startup.ts`'s `finally`. Net effect: single-writer migration at boot.

### `schema-guard.ts` — `assertRuntimeSchemaReady(pool)`
Runtime readiness check called at boot (`bootstrap.ts:136`) *before* any query. It does NOT run migrations — it fails fast with a `driftError` telling the operator to run `pnpm db:migrate`. Checks:
1. `schema_migrations` table exists (`schema-guard.ts:79-85`).
2. The **latest** migration file id (last in sorted list) has a row in `schema_migrations` (`schema-guard.ts:87-94`).
3. Required tables all exist: `pages`, `page_sync_states`, `page_sync_cursors` (`REQUIRED_TABLE_NAMES`, `schema-guard.ts:10,96-108`).
4. **Legacy tables must be absent**: `platform_accounts`, `platform_account_proxies`, `sync_stream_state`, `sync_checkpoints`, `sync_state`, `sync_cursors`, `sync_requests`, `rate_limit_buckets`, `raw_payloads` (`LEGACY_TABLE_NAMES`, `schema-guard.ts:11-21,110-119`). (Names are assembled from string fragments in the source, presumably to avoid grep noise.)
5. `sync_runs.stats` must be `jsonb NOT NULL DEFAULT '{}'::jsonb` (`schema-guard.ts:121-144`); the default is normalized before comparison.

### Drizzle usage / `db:generate` disabled
- `drizzle.config.ts` points drizzle-kit at `schema.ts` with `out: ./packages/db/migrations`, dialect `postgresql`, `strict: true`, reading `DATABASE_URL` from env (`drizzle.config.ts:9-18`). It is present so `drizzle-kit` can introspect, but **generation is intentionally disabled**.
- `pnpm db:generate` → `scripts/db-generate-disabled.mjs`, which prints an error, suggests the next zero-padded prefix (computed by scanning `packages/db/migrations`), and `process.exitCode = 1` (`db-generate-disabled.mjs:23-34`). The message states the repo deliberately keeps no Drizzle migration journal under `migrations/meta` and that migrations are hand-written.

### Migration catalog (`0000`–`0051`)
53 files; **numbering skips `0005`** (jumps `0004`→`0006`) — a numeric gap that the applied-prefix contiguity check tolerates. One-line intent (from filename + DDL peek):

| File | What it does |
|---|---|
| `0000_baseline.sql` (42 KB) | Full baseline: enums (`platform`, `dm_sender_role`, `fan_flag`, `notification_incident_kind/status`, `dm_message_coverage_status`, …) and all core tables — models, pages, page_credentials, egress_endpoints, fans, page_fans, page_subscriptions, page_follows, transactions, revenue/subscriber/follower daily rollups, sync_runs/http_attempts/run_events, page_sync_states/cursors, page_dm_threads/messages, users/sessions/api_keys/audit, notification_incidents, telegram_settings/delivery_attempts, workboard, spender projections, etc. |
| `0001_transactions_scan_token.sql` | Adds `scan_token` to `transactions` (scan-based cleanup marker). |
| `0002_page_fans_external_presence.sql` | Adds `external_presence_at/observed_at/source` columns + index to `page_fans`. |
| `0003_ai_usage_events.sql` | Creates `ai_usage_feature` enum + `ai_usage_events` table + indexes. |
| `0004_ai_usage_feature_scan.sql` | Adds a `scan` value to the `ai_usage_feature` enum (tiny). |
| `0006_fan_deleted_state.sql` | Adds `deleted_detected_at` / `deleted_last_detected_at` to `fans` + backfill + index. |
| `0007_scope_page_subscriptions_unique_key.sql` | Drops global unique on `platform_subscription_id`, re-scopes uniqueness to `(platform_account_id, platform_subscription_id)`. |
| `0008_fan_identities_sync_stream.sql` | Repair touching the `fan_identities` sync stream (data-only UPDATE). |
| `0009_auto_renew_off_detected_at.sql` | Adds `auto_renew_off_detected_at` to `page_fans` and `page_subscriptions` + backfill. |
| `0010_onlyfans_public_profile_resolutions.sql` | Creates `onlyfans_public_profile_resolutions` table (public-profile resolver bookkeeping). |
| `0011_page_dm_message_account_invariant.sql` | Backfills + adds composite FK so `page_dm_messages` always match their thread's `platform_account_id`. |
| `0012_sync_observability_run_scope.sql` | Re-scopes `sync_http_attempts`/`sync_run_events` to their `sync_runs` (backfill + FK). |
| `0013_backfill_egress_rate_limit_scope_key.sql` | Temp-function (`pg_temp.canonical_proxy_host`) backfill of `egress_endpoints.rate_limit_scope_key`. |
| `0014_repair_light_trusted_sync_states.sql` | Data repair of `page_sync_states` for the `light` stream. |
| `0015_repair_egress_rate_limit_scope_key.sql` | Second temp-function repair of egress scope keys (host+url canonicalization). |
| `0016_canonical_proxy_egress_key_function.sql` | Creates **permanent** SQL functions `canonical_proxy_egress_host()` / `canonical_proxy_egress_key()` (used by `egressKeySql`). |
| `0017_reapply_egress_rate_limit_scope_key_repair.sql` | Re-applies the egress-key backfill using the now-permanent function. |
| `0018_notification_incident_recovery_watermarks.sql` | Creates `notification_incident_recoveries` table (recovery watermark per incident key). |
| `0019_workboard_v2.sql` | Workboard v2: enums (`workboard_tab`, `workboard_mass_substate`, `workboard_secondary_status`, `workboard_freeloader_status`, `workboard_contact_action`) + `workboard_state` table. |
| `0020_workboard_v2_closing_classifier.sql` | Creates `wb_closing_cache` + `wb_llm_usage_daily` (closing-classifier cache + LLM budget counters). |
| `0021_workboard_v2_closing_semantics.sql` | Adds `state` / `reason` text columns to `wb_closing_cache`. |
| `0022_workboard_v2_closing_settings.sql` | Creates `wb_closing_settings` (per-page closing config). |
| `0023_workboard_v2_classifier_runs.sql` | Creates `wb_classifier_runs` (classifier run ledger) + indexes. |
| `0024_model_sort_order.sql` | Adds `models.sort_order`, backfills preserving alphabetical order with gaps of 10. |
| `0025_page_dm_tiered_message_retention.sql` | Adjusts the `page_dm_threads` stored-message-count check constraint (tiered retention). |
| `0026_page_dm_retention_1000_200.sql` | Re-sets retention bounds to 1000 (spenders) / 200 (regular). |
| `0027_ofapi_webhook_receiver.sql` | Adds `pages.ofapi_account_id` (unique), creates `ofapi_webhook_config`, and the `ofapi_webhook_events_fanout_seq` sequence. |
| `0028_ofapi_dm_projection.sql` | Adds `projection_status/error/attempts/projected_at` to `ofapi_webhook_events` + index; `page_dm_messages.purchased_at`. |
| `0029_ofapi_dm_sync.sql` | Creates `ofapi_credit_state` (singleton row id=1 credit/day counters + last balance). |
| `0030_ofapi_account_health.sql` | Makes `notification_incidents.platform_account_id` nullable; adds `pages.ofapi_auth_status` / `ofapi_auth_changed_at`. |
| `0031_ofapi_credit_ledger.sql` | Creates `ofapi_credit_ledger` (per-call credit rows) + FK to pages (`on delete set null`) + indexes incl. partial balance-observation index. |
| `0032_requeue_cross_stamped_ofapi_projections.sql` | Data repair: requeues webhook events that were mis-`skipped` for DM projection. |
| `0033_ofapi_flag_flip_hardening.sql` | Adds `audience_spend_day` / `audience_spent_credits` to `ofapi_credit_state` (separate audience-sweep budget counter). |
| `0034_runtime_instances.sql` | Creates `runtime_instances` (per-process heartbeat rows) + last-seen index. |
| `0035_config_settings.sql` | Creates `config_settings` (override rows) + `config_audit_log`. |
| `0036_ofapi_spend_projection_shadow.sql` | Creates `ofapi_spend_projection_events` (shadow spend projection) + unique domain-key index. |
| `0037_dm_message_archive.sql` | Creates `dm_message_archive` (cold DM archive) with retention/tombstone columns. |
| `0038_ofapi_command_outbox.sql` | Creates `ofapi_commands` (durable command outbox) + dedupe/lane constraints. |
| `0039_ofapi_command_execution.sql` | Adds `attempt_started_at`/`attempt_finished_at` + queued/verifier indexes to `ofapi_commands`. |
| `0040_ai_gateway_usage_ledger.sql` | Adds gateway columns (`provider`, `gateway_outcome`, `quota_accepted`, `provider_response_id`, cost, duration…) to `ai_usage_events` + page/completed index. |
| `0041_ofapi_command_payload_redaction.sql` | Adds `payload_redacted_at` + partial index for terminal-payload redaction. |
| `0042_dm_message_daily_aggregates.sql` | Creates `dm_message_daily_aggregates` (per-page/day archive rollup) + date index. |
| `0043_ofapi_command_typing_active.sql` | Extends the `ofapi_commands` kind check to allow the typing-active command. |
| `0044_ofapi_command_unsend_message.sql` | Extends command kind check: unsend-message. |
| `0045_ofapi_command_mark_chat_read.sql` | Extends command kind check: mark-chat-read. |
| `0046_ofapi_command_send_media_message.sql` | Extends command kind check: send-media-message. |
| `0047_ofapi_dm_archive_status.sql` | Adds `archived_at` + `archive_status` (+ check) + archive index to `ofapi_webhook_events`. |
| `0048_page_dm_message_tombstones.sql` | Adds `page_dm_messages.deleted_at` (tombstone). |
| `0049_audit_final_l17_operational_edges.sql` | Drops the `ofapi_spend_projection_events.page_id` FK and makes it nullable (survive page deletion). |
| `0050_telegram_credentials_updated_at.sql` | Adds `telegram_settings.credentials_updated_at` + backfill (verified-status watermark). |
| `0051_ofapi_credit_ledger_list_indexes.sql` | Adds `(page_id, occurred_at desc, id desc)`, `(operation, …)`, `(occurred_at desc, id desc)` composite indexes for the credit-ledger list. |

---

## 3. Repositories

Every function takes `db: Database` (or a `tx` cast to it) as its first arg. Grouped by domain. **Bold** functions are hot paths on the sync/projection or webhook/SSE critical path.

### 3.1 Catalog & credentials — `catalog.ts`
Owns `models`, `pages`, `page_credentials`, `egress_endpoints` (+ seeds `spender_projection_watermarks`). Typed errors: `PlatformAccountIdentityImmutableError`, `PlatformAccountIdentityConflictError`, `DuplicateModelSlugError`, `DuplicatePageLabelError`, `CatalogModelNotFoundError`, `CatalogPageNotFoundError`, `ModelHasPagesError`. `hasErrorCode` walks the `.cause` chain to detect Postgres `23505` (unique violation) and translate to those errors (`catalog.ts:88-102`).
- `createModel` — computes `sortOrder = max+10` then inserts (`catalog.ts:104-121`).
- **`createPlatformPage`** (+ `createFanslyPage`/`createOnlyFansPage`) — inserts a page with `commissionRate` defaulting to 0.2 for OnlyFans / 0 for Fansly, **inside a transaction** that also inserts a `spender_projection_watermarks` row at epoch (`catalog.ts:157-195`).
- `storePlatformCredentials` / `storeFanslySession` — **upsert** encrypted session + `keyVersion` into `page_credentials`, keyed on `platform_account_id` (`catalog.ts:210-235`). *(secret write)*
- `storeProxyConfig` / `deleteProxyConfig` — upsert/delete `egress_endpoints`; derives `rateLimitScopeKey` via `buildProxyEgressKey({ url })` when not supplied (`catalog.ts:237-279`). *(secret write: `encryptedAuth`)*
- `findPageByLabel` / `findPageById` — page + its credentials + proxy (`catalog.ts:281-317`).
- `listPlatformAccounts`, `listPagesByPlatform`, `listFanslyPages`, `listModelsWithPageCounts`, `listAdminModels`, `listAdminPages`, `listPageSummaries` — catalog listings.
- `updateModelBySlug`, `deleteModelBySlug` (refuses while pages exist → `ModelHasPagesError`), `updatePageByLabel`, `deletePageByLabel`.
- **`updatePageMetadata`** — writes username/displayName/follower & subscriber counts/`earningsBalanceMills`/metadata; enforces **immutable upstream identity** (`platformAccountId` cannot be rebound) and cross-page uniqueness, catching `23505` to re-derive the conflict (`catalog.ts:555-660`). Optionally stamps `lastLightSyncAt`/`lastFollowerSyncAt`.
- `updateOnlyFansPageIdentityFromOfapi` — updates username/displayName/metadata for an OFAPI-mapped OnlyFans page.
- `mergePageMetadata` — jsonb `||` merge patch onto `pages.metadata`.

### 3.2 Fans, memberships, subscriptions, follows — `fans.ts`
Owns `fans`, `page_fans` (a.k.a. "page membership"), `page_subscriptions`, `page_follows`, `fan_username_aliases`. This is a **primary sync-write hot path** (Fansly + OFAPI audience projection). Batch upserts dedupe by natural key and **group inputs by which fields are present** so a partial patch never overwrites unrelated columns with nulls.
- **`upsertFans`** — dedupes by `platform:platformUserId`, groups by presence key, upserts `fans` `ON CONFLICT (platform, platform_user_id)`; conditionally clears/sets `deleted_detected_at`/`deleted_last_detected_at` based on whether a non-blank username/displayName reappears; then upserts `fan_username_aliases` with `least/greatest` first/last-seen merge (`fans.ts:85-184`).
- **`upsertFanPages` / `upsertFanPage`** — upsert `page_fans` on `(fan_id, platform_account_id)`; carries follower/subscriber flags, subscription expiry, and **auto-renew-off detection** via a `case` that stamps `auto_renew_off_detected_at` the first time auto-renew flips false and clears it when true (`fans.ts:257-431`).
- `upsertFanPageExternalPresences` — `greatest()` merge of external-presence timestamps (Fansly follower last-seen), default source `FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN` (`fans.ts:433-492`).
- `upsertPageFollows`/`upsertPageFollow`, `countActivePageFollows`, `deactivatePageFollowsMissingFromSnapshot`, `deactivatePageFollowsByGeneration` (generation-watermark sweep), `refreshFanPageFollowerState` (recomputes `page_fans.is_follower/follower_since` from active follows).
- `upsertPageSubscription`/`upsertPageSubscriptions`, `setPageSubscriptionsCurrentFlag`, `deactivatePageSubscriptionsByGeneration` (**`lastSeenBefore` guard, audit P-25**: a sweep only retires rows last-seen before the sweep started so a mid-sweep webhook insert isn't wrongly retired, `fans.ts:839-863`), `refreshFanPageSubscriberState` (recomputes subscriber columns from `is_current` subs), `findPageSubscription` (**`forUpdate` option, audit P-26** — the OFAPI live projection must lock the row it reads before the full-row upsert to avoid clobbering a fresher sweep, `fans.ts:987-1006`).
- `recalculateFanPageSpend` → delegates to `rebuildSpenderProjections` (`fans.ts:913-915`).
- Read helpers: `getFanSpendByIdentifier`, `listTopFansForPage`, `getCurrentSubscribers`, `getFollowersForPage`.

### 3.3 Fan side-tables — `fan-metadata.ts`, `fan-profiles.ts`, `fan-page-identity.ts`, `onlyfans-public-profiles.ts`, `search.ts`
- `fan-metadata.ts` — `fan_notes`, `fan_summaries`, `fan_flags`. `setFanFlags` is a **delete-then-insert transaction** (`fan-metadata.ts:72-98`).
- `fan-profiles.ts` — `fan_profiles` versioned bodies. `appendFanProfile` serializes version assignment with **`pg_advisory_xact_lock(hashtextextended("acctId:fanId"))`** so versions stay gapless (`fan-profiles.ts:19-49`). `getLatestFanProfileForConversation` joins through `findVisiblePageDmConversationByPlatformConversationId`.
- `fan-page-identity.ts` — Fansly "Custom Username" notes → `fan_page_external_notes` + `fan_page_aliases` alias history + writes the current alias back onto `page_fans` (`reconcileFanslyFanPageIdentity`, `fan-page-identity.ts:98-232`). Alias notes identified by title `"Custom Username"` or `contentType 12002`. `listFanslyFanPageIdentityBackfillTargets` enumerates targets.
- `onlyfans-public-profiles.ts` — `onlyfans_public_profile_resolutions`. `listOnlyFansPublicProfileResolutionCandidates` picks top-spender fans with blank/technical usernames due for re-attempt; `upsertOnlyFansPublicProfileResolution` upserts on `fan_id` with `attempt_count = current+1` (`onlyfans-public-profiles.ts:100-133`).
- `search.ts` (internal) — `ilike` pattern escaping and page-alias match/value SQL fragments consumed by `spenders.ts`.

### 3.4 Transactions & revenue rollups — `transactions.ts`
Owns `transactions` (+ writes `revenue_daily`, `daily_followers`, `daily_subscribers`).
- **`upsertTransaction`** — upsert on `(platform_account_id, transaction_id)`; `fan_id` merged via `coalesce(excluded.fan_id, existing)`; `scan_token` preserved when the input omits it; re-activates the row (`is_active=true`, clears inactive reason) (`transactions.ts:52-99`).
- `markTransactionsScanToken` — batched (1 000/chunk) scan-token stamp (`transactions.ts:101-125`).
- **`rebuildRevenueRollups`** / `rebuildFollowerRollups` / `rebuildSubscriberRollups` — transactional delete-then-`insert … on conflict do update` recomputes of the daily rollup tables, respecting platform business time zone and an optional `from` watermark (`transactions.ts:127-296`).
- `getRevenueBreakdown` / `retireTransactionsMissingFromWindow` (soft-retire via `is_active=false`, three cleanup modes: `keep_set`, `authoritative_empty`, `scan_token`) / `countActiveInWindowTransactionsByScanToken` (defensive guard against a provider under-returning a window mass-deactivating rows) / `getOldestPendingTransactionAt`.
- **Discrepancy:** `deleteTransactionsMissingFromWindow` is exported as an **alias of `retireTransactionsMissingFromWindow`** (`transactions.ts:380`) and does a **soft delete** (`is_active=false`, `inactive_reason='missing_from_sync_window'`), not a row delete despite the name.

### 3.5 Spender projections — `spenders.ts`, `top-spenders.ts`
- `spenders.ts` owns `fan_spend_daily`, `fan_spend_lifetime`, `spender_projection_watermarks` (Drizzle vars `spenderDailyFacts` / `spenderLifetimePage`). **`rebuildSpenderProjections`** wraps `rebuildSpenderDailyFacts` + `rebuildSpenderLifetimePage` + `upsertSpenderProjectionWatermark` **in one transaction** (`spenders.ts:213-237`); `from`-scoped rebuilds only recompute affected fans and also update `page_fans.total_creator_net_mills`. Large read surface for dashboards: `listRankedSpenders` (~330 lines of ranking SQL), `getSpenderWindowMetrics`, `getSpenderTypeBreakdown(Batch)`, `count/listPageFansBy{Lifetime,Window}GrossBucket`, `getSpenderDailySeriesRows`, `searchFansInScope`, `getUnattributedRevenueForScope`, `getSpenderRevenueDiagnosticsForScope`, `findVisibleFanByIdentity`, `getVisibleFanPageMemberships`, `listVisibleScopePages`. Visibility is scoped by `pageIds` throughout.
- `top-spenders.ts` owns `page_top_spenders`. **`upsertPageTopSpenders`** batch-upserts on `(platform_account_id, source_identity_key)`, `fan_id` merged with coalesce. `aggregateTransactionTopSpenders` computes per-fan gross/net from `transactions` (source for the computed OnlyFans `top_spenders` SSE stream). `getEarliestSpenderTransactionAt` anchors the bootstrap window.

### 3.6 Page sync orchestration — `page-sync.ts`, `sync-context.ts`, `sync.ts`, `egress.ts`
These are the **executor scheduling core** (worker hot path). Table shapes in Territory 04; behavior here.

**`page-sync.ts`** owns `page_sync_states` (per page×stream FSM) and reads `page_sync_cursors`, `egress_endpoints`, `pages`. Defines the 9 sync **streams** (`light`, `fan_identities`, `transactions`, `top_spenders`, `subscribers`, `followers`, `followers_reconcile`, `dm_conversations`, `dm_messages`), 5 **domains** (`connection`, `financials`, `audience`, `messages_live`, `messages_history`), and static policy maps `SYNC_STREAM_POLICY`, `SYNC_DOMAIN_POLICY`, `SYNC_STREAM_DEPENDENCIES` (`page-sync.ts:16-295`). Status enum: `idle|pending|running|retrying|blocked|paused`.
- Pure helpers: `getSyncStreamsForPlatform`, `resolvePageSyncPriority`, `computePageSyncSlotOffsetSeconds`, `computeCurrentPageSyncSlot`, `normalizePageSyncRequestStreams`, `getSyncStreamDependenciesForPage`.
- Lifecycle writers (raw SQL): `ensurePageSyncStates`, `refreshPageSyncDependencies`, `reclaimExpiredPageSync`, `scheduleDuePageSync`, `listRunnablePageSync`, `markPageSyncEnqueued`, **`acquirePageSyncLease`** (a CTE that picks the highest-priority ready state and atomically flips it to `running` with a `lease_token`/`lease_owner`/`lease_expires_at`, joining `pages` + `egress_endpoints` to return platform + proxy + egress key, `page-sync.ts:1318-1412`), `heartbeatPageSyncLease`, `recordRunningPageSyncProgress`, `clearPageSyncLease`, **`completePageSync`**, `yieldPageSync`, `retryPageSync`, `blockPageSync`, `markPageSyncAuthBlocked`/`clearPageSyncAuthBlock`, `pausePageSync`/`resumePageSync`/`resetPageSync`, `requestPageSync`. All lease mutations guard on `lease_token`/`leased_seq` so a lost lease can't write.

**`sync-context.ts`** — an `AsyncLocalStorage<PageSyncExecutionContext>` ({ pageId, stream, requestSeq, leaseToken }). `assertOwnedPageSyncLease` re-checks the state row (`status='running'` + matching token/seq, optionally `FOR UPDATE`) and throws `PageSyncLeaseLostError` if the lease was stolen; `withOwnedPageSyncTransaction` wraps a callback so the lease is asserted before and (locked) after the writes (`sync-context.ts:36-97`). Cursor/checkpoint writes in `sync.ts` use this context to fence writes to the current lease.

**`sync.ts`** owns `sync_runs`, `sync_http_attempts`, `sync_run_events`, `sync_raw_payloads`, `page_sync_cursors`, `sync_rate_limits`; re-exports all of `page-sync.ts`. Config maps `SYNC_STREAM_CONFIG`, `DM_SYNC_DEPENDENCY_STREAMS`.
- Run lifecycle: `startSyncRun`, `finishSyncRun` (maps status → `sync_run_outcome`), `closeOrphanedSyncRuns` / `closeInactiveSyncRuns` (mark stuck `running` rows `partial` if a `checkpoint_advanced` event exists else `failed`).
- **Cursor/watermark handling**: `getCheckpoint`, **`upsertCheckpoint`** (touches success metadata) / `upsertCheckpointProgress` (does not). The internal `upsertCheckpointRow` (`sync.ts:467-572`) — when a lease execution context matches — does the `page_sync_cursors` upsert **inside a CTE that first `SELECT … FOR UPDATE`s the owning `page_sync_states` row**, and throws `PageSyncLeaseLostError` if that row is gone (so a stolen lease can't advance the cursor). Columns: `cursor_text`, `cursor_timestamp`, `cursor_seq`, `state` jsonb, `last_succeeded_run_id`, `last_succeeded_at`. `deleteCheckpoints` clears cursors for a reset.
- Observability writes: `insertRawPayload` (into `sync_raw_payloads`, stamped with stream/requestSeq from context; retention via `retain_until`), `insertSyncRequestAttempt`/`finishSyncRequestAttempt`, `insertSyncRunEvent`, `deleteExpiredRawPayloads`, `deleteExpiredSyncObservability`.
- Monitor reads: `listRecentSyncRuns`, `getSyncRun`, `listSyncRunEvents`, `listSyncRequestAttempts`, `listRunningSyncRuns`, `getLatestSyncRunPerPage`, `listSyncMonitor{StreamRows,RecentRequests,RecentEvents}`, `countRecentTerminalDmMessageConversationFailureStreak`, `hasRecentTerminalProxyFailure`.
- **Rate limiting**: `ensureSyncProviderRateLimitProfile` upserts `sync_rate_limits (provider, scope, egress_key, min_spacing_ms)`; **`reserveSyncProviderRateLimit`** (`sync.ts:2044+`) opens a transaction, locks each scope row **`FOR UPDATE` in a deterministic sorted order** (provider→scope→egressKey) to avoid deadlock, and advances `next_available_at` by `min_spacing_ms` — this is the outbound-request pacing gate for Fansly/OnlyFans egress. `updatePageSyncTimestampCache` stamps `pages.last_light_sync_at`/`last_follower_sync_at`.
- `egress.ts` (internal) — `egressKeySql(scopeKey, proxyUrl)` = `coalesce(scopeKey, canonical_proxy_egress_key(proxyUrl), 'direct')`, using the SQL function created in migration `0016`.

### 3.7 Page DM projection & archive — `page-dm.ts`, `ofapi-sync-snapshot.ts`, `dm-message-archive.ts`, `dm-analytics.ts`
- **`page-dm.ts`** owns `page_dm_threads` (Drizzle var `pageDmConversations`, aliased to `pageDmThreads` at `schema.ts:1714`) and `page_dm_messages`. Retention constants: regular 200 / spender 1000 messages (`page-dm.ts:19-20`). **`upsertPageDmConversation`** / **`upsertPageDmMessages`** are the DM projection writers; `markPageDmConversationsInvisibleByGeneration` retires stale threads by generation. `findPageDmMessageByPlatformMessageId`, `deletePageDmMessageByPlatformMessageId` (tombstone), `markPageDmMessagePurchased`, `raisePageDmMessageTipAmount`. **`prunePageDmMessagesToLimit`** window-ranks by `(created_at desc, platform_message_id desc, id desc)` and deletes rows past the limit; `getPageDmMessageRetentionLimit` returns 1000 vs 200 based on whether `fan_spend_lifetime.creator_net_amount_mills > 0` (`page-dm.ts:560-620`). Sync-coverage/candidate selection: `refreshPageDmConversationWindow`, `finalizePageDmConversationMessageSync`, `resetPageDmSyncState`, `getExistingPageDmMessageIds`, `selectNextPageDmMessageSyncCandidate`, `selectNextPageDmMessageDeepBackfillCandidate`, `getPageDmSyncCoverage`. Dashboard reads: `getPageConversationMessages`, `getPageConversationPreview`.
- **`ofapi-sync-snapshot.ts`** — read-only snapshot for the desktop workspace's OFAPI DM sync: `findOfapiSyncSnapshotPage` (asserts the ofapi account is among the caller's assigned pages), `listOfapiSyncSnapshotThreads` (with an `exists` subquery computing `hasUnreadTips` over the unread window), `listOfapiSyncSnapshotHotMessages`, **`listOfapiSyncSnapshotArchiveMessages`** (delta by `source_fanout_seq > afterSeq` OR explicit hot ids), `listOfapiSyncSnapshotUnresolvedTombstones` (`ofapi-sync-snapshot.ts:68-256`). These feed the desktop's incremental hydration.
- **`dm-message-archive.ts`** owns `dm_message_archive` (cold OnlyFans DM archive). **`upsertDmMessageArchive`** upserts on `(platform, ofapi_account_id, platform_message_id)`; `tombstoneDmMessageArchive` inserts/updates a deleted marker with `coalesce`-preserved `deleted_at`; `findDmMessageArchiveByPlatformMessageId`; `deleteExpiredDmMessageArchiveRows` (past `retain_until`). `getDmMessageArchiveStatus` cross-joins archive stats with `ofapi_webhook_events` archive-journal pending/failed counts. Media metadata is an embedded jsonb array; `source_fanout_seq` links back to the webhook fanout cursor.
- `dm-analytics.ts` owns `dm_message_daily_aggregates`. `rebuildDmMessageDailyAggregates` — validates the `YYYY-MM-DD` business-date range, deletes the window, then a single `insert … select` rolls `dm_message_archive` into per-page/day counts (inbound/outbound/deleted/paid/tip totals, `max(source_fanout_seq)`) inside a transaction (`dm-analytics.ts:33-110`). `listDmMessageDailyAggregates` reads them back.

### 3.8 OFAPI webhook journal, SSE fanout, credit ledger — `ofapi.ts`, `ofapi-commands.ts`
**`ofapi.ts`** (67 KB) owns `ofapi_webhook_events`, `ofapi_webhook_config`, `ofapi_credit_state`, `ofapi_credit_ledger`, `ofapi_spend_projection_events`; also reads/writes `pages` (OFAPI mapping/auth) and `transactions` (truth-ingest). Central to the **webhook → SSE** pipeline.
- **`insertOfapiWebhookEvent`** — journals a delivery; `ON CONFLICT (idempotency_key) DO NOTHING` returns null on a duplicate (OFAPI delivers at-least-once) (`ofapi.ts:45-62`). *(inbound webhook landing write)*
- **`settleOfapiWebhookEvent`** — guarded `status='pending'` update to a terminal status; a `processed` row is assigned `fanout_seq = nextval('ofapi_webhook_events_fanout_seq')` — the **settle-ordered SSE / Last-Event-ID cursor** (`ofapi.ts:79-109`).
- Projection/archive bookkeeping: `markOfapiWebhookEventProjection`, `markOfapiWebhookEventArchive(Pending)`, `listOfapiWebhookEventsForDmProjection`, `listOfapiWebhookEventsForDmColdArchive`, `listPendingOfapiWebhookEventIds`, `deleteExpiredOfapiWebhookEvents`.
- **SSE replay**: **`listOfapiSyncEventsForReplay`** — processed frames after a `fanout_seq` cursor, oldest first, optionally page-filtered (`ofapi.ts:896-932`); `getMaxOfapiFanoutSeq`, `getOfapiFanoutReplayWindow` (reads `oldest fanout_seq` + the sequence's `last_value` so the high-water survives journal pruning), `getLatestSettledOfapiDmEventTimes` (per-page webhook freshness), `getLatestOfapiWebhookEventReceivedAt` (silence signal), `getLatestOfapiEventTimesForPages`. These feed the desktop SSE stream. *(outbound stream reads)*
- **Credit accounting** (see §4.3): `recordOfapiCreditUsage`, `reserveOfapiDayCredits`, `settleOfapiDayCreditReservation`, `getOfapiCreditState`, `insertOfapiCreditLedgerEntry`, `recordOfapiCreditSpend` (ledger + counter in one txn), `upsertOfapiWebhookAccrual` (idempotent per accrual day), `withOfapiSpendTransactionPageLock` (advisory lock namespace 9003001 keyed by pageId), plus a large family of reconciliation/forecast readers (`summarizeOfapiSpendWindowBetween`, `sumOfapiKnownCreditsBetween`, `listOfapiBalanceObservationsAfter`, `getOfapiCreditReconcileState`/`setOfapiCreditReconcileCursor`, `listOfapiCreditLedgerEntries`, `listOfapi{DailySpendBySource,BalanceSeriesBetween,RefillsBetween,OperationBreakdownBetween,PageBreakdownBetween}`).
- **Spend-projection shadow** (`ofapi_spend_projection_events`): `upsertOfapiSpendProjectionEvent`, `listOfapiWebhookEventsForSpendProjection`, `listMissingOfapiSpendProjectionTransactionsForTruthIngest`, `summarizeOfapiSpendProjectionComparison(ByPage)`, `listOfapiSpendProjectionComparisonSamples`, `getOfapiFinancialTruthSummaries` — a shadow-projection reconciliation against `transactions`.
- **OFAPI page mapping / auth**: `getOfapiWebhookConfig` / `upsertOfapiWebhookConfig` (singleton id=1, stores `encrypted_signing_secret` + `previous_encrypted_signing_secret`, `endpoint_url`, `account_scope`, `events`) *(secret write)*; `findPageByOfapiAccountId`, `listOnlyFansPagesForOfapiMapping`, `setPageOfapiAccountId`, **`advancePageOfapiAuthStatus`** (forward-only by `changedAt` — an older out-of-order `accounts.*` event never overwrites a newer state, `ofapi.ts:1942-1964`), `listOfapiMappedPages`.

**`ofapi-commands.ts`** owns `ofapi_commands` (the durable outbound-command outbox: desktop → OFAPI actions). States: `queued|in_flight|indeterminate|confirmed|failed_retryable|failed_terminal|cancelled`.
- **`createOrGetOfapiCommand`** — insert with `ON CONFLICT (page_id, chatter_user_id, client_command_id) DO NOTHING`; on conflict re-reads the existing row (idempotent client-side dedupe), `dedupe_expires_at = now()+400 days` (`ofapi-commands.ts:36-79`).
- **`claimQueuedOfapiCommand`** — flips exactly one `queued`/`attempt_count=0` row to `in_flight`, catching `23505` from the partial unique "lane" index as a lost race (returns null) (`ofapi-commands.ts:136-166`).
- `cancelQueuedOfapiCommand`, `finalizeOfapiCommand` (guarded on `fromStates`), `markStaleInFlightOfapiCommandsIndeterminate`, `redactTerminalOfapiCommandPayloads` (blanks `send_text_message_v1.text` / `'{}'` for other kinds past a TTL — a **PII redaction** sweep), `listQueuedOfapiCommandIds`, `getOfapiCommandById(ForUser)`, `listOfapiCommandVerificationCandidates`.

### 3.9 AI usage ledger — `ai-usage.ts`
Owns `ai_usage_events`. Records the **AI gateway** (Anthropic / OpenRouter) usage — model, tokens (input/output/cacheWrite/cacheRead), `cost_micro_usd`, `provider`, `gateway_outcome` (`completed|failed|cancelled|quota_denied`), `quota_accepted`, `provider_response_id`, duration. Reserve-then-finalize pattern for gateway calls: `reserveAiGatewayUsageEvent` (insert a reservation row, `ON CONFLICT (user_id, client_event_id) DO NOTHING`), `finalizeAiGatewayUsageEvent` (fill actuals), `markStaleAiGatewayReservationsFailed` (recover abandoned reservations). `insertAiUsageEvents` (batch, client-id deduped), `getAiGatewayDailyUsageTotals` (per user×page daily quota check), `listChatterUsageSummary` (large multi-CTE report over chatters, feature/provider breakdowns). *(records the Claude/OpenRouter provider boundary — see Territory covering the AI gateway.)*

### 3.10 Workboard — `workboard.ts`, `workboard-v2.ts`
- `workboard.ts` (v1) — read-mostly board queries over subscribers/spenders/presence (`listWorkboardSubscribers`, `listWorkboardActiveSpenders`/`Inactive`/`All`, `listWorkboardSnoozed`, `listWorkboardPresence`) plus `snoozeWorkboardFan`/`unsnoozeWorkboardFan`.
- `workboard-v2.ts` — owns `workboard_state`, `wb_closing_cache`, `wb_closing_settings`, `wb_classifier_runs`, `wb_llm_usage_daily`. Signal load + state upsert (`loadWorkboardSignalRows`, `deleteIneligibleWorkboardStates`, `upsertWorkboardStates`), board reads (`listWorkboardV2`, `getWorkboardV2Counts`, `listWorkboardSpenderBands`), contact actions (`appendWorkboardContact`, `markReactivationAttemptedIfDead`, `countOldMassContactsToday`, `snoozeWorkboardFanV2`, `deleteLastWorkboardContact`). **Closing classifier** (LLM-backed): candidate selection (`listClosingClassificationCandidates`, `listSpenderDiagnosisRows`), cache upsert/clear (`upsertClosingCache`, `clearClosingCacheForPage`, `countClosingCache`), settings, classifier-run ledger with a **`pg_advisory_xact_lock(CLASSIFIER_RUN_LOCK_NAMESPACE, pageId)`**-guarded manual-start (`insertClassifierRunRunningIfIdle`, `workboard-v2.ts:1098-1127`), and **daily LLM budget counters** in `wb_llm_usage_daily`: `getLlmUsageDaily`, `incrementLlmUsageDaily`, `reserveLlmUsageDailyCall` (atomic `insert … on conflict do update … where calls < cap returning`, so a per-page/day/feature call cap can't be exceeded, `workboard-v2.ts:861-878`), `addLlmUsageDailyTokens`. These counters are the DB side of the closing-classifier's Claude-usage budget (the actual LLM call is outside this territory).

### 3.11 Auth, config, telegram, notifications, runtime, reporting
- **`auth.ts`** owns `users`, `auth_sessions`, `api_keys`, `user_page_assignments`, `audit_events`. Stores only `password_hash` and `token_digest` (never plaintext). `lockUserForApiKeyRotation` = `SELECT … FOR UPDATE` on the user row to serialize key rotation. Session/key revocation, `deleteExpiredAuthSessions`, `insertAuditEvent`. *(secret-adjacent writes: password hash, token digests)*
- **`config-settings.ts`** owns `config_settings` + `config_audit_log` (the in-dashboard config override surface). **`getConfigOverrides`** returns a `Map<key, {value, version}>` for a scope (default `global`/0) — read once at boot and by the live effective-config resolver. Writes are **optimistic-locked**: `applyConfigPatchesInTx` locks each row `FOR UPDATE` in **sorted key order** (deadlock-safe), checks `expectedVersion`, upserts (version+1) or clears (deletes → version null), and appends an audit row — all-or-nothing. `setConfigOverridesAtomic` wraps it in a plain transaction (live PATCH path); the staged-commit path in the runtime wraps `applyConfigPatchesInTx` under its own advisory lock. `ConfigOverrideVersionConflictError` on stale version or a lost new-key insert race (`23505`). `setConfigOverride`, `clearConfigOverride`, `listConfigAudit`.
- **`telegram-settings.ts`** owns `telegram_settings` (singleton id=1) + `telegram_delivery_attempts`. `getTelegramSettings` self-seeds the singleton. `updateTelegramSettings` stores `encrypted_bot_token` + `chat_id` and only bumps `credentials_updated_at` when the token/chat id actually change (the verified-status watermark). Delivery-attempt inserts/reads (`insertDeliveryAttempt`, `getLatestRealDeliveryAttempt` ignoring `skipped`, `hasScheduledReportForDate`, …). *(secret write: encrypted bot token)*
- **`notifications.ts`** owns `notification_incidents` + `notification_incident_recoveries`. Incident kinds include sync failures and `ofapi_auth`/`ofapi_low_credit`/`ofapi_webhook_silence`/`ofapi_burn_rate`. `openNotificationIncident(WithRecoveryGuard)` runs in a transaction fenced by **`pg_advisory_xact_lock(hashtextextended(incidentKey, seed))`**, re-reads the incident `FOR UPDATE`, and open/reopen/refresh with a recovery-watermark guard so a late incident event that predates a recovery is suppressed; retries up to 3× on `23505`. `resolveNotificationIncident`, `recordNotificationIncidentRecovery` (`greatest()`-merged watermark), list helpers with page joins + per-incident notification counts.
- **`runtime-instances.ts`** owns `runtime_instances`. `upsertInstanceHeartbeat` on `(role, instance_id)` writes a `running` snapshot; TTLs: `INSTANCE_STALE_TTL_MS` 3 min (view marks stale), `INSTANCE_REAP_TTL_MS` 30 min (`reapStaleInstances` hard-deletes). `listActiveInstances`/`listAllInstances`/`removeInstance`.
- **`reporting.ts`** — read-only dashboard queries over pages/models/transactions/subscribers/followers/fans, all `pageIds`-scoped for visibility (`listVisiblePages`, `listVisibleModels`, `getRevenuePageTotals(ForExactPeriod)`, `listTransactionsForPage`/`Scope`, `listSubscribersForPage`, `listFollowersForPage`, `listFansForPage`, `listDeletedFansForPage`, `listFanTransactionsOnPage`/`CrossPage`, `getPlatformTotalSpendForFan`, `countDistinctFansForPages`, …). Uses `egressKeySql` for a couple of proxy-labeled reads.

---

## 4. Cross-cutting consistency primitives

### 4.1 Advisory locks (serialize without table locks)
| Site | Key | Purpose |
|---|---|---|
| `migrate-runner.ts:77` (+ `startup.ts`) | `pg_advisory_lock(31415, 27182)` session | single-writer migrations |
| `ofapi.ts:24` | `pg_advisory_xact_lock(9003001, pageId)` | serialize OFAPI spend-transaction ingest per page |
| `fan-profiles.ts:22` | `pg_advisory_xact_lock(hashtext("acctId:fanId"))` | gapless fan-profile version numbers |
| `notifications.ts:78` | `pg_advisory_xact_lock(hashtext(incidentKey, seed))` | serialize incident open/resolve per key |
| `workboard-v2.ts:1106` | `pg_advisory_xact_lock(CLASSIFIER_RUN_LOCK_NAMESPACE, pageId)` | one manual classifier run per page |

### 4.2 `FOR UPDATE` row locks
`config-settings.ts` (sorted-key patch), `sync.ts` (`reserveSyncProviderRateLimit` sorted scopes; `upsertCheckpointRow` fences on the owning state row), `auth.ts:186` (api-key rotation), `notifications.ts:271` (incident row), `fans.ts:1003` (`findPageSubscription` optional), `page-dm.ts:363` (`findVisiblePageDmConversationByPlatformConversationId` optional), `sync-context.ts:56` / `page-sync.ts:712` (optional lease/state locks).

### 4.3 Atomic day-budget reservations (OFAPI credits, audit F9)
`reserveOfapiDayCredits` folds the budget comparison and the counter increment into **one conditional `INSERT … ON CONFLICT DO UPDATE … WHERE (day counter) + estimate <= budget RETURNING id`** on the singleton `ofapi_credit_state` row (`ofapi.ts:1052-1092`), so concurrent streams near the cap can never both pass. `global` vs `audience` scope select different column pairs. `settleOfapiDayCreditReservation` applies the actual-minus-estimate delta clamped at 0, straddling the UTC-day rollover. `recordOfapiCreditSpend` writes the ledger row and the day counter **in one transaction** so the fast counter can never disagree with the ledger. `upsertOfapiWebhookAccrual` is idempotent per UTC day via a partial unique index (`on conflict (accrual_day) where source='webhook_accrual' do nothing`). `wb_llm_usage_daily.reserveLlmUsageDailyCall` uses the same conditional-upsert shape for the closing-classifier call cap.

### 4.4 Watermarks & cursors
- **Sync cursors** (`page_sync_cursors`): `cursor_text` / `cursor_timestamp` / `cursor_seq` + `last_succeeded_run_id`/`last_succeeded_at`, advanced by `upsertCheckpoint(Progress)` under lease fencing (`sync.ts`).
- **Generation watermarks**: `last_seen_generation` on `page_follows`/`page_subscriptions` drives `deactivate…ByGeneration` sweeps (`fans.ts`).
- **Fanout cursor**: `ofapi_webhook_events.fanout_seq` (from `ofapi_webhook_events_fanout_seq`) is the settle-ordered SSE Last-Event-ID (`ofapi.ts`).
- **Credit reconcile cursor**: `ofapi_credit_state.reconciled_through_ledger_id` (`setOfapiCreditReconcileCursor`).
- **Projection watermark**: `spender_projection_watermarks.last_rebuilt_at` (`spenders.ts`), `dm_message_daily_aggregates.source_max_fanout_seq` (`dm-analytics.ts`).
- **Incident recovery watermark**: `notification_incident_recoveries.recovered_at` (`greatest`-merged).

### 4.5 Idempotency & dedupe keys
`ofapi_webhook_events.idempotency_key` (webhook at-least-once), `ai_usage_events (user_id, client_event_id)` (gateway retries), `ofapi_commands (page_id, chatter_user_id, client_command_id)` (client command dedupe), `dm_message_archive (platform, ofapi_account_id, platform_message_id)`, transactions `(platform_account_id, transaction_id)`. Postgres `23505` is caught and translated in `catalog.ts`, `config-settings.ts`, `ofapi-commands.ts`, `notifications.ts`.

---

## 5. Storage boundary summary
This territory *is* the read/write side of the Postgres boundary; the counterpart is always the `core` Postgres database. Data that also crosses **into other systems** and lands/leaves through these repositories:
- **Inbound OFAPI webhooks** land via `insertOfapiWebhookEvent` (payload jsonb + idempotency key); settlement stamps the `fanout_seq` SSE cursor.
- **Outbound SSE** to the desktop workspace reads `listOfapiSyncEventsForReplay` / `ofapi-sync-snapshot.ts` (thread/message/archive deltas keyed by `fanout_seq`/`source_fanout_seq`).
- **Outbound OFAPI commands** queue through `ofapi_commands` (outbox) and are claimed/finalized by the worker.
- **Outbound OnlyFans/Fansly sync egress** is paced by `sync_rate_limits` reservations and leased through `page_sync_states`.
- **AI provider (Anthropic/OpenRouter)** usage and cost are journaled in `ai_usage_events`; the closing classifier's budget lives in `wb_llm_usage_daily`.
- **Telegram** bot credentials + delivery attempts live in `telegram_settings`/`telegram_delivery_attempts`.
- **Secrets at rest**: encrypted platform sessions (`page_credentials`), proxy auth (`egress_endpoints`), OFAPI signing secret (`ofapi_webhook_config`), Telegram bot token (`telegram_settings`), password hashes + token digests (`auth.ts`). All are written encrypted/hashed by callers; this layer only persists the ciphertext/digests.

**Cross-refs:** Territory 04 (schema.ts) for exact table/column shapes and enums; the API-server and worker territories for the HTTP/webhook/SSE endpoints and pg-boss jobs that call these functions; the OFAPI and AI-gateway territories for the upstream integrations feeding `ofapi_*` and `ai_usage_events`.
