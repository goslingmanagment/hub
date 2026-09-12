-- Full earnings population: no spender, roster or activity predicate.
CREATE FUNCTION public.fansly_earnings_audit_projection(
  scope jsonb, after_fan_id bigint DEFAULT 0,
  after_window text DEFAULT '', page_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  account bigint := public.fansly_earnings_audit_account(scope);
  result jsonb;
BEGIN
  IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100
    OR after_fan_id IS NULL OR after_fan_id < 0 OR after_window IS NULL
    OR octet_length(after_window) > 256 OR (after_fan_id = 0 AND after_window <> '') THEN
    RAISE EXCEPTION 'invalid_earnings_audit_cursor';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT f.* FROM public.fan_earnings_stats f
    WHERE f.account_id = account AND f.id <= (scope->>'upperProjectionId')::bigint
      AND (f.fan_id, f."window") > (after_fan_id, after_window)
    ORDER BY f.fan_id, f."window" LIMIT page_limit + 1
  ), selected AS MATERIALIZED (
    SELECT c.* FROM candidates c ORDER BY c.fan_id, c."window" LIMIT page_limit
  ), receipts AS (
    SELECT s.*, f.platform_user_id AS fan_ref,
      e.id AS event_id, e.account_seq, e.observation_id AS event_observation_id,
      CASE WHEN octet_length(e.fan_identity_ref) <= 256 THEN e.fan_identity_ref END AS fan_identity_ref,
      e.schema_version,
      CASE WHEN jsonb_typeof(e.data->'window') = 'string'
        AND octet_length(e.data->>'window') <= 256 THEN e.data->'window' END AS event_window,
      CASE WHEN jsonb_typeof(e.data->'grossMills') = 'number'
        THEN e.data->'grossMills' END AS event_gross,
      CASE WHEN jsonb_typeof(e.data->'netMills') = 'number'
        THEN e.data->'netMills' END AS event_net,
      o.id AS observation_id, o.received_at AS source_received_at,
      o.kind AS source_kind, o.parse_version AS source_parse_version
    FROM selected s LEFT JOIN public.fans f ON f.id = s.fan_id AND f.platform = 'fansly'
    LEFT JOIN public.domain_events e ON e.id = s.source_event_id
      AND e.occurred_at = s.observed_at AND e.account_id = account
      AND e.type = 'fan.earnings_observed'
    LEFT JOIN public.observations o ON o.id = e.observation_id
      AND o.account_id = account AND o.platform = 'fansly' AND o.source = 'pull'
      AND o.kind IN ('fan_earnings_stats', 'fan_earnings_monthly')
  )
  SELECT jsonb_build_object(
    'scope', scope, 'operation', 'projection',
    'after', jsonb_build_object('fanId', after_fan_id::text, 'window', after_window),
    'exhausted', (SELECT count(*) <= page_limit FROM candidates),
    'next', (SELECT jsonb_build_object('fanId', s.fan_id::text, 'window', s."window")
      FROM selected s ORDER BY s.fan_id DESC, s."window" DESC LIMIT 1),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id::text, 'fanId', r.fan_id::text, 'fan', r.fan_ref,
      'window', r."window", 'grossMills', r.gross_mills::text,
      'netMills', r.net_mills::text, 'currency', r.currency,
      'observedAt', r.observed_at, 'sourceEventId', r.source_event_id::text,
      'sourceObservationId', r.source_observation_id::text,
      'event', CASE WHEN r.event_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', r.event_id::text, 'accountSeq', r.account_seq::text,
        'observationId', r.event_observation_id::text, 'fan', r.fan_identity_ref,
        'window', r.event_window, 'grossMills', r.event_gross, 'netMills', r.event_net,
        'schemaVersion', r.schema_version
      ) END,
      'observation', CASE WHEN r.observation_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', r.observation_id::text, 'receivedAt', r.source_received_at,
        'kind', r.source_kind, 'parseVersion', r.source_parse_version
      ) END
    ) ORDER BY r.fan_id, r."window"), '[]'::jsonb)
  ) INTO result FROM receipts r;
  IF octet_length(result::text) > 1048576 THEN
    RAISE EXCEPTION 'earnings_audit_response_limit';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_projection(jsonb, bigint, text, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION public.fansly_earnings_audit_projection(jsonb, bigint, text, integer)
      TO read_only;
  END IF;
END $$;
