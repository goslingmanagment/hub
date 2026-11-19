-- agency-hub:rollback-compatible — three nullable columns and a check that holds for every row the previous image writes (it never names the columns, so all three stay null).
-- 0433_shift_handin_candidate_signature.sql
--
-- «Сдать смену» on the «Отчёт» board is the person's signature (owner, 2026-11-19): the hand-in carries what the person
-- saw on the draft (the bar's total and count), and when it equals what the candidate holds the candidate is SIGNED.
-- When the check then changes nothing, the server applies that signature as the person's «Подтверждаю» (the same
-- confirmation, the same comparison); when it changes anything, the signature is cleared and the person confirms by
-- hand as before. A candidate re-made by Hub's re-check is never signed; an agent's «со слов» hand-in is never signed.
--
-- signed_total_mills, signed_count — what the person saw and signed; signed_at — when. All three or none.

set local lock_timeout = '5s';

alter table shift_handin_candidates
  add column if not exists signed_total_mills bigint,
  add column if not exists signed_count integer,
  add column if not exists signed_at timestamptz;

alter table shift_handin_candidates drop constraint if exists shift_handin_candidates_signed_check;
alter table shift_handin_candidates add constraint shift_handin_candidates_signed_check check (
  (signed_total_mills is null) = (signed_at is null)
  and (signed_count is null) = (signed_at is null)
  and (signed_count is null or signed_count >= 0)
  and (signed_at is null or door <> 'telegram')
);

comment on column shift_handin_candidates.signed_at is
  'The person signed the candidate at «Сдать смену» (0433): the total and count they saw equal the candidate''s; cleared when the check changed anything.';
