SET statement_timeout = '180s';
-- consecutive-sweep comparison: same page, same rank (offset slot) within the sweep
with r as (
  select p.label as page,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as sweep,
         min(o.received_at) over (partition by p.label, split_part(split_part(o.idempotency_key,':',4),'.',1)) as sweep_t0,
         row_number() over (partition by p.label, split_part(split_part(o.idempotency_key,':',4),'.',1) order by o.received_at) as rk,
         o.payload_object_id as oid
  from observations o join pages p on p.id=o.account_id
  where o.received_at >= timestamptz '2026-09-05 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.producer='sync:fansly:dm_conversations' and o.kind='dm_conversations'
    and o.payload_object_id is not null
), c as (
  select page, sweep, sweep_t0, rk, oid,
         lag(oid) over (partition by page, rk order by sweep_t0) as prev_oid
  from r
)
select page, count(*) filter (where prev_oid is not null) as comparable_reqs,
       count(*) filter (where prev_oid is not null and oid = prev_oid) as identical_to_prev_sweep,
       round(100.0*count(*) filter (where prev_oid is not null and oid = prev_oid)
             / nullif(count(*) filter (where prev_oid is not null),0),1) as pct_unchanged_vs_prev_sweep
from c group by 1 order by 1;
