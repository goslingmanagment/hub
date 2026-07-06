> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 04 — Database Schema (Postgres storage boundary)

**Scope.** This document covers the entire Drizzle-ORM schema definition in `packages/db/src/schema.ts` (2253 lines) — every `pgEnum`, every `pgTable`, and all imported enum value lists / JSON types it depends on (`packages/shared/src/types.ts:104-122` for `userRoles`/`fanFlagTypes`/`aiUsageFeatures`; `packages/shared/src/config-registry.ts:44,252` for `ConfigOverrideValue`/`RunningSnapshot`). It is the definitive shape of everything the `core` backend persists in Postgres. Repository/query logic that reads and writes these tables is territory 05 and is not documented here. One SQL sequence referenced by the schema (`ofapi_webhook_events_fanout_seq`, created in `packages/db/migrations/0027_ofapi_webhook_receiver.sql:26`) is noted where relevant. This is a single physical schema (no multi-tenant table partitioning); all tables live in the default `public` schema.

---

## 0. Conventions used across the schema

- **No Drizzle `relations()` graph.** The file declares foreign keys via `.references(...)` and `foreignKey({...})` only; there is no `relations()` ORM helper. All join semantics live in repositories (territory 05).
- **Surrogate keys.** Most tables use `bigserial("id", { mode: "number" }).primaryKey()` — an auto-increment bigint surfaced to JS as a `number`. Some tables are keyed by natural composite PKs instead (see each table). `ofapi_commands.id` and two config columns are `uuid`.
- **Timestamps.** All `timestamp(..., { withTimezone: true })` → Postgres `timestamptz`. `defaultNow()` = `now()` default. `date(...)` columns (business-date rollups) are timezone-less calendar dates.
- **Money = mills.** Monetary columns are `bigint(..., { mode: "bigint" })` named `*_mills` and carry JS `BigInt`. 1 mill = $0.001. AI cost is the exception: `ai_usage_events.cost_micro_usd` is an `integer` in micro-USD (1e-6 USD).
- **`platform_account_id` is overloaded — read carefully.** In **child** tables the `bigint` column `platform_account_id` is an FK to the internal `pages.id` surrogate (i.e. "the page"). But on the `pages` table itself, the TS property `platformAccountId` maps to DB column **`external_page_id`** (`text`, the OnlyMonster-sourced external platform id) and is **not** an FK. Same TS name, two meanings. This doc always names the DB column to disambiguate.
- **`platform` vs `provider`.** Both are the same `platform` enum (`fansly` | `onlyfans`); some tables call the column `provider`.
- **Generation counters.** Several fan-facing projection tables carry `last_seen_generation` (a bigint written by full-sweep syncs) used to detect rows absent from the latest sweep. No DB-level generated/identity columns are used except the `bigserial` PKs and the external `ofapi_webhook_events_fanout_seq` sequence.
- **Aliased exports (lines 1711-1719).** Nine tables are re-exported under second names for caller ergonomics — **no new tables**: `fanPages`=`page_fans`, `fanPageExternalNotes`=`page_fan_external_notes`, `fanPageAliases`=`page_fan_aliases`, `pageDmConversations`=`page_dm_threads`, `dailyRevenue`=`revenue_daily`, `spenderDailyFacts`=`fan_spend_daily`, `spenderLifetimePage`=`fan_spend_lifetime`, `spenderProjectionWatermarks`=`projection_watermarks`, `pageTopSpenders`=`page_fan_identities`.

---

## 1. Enum catalog (`pgEnum`)

