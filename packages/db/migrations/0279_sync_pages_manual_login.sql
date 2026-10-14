-- 0279_sync_pages_manual_login.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §4.8 «Вход и ручной
-- режим», §3.2; stage 3 PR 15): the owner logs a page's browser in through
-- the dashboard's form. While a person is in the browser the page stands on
-- pause, and its operator is in the manual login — switched on and off by
-- the engine that owns the page (the form's calls go to the operator only in
-- that mode). The owner's lever writes the wish; the engine follows it and
-- says when the automation is back.
--
--   sync_pages.manual_login           off | wanted | ending
--                                     wanted — the owner opened the login
--                                     (API): the page is paused, the engine
--                                     puts the operator into the manual login
--                                     (and starts its browser if it stands);
--                                     ending — the owner closed it: the
--                                     engine brings the automation back (and
--                                     stops the browser of a page on Node)
--                                     and only then writes off; the page is
--                                     paused until then
--   sync_pages.manual_login_paused    the login put the page on the owner's
--                                     pause (paused_all was off when it
--                                     opened): the engine lifts it again when
--                                     the automation is back. False: the page
--                                     was paused before, and stays so
--   sync_pages.manual_login_changed_at, manual_login_changed_by
--                                     when and by whom (`owner:<user id>`,
--                                     `engine`) the value last changed
--
-- The pause of a login is the owner's pause (paused_all, plan §3.2: «при
-- paused_all … в режиме оператора «ручной вход» допускаются только операции
-- входа»): every reader of the page row honours it as it is, and the site's
-- login operations pass it only in the operator's manual login (PR 8).
--
-- LOCKING: every actor transaction of the previous image holds a row lock of
-- sync_pages while this runs. The two defaults are constants (catalog
-- only); the timestamps are nullable without a default; the check is added
-- NOT VALID and validated apart (a handful of rows). lock_timeout keeps
-- each wait brief: if a lock is not had in 5 s the migration aborts and the
-- deploy rolls back.
--
-- Rollback-compatible: the previous image never names these columns, and
-- every page stays off — only the owner's lever of this release writes
-- another value. An image that does not know them keeps a page whose login
-- was open on the owner's pause (paused_all) until the owner lifts it; its
-- operator, on that engine's new owner generation, leaves the manual login
-- and refuses the form.

set local lock_timeout = '5s';

alter table sync_pages add column if not exists manual_login text not null default 'off';
alter table sync_pages add column if not exists manual_login_paused boolean not null default false;
alter table sync_pages
  add column if not exists manual_login_changed_at timestamptz,
  add column if not exists manual_login_changed_by text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_pages_manual_login_check') then
    alter table sync_pages add constraint sync_pages_manual_login_check
      check (manual_login in ('off', 'wanted', 'ending')) not valid;
  end if;
end $$;

alter table sync_pages validate constraint sync_pages_manual_login_check;

comment on column sync_pages.manual_login is
  'Project Browser (0279): the owner''s login of the page''s browser — off, wanted (the page paused, its operator in the manual login), ending (the automation coming back; off once the engine confirmed it).';
