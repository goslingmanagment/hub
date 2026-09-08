SET statement_timeout = '180s';
-- A. fleet total per UTC day
select (o.received_at at time zone 'UTC')::date as utc_day, count(*) as obs
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1 order by 1;
-- B. any fansly-platform rows outside those account ids?
select o.platform, o.source, (o.account_id is null) as acct_null, count(*)
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
group by 1,2,3 order by 4 desc;