| Enum (SQL name) | Values | Used by |
| --- | --- | --- |
| `platform` | `fansly`, `onlyfans` | `pages.platform`, and every `platform`/`provider` column |
| `sync_run_outcome` | `running`, `succeeded`, `partial`, `failed`, `skipped` | `sync_runs.outcome` |
| `sync_stream` | `light`, `fan_identities`, `followers`, `transactions`, `top_spenders`, `subscribers`, `dm_conversations`, `dm_messages`, `followers_reconcile` | sync runs/states/cursors/events/http-attempts/raw-payloads, `notification_incidents.stream` |
| `page_sync_status` | `idle`, `pending`, `running`, `retrying`, `blocked`, `paused` | `page_sync_states.status` |
| `sync_request_source` | `scheduled`, `manual`, `onboarding`, `recovery`, `anomaly`, `reset` | `.source`/`.request_source` on sync tables |
| `sync_work_class` | `live`, `history`, `maintenance` | `page_sync_states.work_class` |
| `sync_http_attempt_state` | `started`, `success`, `retry`, `failed` | `sync_http_attempts.state` |
| `sync_http_failure_kind` | `timeout`, `transport`, `http`, `provider` | `sync_http_attempts.failure_kind` |
| `sync_event_severity` | `info`, `warn`, `error` | `sync_run_events.severity` |
| `transaction_type` | `subscription`, `tip`, `message_purchase`, `post_purchase`, `stream_tip`, `chargeback`, `refund`, `payout_reversal`, `other` | `transactions`, `revenue_daily`, `fan_spend_daily` `canonical_type` |
| `transaction_state` | `pending`, `posted`, `unknown` | `transactions`, `revenue_daily`, `fan_spend_daily` `transaction_state` |
| `user_role` | `owner`, `team_lead`, `chatter`, `content_manager` | `users.role` (from `@agency_hub_core/shared`) |
| `fan_flag` | `whale`, `vip`, `risky` | `fan_flags.flag` (from shared) |
| `ai_usage_feature` | `fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `scan`, `ping`, `hi-greeting` | `ai_usage_events.feature` (from shared) |
| `dm_sender_role` | `fan`, `model`, `system`, `unknown` | dm threads/messages/archive sender-role columns |
| `dm_message_coverage_status` | `pending_backfill`, `partial_window`, `complete` | `page_dm_threads.message_coverage_status`, `workboard_state.best_coverage_seen` |
| `transaction_inactive_reason` | `missing_from_sync_window` | `transactions.inactive_reason` |
| `notification_incident_kind` | `auth_blocked`, `proxy_failed`, `stream_failed_threshold`, `ofapi_auth`, `ofapi_low_credit`, `ofapi_webhook_silence`, `ofapi_burn_rate` | `notification_incidents.kind` |
| `notification_incident_status` | `open`, `resolved` | `notification_incidents.status` |
| `workboard_tab` | `subscribers`, `spenders`, `fresh_mass`, `old_mass`, `service` | `workboard_state.tab` |
| `workboard_mass_substate` | `fresh`, `gray`, `active`, `dead`, `archived` | `workboard_state.mass_substate` |
| `workboard_secondary_status` | `recent_purchase`, `need_reply`, `due_now`, `later`, `dont_touch_today` | `workboard_state.secondary_status` |
| `workboard_freeloader_status` | `none`, `cooling`, `freeloader`, `ceiling` | `workboard_state.freeloader_status` |
| `workboard_contact_action` | `opened`, `handled`, `snoozed` | `workboard_contact_log.action` |

**Enum values that are `text` + CHECK, not `pgEnum`** (allowed values enforced by a check constraint, catalogued at each table): `ofapi_commands.kind`/`.state`, `dm_message_archive.source`/`.source_event_type`, `ofapi_spend_projection_events.projection_status`/`.source_event_type`/`.category`/`.currency`/`.event_status`, `onlyfans_public_profile_resolutions.status`, `ofapi_webhook_events.archive_status`. Several other `text` "status" columns (`ofapi_webhook_events.status`/`.projection_status`, `ofapi_credit_ledger.source`) are free-form with **no** DB check (see discrepancies).

---

## 2. Identity: models, users, pages, credentials, egress

### `models`
Person who may own several pages.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| slug | text | not null | **unique** |
| name | text | not null | |
| sort_order | integer | default 0, not null | |
| created_at | timestamptz | default now() | |

### `users`
Dashboard/API accounts (owners, team leads, chatters, content managers).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| username | text | not null | **unique** |
| role | `user_role` enum | not null | |
| password_hash | text | nullable | null for keyless/SSO-only users |
| created_at / updated_at | timestamptz | default now() | |

### `pages`
A creator account on one platform. Central table; nearly every domain table FKs to `pages.id`.

| Column (DB) | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | the internal "page" id every `platform_account_id` FK points at |
| model_id | bigint | not null | **FK → models.id ON DELETE CASCADE** |
| platform | `platform` enum | not null | |
| commission_rate | numeric(5,4), mode number | default 0, not null | agency commission fraction |
| label | text | not null | **unique** |
| external_page_id | text | nullable | TS prop `platformAccountId`; OnlyMonster-sourced external platform id (NOT `pages.id`) |
| ofapi_account_id | text | nullable | onlyfansapi.com account id `acct_…` delivering webhooks; **unique** (`pages_ofapi_account_uniq`) |
| ofapi_auth_status | text | nullable | latest `accounts.*` webhook suffix (e.g. `connected`/`authentication_failed`), forward-only |
| ofapi_auth_changed_at | timestamptz | nullable | |
| username / display_name | text | nullable | |
| follower_count / subscriber_count | integer | nullable | |
| egress_endpoint_id | bigint, mode number | nullable | **plain column, NO FK** despite the name (see discrepancies) |
| earnings_balance_mills | bigint (BigInt) | default 0, not null | |
| metadata | jsonb `Record<string,unknown>` | default `{}` | |
| last_verified_at / last_light_sync_at / last_follower_sync_at | timestamptz | nullable | |
| created_at / updated_at | timestamptz | default now() | |

- **Unique:** `label`; `pages_platform_external_id_uniq (platform, external_page_id)`; `pages_ofapi_account_uniq (ofapi_account_id)`.
- **Index:** `pages_model_idx (model_id)`.

### `page_credentials`
Encrypted platform session for a page.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null, **unique** | **FK → pages.id CASCADE** (one row per page) |
| encrypted_session | text | not null | encrypted credential envelope (secret) |
| key_version | integer | not null | encryption key generation |
| updated_at | timestamptz | default now() | |

### `egress_endpoints`
Outbound proxy/egress config per page (used to route platform HTTP through per-page proxies).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null, **unique** | **FK → pages.id CASCADE** |
| kind | text | default `'proxy'`, not null | |
| url | text | not null | proxy URL |
| encrypted_auth | text | nullable | encrypted proxy credentials (secret) |
| key_version | integer | nullable | |
| rate_limit_scope_key | text | nullable | ties egress to a `sync_rate_limits` bucket |
| updated_at | timestamptz | default now() | |

---

## 3. Notifications & Telegram

### `notification_incidents`
Open/resolved operational incidents surfaced to alerting.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| incident_key | text | not null, **unique** | dedupe key |
| kind | `notification_incident_kind` enum | not null | |
| platform_account_id | bigint | nullable | **FK → pages.id CASCADE**; null for account-global OFAPI incidents (low credit / webhook silence) |
| stream | `sync_stream` enum | nullable | |
| status | `notification_incident_status` enum | default `open`, not null | |
| opened_at / last_seen_at | timestamptz | default now() | |
| resolved_at | timestamptz | nullable | |
| error_code / error_summary | text | nullable | |
| metadata | jsonb | default `{}` | |
| updated_at | timestamptz | default now() | |

- **Indexes:** `(platform_account_id, status)`, `(status, last_seen_at)`.

### `notification_incident_recoveries`
Records when an incident key recovered (keyed by `incident_key` text PK).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| incident_key | text | PK | |
| recovered_at | timestamptz | not null | |
| metadata | jsonb | default `{}` | |
| updated_at | timestamptz | default now() | |

### `telegram_settings`
Singleton (id defaults to 1) holding the Telegram bot credentials and alert flags. **Boundary: Telegram.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | integer | PK default 1 | singleton |
| enabled | boolean | default true | |
| daily_report_enabled | boolean | default true | |
| sync_failure_alerts_enabled | boolean | default true | |
| report_hour_utc | integer | default 9 | |
| encrypted_bot_token | text | nullable | encrypted (secret) |
| chat_id | text | nullable | target Telegram chat |
| updated_at | timestamptz | default now() | |
| credentials_updated_at | timestamptz | default now() | bumped only when token/chat change |

### `telegram_delivery_attempts`
Log of outbound Telegram sends (daily report + incident alerts). **Boundary: Telegram outbound.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| kind | text | not null | e.g. report vs alert |
| status | text | not null | |
| notification_incident_id | bigint | nullable | **FK → notification_incidents.id ON DELETE SET NULL** |
| report_date | text | nullable | |
| message_id | integer | nullable | Telegram message id returned |
| error | text | nullable | |
| created_at | timestamptz | default now() | |

- **Index:** `(kind, created_at)`.

---

## 4. Sync runs, states, cursors, rate-limits, raw payloads

These tables drive the pg-boss worker's per-page-per-stream sync engine (pulling OnlyFans via OFAPI and Fansly directly). A `sync_run` is one execution; `page_sync_states` is the durable FSM per (page, stream); `page_sync_cursors` stores pagination position.

### `sync_runs`

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| page_id | bigint | not null | **FK → pages.id CASCADE** |
| request_seq / leased_seq | bigint (number) | nullable | request ordering / lease sequence |
| source | `sync_request_source` enum | nullable | |
| lease_token | text | nullable | |
| stream | `sync_stream` enum | not null | |
| outcome | `sync_run_outcome` enum | not null | |
| error_summary | text | nullable | |
| stats | jsonb | default `{}` | |
| started_at | timestamptz | default now() | |
| finished_at | timestamptz | nullable | |

- **Unique:** `sync_runs_id_page_stream_uniq (id, page_id, stream)` — target of composite FKs from http-attempts and run-events.
- **Index:** `(page_id, stream, started_at)`.

### `sync_http_attempts`
Per-HTTP-request telemetry inside a sync run (outbound calls to OFAPI / Fansly).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| sync_run_id | bigint | not null | **FK → sync_runs.id CASCADE** |
| page_id | bigint | not null | **FK → pages.id CASCADE** |
| request_seq | bigint | nullable | |
| source | `sync_request_source` | nullable | |
| provider | `platform` enum | not null | which upstream API |
| stream | `sync_stream` enum | not null | |
| operation | text | not null | logical API operation |
| logical_request_id | text | not null | |
| attempt_number | integer | not null | |
| state | `sync_http_attempt_state` enum | not null | |
| failure_kind | `sync_http_failure_kind` enum | nullable | |
| http_status | integer | nullable | upstream HTTP status |
| retry_delay_ms / duration_ms | integer | nullable | |
| request_shape / response_shape | jsonb | default `{}` | redacted shapes, not full payloads |
| error_message | text | nullable | |
| started_at | timestamptz | default now() | |
| finished_at | timestamptz | nullable | |

- **Indexes:** `(sync_run_id, started_at)`, `(sync_run_id, logical_request_id, attempt_number)`, `retention_idx(started_at)`.
- **Composite FK:** `sync_http_attempts_run_page_stream_fk (sync_run_id, page_id, stream) → sync_runs(id, page_id, stream) CASCADE`.

### `sync_run_events`
Structured event log emitted during a run (info/warn/error).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| sync_run_id | bigint | not null | **FK → sync_runs.id CASCADE** |
| page_id | bigint | not null | **FK → pages.id CASCADE** |
| request_seq | bigint | nullable | |
| source | `sync_request_source` | nullable | |
| lease_token | text | nullable | |
| provider | `platform` enum | not null | |
| stream | `sync_stream` enum | not null | |
| event_type | text | not null | |
| severity | `sync_event_severity` enum | not null | |
| message | text | not null | |
| details | jsonb | default `{}` | |
| emitted_at | timestamptz | default now() | |

- **Indexes:** `(sync_run_id, emitted_at)`, `(emitted_at)`.
- **Composite FK:** `sync_run_events_run_page_stream_fk (sync_run_id, page_id, stream) → sync_runs(id, page_id, stream) CASCADE`.

### `page_sync_states`
Durable FSM: **one row per (page_id, stream)** — composite PK. Holds status, lease, retry/blocker state, cadence scheduling.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| page_id | bigint | not null | **FK → pages.id CASCADE**, part of PK |
| stream | `sync_stream` enum | not null | part of PK |
| status | `page_sync_status` enum | default `idle`, not null | |
| request_seq | bigint | default 0, not null | |
| leased_seq | bigint | nullable | |
| applied_seq | bigint | default 0, not null | |
| request_source | `sync_request_source` enum | nullable | |
| request_payload | jsonb | default `{}` | |
| requested_at / enqueued_at / started_at / progressed_at / finished_at / succeeded_at / failed_at | timestamptz | nullable | lifecycle timestamps |
| retry_kind | text | nullable | |
| retry_at | timestamptz | nullable | |
| blocker_kind / blocker_code / blocker_message | text | nullable | why blocked |
| blocked_at | timestamptz | nullable | |
| phase | text | nullable | |
| work_class | `sync_work_class` enum | nullable | live/history/maintenance |
| progress | jsonb | default `{}` | |
| cadence_seconds | integer | not null | schedule interval |
| slot_offset_seconds | integer | not null | schedule jitter offset |
| last_scheduled_slot | bigint | default -1, not null | |
| lease_owner / lease_token | text | nullable | worker lease holder |
| lease_heartbeat_at / lease_expires_at | timestamptz | nullable | |
| consecutive_failures | integer | default 0, not null | |
| last_error_code / last_error_summary | text | nullable | |
| created_at / updated_at | timestamptz | default now() | |

- **PK:** `(page_id, stream)`.
- **Indexes:** `freshness(stream, succeeded_at)`, `lease(status, lease_expires_at)`, `runnable(status, retry_at, page_id, stream)`, `schedule(status, last_scheduled_slot, page_id, stream)`.

### `page_sync_cursors`
Pagination cursor per (page, stream). Composite PK.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| page_id | bigint | not null | **FK → pages.id CASCADE**, part of PK |
| stream | `sync_stream` enum | not null | part of PK |
| cursor_text | text | nullable | opaque cursor token |
| cursor_timestamp | timestamptz | nullable | |
| cursor_seq | bigint | nullable | |
| state | jsonb | default `{}` | |
| updated_at | timestamptz | default now() | |
| last_succeeded_run_id | bigint | nullable | **FK → sync_runs.id SET NULL** |
| last_succeeded_at | timestamptz | nullable | |

- **PK:** `(page_id, stream)`.

### `sync_rate_limits`
Token-bucket spacing per (provider, scope, egress key). Composite PK, no surrogate id.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| provider | `platform` enum | not null | part of PK |
| scope | text | not null | part of PK |
| egress_key | text | not null | part of PK (matches `egress_endpoints.rate_limit_scope_key`) |
| min_spacing_ms | integer | not null | |
| next_available_at | timestamptz | default now() | earliest next call |
| updated_at | timestamptz | default now() | |

- **PK:** `(provider, scope, egress_key)`.

### `sync_raw_payloads`
Captured raw upstream responses (debugging / reprocessing), TTL-pruned via `retain_until`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| page_id | bigint | not null | **FK → pages.id CASCADE** |
| sync_run_id | bigint | nullable | **FK → sync_runs.id SET NULL** |
| stream | `sync_stream` enum | nullable | |
| request_seq | bigint | nullable | |
| source | `sync_request_source` enum | nullable | |
| endpoint | text | not null | upstream endpoint |
| request_params | jsonb | default `{}` | |
| response_payload | jsonb `unknown` | not null | full raw response body |
| mapper_version | text | not null | |
| payload_kind | text | not null | |
| status_code | integer | nullable | |
| error_message | text | nullable | |
| captured_at | timestamptz | default now() | |
| retain_until | timestamptz | not null | retention TTL |

- **Index:** `retain_idx(retain_until)`.

---

## 5. Fans: identities, aliases, notes, profiles, flags, summaries

### `fans`
Global subscriber/payer identity, unique per (platform, platform_user_id). Not scoped to a page.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform | `platform` enum | not null | |
| platform_user_id | text | not null | external user id |
| username / display_name | text | nullable | |
| created_at_external | timestamptz | nullable | |
| metadata | jsonb | default `{}` | |
| first_seen_at / last_seen_at | timestamptz | default now() | |
| deleted_detected_at / deleted_last_detected_at | timestamptz | nullable | soft-delete detection |

- **Unique:** `fans_platform_user_uniq (platform, platform_user_id)`.
- **Index:** `(platform, deleted_detected_at)`.

### `fan_username_aliases`
Username history per fan. Composite PK `(fan_id, username)`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| fan_id | bigint | not null | **FK → fans.id CASCADE**, part of PK |
| username | text | not null | part of PK |
| first_seen_at / last_seen_at | timestamptz | not null | |

- **Index:** `(username)`.

### `onlyfans_public_profile_resolutions`
Backfill state for resolving OF fan usernames via public profile lookups. PK = `fan_id`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| fan_id | bigint | PK | **FK → fans.id CASCADE** |
| platform_user_id | text | not null | **unique** |
| status | text | not null | CHECK ∈ `resolved`,`not_found`,`unavailable`,`failed`,`rate_limited` |
| username / display_name | text | nullable | resolved values |
| attempt_count | integer | default 0 | |
| last_attempted_at / resolved_at / next_attempt_after | timestamptz | nullable | |
| last_error | text | nullable | |
| created_at / updated_at | timestamptz | default now() | |

- **Index:** `next_attempt_idx(next_attempt_after)`.

### `page_fans` (aliased `fanPages`)
Fan ↔ page relationship: the per-page presence/subscription/alias/spend rollup for one fan.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| total_creator_net_mills | bigint (BigInt) | default 0 | |
| currency | text | default `'USD'` | |
| is_follower | boolean | default false | |
| follower_since | timestamptz | nullable | |
| is_subscriber | boolean | default false | |
| subscriber_since / subscription_expires_at | timestamptz | nullable | |
| auto_renew | boolean | nullable | |
| auto_renew_off_detected_at | timestamptz | nullable | |
| page_alias / page_alias_source / page_alias_source_note_id | text | nullable | chatter-facing alias for this fan on this page |
| page_alias_synced_at | timestamptz | nullable | |
| last_transaction_at | timestamptz | nullable | |
| external_presence_at / external_presence_observed_at / external_presence_source | ts / ts / text | nullable | last known presence on platform |
| last_seen_at | timestamptz | default now() | |

- **Unique:** `page_fans_fan_account_uniq (fan_id, platform_account_id)`.
- **Indexes:** `(platform_account_id)`, `(platform_account_id, external_presence_at)`, `(platform_account_id, page_alias)`.

### `page_fan_external_notes` (aliased `fanPageExternalNotes`)
Notes attached to a fan *on the platform itself* (OF/Fansly "notes"), synced in.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| provider | `platform` enum | not null | |
| external_note_id | text | not null | |
| content_type | integer | nullable | |
| title / body | text | nullable | note text |
| created_at_external / updated_at_external | timestamptz | nullable | |
| is_active | boolean | default true | |
| first_seen_at / last_seen_at | timestamptz | default now() | |
| raw | jsonb | default `{}` | |

- **Unique:** `(platform_account_id, provider, external_note_id)`.
- **Indexes:** `(platform_account_id, fan_id, provider)`, `(platform_account_id, fan_id, provider, is_active)`.

### `page_fan_aliases` (aliased `fanPageAliases`)
Alias history per (page, fan). Composite PK `(platform_account_id, fan_id, alias)`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| fan_id | bigint | not null | **FK → fans.id CASCADE**, PK part |
| alias | text | not null | PK part |
| source_note_id | text | nullable | |
| first_seen_at / last_seen_at | timestamptz | not null | |

- **Indexes:** `(platform_account_id, alias)`, `(fan_id)`.

### `fan_notes`
Free-text internal notes authored by dashboard users about a fan on a page.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| author_user_id | bigint | nullable | **FK → users.id SET NULL** |
| body | text | not null | |
| created_at | timestamptz | default now() | |

- **Index:** `(fan_id, platform_account_id, created_at)`.

### `fan_summaries`
Same shape as `fan_notes` — internal summary text per (fan, page).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| author_user_id | bigint | nullable | **FK → users.id SET NULL** |
| body | text | not null | |
| created_at | timestamptz | default now() | |

- **Index:** `(fan_id, platform_account_id, created_at)`.

### `fan_profiles`
Versioned generated profile of a fan per page (AI/manual). One row per version.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| version | integer | not null | CHECK `> 0` |
| body | text | not null | profile text |
| source | text | not null | how it was produced |
| created_by_user_id | bigint | nullable | **FK → users.id SET NULL** |
| created_at | timestamptz | default now() | |

- **Unique:** `(fan_id, platform_account_id, version)`.
- **Indexes:** latest `(platform_account_id, fan_id, version desc)`, history `(fan_id, platform_account_id, created_at desc)`.

### `fan_flags`
Tags (`whale`/`vip`/`risky`) on a fan (global, not page-scoped).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| flag | `fan_flag` enum | not null | |
| created_by_user_id | bigint | nullable | **FK → users.id SET NULL** |
| created_at | timestamptz | default now() | |

- **Unique:** `(fan_id, flag)`. **Index:** `(fan_id, created_at)`.

---

## 6. Follows & subscriptions

### `page_follows`
A fan following a page (free follower). Generation-swept.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_follow_id | text | not null | |
| followed_at | timestamptz | not null | |
| first_seen_at / last_seen_at | timestamptz | default now() | |
| last_seen_generation | bigint | nullable | full-sweep marker |
| is_active | boolean | default true | |

- **Unique:** `(platform_account_id, platform_follow_id)`.
- **Indexes:** `(fan_id)`, `(platform_account_id, last_seen_generation)`, `(platform_account_id, is_active, followed_at, id)`.

### `page_subscriptions`
A fan's subscription record on a page (paid), incl. tier/pricing/renewal.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_subscription_id | text | not null | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| platform_history_id | text | nullable | |
| subscription_tier_id / _name / _color | text | nullable | |
| plan_id | text | nullable | |
| raw_status | integer | not null | platform-native status code |
| canonical_status | text | not null | normalized status |
| price_mills / renew_price_mills | bigint (BigInt) | not null | |
| auto_renew | boolean | nullable | |
| auto_renew_off_detected_at | timestamptz | nullable | |
| billing_cycle_days / duration_days | integer | nullable | |
| renew_date / source_created_at / source_updated_at / ends_at | timestamptz | nullable | |
| is_current | boolean | default true | |
| last_seen_generation | bigint | nullable | |
| last_seen_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, platform_subscription_id)`.
- **Indexes:** `(platform_account_id, ends_at)`, `(platform_account_id, last_seen_generation)`, `(platform_account_id, is_current, ends_at, id)`.

