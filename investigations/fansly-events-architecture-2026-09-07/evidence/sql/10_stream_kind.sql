SET statement_timeout = '180s';
with d as (
  select split_part(o.producer,':',3) as stream, o.kind,
         (o.received_at at time zone 'UTC')::date as utc_day, count(*) as n
  from observations o
  where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
  group by 1,2,3
)
select stream, kind, sum(n) as total_14d,
       round(sum(n)::numeric/14,1) as per_day_14d,
       round(sum(n) filter (where utc_day not in (date '2026-08-28', date '2026-08-29'))::numeric/12,1) as per_day_clean,
       round(100.0*sum(n)/ (select sum(n) from d),2) as pct_of_fleet
from d group by 1,2 order by total_14d desc;
