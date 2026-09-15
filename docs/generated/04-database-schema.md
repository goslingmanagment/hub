> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 349, 2026-09-15):** migration 0199 adds the `account_links`
> table (one-time invite / password-reset links: sha256 digest + display
> prefix, `used_at`, `revoked_at`/`revoked_reason`, a partial unique index for
> "at most one active link per user", never deleted) and
> `device_tokens.last_client_version`; migration 0200 adds the unique index on
> `lower(username)`.

> **STALE (Decision 354, 2026-09-15):** user administration now addresses immutable
> IDs through `/admin/users/by-id/:userId`, SDK 0.3 retires username routes,
> migration 0201 adds permanent account deletion and partial login uniqueness,
> and Team state/cache ownership follows IDs. See Decision 354 and
> `docs/runbooks/user-account-deletion.md`; the body predates this change.

# Database Schema

The production schema is defined by forward-only SQL migrations under
`packages/db/migrations/`. `packages/db/src/schema.ts` is the Drizzle mirror
used by TypeScript queries; it is maintained alongside the SQL and is not a
migration generator. At this commit the mirror contains 81 `pgTable`
declarations and 23 `pgEnum` declarations. The migration series contains 96
files, `0000_baseline.sql` through
`0096_observations_harvest_lookup_concurrently.sql`.

`packages/db/src/client.ts` installs a parser for PostgreSQL OID 20, so
`BIGINT` values are returned as JavaScript `bigint`. Drizzle columns that use
`mode: "number"` intentionally expose a number instead; money columns use
`mode: "bigint"` where exact integer arithmetic is required.

## Identity, catalog, and access

The catalog starts with `platforms`, `models`, and `pages`. A page is the
internal platform-account record and points to a model. `page_credentials` and
`egress_endpoints` hold the page's upstream credentials and network routing.
Most page-owned fact tables use `ON DELETE RESTRICT`; page removal is a
controlled tombstone/erasure operation rather than an unrestricted cascade.

Authentication and authorization state is split across:

- `users`, `auth_sessions`, and `api_keys` for human principals and their
  normal credentials;
- `device_tokens` for activated, human-owned machine credentials;
- `pending_device_tokens` for short-lived enrollment reservations that do not
  authenticate application traffic;
- `access_grants` for append-oriented org/model/page grants, with
  `user_page_assignments` retained as the legacy shadow structure; and
- `audit_events` for security and administrative actions.

`users.disabled_at` freezes every authentication path without deleting the
user. `users.device_token_epoch` provides bulk device-token revocation.
`device_tokens.harvest_machine_id` is nullable and has a partial unique index;
when present it binds the token's local-harvest capability to one machine.

## Sync and operations

The sync state machine is persisted in `page_sync_states` and
`page_sync_cursors`. `page_sync_states` records both the request source and the
`dispatch_source` that actually launched the work, together with request,
lease, progress, retry, blocker, and scheduling state. `sync_runs`,
`sync_run_events`, and `sync_http_attempts` record execution history;
`sync_raw_payloads` is a time-bounded raw-response store; and
`sync_rate_limits` coordinates per-provider, egress, and priority-class pacing.

Operational tables include `runtime_instances`, `ops_metric_samples`,
`notification_incidents`, `notification_incident_recoveries`,
`telegram_settings`, and `telegram_delivery_attempts`. The incident-kind enum
currently includes `proxy_missing`, `scheduler_silent`, and
`ops_sampler_silent` in addition to auth, proxy, stream, OFAPI, disk,
partition, writer, read-capture, and golden-signal incidents.

`projection_debt` is the durable repair ledger for rebuildable projection
failures. A partial unique index permits one unresolved row for each
`(kind, conversation_id)`; successful repair sets `resolved_at` and retains the
row as history.

## Fan, subscription, and money facts

Captured fan state is distributed across `fans`, `fan_username_aliases`,
`onlyfans_public_profile_resolutions`, `page_fans`,
`page_fan_identities`, `page_fan_external_notes`, `page_fan_aliases`,
`page_follows`, `page_subscriptions`, `fan_notes`, `fan_summaries`,
`fan_profiles`, and `fan_flags`. `fan_profiles.source_generated_at` carries the
upstream record time separately from local observation time.

`transactions` is the canonical money ledger. It stores gross, source,
creator-net, fee, VAT, tax, and balance values as integer mills. Missing rows
can be soft-retired with `missing_from_sync_window`; two sticky negation states,
`superseded_duplicate_negation` and
`reversal_without_settled_original`, distinguish duplicate or unmatched
reversal behavior. The derived money and audience tables are `revenue_daily`,
`fan_spend_daily`, `fan_spend_lifetime`, `fan_earnings_stats`,
`daily_followers`, and `daily_subscribers`.

