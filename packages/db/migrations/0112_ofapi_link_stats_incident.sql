-- 0112: make a failed OFAPI link-stats reconcile visible as one durable,
-- process-global notification incident until a later clean run recovers.
ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'ofapi_link_stats_reconcile_failed';
