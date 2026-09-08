SET statement_timeout = '180s';
with s as (
  select p.label as page, split_part(o.producer,':',3) as stream,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as req_seq,
         min(o.received_at) as t0, count(*) as reqs
  from observations o join pages p on p.id=o.account_id
  where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.source='pull' and o.kind not like '%:failed'
  group by 1,2,3
)
select stream,
       round(count(*)::numeric/6/count(distinct page),2) as scheduled_runs_per_page_per_day,
       round(3600*24.0/nullif(count(*)::numeric/6/count(distinct page),0)) as implied_cadence_s,
       round(avg(reqs),1) as avg_reqs_per_scheduled_run,
       round(sum(reqs)::numeric/6,0) as fleet_reqs_per_day
from s group by 1 order by fleet_reqs_per_day desc;
