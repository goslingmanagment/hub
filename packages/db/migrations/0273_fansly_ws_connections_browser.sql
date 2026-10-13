-- 0273_fansly_ws_connections_browser.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Кадры сокета»,
-- §3.4; stage 3 PR 12): on a browser page the site opens its own socket, and
-- each of its connections is a row of fansly_ws_connections, as the engine's
-- own socket's are.
--
--   origin                 whose socket: 'node' (the engine's own, from
--                          `sync`, as before) or 'browser' (the site's, in
--                          the page's browser)
--   browser_connection_id  the operator's id of the site's connection (its
--                          `connectionId`, spec §6.1); set exactly on the
--                          browser rows, unique within a page
--
-- A browser row opens on the operator's `ws.open` and closes on its
-- `ws.close`; its gap_since is taken from the previous row as for the
-- engine's own; its generation is the page's credentials generation of the
-- browser (the page, its account, the session fingerprint and the proxy —
-- one value across the engine's fields). Its frames are taken by event id,
-- not by the open row (PR 13).
--
-- LOCKING: fansly_ws_connections is small (one row per connection of a
-- page's socket) but the running engine's socket writes it every few
-- seconds. Its column has a constant default (catalog only, no rewrite); the
-- check reads the table's rows once under the ACCESS EXCLUSIVE lock, the
-- index builds over the same few rows. lock_timeout keeps the wait for the
-- lock brief: if it is not had in 5 s the migration aborts and the deploy
-- rolls back.
--
-- Rollback-compatible: the previous image inserts fansly_ws_connections by
-- named columns (the default 'node' and a null id satisfy the check), reads
-- named columns only, and its abandoned sweep closes any open row of a page
-- — a browser row too, which is right: two sockets of one page never run
-- (PR 14 switches the transport). Nothing writes a browser row before the
-- transport switch.

set local lock_timeout = '5s';

alter table fansly_ws_connections
  add column if not exists origin text not null default 'node',
  add column if not exists browser_connection_id uuid;

alter table fansly_ws_connections
  drop constraint if exists fansly_ws_connections_origin_check,
  add constraint fansly_ws_connections_origin_check check (
    origin in ('node', 'browser') and (origin = 'browser') = (browser_connection_id is not null)
  );

create unique index if not exists fansly_ws_connections_browser_connection
  on fansly_ws_connections (page_id, browser_connection_id)
  where browser_connection_id is not null;

comment on column fansly_ws_connections.origin is
  'Whose socket (Project Browser, 0273): node (the engine''s own, from sync) or browser (the site''s, in the page''s browser).';
comment on column fansly_ws_connections.browser_connection_id is
  'The operator''s connectionId of a site socket (origin browser, 0273); null for the engine''s own.';
