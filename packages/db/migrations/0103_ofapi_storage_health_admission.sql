-- OF mirror S1 disk admission: durable singleton health sampled by the
-- worker. Governed capture can fail closed when the sample is missing, stale,
-- over the disk threshold, or the filesystem could not be inspected.

create table ofapi_storage_health_state (
  id integer primary key default 1,
  healthy boolean not null,
  breached boolean not null,
  checked_at timestamptz not null,
  used_bytes bigint,
  free_bytes bigint,
  total_bytes bigint,
  error text,
  updated_at timestamptz not null default now(),
  constraint ofapi_storage_health_state_singleton_check check (id = 1),
  constraint ofapi_storage_health_state_nonnegative_check check (
    (used_bytes is null or used_bytes >= 0)
    and (free_bytes is null or free_bytes >= 0)
    and (total_bytes is null or total_bytes >= 0)
  ),
  constraint ofapi_storage_health_state_shape_check check (
    (
      error is null
      and used_bytes is not null
      and free_bytes is not null
      and total_bytes is not null
      and healthy = (not breached)
    )
    or (
      error is not null
      and used_bytes is null
      and free_bytes is null
      and total_bytes is null
      and not healthy
      and not breached
    )
  )
);

alter table ofapi_budget_denial_daily
  drop constraint ofapi_budget_denial_daily_reason_check,
  add constraint ofapi_budget_denial_daily_reason_check check (
    reason in (
      'global_cap', 'scope_cap', 'job_cap', 'manifest_cap',
      'principal_credit_cap', 'principal_call_cap', 'principal_storm_block',
      'credit_floor', 'balance_stale', 'storage_unhealthy',
      'persistent_pause', 'deadline'
    )
  );
