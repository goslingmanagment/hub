> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Retention, Erasure, Tiering, and Partitions

This map covers the code that removes, anonymizes, archives, or relocates data.
The main anchors are `tests/retention-deleters.test.ts`,
`apps/runtime/src/services/erasure/index.ts`,
`apps/runtime/src/services/tiering/index.ts`, and
`apps/runtime/src/services/observations-partitions.ts`.

## Deletion inventory and timed cleanup

`tests/retention-deleters.test.ts` scans TypeScript under
`apps/runtime/src` and `packages/db/src/repositories` for SQL-delete syntax. Its
allowlist contains 28 files. The scan excludes Fastify `server.delete(...)`
route registration. It is a source-text policy pin; it does not discover
deletion performed outside the scanned directories or through different SQL
spellings.

The test header identifies the timed deleters that touch retained data:

- sync HTTP attempts, run events, and completed sync runs older than 30 days;
- operations metric samples older than 90 days;
- `page_dm_messages`, only when page-DM pruning is enabled and archive coverage
  permits it;
- expired terminal typing commands;
- expired pending device-token custody rows;
- pg-boss archival data.

Authentication session expiry and projection/rebuild cleanup also appear among
the sanctioned deleter files. The break-glass erasure service is the listed
non-scheduled deletion mechanism.

Raw business-fact retention is set to 36,500 days in the sync and OFAPI paths.
`packages/shared/src/config-registry.ts` declares `pageDmPruneEnabled` with a
default of `false`; `apps/runtime/src/services/page-dm-retention.ts` permits the
prune only when the effective value is exactly `true`. The projection and sync
writers additionally check archive coverage before removing hot DM rows.

## Governed erasure

`apps/runtime/src/services/erasure/index.ts` accepts three scope shapes:

| Scope | Selector |
|---|---|
| fan | platform plus vendor fan reference |
| page | mutable page label, resolved to immutable page IDs before execution |
| model | model slug, resolved to its page IDs |

An erasure plan enumerates targets in three planes:

- **hot**: operational and projection tables in Postgres;
- **ledger**: attached `observations` and `domain_events` partitions plus
  detached partitions parked in `tiered_pending_drop`;
- **lake**: Parquet files rewritten through DuckDB with matching rows filtered
  out and manifests re-counted and re-checksummed.

Fan erasure deletes captured identity and derived rows but anonymizes matching
transactions so the financial amounts remain. Page and model erasure remove
the selected pages' transaction rows. Catalog records for pages, models, and
users are not erased by this service.

The fan-lineage collector retains observations referenced by another fan's
domain events and reports their count as `sharedObservations`. A curated
foreign-key check fails when an unhandled non-cascading reference to `fans`
appears.

### Execution protocol

`executeErasure` takes a global session-level Postgres advisory lock through
`withErasureExecutionLock`. That lock spans the database work and the later
filesystem rewrite, serializing erasures that could touch the same Parquet
files.

Execution then follows this order:

1. Resolve the scope and store a pre-delete `erasure_log` tombstone containing
   the resolved page IDs and the current execution protocol.
2. Acquire exclusive archive-fence locks for those page IDs.
3. Apply hot and ledger targets in one database transaction.
4. Rewrite lake targets after that transaction commits.
5. Complete the erasure log with actual counts and supersede only compatible,
   unresolved attempts for the same immutable scope.
6. Record an audit event and an operator observation whose `account_id` is
   null, keeping the erasure's own audit trail outside the erased account.

The writer-side fence is implemented in
`packages/db/src/repositories/erasure-fence.ts`. Archive writers take shared
locks and re-check completed or in-progress erasure records so transcript data
does not reappear after a scoped erasure. The stored resolved page IDs avoid
depending on a page label after it has been renamed.

`apps/runtime/src/cli.ts` exposes `erasure:run`. Planning is the default. An
irreversible run requires `--execute` and a `--confirm` value exactly equal to
the scope reference printed by the dry run, plus an existing initiating user.

## Partition tiering

`apps/runtime/src/services/tiering/index.ts` tiers only monthly partitions of
`observations` and `domain_events`. A partition becomes eligible after the
six-month hot window.

For each eligible partition the service:

1. exports rows through NDJSON and DuckDB to Parquet;
2. writes a manifest with row counts, restricted-row counts, ID bounds, and a
   SHA-256 checksum;
3. re-reads the Parquet count, recomputes the checksum, and compares both with
   a fresh Postgres count;
4. detaches the verified partition and moves it into the
   `tiered_pending_drop` schema.

The tiering service does not drop the parked table. Its restore drill rebuilds
a partition from Parquet, compares the rebuilt count with both the manifest and
the parked source, and reattaches the restored partition.

Observation kind `desktop.guard_audit` is exported under the restricted lake
path. `ai_generation_content` and `ai_acceptance_events` are declared lake
exclusions and are not tiered by this service.

The pg-boss queue is `retention-tiering`; its schedule is `40 4 * * *`.

## Forward partition management

`apps/runtime/src/services/observations-partitions.ts` schedules
`observations.partitions.ensure` at `10 3 * * *` UTC. Each run asks the database
repositories to pre-create partitions for both `observations` and
`domain_events` three months ahead.

The service measures the consecutive lead across both ledgers. A creation
failure or lead below the two-month floor opens an
`observations_partitions` incident through the notification service; a healthy
run resolves it. Missing partitions remain a database insert error rather than
being converted into a dropped capture.
