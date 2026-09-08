SET statement_timeout = '180s';
-- failed observations per page per day
select p.label as page, (o.received_at at time zone 'UTC')::date as utc_day, o.kind, count(*) as n
from observations o join pages p on p.id=o.account_id
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
  and o.kind like '%:failed'
group by 1,2,3 order by 2,1,3;
