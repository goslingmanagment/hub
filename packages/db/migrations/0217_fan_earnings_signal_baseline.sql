-- An unchanged valid earnings response confirms a transaction signal when its
-- content baseline was first seen after that signal. Track when the latest
-- content-changing signal was recorded and when/at which claimed revision the
-- current fingerprint was first seen. Only the claimed revision orders the two
-- for new receipts: a claim reads every committed signal before its fetch.
ALTER TABLE subject_refresh_state
  ADD COLUMN earnings_content_signal_at timestamptz,
  ADD COLUMN content_baseline_at timestamptz,
  ADD COLUMN content_baseline_revision bigint,
  ADD CONSTRAINT subject_refresh_content_baseline_revision_check CHECK (
    content_baseline_revision BETWEEN 0 AND requested_revision
  );

COMMENT ON COLUMN subject_refresh_state.earnings_content_signal_at IS
  'When the current earnings_content_revision was recorded; null when unknown (before 0217, or an old writer).';
COMMENT ON COLUMN subject_refresh_state.content_baseline_at IS
  'When the current content fingerprint was first seen by a valid receipt; null when unknown.';
COMMENT ON COLUMN subject_refresh_state.content_baseline_revision IS
  'Every revision up to this one preceded the first sighting of the current fingerprint; null when unproven.';

-- The daily walk crosses a fan's 404 only after that endpoint was rejected
-- three times in a row. consecutive_failures also counts 5xx, timeouts and
-- empty or invalid bodies, so rejections keep their own run, which any other
-- receipt resets. Existing rows start at 0, a lower bound.
ALTER TABLE subject_refresh_state
  ADD COLUMN consecutive_rejections integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT subject_refresh_state_rejections_check CHECK (consecutive_rejections >= 0);

COMMENT ON COLUMN subject_refresh_state.consecutive_rejections IS
  'Receipts in a row whose request the provider rejected (400/404/410); any other receipt resets it.';

-- Existing pending content debt keeps its strict hold unless retained evidence
-- proves the baseline followed every content signal. The proof needs all of:
-- the endpoint row was created by the first signal's transaction batch; each
-- content revision since then is one transaction insert for this fan (so the
-- newest insert is the newest content signal); and no capture of this endpoint
-- for this fan since the row existed is earlier than that insert plus an hour
-- (covering the signal's batch commit, rate-limit waits and the request).
-- Other rows stay unproven (null). A following ordinary claim and valid
-- unchanged receipt performs the acknowledgement.
WITH pending AS MATERIALIZED (
  SELECT s.page_id, s.plane, s.subject_ref, s.created_at,
    CASE s.plane WHEN 'fan_earnings_lifetime' THEN 'fan_earnings_stats'
      ELSE 'fan_earnings_monthly' END AS endpoint
  FROM subject_refresh_state s
  WHERE s.plane IN ('fan_earnings_lifetime', 'fan_earnings_monthly')
    AND s.earnings_content_revision > s.applied_revision
    AND s.last_content_fingerprint IS NOT NULL
), signals AS (
  SELECT p.page_id, p.plane, p.subject_ref, count(*) AS inserts,
    max(t.created_at) AS signal_at, bool_or(t.created_at = p.created_at) AS created_by_signal
  FROM pending p JOIN transactions t ON t.platform_account_id = p.page_id
    AND t.correlation_account_id = p.subject_ref AND t.created_at >= p.created_at
  GROUP BY p.page_id, p.plane, p.subject_ref
), baselines AS (
  SELECT p.page_id, p.plane, p.subject_ref, min(r.captured_at) AS first_capture
  FROM pending p JOIN sync_raw_payloads r ON r.page_id = p.page_id AND r.endpoint = p.endpoint
    AND r.request_params->>'correlationAccountId' = p.subject_ref AND r.captured_at >= p.created_at
  GROUP BY p.page_id, p.plane, p.subject_ref
)
UPDATE subject_refresh_state s SET
  earnings_content_signal_at = g.signal_at,
  content_baseline_at = b.first_capture,
  content_baseline_revision = s.earnings_content_revision
FROM signals g JOIN baselines b USING (page_id, plane, subject_ref)
WHERE s.page_id = g.page_id AND s.plane = g.plane AND s.subject_ref = g.subject_ref
  AND g.created_by_signal AND g.inserts = s.earnings_content_revision
  AND b.first_capture > g.signal_at + interval '1 hour';

CREATE OR REPLACE FUNCTION fansly_earnings_refresh_status(page_label text, fan_ref text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'plane', s.plane, 'requestedRevision', s.requested_revision,
    'appliedRevision', s.applied_revision, 'contentRevision', s.earnings_content_revision,
    'contentSignalAt', s.earnings_content_signal_at,
    'contentBaselineAt', s.content_baseline_at,
    'contentBaselineRevision', s.content_baseline_revision,
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
