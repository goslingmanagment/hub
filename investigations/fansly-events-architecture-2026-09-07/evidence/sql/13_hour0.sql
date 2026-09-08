SET statement_timeout = '180s';
select split_part(o.producer,':',3) as stream, o.kind, count(*) as n
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
  and extract(hour from o.received_at at time zone 'UTC') = 0
  and o.producer not in ('sync:fansly:dm_conversations','sync:fansly:dm_messages','sync:fansly:fan_earnings','sync:fansly:followers_reconcile')
group by 1,2 order by n desc limit 15;
