do $$
begin
  alter type sync_stream add value if not exists 'followers_reconcile';
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_target_status as enum ('active', 'paused', 'auth_failed', 'disabled');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type sync_request_reason as enum ('scheduled', 'manual', 'onboarding', 'recovery', 'anomaly');
exception
  when duplicate_object then null;
end
$$;

create table if not exists sync_stream_state (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  stream sync_stream not null,
  status sync_target_status not null default 'active',
  cadence_seconds integer not null check (cadence_seconds > 0),
  slot_offset_seconds integer not null check (slot_offset_seconds >= 0),
  next_due_at timestamptz not null,
  base_priority integer not null check (base_priority between 0 and 100),
  effective_priority integer not null check (effective_priority between 0 and 100),
  pending_reason sync_request_reason not null default 'scheduled',
  desired_revision bigint not null default 0,
  satisfied_revision bigint not null default 0,
  desired_at timestamptz,
  request_payload jsonb,
  backoff_until timestamptz not null default '-infinity'::timestamptz,
  last_enqueued_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_code text,
  last_error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (platform_account_id, stream),
  check (slot_offset_seconds < cadence_seconds),
  check (desired_revision >= satisfied_revision)
);

create index if not exists sync_stream_state_due_idx
  on sync_stream_state (next_due_at asc, platform_account_id asc)
  where status = 'active'
    and desired_revision = satisfied_revision;

create index if not exists sync_stream_state_pending_idx
  on sync_stream_state (effective_priority desc, desired_at asc nulls last, platform_account_id asc, stream asc)
  where status = 'active'
    and desired_revision > satisfied_revision;

create index if not exists sync_stream_state_backoff_idx
  on sync_stream_state (backoff_until asc, platform_account_id asc)
  where status = 'active'
    and desired_revision > satisfied_revision;

create index if not exists sync_stream_state_freshness_idx
  on sync_stream_state (stream, last_succeeded_at);

create table if not exists sync_provider_rate_limits (
  provider platform not null,
  scope text not null,
  egress_key text not null,
  min_spacing_ms integer not null check (min_spacing_ms >= 0),
  next_available_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, scope, egress_key)
);

insert into sync_provider_rate_limits (provider, scope, egress_key, min_spacing_ms)
values
  ('fansly', 'global', 'global', 2600),
  ('fansly', 'followers_page', 'global', 5000),
  ('onlyfans', 'global', 'global', 1000)
on conflict (provider, scope, egress_key) do nothing;

alter table page_follows
  add column if not exists last_seen_generation bigint;

create index if not exists page_follows_generation_idx
  on page_follows (platform_account_id, last_seen_generation)
  where is_active = true;

alter table page_subscriptions
  add column if not exists last_seen_generation bigint;

create index if not exists page_subscriptions_generation_idx
  on page_subscriptions (platform_account_id, last_seen_generation)
  where is_current = true;
