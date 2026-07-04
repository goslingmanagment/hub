-- Stage 1 (kernel retention stand-down): disk-usage alert incident kind.
-- Containment for "fact tables now grow forever" — a scheduled worker check
-- pages the owner when the server disk crosses the alert threshold.
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'db_disk_usage';
