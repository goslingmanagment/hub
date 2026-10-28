-- agency-hub:rollback-compatible — new tables and nullable columns; the previous image never names them and its inserts still pass.
-- 0332_ai_provider_key_mappings.sql
--
-- Anthropic reconciliation (0330) without admin keys: the owner exports the
-- console's Cost page as CSV and Hub imports it. And a key's account is
-- remembered, so a rotated key's history stays its account's.
--
--   ai_provider_key_mappings   one API key of an organization: whose it is
--                              (account_id; null = not Hub's), decided by
--                              its hint (the Admin API's key list), its name
--                              on CSV import ("hub" is the account's, any
--                              other key is not Hub's) or the owner. Kept
--                              forever: the reconciliation reads every day,
--                              old ones included, through it.
--   ai_provider_account_orgs   the organization an account's API key lives
--                              in (the anthropic-organization-id header of
--                              GET /v1/models), as last resolved
--   ai_provider_csv_imports    one imported file: its organization, account,
--                              name, the UTC days it covers and its total
--   ai_provider_report_days    + source ('admin_api' | 'csv') and the import
--                              that wrote the day last
--   ai_provider_cost_lines     + api_key_id: the key a CSV line names ('' =
--                              the Console); null = an Admin API line, which
--                              knows the organization only
--
-- Nothing here is a page's or a fan's: no erasure path. No row is deleted.

set local lock_timeout = '5s';

create table if not exists ai_provider_key_mappings (
  org_id text not null,
  api_key_id text not null,
  account_id bigint references ai_provider_accounts(id),
  source text not null,
  key_name text,
  key_hint text,
  decided_at timestamptz not null,
  primary key (org_id, api_key_id),
  constraint ai_provider_key_mappings_source_check check (source in ('hint', 'name', 'owner'))
);

create table if not exists ai_provider_account_orgs (
  account_id bigint primary key references ai_provider_accounts(id),
  org_id text not null,
  resolved_at timestamptz not null
);

create table if not exists ai_provider_csv_imports (
  id bigint generated always as identity primary key,
  org_id text not null,
  account_id bigint not null references ai_provider_accounts(id),
  file_name text,
  period_from date not null,
  period_to date not null,
  row_count integer not null,
  amount_cents numeric not null,
  imported_at timestamptz not null
);

create index if not exists ai_provider_csv_imports_org on ai_provider_csv_imports (org_id, imported_at desc);

alter table ai_provider_report_days
  add column if not exists source text,
  add column if not exists import_id bigint references ai_provider_csv_imports(id);

alter table ai_provider_cost_lines
  add column if not exists api_key_id text;

comment on table ai_provider_key_mappings is
  'Anthropic reconciliation (0332): whose an API key of an organization is (null account = not Hub), by hint, name or the owner; kept forever.';
comment on table ai_provider_csv_imports is
  'Anthropic reconciliation (0332): Cost-page CSV files the owner imported, with the UTC days each covers.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on ai_provider_key_mappings, ai_provider_account_orgs, ai_provider_csv_imports to read_only;
  end if;
end $$;
