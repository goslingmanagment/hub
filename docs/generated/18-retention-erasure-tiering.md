> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Retention, Erasure, Tiering & Partition Management

This map describes how the kernel treats captured business facts over time: the
retention doctrine (the sanctioned-deleter pin, the handful of scheduled
deleters that touch data, and the 100-year "effectively forever" stand-down
constants), the governed erasure procedure (three planes, three scopes, the
fan-lineage exclusivity guard, the FK safety net, the tombstone/audit trail,
and CLI gating), Stage 28 tiering to the on-box Parquet lake (export → verify →
detach, restricted kinds, lake exclusions, the restore drill that gates any
DROP), and daily partition management. It is descriptive and anchored to
file:line.

## Retention doctrine

The governing rule is capture-first, never scheduled deletion: business facts
are journaled verbatim and nothing that captured a fact is deleted on a
schedule.

### The sanctioned-deleter pin

`tests/retention-deleters.test.ts` enumerates and pins **every file that issues
a SQL delete** — it greps for `\.delete\(|delete from` (minus the
`server.delete(` HTTP verb). Any new deleter anywhere in the tree fails this
test first. The pinned `SANCTIONED_DELETER_FILES`
(`retention-deleters.test.ts:19-47`):

| Layer | Files |
|---|---|
| Runtime | `apps/runtime/src/cli.ts`, `services/erasure/index.ts`, `modules/events/index.ts`, `services/auth.ts`, `services/domain-events-stream.ts`, `services/events-stream.ts`, `services/projections/fan-earnings.ts`, `services/sync/executor.ts`, `services/sync/observability.ts`, `services/sync/rate-limiter.ts` |
| DB repos | `auth.ts`, `catalog.ts`, `config-settings.ts`, `dm-analytics.ts`, `dm-message-archive.ts`, `fan-metadata.ts`, `message-archive.ts`, `observations.ts`, `ofapi.ts`, `ops-metrics.ts`, `page-dm.ts`, `runtime-instances.ts`, `spenders.ts`, `sync.ts`, `top-spenders.ts`, `transactions.ts`, `workboard-v2.ts` |

### Scheduled deleters that touch captured data on a timer

Only these run deletions on a schedule (`retention-deleters.test.ts:9-16`):

| # | Deleter | Target | Policy |
|---|---|---|---|
| 1 | `deleteExpiredSyncObservability` | `sync_http_attempts`, `sync_run_events`, and since Stage 28 `sync_runs` | 30 days; running rows are never deleted (`sync.ts:745-760`). |
| 2 | Golden-signals sampler prune (`pruneOpsMetricSamples`) | `ops_metric_samples` | 90 days retained; the migration/repo comment mentions pruning >14 days, and `pruneOpsMetricSamples` takes the days argument (`ops-metrics.ts:30-36`). |
| 3 | `page_dm_messages` prune | `page_dm_messages` (hot DM cache) | Cache policy, archive-coverage-gated. |
| 4 | pg-boss archival | pg-boss's own archival tables | Library-internal. |

### The one sanctioned non-scheduled deleter

The Stage 28 **erasure module** — owner-initiated, dry-run by default,
tombstoned in `erasure_log` (`retention-deleters.test.ts:17-18`). See below.

### 100-year "effectively forever" stand-down

`36500` days (100 years) is the kernel Stage 1 retention stand-down constant —
a value chosen to mean "do not delete on a timer" while still flowing through
the retention-days plumbing:

- `OFAPI_EVENT_RETENTION_DAYS` default `36500` (`ofapi-events.ts:70`)
- `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS` default `36500` (`ofapi-dm-archive.ts:22`)
- `RAW_RETENTION_DAYS = 36500` (`services/sync/shared.ts:33`)

Fact tables grow forever; disk pressure is contained by an hourly disk-usage
incident check (0052, `db-disk-alert.ts:12`), not by deletion.

## Erasure module (Stage 28.4)

`apps/runtime/src/services/erasure/index.ts`. Doctrine (DP 7-A): business facts
are forever, and "delete" is a governed procedure — owner-initiated, scoped,
**dry-run by default** (`index.ts:11-38`).

