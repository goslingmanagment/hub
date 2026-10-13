-- 0278_sync_pages_browser_leave.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Переключение
-- транспорта страницы и откат», §4.7; stage 3 PR 14, Astra's review): a page
-- that leaves its browser for Node is not taken by Node until the leave is
-- confirmed — the browser's exit closed, Chrome stopped, no site socket left,
-- and what its operator kept taken — by the operator, or by the owner's word
-- that the page's container is stopped. The leave outlives the `sync`
-- process: a host that starts again resumes it before anything else.
--
--   sync_pages.browser_leave_generation, browser_leave_requested_at
--                          a pending leave: the page's owner generation when
--                          its transport left `browser` (the last owner that
--                          may have run the browser), and when; null: none
--   sync_pages.browser_left_at, browser_left_by, browser_left_generation
--                          the last confirmed leave: when, by whom
--                          (`operator`: confirmed over the link, for that
--                          generation; `owner`: the owner said the container
--                          is stopped), and the generation it confirmed
--   page_browsers.buffer_undrained_since
--                          the owner said the container stopped before its
--                          operator's buffer was drained: what it kept (site
--                          answers, socket frames, outcomes) waits there
--                          (alert 2 `browser_buffer_undrained`); cleared once
--                          the operator says it keeps nothing
--
-- LOCKING: every actor transaction of the previous image holds a row lock of
-- sync_pages while this runs. The columns are nullable without a default
-- (catalog only); the check is added NOT VALID and validated apart (a handful
-- of rows). page_browsers is tiny. lock_timeout keeps each wait brief: if a
-- lock is not had in 5 s the migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names these columns. A pending
-- leave is written only by the owner's `sync page transport … node` of this
-- release; the deploy refuses to roll back to an image older than 0277 while a
-- page is on its browser or a leave is pending
-- (`verify_rollback_target_runs_no_browser_page`).

set local lock_timeout = '5s';

alter table sync_pages
  add column if not exists browser_leave_generation bigint,
  add column if not exists browser_leave_requested_at timestamptz,
  add column if not exists browser_left_at timestamptz,
  add column if not exists browser_left_by text,
  add column if not exists browser_left_generation bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_pages_browser_leave_check') then
    alter table sync_pages add constraint sync_pages_browser_leave_check check (
      (browser_leave_generation is null) = (browser_leave_requested_at is null)
      and (browser_left_by is null or browser_left_by in ('operator', 'owner'))
      and (browser_left_by is null) = (browser_left_at is null)
    ) not valid;
  end if;
end $$;

alter table sync_pages validate constraint sync_pages_browser_leave_check;

comment on column sync_pages.browser_leave_generation is
  'Project Browser (0278): a pending leave of the page''s browser — the owner generation when its transport left browser; Node takes the page only once the leave is confirmed. Null: none.';
comment on column sync_pages.browser_left_by is
  'Project Browser (0278): who confirmed the last leave of the page''s browser: operator (over the link) or owner (the container is stopped).';

alter table page_browsers add column if not exists buffer_undrained_since timestamptz;

comment on column page_browsers.buffer_undrained_since is
  'Project Browser (0278): the owner said the container stopped before its operator''s buffer was drained; what it kept waits there. Cleared once the operator says it keeps nothing.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (buffer_undrained_since) on page_browsers to read_only;
  end if;
end $$;
