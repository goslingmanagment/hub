-- 0281_page_browser_onboarding.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Подключение новой
-- страницы через браузер», §3.4, §4.8; stage 3 PR 16): a new Fansly page is
-- connected through its own browser. `scripts/deploy-page-browser.sh
-- add-profile` makes the profile's container and its row here, its page
-- empty; the owner gives its proxy in the dashboard, pins the exit IP, logs it
-- in through the form; the engine checks the account through the browser;
-- then Hub creates the page and binds the profile to it. Until then the
-- profile is no page's: the engine links to it by the profile alone.
--
-- page_browsers:
--   onboarding              the owner's onboarding of a profile no page has
--                           yet: off — nothing; login — his login through the
--                           form (the operator in the manual login, the
--                           browser started); open — the login closed, the
--                           browser back in the automation, the account
--                           checked through it on request; closing — the
--                           onboarding given up: the engine stops the browser
--                           (its profile kept), then off. A bound profile is
--                           off (its page's own login is sync_pages.manual_login)
--   onboarding_changed_at, onboarding_changed_by
--                           when and by whom (`owner:<user id>`, `engine`)
--   socks_endpoint          `ip:port` of the SOCKS5 the profile's container was
--                           made for (its rules admit that address alone):
--                           the proxy the owner gives must be that one
--   onboarding_proxy_url, onboarding_proxy_auth, onboarding_proxy_key_version
--                           the proxy of the page to be, as the owner gave it
--                           — its URL, and its username and password as one
--                           encrypted JSON envelope with its key version, as
--                           egress_endpoints keeps a page's. The page takes it
--                           at the binding; cleared then
--   link_generation         raised every time an engine takes the link to
--                           a profile no page has (its hello's owner
--                           generation): an earlier link's writes are fenced
--                           off by it, and the binding raises it too
--   identity_request_id, identity_request_source, identity_requested_at
--                           the owner asked for the account the profile's
--                           live session belongs to (`onboarding`: the page's
--                           creation; `credentials_verify`: the owner's check):
--                           one `GET /account/me` through the browser
--   identity_result         the engine's answer to that request: the account
--                           (id, username, display name), the send instant,
--                           the session's fingerprint, the observation it was
--                           journaled as — or why there is none
--
-- fansly_send_log:
--   browser_profile_id, browser_attempt_id
--                           a send through the browser of a profile no page
--                           has (the site's own login requests, the account
--                           check): journaled with page_id null as the check
--                           of a session without a page is, under source
--                           `onboarding` (or `credentials_verify`), with the
--                           profile and the attempt id its operator knows it by
--
-- LOCKING: page_browsers is tiny (one row per browser profile): the columns
-- are nullable or carry a constant default (catalog only, no rewrite); its
-- checks read the few rows once. fansly_send_log is small and written only by
-- the identity checks without a page and the public reader: two nullable
-- columns without a default (catalog only). lock_timeout keeps each wait
-- brief: if a lock is not had in 5 s the migration aborts and the deploy rolls
-- back.
--
-- Rollback-compatible: the previous image never names these columns, reads
-- and writes both tables by named columns, and never inserts a profile's row
-- (only the deploy script's add-profile of this release does). A profile left
-- unbound stays so under it: no engine of it links to a profile no page has.

set local lock_timeout = '5s';

alter table page_browsers
  add column if not exists onboarding text not null default 'off',
  add column if not exists onboarding_changed_at timestamptz,
  add column if not exists onboarding_changed_by text,
  add column if not exists socks_endpoint text,
  add column if not exists onboarding_proxy_url text,
  add column if not exists onboarding_proxy_auth text,
  add column if not exists onboarding_proxy_key_version integer,
  add column if not exists link_generation bigint not null default 0,
  add column if not exists identity_request_id uuid,
  add column if not exists identity_request_source text,
  add column if not exists identity_requested_at timestamptz,
  add column if not exists identity_result jsonb;

alter table page_browsers
  drop constraint if exists page_browsers_onboarding_check,
  add constraint page_browsers_onboarding_check check (onboarding in ('off', 'login', 'open', 'closing')),
  -- A profile bound to a page is no onboarding's: its page's login is its own.
  drop constraint if exists page_browsers_onboarding_unbound_check,
  add constraint page_browsers_onboarding_unbound_check check (page_id is null or onboarding = 'off'),
  drop constraint if exists page_browsers_socks_endpoint_check,
  add constraint page_browsers_socks_endpoint_check check (
    socks_endpoint is null or socks_endpoint ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$'
  ),
  drop constraint if exists page_browsers_onboarding_proxy_check,
  add constraint page_browsers_onboarding_proxy_check check (
    (onboarding_proxy_auth is null) = (onboarding_proxy_key_version is null)
    and (onboarding_proxy_url is not null or onboarding_proxy_auth is null)
  ),
  drop constraint if exists page_browsers_link_generation_check,
  add constraint page_browsers_link_generation_check check (link_generation >= 0),
  drop constraint if exists page_browsers_identity_request_check,
  add constraint page_browsers_identity_request_check check (
    (identity_request_id is null) = (identity_requested_at is null)
    and (identity_request_id is null) = (identity_request_source is null)
    and (identity_request_source is null or identity_request_source in ('onboarding', 'credentials_verify'))
  ),
  drop constraint if exists page_browsers_identity_result_check,
  add constraint page_browsers_identity_result_check check (identity_result is null or jsonb_typeof(identity_result) = 'object');

comment on column page_browsers.onboarding is
  'Project Browser (0281): the owner''s onboarding of a profile no page has yet — off, login (his login through the form, the operator in the manual login), open (the automation back, the account checked through the browser on request), closing (given up: the browser stopped, then off). Off once bound.';
comment on column page_browsers.socks_endpoint is
  'Project Browser (0281): ip:port of the SOCKS5 the profile''s container was made for (add-profile); its rules admit that address alone.';
comment on column page_browsers.onboarding_proxy_auth is
  'Project Browser (0281): the username and password of the proxy the owner gave for the page to be, one encrypted JSON envelope (onboarding_proxy_key_version names the key); the page takes it at the binding.';
comment on column page_browsers.link_generation is
  'Project Browser (0281): raised every time an engine takes the link to a profile no page has (the hello''s owner generation) and at the binding: an earlier link''s writes are fenced off by it.';
comment on column page_browsers.identity_result is
  'Project Browser (0281): the engine''s answer to identity_request_id — the account the browser''s live session belongs to, read by one GET /account/me through the browser and journaled in observations — or why there is none.';

alter table fansly_send_log
  add column if not exists browser_profile_id uuid,
  add column if not exists browser_attempt_id bigint;

comment on column fansly_send_log.browser_profile_id is
  'Project Browser (0281): a send through the browser of a profile no page has yet (its onboarding: the site''s login requests, the account check), page_id null.';
comment on column fansly_send_log.browser_attempt_id is
  'Project Browser (0281): the attempt id the profile''s operator knows that send by.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    -- every new column but the proxy's sealed auth
    grant select (onboarding, onboarding_changed_at, onboarding_changed_by, socks_endpoint, onboarding_proxy_url,
      onboarding_proxy_key_version, link_generation, identity_request_id, identity_request_source, identity_requested_at,
      identity_result)
      on page_browsers to read_only;
  end if;
end $$;
