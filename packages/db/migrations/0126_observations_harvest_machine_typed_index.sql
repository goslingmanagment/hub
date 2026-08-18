-- agency-hub:no-transaction
-- 0126: G5 slice 3a — the typed-column twin of the harvest lookup index.
--
-- Migration 0096 built `observations_harvest_machine_client_event_idx` over the
-- EXPRESSION `(payload->>'machineId', split_part(idempotency_key, ':', 2))`.
-- 0125 gave that expression a typed column, so the lookup
-- (hasHarvestObservationClientEvent) now reads
--
--     harvest_machine_id = $1
--     OR (harvest_machine_id IS NULL AND payload->>'machineId' = $1)
--
-- rather than a `coalesce(...)`, because coalesce over two columns is not
-- indexable and would have turned a bounded probe into a scan of the largest
-- table in the system. The two arms are disjoint by construction and each has
-- its own index: 0096's serves the legacy arm (its extra `harvest_machine_id IS
-- NULL` becomes a filter), and this one serves the typed arm. Both are needed
-- until the historical rewrite has populated every row's typed column; only then
-- does 0096's expression index become droppable.
--
-- The predicate and the second column are IDENTICAL to 0096's on purpose. The
-- planner may only use a partial index when the query's own clauses imply the
-- index predicate, so the twin has to be implied by exactly the same clause set
-- the original is — anything narrower or wider and one of the two arms silently
-- stops being index-backed.
--
-- CONCURRENTLY IS NOT OPTIONAL HERE. A partial index still requires a full heap
-- scan to evaluate its predicate, so an ordinary CREATE INDEX would hold ACCESS
-- EXCLUSIVE over every `observations` partition — tens of GB — while capture
-- blocks behind it. Capture-first (DP 7) forbids that. PostgreSQL cannot
-- CREATE INDEX CONCURRENTLY on a partitioned parent, so this follows 0096's
-- shape exactly: create the parent's empty metadata index, ask the runner to
-- build every CURRENTLY ATTACHED leaf concurrently, then attach the leaves.
-- Tolerates already-tiered/detached monthlies; every operation is idempotent
-- across a crash before the ledger insert.

-- agency-hub:statement
create index if not exists observations_harvest_machine_typed_idx
  on only observations (
    harvest_machine_id,
    (split_part(idempotency_key, ':', 2))
  )
  where source = 'client_capture'
    and producer like 'desktop-harvest@%'
    and kind like 'harvest.%';

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
  on child_index.relname = child.relname || '_harvest_machine_typed_idx'
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
    on %I.%I (harvest_machine_id, (split_part(idempotency_key, ':', 2)))
    where source = 'client_capture'
      and producer like 'desktop-harvest@%%'
      and kind like 'harvest.%%'
  $index$,
  child.relname || '_harvest_machine_typed_idx',
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
do $attach_typed_harvest_indexes$
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
    child_index_name := partition_name || '_harvest_machine_typed_idx';
    if to_regclass(child_index_name) is null then
      raise exception 'missing typed harvest lookup index for attached partition %', partition_name;
    end if;
    if not exists (
      select 1 from pg_inherits
      where inhparent = 'observations_harvest_machine_typed_idx'::regclass
        and inhrelid = to_regclass(child_index_name)
    ) then
      execute format(
        'alter index observations_harvest_machine_typed_idx attach partition %I',
        child_index_name
      );
    end if;
  end loop;
end
$attach_typed_harvest_indexes$;
