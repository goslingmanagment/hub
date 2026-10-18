-- 0288_page_browser_telemetry.sql
--
-- Project Browser telemetry for audits (protocol minor 5, 2026-10-18): what
-- an audit of a page's browser had to piece together by hand over SSH.
--
--   page_browsers.hub_send_allowed, hub_send_blocked_reason, hub_send_blocked_since
--                                 whether a Hub request can go now, as the
--                                 operator's last state said (state.hubSend):
--                                 a page may be `ready` while its transport
--                                 refuses them (a header parity broken until
--                                 Chrome starts anew); blocked: the reason
--                                 and since when. Null: not said (an operator
--                                 from before minor 5)
--   page_browsers.crash_dumps_completed, crash_dumps_completed_newest_at,
--   crash_dumps_pending, crash_dumps_pending_newest_at, crash_dumps_counted_at
--                                 Chrome's crash dumps on the profile —
--                                 Crashpad's completed and pending, how many
--                                 and the newest one's time — as counted at
--                                 Chrome's last start or exit (state.crashDumps).
--                                 Never a dump: they hold the session's memory.
--                                 Null: not counted
--
--   page_browser_transitions      every change of a page operator's step, as
--                                 its buffer delivered it (`browser.transition`,
--                                 taken in the intake's batch, keyed by the
--                                 buffer and the event's number): from, to,
--                                 the stop reason, whether it held until the
--                                 engine starts it, the next retry, the note
--                                 (IPs masked by the operator), the versions
--                                 and the crash dumps then. The stops and
--                                 starts of a browser over any window — the
--                                 input of the update's `browser_stable` check.
--                                 Small (a few rows an hour at most); kept.
--
-- LOCKING: page_browsers is tiny (one row per browser profile); the columns
-- are nullable without a default (catalog only), the check reads its few
-- rows once. The new table is empty. lock_timeout keeps each wait brief: if
-- a lock is not had in 5 s the migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names these columns or the
-- table, and updates page_browsers by named columns only; its intake knows no
-- `browser.transition`, which an operator writes only for an engine of
-- minor 5.

set local lock_timeout = '5s';

alter table page_browsers
  add column if not exists hub_send_allowed boolean,
  add column if not exists hub_send_blocked_reason text,
  add column if not exists hub_send_blocked_since timestamptz,
  add column if not exists crash_dumps_completed integer,
  add column if not exists crash_dumps_completed_newest_at timestamptz,
  add column if not exists crash_dumps_pending integer,
  add column if not exists crash_dumps_pending_newest_at timestamptz,
  add column if not exists crash_dumps_counted_at timestamptz;

alter table page_browsers
  drop constraint if exists page_browsers_telemetry_check,
  add constraint page_browsers_telemetry_check check (
    (hub_send_blocked_reason is null) = (hub_send_blocked_since is null)
    and (hub_send_blocked_reason is null or hub_send_allowed is false)
    and (crash_dumps_completed is null or crash_dumps_completed >= 0)
    and (crash_dumps_pending is null or crash_dumps_pending >= 0)
    and (crash_dumps_counted_at is null) = (crash_dumps_completed is null)
    and (crash_dumps_counted_at is null) = (crash_dumps_pending is null)
  );

comment on column page_browsers.hub_send_allowed is
  'Project Browser (0288): whether a Hub request can go now, as the operator''s last state said (minor 5); false with hub_send_blocked_reason and _since. A page may be ready and blocked. Null: not said.';
comment on column page_browsers.crash_dumps_completed is
  'Project Browser (0288): Chrome''s crash dumps on the profile (Crashpad completed; crash_dumps_pending the pending ones), with the newest one''s time, as counted at Chrome''s last start or exit (crash_dumps_counted_at). Never a dump. Null: not counted.';

create table if not exists page_browser_transitions (
  id bigserial primary key,
  profile_id uuid not null references page_browsers(profile_id) on delete cascade,
  page_id bigint,
  buffer_id uuid not null,
  seq bigint not null,
  at timestamptz not null,
  from_step text not null,
  to_step text not null,
  stop_reason text,
  halted boolean not null,
  retry_at timestamptz,
  note text not null,
  chrome_version text not null,
  operator_version text not null,
  crash_dumps integer,
  taken_at timestamptz not null default clock_timestamp(),
  constraint page_browser_transitions_event_key unique (buffer_id, seq),
  constraint page_browser_transitions_check check (seq > 0 and (crash_dumps is null or crash_dumps >= 0) and length(note) <= 1024)
);

create index if not exists page_browser_transitions_profile_at_idx on page_browser_transitions (profile_id, at);

comment on table page_browser_transitions is
  'Project Browser (0288): every change of a page operator''s step as its buffer delivered it (browser.transition, minor 5), keyed by (buffer_id, seq): from, to, stop reason, halted, the next retry, the note (IPs masked), the versions and Chrome''s crash dumps then. page_id: the page the profile served when taken (null: none).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (hub_send_allowed, hub_send_blocked_reason, hub_send_blocked_since, crash_dumps_completed,
      crash_dumps_completed_newest_at, crash_dumps_pending, crash_dumps_pending_newest_at, crash_dumps_counted_at)
      on page_browsers to read_only;
    grant select on page_browser_transitions to read_only;
  end if;
end $$;
