SET statement_timeout = '180s';
-- hourly profile, fleet-wide, dm_conversations stream vs everything else
select extract(hour from o.received_at at time zone 'UTC')::int as utc_hour,
       count(*) filter (where o.producer = 'sync:fansly:dm_conversations') as dm_conv_stream,
       count(*) filter (where o.producer = 'sync:fansly:dm_messages')      as dm_messages_stream,
       count(*) filter (where o.producer = 'sync:fansly:fan_earnings')     as fan_earnings,
       count(*) filter (where o.producer = 'sync:fansly:followers_reconcile') as foll_reconcile,
       count(*) filter (where o.producer not in ('sync:fansly:dm_conversations','sync:fansly:dm_messages','sync:fansly:fan_earnings','sync:fansly:followers_reconcile')) as other,
       count(*) as total,
       round(count(*)::numeric/14,1) as per_hour_avg
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1 order by 1;
