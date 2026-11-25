-- agency-hub:rollback-compatible — widens person_rights_right_check and backfills `reviews_shift_reports` on existing active reviewer agents: the previous image ignores the new right value and keeps resolving reviewers from keys.
-- 0449_person_right_reviews_shift_reports.sql
--
-- Decouples the `review:shift_reports` key capability from automatic shift-report reviewer assignment (OA-002):
-- granting `review:shift_reports` to an administrative or machine key no longer makes it an expected shift-report
-- reviewer unless its agent person explicitly holds `reviews_shift_reports` in `person_rights`.
--
-- Backfills `reviews_shift_reports` onto every currently active agent person holding a live key with
-- `review:shift_reports` so existing production and sandbox reviewers continue uninterrupted.

set local lock_timeout = '5s';

alter table person_rights
  drop constraint person_rights_right_check,
  add constraint person_rights_right_check check ("right" in ('customs_lead', 'records_customs', 'submits_shift', 'sees_own_pay', 'reviews_shift_reports'));

comment on table person_rights is
  'Narrow rights beside the role: customs_lead («ведёт кастомы»), records_customs («записывает кастомы в системе»), submits_shift («сдаёт смену в системе»), sees_own_pay («видит свои деньги»), reviews_shift_reports («проверяет отчёты смен»).';

insert into person_rights (person_id, "right")
select distinct p.id, 'reviews_shift_reports'
from people p
join person_agent_keys pak on pak.person_id = p.id
join agent_keys k on k.id = pak.agent_key_id
where p.kind = 'agent'
  and p.state <> 'left'
  and 'review:shift_reports' = any(k.capabilities)
  and k.revoked_at is null
  and k.expires_at > now()
on conflict (person_id, "right") do nothing;
