UPDATE page_sync_states AS st
SET status = 'pending'::page_sync_status,
    request_seq = 1,
    request_source = 'recovery'::sync_request_source,
    request_payload = '{}'::jsonb,
    requested_at = now(),
    enqueued_at = NULL,
    started_at = NULL,
    progressed_at = NULL,
    finished_at = NULL,
    succeeded_at = NULL,
    failed_at = NULL,
    retry_kind = NULL,
    retry_at = NULL,
    blocker_kind = NULL,
    blocker_code = NULL,
    blocker_message = NULL,
    blocked_at = NULL,
    phase = NULL,
    progress = '{}'::jsonb,
    lease_owner = NULL,
    lease_token = NULL,
    lease_heartbeat_at = NULL,
    lease_expires_at = NULL,
    consecutive_failures = 0,
    last_error_code = NULL,
    last_error_summary = NULL,
    updated_at = now()
FROM pages AS p
WHERE st.page_id = p.id
  AND st.stream = ANY(ARRAY['transactions'::sync_stream, 'subscribers'::sync_stream])
  AND st.status = 'idle'
  AND st.request_seq = 0
  AND st.applied_seq = 0
  AND st.request_source IS NULL
  AND st.requested_at IS NULL
  AND st.succeeded_at IS NOT NULL;
