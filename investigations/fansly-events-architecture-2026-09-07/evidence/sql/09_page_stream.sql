SET statement_timeout = '180s';
-- per page x stream: mean/day over 14 days, and over the 12 "clean" days (excl 08-28, 08-29)
with d as (
  select p.label as page,
         split_part(o.producer,':',3) as stream,
         (o.received_at at time zone 'UTC')::date as utc_day,
         count(*) as n
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
  group by 1,2,3
)
select page, stream,
       sum(n) as total_14d,
       round(sum(n)::numeric/14,1) as mean_per_day_14d,
       round(sum(n) filter (where utc_day not in (date '2026-08-28', date '2026-08-29'))::numeric/12,1) as mean_per_day_clean
from d group by 1,2 order by page, total_14d desc;
