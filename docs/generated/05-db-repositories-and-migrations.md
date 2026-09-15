> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 349, 2026-09-15):** migrations run to 0200.
> `repositories/auth.ts` gained the account-link family (`createAccountLink`,
> `findAccountLinkByDigest` with `FOR UPDATE`, `findAccountLinkForUser`,
> `listAccountLinks`, `revokeActiveAccountLinks`, `revokeAccountLinkById`,
> `markAccountLinkUsed`, `hasRedeemedAccountLink`), plus
> `listActiveDeviceTokensForUser`, `revokeAuthSessionsForUserExcept` and
> `isUniqueViolation`; `findUserByUsername` now matches on `lower(username)`.
> `repositories/ai-usage.ts` gained `listUserUsageReport` (one user, every
> role, with daily buckets).

> **STALE (Decision 354, 2026-09-15):** user administration now addresses immutable
> IDs through `/admin/users/by-id/:userId`, SDK 0.3 retires username routes,
> migration 0201 adds permanent account deletion and partial login uniqueness,
> and Team state/cache ownership follows IDs. See Decision 354 and
> `docs/runbooks/user-account-deletion.md`; the body predates this change.

# DB Client, Migrations, and Repositories

`packages/db` owns the PostgreSQL pool, the Drizzle schema mirror, the
forward-only SQL migration runner, the startup schema guard, and the reusable
data-access modules consumed by the services. Current schema shape is mapped in
`04-database-schema.md`.

## Client construction

`packages/db/src/client.ts` creates a `pg.Pool` and wraps it with
`drizzle(pool, { schema })`. The package installs a PostgreSQL OID 20 parser so
raw `BIGINT` results become JavaScript `bigint`. Callers can use the Drizzle
database and the underlying pool; repositories use both typed query building
and explicit SQL for operations that need database-specific locking,
partition, JSON, or conflict behavior.

## Migration discovery and ordering

`packages/db/src/migrations-dir.ts` accepts migration names matching
`NNNN_name.sql`, sorts them lexically, and resolves either an explicit
directory, `packages/db/migrations` under the current working directory, or
the package-relative migration directory.

`packages/db/src/migrate-runner.ts` applies the sorted series. Its invariants
are:

- a session advisory lock on keys `(31415, 27182)` serializes migration
  runners;
- `schema_migrations(id, applied_at)` is the application ledger;
- two files cannot share the same four-digit prefix;
- already applied files must form a contiguous prefix of the complete sorted
  list; and
- `through` can limit a run to the contiguous prefix ending at one exact
  filename, and fails if that filename does not exist.

Normal files execute in one transaction per file: SQL, ledger insert, and
commit succeed together, while any error rolls that file back. The series has
no down-migration mechanism.

PostgreSQL operations forbidden inside a transaction use a separate protocol.
A file beginning with `-- agency-hub:no-transaction` is split at
`-- agency-hub:statement` markers. Each operation runs under the same advisory
lock, followed by the ledger insert. An operation beginning with
`-- agency-hub:execute-returned-statements` is first executed as a statement
generator; every returned `statement` string is then executed. This path is
used for idempotent concurrent-index work, so a process death before the ledger
insert can safely rerun the operations.

Migration 0096 uses that protocol to create harvest-compatibility indexes on
individual observation partitions with `CREATE INDEX CONCURRENTLY IF NOT
EXISTS`, then attach them to the partitioned parent index.

## Runtime schema guard

`packages/db/src/schema-guard.ts` runs during process bootstrap and rejects a
database that does not match the runtime's minimum expected shape. It verifies:

- the `schema_migrations` table exists and contains the current final migration;
- `pages`, `page_sync_states`, and `page_sync_cursors` exist;
- the named legacy account, proxy, sync-state, checkpoint, request,
  rate-limit, and raw-payload tables are absent; and
- `sync_runs.stats` is `jsonb NOT NULL DEFAULT '{}'::jsonb`.

