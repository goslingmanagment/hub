-- agency-hub:rollback-compatible — a new table, and one more outcome a check may record; the previous image never names either.
-- 0302_publication_queue_snapshots.sql
--
-- Publications (docs/plans/2026-10-23-wall-posts, plan PR 5b): the latest
-- read of each OnlyFans page's own schedule (spec §6, §9). Hub reads it hourly
-- while the page has its publications in the schedule, otherwise daily, and
-- when the owner presses "Обновить"; the screen shows from it the posts put
-- in the schedule by hand ("поставлено вручную") and whether the read was
-- complete. One row per page, replaced by every successful read; the read's
-- responses themselves are journaled in observations first (owner actions).
--
--   window_from, window_to   the UTC days the read covers (today .. +7)
--   complete                 every day read whole: the counts were not
--                            syncing, every window's list held its count, no
--                            day over 100 posts, no window left unread
--   incomplete_reasons       why not
--   posts_per_day            the counts, {"2026-10-24": 3, ...}
--   entries                  the scheduled posts read: queue id, post id,
--                            publish time, caption head, file count
--   refresh_requested_at     the owner pressed "Обновить" (the minutely job
--                            reads it); by whom
--   last_failure             the last read that failed, kept beside the last
--                            good one
--
-- publication_checks may now record "withdrawn": the search for an unknown
-- publication found a withdrawal OnlyFans confirmed gone from a complete read.

set local lock_timeout = '5s';

create table publication_queue_snapshots (
  page_id bigint primary key references pages(id) on delete restrict,
  read_at timestamptz,
  window_from date,
  window_to date,
  complete boolean not null default false,
  incomplete_reasons text[] not null default '{}',
  posts_per_day jsonb not null default '{}',
  entries jsonb not null default '[]',
  evidence jsonb not null default '{}',
  refresh_requested_at timestamptz,
  refresh_requested_by_user_id bigint references users(id) on delete restrict,
  last_failure text,
  last_failed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table publication_checks
  drop constraint publication_checks_outcome_check,
  add constraint publication_checks_outcome_check check (outcome in (
    'published', 'processing', 'scheduled', 'not_published', 'unknown', 'not_found', 'read_failed', 'withdrawn'
  ));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on publication_queue_snapshots to read_only;
  end if;
end $$;
