SET statement_timeout = '180s';
with s as (
  select p.label as page, split_part(o.producer,':',3) as stream,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as req_seq,
         count(*) as reqs
  from observations o join pages p on p.id=o.account_id
  where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
    and o.source='pull' and o.kind not like '%:failed'
  group by 1,2,3
), per_page as (
  select page, stream, count(*)/6.0 as sched_per_day, sum(reqs)/6.0 as reqs_per_day
  from s group by 1,2
)
select stream,
       round(avg(sched_per_day),2) as sched_runs_per_page_per_day,
       round(86400/nullif(avg(sched_per_day),0)) as implied_cadence_s,
       round(sum(reqs_per_day)/nullif(sum(sched_per_day),0),1) as reqs_per_scheduled_run,
       round(sum(reqs_per_day),0) as fleet_reqs_per_day,
       round(100.0*sum(reqs_per_day)/ (select sum(reqs_per_day) from per_page),2) as pct
from per_page group by 1 order by fleet_reqs_per_day desc;
