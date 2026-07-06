> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# DB Client, Migration Runner & Repository Layer

This map describes the mechanics of the `packages/db` package: the pooled
Drizzle client, the forward-only migration runner (its advisory lock, ledger
table, per-file transactions, and numbering guards), the runtime schema guard,
the shape of the `0000`–`0074` migration series with its notable structural
migrations, and the inventory of repository modules and their append / dedup /
watermark primitives. It is descriptive and anchored to file:line.

## The pg Pool / Drizzle client

`packages/db/src/client.ts:1-16` constructs the shared database client:

- A `pg.Pool` is created and wrapped with `drizzle(pool, { schema })`
  (`client.ts:1-16`), exposing the Drizzle query builder over the typed schema
  mirror (`packages/db/src/schema.ts`).
- `client.ts:6` installs the global BIGINT type parser
  `pg.types.setTypeParser(20, (value) => BigInt(value))`, so all `int8`
  columns are returned as native JS `bigint` (see `04-database-schema.md` for
  the money-unit implications).

## Forward-only migration runner

`packages/db/src/migrate-runner.ts` is the sole applier of schema change.
There are **no** down-migrations — every migration is forward-only, and applied
migrations are never edited.

- **`runMigrations()`** (`migrate-runner.ts:92`) is the entry logic. Invoked via
  `packages/db/src/migrate.ts:3-20` (the `pnpm db:migrate` command).
- **Session advisory lock:** before applying anything it takes
  `pg_advisory_lock(31415, 27182)` (keys `MIGRATION_LOCK_KEY_1` /
  `MIGRATION_LOCK_KEY_2` at `migrate-runner.ts:10-11`, acquired at
  `:77-80`), so only one migrator can run at a time.
- **Ledger table:** `schema_migrations(id text primary key, applied_at)` is
  created if absent (`migrate-runner.ts:99-104`). Each migration is recorded by
  its filename.
- **Per-file transaction:** each `.sql` file runs in its own `begin`/`commit`
  (`migrate-runner.ts:124-139`); a file that fails rolls back only itself.

### Numbering guards

Two assertions fail the run before any SQL executes if the migration set is
malformed:

| Guard | Location | Rejects |
|---|---|---|
| `assertUniqueMigrationPrefixes` | `migrate-runner.ts:13-31` | Two files sharing the same 4-digit prefix. |
| `assertContiguousAppliedPrefix` | `migrate-runner.ts:33-52` | Out-of-order application — the applied set must be a contiguous prefix of the sorted file list (no gaps, no skipping ahead). |

### Filename pattern & directory resolution

- Filenames must match `/^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$/`
  (`migrations-dir.ts:8,21-28`).
- Files are sorted lexically (`migrations-dir.ts:31`), which for the
  zero-padded 4-digit prefixes is also numeric order.
- Directory resolution prefers `cwd/packages/db/migrations`, then falls back to
  a module-relative path (`migrations-dir.ts:50-53`).

## Runtime schema guard

`packages/db/src/schema-guard.ts:63` `assertRuntimeSchemaReady()` runs at
process start and refuses to boot against a database that is not fully migrated
to the current head. It asserts:

- `schema_migrations` exists and the **latest** migration id is applied
  (`schema-guard.ts:87-94`).
- Required tables `pages`, `page_sync_states`, `page_sync_cursors` exist
  (`schema-guard.ts:10, 96-108`).
- Legacy tables are absent (`schema-guard.ts:11-21, 110-119`).
- `sync_runs.stats` is `jsonb NOT NULL DEFAULT '{}'`
  (`schema-guard.ts:121-144`).

This behavior is pinned by `tests/schema-guard.test.ts`.

## The migration series 0000–0074

75 SQL files, `0000`–`0074`, under `packages/db/migrations/`. Selected
structurally notable migrations (as named in the schema map):

