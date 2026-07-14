-- A re-run of an interrupted erasure must resolve the earlier same-scope
-- attempt, rather than leaving an apparently live tombstone forever. Attempts
-- from other scopes are deliberately unrelated. The service serializes every
-- filesystem + database erasure execution with one global advisory lock.
alter table erasure_log
  add column resolution_kind text,
  add column resolved_at timestamptz,
  add column superseded_by_id bigint,
  add column execution_protocol text;

update erasure_log
set resolution_kind = 'completed',
    resolved_at = completed_at
where completed_at is not null;

alter table erasure_log
  add constraint erasure_log_resolution_kind_check
    check (resolution_kind is null or resolution_kind in ('completed', 'superseded')),
  add constraint erasure_log_execution_protocol_check
    check (execution_protocol is null or execution_protocol = 'global-erasure-lock-v1'),
  add constraint erasure_log_resolution_shape_check
    check (
      (resolution_kind is null and resolved_at is null and superseded_by_id is null)
      or (resolution_kind = 'completed' and completed_at is not null
          and resolved_at is not null and superseded_by_id is null)
      or (resolution_kind = 'superseded' and completed_at is null
          and resolved_at is not null and superseded_by_id is not null)
    ),
  add constraint erasure_log_superseded_by_fk
    foreign key (superseded_by_id) references erasure_log(id) on delete restrict;

create index erasure_log_unresolved_scope_idx
  on erasure_log (scope_type, scope_ref, started_at, id)
  where dry_run = false and resolution_kind is null;
