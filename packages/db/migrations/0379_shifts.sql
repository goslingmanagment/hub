-- agency-hub:rollback-compatible — two new tables only: the previous image never names them.
-- 0379_shifts.sql
--
-- A chatter's shift as a row with a stable id (the ecosystem plan, package C).
-- What a shift is stays chatter-shifts.ts's (`workOfMinutes`, computed from the
-- extension's activity and the person's messages): a job writes what it
-- computes here, so a shift can be named by its id while its start moves (a
-- look-in before it joins it, two pieces merge) and once it is over.
--
-- `shifts`: one row per shift, from the minute Hub recognises it.
--   state — going (still on: its end is the last time the job looked),
--   closed (over), dropped (late activity made it no shift: a look-in, or
--   gone), merged (late activity joined it to another shift, `merged_into`).
--   A dropped or merged row is never deleted: an address that named it still
--   resolves. report_date — the Moscow day the shift is reported on (ledger's
--   report-date rule: the day it starts, unless it starts within two hours
--   before midnight and mostly lies after it).
--   pages — [{pageLabel, activeMinutes, messages, salesFrom}], as Workboard
--   shows a shift; pauses — [{from, to}].
-- `shift_changes`: the trace of every change of a row after it was opened
--   (what it was before, what it became), so a late change of activity never
--   rewrites a shift silently.
--
-- No screen reads these yet: the screens compute their shifts live, as before.

create table if not exists shifts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  state text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  worked_minutes integer not null,
  messages integer not null,
  report_date date not null,
  pages jsonb not null default '[]'::jsonb,
  pauses jsonb not null default '[]'::jsonb,
  merged_into bigint references shifts(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint shifts_state_check check (state in ('going', 'closed', 'dropped', 'merged')),
  constraint shifts_window_check check (ended_at >= started_at),
  constraint shifts_merged_check check ((state = 'merged') = (merged_into is not null)),
  constraint shifts_pages_check check (jsonb_typeof(pages) = 'array'),
  constraint shifts_pauses_check check (jsonb_typeof(pauses) = 'array')
);

create index if not exists shifts_user_start on shifts (user_id, started_at);
create index if not exists shifts_ended on shifts (ended_at);
create index if not exists shifts_report_date on shifts (report_date);

create table if not exists shift_changes (
  id bigint generated always as identity primary key,
  shift_id bigint not null references shifts(id),
  changed_at timestamptz not null default now(),
  change text not null,
  before jsonb,
  after jsonb not null,
  constraint shift_changes_change_check check (change in ('opened', 'moved', 'closed', 'reopened', 'dropped', 'restored', 'merged'))
);

create index if not exists shift_changes_shift on shift_changes (shift_id, changed_at);

comment on table shifts is 'A chatter''s shift with a stable id, as chatter-shifts.ts computes it; written by the shift-rows job.';
comment on table shift_changes is 'Every change of a shift row after it was opened: the row before and after.';
