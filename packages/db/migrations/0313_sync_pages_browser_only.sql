-- agency-hub:rollback-compatible — a default and a narrower check only: the previous image runs every page whose transport is `browser` on its browser; its lever to Node is refused by the check, and a page it creates is born `browser`.
-- 0313_sync_pages_browser_only.sql
--
-- The Node sender is gone (owner, 2026-10-25): every Fansly page sends through
-- its own browser, and the host runs every live page there. `sync_pages.transport`
-- (0277) keeps its one value: `browser` is the default of a new row, and the
-- check admits nothing else. Every row on production is `browser` since
-- 2026-10-23; a row that is not (a development database) is set to it first.
-- The leave columns (0278) stay: nothing writes them any more.
--
-- LOCKING: as 0277 — the check is added NOT VALID and validated apart (a
-- handful of rows); lock_timeout keeps each wait brief.

set local lock_timeout = '5s';

update sync_pages set transport = 'browser', updated_at = clock_timestamp() where transport <> 'browser';

alter table sync_pages alter column transport set default 'browser';

alter table sync_pages drop constraint if exists sync_pages_transport_check;
alter table sync_pages add constraint sync_pages_transport_check check (transport = 'browser') not valid;
alter table sync_pages validate constraint sync_pages_transport_check;

comment on column sync_pages.transport is
  'Project Browser (0277, 0313): which sender the page''s requests leave through — always browser (the page''s own browser, through its operator) since the Node sender was removed.';
