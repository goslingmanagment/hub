SET statement_timeout = '180s';
-- runs per day and requests per run, per page x stream (using idempotency_key part 3 = sync_run_id)
with o as (
  select p.label as page,
         split_part(o.producer,':',3) as stream,
         split_part(o.idempotency_key,':',3) as run_id,
         (o.received_at at time zone 'UTC')::date as utc_day
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-08-30 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
    and o.source = 'pull'
), per_run as (
  select page, stream, utc_day, run_id, count(*) as reqs from o group by 1,2,3,4
)
select page, stream,
       round(count(*)::numeric/8,1) as runs_per_day,
       round(sum(reqs)::numeric/8,1) as reqs_per_day,
       round(avg(reqs),2) as avg_reqs_per_run,
       max(reqs) as max_reqs_per_run
from per_run group by 1,2 order by reqs_per_day desc limit 45;
