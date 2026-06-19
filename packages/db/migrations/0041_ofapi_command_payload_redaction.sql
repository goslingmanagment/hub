-- Runtime payload redaction for the OFAPI command outbox.
-- Keeps command audit/dedupe metadata while allowing terminal rows to tombstone
-- message text after the recovery/correlation window.

ALTER TABLE "ofapi_commands"
	ADD COLUMN IF NOT EXISTS "payload_redacted_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "ofapi_commands_payload_redaction_idx"
	ON "ofapi_commands" USING btree ("updated_at")
	WHERE "payload_redacted_at" IS NULL
		AND "state" IN ('confirmed', 'failed_retryable', 'failed_terminal', 'cancelled');
