SET statement_timeout = '180s';
-- how often does a repeated request return a BYTE-IDENTICAL body? (CAS content hash reuse)
select p.label as page, split_part(o.producer,':',3) as stream, o.kind,
       count(*) as requests,
       count(distinct o.payload_object_id) as distinct_bodies,
       round(100.0*(count(*)-count(distinct o.payload_object_id))/nullif(count(*),0),1) as pct_identical_repeat
from observations o join pages p on p.id=o.account_id
where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
  and o.payload_object_id is not null
  and split_part(o.producer,':',3) in ('dm_conversations','fan_earnings','followers_reconcile','notifications','transactions','light','top_spenders','subscribers','followers')
group by 1,2,3 order by requests desc limit 30;
