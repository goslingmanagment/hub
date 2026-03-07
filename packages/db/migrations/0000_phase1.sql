do $$
begin
  create type platform as enum ('fansly', 'onlyfans');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type sync_run_status as enum ('running', 'success', 'partial', 'failed');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type sync_stream as enum ('light', 'followers', 'transactions', 'subscribers', 'cleanup');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type transaction_type as enum (
    'subscription',
    'tip',
    'message_purchase',
    'post_purchase',
    'stream_tip',
    'chargeback',
    'refund',
    'other'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type transaction_state as enum ('pending', 'posted', 'unknown');
exception
  when duplicate_object then null;
end $$;

create table if not exists models (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists platform_accounts (
  id bigserial primary key,
  model_id bigint not null references models(id) on delete cascade,
  platform platform not null,
  label text not null unique,
  platform_account_id text,
  username text,
  display_name text,
  follower_count integer not null default 0,
  subscriber_count integer not null default 0,
  earnings_balance_mills bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  last_light_sync_at timestamptz,
  last_follower_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists platform_accounts_model_idx on platform_accounts(model_id);
create index if not exists platform_accounts_platform_user_idx
  on platform_accounts(platform, platform_account_id);

create table if not exists platform_account_credentials (
  id bigserial primary key,
  platform_account_id bigint not null unique references platform_accounts(id) on delete cascade,
  encrypted_session text not null,
  key_version integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists platform_account_proxies (
  id bigserial primary key,
  platform_account_id bigint not null unique references platform_accounts(id) on delete cascade,
  url text not null,
  encrypted_auth text,
  key_version integer,
  updated_at timestamptz not null default now()
);

create table if not exists sync_runs (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  stream sync_stream not null,
  trigger text not null,
  status sync_run_status not null,
  error_summary text,
  stats jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists sync_runs_account_stream_idx
  on sync_runs(platform_account_id, stream, started_at);

create table if not exists sync_checkpoints (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  stream sync_stream not null,
  cursor_text text,
  cursor_timestamp timestamptz,
  state jsonb not null default '{}'::jsonb,
  last_successful_run_id bigint references sync_runs(id) on delete set null,
  last_successful_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint sync_checkpoints_account_stream_uniq unique (platform_account_id, stream)
);

create table if not exists raw_payloads (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  sync_run_id bigint references sync_runs(id) on delete set null,
  endpoint text not null,
  request_params jsonb not null default '{}'::jsonb,
  response_payload jsonb not null,
  mapper_version text not null,
  payload_kind text not null,
  status_code integer,
  error_message text,
  captured_at timestamptz not null default now(),
  retain_until timestamptz not null
);

create index if not exists raw_payloads_retain_idx on raw_payloads(retain_until);

create table if not exists fans (
  id bigserial primary key,
  platform platform not null,
  platform_user_id text not null,
  username text,
  display_name text,
  created_at_external timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint fans_platform_user_uniq unique (platform, platform_user_id)
);

create table if not exists fan_pages (
  id bigserial primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  total_spent_mills bigint not null default 0,
  currency text not null default 'USD',
  is_follower boolean not null default false,
  follower_since timestamptz,
  is_subscriber boolean not null default false,
  subscriber_since timestamptz,
  subscription_expires_at timestamptz,
  auto_renew boolean,
  last_transaction_at timestamptz,
  last_seen_at timestamptz not null default now(),
  constraint fan_pages_fan_account_uniq unique (fan_id, platform_account_id)
);

create table if not exists page_follows (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_follow_id text not null,
  followed_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true,
  constraint page_follows_account_follow_uniq unique (platform_account_id, platform_follow_id)
);

create index if not exists page_follows_fan_idx on page_follows(fan_id);

create table if not exists page_subscriptions (
  id bigserial primary key,
  platform_subscription_id text not null unique,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_history_id text,
  subscription_tier_id text,
  subscription_tier_name text,
  subscription_tier_color text,
  plan_id text,
  raw_status integer not null,
  canonical_status text not null,
  price_mills bigint not null,
  renew_price_mills bigint not null,
  auto_renew boolean,
  billing_cycle_days integer,
  duration_days integer,
  renew_date timestamptz,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  ends_at timestamptz,
  is_current boolean not null default true,
  last_seen_at timestamptz not null default now()
);

create index if not exists page_subscriptions_account_idx
  on page_subscriptions(platform_account_id, ends_at);

create table if not exists transactions (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint references fans(id) on delete set null,
  transaction_id text not null,
  wallet_id text,
  account_id text,
  correlation_id text,
  correlation_account_id text,
  raw_type integer not null,
  canonical_type transaction_type not null,
  transaction_state transaction_state not null,
  destination integer,
  raw_status integer not null,
  amount_mills bigint not null,
  destination_amount_mills bigint not null,
  net_amount_mills bigint not null,
  raw_destination_tax integer,
  new_balance_mills bigint,
  sender_id text,
  receiver_id text,
  occurred_at timestamptz not null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  constraint transactions_account_transaction_uniq unique (platform_account_id, transaction_id)
);

create index if not exists transactions_account_occurred_idx
  on transactions(platform_account_id, occurred_at);
create index if not exists transactions_fan_idx on transactions(fan_id);

create table if not exists daily_revenue (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  business_date date not null,
  canonical_type transaction_type not null,
  transaction_state transaction_state not null,
  transaction_count integer not null default 0,
  net_amount_mills bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint daily_revenue_account_date_type_state_uniq
    unique (platform_account_id, business_date, canonical_type, transaction_state)
);

create table if not exists daily_followers (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  business_date date not null,
  new_followers integer not null default 0,
  known_total_followers integer,
  updated_at timestamptz not null default now(),
  constraint daily_followers_account_date_uniq unique (platform_account_id, business_date)
);

create table if not exists daily_subscribers (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  business_date date not null,
  new_subscribers integer not null default 0,
  active_subscribers integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint daily_subscribers_account_date_uniq unique (platform_account_id, business_date)
);
