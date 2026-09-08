SET statement_timeout = '180s';
EXPLAIN
select (o.received_at at time zone 'UTC')::date as d, o.account_id, o.kind, o.source, count(*)
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1,2,3,4;
