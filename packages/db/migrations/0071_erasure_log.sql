-- Kernel Stage 28: the audited break-glass erasure (DP 7-A — "delete" is a
-- governed procedure). Every run, dry or real, leaves a tombstone here: the
-- scope, who initiated it, the full per-plane plan, and — for executions —
-- the counts actually removed. completed_at NULL on an executed run means
-- the run died mid-flight (lake rewrite is post-commit) and must be re-run
-- to convergence.
CREATE TABLE erasure_log (
  id bigserial PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('page', 'model', 'fan')),
  scope_ref text NOT NULL,
  initiated_by bigint NOT NULL REFERENCES users(id),
  dry_run boolean NOT NULL,
  plan jsonb NOT NULL,
  executed_counts jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX erasure_log_scope_idx ON erasure_log (scope_type, scope_ref, started_at);
