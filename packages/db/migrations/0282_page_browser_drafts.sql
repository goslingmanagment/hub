-- 0282_page_browser_drafts.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Подключение новой
-- страницы через браузер», §3.4, §4.5; owner decision 2026-10-15): a page's
-- server browser starts in the dashboard. The owner pastes the proxy in any
-- common format, Hub checks it (its exit, place, time zone) and proposes the
-- browser's environment from it, the owner confirms — a draft. Then
-- `scripts/deploy-page-browser.sh add-profile` takes the SOCKS5's address and
-- the environment from the draft (no proxy or environment typed on the
-- server), makes the container and registers the profile from it in one
-- transaction that consumes the draft. Before, the SOCKS5 address and the
-- environment were typed at add-profile and the proxy's login and password
-- given later in the dashboard (PR 16).
--
-- page_browser_drafts (new), one per browser to be made:
--   name                    the page's label and the container's name
--                           (`page-browser-<name>`): the name add-profile is
--                           run with
--   page_id                 an existing page that moves to its browser
--                           (add-profile --existing): its proxy is its own
--                           (`egress_endpoints`), shown and checked, not
--                           given here; null — a new page's draft
--   proxy_url, proxy_auth, proxy_key_version
--                           a new page's proxy as the owner gave it: its
--                           URL (socks5://host:port, no credentials), and its
--                           login and password as one encrypted JSON envelope
--                           with its key version, as egress_endpoints keeps a
--                           page's. The profile takes it at its registration
--   env                     the browser's environment the owner confirmed:
--                           {timeZone, languages, geolocation: {latitude,
--                           longitude, accuracyM}} (`hello.env`)
--   socks_endpoint          `ip:port` of the SOCKS5 the container is made
--                           for: the proxy's host resolved ONCE when the
--                           draft was saved, every address it resolved to a
--                           public one — add-profile takes this address,
--                           never a later DNS answer (Astra's review of PR
--                           #627, item 3)
--   page_proxy_id, page_proxy_fingerprint
--                           an existing page's proxy as it was when the
--                           draft was saved (its egress_endpoints row and a
--                           hash of that row): the registration refuses when
--                           the page's proxy changed since (item 4)
--   draft_id                this draft's own identity, minted at its
--                           creation and never reused: a draft deleted and
--                           made again is another draft (item 5)
--   revision                raised at every save: add-profile registers the
--                           draft it read (its id and revision), refused when
--                           it changed meanwhile
--
-- A draft is configuration the owner typed, not a captured fact: the
-- owner's delete, and the registration that consumes it, remove its row.
--
-- LOCKING: a new, empty table; nothing else is altered. lock_timeout keeps the
-- wait for the pages table's reference brief: if a lock is not had in 5 s the
-- migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names the table; a draft
-- left unconsumed stays so under it (its add-profile still takes --socks and
-- --env).

set local lock_timeout = '5s';

create table if not exists page_browser_drafts (
  name text primary key,
  page_id bigint references pages(id) on delete cascade,
  proxy_url text,
  proxy_auth text,
  proxy_key_version integer,
  env jsonb not null,
  socks_endpoint text not null,
  page_proxy_id bigint,
  page_proxy_fingerprint text,
  draft_id uuid not null default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text not null,
  constraint page_browser_drafts_name_check check (name ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  constraint page_browser_drafts_page_key unique (page_id),
  -- A new page's draft carries its proxy; an existing page's uses its own.
  constraint page_browser_drafts_proxy_check check (
    (proxy_auth is null) = (proxy_key_version is null)
    and (page_id is null) = (proxy_url is not null)
    and (proxy_url is not null or proxy_auth is null)
    and (proxy_url is null or proxy_url ~ '^socks5://')
  ),
  constraint page_browser_drafts_env_check check (jsonb_typeof(env) = 'object'),
  constraint page_browser_drafts_socks_endpoint_check check (socks_endpoint ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$'),
  -- An existing page's draft holds the state of the page's proxy it was saved with.
  constraint page_browser_drafts_page_proxy_check check (
    (page_id is null) = (page_proxy_id is null) and (page_proxy_id is null) = (page_proxy_fingerprint is null)
  ),
  constraint page_browser_drafts_draft_id_key unique (draft_id),
  constraint page_browser_drafts_revision_check check (revision >= 1)
);

comment on table page_browser_drafts is
  'Project Browser (0282): a page browser to be made, started in the dashboard — its name, its proxy (a new page''s; an existing page''s is its own), the environment the owner confirmed. add-profile registers the profile from it and consumes it.';
comment on column page_browser_drafts.proxy_auth is
  'Project Browser (0282): the login and password of a new page''s proxy, one encrypted JSON envelope (proxy_key_version names the key), as egress_endpoints.encrypted_auth; the profile takes it at its registration.';
comment on column page_browser_drafts.revision is
  'Project Browser (0282): raised at every save; add-profile registers only the revision it read.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    -- every column but the proxy's sealed auth
    grant select (name, page_id, proxy_url, proxy_key_version, env, socks_endpoint, page_proxy_id, draft_id, revision, created_at, created_by,
      updated_at, updated_by)
      on page_browser_drafts to read_only;
  end if;
end $$;
