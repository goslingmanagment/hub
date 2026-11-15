-- agency-hub:rollback-compatible — one nullable column: the previous image never names it.
-- 0416_mark_by_proposal.sql
--
-- The «Отчёт» board: a proposal of Gengar the person accepted («Подтверждаю» without «Не согласен», or «Принять» of a
-- late card) becomes the person's own word at that moment — written as their mark, and the mark says it came «по правке
-- Генгара». Null — the person's own choice.

set local lock_timeout = '5s';

alter table shift_handin_marks add column if not exists by_proposal_id bigint references shift_handin_proposals(id) on delete restrict;

comment on column shift_handin_marks.by_proposal_id is
  'The proposal of Gengar the person accepted, this word came from (0416); null — the person''s own choice.';
