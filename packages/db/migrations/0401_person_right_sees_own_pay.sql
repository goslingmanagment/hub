-- agency-hub:rollback-compatible — only a wider person_rights check: the previous image never writes the new right and ignores it on a person.
-- 0401_person_right_sees_own_pay.sql
--
-- `sees_own_pay` («видит свои деньги», ecosystem plan, package H1): the
-- person's switch of «Мои деньги» on «Мои смены» — what the agency ledger
-- accrued to them, what it owes them now and when it last paid them. Off (no
-- row) — the screen stays as it was. Nothing else.
--
-- The check is rewritten whole, so it carries every right of the migrations
-- before it: customs_lead (0384), records_customs (0399), submits_shift
-- (0400).

set local lock_timeout = '5s';

alter table person_rights
  drop constraint person_rights_right_check,
  add constraint person_rights_right_check check ("right" in ('customs_lead', 'records_customs', 'submits_shift', 'sees_own_pay'));

comment on table person_rights is
  'Narrow rights beside the role: customs_lead («ведёт кастомы»), records_customs («записывает кастомы в системе»), submits_shift («сдаёт смену в системе»), sees_own_pay («видит свои деньги»).';
