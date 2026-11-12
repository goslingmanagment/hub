-- Unfinished or resumable work whose next step reads a raw capture row that business-dump.sh does
-- not copy: one row per reference (work, state, observation_id, observation_received_at,
-- raw_payload_id, present), present = the row and its body are in this database. pull-backup.sh
-- runs it on production in the dump's own snapshot and copies exactly these raw rows into
-- hub-unfinished-inputs.sql. restore-drill.sh runs it on the restored copy to show that every one
-- of them is there. :'as_of' is the snapshot time. One SELECT without a final semicolon (both
-- callers wrap it), and no semicolon in these comments either.
--
-- Checked and NOT here, because their next step reads no raw row: capture jobs that are ready,
-- retry_wait or blocked (they request again, as they would without a restore), sync_work and
-- history requests (their cursors carry positions, a captured attempt is the sync_attempts row
-- below), ofapi_interactive_requests (served ones are done, indeterminate ones have no response),
-- fansly_write_commands, fansly_ws_hint_receipts (the mutation is inline), and the replays and
-- repairs over history (they need the raw history, which is excluded on purpose).

select r.*,
       case when r.observation_id is not null then exists (
              select 1 from observations o
               where o.id = r.observation_id and o.received_at = r.observation_received_at
                 and ((o.payload_object_id is null and o.payload is not null)
                      or exists (select 1 from capture_json_hot_bodies b
                                  where b.bucket_month = o.payload_bucket_month and b.object_id = o.payload_object_id)
                      or exists (select 1 from capture_byte_hot_bodies b
                                  where b.bucket_month = o.payload_bucket_month and b.object_id = o.payload_object_id)))
            else exists (
              select 1 from sync_raw_payloads p
               where p.id = r.raw_payload_id
                 and ((p.payload_object_id is null and p.response_payload is not null)
                      or exists (select 1 from capture_json_hot_bodies b
                                  where b.bucket_month = p.payload_bucket_month and b.object_id = p.payload_object_id)
                      or exists (select 1 from capture_byte_hot_bodies b
                                  where b.bucket_month = p.payload_bucket_month and b.object_id = p.payload_object_id)))
       end as present
from (
  -- A capture job between the paid response and its parse: the parse and the credit metadata come
  -- from this observation (apps/runtime/src/services/ofapi-capture-jobs.ts, parseCapturedJob).
  select 'ofapi_capture_jobs'::text as work, j.state::text as state,
         j.pending_observation_id as observation_id,
         j.pending_observation_received_at as observation_received_at, null::bigint as raw_payload_id
    from ofapi_capture_jobs j
   where j.pending_observation_id is not null
  union all
  -- A finished step of an unfinished collection job: on resume the step is served again from its
  -- captured response (ofapi-collection-read-transport.ts, loadCaptured), not requested again.
  select 'ofapi_collection_jobs step', c.state || '/' || j.state,
         (j.result->>'observationId')::bigint, (j.result->>'observationReceivedAt')::timestamptz, null
    from ofapi_collection_jobs c
    join ofapi_capture_jobs j on j.target->>'collectionJobId' = c.id::text
   where c.state in ('queued', 'running', 'paused') and j.state = 'complete'
     and j.result->>'observationId' ~ '^[0-9]+$' and j.result ? 'observationReceivedAt'
  union all
  -- A sync attempt captured but not applied yet: the commit reads the journal body
  -- (apps/runtime/src/sync/engine/commit.ts, readJournalBody).
  select 'sync_attempts', a.apply_state, a.observation_id, a.observation_received_at, null
    from sync_attempts a
   where a.apply_state in ('captured', 'deferred', 'quarantined') and a.observation_id is not null
  union all
  -- A parse that failed and waits for a parser fix to be replayed.
  select 'observation_parse_quarantine', q.reason_code, q.observation_id, q.received_at, null
    from observation_parse_quarantine q
  union all
  -- Source bytes kept for an OnlyFans media upload (ofapi-media-sources.ts): they live only here.
  select 'ofapi_media_sources', 'retained', s.observation_id, s.observation_received_at, null
    from ofapi_media_sources s
   where s.observation_id is not null
  union all
  -- A Fansly websocket frame not decoded or not applied live yet (live-apply.ts replays it). The
  -- receipt row itself is copied too: its table is excluded from the dump.
  select 'fansly_ws_decode_receipts', d.state || '/' || d.live_state, d.observation_id, d.received_at, null
    from fansly_ws_decode_receipts d
   where d.state in ('pending', 'debt') or d.live_state = 'pending'
  union all
  -- Link-fan journal pages after the projection's cursor (ofapi-link-fans-projection.ts).
  select 'link-fan journal', 'after cursor', null, null, r.id
    from page_link_fan_journal_cursors c
    join sync_raw_payloads r on r.page_id = c.platform_account_id and r.id > c.last_raw_payload_id
  union all
  -- The canonicalizer's in-flight work: never-parsed observations of the last hour (the sweep runs
  -- every minute, on 2026-11-12 its lag was about 30 s).
  select 'canonicalize, last hour', o.source, o.id, o.received_at, null
    from observations o
   where o.received_at > :'as_of'::timestamptz - interval '1 hour' and o.received_at <= :'as_of'::timestamptz
     and o.parse_version = 0
) r
