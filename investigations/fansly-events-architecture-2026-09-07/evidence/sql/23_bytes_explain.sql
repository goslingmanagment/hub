SET statement_timeout = '180s';
EXPLAIN
select o.kind, count(*), sum(c.logical_bytes)
from observations o
join capture_payload_objects c
  on c.bucket_month = o.payload_bucket_month and c.object_id = o.payload_object_id
where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1;
