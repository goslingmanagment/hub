create table if not exists fan_profiles (
  id bigserial primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  version integer not null,
  body text not null,
  source text not null,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fan_profiles_version_check check (version > 0),
  constraint fan_profiles_fan_page_version_uniq unique (fan_id, platform_account_id, version)
);

create index if not exists fan_profiles_latest_idx
  on fan_profiles (platform_account_id, fan_id, version desc);

create index if not exists fan_profiles_history_idx
  on fan_profiles (fan_id, platform_account_id, created_at desc);
