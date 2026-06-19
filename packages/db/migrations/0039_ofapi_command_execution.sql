-- Durable execution metadata for Decision #56.
-- The executor remains separately feature-flagged and default-off. These
-- columns make one-attempt ownership and crash-to-indeterminate recovery
-- explicit before any worker can call OFAPI.

ALTER TABLE "ofapi_commands"
	ADD COLUMN IF NOT EXISTS "attempt_started_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "attempt_finished_at" timestamp with time zone;

DO $$ BEGIN
	ALTER TABLE "ofapi_commands"
		ADD CONSTRAINT "ofapi_commands_attempt_count_max_one_check"
		CHECK ("attempt_count" <= 1);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ofapi_commands_queued_created_idx"
	ON "ofapi_commands" USING btree ("created_at")
	WHERE "state" = 'queued';

CREATE INDEX IF NOT EXISTS "ofapi_commands_verifier_candidate_idx"
	ON "ofapi_commands" USING btree (
		"ofapi_account_id",
		"conversation_id",
		"attempt_started_at"
	)
	WHERE "state" IN ('in_flight', 'indeterminate');
