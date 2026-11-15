-- agency-hub:rollback-compatible — a column with a default and three nullable columns: the previous image never names them.
-- 0413_shift_report_late_mark.sql
--
-- The «Отчёт» board (products plan 2026-11-13, package R): the dot of «после сдачи» without computing the draft.
--
-- shift_handins.late_sales — how many sales the rule gives the person on this shift (`sale_homes`) that no version of
--   the report holds, as the board's minute pass found them after the report was counted; 0 — none. The extension's
--   pulse reads it; a version that takes them sets it back to 0 at the next pass.

set local lock_timeout = '5s';

alter table shift_handins add column if not exists late_sales integer not null default 0;

alter table shift_handins drop constraint if exists shift_handins_late_sales_check;
alter table shift_handins add constraint shift_handins_late_sales_check check (late_sales >= 0);

comment on column shift_handins.late_sales is
  'Sales of the person on this shift no version holds, found after it was counted (0413): the pulse''s dot «после сдачи».';

-- shift_handins.fixing_from — the phase «Исправить» came from (`counted` or `confirm`): «Отмена» returns there when it
--   still stands (a counted version; the same candidate still the newest), else to the draft. Null — not fixing.
-- shift_handins.post_copied_at, post_copied_version — when the person last pressed «Скопировать пост», and which version
--   it was: a later version that changes a page sum says «Пост изменился» and opens the person's matter.
alter table shift_handins
  add column if not exists fixing_from text,
  add column if not exists post_copied_at timestamptz,
  add column if not exists post_copied_version integer;

alter table shift_handins drop constraint if exists shift_handins_fixing_from_check;
alter table shift_handins add constraint shift_handins_fixing_from_check check (fixing_from is null or fixing_from in ('counted', 'confirm'));
alter table shift_handins drop constraint if exists shift_handins_post_copied_check;
alter table shift_handins add constraint shift_handins_post_copied_check check ((post_copied_at is null) = (post_copied_version is null));
