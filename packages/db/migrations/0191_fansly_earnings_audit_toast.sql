-- Retain all scope/cursor/storage gates; PostgreSQL compression is not a codec mismatch.
CREATE OR REPLACE FUNCTION public.fansly_earnings_audit_observations(
  scope jsonb, after_received_at timestamptz DEFAULT NULL,
  after_id bigint DEFAULT 0, page_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  account bigint := public.fansly_earnings_audit_account(scope);
  result jsonb;
BEGIN
  -- Existing functions survive pg_upgrade; revalidate the internal ABI on reads.
  IF current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'earnings_audit_raw_length_requires_postgresql_16';
  END IF;
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100 OR after_id IS NULL
    OR (after_received_at IS NULL AND after_id <> 0)
    OR (after_received_at IS NOT NULL AND (
      NOT isfinite(after_received_at) OR after_received_at < (scope->>'from')::timestamptz
      OR after_received_at >= (scope->>'to')::timestamptz OR after_id <= 0))
    OR after_id > (scope->>'upperObservationId')::bigint THEN
    RAISE EXCEPTION 'invalid_earnings_audit_cursor';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT o.id, o.kind, o.received_at, o.observed_at, o.parse_version,
      o.payload, o.payload_bucket_month, o.payload_object_id
    FROM public.observations o
    WHERE o.account_id = account AND o.platform = 'fansly' AND o.source = 'pull'
      AND o.kind IN ('fan_earnings_stats', 'fan_earnings_monthly')
      AND o.received_at >= (scope->>'from')::timestamptz
      AND o.received_at < (scope->>'to')::timestamptz
      AND o.id <= (scope->>'upperObservationId')::bigint
      AND (after_received_at IS NULL OR (o.received_at, o.id) > (after_received_at, after_id))
    ORDER BY o.received_at, o.id LIMIT page_limit + 1
  ), selected AS MATERIALIZED (
    SELECT c.* FROM candidates c ORDER BY c.received_at, c.id LIMIT page_limit
  ), storage AS MATERIALIZED (
    SELECT s.*, b.body, CASE
      WHEN s.payload_object_id IS NULL THEN 'inline'
      WHEN o.object_id IS NULL THEN 'object_missing'
      WHEN o.platform_account_id IS DISTINCT FROM account
        OR o.access_class <> 'ordinary_capture' OR o.erasure_domain <> 'fan_subject'
        THEN 'scope_mismatch'
      WHEN o.representation <> 'canonical_json' OR o.codec_version <> 1 THEN 'codec_mismatch'
      WHEN o.logical_bytes > 65536 THEN 'body_limit'
      WHEN b.object_id IS NULL THEN 'body_missing'
      ELSE 'cas' END AS storage_status
    FROM selected s LEFT JOIN public.capture_payload_objects o
      ON o.bucket_month = s.payload_bucket_month AND o.object_id = s.payload_object_id
    LEFT JOIN public.capture_json_hot_bodies b
      ON b.bucket_month = o.bucket_month AND b.object_id = o.object_id
      AND o.platform_account_id = account AND o.access_class = 'ordinary_capture'
      AND o.erasure_domain = 'fan_subject' AND o.representation = 'canonical_json'
      AND o.codec_version = 1
      AND o.logical_bytes <= 65536
  ), bounded AS MATERIALIZED (
    SELECT s.*, CASE
      WHEN s.storage_status NOT IN ('inline', 'cas') THEN s.storage_status
      WHEN s.payload IS NULL AND s.body IS NULL THEN 'body_missing'
      -- Check both stored copies before equality, parsing or text conversion.
      WHEN public.fansly_earnings_audit_raw_bytes(s.payload) > 65536
        OR public.fansly_earnings_audit_raw_bytes(s.body) > 65536 THEN 'body_limit'
      WHEN s.storage_status = 'cas' AND s.payload IS NOT NULL AND s.payload <> s.body
        THEN 'copy_disagreement'
      ELSE 'available' END AS status
    FROM storage s
  ), sanitized AS MATERIALIZED (
    SELECT b.*, CASE WHEN b.status = 'available'
      THEN public.fansly_earnings_audit_payload(CASE WHEN b.storage_status = 'cas'
        THEN b.body ELSE b.payload END) ELSE NULL END AS parser_input
    FROM bounded b
  )
  SELECT jsonb_build_object(
    'scope', scope, 'operation', 'observations',
    'after', jsonb_build_object('receivedAt', after_received_at, 'id', after_id::text),
    'exhausted', (SELECT count(*) <= page_limit FROM candidates),
    'next', (SELECT jsonb_build_object('receivedAt', s.received_at, 'id', s.id::text)
      FROM selected s ORDER BY s.received_at DESC, s.id DESC LIMIT 1),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id::text, 'kind', s.kind, 'receivedAt', s.received_at,
      'observedAt', s.observed_at, 'parseVersion', s.parse_version,
      'storage', s.storage_status,
      'status', CASE WHEN s.status = 'available' AND s.parser_input IS NULL
        THEN 'shape_limit' ELSE s.status END,
      'payload', s.parser_input
    ) ORDER BY s.received_at, s.id), '[]'::jsonb)
  ) INTO result FROM sanitized s;
  IF octet_length(result::text) > 8388608 THEN
    RAISE EXCEPTION 'earnings_audit_response_limit';
  END IF;
  RETURN result;
END;
$$;