| Migration | What it introduced |
|---|---|
| `0000_baseline.sql` | The foundational schema: `models`, `pages`, `users`, `fans`, `page_fans`, `transactions` (money truth, cols at 0000:570-590), sync engine tables, `audit_events`, workboard snoozes. |
| `0003` / `0004` | `ai_usage_events` and its feature scan. |
| `0010` | `onlyfans_public_profile_resolutions`. |
| `0018` | `notification_incident_recoveries`. |
| `0019` / `0020` / `0022` / `0023` | Workboard v2: `workboard_state`, `workboard_contact_log`, `wb_closing_cache`, `wb_llm_usage_daily`, `wb_closing_settings`, `wb_classifier_runs`. |
| `0027` | OFAPI webhook config + events. |
| `0029` / `0031` | OFAPI credit state and the append-only `ofapi_credit_ledger`. |
| `0034` | `runtime_instances` (heartbeat / leader election). |
| `0035` | Config surface: `config_settings` + `config_audit_log`. |
| `0036` | `ofapi_spend_projection_events` (shadow spend). |
| `0037` / `0042` | `dm_message_archive`, `dm_message_daily_aggregates`. |
| `0038`–`0046` | `ofapi_commands` outbox and its command types (typing/unsend/mark-read/send-media). |
| `0040` | `ai_usage_events` hardening: `cost_micro_usd` CHECK ≥ 0, `provider`/`gateway_outcome` CHECKs. |
| `0053` | Tombstone / soft-retire markers (`pages.deleted_at`, `workboard_contact_log.retracted_at`, `wb_closing_cache.superseded_at`). |
| `0054` | **`observations`** partitioned capture spine + `observation_keys`; 2026 monthly partitions seeded. |
| `0056` | Flip `pages` child FKs CASCADE → RESTRICT. |
| `0057` | **`domain_events`** partitioned event log + `domain_event_keys` + `domain_event_seq`; `pre_2024` catch-all + 2024–2026 partitions. |
| `0059` | `message_archive`, `projection_seq_watermarks`. |
| `0061` | `fan_earnings_stats` (FKs ON DELETE RESTRICT). |
| `0063` | `transactions` fee/VAT/tax columns. |
| `0064` | `domain_events_smoke_checkpoint`. |
| `0065` | `access_grants`, `device_tokens`, `users.must_change_password`. |
| `0066` | `workboard_claim_leases`. |
| `0067` | `ops_metric_samples` + `golden_signal_lag` incident kind. |
| `0068` | `platforms` reference table. |
| `0071` | `erasure_log` (Stage 28.4 tombstone). |
| `0072` | `ai_generation_content` + `ai_acceptance_events` (Stage 29 DP-6A restricted class). |
| `0073` | `ai_personas` (Stage 30 kernel config). |
| `0074` | `ai_usage_events.user_id` nullable (system lane); `copied` acceptance lifecycle. |

## Repository layer

Repositories live in `packages/db/src/repositories/*` and are exported through
`packages/db/src/repositories/index.ts`. They are the only sanctioned place SQL
is issued; every module that issues a `delete` is pinned by
`tests/retention-deleters.test.ts` (see `18-retention-erasure-tiering.md`).

### Append / dedup / watermark primitives

The two capture spines carry the core append + dedup + gapless-seq logic:

- **`observations.ts`** — the capture append. `insertObservation` /
  `insertObservations` append via a pre-allocated identity id plus an
  `observation_keys` claim; `ON CONFLICT DO NOTHING` on the key is the
  duplicate signal (`observations.ts:54-68`). Also
  `findObservationByKey`, `findObservationEnvelopesByIds`,
  `listObservationsByKindAfterId`, `ensureObservationPartitions`,
  `getObservationPartitionLeadMonths`, `countHarvestObservations`,
  `listHarvestTransactionResidue`. Partition naming/creation lives here
  (`observations.ts:263-321`).
- **`domain-events.ts`** — the gapless event append. `appendDomainEvents`
  takes the per-account `domain_event_seq.next_seq` **FOR UPDATE** for the
  whole batch to assign a serial gapless `account_seq`
  (`domain-events.ts:52-122`) and emits `pg_notify('domain_events_appended')`
  on commit (`domain-events.ts:115-125`); `domain_event_keys` gives content-hash
  dedup on `(account_id, dedup_key)` (`domain-events.ts:71-80`). Also
  `listDomainEventHighWaters`, `listDomainEventAccountBounds`,
  `getAccountHighWater`, `listEventsSince`, `listObservationsForReplay`,
  `markObservationParsed`, `ensureDomainEventPartitions`,
  `getDomainEventPartitionLeadMonths`.

### Repository module inventory

