SET statement_timeout = '180s';
select o.received_at, p.label, o.kind, (o.payload is not null) as inline,
       left(coalesce(o.payload::text, coalesce(j.body::text,'<no-inline>')), 300) as body
from observations o
join pages p on p.id=o.account_id
left join capture_json_hot_bodies j
  on j.bucket_month = o.payload_bucket_month and j.object_id = o.payload_object_id
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
  and o.kind like '%:failed'
order by o.received_at desc limit 20;
