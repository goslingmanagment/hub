SET statement_timeout = '180s';
select o.kind, o.idempotency_key, o.received_at, (o.payload is null) as payload_null, o.payload_object_id
from observations o
where o.received_at >= timestamptz '2026-09-06 12:00:00+00'
  and o.received_at <  timestamptz '2026-09-06 12:20:00+00'
  and o.account_id = 5
order by o.received_at limit 25;
