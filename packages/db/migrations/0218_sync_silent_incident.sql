-- The ops watchdog's Fansly sync deadman: no sync chunk started while a stream is due.
ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'sync_silent';
