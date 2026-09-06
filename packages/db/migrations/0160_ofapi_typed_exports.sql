create table ofapi_typed_export_artifacts (
  export_job_id uuid primary key references ofapi_capture_jobs(id), profile text not null,
  sha256 text not null, byte_size bigint not null, row_count integer,
  observation_id bigint not null, observation_received_at timestamptz not null,
  state text not null check(state in ('captured','imported','rejected')),
  reason text, created_at timestamptz not null default now(), imported_at timestamptz
);
create table ofapi_typed_export_rows (
  export_job_id uuid not null references ofapi_capture_jobs(id), row_key text not null,
  profile text not null, page_id bigint not null references pages(id), data jsonb not null,
  observation_id bigint not null, observation_received_at timestamptz not null,
  primary key(export_job_id,row_key)
);
create table ofapi_profile_visitors_daily (
  page_id bigint not null references pages(id), day date not null, source text not null,
  total_visitors bigint, guest_visitors bigint, user_visitors bigint, subscriber_visitors bigint,
  avg_view_duration text, chart_duration text,
  availability text not null check(availability in ('complete','partial','unavailable','ineligible')),
  observation_id bigint not null, observation_received_at timestamptz not null,
  export_job_id uuid references ofapi_capture_jobs(id), observed_at timestamptz not null,
  primary key(page_id,day,source)
);
