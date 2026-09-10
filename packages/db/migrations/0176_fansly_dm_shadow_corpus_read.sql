-- Historical A0 input: retained request offsets plus head metadata, with no
-- message text, usernames, session material or arbitrary request parameters.
-- Keyset over a capped candidate batch bounds work without indexing the 100-year
-- capture history or pretending captured_at is already indexed.
create function fansly_dm_shadow_corpus_batch(
  window_start timestamptz, window_end timestamptz,
  after_id bigint default 0, through_id bigint default null, batch_size integer default 500
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare result jsonb; upper_id bigint;
begin
  if window_start is null or window_end is null or window_start >= window_end
     or window_end - window_start > interval '8 days'
     or after_id is null or after_id < 0
     or batch_size is null or batch_size not between 1 and 1000 then
    raise exception 'An ordered window <=8 days and a keyset batch of 1..1000 are required';
  end if;
  select coalesce(through_id, max(r.id), 0) into upper_id from public.sync_raw_payloads r;
  if upper_id < after_id then raise exception 'through_id precedes after_id'; end if;

  with candidates as materialized (
    select r.id from public.sync_raw_payloads r
    where r.id > after_id and r.id <= upper_id
    order by r.id limit batch_size
  ), bodies as (
    select r.id, r.page_id, p.label, r.sync_run_id, r.captured_at, r.mapper_version,
           r.request_params, sr.outcome as run_outcome, sr.finished_at as run_finished_at,
           case when sr.stats #>> '{checkpoint,after,dm_conversations,stateScalars,membershipCertified}' = 'true'
             then sr.stats #>> '{checkpoint,after,dm_conversations,stateScalars,lastFullSweepCompletedAt}'
           end as certified_at,
           coalesce(r.response_payload, b.body) as payload
    from candidates c join public.sync_raw_payloads r on r.id = c.id
    join public.pages p on p.id = r.page_id
    left join public.sync_runs sr on sr.id = r.sync_run_id
    left join public.capture_json_hot_bodies b
      on b.bucket_month = r.payload_bucket_month and b.object_id = r.payload_object_id
    where r.endpoint = 'dm_conversations' and p.platform = 'fansly'
      and r.captured_at >= window_start and r.captured_at < window_end
  ), records as (
    select r.id, r.page_id as "pageId", r.label as "pageLabel", r.sync_run_id as "runId",
           r.captured_at as "capturedAt", r.run_outcome as "runOutcome",
           r.run_finished_at as "runFinishedAt", r.certified_at as "certifiedAt",
           r.mapper_version as "mapperVersion",
           r.request_params -> 'offset' as "offset",
           r.request_params -> 'limit' as "limit",
           r.request_params -> 'sortOrder' as "sortOrder",
           r.payload is not null as "payloadAvailable",
           jsonb_typeof(r.payload -> 'data') = 'array' as "dataValid",
           r.payload #> '{aggregationData,total}' as total,
           octet_length(r.payload::text) as "retainedJsonBytes",
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'groupId', d -> 'groupId', 'lastMessageId', d -> 'lastMessageId',
               'unreadCount', d -> 'unreadCount', 'flags', d -> 'flags',
               'lastUnreadMessageId', d -> 'lastUnreadMessageId',
               'subscriptionTierId', d -> 'subscriptionTierId',
               'embeddedId', g.head -> 'id', 'embeddedMatches', g.matches, 'timestamp', g.head -> 'createdAt',
               'senderId', g.head -> 'senderId'
             ) order by n)
             from jsonb_array_elements(case when jsonb_typeof(r.payload -> 'data') = 'array'
               then r.payload -> 'data' else '[]'::jsonb end) with ordinality as items(d, n)
             left join lateral (
               select jsonb_agg(value -> 'lastMessage') -> 0 as head, count(*) as matches
               from jsonb_array_elements(case
                 when jsonb_typeof(r.payload #> '{aggregationData,groups}') = 'array'
                 then r.payload #> '{aggregationData,groups}' else '[]'::jsonb end)
               where value ->> 'id' = d ->> 'groupId'
             ) g on true
           ), '[]'::jsonb) as heads
    from bodies r
  )
  select jsonb_build_object(
    'upperId', upper_id,
    'nextId', coalesce((select max(c.id) from candidates c), after_id),
    'scannedRows', (select count(*) from candidates),
    'records', coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from records r), '[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function fansly_dm_shadow_corpus_batch(
  timestamptz, timestamptz, bigint, bigint, integer
) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant execute on function fansly_dm_shadow_corpus_batch(
      timestamptz, timestamptz, bigint, bigint, integer
    ) to read_only;
  end if;
end $$;