---

## 7. DM threads, messages, archive, aggregates

The live DM cache (`page_dm_threads` + `page_dm_messages`) is intentionally shallow (stored message count capped at 1000; see CHECK). `dm_message_archive` is the durable, richer message store fed by OFAPI webhooks/commands; `dm_message_daily_aggregates` are text-free rollups.

### `page_dm_threads` (aliased `pageDmConversations`)
One conversation between a page and a fan.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | nullable | **FK → fans.id SET NULL** |
| platform_conversation_id | text | not null | |
| partner_platform_user_id / partner_username / partner_display_name | text | nullable | the fan side |
| conversation_flags | integer | default 0 | |
| unread_count | integer | default 0 | |
| subscription_tier_id | text | nullable | |
| last_message_id / last_unread_message_id | text | nullable | |
| last_message_at | timestamptz | nullable | |
| last_message_sender_id | text | nullable | |
| last_message_sender_role | `dm_sender_role` enum | default `unknown` | |
| last_message_preview | text | nullable | |
| last_fan_message_at / last_model_message_at | timestamptz | nullable | |
| stored_message_count | integer | default 0 | CHECK `between 0 and 1000` |
| newest_stored_message_id / oldest_stored_message_id | text | nullable | |
| message_coverage_status | `dm_message_coverage_status` enum | default `pending_backfill` | |
| message_backfill_complete | boolean | default false | |
| last_message_sync_at | timestamptz | nullable | |
| is_visible | boolean | default true | |
| last_seen_generation | bigint | nullable | |
| first_seen_at / last_seen_at / created_at / updated_at | timestamptz | default now() | |
| metadata | jsonb | default `{}` | |

