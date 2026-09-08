SET statement_timeout = '180s';
with x as (
  select split_part(o.producer,':',3) as stream, o.kind, c.logical_bytes,
         (o.received_at at time zone 'UTC')::date as d
  from observations o
  join capture_payload_objects c
    on c.bucket_month = o.payload_bucket_month and c.object_id = o.payload_object_id
  where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
)
select stream, kind, count(*) as obs_6d,
       round(count(*)::numeric/6,0) as obs_per_day,
       pg_size_pretty(round(sum(logical_bytes)/6.0)) as bytes_per_day,
       round(avg(logical_bytes)) as avg_bytes_per_req,
       round(100.0*sum(logical_bytes)/(select sum(logical_bytes) from x),2) as pct_bytes
from x group by 1,2 order by sum(logical_bytes) desc limit 25;
