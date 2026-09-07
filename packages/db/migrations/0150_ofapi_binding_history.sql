-- Forward-only. Existing mappings are evidence of association, not proof of creator identity.
alter table pages add column ofapi_binding_generation integer not null default 1;
alter table ofapi_commands add column binding_generation integer not null default 1;
alter table page_sync_states add column blocker_ofapi_generation integer;
-- Separate an explicit pause from an auth-owned pause, including pause-after-auth.
alter table page_sync_states add column ofapi_user_paused boolean not null default false;
create table ofapi_account_bindings (
  account_id text primary key,
  page_id bigint not null references pages(id),
  creator_id text,
  generation integer,
  valid_from timestamptz,
  valid_to timestamptz,
  evidence jsonb not null,
  recorded_at timestamptz not null default now()
);
create index ofapi_account_bindings_page_idx on ofapi_account_bindings(page_id);
insert into ofapi_account_bindings(account_id,page_id,generation,evidence)
select ofapi_account_id,id,1,jsonb_build_object('source','mapping_at_migration','boundary','unknown')
from pages where platform='onlyfans' and ofapi_account_id is not null;
create table ofapi_credential_preflights (
  credential_fingerprint text primary key,
  expected_team text,
  observed_team text,
  status text not null check(status in ('verified','unknown','mismatch','denied')),
  checked_at timestamptz not null,
  reason text
);
create table ofapi_webhook_registration_history (
  id bigserial primary key,
  external_webhook_id text not null,
  endpoint_url text not null,
  credential_fingerprint text not null,
  reason text not null,
  recorded_at timestamptz not null default now()
);
