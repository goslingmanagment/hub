> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Database Schema

This map describes the `core` kernel's Postgres 16 schema: how it is defined
(dual definition — raw SQL migrations are authoritative, the Drizzle mirror is
the query-layer type source), the global bigint type parser, the complete table
inventory grouped by domain, the enums, the money units carried per column, and
the monthly RANGE partitioning of the two append-only spines. It is descriptive:
every claim is anchored to `schema.ts` line numbers and the defining migration.

## Dual definition: SQL migrations authoritative, Drizzle a mirror

The schema is defined twice, deliberately, with one source of truth.

- **Authoritative:** raw SQL migrations under `packages/db/migrations/*.sql` —
  75 files, `0000`–`0074`. These are what actually shape the production
  database (applied by the forward-only runner; see
  `05-db-repositories-and-migrations.md`).
- **Query-layer mirror:** the Drizzle ORM typed schema in
  `packages/db/src/schema.ts` (~116 KB, 77 `pgTable` declarations). It exists
  to give the query layer TypeScript types and column references. It is **not**
  diffed to generate migrations and is **not** the source of truth — it is
  hand-kept in step with the SQL.

The Drizzle client wires the two together at `packages/db/src/client.ts:1-16`:
`drizzle(pool, { schema })` over a `pg.Pool`.

## Global bigint type parser

`packages/db/src/client.ts:6` installs
`pg.types.setTypeParser(20, (value) => BigInt(value))`. Postgres type OID 20 is
`int8`/`BIGINT`, so **every** BIGINT column — all the `_mills` money columns,
identity keys, `account_seq`, `value_ms`, etc. — is returned to JS as a native
`bigint`, not a `number` or `string`. This is what makes the mills money model
(below) safe from float rounding across the whole codebase.

## Money units per column

Three distinct unit systems coexist; they differ by factors of 10³ and are
never interchangeable:

| Unit | Encoding | Column suffix / example | Where |
|---|---|---|---|
| **mills** (1 mill = $0.001, thousandths of the currency unit) | `bigint` | `gross_amount_mills`, `creator_net_amount_mills`, `price_mills`, `tip_amount_mills`, `renew_price_mills` | platform money truth + all money projections |
| **micro-USD** (millionths of USD) | `integer` | `cost_micro_usd` | AI gateway spend (`ai_usage_events`) |
| **cents** | `integer` | credit-adjacent counters | OFAPI credit ledger uses whole-credit `integer`, not cents |

## Table inventory by domain

Anchors below are `schema.ts` line / defining migration.

### Catalog / identity (agency's own records — survive erasure)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `platforms` | 48 | 0068 | Platform reference (`onlyfans`, `fansly` keys). |
| `models` | 164 | 0000 | Model roster; `slug` unique; `sort_order` (0024). |
| `pages` | 182 | 0000 | Platform accounts; `label`, `external_page_id`, `ofapi_account_id`, `model_id`, `deleted_at` tombstone (0053); 38 CASCADE FKs later flipped to RESTRICT (0056). |
| `page_credentials` | 245 | 0000 | Per-page credentials. |
| `egress_endpoints` | 256 | 0000 | Proxy / egress config. |
| `users` | 172 | 0000 | `username` unique, `role` (`user_role` enum), `must_change_password` (0065). |
| `user_page_assignments` | 1550 | 0000 | Legacy page ACL (shadow read path). |
| `access_grants` | 1636 | 0065 | Append-only grant log (`scope_type` org/model/page, `revoked_at`) replacing hard-deleted assignments. |
| `auth_sessions` | 1568 | 0000 | Bearer session creds. |
| `api_keys` | 1588 | 0000 | API keys (`token_digest` unique, expiring). |
| `device_tokens` | 1610 | 0065 | Device bearer tokens. |
| `audit_events` | 1736 | 0000 | Dual-write audit sink (erasure records here). |