Three integer-unit conventions appear in the schema:

| Unit | Representation | Examples |
|---|---|---|
| Mills, one thousandth of a currency unit | `BIGINT` | transaction amounts, prices, tips, revenue and spender projections |
| Micro-USD | integer microdollars | `ai_usage_events.cost_micro_usd` |
| Whole vendor credits | integer credits | `ofapi_credit_ledger.credits` |

These columns are not interchangeable even when their TypeScript values are
all integers.

## Conversations and message storage

The live conversation model is `page_dm_threads` plus `page_dm_messages`.
`page_dm_threads.stored_message_count` has only a nonnegative database check;
retention size is selection policy rather than a schema upper bound.
`page_dm_message_sync_health` is a per-conversation circuit breaker with
failure, retry, quarantine, and learned `preferred_page_limit` state, allowing
one repeatedly failing conversation to back off without blocking the page-wide
stream.

`dm_message_archive` is the durable OFAPI message archive. It can be populated
from webhook, command, REST reconciliation, or REST backfill input. REST rows
may have no `source_journal_id`; `rest_material_observation_id` and
`rest_material_observed_at` record the readthrough observation that materially
advanced the row. `rest_platform_changed_at` separately records the upstream
edit time.

The archive stores a material fingerprint and the last emitted fingerprint,
the corresponding emitted event id, a revision number, and per-field
provenance. A partial repair index selects rows whose material and emitted
fingerprints differ. `dm_message_daily_aggregates` contains replaceable
aggregate-only facts without transcript text, media metadata, or fan
identifiers. The older `message_archive` and `projection_seq_watermarks` tables
serve the event-ledger projection path.

## Capture and event ledgers

`observations` is the universal append-only capture journal, partitioned by
`received_at`. It deliberately has no foreign key on `account_id`.
`observation_keys` is the unpartitioned cross-partition idempotency companion.

`domain_events` is the canonical event ledger, partitioned by `occurred_at`.
It carries a per-account `account_seq`; `domain_event_seq` serializes sequence
allocation and `domain_event_keys` provides cross-partition deduplication.
`domain_events_smoke_checkpoint` stores the replay-smoke watermark.

Both ledgers have monthly partitions. Migration 0077 reopened explicitly
addressable 2024 and 2025 event partitions. Migration 0082 adds
`domain_events_future` and `observations_future` for
`[2031-01-01, MAXVALUE)`. The partition managers stop monthly precreation at
2031 because that range already belongs to the catch-all partitions.

## OFAPI state

The OFAPI boundary persists configuration and input in
`ofapi_webhook_config`, `ofapi_webhook_events`, and
`ofapi_fanout_replay_state`; vendor credit accounting in
`ofapi_credit_state` and the append-only `ofapi_credit_ledger`; outgoing work
in `ofapi_commands`; snapshot state in the tables used by
`ofapi-sync-snapshot.ts`; and shadow money facts in
`ofapi_spend_projection_events`.

`ofapi_fanout_replay_state` is a singleton containing the contiguous replay
floor and the legacy high-water mark. Webhook cleanup cannot advance the floor
past a retained replayable blocker.

## AI, configuration, workboard, and erasure

AI data is split by purpose:

- `ai_usage_events` is the quota and cost ledger;
- `ai_generation_content` is restricted prompt/completion capture;
- `ai_acceptance_events` records lifecycle events tied to a generation;
- `ai_personas` stores keyed persona configuration and a revision; and
- `wb_llm_usage_daily` is the workboard classifier's daily usage counter.

`config_settings` stores runtime override values and `config_audit_log` stores
their append-only change history. Workboard state lives in
`workboard_state`, `workboard_contact_log`, `workboard_snoozes`,
`workboard_claim_leases`, `wb_closing_cache`, `wb_closing_settings`, and
`wb_classifier_runs`.

Every dry-run or executed erasure attempt receives an `erasure_log` row.
Executed rows resolve as either `completed` or `superseded`; a superseded row
points to the converging attempt. The optional execution protocol is currently
`global-erasure-lock-v1`. Shape checks keep resolution, completion, and
supersession fields consistent.

## Naming boundary: `platform_account_id`

In tables such as `transactions`, `page_fans`, and the DM tables,
`platform_account_id` is the internal `pages.id`, not the platform's external
identifier. The external values live separately, including
`pages.external_page_id` and `pages.ofapi_account_id`.
