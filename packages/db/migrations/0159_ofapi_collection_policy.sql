-- Local policy is effective on every physical managed request, never a boot flag.
create table ofapi_collection_state (
  id integer primary key check (id=1), revision integer not null default 0,
  background_paused boolean not null default false, updated_at timestamptz not null default now()
);
insert into ofapi_collection_state(id) values(1);
create table ofapi_collection_policies (
  scope_key text not null, category text not null, page_id bigint references pages(id),
  settings jsonb not null, revision integer not null, actor_user_id bigint not null,
  updated_at timestamptz not null default now(), primary key(scope_key,category)
);
create table ofapi_collection_audit (
  revision integer primary key, actor_user_id bigint not null, changes jsonb not null,
  created_at timestamptz not null default now()
);
create table ofapi_collection_jobs (
  id uuid primary key, page_id bigint not null references pages(id), category text not null,
  policy_revision integer not null, actor_user_id bigint not null,
  state text not null default 'queued' check(state in ('queued','running','paused','completed','failed')),
  max_credits bigint not null check(max_credits>0), max_calls integer not null check(max_calls>0),
  max_bytes bigint not null check(max_bytes>0), used_credits bigint not null default 0,
  used_calls integer not null default 0, used_bytes bigint not null default 0,
  target jsonb not null, checkpoint jsonb not null default '{}', reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table ofapi_collection_requests (
  request_id text primary key, page_id bigint not null references pages(id), category text not null,
  purpose text not null check(purpose in ('background','interactive','one_off')),
  operation text not null, policy_revision integer not null,
  job_id uuid references ofapi_collection_jobs(id), reserved_credits bigint not null check(reserved_credits>=0),
  actual_credits bigint, state text not null default 'reserved' check(state in ('reserved','captured','released')),
  created_at timestamptz not null default now(), captured_at timestamptz
);
create index ofapi_collection_requests_usage_idx on ofapi_collection_requests(page_id,category,purpose,created_at);
create index ofapi_collection_jobs_pending_idx on ofapi_collection_jobs(state,created_at);