### Fans / identity graph (captured personal data — in erasure reach)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `fans` | 592 | 0000 | Captured identity; `platform` + `platform_user_id`. THE row deleted on fan erasure. |
| `fan_username_aliases` | 613 | 0000 | Username history. |
| `onlyfans_public_profile_resolutions` | 632 | 0010 | Public-profile resolution cache. |
| `page_fans` | 665 | 0000 | Fan↔page link (`platform_account_id`); external-presence cols (0002). |
| `page_fan_identities` | 1465 | 0000 | Per-page fan identity. |
| `page_fan_external_notes` | 710 | 0000 | External notes. |
| `page_fan_aliases` | 752 | 0000 | Per-page aliases. |
| `fan_notes` | 1762 | 0000 | Operator notes. |
| `fan_summaries` | 1783 | 0000 | Summaries. |
| `fan_profiles` | 1804 | 0000 | Profiles. |
| `fan_flags` | 1842 | 0000 | Flags. |
| `page_follows` | 779 | 0000 | Follow edges. |
| `page_subscriptions` | 815 | 0000 | Subscriptions; `price_mills`, `renew_price_mills` (bigint). |

### Money truth & projections (BIGINT mills)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `transactions` | 1285 | 0000 | Money truth ledger. `gross_amount_mills`, `source_destination_amount_mills`, `creator_net_amount_mills`, `new_balance_mills` (all bigint); `canonical_type`/`transaction_state` enums; `is_active`/`inactive_reason` soft-retire; `UNIQUE(platform_account_id, transaction_id)`. Added: `scan_token` (0001), provenance (0055), `platform_fee_mills`/`vat_amount_mills`/`tax_amount_mills` (0063). Fan erasure **anonymizes**, never deletes. |
| `revenue_daily` | 1362 | 0000 | `gross_amount_mills`, `creator_net_amount_mills` rollup. |
| `fan_spend_daily` | 1393 | 0000 | Spender projection (mills). |
| `fan_spend_lifetime` | 1437 | 0000 | Lifetime spender projection (mills). |
| `fan_earnings_stats` | 2642 region | 0061 | Per-fan Fansly earnings projection; `gross_mills`/`net_mills` bigint; FKs `account_id`→pages, `fan_id`→fans **ON DELETE RESTRICT** (0061:6-7) — must be cleared before the fans row. |
| `daily_followers` | 1510 | 0000 | Follower rollup. |
| `daily_subscribers` | 1530 | 0000 | Subscriber rollup. |

### Capture spine — observations (Stage 7, partitioned)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `observations` | 2460 | 0054 | Universal append-only journal, `PARTITION BY RANGE(received_at)` monthly (0054:9-27). PK `(id, received_at)`; `id bigint GENERATED ALWAYS AS IDENTITY`; `source` CHECK in (`webhook`, `pull`, `client_capture`, `readthrough`, `command_result`, `operator`); `payload jsonb`, `payload_hash bytea`, `idempotency_key`, `parse_version`. **No FK on `account_id` by design.** Partitions `observations_2026_01..12` seeded (0054:49-60). |
| `observation_keys` | 2492 | 0054 | Unpartitioned dedup companion; PK `(source, idempotency_key)`; ON CONFLICT DO NOTHING = duplicate signal (`repositories/observations.ts:54-68`). |

### Derived events — domain_events (Stage 8, partitioned, gapless)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `domain_events` | 2509 | 0057 | Canonical event log, `PARTITION BY RANGE(occurred_at)` monthly (0057:12-29). PK `(id, occurred_at)`; `account_seq bigint` gapless per account; `dedup_key`, `observation_id`, `schema_version`. Partitions `domain_events_pre_2024` MINVALUE catch-all + `2024_01`…`2026_12` (0057:56-93). |
| `domain_event_keys` | 2537 | 0057 | Cross-producer dedup companion; PK `(account_id, dedup_key)` = content-hash dedup (`repositories/domain-events.ts:71-80`). |
| `domain_event_seq` | 2550 | 0057 | Per-account counter `next_seq`, taken **FOR UPDATE** for the whole batch → serial gapless assignment (`domain-events.ts:52-122`). Emits `pg_notify('domain_events_appended', …)` on commit (`domain-events.ts:115-125`). |
| `domain_events_smoke_checkpoint` | — | 0064 | Replay-smoke watermark. |

