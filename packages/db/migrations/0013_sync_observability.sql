do $$
begin
  alter type sync_run_status add value if not exists 'skipped';
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_request_attempt_state as enum ('started', 'success', 'retry', 'failed');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_request_failure_kind as enum ('timeout', 'transport', 'http', 'provider');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_event_severity as enum ('info', 'warn', 'error');
exception
  when duplicate_object then null;
end
$$;

create table if not exists sync_request_attempts (
  id bigserial primary key,
  sync_run_id bigint not null references sync_runs(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  provider platform not null,
  stream sync_stream not null,
  operation text not null,
  logical_request_id text not null,
  attempt_number integer not null,
  state sync_request_attempt_state not null,
  failure_kind sync_request_failure_kind,
  http_status integer,
  retry_delay_ms integer,
  duration_ms integer,
  request_shape jsonb not null default '{}'::jsonb,
  response_shape jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists sync_request_attempts_run_started_idx
  on sync_request_attempts(sync_run_id, started_at);

create index if not exists sync_request_attempts_logical_idx
  on sync_request_attempts(sync_run_id, logical_request_id, attempt_number);

create index if not exists sync_request_attempts_retention_idx
  on sync_request_attempts(started_at);

create table if not exists sync_run_events (
  id bigserial primary key,
  sync_run_id bigint not null references sync_runs(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  provider platform not null,
  stream sync_stream not null,
  event_type text not null,
  severity sync_event_severity not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  emitted_at timestamptz not null default now()
);

create index if not exists sync_run_events_run_emitted_idx
  on sync_run_events(sync_run_id, emitted_at);

create index if not exists sync_run_events_emitted_idx
  on sync_run_events(emitted_at);
