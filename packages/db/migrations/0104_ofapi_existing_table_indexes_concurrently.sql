-- agency-hub:no-transaction
-- OF Mirror indexes over retained tables. Every statement is idempotent: a
-- crash can leave an invalid concurrent index shell, so each physical index is
-- conditionally dropped when invalid before CREATE INDEX CONCURRENTLY retries.

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists message_archive_ofapi_native_order_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('message_archive_ofapi_native_order_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists message_archive_ofapi_native_order_idx
  on message_archive (account_id, conversation_ref, native_message_id desc)
  where platform = 'onlyfans' and deleted_at is null;

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists message_archive_shadow_ofapi_native_order_idx' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('message_archive_shadow_ofapi_native_order_idx')
    and not index_state.indisvalid
);

-- agency-hub:statement
create index concurrently if not exists message_archive_shadow_ofapi_native_order_idx
  on message_archive_shadow (account_id, conversation_ref, native_message_id desc)
  where platform = 'onlyfans' and deleted_at is null;

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select 'drop index concurrently if exists ofapi_credit_ledger_attempt_phase_uniq' as statement
where exists (
  select 1
  from pg_class index_relation
  join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid = to_regclass('ofapi_credit_ledger_attempt_phase_uniq')
    and not index_state.indisvalid
);

-- agency-hub:statement
create unique index concurrently if not exists ofapi_credit_ledger_attempt_phase_uniq
  on ofapi_credit_ledger (attempt_id, attempt_entry_phase)
  where attempt_id is not null;

-- PostgreSQL cannot build a partitioned parent index concurrently. Creating
-- the empty metadata index is instant; every currently attached physical leaf
-- is then built concurrently and attached.
-- agency-hub:statement
create index if not exists domain_events_v2_deliverable_account_seq_idx
  on only domain_events (account_id, account_seq)
  where type not in (
    'message.material_observed',
    'capture.coverage_observed',
    'capture.coverage_revoked'
  );

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
  on child_index.relname = child.relname || '_v2_deliverable_account_seq_idx'
join pg_namespace index_namespace on index_namespace.oid = child_index.relnamespace
join pg_index index_state
  on index_state.indexrelid = child_index.oid
 and index_state.indrelid = child.oid
where parent.oid = 'domain_events'::regclass
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
    on %I.%I (account_id, account_seq)
    where type not in (
      'message.material_observed',
      'capture.coverage_observed',
      'capture.coverage_revoked'
    )
  $index$,
  child.relname || '_v2_deliverable_account_seq_idx',
  namespace.nspname,
  child.relname
) as statement
from pg_inherits inheritance
join pg_class parent on parent.oid = inheritance.inhparent
join pg_class child on child.oid = inheritance.inhrelid
join pg_namespace namespace on namespace.oid = child.relnamespace
where parent.oid = 'domain_events'::regclass
  and child.relkind = 'r'
order by child.relname;

-- agency-hub:statement
do $attach_ofapi_domain_event_indexes$
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
    where parent.oid = 'domain_events'::regclass
      and namespace.nspname = 'public'
      and child.relkind = 'r'
  loop
    child_index_name := partition_name || '_v2_deliverable_account_seq_idx';
    if to_regclass(child_index_name) is null then
      raise exception 'missing OF Mirror deliverable index for attached partition %', partition_name;
    end if;
    if not exists (
      select 1 from pg_inherits
      where inhparent = 'domain_events_v2_deliverable_account_seq_idx'::regclass
        and inhrelid = to_regclass(child_index_name)
    ) then
      execute format(
        'alter index domain_events_v2_deliverable_account_seq_idx attach partition %I',
        child_index_name
      );
    end if;
  end loop;
end
$attach_ofapi_domain_event_indexes$;