### Projection bookkeeping

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `projection_watermarks` | 1498 | 0000 | Projection cursors. |
| `projection_seq_watermarks` | 2607 | 0059 | Per-seq projection cursors. |
| `message_archive` | 2560 | 0059 | Cold message archive; `price_mills`, `tip_amount_mills` bigint; prune-coverage authority (`countArchiveCoverageGaps`). |

### AI spend & restricted class (micro-USD)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `ai_usage_events` | 1657 | 0003 | AI gateway ledger. `cost_micro_usd integer DEFAULT 0 NOT NULL CHECK >= 0` (micro-USD, 0040:9,24-25); `provider` CHECK in (`anthropic`, `openrouter`) (0040:31-36); `gateway_outcome` CHECK (`completed`, `failed`, `cancelled`, `quota_denied`); `page_id` FK SET NULL; `user_id` nullable = system lane (0074:45). Feature scan (0004). |
| `ai_generation_content` | 2642 | 0072 | Stage 29 DP-6A restricted capture: `prompt_blocks jsonb` VERBATIM, `completion text`, `params jsonb`, `generation_ref` UNIQUE, FK `usage_event_id` ON DELETE RESTRICT. Owner-only, lake-excluded, erasure-reachable. |
| `ai_acceptance_events` | 2674 | 0072 | Lifecycle correlated by `generation_ref`; CHECK lifecycle in (`shown`, `copied`, `inserted`, `edited`, `sent`) — `copied` added 0074. |
| `ai_personas` | 2621 | 0073 | Stage 30 kernel config records; `key` unique, `system_block`, `feature_overrides jsonb`, `archived_at` soft-retire (never hard-deleted). |
| `wb_llm_usage_daily` | 2107 | 0020 | Workboard classifier LLM spend counter. |

### Config

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `config_settings` | 2383 | 0035 | Per-key override overlay over env defaults; `UNIQUE(scope_type, scope_id, key)`; only `scope_type='global', scope_id=0` used today. |
| `config_audit_log` | 2411 | 0035 | Append-only change trail; shared `group_id uuid` per multi-key patch, old/new value + version. |

### OFAPI (OnlyFans API vendor) — credit ledger & outbox

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `ofapi_credit_ledger` | 2187 | 0031 | Append-only credit movement; `credits integer` (positive=spent, negative=added); `source` CHECK in (`rest`, `webhook_accrual`, `external`, `refill`, `adjustment`) (0031:26-28); partial-unique `accrual_day` for `webhook_accrual` (0031:38); actor col (0058). |
| `ofapi_credit_state` | 2147 | 0029 | Fast day-counter + reconciliation cursor. |
| `ofapi_commands` | 1113 | 0038 | Command outbox (typing/unsend/mark-read/send-media 0043–0046); execution (0039), payload redaction (0041). |
| `ofapi_webhook_config` | 2131 | 0027 | Webhook receiver config. |
| `ofapi_webhook_events` | 2299 | 0027 | Webhook journal. |
| `ofapi_spend_projection_events` | 2232 | 0036 | Shadow spend projection; `gross_amount_mills`, `creator_net_amount_mills`. |

### DM archive / analytics

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `page_dm_threads` | 866 | 0000 | `stored_message_count` CHECK 0–1000 (0026; was 0–500 in 0025). |
| `page_dm_messages` | 952 | 0000 | Hot DM cache (prune target). |
| `dm_message_archive` | 1003 | 0037 | Cold archive; `price_mills`, `tip_amount_mills` bigint; archive status (0047), tombstones (0048). |
| `dm_message_daily_aggregates` | 1067 | 0042 | `paid_outbound_price_mills`, `tip_amount_mills` bigint. |

