-- The fan/page-fan capture lanes rewrite every row on every sweep (57.8M updates
-- on 67k page_fans rows by 2026-08-23); default autovacuum (scale_factor 0.2)
-- let the heaps grow 30-64x their live size. VACUUM FULL reclaimed them in the
-- 2026-08-23 maintenance window; these thresholds keep them reclaimed.
-- cost_delay is left at default deliberately: an unthrottled vacuum would
-- compete with the backfill for the 2-vCPU host.
ALTER TABLE fans SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE page_fans SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE page_sync_states SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 50);
