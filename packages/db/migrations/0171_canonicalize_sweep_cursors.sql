-- Rebuildable traversal state only. A cursor is NOT a consumption watermark:
-- unstamped observations remain eligible after wrap, parser upgrade or repair.
CREATE TABLE canonicalize_sweep_cursors (
  key text PRIMARY KEY,
  after_id bigint,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (after_id IS NULL OR after_id > 0),
  CHECK (revision >= 0)
);
