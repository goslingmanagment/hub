-- agency-hub:no-transaction
-- 0127: G5 slice 3b — the index that lets an erasure PROVE a catalog body has
-- no surviving envelope reference.
--
-- Migration 0124 deliberately shipped the reference columns with NO index:
--
--   "This is a WRITE-ONLY stage: no query resolves a payload through them ...
--    The pointer slice, which does resolve reads through these columns, is
--    where an index is earned by a real query plan."
--
-- This is that slice, and this is that query plan. The erasure's catalog sweep
-- (packages/db/src/repositories/capture-payload-erasure.ts) may delete a body
-- only when NO envelope references it any more, and it decides that with an
-- existence probe per candidate object:
--
--   not exists (select 1 from observations e
--               where e.payload_bucket_month = $1 and e.payload_object_id = $2)
--
-- Unindexed, that probe is a sequential scan of `observations` — the largest
-- relation in the system, ~19 GB of heap+TOAST across its monthly partitions —
-- ONCE PER CANDIDATE OBJECT. Erasure is a rare break-glass act, but "rare" does
-- not make an unbounded scan per object acceptable: the run would not finish,
-- and an erasure that does not finish is an erasure that did not happen.
--
-- PARTIAL, on `payload_object_id IS NOT NULL`. The columns are null for every
-- row written before slice 1 and for every page outside the dual-write canary,
-- so the index covers only the rows that can ever be an answer. That is what
-- keeps it small enough to be worth having on a box whose free space is the
-- reason this project exists — and the erasure probe implies the predicate by
-- construction (it always compares the column to a non-null object id), so the
-- planner may use it.
--
-- COLUMN ORDER (bucket_month, object_id) matches the catalog's own primary key
-- and the probe's equality pair; either order would serve the probe, and this
-- one also serves a future "everything in this month" sweep for the cold tier.
--
-- CONCURRENTLY IS NOT OPTIONAL. A partial index still evaluates its predicate
-- over the whole heap, so an ordinary CREATE INDEX would hold ACCESS EXCLUSIVE
-- over every `observations` partition while capture blocks behind it —
-- capture-first (DP 7) forbids that. PostgreSQL cannot CREATE INDEX
-- CONCURRENTLY on a partitioned parent, so `observations` follows the 0096/0126
-- shape exactly: create the parent's empty metadata index, build every
-- CURRENTLY ATTACHED leaf concurrently, then attach the leaves. Partitions
-- created LATER inherit the index automatically as PARTITION OF children.
-- `sync_raw_payloads` is not partitioned and takes the plain concurrent form.
--
-- Tolerates already-tiered/detached monthlies; every operation is idempotent
-- across a crash before the ledger insert.

-- agency-hub:statement
create index if not exists observations_payload_object_ref_idx
  on only observations (payload_bucket_month, payload_object_id)
  where payload_object_id is not null;

-- A backend/process failure during CREATE INDEX CONCURRENTLY can leave an
-- invalid leaf index behind. IF NOT EXISTS would otherwise keep skipping that
-- unusable shell forever, so remove only invalid indexes with our exact
-- deterministic leaf name before rebuilding them.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format(
  'drop index concurrently if exists %I.%I',
  index_namespace.nspname,
  child_index.relname
) as statement
from pg_inherits inheritance
join pg_class parent on parent.oid = inheritance.inhparent
join pg_class child on child.oid = inheritance.inhrelid
join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
join pg_class child_index
  on child_index.relname = child.relname || '_payload_object_ref_idx'
join pg_namespace index_namespace on index_namespace.oid = child_index.relnamespace
join pg_index index_state
  on index_state.indexrelid = child_index.oid
 and index_state.indrelid = child.oid
where parent.oid = 'observations'::regclass
  and child.relkind = 'r'
  and child_namespace.nspname = 'public'
  and index_namespace.nspname = child_namespace.nspname
  and not index_state.indisvalid
order by child.relname;

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format(
  $index$
    create index concurrently if not exists %I
    on %I.%I (payload_bucket_month, payload_object_id)
    where payload_object_id is not null
  $index$,
  child.relname || '_payload_object_ref_idx',
  namespace.nspname,
  child.relname
) as statement
from pg_inherits inheritance
join pg_class parent on parent.oid = inheritance.inhparent
join pg_class child on child.oid = inheritance.inhrelid
join pg_namespace namespace on namespace.oid = child.relnamespace
where parent.oid = 'observations'::regclass
  and child.relkind = 'r'
order by child.relname;

-- agency-hub:statement
do $attach_payload_ref_indexes$
declare
  partition_name text;
  child_index_name text;
begin
  for partition_name in
    select child.relname
    from pg_inherits inheritance
    join pg_class parent on parent.oid = inheritance.inhparent
    join pg_class child on child.oid = inheritance.inhrelid
    join pg_namespace namespace on namespace.oid = child.relnamespace
    where parent.oid = 'observations'::regclass
      and namespace.nspname = 'public'
      and child.relkind = 'r'
  loop
    child_index_name := partition_name || '_payload_object_ref_idx';
    if to_regclass(child_index_name) is null then
      raise exception 'missing payload reference index for attached partition %', partition_name;
    end if;
    if not exists (
      select 1 from pg_inherits
      where inhparent = 'observations_payload_object_ref_idx'::regclass
        and inhrelid = to_regclass(child_index_name)
    ) then
      execute format(
        'alter index observations_payload_object_ref_idx attach partition %I',
        child_index_name
      );
    end if;
  end loop;
end
$attach_payload_ref_indexes$;

-- agency-hub:statement
create index concurrently if not exists sync_raw_payloads_payload_object_ref_idx
  on sync_raw_payloads (payload_bucket_month, payload_object_id)
  where payload_object_id is not null;
