-- agency-hub:rollback-compatible — the check only widens: the previous image never writes the new value and reads `escalated_why` as text.
-- 0434_sale_claims_escalated_paid.sql
--
-- A colleague's sale written to oneself counts at once (0-migration change of 2026-11-21) — except when the colleague's
-- report of a day the ledger already paid counts the sale: that money is out, so nothing moves by a word alone and the
-- claim is the owner's at once. `escalated_why = 'paid'` says why it went to him.

set local lock_timeout = '5s';

alter table sale_claims drop constraint if exists sale_claims_escalated_check;
alter table sale_claims add constraint sale_claims_escalated_check
  check (escalated_why is null or escalated_why in ('disagree', 'silence', 'no_side', 'double', 'imported', 'question', 'paid'));
