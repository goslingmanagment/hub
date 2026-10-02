-- The Fansly Sync Engine's alerts (plan §10, design §9.6): one incident kind,
-- five subKeys (page_stopped, live_degraded, freshness, stuck, process).
-- Purely additive; the previous image never produces the value.
ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'fansly_sync_engine';
