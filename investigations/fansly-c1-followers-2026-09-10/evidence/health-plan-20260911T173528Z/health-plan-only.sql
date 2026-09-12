-- Prepared from listSyncMonitorStreamRows at source d47dc9b0.
-- Active-page predicate substitutes for the caller's resolved active ID list.
-- OWNER APPROVAL REQUIRED: read_only lacks SELECT for this plan.
-- Planning only: ANALYZE is false; no query execution or row export.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
PREPARE c1_sync_health_plan AS
with visible_pages as (
      select "pages"."id" as "pageId",
             "pages"."label" as "pageLabel",
             "pages"."platform" as "platform",
             "pages"."username" as "username",
             "pages"."display_name" as "displayName",
             "models"."slug" as "modelSlug",
             "models"."name" as "modelName",
             coalesce(
    "egress_endpoints"."rate_limit_scope_key",
    canonical_proxy_egress_key("egress_endpoints"."url"),
    'direct'
  ) as "egressKey"
      from "pages"
      inner join "models" on "models"."id" = "pages"."model_id"
      left join "egress_endpoints" on "egress_endpoints"."platform_account_id" = "pages"."id"
      where "pages"."status" = 'active'
    ),
    page_streams as (
      select vp."pageId",
             vp."pageLabel",
             vp."platform",
             vp."username",
             vp."displayName",
             vp."modelSlug",
             vp."modelName",
             vp."egressKey",
             s.stream::sync_stream as "stream"
      from visible_pages vp
      cross join lateral unnest(
        case
          when vp."platform" = 'fansly'
            then ARRAY[$1::sync_stream, $2::sync_stream, $3::sync_stream, $4::sync_stream, $5::sync_stream, $6::sync_stream, $7::sync_stream, $8::sync_stream, $9::sync_stream, $10::sync_stream, $11::sync_stream, $12::sync_stream, $13::sync_stream, $14::sync_stream, $15::sync_stream, $16::sync_stream, $17::sync_stream]::sync_stream[]
          else ARRAY[$18::sync_stream, $19::sync_stream, $20::sync_stream, $21::sync_stream, $22::sync_stream, $23::sync_stream]::sync_stream[]
        end
      ) as s(stream)
    ),
    fan_counts as (
      select fp.platform_account_id as "pageId",
             count(distinct fp.fan_id)::int as "fanCount"
      from "page_fans" fp
      inner join visible_pages vp on vp."pageId" = fp.platform_account_id
      group by fp.platform_account_id
    ),
    follower_counts as (
      select pf.platform_account_id as "pageId",
             count(*) filter (where pf.is_active = true)::int as "followerCount"
      from "page_follows" pf
      inner join visible_pages vp on vp."pageId" = pf.platform_account_id
      group by pf.platform_account_id
    ),
    subscriber_counts as (
      select ps.platform_account_id as "pageId",
             count(*) filter (where ps.is_current = true)::int as "subscriberCount"
      from "page_subscriptions" ps
      inner join visible_pages vp on vp."pageId" = ps.platform_account_id
      group by ps.platform_account_id
    ),
    transaction_counts as (
      select t.platform_account_id as "pageId",
             count(*)::int as "transactionCount"
      from "transactions" t
      inner join visible_pages vp on vp."pageId" = t.platform_account_id
      group by t.platform_account_id
    ),
    dm_conversation_counts as (
      select c.platform_account_id as "pageId",
             count(*) filter (where c.is_visible = true)::int as "dmConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and coalesce(c.metadata ->> $24, '') = ''
             )::int as "dmEligibleConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and coalesce(c.metadata ->> $25, '') = ''
                 and c.message_coverage_status in (
                   'complete'::dm_message_coverage_status,
                   'partial_window'::dm_message_coverage_status
                 )
             )::int as "dmBackfillCompleteConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and coalesce(c.metadata ->> $26, '') = ''
                 and c.last_message_id is distinct from c.newest_stored_message_id
                 and (
                   c.last_message_sync_at is null
                   or (c.last_message_at is not null and c.last_message_sync_at < c.last_message_at)
                 )
             )::int as "dmLaggingConversationCount"
      from "page_dm_threads" c
      inner join visible_pages vp on vp."pageId" = c.platform_account_id
      group by c.platform_account_id
    ),
    dm_message_counts as (
      select m.platform_account_id as "pageId",
             count(*)::int as "dmMessageCount"
      from "page_dm_messages" m
      inner join visible_pages vp on vp."pageId" = m.platform_account_id
      group by m.platform_account_id
    ),
    dm_deep_backfill_candidates as (
      select c.platform_account_id as "pageId",
             (coalesce(slp.creator_net_amount_mills, 0)::bigint > 0) as "isSpender",
             c.stored_message_count as "storedMessageCount",
             case
               when coalesce(slp.creator_net_amount_mills, 0)::bigint > 0
                 then $27
               else $28
             end::int as "retentionLimit"
      from "page_dm_threads" c
      inner join visible_pages vp on vp."pageId" = c.platform_account_id
      left join "fan_spend_lifetime" slp
        on slp.platform_account_id = c.platform_account_id
       and slp.fan_id = c.fan_id
      where vp."platform" = 'fansly'
        and c.is_visible = true
        and c.fan_id is not null
        and coalesce(c.metadata ->> $29, '') = ''
        and c.message_coverage_status = 'partial_window'::dm_message_coverage_status
        and c.stored_message_count > 0
        and not (
          c.last_message_id is distinct from c.newest_stored_message_id
          and (
            c.last_message_sync_at is null
            or (c.last_message_at is not null and c.last_message_sync_at < c.last_message_at)
          )
        )
    ),
    dm_deep_backfill_counts as (
      select "pageId",
             count(*) filter (where "storedMessageCount" < "retentionLimit")::int as "pendingConversationCount",
             coalesce(sum(
               ceil(greatest("retentionLimit" - "storedMessageCount", 0)::numeric / $30)
             ) filter (where "storedMessageCount" < "retentionLimit"), 0)::int as "pendingPageEstimate",
             count(*) filter (
               where "isSpender" = true
                 and "storedMessageCount" < "retentionLimit"
             )::int as "spenderPendingConversationCount",
             coalesce(sum(
               ceil(greatest("retentionLimit" - "storedMessageCount", 0)::numeric / $31)
             ) filter (
               where "isSpender" = true
                 and "storedMessageCount" < "retentionLimit"
             ), 0)::int as "spenderPendingPageEstimate",
             count(*) filter (
               where "isSpender" = false
                 and "storedMessageCount" < "retentionLimit"
             )::int as "regularPendingConversationCount",
             coalesce(sum(
               ceil(greatest("retentionLimit" - "storedMessageCount", 0)::numeric / $32)
             ) filter (
               where "isSpender" = false
                 and "storedMessageCount" < "retentionLimit"
             ), 0)::int as "regularPendingPageEstimate"
      from dm_deep_backfill_candidates
      group by "pageId"
    ),
    running_runs as (
      select ranked.*,
             greatest(
               ranked."runningStartedAt",
               ra."lastAttemptAt",
               ea."lastEventAt"
             ) as "runningLastActivityAt"
      from (
        select sr.page_id as "pageId",
               sr.stream as "stream",
               sr.id as "runningRunId",
               coalesce(sr.source::text, 'scheduled') as "runningTrigger",
               sr.started_at as "runningStartedAt",
               sr.stats as "runningStats",
               sr.error_summary as "runningErrorSummary",
               row_number() over (
                 partition by sr.page_id, sr.stream
                 order by sr.started_at desc, sr.id desc
               ) as "rank"
        from "sync_runs" sr
        inner join visible_pages vp on vp."pageId" = sr.page_id
        where sr.outcome = 'running'
          and sr.stream = any(ARRAY[$33::sync_stream, $34::sync_stream, $35::sync_stream, $36::sync_stream, $37::sync_stream, $38::sync_stream, $39::sync_stream, $40::sync_stream, $41::sync_stream, $42::sync_stream, $43::sync_stream, $44::sync_stream, $45::sync_stream, $46::sync_stream, $47::sync_stream, $48::sync_stream, $49::sync_stream]::sync_stream[])
      ) ranked
      -- Activity belongs only to the selected running run. The run/time indexes
      -- avoid aggregating retained attempts/events for every historical run.
      left join lateral (
        select max(coalesce(a.finished_at, a.started_at)) as "lastAttemptAt"
        from "sync_http_attempts" a
        where a.sync_run_id = ranked."runningRunId"
      ) ra on true
      left join lateral (
        select max(e.emitted_at) as "lastEventAt"
        from "sync_run_events" e
        where e.sync_run_id = ranked."runningRunId"
      ) ea on true
      where ranked."rank" = 1
    ),
    completed_runs as (
      select ranked.*
      from (
        select sr.page_id as "pageId",
               sr.stream as "stream",
               sr.id as "lastCompletedRunId",
               coalesce(sr.source::text, 'scheduled') as "lastCompletedTrigger",
               case
                 when sr.outcome = 'succeeded' then 'success'
                 else sr.outcome::text
               end as "lastCompletedStatus",
               sr.started_at as "lastCompletedStartedAt",
               sr.finished_at as "lastCompletedFinishedAt",
               greatest(
                 0,
                 floor(extract(epoch from (sr.finished_at - sr.started_at)) * 1000)
               )::int as "lastCompletedDurationMs",
               sr.stats as "lastCompletedStats",
               sr.error_summary as "lastCompletedErrorSummary",
               row_number() over (
                 partition by sr.page_id, sr.stream
                 order by sr.finished_at desc, sr.id desc
               ) as "rank"
        from "sync_runs" sr
        inner join visible_pages vp on vp."pageId" = sr.page_id
        where sr.outcome <> 'running'
          and sr.finished_at is not null
          and sr.stream = any(ARRAY[$50::sync_stream, $51::sync_stream, $52::sync_stream, $53::sync_stream, $54::sync_stream, $55::sync_stream, $56::sync_stream, $57::sync_stream, $58::sync_stream, $59::sync_stream, $60::sync_stream, $61::sync_stream, $62::sync_stream, $63::sync_stream, $64::sync_stream, $65::sync_stream, $66::sync_stream]::sync_stream[])
      ) ranked
      where ranked."rank" = 1
    ),
    deep_backfill_runs as (
      select page_id as "pageId",
             coalesce(sum("deepBackfillRequests"), 0)::int as "recentDeepBackfillRequestCount",
             max(finished_at) filter (
               where "deepBackfillRequests" > 0
                 and finished_at is not null
             ) as "lastDeepBackfillCompletedAt"
      from (
        select sr.page_id,
               sr.finished_at,
               case
                 when jsonb_typeof(sr.stats) = 'object'
                  and (sr.stats ->> 'deepBackfillRequests') ~ '^[0-9]+$'
                 then (sr.stats ->> 'deepBackfillRequests')::int
                 else 0
               end as "deepBackfillRequests"
        from "sync_runs" sr
        inner join visible_pages vp on vp."pageId" = sr.page_id
        where vp."platform" = 'fansly'
          and sr.stream = 'dm_messages'::sync_stream
          and sr.started_at >= $67
      ) runs
      group by page_id
    ),
    recent_run_counts as (
      select sr.page_id as "pageId",
             sr.stream as "stream",
             count(*) filter (where sr.outcome = 'running')::int as "recentRunningCount",
             count(*) filter (where sr.outcome = 'succeeded')::int as "recentSuccessCount",
             count(*) filter (where sr.outcome = 'partial')::int as "recentPartialCount",
             count(*) filter (where sr.outcome = 'failed')::int as "recentFailedCount",
             count(*) filter (where sr.outcome = 'skipped')::int as "recentSkippedCount"
      from "sync_runs" sr
      inner join visible_pages vp on vp."pageId" = sr.page_id
      where sr.started_at >= $68
        and sr.stream = any(ARRAY[$69::sync_stream, $70::sync_stream, $71::sync_stream, $72::sync_stream, $73::sync_stream, $74::sync_stream, $75::sync_stream, $76::sync_stream, $77::sync_stream, $78::sync_stream, $79::sync_stream, $80::sync_stream, $81::sync_stream, $82::sync_stream, $83::sync_stream, $84::sync_stream, $85::sync_stream]::sync_stream[])
      group by sr.page_id, sr.stream
    ),
    recent_attempt_counts as (
      select a.page_id as "pageId",
             a.stream as "stream",
             count(*) filter (where a.http_status = 429)::int as "recent429Count",
             count(*) filter (where a.http_status >= 500 and a.http_status < 600)::int as "recent5xxCount",
             count(*) filter (where a.state = 'failed')::int as "recentFailedAttemptCount",
             count(*) filter (where a.state = 'retry')::int as "recentRetryCount",
             max(a.started_at) filter (where a.http_status = 429) as "last429At",
             max(a.started_at) filter (where a.http_status >= 500 and a.http_status < 600) as "last5xxAt"
      from "sync_http_attempts" a
      inner join visible_pages vp on vp."pageId" = a.page_id
      where a.started_at >= $86
        and a.stream = any(ARRAY[$87::sync_stream, $88::sync_stream, $89::sync_stream, $90::sync_stream, $91::sync_stream, $92::sync_stream, $93::sync_stream, $94::sync_stream, $95::sync_stream, $96::sync_stream, $97::sync_stream, $98::sync_stream, $99::sync_stream, $100::sync_stream, $101::sync_stream, $102::sync_stream, $103::sync_stream]::sync_stream[])
      group by a.page_id, a.stream
    ),
    attempts_with_last_success as (
      select a.page_id as "pageId",
             a.stream as "stream",
             a.state as "state",
             a.started_at as "startedAt",
             max(a.started_at) filter (where a.state = 'success') over (
               partition by a.page_id, a.stream
             ) as "lastPhysicalSuccessAt"
      from "sync_http_attempts" a
      inner join visible_pages vp on vp."pageId" = a.page_id
      where a.stream = any(ARRAY[$104::sync_stream, $105::sync_stream, $106::sync_stream, $107::sync_stream, $108::sync_stream, $109::sync_stream, $110::sync_stream, $111::sync_stream, $112::sync_stream, $113::sync_stream, $114::sync_stream, $115::sync_stream, $116::sync_stream, $117::sync_stream, $118::sync_stream, $119::sync_stream, $120::sync_stream]::sync_stream[])
    ),
    physical_attempt_health as (
      select attempts."pageId" as "pageId",
             attempts."stream" as "stream",
             count(*) filter (
               where attempts."startedAt" >= $121
                 and (
                   attempts."state" in ('success', 'retry', 'failed')
                   or (
                     attempts."state" = 'started'
                     and attempts."startedAt" <= $122
                   )
                 )
             )::int as "recentPhysicalAttemptCount",
             count(*) filter (
               where attempts."startedAt" >= $123
                 and attempts."state" = 'success'
             )::int as "recentPhysicalSuccessCount",
             count(*) filter (
               where attempts."state" = 'started'
                 and attempts."startedAt" <= $124
                 and (
                   attempts."lastPhysicalSuccessAt" is null
                   or attempts."startedAt" > attempts."lastPhysicalSuccessAt"
                 )
             )::int as "stalePhysicalAttemptCount",
             count(*) filter (
               where (
                 attempts."state" in ('retry', 'failed')
                 or (
                   attempts."state" = 'started'
                   and attempts."startedAt" <= $125
                 )
               )
                 and (
                   attempts."lastPhysicalSuccessAt" is null
                   or attempts."startedAt" > attempts."lastPhysicalSuccessAt"
                 )
             )::int as "physicalAttemptsSinceLastSuccess",
             max(attempts."lastPhysicalSuccessAt") as "lastPhysicalSuccessAt"
      from attempts_with_last_success attempts
      group by attempts."pageId", attempts."stream"
    ),
    provider_rate_limits as (
      select rl.provider as "platform",
             rl.egress_key as "egressKey",
             max(rl.next_available_at) as "providerNextAvailableAt",
             max(rl.min_spacing_ms)::int as "providerMinSpacingMs"
      from "sync_rate_limits" rl
      group by rl.provider, rl.egress_key
    )
    select ps."pageId" as "pageId",
           ps."pageLabel" as "pageLabel",
           ps."platform" as "platform",
           ps."modelSlug" as "modelSlug",
           ps."modelName" as "modelName",
           ps."username" as "username",
           ps."displayName" as "displayName",
           coalesce(fc."fanCount", 0)::int as "fanCount",
           coalesce(foc."followerCount", 0)::int as "followerCount",
           coalesce(scnt."subscriberCount", 0)::int as "subscriberCount",
           coalesce(tc."transactionCount", 0)::int as "transactionCount",
           coalesce(dcc."dmConversationCount", 0)::int as "dmConversationCount",
           coalesce(dmc."dmMessageCount", 0)::int as "dmMessageCount",
           coalesce(dcc."dmEligibleConversationCount", 0)::int as "dmEligibleConversationCount",
           coalesce(dcc."dmBackfillCompleteConversationCount", 0)::int as "dmBackfillCompleteConversationCount",
           coalesce(dcc."dmLaggingConversationCount", 0)::int as "dmLaggingConversationCount",
           coalesce(ddbc."pendingConversationCount", 0)::int as "dmDeepBackfillPendingConversationCount",
           coalesce(ddbc."pendingPageEstimate", 0)::int as "dmDeepBackfillPendingPageEstimate",
           coalesce(ddbc."spenderPendingConversationCount", 0)::int as "dmDeepBackfillSpenderPendingConversationCount",
           coalesce(ddbc."spenderPendingPageEstimate", 0)::int as "dmDeepBackfillSpenderPendingPageEstimate",
           coalesce(ddbc."regularPendingConversationCount", 0)::int as "dmDeepBackfillRegularPendingConversationCount",
           coalesce(ddbc."regularPendingPageEstimate", 0)::int as "dmDeepBackfillRegularPendingPageEstimate",
           coalesce(dbr."recentDeepBackfillRequestCount", 0)::int as "dmDeepBackfillRecentRequestCount",
           dbr."lastDeepBackfillCompletedAt" as "dmDeepBackfillLastCompletedAt",
           ps."stream" as "stream",
           st.status as "status",
           st.blocker_kind as "blockerKind",
           st.cadence_seconds as "cadenceSeconds",
           to_timestamp(((st.last_scheduled_slot + 1) * st.cadence_seconds) + st.slot_offset_seconds) as "nextDueAt",
           st.request_seq as "requestSeq",
           st.applied_seq as "appliedSeq",
           st.requested_at as "requestedAt",
           st.retry_at as "retryAt",
           st.enqueued_at as "lastEnqueuedAt",
           st.started_at as "lastStartedAt",
           st.finished_at as "lastFinishedAt",
           st.succeeded_at as "succeededAt",
           st.failed_at as "failedAt",
           coalesce(st.consecutive_failures, 0)::int as "consecutiveFailures",
           st.last_error_code as "lastErrorCode",
           st.last_error_summary as "lastErrorSummary",
           cp.cursor_text as "checkpointCursorText",
           cp.cursor_timestamp as "checkpointCursorTimestamp",
           cp.state as "checkpointState",
           cp.last_succeeded_at as "cursorLastSucceededAt",
           cp.last_succeeded_run_id as "cursorLastSucceededRunId",
           rr."runningRunId" as "runningRunId",
           rr."runningTrigger" as "runningTrigger",
           rr."runningStartedAt" as "runningStartedAt",
           rr."runningLastActivityAt" as "runningLastActivityAt",
           rr."runningStats" as "runningStats",
           rr."runningErrorSummary" as "runningErrorSummary",
           cr."lastCompletedRunId" as "lastCompletedRunId",
           cr."lastCompletedTrigger" as "lastCompletedTrigger",
           cr."lastCompletedStatus" as "lastCompletedStatus",
           cr."lastCompletedStartedAt" as "lastCompletedStartedAt",
           cr."lastCompletedFinishedAt" as "lastCompletedFinishedAt",
           cr."lastCompletedDurationMs" as "lastCompletedDurationMs",
           cr."lastCompletedStats" as "lastCompletedStats",
           cr."lastCompletedErrorSummary" as "lastCompletedErrorSummary",
           coalesce(rrc."recentRunningCount", 0)::int as "recentRunningCount",
           coalesce(rrc."recentSuccessCount", 0)::int as "recentSuccessCount",
           coalesce(rrc."recentPartialCount", 0)::int as "recentPartialCount",
           coalesce(rrc."recentFailedCount", 0)::int as "recentFailedCount",
           coalesce(rrc."recentSkippedCount", 0)::int as "recentSkippedCount",
           coalesce(rac."recent429Count", 0)::int as "recent429Count",
           coalesce(rac."recent5xxCount", 0)::int as "recent5xxCount",
           coalesce(rac."recentFailedAttemptCount", 0)::int as "recentFailedAttemptCount",
           coalesce(rac."recentRetryCount", 0)::int as "recentRetryCount",
           coalesce(pah."recentPhysicalAttemptCount", 0)::int as "recentPhysicalAttemptCount",
           coalesce(pah."recentPhysicalSuccessCount", 0)::int as "recentPhysicalSuccessCount",
           coalesce(pah."stalePhysicalAttemptCount", 0)::int as "stalePhysicalAttemptCount",
           coalesce(pah."physicalAttemptsSinceLastSuccess", 0)::int as "physicalAttemptsSinceLastSuccess",
           pah."lastPhysicalSuccessAt" as "lastPhysicalSuccessAt",
           rac."last429At" as "last429At",
           rac."last5xxAt" as "last5xxAt",
           prl."providerNextAvailableAt" as "providerNextAvailableAt",
           prl."providerMinSpacingMs" as "providerMinSpacingMs"
    from page_streams ps
    left join "page_sync_states" st
      on st.page_id = ps."pageId"
     and st.stream::text = ps."stream"::text
    left join "page_sync_cursors" cp
      on cp.page_id = ps."pageId"
     and cp.stream::text = ps."stream"::text
    left join running_runs rr
      on rr."pageId" = ps."pageId"
     and rr."stream" = ps."stream"
    left join completed_runs cr
      on cr."pageId" = ps."pageId"
     and cr."stream" = ps."stream"
    left join recent_run_counts rrc
      on rrc."pageId" = ps."pageId"
     and rrc."stream" = ps."stream"
    left join recent_attempt_counts rac
      on rac."pageId" = ps."pageId"
     and rac."stream" = ps."stream"
    left join physical_attempt_health pah
      on pah."pageId" = ps."pageId"
     and pah."stream" = ps."stream"
    left join provider_rate_limits prl
      on prl."platform" = ps."platform"
     and prl."egressKey" = ps."egressKey"
    left join fan_counts fc on fc."pageId" = ps."pageId"
    left join follower_counts foc on foc."pageId" = ps."pageId"
    left join subscriber_counts scnt on scnt."pageId" = ps."pageId"
    left join transaction_counts tc on tc."pageId" = ps."pageId"
    left join dm_conversation_counts dcc on dcc."pageId" = ps."pageId"
    left join dm_message_counts dmc on dmc."pageId" = ps."pageId"
    left join dm_deep_backfill_counts ddbc on ddbc."pageId" = ps."pageId"
    left join deep_backfill_runs dbr on dbr."pageId" = ps."pageId"
    order by ps."pageLabel" asc, 
    case ps."stream"
      when 'light' then 1
      when 'transactions' then 2
      when 'fan_identities' then 3
      when 'top_spenders' then 4
      when 'subscribers' then 5
      when 'followers' then 6
      when 'followers_reconcile' then 7
      when 'dm_conversations' then 8
      when 'dm_messages' then 9
      when 'fan_earnings' then 10
      when 'purchase_history' then 11
      when 'posts' then 12
      when 'stats_snapshot' then 13
      when 'notifications' then 14
      when 'catalog' then 15
      when 'post_replies' then 16
      when 'payouts' then 17
      when 'media_stats' then 18
      else 999
    end
   asc;
EXPLAIN (ANALYZE FALSE, FORMAT JSON, COSTS TRUE)
EXECUTE c1_sync_health_plan(
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'dm_conversations',
  'posts',
  'messageSyncExcludedReason',
  'messageSyncExcludedReason',
  'messageSyncExcludedReason',
  1000,
  200,
  'messageSyncExcludedReason',
  25,
  25,
  25,
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  '2026-09-10T02:53:01.000Z',
  '2026-09-10T02:53:01.000Z',
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  '2026-09-10T02:53:01.000Z',
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  'light',
  'transactions',
  'top_spenders',
  'subscribers',
  'followers',
  'followers_reconcile',
  'dm_conversations',
  'dm_messages',
  'fan_earnings',
  'purchase_history',
  'posts',
  'stats_snapshot',
  'notifications',
  'catalog',
  'post_replies',
  'payouts',
  'media_stats',
  '2026-09-10T02:53:01.000Z',
  '2026-09-11T02:51:01.000Z',
  '2026-09-10T02:53:01.000Z',
  '2026-09-11T02:51:01.000Z',
  '2026-09-11T02:51:01.000Z'
);
ROLLBACK;
