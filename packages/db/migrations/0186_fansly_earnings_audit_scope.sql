-- C2a acceptance reads share one short, repeatable READ ONLY snapshot.
-- 0182-0185 are already applied in production on independently reviewed branches.
CREATE FUNCTION public.fansly_earnings_audit_scope(
  requested_page text, window_start timestamptz, window_end timestamptz
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  account bigint;
  partition_row record;
  detached_rows bigint;
  inventory jsonb := '[]'::jsonb;
BEGIN
  IF current_setting('transaction_read_only') <> 'on'
    OR current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'earnings_audit_requires_repeatable_read_only';
  END IF;
  IF window_start IS NULL OR window_end IS NULL
    OR NOT isfinite(window_start) OR NOT isfinite(window_end)
    OR window_start >= window_end OR window_end > transaction_timestamp()
    OR window_end - window_start > interval '366 days' THEN
    RAISE EXCEPTION 'invalid_earnings_audit_window';
  END IF;
  SELECT p.id INTO account FROM public.pages p
    WHERE p.label = requested_page AND p.platform = 'fansly';
  IF account IS NULL THEN RAISE EXCEPTION 'unknown_fansly_page'; END IF;

  FOR partition_row IN
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound,
      EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
        AND i.inhparent IN ('public.observations'::regclass, 'public.domain_events'::regclass)) AS attached
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (c.relname ~ '^(observations|domain_events)_(\d{4}(_\d{2})?|future|pre_\d{4})$'
        OR EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
          AND i.inhparent IN ('public.observations'::regclass, 'public.domain_events'::regclass)))
    ORDER BY c.relname
  LOOP
    detached_rows := NULL;
    IF NOT partition_row.attached THEN
      IF partition_row.relname LIKE 'observations_%' THEN
        EXECUTE format('SELECT count(*) FROM public.%I o
          WHERE o.account_id = $1 AND o.platform = ''fansly'' AND o.source = ''pull''
            AND o.kind IN (''fan_earnings_stats'', ''fan_earnings_monthly'')
            AND o.received_at >= $2 AND o.received_at < $3', partition_row.relname)
          INTO detached_rows USING account, window_start, window_end;
      ELSE
        EXECUTE format('SELECT count(*) FROM public.%I e
          WHERE e.account_id = $1 AND e.type = ''fan.earnings_observed''', partition_row.relname)
          INTO detached_rows USING account;
      END IF;
    END IF;
    inventory := inventory || jsonb_build_array(jsonb_build_object(
      'name', partition_row.relname, 'bound', partition_row.bound,
      'attached', partition_row.attached, 'detachedRows', detached_rows::text
    ));
  END LOOP;

  RETURN (
    WITH captures AS (
      SELECT count(*) AS total, coalesce(max(o.id), 0) AS upper_id
      FROM public.observations o
      WHERE o.account_id = account AND o.platform = 'fansly' AND o.source = 'pull'
        AND o.kind IN ('fan_earnings_stats', 'fan_earnings_monthly')
        AND o.received_at >= window_start AND o.received_at < window_end
    ), projected AS (
      SELECT count(*) AS total, coalesce(max(f.id), 0) AS upper_id
      FROM public.fan_earnings_stats f WHERE f.account_id = account
    )
    SELECT jsonb_build_object(
      'version', 1, 'accountId', account::text, 'page', requested_page,
      'from', window_start, 'to', window_end,
      'asOf', transaction_timestamp(), 'snapshot', pg_current_snapshot()::text,
      'observationCount', c.total::text, 'upperObservationId', c.upper_id::text,
      'projectionCount', p.total::text, 'upperProjectionId', p.upper_id::text,
      'eventHighSeq', coalesce((SELECT s.next_seq - 1
        FROM public.domain_event_seq s WHERE s.account_id = account), 0)::text,
      'projectionHighSeq', (SELECT w.high_seq::text
        FROM public.projection_seq_watermarks w
        WHERE w.account_id = account AND w.projection = 'fan_earnings_stats'),
      'partitions', inventory
    ) FROM captures c CROSS JOIN projected p
  );
END;
$$;

-- Internal validator: never accepts an object ID as authority to read a body.
CREATE FUNCTION public.fansly_earnings_audit_account(scope jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  account bigint;
  window_start timestamptz := (scope->>'from')::timestamptz;
  window_end timestamptz := (scope->>'to')::timestamptz;
BEGIN
  IF scope IS NULL OR octet_length(scope::text) > 16384
    OR (scope->>'version') IS DISTINCT FROM '1'
    OR current_setting('transaction_read_only') <> 'on'
    OR current_setting('transaction_isolation') <> 'repeatable read'
    OR (scope->>'snapshot') IS DISTINCT FROM pg_current_snapshot()::text
    OR (scope->>'asOf')::timestamptz IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'earnings_audit_snapshot_mismatch';
  END IF;
  IF window_start IS NULL OR window_end IS NULL
    OR NOT isfinite(window_start) OR NOT isfinite(window_end)
    OR window_start >= window_end OR window_end > transaction_timestamp()
    OR window_end - window_start > interval '366 days'
    OR (scope->>'upperObservationId') IS NULL
    OR (scope->>'upperObservationId')::bigint NOT BETWEEN 0 AND 9007199254740991
    OR (scope->>'upperProjectionId') IS NULL
    OR (scope->>'upperProjectionId')::bigint NOT BETWEEN 0 AND 9007199254740991 THEN
    RAISE EXCEPTION 'invalid_earnings_audit_scope';
  END IF;
  SELECT p.id INTO account FROM public.pages p
    WHERE p.id = (scope->>'accountId')::bigint
      AND p.label = scope->>'page' AND p.platform = 'fansly';
  IF account IS NULL THEN RAISE EXCEPTION 'unknown_fansly_page'; END IF;
  RETURN account;
END;
$$;
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_account(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fansly_earnings_audit_scope(text, timestamptz, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION public.fansly_earnings_audit_scope(text, timestamptz, timestamptz) TO read_only;
  END IF;
END $$;
