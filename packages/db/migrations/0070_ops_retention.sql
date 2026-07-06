-- Kernel Stage 28: ops telemetry gets bounded retention. sync_runs grew
-- UNBOUNDED until now (only its children had the 30-day sweep); the sweep
-- gains the parent table and this index carries the delete.
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at);
