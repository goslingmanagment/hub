-- agency-hub:rollback-compatible — a new table only; the previous image never names it.
-- 0354_model_application_sessions.sql
--
-- One filling of the agency site's model questionnaire, as its page reports it
-- while the model types (public POST /api/v1/model-applications/progress):
-- how far she got, the section, the name she gave and, when the page sends
-- them, her answers so far (the latest snapshot, unsent: the same sensitive
-- personal data as model_applications). The owner hears in Telegram
-- when a filling starts and when one is left unsent; a sent questionnaire
-- marks its filling. The client's address is kept only as a keyed hash, for
-- the per-address limits.

set local lock_timeout = '5s';

create table if not exists model_application_sessions (
  session uuid primary key,
  form text not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  filled integer not null default 0 check (filled between 0 and 500),
  total integer not null default 0 check (total between 0 and 500),
  section text,
  name text,
  answers jsonb,
  ip_hash text not null,
  start_notified_at timestamptz,
  abandon_notified_at timestamptz,
  submitted_at timestamptz,
  application_id bigint references model_applications(id)
);

create index if not exists model_application_sessions_ip_hash_started_idx
  on model_application_sessions (ip_hash, started_at);

create index if not exists model_application_sessions_updated_idx
  on model_application_sessions (updated_at);
