do $$
begin
  create type user_role as enum ('owner', 'team_lead', 'chatter', 'content_manager');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type fan_flag as enum ('whale', 'vip', 'risky');
exception
  when duplicate_object then null;
end $$;

create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  role user_role not null,
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_page_assignments (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_page_assignments_user_page_uniq unique (user_id, platform_account_id)
);

create index if not exists user_page_assignments_page_idx
  on user_page_assignments(platform_account_id);

create table if not exists auth_sessions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  token_digest text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);

create index if not exists auth_sessions_user_idx on auth_sessions(user_id);
create index if not exists auth_sessions_expiry_idx on auth_sessions(expires_at);

create table if not exists api_keys (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  key_prefix text not null unique,
  token_digest text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);

create index if not exists api_keys_user_idx on api_keys(user_id);

create table if not exists audit_events (
  id bigserial primary key,
  actor_user_id bigint references users(id) on delete set null,
  target_user_id bigint references users(id) on delete set null,
  platform_account_id bigint references platform_accounts(id) on delete set null,
  source text not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_actor_idx
  on audit_events(actor_user_id, created_at);
create index if not exists audit_events_target_idx
  on audit_events(target_user_id, created_at);
create index if not exists audit_events_page_idx
  on audit_events(platform_account_id, created_at);

create table if not exists fan_notes (
  id bigserial primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  author_user_id bigint references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists fan_notes_fan_page_idx
  on fan_notes(fan_id, platform_account_id, created_at);

create table if not exists fan_summaries (
  id bigserial primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  author_user_id bigint references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists fan_summaries_fan_page_idx
  on fan_summaries(fan_id, platform_account_id, created_at);

create table if not exists fan_flags (
  id bigserial primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  flag fan_flag not null,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fan_flags_fan_flag_uniq unique (fan_id, flag)
);

create index if not exists fan_flags_fan_idx
  on fan_flags(fan_id, created_at);
