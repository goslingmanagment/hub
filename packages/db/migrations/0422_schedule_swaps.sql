-- agency-hub:rollback-compatible — nullable columns, a widened kind list and an index; at deploy time no row uses them.
-- 0422_schedule_swaps.sql
--
-- «Подмена» and «Предложить сетку» (products plan 2026-11-13 §2.3, package W) are QUESTIONS (0418 `team_questions`), never a
-- second ask/decide mechanism and never a second schedule:
--
-- - A swap is a question of the kind `swap` with its details (`team_questions.swap`: the day, the pages, the hours, who is
--   absent, who covers). Its «Можно» writes, in the answer's transaction, the registry's one-day lines of that day in the
--   one schedule table (`person_schedule_slots`, 0384): a `cover` line for the covering person on each page (on top of
--   their own lines), an `off` line for the absent person on each page (none of their lines runs there that day). Both
--   name the question. Taking the swap back before the day marks the lines revoked; nothing is deleted.
-- - «Предложить сетку» is a question of the new kind `schedule` from a lead to the owner (one line of words); the owner
--   changes the standing schedule on the person's card as before.
--
-- Rollback. The previous image runs on this schema unchanged: at deploy time no row has a `kind`, a `question_id` or a
-- `revoked_at`, and no question is of the kind `schedule`. After the first approved swap a previous image would misread
-- the swap's lines as plain standing lines: the covering person's `cover` line on a page would stand INSTEAD of their own
-- every-page line on that page that day (a page's own line replaces the every-page one), and the absent person's `off`
-- line would read as a slot, so the absent person would still count as scheduled that day; a revoked swap would still
-- count. Nothing else of the previous image reads these columns.

set local lock_timeout = '5s';

alter table person_schedule_slots add column if not exists kind text;
alter table person_schedule_slots add column if not exists question_id bigint references team_questions(id) on delete restrict;
alter table person_schedule_slots add column if not exists revoked_at timestamptz;
alter table person_schedule_slots add column if not exists revoked_by_user_id bigint references users(id) on delete restrict;

alter table person_schedule_slots drop constraint if exists person_schedule_slots_kind_check;
alter table person_schedule_slots add constraint person_schedule_slots_kind_check check (kind is null or kind in ('cover', 'off'));
-- A swap's line: one page, one day, its question. A standing line has none of it.
alter table person_schedule_slots drop constraint if exists person_schedule_slots_day_line_check;
alter table person_schedule_slots add constraint person_schedule_slots_day_line_check check (
  (kind is null and question_id is null and revoked_at is null)
  or (kind is not null and page_id is not null and valid_from is not null and valid_to = valid_from and question_id is not null)
);
alter table person_schedule_slots drop constraint if exists person_schedule_slots_revoked_check;
alter table person_schedule_slots add constraint person_schedule_slots_revoked_check check ((revoked_at is null) = (revoked_by_user_id is null));

create index if not exists person_schedule_slots_day_lines_idx on person_schedule_slots (valid_from) where kind is not null and revoked_at is null;
create index if not exists person_schedule_slots_question_idx on person_schedule_slots (question_id) where question_id is not null;

-- The swap's details; null for every other kind.
alter table team_questions add column if not exists swap jsonb;
alter table team_questions drop constraint if exists team_questions_swap_check;
alter table team_questions add constraint team_questions_swap_check check (swap is null or (kind = 'swap' and jsonb_typeof(swap) = 'object'));

-- The kinds, rewritten whole: «Предложить сетку» (`schedule`) beside 0418's.
alter table team_questions drop constraint if exists team_questions_kind_check;
alter table team_questions add constraint team_questions_kind_check
  check (kind in ('discount_over_50', 'free_paid', 'custom_price', 'whale_terms', 'swap', 'late', 'schedule'));

comment on column person_schedule_slots.kind is
  'null — a standing line; cover / off — a one-day line of an approved swap (0422, its question in question_id).';