- **Unique:** `(platform_account_id, platform_conversation_id)`; `page_dm_threads_id_account_uniq (id, platform_account_id)` (target of `page_dm_messages` composite FK).
- **Indexes:** `(platform_account_id, fan_id)`; visible-by-recency `(platform_account_id, is_visible, last_message_at desc, id desc)`; visible-by-unread `(platform_account_id, is_visible, unread_count desc, last_message_at desc, id desc)`; backfill `(platform_account_id, is_visible, message_coverage_status, last_message_sync_at)`; generation.

### `page_dm_messages`
Individual DM in the live cache (shallow tail of each thread).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| conversation_id | bigint | not null | **FK → page_dm_threads.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| platform_message_id | text | not null | |
| sender_platform_user_id | text | nullable | |
| sender_role | `dm_sender_role` enum | default `unknown` | |
| created_at | timestamptz | not null | message time (not row-insert time) |
| content | text | default `''` | message body |
| total_tip_amount_cents | integer | default 0 | note: **cents**, not mills |
| in_reply_to_message_id / in_reply_to_root_message_id | text | nullable | |
| purchased_at | timestamptz | nullable | PPV unlock time (`messages.ppv.unlocked`) |
| deleted_at | timestamptz | nullable | |
| synced_at | timestamptz | default now() | |

- **Unique:** `(conversation_id, platform_message_id)`.
- **Indexes:** `(platform_account_id, platform_message_id)`, `(conversation_id, created_at desc, id desc)`, `(platform_account_id, conversation_id, created_at desc, id desc)`.
- **Composite FK:** `(conversation_id, platform_account_id) → page_dm_threads(id, platform_account_id) CASCADE`.

### `dm_message_archive`
Durable, source-attributed DM archive fed by OFAPI webhook journal + command sink + REST reconcile/backfill. TTL-pruned via `retain_until`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform | `platform` enum | not null | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| ofapi_account_id | text | not null | `acct_…` |
| platform_conversation_id | text | nullable | |
| fan_platform_user_id | text | nullable | |
| platform_message_id | text | not null | |
| sender_platform_user_id | text | nullable | |
| sender_role | `dm_sender_role` enum | default `unknown` | |
| is_sent_by_me | boolean | default false | outbound vs inbound |
| message_created_at | timestamptz | nullable | |
| text_plain | text | default `''` | |
| price_mills | bigint (BigInt) | nullable | CHECK null or `>= 0` |
| is_opened | boolean | nullable | |
| is_tip | boolean | default false | |
| tip_amount_mills | bigint (BigInt) | default 0 | CHECK `>= 0` |
| in_reply_to_message_id | text | nullable | |
| deleted_at | timestamptz | nullable | |
| source | text | not null | CHECK ∈ `webhook`,`command`,`rest_reconcile`,`rest_backfill` |
| source_event_type | text | not null | CHECK ∈ `messages.received`,`messages.sent`,`messages.deleted` |
| source_idempotency_key | text | not null | |
| source_journal_id | bigint | not null | links to `ofapi_webhook_events.id` |
| source_fanout_seq | bigint | nullable | |
| source_received_at | timestamptz | not null | |
| raw_shape_version | text | default `'ofapi-message-v1'` | |
| media_metadata | jsonb `Array<Record<string,unknown>>` | default `[]` | |
| retention_policy | text | default `'default'` | |
| retain_until | timestamptz | not null | TTL |
| archived_at / updated_at | timestamptz | default now() | |

