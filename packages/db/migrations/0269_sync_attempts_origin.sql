-- 0269_sync_attempts_origin.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2; stage 3 PR 8): a
-- page's browser sends requests the engine did not choose — the site's own
-- reads and the owner's login operations. The engine admits them too, and
-- journals them in sync_attempts next to its own sends, so the takeover floor
-- (`paceFloorFromDb`), the route clocks (`readRouteJournal`) and the pace
-- audit (`sync check live-hour`) see every send of the page without code of
-- their own.
--
--   origin   whose request it was: 'engine' (a work's send, as before),
--            'site' (the site's own request) or 'login' (a login operation
--            of the owner's manual login)
--
-- A site or login attempt has the class 'site' and no work; an engine attempt
-- keeps its class (urgent, requests, planned). Its `operation` is its route
-- (a catalogue route, `site.other`, `auth.login`, `auth.twofa`).
--
-- Additive: a column with a constant default (catalog-only, no rewrite) and
-- the class check widened. Both checks are added NOT VALID and validated
-- after, so the scan takes no exclusive lock. The previous image never names
-- `origin` (it inserts sync_attempts by named columns) and never writes the
-- class 'site': it runs unchanged after a rollback. Nothing writes a site
-- attempt yet.
alter table sync_attempts add column if not exists origin text not null default 'engine';

alter table sync_attempts drop constraint if exists sync_attempts_class_check;
alter table sync_attempts add constraint sync_attempts_class_check
  check (class in ('urgent', 'requests', 'planned', 'site')) not valid;
alter table sync_attempts validate constraint sync_attempts_class_check;

alter table sync_attempts drop constraint if exists sync_attempts_origin_check;
alter table sync_attempts add constraint sync_attempts_origin_check check (
  origin in ('engine', 'site', 'login')
  and (origin = 'engine') = (class <> 'site')
  and (origin = 'engine' or work_id is null)
) not valid;
alter table sync_attempts validate constraint sync_attempts_origin_check;

comment on column sync_attempts.origin is
  'Whose request (Project Browser, 0269): engine (a work''s send), site (the page''s own site request) or login (an operation of the owner''s manual login). A site or login attempt has class site and no work.';
