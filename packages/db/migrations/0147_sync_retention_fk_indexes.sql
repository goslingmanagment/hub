-- agency-hub:no-transaction
-- 0147: the nightly telemetry sweep stops sequentially scanning 600 MB per
-- deleted run.
--
-- `deleteExpiredSyncObservability` deletes aged `sync_runs`, and PostgreSQL
-- enforces every inbound foreign key of every deleted row before the statement
-- returns. Two of those children reference `sync_runs(id)` ON DELETE SET NULL
-- and neither had an index on the referencing column, so each deleted run cost
-- a full scan of the child. Measured on prod 2026-08-26 (EXPLAIN, read-only):
--
--   explain select 1 from sync_raw_payloads where sync_run_id = 611162;
--     Gather  (cost=1000.00..83535.xx rows=1 width=4)
--       ->  Parallel Seq Scan on sync_raw_payloads
--
-- 607 MB of heap, once per deleted run. With ~3 000 stale runs a night that is
-- the whole of the observed 676–824 s runtime, and it is why
-- `fansly.raw-payload-cleanup` failed four consecutive nights (2026-08-22..25)
-- with `handler execution exceeded 900s`.
--
-- WHY BOTH ARE PARTIAL. A `SET NULL` action only ever probes for rows whose
-- referencing column EQUALS the deleted key, so a NULL row can never be a
-- match: PostgreSQL's own RI query is `... WHERE sync_run_id = $1 FOR KEY
-- SHARE`, which a partial index with `IS NOT NULL` satisfies by implication.
-- On `sync_raw_payloads` that is not a rounding error — 920 153 of 1 670 260
-- rows (55 %) carry no run link at all, because the pointer-only and
-- webhook-lane writers never set one — so the partial index is roughly half the
-- size of the full one and stays out of the way of the hottest insert path in
-- the system. `page_sync_cursors` is 103 rows; its index is measured in
-- kilobytes and exists so that NO `sync_runs` child is left unindexed rather
-- than because those 103 rows are expensive.
--
-- NO INDEX FOR THE RETENTION PREDICATES THEMSELVES. `sync_runs(started_at)`
-- (0070) and `sync_http_attempts(started_at)` and `sync_run_events(emitted_at)`
-- already exist; what stopped them being used was `coalesce(finished_at,
-- started_at) < cutoff`, which is not a clause over an indexed column. That is
-- fixed in the deleter instead of here (it now leads with `started_at <
-- cutoff`, which is implied by the coalesce because `finished_at >=
-- started_at`), because a predicate change costs no disk and no write
-- amplification and an expression index costs both.
--
-- Decision #239 carries the full account; this file is its schema half.
--
-- CONCURRENTLY: `sync_raw_payloads` is the raw capture lane (DP 7). An ordinary
-- CREATE INDEX would hold ACCESS EXCLUSIVE over 21 GB while every Fansly pull
-- blocked behind it. Neither table is partitioned, so no per-leaf dance is
-- needed — this is 0143's shape.

-- A backend/process failure during CREATE INDEX CONCURRENTLY leaves an INVALID
-- index behind, and `if not exists` would then skip that unusable shell
-- forever. Drop it first if (and only if) it is invalid.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname in (
        'sync_raw_payloads_sync_run_idx',
        'page_sync_cursors_last_succeeded_run_idx'
      )
  and n.nspname = 'public'
  and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_raw_payloads_sync_run_idx
  on sync_raw_payloads (sync_run_id)
  where sync_run_id is not null;

-- agency-hub:statement
create index concurrently if not exists page_sync_cursors_last_succeeded_run_idx
  on page_sync_cursors (last_succeeded_run_id)
  where last_succeeded_run_id is not null;
