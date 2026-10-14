-- 0277_sync_pages_transport.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Выбор транспорта
-- страницы», §3.4, §4.7; stage 3 PR 14): which sender a page's requests leave
-- through, and the operator's word on a hand-over of a browser page.
--
--   sync_pages.transport   'node'    undici from the `sync` process, as every
--                                     page ran before this column;
--                          'browser' the page's own browser, through its
--                                     operator (`page_browsers`).
--                          'node' for every row: nothing changes until the
--                          owner runs `sync page transport <page> browser`.
--                          The host reads it when it takes the page, and takes
--                          the page again — a new owner generation, the
--                          takeover floor — when it changes.
--
--   page_browsers.pinned_exit_ip, pinned_exit_ip_at, env
--                          what the engine's hello tells the page's operator
--                          besides its proxy (spec §6.1 `hello`): the exit IP
--                          the owner pinned for the page and when, and the
--                          browser's environment by the proxy's region
--                          (`{timeZone, languages, geolocation: {latitude,
--                          longitude, accuracyM}}`, plan §4.1 step 2). Null
--                          until set: a page whose browser has none cannot be
--                          switched to it, and the host takes none to it.
--
--   page_browsers.handover_generation, handover_quiesced_at,
--   handover_last_send_at
--                          the newest owner generation whose hello the
--                          profile's operator answered with `quiesced` — the
--                          earlier owners' requests are over, nothing of them
--                          is in flight (plan §4.7, §4.13) — when the engine
--                          heard it, and the browser's last send as the
--                          operator named it (null: it knows of none). A new
--                          owner of a browser page sends nothing before it;
--                          `sync ownership confirm-stopped` waits for it.
--
-- LOCKING: sync_pages has one row per Fansly page, but every actor
-- transaction of the previous image — still running while this runs — holds
-- a row lock there. The column has a constant default (catalog only, no
-- rewrite); its check is added NOT VALID and validated apart (a handful of
-- rows). page_browsers is tiny and its columns are nullable without a
-- default; its env check reads the few rows once. lock_timeout keeps each wait brief: if a lock is not had in 5 s
-- the migration aborts and the deploy rolls back (the 0245 pattern).
--
-- Rollback-compatible: the previous image never names these columns (it
-- reads and writes sync_pages and page_browsers by named columns only), and
-- no lever of it writes 'browser': every row is 'node' when it runs again.
-- From this release on, an image older than it must not run a page whose
-- transport is 'browser' — it would send through Node beside the page's
-- browser (apps/runtime/src/sync/README.md, "A page's browser").

set local lock_timeout = '5s';

alter table sync_pages add column if not exists transport text not null default 'node';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_pages_transport_check') then
    alter table sync_pages add constraint sync_pages_transport_check
      check (transport in ('node', 'browser')) not valid;
  end if;
end $$;

alter table sync_pages validate constraint sync_pages_transport_check;

comment on column sync_pages.transport is
  'Project Browser (0277): which sender the page''s requests leave through — node (undici from sync, the default) or browser (the page''s own browser, through its operator). Changed by `sync page transport`; the host takes the page again when it changes.';

alter table page_browsers
  add column if not exists pinned_exit_ip text,
  add column if not exists pinned_exit_ip_at timestamptz,
  add column if not exists env jsonb,
  add column if not exists handover_generation bigint,
  add column if not exists handover_quiesced_at timestamptz,
  add column if not exists handover_last_send_at timestamptz;

alter table page_browsers
  drop constraint if exists page_browsers_env_check,
  add constraint page_browsers_env_check check (env is null or jsonb_typeof(env) = 'object');

comment on column page_browsers.pinned_exit_ip is
  'Project Browser (0277): the exit IP the owner pinned for the page (hello.pinnedExitIp); the operator opens its exit only through it.';
comment on column page_browsers.pinned_exit_ip_at is
  'Project Browser (0277): when the exit IP was pinned.';
comment on column page_browsers.env is
  'Project Browser (0277): the browser''s environment by the proxy''s region (hello.env: timeZone, languages, geolocation).';

comment on column page_browsers.handover_generation is
  'Project Browser (0277): the newest owner generation of the page whose hello the operator answered with quiesced (the earlier owners'' requests are over); a new owner sends nothing before it.';
comment on column page_browsers.handover_quiesced_at is
  'Project Browser (0277): when the engine heard the operator''s quiesced for handover_generation.';
comment on column page_browsers.handover_last_send_at is
  'Project Browser (0277): the browser''s last send as that quiesced named it (null: the operator knows of none).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (pinned_exit_ip, pinned_exit_ip_at, env, handover_generation, handover_quiesced_at, handover_last_send_at)
      on page_browsers to read_only;
  end if;
end $$;