- **Unique index:** `(platform, ofapi_account_id, platform_message_id)`.
- **Indexes:** `(platform_account_id, message_created_at desc, id desc)`, `(platform_account_id, platform_conversation_id, message_created_at desc)`, `retain_until`, `source_journal_id`.
- **CHECKs:** source, event-type, tip `>= 0`, price null-or-`>= 0`.

### `dm_message_daily_aggregates`
Replaceable text-free daily counters derived from `dm_message_archive`. Composite PK `(platform_account_id, business_date)`. Deliberately contains no transcript/media/fan identifiers.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| business_date | date | not null | PK part |
| archive_rows / inbound_messages / outbound_messages / deleted_messages / distinct_conversations / paid_outbound_messages / tip_messages | integer | default 0 | all CHECK `>= 0` |
| paid_outbound_price_mills / tip_amount_mills | bigint (BigInt) | default 0 | CHECK `>= 0` |
| first_message_at / last_message_at | timestamptz | nullable | |
| source_max_fanout_seq | bigint | nullable | watermark into webhook journal |
| rebuilt_at | timestamptz | default now() | |

- **Index:** `(business_date desc, platform_account_id)`.
- **CHECK:** aggregate `counts_nonnegative` covering all count columns.

---

## 8. OFAPI commands (outbound send/typing/unsend/read)

### `ofapi_commands`
Queue of chatter-initiated actions dispatched to OFAPI (send text/media, typing, unsend, mark-read). UUID-keyed with strict dedupe + one-in-flight-per-lane invariants. **Boundary: outbound to onlyfansapi.com; inbound from desktop chat app via API.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | uuid | PK | |
| client_command_id | uuid | not null | client-supplied idempotency id |
| page_id | bigint | not null | **FK → pages.id CASCADE** |
| chatter_user_id | bigint | not null | **FK → users.id ON DELETE RESTRICT** |
| ofapi_account_id | text | not null | CHECK `~ '^acct_[A-Za-z0-9]+$'` |
| conversation_id | text | not null | CHECK `~ '^[0-9]{1,30}$'` |
| kind | text (`OfapiCommandKind`) | not null | CHECK ∈ 5 send/typing/unsend/read kinds |
| payload | jsonb (`OfapiCommandPayload`) | not null | text / {text,price,mediaFiles,previews} / {messageId} / {} |
| payload_hash | text | not null | CHECK `~ '^[0-9a-f]{64}$'` (sha-256) |
| retry_of_command_id | uuid | nullable | **self-FK → ofapi_commands.id RESTRICT** |
| state | text | default `queued` | CHECK ∈ `queued`,`in_flight`,`confirmed`,`failed_retryable`,`failed_terminal`,`indeterminate`,`cancelled` |
| attempt_count | integer | default 0 | CHECK `>= 0` **and** CHECK `<= 1` (at most one attempt) |
| last_error_code / last_error_class | text | nullable | |
| verifier_result | jsonb | nullable | |
| platform_message_id | text | nullable | resolved message id on success |
| attempt_started_at / attempt_finished_at | timestamptz | nullable | |
| payload_redacted_at | timestamptz | nullable | PII redaction marker |
| dedupe_expires_at | timestamptz | not null | CHECK `>= created_at` |
| created_at / updated_at | timestamptz | default now() | |

- **Unique indexes:** `(page_id, chatter_user_id, client_command_id)`; **partial** `one_in_flight_lane (page_id, conversation_id) WHERE state='in_flight'` (enforces single in-flight command per conversation lane).
- **Indexes:** `(chatter_user_id, created_at desc)`; `(page_id, conversation_id, created_at)`; `dedupe_expires_at`; partial `queued (created_at) WHERE state='queued'`; partial `verifier_candidate (ofapi_account_id, conversation_id, attempt_started_at) WHERE state IN ('in_flight','indeterminate')`; partial `payload_redaction (updated_at) WHERE payload_redacted_at IS NULL AND state IN (terminal states)`.

---

## 9. Transactions & revenue rollups

### `transactions`
Canonicalized money events (subscriptions, tips, PPV, chargebacks, refunds…). Idempotent per (page, transaction_id). Money in mills.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | nullable | **FK → fans.id SET NULL** |
| transaction_id | text | not null | external id |
| wallet_id / account_id / correlation_id / correlation_account_id | text | nullable | |
| raw_type | text | not null | |
| canonical_type | `transaction_type` enum | not null | |
| transaction_state | `transaction_state` enum | not null | pending/posted/unknown |
| destination | integer | nullable | |
| raw_status | text | not null | |
| gross_amount_mills | bigint (BigInt) | not null | |
| source_destination_amount_mills | bigint (BigInt) | not null | |
| creator_net_amount_mills | bigint (BigInt) | not null | |
| raw_destination_tax | integer | nullable | |
| new_balance_mills | bigint (BigInt) | nullable | balance after |
| sender_id / receiver_id | text | nullable | |
| occurred_at | timestamptz | not null | |
| source_updated_at | timestamptz | nullable | |
| scan_token | text | nullable | |
| is_active | boolean | default true | |
| inactive_reason | `transaction_inactive_reason` enum | nullable | `missing_from_sync_window` |
| inactivated_at | timestamptz | nullable | |
| created_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, transaction_id)`.
- **Indexes:** pending-boundary `(platform_account_id, transaction_state, occurred_at)`, `(platform_account_id, occurred_at)`, active `(platform_account_id, is_active, occurred_at)`, `(fan_id)`.

### `revenue_daily` (aliased `dailyRevenue`)
Per-page daily revenue rollup keyed by type+state.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| business_date | date | not null | |
| canonical_type | `transaction_type` enum | not null | |
| transaction_state | `transaction_state` enum | not null | |
| transaction_count | integer | default 0 | |
| gross_amount_mills / creator_net_amount_mills | bigint (BigInt) | default 0 | |
| updated_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, business_date, canonical_type, transaction_state)`.
- **Index:** `(platform_account_id, business_date)`.

### `fan_spend_daily` (aliased `spenderDailyFacts`)
Per (page, fan, day, type, state) spend rollup. Composite PK.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| fan_id | bigint | not null | **FK → fans.id CASCADE**, PK part |
| business_date | date | not null | PK part |
| canonical_type | `transaction_type` enum | not null | PK part |
| transaction_state | `transaction_state` enum | not null | PK part |
| transaction_count | integer | default 0 | |
| gross_amount_mills / creator_net_amount_mills | bigint (BigInt) | default 0 | |
| last_transaction_at | timestamptz | nullable | |
| updated_at | timestamptz | default now() | |

- **PK:** `(platform_account_id, fan_id, business_date, canonical_type, transaction_state)`.
- **Indexes:** `(platform_account_id, business_date, fan_id)`, `(fan_id, platform_account_id, business_date)`.

### `fan_spend_lifetime` (aliased `spenderLifetimePage`)
Per (page, fan) lifetime spend. Composite PK `(platform_account_id, fan_id)`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| fan_id | bigint | not null | **FK → fans.id CASCADE**, PK part |
| gross_amount_mills / creator_net_amount_mills | bigint (BigInt) | default 0 | |
| last_transaction_at | timestamptz | nullable | |
| updated_at | timestamptz | default now() | |

