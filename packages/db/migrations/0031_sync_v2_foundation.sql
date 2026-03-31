do $$
begin
  create type sync_task as enum (
    'light',
    'followers',
    'transactions',
    'top_spenders',
    'subscribers',
    'dm_conversations',
    'dm_messages',
    'followers_reconcile'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_task_status as enum (
    'idle',
    'queued',
    'running',
    'retry_wait',
    'blocked',
    'paused'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_operation_source as enum (
    'scheduled',
    'manual',
    'onboarding',
    'recovery',
    'anomaly',
    'reset'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_work_class as enum (
    'live',
    'history',
    'maintenance'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists sync_operations (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  task sync_task not null,
  generation bigint not null,
  source sync_operation_source not null,
  requested_by_actor text,
  requested_by_user_id bigint references users(id) on delete set null,
  request_payload jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  constraint sync_operations_account_task_generation_uniq
    unique (platform_account_id, task, generation)
);

create index if not exists sync_operations_account_requested_idx
  on sync_operations (platform_account_id, requested_at desc, id desc);

create table if not exists sync_tasks (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  task sync_task not null,
  status sync_task_status not null default 'idle',
  desired_generation bigint not null default 0,
  running_generation bigint,
  applied_generation bigint not null default 0,
  schedule_interval_seconds integer not null check (schedule_interval_seconds > 0),
  slot_offset_seconds integer not null check (slot_offset_seconds >= 0),
  last_scheduled_slot bigint not null default -1,
  last_requested_at timestamptz,
  last_enqueued_at timestamptz,
  last_started_at timestamptz,
  last_progress_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  retry_class text,
  retry_at timestamptz,
  blocker_type text,
  blocker_code text,
  blocker_reason text,
  blocked_since timestamptz,
  current_phase text,
  current_work_class sync_work_class,
  progress_payload jsonb not null default '{}'::jsonb,
  lease_owner text,
  lease_token text,
  lease_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_code text,
  last_error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (platform_account_id, task),
  check (slot_offset_seconds < schedule_interval_seconds),
  check (desired_generation >= applied_generation)
);

create index if not exists sync_tasks_freshness_idx
  on sync_tasks (task, last_success_at);

create index if not exists sync_tasks_lease_idx
  on sync_tasks (status, lease_expires_at)
  where status = 'running';

create index if not exists sync_tasks_runnable_idx
  on sync_tasks (status, retry_at, platform_account_id, task)
  where desired_generation > applied_generation;

create index if not exists sync_tasks_schedule_idx
  on sync_tasks (status, last_scheduled_slot, platform_account_id, task)
  where status <> 'paused';

create table if not exists sync_cursors (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  task sync_task not null,
  cursor_text text,
  cursor_timestamp timestamptz,
  cursor_generation bigint,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  last_successful_run_id bigint references sync_runs(id) on delete set null,
  last_successful_at timestamptz,
  primary key (platform_account_id, task)
);

alter table sync_runs
  add column if not exists operation_id bigint references sync_operations(id) on delete set null,
  add column if not exists task sync_task,
  add column if not exists generation bigint,
  add column if not exists lease_token text;

create index if not exists sync_runs_operation_idx
  on sync_runs (operation_id, started_at desc, id desc)
  where operation_id is not null;

alter table sync_run_events
  add column if not exists operation_id bigint references sync_operations(id) on delete set null,
  add column if not exists task sync_task,
  add column if not exists generation bigint,
  add column if not exists lease_token text;

create index if not exists sync_run_events_operation_idx
  on sync_run_events (operation_id, emitted_at desc, id desc)
  where operation_id is not null;

alter table sync_request_attempts
  add column if not exists operation_id bigint references sync_operations(id) on delete set null,
  add column if not exists task sync_task,
  add column if not exists generation bigint;

create index if not exists sync_request_attempts_operation_idx
  on sync_request_attempts (operation_id, started_at desc, id desc)
  where operation_id is not null;

with legacy_rows as (
  select sss.platform_account_id,
         sss.stream::text::sync_task as task,
         case
           when sss.status in ('paused', 'disabled') then 'paused'::sync_task_status
           when sss.status = 'auth_failed' then 'blocked'::sync_task_status
           when sss.desired_revision > sss.satisfied_revision and sss.backoff_until > now()
             then 'retry_wait'::sync_task_status
           when sss.desired_revision > sss.satisfied_revision then 'queued'::sync_task_status
           else 'idle'::sync_task_status
         end as status,
         sss.desired_revision as desired_generation,
         sss.satisfied_revision as applied_generation,
         sss.cadence_seconds as schedule_interval_seconds,
         sss.slot_offset_seconds,
         greatest(
           -1,
           floor(
             (
               extract(epoch from sss.next_due_at) - sss.slot_offset_seconds
             ) / sss.cadence_seconds
           )::bigint - 1
         ) as last_scheduled_slot,
         sss.desired_at as last_requested_at,
         sss.last_enqueued_at,
         sss.last_started_at,
         coalesce(
           sss.last_finished_at,
           sss.last_started_at,
           sss.last_enqueued_at,
           sss.desired_at,
           sss.last_succeeded_at,
           sss.last_failed_at
         ) as last_progress_at,
         sss.last_finished_at,
         sss.last_succeeded_at as last_success_at,
         sss.last_failed_at as last_failure_at,
         case
           when sss.backoff_until > now() and sss.last_error_code = 'http_429' then 'rate_limit'
           when sss.backoff_until > now() and sss.last_error_code like 'http_5%' then 'provider_5xx'
           when sss.backoff_until > now() and sss.status = 'auth_failed' then 'auth'
           when sss.backoff_until > now() then 'transient_network'
           else null
         end as retry_class,
         case
           when sss.backoff_until > now() then sss.backoff_until
           else null
         end as retry_at,
         case
           when sss.status = 'auth_failed' then 'auth'
           else null
         end as blocker_type,
         case
           when sss.status = 'auth_failed' then 'credentials_invalid'
           else null
         end as blocker_code,
         case
           when sss.status = 'auth_failed' then coalesce(sss.last_error_summary, 'Credentials must be re-verified')
           when sss.status = 'disabled' then 'Legacy sync row was disabled'
           else null
         end as blocker_reason,
         case
           when sss.status in ('auth_failed', 'disabled') then coalesce(sss.last_failed_at, sss.updated_at)
           else null
         end as blocked_since,
         case
           when sss.stream in ('dm_messages') then 'history'::sync_work_class
           when sss.stream in ('top_spenders', 'followers_reconcile') then 'maintenance'::sync_work_class
           else 'live'::sync_work_class
         end as current_work_class,
         sss.consecutive_failures,
         sss.last_error_code,
         sss.last_error_summary,
         sss.created_at,
         sss.updated_at
  from sync_stream_state sss
)
insert into sync_tasks (
  platform_account_id,
  task,
  status,
  desired_generation,
  applied_generation,
  schedule_interval_seconds,
  slot_offset_seconds,
  last_scheduled_slot,
  last_requested_at,
  last_enqueued_at,
  last_started_at,
  last_progress_at,
  last_finished_at,
  last_success_at,
  last_failure_at,
  retry_class,
  retry_at,
  blocker_type,
  blocker_code,
  blocker_reason,
  blocked_since,
  current_work_class,
  consecutive_failures,
  last_error_code,
  last_error_summary,
  created_at,
  updated_at
)
select platform_account_id,
       task,
       status,
       desired_generation,
       applied_generation,
       schedule_interval_seconds,
       slot_offset_seconds,
       last_scheduled_slot,
       last_requested_at,
       last_enqueued_at,
       last_started_at,
       last_progress_at,
       last_finished_at,
       last_success_at,
       last_failure_at,
       retry_class,
       retry_at,
       blocker_type,
       blocker_code,
       blocker_reason,
       blocked_since,
       current_work_class,
       consecutive_failures,
       last_error_code,
       last_error_summary,
       created_at,
       updated_at
from legacy_rows
on conflict (platform_account_id, task) do nothing;

insert into sync_cursors (
  platform_account_id,
  task,
  cursor_text,
  cursor_timestamp,
  state,
  updated_at,
  last_successful_run_id,
  last_successful_at
)
select cp.platform_account_id,
       cp.stream::text::sync_task as task,
       cp.cursor_text,
       cp.cursor_timestamp,
       cp.state,
       cp.updated_at,
       cp.last_successful_run_id,
       cp.last_successful_at
from sync_checkpoints cp
where cp.stream <> 'cleanup'
on conflict (platform_account_id, task) do nothing;

with pending_operations as (
  select sss.platform_account_id,
         sss.stream::text::sync_task as task,
         gs.generation,
         case sss.pending_reason
           when 'manual' then 'manual'::sync_operation_source
           when 'onboarding' then 'onboarding'::sync_operation_source
           when 'recovery' then 'recovery'::sync_operation_source
           when 'anomaly' then 'anomaly'::sync_operation_source
           else 'scheduled'::sync_operation_source
         end as source,
         coalesce(sss.request_payload, '{}'::jsonb) as request_payload,
         coalesce(sss.desired_at, sss.updated_at, now()) as requested_at
  from sync_stream_state sss
  cross join lateral generate_series(sss.satisfied_revision + 1, sss.desired_revision) as gs(generation)
  where sss.desired_revision > sss.satisfied_revision
)
insert into sync_operations (
  platform_account_id,
  task,
  generation,
  source,
  requested_by_actor,
  request_payload,
  requested_at
)
select platform_account_id,
       task,
       generation,
       source,
       'migration_backfill',
       request_payload,
       requested_at
from pending_operations
on conflict (platform_account_id, task, generation) do nothing;

update sync_runs
set task = sync_runs.stream::text::sync_task
where task is null
  and stream <> 'cleanup';

update sync_request_attempts
set task = sync_request_attempts.stream::text::sync_task
where task is null
  and stream <> 'cleanup';

update sync_run_events
set task = sync_run_events.stream::text::sync_task
where task is null
  and stream <> 'cleanup';

update sync_runs sr
set operation_id = so.id,
    generation = coalesce(sr.generation, so.generation)
from sync_operations so
where sr.task is not null
  and sr.operation_id is null
  and so.platform_account_id = sr.platform_account_id
  and so.task = sr.task
  and so.generation = (
    select max(so2.generation)
    from sync_operations so2
    where so2.platform_account_id = sr.platform_account_id
      and so2.task = sr.task
      and so2.requested_at <= sr.started_at
  );

update sync_request_attempts a
set operation_id = sr.operation_id,
    generation = coalesce(a.generation, sr.generation)
from sync_runs sr
where a.sync_run_id = sr.id
  and (a.operation_id is null or a.generation is null);

update sync_run_events e
set operation_id = sr.operation_id,
    generation = coalesce(e.generation, sr.generation),
    lease_token = coalesce(e.lease_token, sr.lease_token)
from sync_runs sr
where e.sync_run_id = sr.id
  and (e.operation_id is null or e.generation is null or e.lease_token is null);
