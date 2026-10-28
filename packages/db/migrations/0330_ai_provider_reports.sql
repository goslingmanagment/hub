-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0330_ai_provider_reports.sql
--
-- What Anthropic bills, next to Hub's own ledger (ai_usage_events): the
-- Admin API's daily reports of each organization an admin key of
-- ANTHROPIC_ADMIN_KEYS reads. The hourly sync re-reads the last 8 UTC days,
-- because the provider's numbers settle over hours: a day read again
-- overwrites its lines.
--
--   ai_provider_report_syncs   one admin key (by fingerprint, never the key):
--                              its organization, the organization's API keys
--                              as last listed (id, name, hint), the last
--                              attempt, success and error
--   ai_provider_report_days    a UTC day of an organization a sync has read
--                              (a day with no spend has a row and no lines)
--   ai_provider_cost_lines     /cost_report grouped by description: one line
--                              per model, token type, tier... in cents, exact
--                              as the provider wrote them
--   ai_provider_usage_lines    /usage_report/messages grouped by API key and
--                              model: tokens by kind
--
-- A line the latest read of its day no longer names is zeroed, never deleted.
-- Nothing here is a page's or a fan's: no erasure path.

set local lock_timeout = '5s';

create table if not exists ai_provider_report_syncs (
  admin_key_fingerprint text primary key,
  provider text not null default 'anthropic',
  org_id text,
  org_name text,
  -- [{id, name, hint, status}] from /v1/organizations/api_keys; hints only.
  api_keys jsonb not null default '[]'::jsonb,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ai_provider_report_syncs_provider_check check (provider in ('anthropic'))
);

create table if not exists ai_provider_report_days (
  org_id text not null,
  day date not null,
  fetched_at timestamptz not null,
  primary key (org_id, day)
);

create table if not exists ai_provider_cost_lines (
  org_id text not null,
  day date not null,
  -- The description's fields joined: the line's identity within its day.
  line_key text not null,
  description text,
  model text,
  cost_type text,
  token_type text,
  service_tier text,
  context_window text,
  inference_geo text,
  speed text,
  amount_cents numeric not null,
  currency text not null,
  fetched_at timestamptz not null,
  primary key (org_id, day, line_key)
);

create table if not exists ai_provider_usage_lines (
  org_id text not null,
  day date not null,
  -- '' : usage without an API key (the Console's workbench).
  api_key_id text not null,
  model text not null,
  uncached_input_tokens bigint not null,
  cache_read_input_tokens bigint not null,
  cache_write_5m_tokens bigint not null,
  cache_write_1h_tokens bigint not null,
  output_tokens bigint not null,
  web_search_requests bigint not null,
  fetched_at timestamptz not null,
  primary key (org_id, day, api_key_id, model)
);

comment on table ai_provider_report_syncs is
  'Anthropic reconciliation (0330): one admin key of ANTHROPIC_ADMIN_KEYS by fingerprint, its organization and its last sync.';
comment on table ai_provider_cost_lines is
  'Anthropic reconciliation (0330): /v1/organizations/cost_report by description per UTC day, cents as written.';
comment on table ai_provider_usage_lines is
  'Anthropic reconciliation (0330): /v1/organizations/usage_report/messages by API key and model per UTC day.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on ai_provider_report_syncs, ai_provider_report_days,
      ai_provider_cost_lines, ai_provider_usage_lines to read_only;
  end if;
end $$;
