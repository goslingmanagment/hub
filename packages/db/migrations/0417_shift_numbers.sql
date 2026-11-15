-- agency-hub:rollback-compatible — one new table only: the previous image never names it.
-- 0417_shift_numbers.sql
--
-- A closed shift's numbers, stored (products plan 2026-11-13 §5, package N): what
-- `shiftNumbersOf` (apps/runtime/src/services/chatter-numbers.ts) gives for the shift,
-- written by the SAME function, so the team reads stop recounting 14 days of every
-- chatter's messages on each request. Not a second definition: a row is a copy of
-- the live computation, recomputed when what it was computed from changes.
--
-- shift_numbers  one row per closed shift of a LOGIN (user_id, started_at): the shift
--   as chatter-shifts.ts computed it (ended_at, worked_minutes), `key` — the shift's
--   own inputs (its pages, the pages whose every fan it answers for, the automated
--   openings), `inputs_mark` — a cheap mark of the facts read for it (messages,
--   author reports, purchases): a late author report or a late message changes the
--   mark and the row is rewritten; a merged or moved shift is a new start or a new
--   end, so its row no longer matches and is recomputed. `revision` — the revision of
--   the definition that wrote the row (SHIFT_NUMBERS_REVISION): a row of another one
--   is recomputed, never mixed. `numbers` — the ShiftNumbersRow itself.
-- A going shift has no row: it is computed live, as before.

create table if not exists shift_numbers (
  user_id bigint not null references users(id),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  worked_minutes integer not null,
  revision integer not null,
  key text not null,
  inputs_mark text not null,
  numbers jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, started_at),
  constraint shift_numbers_window_check check (ended_at >= started_at),
  constraint shift_numbers_numbers_check check (jsonb_typeof(numbers) = 'object')
);

create index if not exists shift_numbers_started on shift_numbers (started_at);
