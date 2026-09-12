-- C1 diagnostics only. No follower state or reconcile policy changes.
create function fansly_followers_diagnostic_report(window_start timestamptz, window_end timestamptz)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare result jsonb;
begin
  if window_start is null or window_end is null or window_start >= window_end
     or window_end - window_start > interval '8 days' then
    raise exception 'An ordered report window of at most eight days is required';
  end if;
  with runs as materialized (
    select r.id, p.label as page_label, r.outcome, r.finished_at,
           receipt.d, coalesce(receipt.receipt_count, 0) as receipt_count
    from public.sync_runs r join public.pages p on p.id = r.page_id
    left join lateral (
      select e.details -> 'followersReconcile' as d, count(*) over () as receipt_count
      from public.sync_run_events e
      where e.sync_run_id = r.id and e.event_type = 'note'
        and e.details ? 'followersReconcile'
        and e.emitted_at >= window_start and e.emitted_at < window_end
      order by e.id limit 1
    ) receipt on true
    where p.platform = 'fansly' and r.stream = 'followers'
      and r.started_at >= window_start and r.started_at < window_end
  ), classified as (
    select *, coalesce(
      receipt_count = 1 and d @> '{"schemaVersion":1}'::jsonb
      and jsonb_typeof(d -> 'countMismatch') = 'boolean'
      and jsonb_typeof(d -> 'exhaustedWithoutKnown') = 'boolean'
      and jsonb_typeof(d -> 'unchangedHeadWithRows') = 'boolean'
      and jsonb_typeof(d -> 'requested') = 'boolean'
      and d -> 'requested' = to_jsonb(
        d ->> 'countMismatch' = 'true' or d ->> 'exhaustedWithoutKnown' = 'true'
        or d ->> 'unchangedHeadWithRows' = 'true'
      ), false) as valid
    from runs
  ), queue_receipts as (
    select *, case
      when valid and d ->> 'requested' = 'true'
        and jsonb_typeof(d -> 'requestedSeq') = 'number'
        and jsonb_typeof(d #> '{queueBefore,requestedSeq}') = 'number'
        and jsonb_typeof(d #> '{queueBefore,appliedSeq}') = 'number'
      then (d #>> '{queueBefore,appliedSeq}')::numeric >= 0
        and trunc((d ->> 'requestedSeq')::numeric) = (d ->> 'requestedSeq')::numeric
        and trunc((d #>> '{queueBefore,requestedSeq}')::numeric) = (d #>> '{queueBefore,requestedSeq}')::numeric
        and trunc((d #>> '{queueBefore,appliedSeq}')::numeric) = (d #>> '{queueBefore,appliedSeq}')::numeric
        and (d ->> 'requestedSeq')::numeric = (d #>> '{queueBefore,requestedSeq}')::numeric + 1
        and (d #>> '{queueBefore,appliedSeq}')::numeric <= (d #>> '{queueBefore,requestedSeq}')::numeric
      else false end as queue_valid
    from classified
  ), coverage as (
    select page_label, outcome, count(*) as runs,
           count(*) filter (where valid) as decisions,
           count(*) filter (where receipt_count = 0) as missing_decisions,
           count(*) filter (where receipt_count > 1) as duplicate_decisions,
           count(*) filter (where receipt_count = 1 and not valid) as invalid_decisions,
           count(*) filter (where finished_at is null or finished_at >= window_end) as unfinished_in_window
    from classified group by page_label, outcome
  ), decisions as (
    select page_label,
           d ->> 'countMismatch' = 'true' as count_mismatch,
           d ->> 'exhaustedWithoutKnown' = 'true' as exhausted_without_known,
           d ->> 'unchangedHeadWithRows' = 'true' as unchanged_head_with_rows,
           d ->> 'requested' = 'true' as requested,
           outcome, count(*) as decisions
    from classified where valid
    group by page_label, outcome, d ->> 'countMismatch', d ->> 'exhaustedWithoutKnown',
             d ->> 'unchangedHeadWithRows', d ->> 'requested'
  ), queue_counts as (
    select page_label,
      count(*) filter (where valid and d ->> 'requested' = 'true') as requested,
      count(*) filter (where queue_valid) as known_queue_receipts,
      count(*) filter (where valid and d ->> 'requested' = 'true' and not queue_valid) as unknown_queue_receipts,
      count(*) filter (where case when queue_valid then
        (d #>> '{queueBefore,requestedSeq}')::numeric > (d #>> '{queueBefore,appliedSeq}')::numeric
        else false end) as requests_with_pending_work
    from queue_receipts group by page_label
  )
  select jsonb_build_object(
    'windowStart', window_start, 'windowEnd', window_end,
    'scope', 'Runs started in the window; only decision receipts emitted inside it. Missing is unknown.',
    'coverage', coalesce((select jsonb_agg(to_jsonb(c) order by page_label, outcome) from coverage c), '[]'),
    'decisions', coalesce((select jsonb_agg(to_jsonb(d) order by page_label, outcome) from decisions d), '[]'),
    'queue', coalesce((select jsonb_agg(to_jsonb(q) order by page_label) from queue_counts q), '[]')
  ) into result;
  return result;
end;
$$;
revoke all on function fansly_followers_diagnostic_report(timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant execute on function fansly_followers_diagnostic_report(timestamptz, timestamptz) to read_only;
  end if;
end $$;
