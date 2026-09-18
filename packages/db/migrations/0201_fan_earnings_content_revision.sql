-- Existing signals lack a recorded semantic diff. Keep them strict until
-- individually evidenced; deployment must not silently acknowledge old debt.
ALTER TABLE subject_refresh_state
  ADD COLUMN earnings_content_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT subject_refresh_earnings_content_revision_check CHECK (
    earnings_content_revision BETWEEN 0 AND requested_revision
  );

UPDATE subject_refresh_state SET earnings_content_revision = requested_revision
WHERE plane IN ('fan_earnings_lifetime', 'fan_earnings_monthly');

COMMENT ON COLUMN subject_refresh_state.earnings_content_revision IS
  'Highest earnings revision requiring changed content; exact pending-to-posted status rechecks do not advance it. Legacy debt is conservative.';

-- Bounded operational metadata for an already-known page/fan, without grants
-- on transactions, fans, or the complete refresh queue.
CREATE FUNCTION fansly_earnings_refresh_status(page_label text, fan_ref text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'plane', s.plane, 'requestedRevision', s.requested_revision,
    'appliedRevision', s.applied_revision, 'contentRevision', s.earnings_content_revision,
    'dirtyReason', s.dirty_reason, 'claimActive', s.claim_token IS NOT NULL,
    'claimExpiresAt', s.claim_expires_at, 'lastCheckedAt', s.last_checked_at,
    'lastCheckedObservationId', s.last_checked_observation_id,
    'lastContentFingerprint', s.last_content_fingerprint,
    'lastRefreshOutcome', s.last_refresh_outcome,
    'nextDueAt', s.next_due_at, 'retryAfterAt', s.retry_after_at,
    'refreshChecks', s.refresh_checks, 'refreshChanges', s.refresh_changes
  ) ORDER BY s.plane), '[]'::jsonb)
  FROM public.subject_refresh_state s JOIN public.pages p ON p.id = s.page_id
  WHERE p.label = page_label AND p.platform = 'fansly' AND s.subject_ref = fan_ref
    AND length(page_label) BETWEEN 1 AND 100 AND length(fan_ref) BETWEEN 1 AND 100
    AND s.plane IN ('fan_earnings_lifetime', 'fan_earnings_monthly');
$$;
REVOKE ALL ON FUNCTION fansly_earnings_refresh_status(text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION fansly_earnings_refresh_status(text, text) TO read_only;
  END IF;
END $$;
