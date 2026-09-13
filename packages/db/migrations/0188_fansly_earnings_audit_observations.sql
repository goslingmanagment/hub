-- Preserve v7 parser behavior while withholding fields it never consumes.
CREATE FUNCTION public.fansly_earnings_audit_payload(body jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  row jsonb;
  field text;
  value jsonb;
  selected jsonb;
  result jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(body) <> 'array' THEN
    RETURN CASE jsonb_typeof(body)
      WHEN 'object' THEN '{}'::jsonb WHEN 'string' THEN '""'::jsonb
      ELSE body END;
  END IF;
  IF jsonb_array_length(body) > 512 THEN RETURN NULL; END IF;
  FOR row IN SELECT r.value FROM jsonb_array_elements(body) WITH ORDINALITY r(value, ordinal)
    ORDER BY r.ordinal LOOP
    IF jsonb_typeof(row) = 'object' THEN
      selected := '{}'::jsonb;
      FOREACH field IN ARRAY ARRAY[
        'correlationAccountId', 'year', 'month', 'type', 'totalGross', 'totalNet'
      ] LOOP
        IF NOT row ? field THEN CONTINUE; END IF;
        value := row->field;
        IF field = 'correlationAccountId' AND jsonb_typeof(value) = 'string'
          AND octet_length(value #>> '{}') > 256 THEN RETURN NULL; END IF;
        value := CASE jsonb_typeof(value)
          WHEN 'object' THEN '{}'::jsonb WHEN 'array' THEN '[]'::jsonb
          WHEN 'string' THEN CASE WHEN field = 'correlationAccountId'
            THEN value ELSE '""'::jsonb END
          ELSE value END;
        selected := selected || jsonb_build_object(field, value);
      END LOOP;
    ELSE
      selected := CASE jsonb_typeof(row)
        WHEN 'array' THEN '[]'::jsonb WHEN 'string' THEN '""'::jsonb ELSE row END;
    END IF;
    result := result || jsonb_build_array(selected);
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION public.fansly_earnings_audit_observations(
  scope jsonb, after_received_at timestamptz DEFAULT NULL,
  after_id bigint DEFAULT 0, page_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  account bigint := public.fansly_earnings_audit_account(scope);
  result jsonb;
BEGIN
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
      pg_column_compression(o.payload) AS inline_compression,
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
    SELECT s.*, b.body, pg_column_compression(b.body) AS cas_compression, CASE
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
      -- A compressed inline value has no trusted decoded-length receipt.
      -- Refuse it explicitly rather than allocate an unbounded JSON text copy.
      WHEN s.inline_compression IS NOT NULL OR s.cas_compression IS NOT NULL
        THEN 'compressed_body'
      WHEN pg_column_size(s.payload) > 65536 OR pg_column_size(s.body) > 65536
        THEN 'body_limit'
      WHEN s.payload IS NOT NULL AND octet_length(s.payload::text) > 65536 THEN 'body_limit'
      WHEN s.body IS NOT NULL AND octet_length(s.body::text) > 65536 THEN 'body_limit'
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
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_payload(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_observations(jsonb, timestamptz, bigint, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION public.fansly_earnings_audit_observations(jsonb, timestamptz, bigint, integer)
      TO read_only;
  END IF;
END $$;