- **Index:** `(fan_id, platform_account_id)`.

### `page_fan_identities` (aliased `pageTopSpenders`)
Top-spender identity projection per page, keyed by an opaque `source_identity_key`. Composite PK. Carries source-window spend before it is matched to a `fan_id`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| source_identity_key | text | not null | PK part |
| correlation_account_id / account_id | text | nullable | |
| fan_id | bigint | nullable | **FK → fans.id SET NULL** |
| gross_amount_mills / creator_net_amount_mills | bigint (BigInt) | default 0 | |
| source_window_started_at / source_window_ended_at | timestamptz | not null | |
| last_synced_at / created_at / updated_at | timestamptz | default now() | |

- **PK:** `(platform_account_id, source_identity_key)`.
- **Index:** `(fan_id, platform_account_id)`.

### `projection_watermarks` (aliased `spenderProjectionWatermarks`)
Per-page rebuild watermark for spend projections. PK = `platform_account_id`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | PK | **FK → pages.id CASCADE** |
| last_rebuilt_at | timestamptz | not null | |
| updated_at | timestamptz | default now() | |

### `daily_followers`
Per-page daily follower deltas.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| business_date | date | not null | |
| new_followers | integer | default 0 | |
| known_total_followers | integer | nullable | |
| updated_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, business_date)`.

### `daily_subscribers`
Per-page daily subscriber deltas + active count.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| business_date | date | not null | |
| new_subscribers | integer | default 0 | |
| active_subscribers | integer | default 0 | |
| updated_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, business_date)`.

---

## 10. Access control, auth, audit

### `user_page_assignments`
Which pages a user may access.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| user_id | bigint | not null | **FK → users.id CASCADE** |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| created_at | timestamptz | default now() | |

- **Unique:** `(user_id, platform_account_id)`. **Index:** `(platform_account_id)`.

### `auth_sessions`
Session tokens (stored as digests, not raw).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| user_id | bigint | not null | **FK → users.id CASCADE** |
| token_digest | text | not null, **unique** | hashed session token (secret material never stored raw) |
| expires_at | timestamptz | not null | |
| last_seen_at | timestamptz | default now() | |
| created_at | timestamptz | default now() | |
| revoked_at / revoked_reason | ts / text | nullable | |

- **Indexes:** `(user_id)`, `(expires_at)`.

### `api_keys`
Programmatic API keys (prefix + digest).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| user_id | bigint | not null | **FK → users.id CASCADE** |
| key_prefix | text | not null, **unique** | visible prefix |
| token_digest | text | not null, **unique** | hashed secret |
| last_used_at | timestamptz | nullable | |
| created_at | timestamptz | default now() | |
| revoked_at / revoked_reason | ts / text | nullable | |

- **Index:** `(user_id)`.

### `audit_events`
Generic actor/target/page audit trail.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| actor_user_id | bigint | nullable | **FK → users.id SET NULL** |
| target_user_id | bigint | nullable | **FK → users.id SET NULL** |
| platform_account_id | bigint | nullable | **FK → pages.id SET NULL** |
| source | text | not null | |
| event_type | text | not null | |
| metadata | jsonb | default `{}` | |
| created_at | timestamptz | default now() | |

- **Indexes:** `(actor_user_id, created_at)`, `(target_user_id, created_at)`, `(platform_account_id, created_at)`.

---

## 11. AI usage & gateway ledger

### `ai_usage_events`
Per-user AI token/cost ledger for the AI gateway. Cost in **micro-USD** (not mills). **Boundary: records outbound AI-provider (Anthropic / OpenRouter) usage.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| user_id | bigint | not null | **FK → users.id CASCADE** |
| page_id | bigint | nullable | **FK → pages.id SET NULL** |
| client_event_id | text | not null | client idempotency id |
| feature | `ai_usage_feature` enum | not null | fast-reply/improve-draft/help-me/fan-summary/chat-review/scan/ping/hi-greeting |
| model | text | not null | model id string |
| provider | text | nullable | CHECK null-or ∈ `anthropic`,`openrouter` |
| provider_response_id | text | nullable | |
| input_tokens / output_tokens / cache_write_tokens / cache_read_tokens | integer | not null | each CHECK `>= 0` |
| cost_micro_usd | integer | default 0 | CHECK `>= 0` |
| cost_approximate | boolean | default false | |
| quota_accepted | boolean | nullable | |
| gateway_outcome | text | nullable | CHECK null-or ∈ `completed`,`failed`,`cancelled`,`quota_denied` |
| conversation_id | text | nullable | |
| duration_ms | integer | nullable | CHECK null-or `>= 0` |
| is_cache_hit / is_regeneration | boolean | default false | |
| completed_at | timestamptz | not null | |
| ingested_at | timestamptz | default now() | |

- **Unique:** `(user_id, client_event_id)`.
- **Indexes:** `(user_id, completed_at)`, `(page_id, completed_at)`, partial `(provider, provider_response_id) WHERE provider_response_id IS NOT NULL`, `(completed_at)`.

> Note: `ai_usage_events` has no `platform_account_id`; the per-page daily AI cap lives in `wb_llm_usage_daily` (§12).

---

## 12. Workboard (v1 snooze, v2 priority engine, closing classifier)