### Sync engine / ops

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `sync_runs` | 343 | 0000 | `stats jsonb NOT NULL DEFAULT '{}'` (guarded by the runtime schema guard). |
| `sync_run_events` | 421 | 0000 | Per-run event trail. |
| `sync_http_attempts` | 375 | 0000 | HTTP attempt trail. |
| `sync_raw_payloads` | 564 | 0000 | Raw payload store; `retain_until`. |
| `sync_rate_limits` | 541 | 0000 | Rate-limit state. |
| `page_sync_states` | 453 | 0000 | Per-page sync state. |
| `page_sync_cursors` | 516 | 0000 | Per-page cursors. |
| `runtime_instances` | 2358 | 0034 | Heartbeat / leader election. |
| `ops_metric_samples` | 1221 | 0067 | Golden-signal p50/p95 (`value_ms bigint`, `quantile`), minutely. |
| `notification_incidents` | 270 | 0000 | Incident records. |
| `notification_incident_recoveries` | 301 | 0018 | Recovery records; `notification_incident_kind` enum extended by `observations_partitions` (0054), `ofapi_burn_rate` (0031), `golden_signal_lag` (0067). |
| `telegram_settings` | 308 | 0000 | Telegram config. |
| `telegram_delivery_attempts` | 322 | 0000 | Delivery trail. |

### Workboard (v2)

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `workboard_state` | 1915 | 0019 | Per-thread workboard state. |
| `workboard_contact_log` | 1987 | 0019 | Contact log; `retracted_at` marker (0053). |
| `workboard_snoozes` | 1256 | 0000 | Snooze records. |
| `workboard_claim_leases` | 1230 | 0066 | Claim leases. |
| `wb_closing_cache` | 2036 | 0020 | Closing classifier cache; `superseded_at` partial-unique (0053). |
| `wb_closing_settings` | 2068 | 0022 | Closing classifier settings. |
| `wb_classifier_runs` | 2080 | 0023 | Classifier run trail. |

### Erasure audit

| Table | schema.ts | Migration | Notes |
|---|---|---|---|
| `erasure_log` | 2700 | 0071 | Stage 28.4 tombstone: `scope_type` CHECK (`page`, `model`, `fan`), `scope_ref`, `initiated_by` FK→users, `dry_run bool`, `plan jsonb`, `executed_counts jsonb` (NULL until complete), `started_at`/`completed_at`. NULL `completed_at` on an executed run = mid-flight death; re-run to converge (0071:1-19). |

## Enums

The schema declares 23 `pgEnum` types. They include: platform / catalog enums
(`user_role`); the money-truth state enums on `transactions` (`canonical_type`,
`transaction_state`); the incident enum `notification_incident_kind` (extended
across 0031/0054/0067). Several fixed-value domains that could have been enums
are instead expressed as `CHECK … in (…)` constraints rather than Postgres
enum types — notably `observations.source`, `domain`/AI provider and
`gateway_outcome` on `ai_usage_events`, `ai_acceptance_events.lifecycle`,
`ofapi_credit_ledger.source`, and `erasure_log.scope_type` — so their allowed
values live in the migration CHECK clauses noted in the inventory above.

## Partitioning of the two append-only spines

Both spines are declared `PARTITION BY RANGE`, monthly, and are the only tables
tiered off to the lake (see `18-retention-erasure-tiering.md`):

- **`observations`** — `PARTITION BY RANGE(received_at)` (0054:9-27). Child
  partitions `observations_<YYYY>_<MM>` (zero-padded). 2026 partitions
  `observations_2026_01..12` are seeded in 0054:49-60; new months are
  pre-created daily by the partition manager.
- **`domain_events`** — `PARTITION BY RANGE(occurred_at)` (0057:12-29). Child
  partitions `domain_events_<YYYY>_<MM>`, plus a `domain_events_pre_2024`
  MINVALUE catch-all and `2024_01`…`2026_12` (0057:56-93).

An insert that targets a month with no matching partition fails loudly rather
than silently dropping — for webhook ingestion this surfaces as a 5xx that the
vendor retries.

## Naming trap: `platform_account_id`

Several child tables (e.g. `page_fans`, `transactions`) carry a column named
`platform_account_id`. Despite the name, it does **not** hold the platform's
external account identifier — it is the FK to the **internal** `pages.id`
surrogate key. The external identifier is a separate column
(`pages.external_page_id` / `pages.ofapi_account_id`). Filtering
`platform_account_id` by a platform-supplied id will not match.
