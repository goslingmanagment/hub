SET statement_timeout = '180s';
select p.label as page, w.last_rebuilt_at, w.updated_at, now() - w.last_rebuilt_at as lag
from projection_watermarks w join pages p on p.id = w.platform_account_id
order by w.last_rebuilt_at;
select p.label as page, (o.received_at at time zone 'UTC')::date as d, count(*) as reqs
from observations o join pages p on p.id=o.account_id
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1,2 order by 1,2;
