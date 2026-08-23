-- agency-hub:no-transaction
-- 0144: the golden-signal health-floor probes stop reading the observations
-- heap.
--
-- `computeHealthFloorBacklogMs` asks, once a minute for each of the ~80
-- (family, kind) pairs in HEALTH_FLOOR_REGISTRY, for the oldest observation
-- still below the family's parse-version floor. Only `(kind, received_at)` was
-- indexed, so `source` and `parse_version` were HEAP filters. Measured on prod
-- (EXPLAIN ANALYZE, read-only, 2026-08-23) for the webhook family alone:
--
--   Index Scan using observations_2026_07_kind_received_at_idx  (rows=0, loops=16)
--     Filter: ((parse_version < 3) AND (source = 'webhook'::text))
--     Rows Removed by Filter: 14236
--     Buffers: shared hit=37629 read=82714
--   ...
--   Execution Time: 4801.479 ms
--
-- One family, 4.8 s and ~200 000 blocks — to learn that it is caught up. Every
-- kind of that family got a full walk of its rows in EVERY partition, because
-- the only thing that could exclude a row was a column the index did not carry.
--
-- This index carries all four columns, so `(parse_version, source, kind)`
-- become index conditions and `received_at` is then already in order: the probe
-- is an index min-scan (`order by received_at limit 1`), and a caught-up pair
-- is an empty range instead of a table walk. The column ORDER is the whole
-- point — the three equality columns first, the ordering column last.
--
-- `parse_version` LEADS, and that is a deliberate second constraint rather than
-- a free choice. An earlier revision of this migration led with `source`, and
-- the planner promptly started using it for the G5 harvest lookup
-- (`hasHarvestObservationClientEvent`), which carries `source =
-- 'client_capture'` and nothing else this index could serve: a bounded probe of
-- 0096/0126's partial indexes turned into a bitmap scan of every
-- `client_capture` row with the real predicate demoted to a heap filter
-- (caught by tests/capture-queryable-columns.integration.test.ts). Leading with
-- `parse_version` makes that impossible by construction — the harvest lookup
-- has no `parse_version` clause, so this index cannot even be considered for
-- it, and the same holds for every other reader of `observations` that is not
-- asking "what is still pending". A future column reorder here must re-check
-- that test.
--
-- `observations` is PARTITIONED and PostgreSQL cannot CREATE INDEX CONCURRENTLY
-- on a partitioned parent; an ordinary CREATE INDEX would hold ACCESS EXCLUSIVE
-- over every partition while capture (DP 7) blocks behind it. So this follows
-- 0096/0126 exactly: create the parent's empty metadata index ON ONLY, build
-- every currently-attached leaf concurrently, then attach the leaves. Tolerates
-- already-tiered/detached monthlies; every step is idempotent across a crash
-- before the ledger insert. FUTURE partitions need no wiring: they are created
-- with `create table … partition of observations`
-- (packages/db/src/repositories/observations.ts), and PostgreSQL creates the
-- matching leaf index for every partitioned index on the parent by itself.

-- agency-hub:statement
create index if not exists observations_health_floor_idx
  on only observations (parse_version, source, kind, received_at);

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
  on child_index.relname = child.relname || '_health_floor_idx'
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
    on %I.%I (parse_version, source, kind, received_at)
  $index$,
  child.relname || '_health_floor_idx',
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
do $attach_health_floor_indexes$
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
    child_index_name := partition_name || '_health_floor_idx';
    if to_regclass(child_index_name) is null then
      raise exception 'missing health-floor index for attached partition %', partition_name;
    end if;
    if not exists (
      select 1 from pg_inherits
      where inhparent = 'observations_health_floor_idx'::regclass
        and inhrelid = to_regclass(child_index_name)
    ) then
      execute format(
        'alter index observations_health_floor_idx attach partition %I',
        child_index_name
      );
    end if;
  end loop;
end
$attach_health_floor_indexes$;
