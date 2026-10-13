-- 0276_page_browser_intake.sql
--
-- Project Browser (docs/plans/project-browser/plan.md §3.2 «Приём буфера и
-- восстановление», §4.4; spec §6.1; stage 3 PR 13): where the engine's
-- intake of a page's operator buffer stands, on the profile's row — the
-- buffer lives on the profile's volume.
--
--   events_buffer_id    the operator's buffer the engine takes events of
--                       (its id from `helloResult`, `events.refused`); null
--                       until the first batch is committed
--   events_acked_seq    the last number of that buffer whose event the
--                       engine committed, in the transaction that committed
--                       it — the `afterSeq` of the next `events.subscribe`
--                       (the operator takes it as the acknowledgement of
--                       everything up to it, so a lost `ack` loses nothing)
--   events_last_wall    when the operator saw the last event the engine
--                       committed, of any buffer: the start of a loss whose
--                       own boundary the operator cannot name (a `gap` with
--                       null `fromWall`, a volume made anew)
--   events_gap_since    a loss the operator marked (`gap`) that no
--                       connection of the site's socket has taken yet: the
--                       next connection's gap_since starts no later, so the
--                       socket's repair (`repair.ws-gap`) reads it back
--   events_updated_at   the last commit of the intake
--
-- LOCKING: page_browsers is tiny (one row per browser profile). The columns
-- are nullable or carry a constant default (catalog only, no rewrite); the
-- check reads the few rows once. lock_timeout keeps the wait brief: if the
-- lock is not had in 5 s the migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names these columns and
-- updates page_browsers by named columns only; nothing takes a page's buffer
-- before the transport switch (PR 14), so it runs unchanged after a rollback.

set local lock_timeout = '5s';

alter table page_browsers
  add column if not exists events_buffer_id uuid,
  add column if not exists events_acked_seq bigint not null default 0,
  add column if not exists events_last_wall timestamptz,
  add column if not exists events_gap_since timestamptz,
  add column if not exists events_updated_at timestamptz;

alter table page_browsers
  drop constraint if exists page_browsers_events_check,
  add constraint page_browsers_events_check check (
    events_acked_seq >= 0 and (events_buffer_id is not null or events_acked_seq = 0)
  );

comment on column page_browsers.events_buffer_id is
  'Project Browser (0276): the operator buffer the engine takes events of; null until its first committed batch.';
comment on column page_browsers.events_acked_seq is
  'Project Browser (0276): the last event number of events_buffer_id the engine committed (the afterSeq of its next events.subscribe).';
comment on column page_browsers.events_last_wall is
  'Project Browser (0276): the operator''s instant of the last event the engine committed, of any buffer: the start of a loss of unknown boundary.';
comment on column page_browsers.events_gap_since is
  'Project Browser (0276): a gap the operator marked that no site socket connection has taken yet; the next connection''s gap_since starts no later.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (events_buffer_id, events_acked_seq, events_last_wall, events_gap_since, events_updated_at)
      on page_browsers to read_only;
  end if;
end $$;
