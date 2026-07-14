-- agency-hub:no-transaction
-- Compatibility lookup for facts accepted before harvest dedupe moved from
-- <principal>:<event> to <machine>:<event>. PostgreSQL cannot CREATE INDEX
-- CONCURRENTLY on a partitioned parent. Create its empty metadata index, ask
-- the runner to build every CURRENTLY ATTACHED leaf concurrently, then attach
-- those matching leaf indexes. This also tolerates already-tiered/detached
-- monthlies. Every operation is idempotent across a crash before ledger insert.

-- agency-hub:statement
create index if not exists observations_harvest_machine_client_event_idx
  on only observations (
    (payload->>'machineId'),
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
  on child_index.relname = child.relname || '_harvest_machine_client_event_idx'
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
    on %I.%I ((payload->>'machineId'), (split_part(idempotency_key, ':', 2)))
    where source = 'client_capture'
      and producer like 'desktop-harvest@%%'
      and kind like 'harvest.%%'
  $index$,
  child.relname || '_harvest_machine_client_event_idx',
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
do $attach_harvest_indexes$
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
    child_index_name := partition_name || '_harvest_machine_client_event_idx';
    if to_regclass(child_index_name) is null then
      raise exception 'missing harvest lookup index for attached partition %', partition_name;
    end if;
    if not exists (
      select 1 from pg_inherits
      where inhparent = 'observations_harvest_machine_client_event_idx'::regclass
        and inhrelid = to_regclass(child_index_name)
    ) then
      execute format(
        'alter index observations_harvest_machine_client_event_idx attach partition %I',
        child_index_name
      );
    end if;
  end loop;
end
$attach_harvest_indexes$;
