-- 0280_page_browser_visibility.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §4.9, §4.11; stage 3
-- PR 17): what the engine keeps of a page's browser for the owner to see and
-- steer — the operator's start as it goes, its alarms, the delivery of its
-- events, the owner's stop — and the owner's one-shot commands to it.
--
--   page_browsers.retry_at        the operator's next start after a failure
--                                 (state.retryAtWall); null: none due
--   page_browsers.down_since      since when the operator has not said
--                                 `ready` (step 10 of plan §4.1): the page's
--                                 browser is not up; null while it is ready
--   page_browsers.stop_since      since when the operator has said its
--                                 current stop reason; null without one
--   page_browsers.delivery_p50_ms, delivery_p95_ms, delivery_at
--                                 how long the operator's events took from
--                                 their instant to the engine's commit over
--                                 the last minutes, as the engine measured it,
--                                 and when it last said so
--   page_browsers.alarm_kind, alarm_at, alarm_detail
--                                 the operator's last alarm (spec §6.1
--                                 `alarm`: no secrets by the protocol; the
--                                 engine keeps only its scalar details)
--   page_browsers.owner_stop_at, owner_stop_by, owner_stop_paused
--                                 the owner's `sync browser stop` (plan
--                                 §4.11: the engine pauses the page, the
--                                 operator closes its exit): when, by whom,
--                                 and whether the stop put the page on its
--                                 pause (so `sync browser start` lifts only
--                                 that one); null: not stopped by the owner
--
--   page_browser_commands         the owner's one-shot commands to a page's
--                                 browser (`sync browser start` of a halted
--                                 one, `sync browser selftest`), carried out
--                                 by the engine that owns the page, over its
--                                 link — a command reaches a browser only from
--                                 the page's current owner (plan §4.8, §4.13).
--                                 `command_id` is the operator's id of it (one
--                                 run per id); a command no owner took before
--                                 `expires_at` is never run. A command belongs
--                                 to its profile (it goes with it); page_id is
--                                 the page the profile served when asked.
--
-- LOCKING: page_browsers is tiny (one row per browser profile); the columns
-- are nullable or carry a constant default (catalog only). The new table is
-- empty. lock_timeout keeps each wait brief: if a lock is not had in 5 s the
-- migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names these columns or the
-- table, and updates page_browsers by named columns only; nothing writes them
-- before a page runs on its browser.

set local lock_timeout = '5s';

alter table page_browsers
  add column if not exists retry_at timestamptz,
  add column if not exists down_since timestamptz,
  add column if not exists stop_since timestamptz,
  add column if not exists delivery_p50_ms bigint,
  add column if not exists delivery_p95_ms bigint,
  add column if not exists delivery_at timestamptz,
  add column if not exists alarm_kind text,
  add column if not exists alarm_at timestamptz,
  add column if not exists alarm_detail jsonb,
  add column if not exists owner_stop_at timestamptz,
  add column if not exists owner_stop_by text,
  add column if not exists owner_stop_paused boolean not null default false;

alter table page_browsers
  drop constraint if exists page_browsers_visibility_check,
  add constraint page_browsers_visibility_check check (
    (delivery_p50_ms is null or delivery_p50_ms >= 0) and (delivery_p95_ms is null or delivery_p95_ms >= 0)
    and (alarm_kind is null) = (alarm_at is null)
    and (alarm_detail is null or jsonb_typeof(alarm_detail) = 'object')
    and (owner_stop_at is null) = (owner_stop_by is null)
    and (owner_stop_at is not null or not owner_stop_paused)
  );

comment on column page_browsers.down_since is
  'Project Browser (0280): since when the operator has not said ready (its browser not up); null while ready.';
comment on column page_browsers.alarm_kind is
  'Project Browser (0280): the operator''s last alarm (spec §6.1), with alarm_at and its scalar details (no secrets).';
comment on column page_browsers.owner_stop_at is
  'Project Browser (0280): the owner stopped the page''s browser (sync browser stop): the engine keeps its exit closed and Chrome stopped until sync browser start.';
comment on column page_browsers.owner_stop_paused is
  'Project Browser (0280): the owner''s stop put the page on its pause (sync browser start lifts only that pause).';

create table if not exists page_browser_commands (
  id bigserial primary key,
  command_id uuid not null default gen_random_uuid(),
  profile_id uuid not null references page_browsers(profile_id) on delete cascade,
  page_id bigint not null,
  kind text not null,
  requested_by text not null,
  note text,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  taken_generation bigint,
  taken_at timestamptz,
  done_at timestamptz,
  ok boolean,
  detail text,
  constraint page_browser_commands_command_id_key unique (command_id),
  constraint page_browser_commands_kind_check check (kind in ('restartBrowser', 'selfTest')),
  constraint page_browser_commands_done_check check ((done_at is null) = (ok is null)),
  constraint page_browser_commands_taken_check check ((taken_at is null) = (taken_generation is null))
);

create index if not exists page_browser_commands_pending_idx on page_browser_commands (page_id, id) where done_at is null;

comment on table page_browser_commands is
  'Project Browser (0280): the owner''s one-shot commands to a page''s browser (sync browser start|selftest), run once by the engine that owns the page over its link; never run after expires_at.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (retry_at, down_since, stop_since, delivery_p50_ms, delivery_p95_ms, delivery_at, alarm_kind, alarm_at,
      alarm_detail, owner_stop_at, owner_stop_by, owner_stop_paused)
      on page_browsers to read_only;
    grant select on page_browser_commands to read_only;
  end if;
end $$;
