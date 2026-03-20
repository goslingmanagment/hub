do $$
begin
  create type notification_incident_kind as enum ('auth_failed', 'proxy_failed', 'stream_failed_threshold');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type notification_incident_status as enum ('open', 'resolved');
exception
  when duplicate_object then null;
end
$$;

create table if not exists notification_incidents (
  id bigserial primary key,
  incident_key text not null unique,
  kind notification_incident_kind not null,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  stream sync_stream,
  status notification_incident_status not null default 'open',
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  error_code text,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists notification_incidents_account_status_idx
  on notification_incidents (platform_account_id, status);

create index if not exists notification_incidents_status_seen_idx
  on notification_incidents (status, last_seen_at);
