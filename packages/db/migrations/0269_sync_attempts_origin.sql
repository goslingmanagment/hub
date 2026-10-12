-- agency-hub:no-transaction
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
-- keeps its class (urgent, requests, planned). Its `operation` is its route.
--
-- The live engine keeps running while this migrates (the deploy leaves the
-- previous sync up), and sync_attempts is its journal, so nothing here holds
-- the table for long. Each statement runs in its own transaction:
-- 1. the column, with a constant default (catalog only, no rewrite);
-- 2. each check swapped NOT VALID in one ALTER (both brief, under ACCESS
--    EXCLUSIVE): every DDL waits at most 1 s for its lock and retries,
--    instead of queueing the engine's reads and writes behind a long reader,
--    and fails the migration after ~60 s;
-- 3. each check validated apart, under SHARE UPDATE EXCLUSIVE: the scan of
--    the table conflicts with no read or write.
-- Re-running after a crash is safe: every statement is idempotent.
--
-- The previous image never names `origin` (it inserts sync_attempts by named
-- columns) and never writes the class 'site': it runs unchanged after a
-- rollback. Nothing writes a site attempt yet.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts add column if not exists origin text not null default 'engine';
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to add origin';
end
$do$;
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts
        drop constraint if exists sync_attempts_class_check,
        add constraint sync_attempts_class_check check (class in ('urgent', 'requests', 'planned', 'site')) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to widen its class check';
end
$do$;
-- agency-hub:statement
alter table sync_attempts validate constraint sync_attempts_class_check;
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table sync_attempts
        drop constraint if exists sync_attempts_origin_check,
        add constraint sync_attempts_origin_check check (
          origin in ('engine', 'site', 'login')
          and (origin = 'engine') = (class <> 'site')
          and (origin = 'engine' or work_id is null)
        ) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock sync_attempts to add its origin check';
end
$do$;
-- agency-hub:statement
alter table sync_attempts validate constraint sync_attempts_origin_check;
-- agency-hub:statement
comment on column sync_attempts.origin is
  'Whose request (Project Browser, 0269): engine (a work''s send), site (the page''s own site request) or login (an operation of the owner''s manual login). A site or login attempt has class site and no work.';
