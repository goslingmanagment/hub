-- OF mirror S2: a signed webhook is durable before JSON/envelope parsing.
-- Existing rows predate raw capture and remain accepted legacy facts.

ALTER TABLE ofapi_webhook_events
  ADD COLUMN raw_body bytea,
  ADD COLUMN payload_hash bytea,
  ADD COLUMN capture_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN capture_state text NOT NULL DEFAULT 'accepted';

ALTER TABLE ofapi_webhook_events
  ADD CONSTRAINT ofapi_webhook_events_capture_state_check
  CHECK (capture_state IN ('raw_captured', 'accepted', 'quarantined_malformed')),
  ADD CONSTRAINT ofapi_webhook_events_raw_capture_check
  CHECK (
    capture_state = 'accepted'
    OR (raw_body IS NOT NULL AND payload_hash IS NOT NULL)
  );

CREATE INDEX ofapi_webhook_events_raw_capture_idx
  ON ofapi_webhook_events (id)
  WHERE capture_state = 'raw_captured';
