-- Kernel Stage 26: priority classes on the shared pacing rows. Additive —
-- existing rows default to 'bulk'; the vendor-cap and class rows are seeded
-- idempotently at runtime (ensureSyncProviderRateLimitProfile), not here.
ALTER TABLE sync_rate_limits ADD COLUMN priority_class text NOT NULL DEFAULT 'bulk'
  CHECK (priority_class IN ('interactive', 'commands', 'bulk'));
