-- agency-hub:rollback-compatible — a new table only; the previous image never names it.
-- 0353_model_applications.sql
--
-- Model questionnaires («анкета модели») from the agency site gosling-agency.ru
-- (public POST /api/v1/model-applications). Sensitive personal data: kept here
-- and in the agency's own Google Form only. The client's address is never
-- stored, only its keyed hash, for the per-address hourly limit.

set local lock_timeout = '5s';

create table if not exists model_applications (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  form text not null,
  answers jsonb not null,
  google_fields jsonb,
  google_status text not null check (google_status in ('recorded', 'failed', 'skipped')),
  google_error text,
  ip_hash text not null,
  user_agent text
);

create index if not exists model_applications_ip_hash_created_idx
  on model_applications (ip_hash, created_at);