### Scopes

`ErasureScopeInput` (`index.ts:40-54`), resolved by `resolveScope` to
pageIds / fanId / nativeRefs (`index.ts:98-148`):

| Scope | Input | 
|---|---|
| `fan` | platform + fanRef |
| `page` | pageLabel |
| `model` | modelSlug |

### Three planes

`ErasureTarget.plane` (`index.ts:56-70`):

| Plane | What is erased |
|---|---|
| **hot** | DB tables. Fan scope (`fanHotTargets`, `index.ts:425-596`): `wb_closing_cache`, `page_dm_threads` (+ `page_dm_messages` cascade), `fan_earnings_stats` (RESTRICT-cleared first), `page_fan_identities`, `message_archive`, `dm_message_archive`, `ofapi_commands`, `ai_acceptance_events` + `ai_generation_content`, cascade FK tables, then the `fans` row. `transactions` are **anonymized, not deleted** (fan_id / correlation / sender / wallet / scan_token nulled — `index.ts:569-574`). Page/model scope (`pageHotTargets`, `index.ts:598-708`): a 28-table delete list (`index.ts:642-670`) plus orphaned-fan cleanup guarded against links elsewhere (`index.ts:604-616`). |
| **ledger** | Partitioned tables, erased via parent `DELETE` **plus** any parked partitions in schema `tiered_pending_drop` — a parent `DELETE` never reaches detached partitions (`index.ts:214-226, 713-809`). Targets: `domain_event_keys`, `domain_events` (+ parked), `observation_keys`, `observations` (+ parked). |
| **lake** | Parquet files (`index.ts:821-914`): a DuckDB **filter-out rewrite** (`COPY … WHERE NOT (pred)`), manifest re-checksummed (sha256), id-bounds recomputed, and an **erasure record appended to the manifest** (`index.ts:907-911`). |

### Fan-lineage exclusivity guard

`collectFanLineage` (`index.ts:305-405`): an observation is erased only if **no
other fan's** domain_events reference it. Shared survivors are counted into
`sharedObservations`, reported, and never touched (`index.ts:35, 371-398`).
Catalog rows (models / pages / users) survive by design (`index.ts:20-26`).

### FK safety net

`FAN_FK_CURATED` set (`index.ts:423`): any unmapped non-cascade FK to `fans`
throws "extend the erasure curation" (`index.ts:436-441`), so a newly added
reference to fans cannot silently escape erasure.

### Execution & audit trail

`executeErasure` (`index.ts:975-1040`):

1. Tombstone written to `erasure_log` **before** any deletion via
   `insertErasureLog` (`index.ts:984-990`).
2. Hot + ledger deletes run in **one transaction** (`index.ts:998-1006`).
3. Lake rewrite follows **post-commit** (`index.ts:1008-1010`).
4. `completeErasureLog` records the actual `executedCounts` +
   `sharedObservationsKept` (`index.ts:1012-1018`).
5. Dual-write audit: an `audit_events` row plus an operator observation with
   `account_id = NULL` by design (`index.ts:1020-1033`).

### CLI gating

`apps/runtime/src/cli.ts:787-858`, command `erasure:run`:

- `--initiated-by <username>` is required and resolved via
  `findUserByUsername`, else it throws unknown user (`cli.ts:823-826`).
- The default path is dry-run — it records an `erasure.dry_run` audit
  (`cli.ts:829-846`).
- Execution requires both `--execute` **and** `--confirm <scopeRef>` matching
  exactly the dry-run scope ref (`cli.ts:849-851`).

There is no explicit role check in the CLI beyond user existence; the CLI itself
is the owner-only surface.

## Tiering (Stage 28)

`apps/runtime/src/services/tiering/index.ts`. Aged **monthly partitions** of the
two ledgers export to Parquet in the on-box lake.

### What tiers where

`TIERED_TABLES` (`index.ts:45-87`): `observations` and `domain_events`. Aged
partitions export to Parquet under `config.lakeDir`, in plane directories
`capture/` and `ledger/` (`index.ts:168-179`).

### Threshold

