-- Bounded read operation for A0/T0. The raw started_at predicates precede
-- aggregation, so a short report can use the existing retention indexes.
create function fansly_events_measurement_report(
  window_start timestamptz, window_end timestamptz
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare result jsonb;
begin
  if window_start is null or window_end is null or window_start >= window_end
     or window_end - window_start > interval '8 days' then
    raise exception 'An ordered report window of at most eight days is required';
  end if;

  with attempts as (
    select a.page_id, p.label as page_label, a.stream, a.operation, coalesce(a.source, r.source) as source,
           (a.started_at at time zone 'UTC')::date as day,
           a.state, a.failure_kind, a.http_status,
           count(*) as attempts,
           count(*) filter (where a.attempt_number > 1) as retry_attempts,
           sum(a.response_body_bytes) as captured_payload_bytes,
           count(*) filter (where a.response_body_bytes is null) as unknown_bytes
    from public.sync_http_attempts a join public.pages p on p.id = a.page_id
    join public.sync_runs r on r.id = a.sync_run_id
    where a.provider = 'fansly'
      and a.started_at >= window_start and a.started_at < window_end
    group by a.page_id, p.label, a.stream, a.operation, coalesce(a.source, r.source),
             (a.started_at at time zone 'UTC')::date,
             a.state, a.failure_kind, a.http_status
  ), runs as materialized (
    select r.*, p.label as page_label
    from public.sync_runs r join public.pages p on p.id = r.page_id
    where p.platform = 'fansly'
      and r.started_at < window_end
      and (r.started_at >= window_start or r.finished_at >= window_start or r.finished_at is null)
  ), http_coverage as (
    select r.page_label, r.stream, r.source,
           (r.started_at at time zone 'UTC')::date as day,
           count(*) as runs,
           count(*) filter (where r.started_at < window_start or r.finished_at >= window_end)
             as boundary_runs,
           count(*) filter (
             where r.finished_at is null or
               not coalesce(r.stats -> 'requestTotals' ?&
                 array['unrecordedAttempts', 'unfinishedAttempts'], false)
           ) as unknown_runs,
           sum((r.stats #>> '{requestTotals,unrecordedAttempts}')::bigint)
             as unrecorded_attempts,
           sum((r.stats #>> '{requestTotals,unfinishedAttempts}')::bigint)
             as unfinished_attempts
    from runs r
    group by r.page_label, r.stream, r.source,
             (r.started_at at time zone 'UTC')::date
  ), dm_run_receipts as (
    select r.*, receipt.shadow,
           s.status as report_status
    from runs r
    left join lateral (
      select e.details -> 'dmShadow' as shadow
      from public.sync_run_events e
      where e.sync_run_id = r.id and e.event_type = 'note'
        and e.details ? 'dmShadow'
      order by e.emitted_at desc, e.id desc limit 1
    ) receipt on true
    left join public.fansly_dm_shadow_sweeps s
      on s.page_id = r.page_id
      and s.generation = (receipt.shadow ->> 'generation')::bigint
    where r.stream = 'dm_conversations'
  ), dm_coverage as (
    select r.page_label, count(*) as runs,
           count(*) filter (
             where r.shadow is null or r.finished_at is null
           ) as unknown_runs,
           count(*) filter (where r.outcome = 'failed') as failed_runs,
           count(*) filter (
             where r.shadow is not null and
               (r.report_status is null or
                r.shadow ->> 'reportPersisted' = 'false')
           ) as lost_report_runs
    from dm_run_receipts r group by r.page_label
  ), sweeps as (
    select p.label as page_label, s.*,
           extract(epoch from s.finished_at - s.started_at) * 1000 as duration_ms
    from public.fansly_dm_shadow_sweeps s
    join public.pages p on p.id = s.page_id
    where s.started_at >= window_start and s.started_at < window_end
  )
  select jsonb_build_object(
    'windowStart', window_start, 'windowEnd', window_end,
    'lossCounterScope', 'Overlapping runs; boundary losses cannot be assigned to an exact attempt time',
    'attempts', coalesce((select jsonb_agg(to_jsonb(a)) from attempts a), '[]'::jsonb),
    'httpCoverage', coalesce((select jsonb_agg(to_jsonb(c)) from http_coverage c), '[]'::jsonb),
    'dmCoverage', coalesce((select jsonb_agg(to_jsonb(c)) from dm_coverage c), '[]'::jsonb),
    'sweeps', coalesce((select jsonb_agg(to_jsonb(s)) from sweeps s), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- This operation exposes counts and bounded diagnostic scalars, never headers,
-- credentials, message bodies or arbitrary SQL. Underlying tables stay private.
revoke all on function fansly_events_measurement_report(timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant execute on function fansly_events_measurement_report(timestamptz, timestamptz)
      to read_only;
  end if;
end $$;
