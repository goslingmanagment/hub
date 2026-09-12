-- C2b extends only the new earnings planes. Existing refresh consumers retain
-- their current semantics; an earnings claim can settle only its own revision.
ALTER TABLE subject_refresh_state
  DROP CONSTRAINT subject_refresh_state_plane_check,
  ADD COLUMN requested_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN applied_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN claimed_revision bigint,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD COLUMN retry_after_at timestamptz,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_changed_at timestamptz,
  ADD COLUMN last_receipt_observation_id bigint,
  ADD COLUMN last_checked_observation_id bigint,
  ADD COLUMN last_content_fingerprint text,
  ADD COLUMN last_refresh_outcome text,
  ADD COLUMN refresh_visits bigint NOT NULL DEFAULT 0,
  ADD COLUMN refresh_receipts bigint NOT NULL DEFAULT 0,
  ADD COLUMN refresh_checks bigint NOT NULL DEFAULT 0,
  ADD COLUMN refresh_changes bigint NOT NULL DEFAULT 0,
  ADD COLUMN unsignaled_changes bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT subject_refresh_state_plane_check CHECK (plane IN (
    'media_stats', 'post_replies', 'post_engagement', 'of_post_stats',
    'fan_earnings_lifetime', 'fan_earnings_monthly', 'fan_earnings_attribution'
  )),
  ADD CONSTRAINT subject_refresh_revision_check CHECK (
    applied_revision >= 0 AND requested_revision >= applied_revision
    AND (claimed_revision IS NULL OR claimed_revision BETWEEN applied_revision AND requested_revision)
  ),
  ADD CONSTRAINT subject_refresh_claim_check CHECK (
    num_nonnulls(claimed_revision, claim_token, claim_expires_at) IN (0, 3)
  );

COMMENT ON COLUMN subject_refresh_state.last_checked_at IS
  'Last valid nonempty response bound to this fan/endpoint; not proof of provider recalculation.';
COMMENT ON COLUMN subject_refresh_state.last_changed_at IS
  'Last fingerprint change against an existing receipt; the first baseline is not a change.';
COMMENT ON COLUMN subject_refresh_state.unsignaled_changes IS
  'Changes observed by daily rotation without a pending semantic transaction signal at claim time.';
