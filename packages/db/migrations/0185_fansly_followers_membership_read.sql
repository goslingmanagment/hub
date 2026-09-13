-- C1: retain exact retirement results and disjoint timestamp/generation protection counts.
create or replace function fansly_followers_diagnostic_timeline(
  window_start timestamptz, window_end timestamptz,
  after_run_id bigint default 0, through_run_id bigint default null,
  row_limit integer default 500
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare upper_id bigint; result jsonb;
begin
  if window_start is null or window_end is null or window_start >= window_end
     or window_end - window_start > interval '8 days' then
    raise exception 'An ordered report window of at most eight days is required';
  end if;
  if after_run_id is null or after_run_id < 0 or through_run_id < after_run_id
     or row_limit is null or row_limit < 1 or row_limit > 500 then
    raise exception 'An ordered run cursor and a row limit between 1 and 500 are required';
  end if;
  select coalesce(through_run_id, max(r.id), 0) into upper_id from public.sync_runs r;

  with candidates as materialized (
    select r.*, p.label as page_label
    from public.sync_runs r join public.pages p on p.id = r.page_id
    where p.platform = 'fansly' and r.stream in ('followers', 'followers_reconcile')
      and r.started_at >= window_start and r.started_at < window_end
      and r.id > after_run_id and r.id <= upper_id
    order by r.id limit row_limit + 1
  ), runs as (
    select * from candidates order by id limit row_limit
  ), records as (
    select r.id as run_id, r.page_label, r.stream, r.source,
      r.request_seq, r.leased_seq, r.outcome, r.started_at, r.finished_at,
      r.finished_at is null or r.finished_at >= window_end as unfinished_in_window,
      coalesce(receipt.n, 0) as decision_receipt_count,
      receipt.id as decision_receipt_id, receipt.emitted_at as decision_at,
      decision.valid as decision_valid,
      case when decision.valid and receipt.d ->> 'requested' = 'true'
        and jsonb_typeof(receipt.d -> 'requestedSeq') = 'number'
        and jsonb_typeof(receipt.d #> '{queueBefore,requestedSeq}') = 'number'
        and jsonb_typeof(receipt.d #> '{queueBefore,appliedSeq}') = 'number'
      then (receipt.d #>> '{queueBefore,appliedSeq}')::numeric >= 0
        and trunc((receipt.d ->> 'requestedSeq')::numeric) = (receipt.d ->> 'requestedSeq')::numeric
        and trunc((receipt.d #>> '{queueBefore,requestedSeq}')::numeric)
          = (receipt.d #>> '{queueBefore,requestedSeq}')::numeric
        and trunc((receipt.d #>> '{queueBefore,appliedSeq}')::numeric)
          = (receipt.d #>> '{queueBefore,appliedSeq}')::numeric
        and (receipt.d ->> 'requestedSeq')::numeric = (receipt.d #>> '{queueBefore,requestedSeq}')::numeric + 1
        and (receipt.d #>> '{queueBefore,appliedSeq}')::numeric
          <= (receipt.d #>> '{queueBefore,requestedSeq}')::numeric
      else false end as queue_valid,
      coalesce(membership.n, 0) as membership_receipt_count,
      membership.id as membership_receipt_id, membership.emitted_at as membership_at,
      case when membership.n = 1 and membership.d @> '{"schemaVersion":1}'::jsonb
          and membership_counts.valid
          and jsonb_typeof(membership.d -> 'fullSweepStartedAt') = 'string'
          and length(membership.d ->> 'fullSweepStartedAt') <= 35
          and membership.d ->> 'fullSweepStartedAt' ~ '^[0-9T:.+Z-]+$'
          and pg_input_is_valid(membership.d ->> 'fullSweepStartedAt', 'timestamp with time zone')
          and membership.d ->> 'outcome' in (
            'complete', 'restart', 'non_destructive_complete', 'blast_radius_blocked'
          )
        then (membership.d ->> 'activeFollowerCount')::numeric
            = (membership.d ->> 'activeInGenerationCount')::numeric
              + (membership.d ->> 'activeOutsideGenerationCount')::numeric
          and (membership.d ->> 'activeOutsideGenerationCount')::numeric
            = (membership.d ->> 'deactivationCandidateCount')::numeric
              + (membership.d ->> 'generationGraceOnlyCount')::numeric
              + (membership.d ->> 'touchedSinceStartOnlyCount')::numeric
              + (membership.d ->> 'generationGraceAndTouchCount')::numeric
              + (membership.d ->> 'futureGenerationCount')::numeric
          and case when membership.d ->> 'outcome' = 'complete'
            then case when jsonb_typeof(membership.d -> 'deactivatedCount') = 'number'
              then (membership.d ->> 'deactivatedCount')::numeric >= 0
                and trunc((membership.d ->> 'deactivatedCount')::numeric)
                  = (membership.d ->> 'deactivatedCount')::numeric
              else false end
            else coalesce(membership.d -> 'deactivatedCount' = 'null'::jsonb, false) end
        else false end as membership_receipt_valid,
      fields.sections,
      case when r.stats ->> 'membershipProof' in ('exact_generation', 'new_followers_seen_during_sweep')
        then r.stats ->> 'membershipProof' end as membership_proof,
      r.stats ? 'qualityHold' as has_quality_hold,
      r.stats ? 'gatedSkip' as has_gated_skip
    from runs r
    left join lateral (
      select e.id, e.details -> 'followersReconcile' as d, e.emitted_at, count(*) over () as n
      from public.sync_run_events e
      where e.sync_run_id = r.id and e.event_type = 'note'
        and e.details ? 'followersReconcile'
        and e.emitted_at >= window_start and e.emitted_at < window_end
      order by e.id limit 1
    ) receipt on true
    left join lateral (
      select e.id, e.details -> 'followersMembership' as d, e.emitted_at, count(*) over () as n
      from public.sync_run_events e
      where e.sync_run_id = r.id and e.event_type = 'note'
        and e.details ? 'followersMembership'
        and e.emitted_at >= window_start and e.emitted_at < window_end
      order by e.id limit 1
    ) membership on true
    cross join lateral (
      select bool_and(case when jsonb_typeof(membership.d -> key) = 'number'
        then (membership.d ->> key)::numeric >= 0
          and trunc((membership.d ->> key)::numeric) = (membership.d ->> key)::numeric
        else false end) as valid
      from unnest(array['generation', 'sourceFollowerCount', 'generationObservedCount',
        'activeFollowerCount', 'activeInGenerationCount', 'activeOutsideGenerationCount',
        'deactivationCandidateCount', 'generationGraceOnlyCount', 'touchedSinceStartOnlyCount',
        'generationGraceAndTouchCount', 'futureGenerationCount']) as field(key)
    ) membership_counts
    cross join lateral (
      select coalesce(receipt.n = 1 and receipt.d @> '{"schemaVersion":1}'::jsonb
        and jsonb_typeof(receipt.d -> 'countMismatch') = 'boolean'
        and jsonb_typeof(receipt.d -> 'exhaustedWithoutKnown') = 'boolean'
        and jsonb_typeof(receipt.d -> 'unchangedHeadWithRows') = 'boolean'
        and jsonb_typeof(receipt.d -> 'requested') = 'boolean'
        and receipt.d -> 'requested' = to_jsonb(
          receipt.d ->> 'countMismatch' = 'true' or receipt.d ->> 'exhaustedWithoutKnown' = 'true'
          or receipt.d ->> 'unchangedHeadWithRows' = 'true'), false) as valid
    ) decision
    cross join lateral (
      select jsonb_object_agg(section.name, picked.fields) as sections
      from (values
        ('decision', receipt.d, array['schemaVersion', 'countMismatch', 'exhaustedWithoutKnown',
          'unchangedHeadWithRows', 'requested', 'requestedSeq', 'knownCheckpoint', 'pageDone']),
        ('counts', receipt.d -> 'counts', array['activeFollowerCount', 'sourceFollowerCount',
          'pageCount', 'processedThisChunk']),
        ('queueBefore', receipt.d -> 'queueBefore', array['requestedSeq', 'appliedSeq']),
        ('membership', membership.d, array['schemaVersion', 'outcome', 'generation', 'fullSweepStartedAt',
          'sourceFollowerCount', 'generationObservedCount', 'activeFollowerCount',
          'activeInGenerationCount', 'activeOutsideGenerationCount', 'deactivationCandidateCount',
          'generationGraceOnlyCount', 'touchedSinceStartOnlyCount', 'generationGraceAndTouchCount',
          'futureGenerationCount', 'deactivatedCount']),
        ('statistics', r.stats, array['generation', 'pageCount', 'processedThisChunk',
          'sourceFollowerCount', 'startingSourceFollowerCount', 'generationObservedCount',
          'deactivationCandidateCount', 'deactivationLimit', 'destructiveFinalization',
          'finalizationWithheld', 'nonDestructiveClose', 'snapshotRestartCount']),
        ('checkpointBefore', r.stats #> '{checkpoint,before,followers_reconcile,stateScalars}',
          array['revision', 'generation', 'offset', 'pageCount', 'observedCount',
            'sourceFollowerCount', 'snapshotRestartCount', 'fullSweepStartedAt', 'verificationPending']),
        ('checkpointAfter', r.stats #> '{checkpoint,after,followers_reconcile,stateScalars}',
          array['revision', 'generation', 'offset', 'pageCount', 'observedCount',
            'sourceFollowerCount', 'snapshotRestartCount', 'fullSweepStartedAt', 'verificationPending'])
      ) section(name, body, keys)
      cross join lateral (
        select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) as fields
        from jsonb_each(case when jsonb_typeof(section.body) = 'object'
          then section.body else '{}'::jsonb end) f
        where f.key = any(section.keys) and (
          jsonb_typeof(f.value) in ('number', 'boolean', 'null') or (
            f.key = 'outcome' and f.value #>> '{}' in (
              'complete', 'restart', 'non_destructive_complete', 'blast_radius_blocked'
            )
          ) or (
            f.key = 'fullSweepStartedAt' and jsonb_typeof(f.value) = 'string'
            and length(f.value #>> '{}') <= 35 and (f.value #>> '{}') ~ '^[0-9T:.+Z-]+$'
            and pg_input_is_valid(f.value #>> '{}', 'timestamp with time zone')
          )
        )
      ) picked
    ) fields
  )
  select jsonb_build_object(
    'windowStart', window_start, 'windowEnd', window_end, 'asOf', statement_timestamp(),
    'throughRunId', upper_id,
    'nextRunId', case when (select count(*) from candidates) > row_limit
      then (select max(id) from runs) end,
    'scope', 'Runs started in the window; late finishes can change later reads. Missing evidence is unknown.',
    'records', coalesce((select jsonb_agg(to_jsonb(r) order by r.run_id) from records r), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function fansly_followers_diagnostic_timeline(timestamptz, timestamptz, bigint, bigint, integer)
  from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant execute on function fansly_followers_diagnostic_timeline(timestamptz, timestamptz, bigint, bigint, integer)
      to read_only;
  end if;
end $$;
