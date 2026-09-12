-- Snapshot counts only; retain successive reports outside telemetry retention.
-- No fan identities, monetary values, raw bodies or base-table grants.
CREATE OR REPLACE FUNCTION fansly_earnings_shadow_report(requested_page_label text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  selected_page bigint;
  result jsonb;
BEGIN
  SELECT p.id INTO selected_page FROM public.pages p
    WHERE p.label = requested_page_label AND p.platform = 'fansly';
  IF selected_page IS NULL THEN RAISE EXCEPTION 'unknown_fansly_page'; END IF;
  WITH states AS MATERIALIZED (
    SELECT s.* FROM public.subject_refresh_state s
    WHERE s.page_id = selected_page AND s.plane IN (
      'fan_earnings_lifetime', 'fan_earnings_monthly', 'fan_earnings_attribution'
    )
  ), endpoints AS (
    SELECT s.plane, count(*) AS tracked_fans,
      count(*) FILTER (WHERE s.requested_revision > s.applied_revision) AS pending_fans,
      count(*) FILTER (WHERE s.retry_after_at IS NOT NULL) AS retry_fans,
      count(*) FILTER (WHERE s.claim_expires_at > now()) AS active_claims,
      count(*) FILTER (WHERE s.claim_expires_at <= now()) AS expired_claims,
      count(*) FILTER (WHERE s.last_checked_at IS NULL) AS never_checked,
      count(*) FILTER (WHERE s.last_checked_at >= now() - interval '24 hours') AS checked_within_24h,
      count(*) FILTER (WHERE s.last_checked_at < now() - interval '24 hours') AS checked_older_than_24h,
      count(*) FILTER (WHERE s.last_checked_at < now() - interval '7 days') AS checked_older_than_7d,
      count(*) FILTER (WHERE s.requested_revision > s.applied_revision AND NOT EXISTS (
        SELECT 1 FROM public.page_fans pf JOIN public.fans f ON f.id = pf.fan_id
        WHERE pf.platform_account_id = selected_page AND f.platform_user_id = s.subject_ref
          AND pf.total_creator_net_mills > 0
      )) AS pending_outside_daily_spenders,
      sum(s.refresh_visits) AS endpoint_visits,
      sum(s.refresh_receipts) AS receipts,
      sum(s.refresh_visits - s.refresh_receipts) AS missing_or_inflight_receipts,
      sum(s.refresh_checks) AS valid_checks,
      sum(s.refresh_changes) AS changes,
      sum(s.unsignaled_changes) AS changes_without_signal_at_claim,
      min(s.created_at) AS first_tracked_at
    FROM states s WHERE s.plane <> 'fan_earnings_attribution' GROUP BY s.plane
  ), outcomes AS (
    SELECT s.plane, s.last_refresh_outcome AS outcome, count(*) AS fans
    FROM states s WHERE s.plane <> 'fan_earnings_attribution'
    GROUP BY s.plane, s.last_refresh_outcome
  ), checkpoint AS (
    SELECT c.state->>'completedAt' AS completed_at
    FROM public.page_sync_cursors c WHERE c.page_id = selected_page
      AND c.stream = 'fan_earnings'
  )
  SELECT jsonb_build_object(
    'as_of', now(), 'scope', 'cumulative_shadow_snapshot',
    'tracked_scope_complete', false,
    'endpoints', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.plane) FROM endpoints e), '[]'::jsonb),
    'outcomes', coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.plane, o.outcome) FROM outcomes o), '[]'::jsonb),
    'unknown_attribution', (SELECT count(*) FROM states s
      WHERE s.plane = 'fan_earnings_attribution' AND s.requested_revision > s.applied_revision),
    'last_completed_daily_spender_sweep', (SELECT CASE
      WHEN length(c.completed_at) <= 35
        AND c.completed_at ~ '^[0-9T:.+Z-]+$'
        AND pg_input_is_valid(c.completed_at, 'timestamp with time zone')
      THEN c.completed_at::timestamptz ELSE NULL END FROM checkpoint c)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION fansly_earnings_shadow_report(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION fansly_earnings_shadow_report(text) TO read_only;
  END IF;
END $$;