### `workboard_snoozes` (v1)
Legacy per (page, fan) snooze. One row per pair.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| snoozed_until | timestamptz | not null | |
| created_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, fan_id)`. **Index:** `(platform_account_id, fan_id, snoozed_until)`.

### `workboard_state` (v2)
Persisted FSM, one row per (page, fan), recomputed nightly + event-patched. Value and Urgency stored separately; `rank_score` is the per-tab sort key.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| fan_id | bigint | not null | **FK → fans.id CASCADE**, PK part |
| tab | `workboard_tab` enum | not null | |
| mass_substate | `workboard_mass_substate` enum | nullable | |
| value_score / urgency_score | numeric(5,2) | default 0 | |
| rank_score | numeric(8,3) | default 0 | tab sort key |
| secondary_status | `workboard_secondary_status` enum | default `later` | |
| value_tier | text | default `'new'` | |
| urgency_severity | text | default `'normal'` | |
| needs_reply / needs_human_triage / is_purchase_followup | boolean | default false | |
| why_now_code | text | nullable | |
| why_now_value | numeric(10,2) | nullable | |
| reason_chips | jsonb `string[]` | default `[]` | |
| followup_due_at | timestamptz | nullable | |
| q_score | numeric(4,3) | nullable | conversation-quality score |
| q_confidence / value_confidence | text | default `'low'` | |
| role_confidence | numeric(4,3) | default 1 | |
| best_coverage_seen | `dm_message_coverage_status` enum | nullable | |
| freeloader_status | `workboard_freeloader_status` enum | default `none` | |
| freeloader_episodes | jsonb `string[]` | default `[]` | |
| lifetime_free_episodes | integer | default 0 | |
| reactivation_attempted_at | timestamptz | nullable | |
| service_reason | text | nullable | |
| last_eval_at / updated_at | timestamptz | default now() | |

- **PK:** `(platform_account_id, fan_id)`.
- **Indexes:** tab-rank `(platform_account_id, tab, rank_score desc)`, status `(platform_account_id, tab, secondary_status)`, `(fan_id, platform_account_id)`.

### `workboard_contact_log` (v2)
Dashboard-written touch log — authoritative "we contacted this fan" signal (DM sync is lagged/shallow). Model-scoped for cross-page anti-spam.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| model_id | bigint | not null | **FK → models.id CASCADE** (cross-page scope) |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| fan_id | bigint | not null | **FK → fans.id CASCADE** |
| business_date | date | not null | |
| action | `workboard_contact_action` enum | not null | opened/handled/snoozed |
| was_productive | boolean | default false | |
| acted_at / created_at | timestamptz | default now() | |

- **Indexes:** `(platform_account_id, fan_id, acted_at desc)`, cross-page `(model_id, fan_id, business_date)`, `(platform_account_id, business_date)`.

### `wb_closing_cache`
Permanent per-message verdict cache for the L2 (Haiku) closing classifier.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| platform_message_id | text | not null | |
| content_hash | text | not null | |
| needs_reply | boolean | not null | |
| layer | text | not null | `l2` (classifier-confirmed) or `over_cap` (fallback) |
| model | text | nullable | |
| state / reason | text | nullable | L2 semantic read + rationale |
| classified_at | timestamptz | default now() | |

- **Unique:** `(platform_account_id, platform_message_id)`. **Index:** `(platform_account_id, classified_at)`.

### `wb_closing_settings`
Per-page overrides for the L2 classifier (null column = inherit env). PK = `platform_account_id`.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | PK | **FK → pages.id CASCADE** |
| enabled | boolean | nullable | |
| daily_cap_max | integer | nullable | |
| model | text | nullable | |
| updated_at | timestamptz | default now() | |

### `wb_classifier_runs`
Append-only classifier run log (one row per page per run).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE** |
| trigger | text | not null | `cron`/`manual`/`reclassify` |
| model | text | nullable | |
| classified / calls / input_tokens / output_tokens / deferred / cleared | integer | default 0 | |
| status | text | default `'ok'` | |
| error | text | nullable | |
| created_at | timestamptz | default now() | |

- **Indexes:** `(created_at desc)`, `(platform_account_id, created_at desc)`.

### `wb_llm_usage_daily`
Per (page, day, feature) AI usage + cost counter — the per-page daily cap the human-keyed `ai_usage_events` cannot express. Composite PK.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| platform_account_id | bigint | not null | **FK → pages.id CASCADE**, PK part |
| business_date | date | not null | PK part |
| feature | text | not null | PK part |
| calls / input_tokens / output_tokens | integer | default 0 | |
| updated_at | timestamptz | default now() | |

- **PK:** `(platform_account_id, business_date, feature)`.

---

## 13. OFAPI webhook, credit budget/ledger, spend projection

### `ofapi_webhook_config`
Singleton (id default 1) registering the onlyfansapi.com webhook + signing secret. **Boundary: webhook registration with OFAPI.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | integer | PK default 1 | singleton |
| external_webhook_id | text | nullable | OFAPI-side webhook id |
| endpoint_url | text | not null | our receiver URL |
| account_scope | text | default `'global'` | |
| events | jsonb `string[]` | default `[]` | subscribed event types |
| encrypted_signing_secret | text | not null | encrypted (secret) |
| previous_encrypted_signing_secret | text | nullable | kept across rotation so in-flight deliveries verify |
| created_at / updated_at | timestamptz | default now() | |

### `ofapi_credit_state`
Singleton (id default 1) tracking OFAPI credit budget across all pages (credits are account-global at OFAPI, so deliberately not per-page).

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | integer | PK default 1, not null | singleton |
| spend_day | date | nullable | current UTC day for DM REST spend |
| spent_credits | integer | default 0 | REST spend today |
| audience_spend_day | date | nullable | audience-sweep's own day counter |
| audience_spent_credits | integer | default 0 | reserved-then-settled sweep spend |
| last_balance | integer | nullable | last `_meta._credits.balance` seen |
| last_balance_at | timestamptz | nullable | |
| reconciled_through_ledger_id | bigint | nullable | reconciliation cursor into `ofapi_credit_ledger` |
| last_reconcile_at | timestamptz | nullable | |
| last_drift_credits | integer | nullable | residual from last reconcile pair |
| updated_at | timestamptz | default now() | |

### `ofapi_credit_ledger`
Append-only credit-movement ledger (the checkbook reconciliation balances against). `credits`: positive = spent, negative = added.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| occurred_at | timestamptz | not null | |
| source | text | not null | **free text, NO DB check** — intended values in TS `OFAPI_CREDIT_LEDGER_SOURCES` = `rest`,`webhook_accrual`,`external`,`refill`,`adjustment` |
| operation | text | nullable | |
| page_id | bigint | nullable | **FK → pages.id SET NULL** |
| http_status | integer | nullable | |
| credits | integer | not null | +spent / -added |
| estimated | boolean | default false | true when a 2xx had no `_meta` |
| balance_after | integer | nullable | balance observation |
| request_id | text | nullable | |
| accrual_day | date | nullable | webhook-accrual UTC day |
| details | jsonb | nullable | |

- **Indexes:** `(occurred_at)`, `(source, occurred_at)`, page-list `(page_id, occurred_at desc, id desc)`, `(operation, occurred_at desc, id desc)`, `(occurred_at desc, id desc)`, partial balance-observation `(id) WHERE balance_after IS NOT NULL`, **partial unique** `accrual_day_uniq (accrual_day) WHERE source='webhook_accrual'` (one accrual row per UTC day).

### `ofapi_spend_projection_events`
Shadow-only spend projection derived from OFAPI webhook journal rows (compared against `transactions`; not production revenue truth). Domain-keyed idempotency.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| domain_key | text | not null | **unique** (idempotency) |
| projection_status | text | not null | CHECK ∈ `projected`,`blocked`,`skipped` |
| blocked_reason | text | nullable | |
| source_event_type | text | not null | CHECK ∈ `transactions.new`,`tips.received`,`messages.ppv.unlocked` |
| source_idempotency_key | text | not null | |
| journal_id | bigint | not null | → `ofapi_webhook_events.id` |
| fanout_seq | bigint | nullable | |
| ofapi_account_id | text | not null | |
| page_id | bigint | nullable | **FK → pages.id SET NULL** |
| fan_platform_user_id / transaction_id / message_id | text | nullable | |
| occurred_at | timestamptz | not null | |
| category | text | nullable | CHECK null-or ∈ `message`,`tip`,`subscription`,`post`,`stream`,`other` |
| currency | text | nullable | CHECK null-or `= 'USD'` |
| gross_amount_mills / creator_net_amount_mills | bigint (BigInt) | nullable | |
| event_status | text | nullable | CHECK null-or ∈ `pending`,`settled`,`reversed`,`estimated` |
| created_at / updated_at | timestamptz | default now() | |

- **Unique index:** `(domain_key)`.
- **Indexes:** `(page_id, occurred_at)`, `(projection_status, source_event_type)`, `(journal_id)`.

### `ofapi_webhook_events`
Journal of received OFAPI webhook deliveries. Ack row written on receipt; a pg-boss processor derives the `sync_event` frame, assigns `fanout_seq` in **settle order** (from sequence `ofapi_webhook_events_fanout_seq`) for SSE Last-Event-ID replay, and later projects DM/archive. Pruned after ~7 days. **Boundary: primary inbound webhook journal from onlyfansapi.com; outbound SSE fan-out source.**

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| idempotency_key | text | not null | **unique** dedupe |
| event_type | text | not null | OFAPI event type |
| ofapi_account_id | text | nullable | `acct_…` |
| platform_account_id | bigint | nullable | **FK → pages.id SET NULL** (filled by processor) |
| payload | jsonb `Record<string,unknown>` | not null | raw webhook body |
| sync_event | jsonb | nullable | derived SSE frame |
| fanout_seq | bigint | nullable | SSE event id (settle-ordered) |
| status | text | default `'pending'` | free text: `pending`/`processed`/`skipped`/`failed` (no DB check) |
| error | text | nullable | |
| projection_status | text | default `'none'` | free text: `none`/`pending`/`projected`/`skipped`/`failed` (no DB check) |
| projection_error | text | nullable | |
| projection_attempts | integer | default 0 | |
| projected_at | timestamptz | nullable | |
| archive_status | text | default `'none'` | CHECK ∈ `none`,`pending`,`archived`,`skipped`,`failed` |
| archive_error | text | nullable | |
| archive_attempts | integer | default 0 | |
| archived_at | timestamptz | nullable | |
| received_at | timestamptz | default now() | |
| processed_at | timestamptz | nullable | |

- **Unique:** `(idempotency_key)`; **partial unique** `fanout_seq_uniq (fanout_seq) WHERE fanout_seq IS NOT NULL`.
- **Indexes:** `(received_at)`, `(status, id)`, partial `(projection_status, id) WHERE projection_status IN ('pending','failed')`, partial `(archive_status, id) WHERE archive_status IN ('pending','failed')`, partial replay `(platform_account_id, fanout_seq) WHERE fanout_seq IS NOT NULL`.
- **CHECK:** `archive_status` only (status/projection_status are unconstrained text).

---

## 14. Runtime instances & configuration surface

### `runtime_instances`
Heartbeat for each running process (`api`, `worker`) publishing the sanitized config it is actually using. **No secret values stored** — only set/unset state. Composite PK survives multiple processes per role.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| role | text | not null | `api`/`worker`, PK part |
| instance_id | text | not null | PK part |
| started_at | timestamptz | not null | |
| last_seen_at | timestamptz | not null | staleness TTL |
| image_tag | text | nullable | |
| running | jsonb (`RunningSnapshot` = `{schemaVersion, values: Record<string,RunningValue>, skippedOverrides[]}`) | not null | sanitized running config |

- **PK:** `(role, instance_id)`. **Index:** `(last_seen_at)`.

### `config_settings`
Per-key override overlay for the in-dashboard Configuration surface. Only editable registry knobs are written; value validated/clamped server-side. Scope columns future-proof per-page overrides but only global scope (`scope_type='global'`, `scope_id=0`) is used today; `scope_id` is NOT NULL (0 = global) so the uniqueness constraint is reliable.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| scope_type | text | not null default `'global'` | |
| scope_id | bigint | not null default 0 | 0 = global |
| key | text | not null | config key |
| value | jsonb (`ConfigOverrideValue` = string \| number \| boolean) | not null | |
| version | integer | not null default 1 | optimistic version |
| updated_by_user_id | bigint | nullable | **FK → users.id SET NULL** |
| updated_at | timestamptz | default now() | |

- **Unique:** `config_settings_scope_key_uniq (scope_type, scope_id, key)`.

### `config_audit_log`
Append-only audit trail for config overrides; a multi-key patch shares a `group_id`. A clear (revert to env) is recorded with `new_value`/`new_version` null.

| Column | Type | Null/Default | Notes |
| --- | --- | --- | --- |
| id | bigserial | PK | |
| group_id | uuid | not null | groups one patch's rows |
| changed_at | timestamptz | default now() | |
| user_id | bigint | nullable | **FK → users.id SET NULL** |
| scope_type | text | not null | |
| scope_id | bigint | not null | |
| key | text | not null | |
| old_value / new_value | jsonb `ConfigOverrideValue` | nullable | |
| old_version / new_version | integer | nullable | |
| note | text | nullable | |

- **Indexes:** `(changed_at)`, `(group_id)`.

---

## 15. Scoping keys (cross-cutting)

- **Page scope** — the dominant scope: `platform_account_id → pages.id` appears on ~40 tables, nearly always `ON DELETE CASCADE` (so deleting a page removes all its fans/DMs/transactions/rollups/workboard/sync/AI-usage rows). Exceptions that use `SET NULL` (rows survive page deletion): `notification_incidents`, `ai_usage_events.page_id`, `audit_events.platform_account_id`, `page_dm_threads.fan_id`, `ofapi_credit_ledger.page_id`, `ofapi_spend_projection_events.page_id`, `ofapi_webhook_events.platform_account_id`, and `transactions.fan_id`/`page_fan_identities.fan_id`.
- **Model scope** — `pages.model_id → models.id` (CASCADE), plus `workboard_contact_log.model_id → models.id` (cross-page anti-spam scope).
- **Fan scope** — `fan_id → fans.id`; global-per-platform. `fans` itself is unique on `(platform, platform_user_id)` and carries no page/model.
- **User scope** — `user_id → users.id`; CASCADE for owned rows (`auth_sessions`, `api_keys`, `user_page_assignments`, `ai_usage_events`), `SET NULL`/`RESTRICT` for authorship/attribution (`fan_notes`, `fan_summaries`, `fan_profiles`, `fan_flags`, `audit_events`, `config_settings`, `config_audit_log` = SET NULL; `ofapi_commands.chatter_user_id` = RESTRICT).
- **Platform** — `platform`/`provider` enum (`fansly`|`onlyfans`) partitions fans, transactions, DM archive, external notes, sync tables.
- **Business date** — `date` calendar-day key for all `*_daily`/aggregate rollups (`revenue_daily`, `fan_spend_daily`, `daily_followers`, `daily_subscribers`, `dm_message_daily_aggregates`, `workboard_contact_log`, `wb_llm_usage_daily`).
- **Singletons** — `telegram_settings` (id=1), `ofapi_webhook_config` (id=1), `ofapi_credit_state` (id=1) are single-row config tables keyed by a constant integer.

---

## 16. Discrepancies & notable facts

1. **`platform_account_id` name collision.** On `pages` the TS field `platformAccountId` is DB column **`external_page_id`** (text, external OnlyMonster page id, no FK). On every other table `platform_account_id` is a bigint FK to `pages.id`. The name means opposite things depending on the table.
2. **`pages.egress_endpoint_id` has no foreign key.** It is a plain `bigint` column (schema.ts:186) despite the name; the actual referential link is the reverse `egress_endpoints.platform_account_id → pages.id` (unique). Deleting an egress endpoint will not null/cascade this pages column.
3. **`ofapi_credit_ledger.source` and `ofapi_webhook_events.status`/`projection_status` are unconstrained free text** — the allowed values exist only in TS constants/comments (`OFAPI_CREDIT_LEDGER_SOURCES`, and inline comments), not as DB `CHECK`s. Contrast `dm_message_archive`, `ofapi_commands`, `ofapi_spend_projection_events`, `ofapi_webhook_events.archive_status`, which do enforce their string domains with `CHECK`.
4. **Nine alias exports (lines 1711-1719)** create no tables — e.g. `pageTopSpenders` is literally `page_fan_identities`, `pageDmConversations` is `page_dm_threads`. A reader who greps for `topSpenders`/`conversations` finds the same physical table.
5. **Mixed money units.** Most amounts are mills (`bigint` BigInt). Exceptions: `page_dm_messages.total_tip_amount_cents` is in **cents** (integer), and `ai_usage_events.cost_micro_usd` is in **micro-USD** (integer).
6. **`ofapi_commands.attempt_count` is capped at 1** by a CHECK (`<= 1`) in addition to `>= 0` — commands are effectively single-attempt; retries are modeled as new rows via the self-FK `retry_of_command_id`.
7. **`page_dm_threads.stored_message_count` CHECK `between 0 and 1000`** bounds the live DM cache depth; the durable history lives in `dm_message_archive`.
8. **Composite foreign keys** (beyond simple `.references`): `sync_http_attempts` and `sync_run_events` each carry a 3-column FK into `sync_runs(id, page_id, stream)`; `page_dm_messages` a 2-column FK into `page_dm_threads(id, platform_account_id)`. These require the matching composite UNIQUE constraints on the parent tables.
9. **`fanout_seq` uses an external SQL sequence** `ofapi_webhook_events_fanout_seq` (created in migration 0027, not in schema.ts) rather than a serial column; it is assigned in settle order, not receive order.
10. **No `relations()` graph and no DB views/materialized views** are defined in this file — all cross-table logic is repository-level.
