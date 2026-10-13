-- 0275_page_browsers.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.1, §3.4, §4.11;
-- spec §6.3; stage 3 PR 12): one row per browser profile — the profile's
-- container, the page it serves (none until it is bound), what its operator
-- last said of itself, and the page's secrets of it.
--
--   profile_id              the profile (its volumes are named by it: a
--                           profile moves to another page without a copy)
--   page_id                 the page it serves; null until bound (a new
--                           page's profile is made before its page, §3.2)
--   container               `page-browser-<page>` on pb-control
--   step, stop_reason, mode, exit_open, session_fingerprint, account_id,
--   exit_ip, chrome_version, operator_version, selftest_*, buffer_*
--                           the operator's last `state` (spec §6.1), at
--                           last_state_at; values as the operator says them
--                           (its enumerations grow by protocol minor
--                           versions, spec §6.3: no CHECK of their own)
--   link_error              the engine's own word on its link when it cannot
--                           work with the operator (`protocol_version`: no
--                           common major, spec §6.3 rule 6; `token`); null
--                           while the link works
--   encrypted_engine_token, encrypted_api_token, encrypted_vnc_password
--                           the page's RPC tokens (the engine's, the API's)
--                           and its KasmVNC password, each an encrypted
--                           JSON envelope with key_version, as
--                           egress_endpoints.encrypted_auth
--
-- The read role sees every column but the three secrets.
--
-- Rollback-compatible: a new table the previous image never names. Nothing
-- writes a row before the deploy script of the page browsers makes profiles.

set local lock_timeout = '5s';

create table if not exists page_browsers (
  profile_id uuid primary key,
  page_id bigint references pages(id) on delete set null,
  container text not null,
  step text,
  stop_reason text,
  mode text not null default 'automation',
  exit_open boolean not null default false,
  session_fingerprint text,
  account_id text,
  exit_ip text,
  chrome_version text,
  operator_version text,
  selftest_ok boolean,
  selftest_at timestamptz,
  selftest_failed text,
  buffer_bytes bigint,
  buffer_oldest_age_ms bigint,
  last_state_at timestamptz,
  link_error text,
  encrypted_engine_token text not null,
  encrypted_api_token text not null,
  encrypted_vnc_password text not null,
  key_version integer not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint page_browsers_container_key unique (container),
  constraint page_browsers_page_key unique (page_id),
  constraint page_browsers_container_check check (container ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  constraint page_browsers_mode_check check (mode in ('automation', 'manual_login')),
  constraint page_browsers_fingerprint_check check (session_fingerprint is null or session_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint page_browsers_buffer_check check (
    (buffer_bytes is null or buffer_bytes >= 0) and (buffer_oldest_age_ms is null or buffer_oldest_age_ms >= 0)
  )
);

comment on table page_browsers is
  'Project Browser (0275): one row per browser profile — its container on pb-control, the page it serves (null until bound), the operator''s last state, and the page''s RPC tokens and KasmVNC password, encrypted as egress_endpoints.encrypted_auth.';
comment on column page_browsers.link_error is
  'The engine''s own word on its link to the operator when it cannot work with it (protocol_version: no common protocol major, spec §6.3; token); null while the link works.';
comment on column page_browsers.encrypted_engine_token is
  'The engine''s RPC token of the page (hello.token), an encrypted JSON envelope (key_version names the key).';
comment on column page_browsers.encrypted_api_token is
  'The API''s RPC token of the page (login.*), an encrypted JSON envelope.';
comment on column page_browsers.encrypted_vnc_password is
  'The page''s KasmVNC password, an encrypted JSON envelope; the API puts it in, the owner never needs it.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    -- every column but the secrets
    grant select (profile_id, page_id, container, step, stop_reason, mode, exit_open, session_fingerprint, account_id,
      exit_ip, chrome_version, operator_version, selftest_ok, selftest_at, selftest_failed, buffer_bytes,
      buffer_oldest_age_ms, last_state_at, link_error, key_version, created_at, updated_at)
      on page_browsers to read_only;
  end if;
end $$;
