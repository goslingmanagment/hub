-- agency-hub:rollback-compatible — three new tables nothing of the previous image names.
-- 0391_system_state.sql
--
-- «Состояние» (ecosystem plan §3.6, §6, package P): every routine and every
-- copy of the system, seen from the owner's place. A reporter (the Mac's
-- script, later others) sends its whole list with an agent key; Hub writes its
-- own facts (its job schedules, the ledger's health) as the reporter `hub`.
--
-- system_reporters — one row per reporter: when it last reported, and since
-- when it reports without a silence (its routines are not called silent for a
-- grace after it comes back: a sleeping Mac is not a broken routine).
--
-- system_routines — one row per routine key, owned by one reporter.
--   place             where it runs: server | mac | pc
--   title             what a person reads, given by the reporter (Russian)
--   period_seconds    how often it is meant to run at most: the longest gap of its schedule
--   last_run_at       when it last ran (never goes back)
--   last_success_at   when it last did its work (never goes back)
--   last_result       ok | failed | skipped | empty_input; null — never ran or the outcome is not seen.
--                     A routine is never fine merely because it ran: skipped and empty_input are their own.
--   failed_streak     failed runs in a row (the routine's own count, or Hub's of the runs it saw)
--   empty_since       since when its input is empty; empty_threshold_seconds — how long that may last
--   run_count         a counter of runs that only grows while its host is up (launchd); its change is a run Hub saw
--   retired_at        the reporter stopped sending it: kept, no longer watched
--
-- system_copies — one row per copy key: what, from where to where, when the
-- newest was taken, its size, how many are kept.

set local lock_timeout = '5s';

create table if not exists system_reporters (
  reporter text primary key,
  place text not null,
  agent_key_id bigint references agent_keys(id),
  last_report_at timestamptz not null,
  online_since timestamptz not null,
  reporter_read_at timestamptz,
  version text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_reporters_reporter_check check (reporter ~ '^[a-z][a-z0-9-]{0,31}$'),
  constraint system_reporters_place_check check (place in ('server', 'mac', 'pc')),
  constraint system_reporters_version_check check (version is null or length(version) <= 60)
);

comment on table system_reporters is
  'Состояние (0391): who reports routines and copies, when it last did, and since when without a silence; `hub` is Hub itself.';

create table if not exists system_routines (
  routine_key text primary key,
  reporter text not null references system_reporters(reporter),
  place text not null,
  title text not null,
  period_seconds integer not null,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_result text,
  detail text,
  failed_streak integer not null default 0,
  empty_since timestamptz,
  empty_threshold_seconds integer,
  run_count bigint,
  first_seen_at timestamptz not null,
  reported_at timestamptz not null,
  reported_by_key_id bigint references agent_keys(id),
  retired_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_routines_key_check check (routine_key ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  constraint system_routines_place_check check (place in ('server', 'mac', 'pc')),
  constraint system_routines_title_check check (length(title) between 1 and 200),
  constraint system_routines_period_check check (period_seconds between 60 and 3456000),
  constraint system_routines_result_check check (last_result is null or last_result in ('ok', 'failed', 'skipped', 'empty_input')),
  constraint system_routines_detail_check check (detail is null or length(detail) <= 500),
  constraint system_routines_streak_check check (failed_streak >= 0),
  constraint system_routines_empty_threshold_check check (empty_threshold_seconds is null or empty_threshold_seconds > 0),
  constraint system_routines_run_count_check check (run_count is null or run_count >= 0)
);

create index if not exists system_routines_reporter_idx on system_routines (reporter) where retired_at is null;

comment on table system_routines is
  'Состояние (0391): one row per routine — where it runs, its period, last run, last success, last result (ok, failed, skipped, empty_input), who reported it.';

create table if not exists system_copies (
  copy_key text primary key,
  reporter text not null references system_reporters(reporter),
  title text not null,
  source text not null,
  destination text not null,
  taken_at timestamptz,
  bytes bigint,
  kept integer,
  detail text,
  first_seen_at timestamptz not null,
  reported_at timestamptz not null,
  reported_by_key_id bigint references agent_keys(id),
  retired_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_copies_key_check check (copy_key ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  constraint system_copies_words_check check (
    length(title) between 1 and 200 and length(source) between 1 and 200 and length(destination) between 1 and 200
  ),
  constraint system_copies_numbers_check check (coalesce(bytes, 0) >= 0 and coalesce(kept, 0) >= 0),
  constraint system_copies_detail_check check (detail is null or length(detail) <= 500)
);

create index if not exists system_copies_reporter_idx on system_copies (reporter) where retired_at is null;

comment on table system_copies is
  'Состояние (0391): one row per copy — what, from where to where, when the newest was taken, its size, how many are kept.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on system_reporters, system_routines, system_copies to read_only;
  end if;
end
$$;