The guard reports the same `DATABASE_URL` migration command for each detected
drift condition. `tests/schema-guard.test.ts` covers the behavior.

## Migration series

There are 96 migrations, from `0000_baseline.sql` through
`0096_observations_harvest_lookup_concurrently.sql`. The baseline establishes
the catalog, sync, fan, money, DM, auth, notification, audit, and initial
projection tables. Later structural groups include:

| Range | Persisted change |
|---|---|
| `0003`-`0004` | AI usage ledger and feature scan |
| `0018`-`0023` | notification recovery and workboard-v2 state |
| `0027`-`0031` | OFAPI webhook and credit state/ledger |
| `0034`-`0037` | runtime instances, config audit, OFAPI spend shadow, DM archive |
| `0038`-`0046` | OFAPI command outbox and command variants |
| `0053`-`0057` | tombstones, observations journal, restrictive page FKs, domain-event ledger |
| `0059`-`0068` | event projections, fan earnings, money detail, smoke checkpoint, access/device auth, claims, operations metrics, platforms |
| `0071`-`0074` | erasure log, restricted AI capture, personas, system AI lane, acceptance lifecycle |

The migrations after the previous generated-map baseline are:

| Migration | Persisted change |
|---|---|
| `0075_dm_archive_readthrough.sql` | REST-readthrough provenance and nullable source-journal linkage in the DM archive |
| `0076_dm_archive_corrections.sql` | material/emitted fingerprints, revision linkage, field provenance, and the repair signal |
| `0077_domain_events_2024_2025_reopen.sql` | explicitly addressable older domain-event partitions |
| `0078_proxy_missing_incident_kind.sql` | `proxy_missing` incident kind |
| `0079_users_disabled_at.sql` | user deactivation tombstone |
| `0080_w5_observability.sql` | scheduler and operations-sampler observability state |
| `0081_w7_money_correctness.sql` | sticky transaction-negation inactive reasons |
| `0082_w8_future_catchall_partitions.sql` | observation and event catch-all partitions beginning in 2031 |
| `0083_w10_message_archive_shadow.sql` | message-archive shadow rebuild support |
| `0084_page_dm_threads_count_floor_only.sql` | replacement of the stored-message upper bound with a nonnegative floor |
| `0085_projection_debt.sql` | durable projection repair debt |
| `0086_page_dm_message_sync_health.sql` | per-conversation failure, retry, and quarantine state |
| `0087_fan_profiles_source_generated_at.sql` | upstream generation time on fan profiles |
| `0088_sync_health_preferred_limit.sql` | learned conversation page-size state |
| `0089_page_sync_dispatch_source.sql` | actual sync dispatch source |
| `0090_device_token_harvest_capability.sql` | machine-bound harvest capability and compatibility lookup support |
| `0091_ai_persona_revision.sql` | AI persona revision |
| `0092_pending_device_tokens.sql` | non-authenticating device enrollment reservations |
| `0093_typing_command_retention.sql` | typing-command retention behavior |
| `0094_event_replay_continuity.sql` | v1 fanout replay continuity state |
| `0095_erasure_attempt_resolution.sql` | completed/superseded erasure-attempt resolution protocol |
| `0096_observations_harvest_lookup_concurrently.sql` | concurrent partition-leaf harvest lookup indexes |

## Observation repository

`packages/db/src/repositories/observations.ts` implements the observation
append protocol. It preallocates an observation id, claims
`(source, idempotency_key)` in `observation_keys`, and writes the partitioned
journal row only for the winning claim. Both inserted and duplicate results
include the authoritative journal `received_at`; on a duplicate this is the
existing key's timestamp, allowing an immediate projector to address the
correct partition.

If an autocommit journal insert fails after its key claim, the repository
removes only that exact claim and rethrows the original failure. In a caller
transaction, rollback removes both operations. Batch insertion is sequential.

The repository also exposes partition creation and lead checks, keyed lookup,
envelope and replay scans, harvest counts, transaction-residue queries, and a
staged-rollout compatibility lookup for old principal-based versus current
machine-based harvest idempotency keys. Migration 0096 supplies the bounded
partition indexes used by that compatibility lookup.

