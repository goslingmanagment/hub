-- 0089 (#141 addendum): request_source is immutable request/audit origin.
-- dispatch_source is the mutable scheduling class for the current generation,
-- so a priority boost can be consumed without falsifying run telemetry.
ALTER TABLE page_sync_states
  ADD COLUMN dispatch_source sync_request_source NOT NULL DEFAULT 'scheduled';

UPDATE page_sync_states
SET dispatch_source = request_source
WHERE request_source IS NOT NULL;