The hot window is a deploy-time **constant**, not a config knob:
`TIERING_HOT_WINDOW_MONTHS = 6` (`index.ts:27`). `listTierablePartitions` picks
monthly partitions whose whole range is older than `now − 6 months`; the
`pre_2024` / MINVALUE catch-alls and the current-year tail never match
(`index.ts:114-160`).

### Pipeline: export → verify → detach

`tierPartition` (`index.ts:312-413`):

1. **Export** — NDJSON → DuckDB `COPY TO PARQUET` with an explicit column
   schema (`index.ts:250-266`); writes a `.manifest.json` recording rowCount,
   restrictedRowCount, minId/maxId, sha256 (`index.ts:98-110, 357-368`).
2. **Verify** (`index.ts:376-397`) — a parquet re-read count, a checksum
   recompute, and a **fresh Postgres count** must all agree; otherwise the
   partition is marked `failed` and stays hot.
3. **Detach** (`index.ts:399-404`) — `ALTER TABLE … DETACH PARTITION` then
   `SET SCHEMA tiered_pending_drop`. **Nothing is dropped.** A `DROP` is a
   separate owner-gated act after the restore drill (`index.ts:14-16`).

### Restricted kinds & lake exclusions

- `RESTRICTED_OBSERVATION_KINDS = {"desktop.guard_audit"}` export to
  `lake/restricted/…` under the same manifest/verify, outside the analytics
  path (`index.ts:29, 218-230`).
- `LAKE_EXCLUDED_TABLES = ["ai_generation_content", "ai_acceptance_events"]`
  **never** export (`index.ts:31-34`, pinned by test).

### Jobs

Queue `retention-tiering` (`index.ts:569`), scheduled daily at `40 4 * * *`
(`index.ts:580-582`); worker `startTieringWorker` (`index.ts:584-597`). It is a
no-op until roughly 2027-01, since data collection starts 2026-07.

### Restore drill

`runRestoreDrill` (`index.ts:472-567`; CLI `tiering:restore-drill`,
`cli.ts:860-876`): rebuilds the partition **from parquet alone** (general +
restricted merged via DuckDB → NDJSON → `jsonb_populate_recordset` into a
`LIKE … INCLUDING ALL` staging table), proves counts identical both to the
manifest and to the parked pre-detach table, then re-attaches. The parked
original is left untouched — proving the lake alone suffices. This drill gates
any `DROP`.

## Partition management

`apps/runtime/src/services/observations-partitions.ts`.

- **Cadence:** daily at **03:10 UTC** (`10 3 * * *`), clear of the 02:00/02:30
  cleanup jobs and the hourly :15 disk check (`observations-partitions.ts:36-43`).
  Queue `observations.partitions.ensure` (`:22`).
- **Behavior** (`runObservationsPartitionCheck`, `:45-93`): pre-creates **both**
  `observations` and `domain_events` partitions `monthsAhead = 3` (via
  `ensureObservationPartitions` / `ensureDomainEventPartitions`), then computes
  the minimum lead across both.
- **Target / floor:** `LEAD_TARGET_MONTHS = 3`, `LEAD_FLOOR_MONTHS = 2`
  (`:24-25`). If pre-creation fails, or lead < 2, it pages the owner via
  `notifyOfapiGlobalIncident({kind:"observations_partitions"})`; otherwise it
  resolves the incident (`:77-90`).
- **Naming / creation** (`repositories/observations.ts:263-299`): partitions are
  `observations_<YYYY>_<MM>` (zero-padded), created idempotently with
  `CREATE TABLE IF NOT EXISTS "<name>" PARTITION OF "observations" FOR VALUES
  FROM ('YYYY-MM-01') TO (next-month)`, from the current month through
  `monthsAhead` out. `getObservationPartitionLeadMonths` counts consecutive
  existing forward partitions via `to_regclass` until the first gap
  (`observations.ts:305-321`).
- **Fail-loud:** an insert targeting a missing partition fails loudly (a webhook
  surfaces it as a 5xx that the vendor retries) — never a silent drop
  (`observations-partitions.ts:1-6`).
