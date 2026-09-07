-- W4: account transitions use the existing independent retry journal. No new
-- fact table; history, lineage and erasure remain owned by the webhook journal.
UPDATE ofapi_webhook_events
SET projection_status='pending'
WHERE capture_state='accepted' AND projection_status='none'
  AND event_type IN ('accounts.connected','accounts.reconnected','accounts.disconnected',
    'accounts.session_expired','accounts.authentication_failed','accounts.otp_code_required',
    'accounts.face_otp_required','subscriptions.expired',
    'media_uploads.completed','media_uploads.failed',
    'data_exports.calculating_credits','data_exports.calculating_credits_completed',
    'data_exports.calculating_credits_failed','data_exports.in_progress',
    'data_exports.completed','data_exports.failed','data_exports.cancelled');

-- DB-only lifecycle summaries look up a known resource, never scan payloads
-- across the whole journal. Exact signed bodies remain the immutable evidence.
-- The lookup index (ofapi_webhook_lifecycle_resource_idx) is built in
-- 0169_ofapi_webhook_lifecycle_index.sql, CONCURRENTLY and outside a
-- transaction: a plain CREATE INDEX here would hold ACCESS EXCLUSIVE on the
-- 570k-row journal for the whole build and stall inbound OFAPI deliveries
-- past their 10 s timeout (capture-first, DP 7). The 0143 shape is the precedent.