| Module | Responsibility (selected functions) |
|---|---|
| `observations.ts` | Capture append + dedup + partition management (above). |
| `domain-events.ts` | Gapless event append + replay + partition management (above). |
| `erasure.ts` | `insertErasureLog`, `completeErasureLog`, `listErasureLog`. |
| `ai-restricted.ts` | `insertAiGenerationContent`, `insertAiAcceptanceEvent`, `listAiGenerationContent`, `getAiGenerationContentByRef`, `getAiGenerationContentVolume`. |
| `ai-personas.ts` | `upsertAiPersona`, `findAiPersonaByKey`, `listAiPersonas`, `archiveAiPersona` (soft-retire). |
| `ai-usage.ts` | `insertAiUsageEvents`, `reserveAiGatewayUsageEvent`, `recordAiGatewayQuotaDenied`, `finalizeAiGatewayUsageEvent`, `markStaleAiGatewayReservationsFailed`, `getAiGatewayDailyUsageTotals`, `getAiGatewayFeatureDailyTotals`, `listChatterUsageSummary`. |
| `ops-metrics.ts` | `insertOpsMetricSamples`, `pruneOpsMetricSamples` (deleter), `listRecentOpsMetricSamples`. |
| `config-settings.ts` | `getConfigOverrides`, `setConfigOverridesAtomic`, `applyConfigPatchesInTx`, `setConfigOverride`, `clearConfigOverride` (deleter), `listConfigAudit`. |
| `auth.ts` | User/session/apikey/devicetoken CRUD incl. `deleteExpiredAuthSessions` (deleter), `insertAuditEvent`, `revoke*` family. |
| `access-grants.ts` | `insertAccessGrant`, `revokeAccessGrants`, `listGrantsForUser`, `resolveGrantedPageAssignments`, `listModelsByIds`, `listPagesByIds`. |
| `transactions.ts` | `upsertTransaction`, `markTransactionsScanToken`, `rebuildRevenueRollups`, `rebuildFollowerRollups`, `rebuildSubscriberRollups`, `getRevenueBreakdown`, `retireTransactionsMissingFromWindow` (soft-retire), `countActiveInWindowTransactionsByScanToken`, `getOldestPendingTransactionAt`. |
| `catalog.ts` | Model/page create/update, `deleteModelBySlug`/`deletePageByLabel` (deleters), `deleteProxyConfig`, credential storage, `getPageBusinessFactPresence`, metadata. |
| `sync.ts` | Sync run lifecycle; `deleteExpiredRawPayloads`, `deleteExpiredSyncObservability` (30-day deleter), `deleteCheckpoints`, monitor queries. |
| `page-sync.ts` | Page sync scheduling/lease/state machine (~40 fns). |
| `page-dm.ts` | DM conversation/message upsert; `prunePageDmMessagesToLimit`/`deletePageDmMessageByPlatformMessageId`/reset (deleters), `getPageDmMessageRetentionLimit`. |
| `message-archive.ts` | Archive projection apply/rebuild/`resetMessageArchiveProjection`, `countArchiveCoverageGaps`, `backfillArchiveFrom*`, `upsertFanEarningsStat`, `listTopFanEarnings`. |
| `dm-message-archive.ts` | `upsertDmMessageArchive`, `tombstoneDmMessageArchive`, `deleteExpiredDmMessageArchiveRows` (deleter), status. |
| `dm-analytics.ts` | DM daily aggregates. |
| `fans.ts` | Fan/page/subscription/follow upsert & spend recompute (~30 fns). |
| `spenders.ts` | Spender projections, ranked/window/lifetime metrics, scope visibility (~30 fns). |
| `top-spenders.ts` | `upsertPageTopSpenders`, `deletePageTopSpenders` (deleter), aggregate. |
| `reporting.ts` | Revenue/subscriber/follower/transaction read models (~35 fns). |
| `workboard-v2.ts` | Workboard states, closing classifier, LLM usage, claims (~50 fns; incl. `deleteIneligibleWorkboardStates` deleter). |
| `ofapi.ts` | OFAPI webhook/credit-ledger/spend-projection (~65 fns; `deleteExpiredOfapiWebhookEvents` deleter). |
| `ofapi-commands.ts` | Command outbox lifecycle. |
| `ofapi-sync-snapshot.ts`, `onlyfans-public-profiles.ts`, `sync-context.ts`, `runtime-instances.ts` (`reapStaleInstances`), `notifications.ts`, `telegram-settings.ts`, `fan-page-identity.ts`, `fan-profiles.ts`, `fan-metadata.ts`, `egress.ts`, `search.ts` | Supporting read/write modules for their named domains. |