## Domain-event repository

`packages/db/src/repositories/domain-events.ts` serializes each account's
batch on `domain_event_seq ... FOR UPDATE`. It preallocates event ids, claims
`(account_id, dedup_key)` in `domain_event_keys`, and advances `account_seq`
only for new claims. The result contains a per-input outcome and the resolved
event id even when the key already existed. A successful nonempty append emits
one `domain_events_appended` notification after commit; consumers use the
notification as a wake-up and drain from their own watermark.

Replay queries expose account bounds, high waters, retained continuity gaps,
contiguous replay ends, state-snapshot recovery floors, the erasure epoch, and
retained recovery counts. Event listing accepts a `throughSeq` ceiling so a
recovery calculation and subsequent drain can stay inside the same bounded
interval. The repository also provides observation replay/parse operations and
domain-event partition management.

## DM convergence repositories

Several modules form the current message convergence path:

- `dm-message-candidate.ts` reduces webhook, REST-reconcile, and command
  candidates into one DM archive head. Outcomes distinguish deferred, fenced,
  written, and no-op cases. It also lists material/emitted repair mismatches
  and advances the emitted fingerprint after event publication.
- `dm-material-fingerprint.ts` hashes a domain-separated canonical material
  tuple. Storage uses `bytea`; hexadecimal fingerprints appear only in
  superseding-event dedup keys and event data.
- `ai-transcript-union.ts` reads both message archives in one database
  snapshot, applies cross-store tombstones, prefers the fresh DM row for a
  duplicated message reference, applies PPV-open upgrades, and caps the
  deterministic result tail at 1,500 rows.
- `erasure-fence.ts` supplies shared DM-writer and exclusive erasure advisory
  locks plus scope-fence checks.
- `projection-debt.ts` records, lists, resolves, and counts rebuildable DM
  thread-summary failures.

`dm-message-archive.ts`, `message-archive.ts`, `page-dm.ts`, and
`dm-analytics.ts` provide the archive lifecycle, event projection, hot
conversation/message store, and aggregate projection operations around that
convergence path.

## Repository inventory

The directory `packages/db/src/repositories/` contains 41 modules. Grouped by
responsibility, they are:

| Area | Modules |
|---|---|
| Capture and event ledger | `observations.ts`, `domain-events.ts` |
| Message convergence and projections | `ai-transcript-union.ts`, `dm-material-fingerprint.ts`, `dm-message-candidate.ts`, `dm-message-archive.ts`, `message-archive.ts`, `page-dm.ts`, `dm-analytics.ts`, `projection-debt.ts` |
| Fan and money facts | `fans.ts`, `fan-metadata.ts`, `fan-page-identity.ts`, `fan-profiles.ts`, `transactions.ts`, `spenders.ts`, `top-spenders.ts`, `reporting.ts` |
| Sync and platform state | `sync.ts`, `sync-context.ts`, `page-sync.ts`, `ofapi-sync-snapshot.ts`, `onlyfans-public-profiles.ts`, `egress.ts` |
| OFAPI boundary | `ofapi.ts`, `ofapi-commands.ts` |
| AI | `ai-usage.ts`, `ai-restricted.ts`, `ai-personas.ts` |
| Auth, access, and erasure | `auth.ts`, `access-grants.ts`, `erasure.ts`, `erasure-fence.ts` |
| Operations and configuration | `catalog.ts`, `config-settings.ts`, `notifications.ts`, `ops-metrics.ts`, `runtime-instances.ts`, `telegram-settings.ts` |
| Product read models | `search.ts`, `workboard-v2.ts` |

These modules include ordinary CRUD, soft-retirement, append ledgers,
watermarks, leases, projections, retention cleanup, advisory-lock protocols,
and reporting queries. Tests that police retention and erasure behavior inspect
the actual delete surfaces rather than treating every repository mutation as
equivalent.
