-- 0107: make a failed OFAPI chargebacks reconcile visible as one durable,
-- process-global notification incident until a later clean run recovers.
ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'ofapi_chargebacks_reconcile_failed';
