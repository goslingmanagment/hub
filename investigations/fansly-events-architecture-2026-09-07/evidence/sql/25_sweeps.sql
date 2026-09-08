SET statement_timeout = '180s';
with s as (
  select p.label as page,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as req_seq,
         min(o.received_at) as t0, max(o.received_at) as t1, count(*) as reqs
  from observations o join pages p on p.id=o.account_id
  where o.received_at >= timestamptz '2026-09-05 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.producer='sync:fansly:dm_conversations' and o.kind='dm_conversations'
  group by 1,2
), g as (
  select page, req_seq, t0, t1, reqs,
         lead(t0) over (partition by page order by t0) - t0 as start_gap,
         t1 - t0 as duration
  from s
)
select page, count(*) as sweeps_2d,
       round(avg(reqs),1) as avg_reqs_per_sweep,
       min(reqs) as min_reqs, max(reqs) as max_reqs,
       avg(start_gap) as avg_start_interval,
       percentile_cont(0.5) within group (order by extract(epoch from start_gap)) as median_start_interval_s,
       avg(duration) as avg_sweep_duration
from g group by 1 order by 1;
