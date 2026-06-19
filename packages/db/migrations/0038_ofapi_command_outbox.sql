-- Core-owned OFAPI command outbox intake (Decision #55).
-- This migration adds durable command/dedupe state only. No worker or route in
-- this slice executes a command against OFAPI.

CREATE TABLE IF NOT EXISTS "ofapi_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_command_id" uuid NOT NULL,
	"page_id" bigint NOT NULL,
	"chatter_user_id" bigint NOT NULL,
	"ofapi_account_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"retry_of_command_id" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_class" text,
	"verifier_result" jsonb,
	"platform_message_id" text,
	"dedupe_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ofapi_commands_kind_check" CHECK ("kind" = 'send_text_message_v1'),
	CONSTRAINT "ofapi_commands_state_check" CHECK (
		"state" IN (
			'queued',
			'in_flight',
			'confirmed',
			'failed_retryable',
			'failed_terminal',
			'indeterminate',
			'cancelled'
		)
	),
	CONSTRAINT "ofapi_commands_attempt_count_nonnegative_check" CHECK ("attempt_count" >= 0),
	CONSTRAINT "ofapi_commands_account_id_check" CHECK (
		"ofapi_account_id" ~ '^acct_[A-Za-z0-9]+$'
	),
	CONSTRAINT "ofapi_commands_conversation_id_check" CHECK (
		"conversation_id" ~ '^[0-9]{1,30}$'
	),
	CONSTRAINT "ofapi_commands_payload_hash_check" CHECK (
		"payload_hash" ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT "ofapi_commands_dedupe_horizon_check" CHECK (
		"dedupe_expires_at" >= "created_at"
	)
);

DO $$ BEGIN
	ALTER TABLE "ofapi_commands"
		ADD CONSTRAINT "ofapi_commands_page_id_pages_id_fk"
		FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "ofapi_commands"
		ADD CONSTRAINT "ofapi_commands_chatter_user_id_users_id_fk"
		FOREIGN KEY ("chatter_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "ofapi_commands"
		ADD CONSTRAINT "ofapi_commands_retry_of_command_id_fk"
		FOREIGN KEY ("retry_of_command_id") REFERENCES "public"."ofapi_commands"("id") ON DELETE RESTRICT;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ofapi_commands_page_chatter_client_uniq"
	ON "ofapi_commands" USING btree ("page_id", "chatter_user_id", "client_command_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ofapi_commands_one_in_flight_lane_uniq"
	ON "ofapi_commands" USING btree ("page_id", "conversation_id")
	WHERE "state" = 'in_flight';
CREATE INDEX IF NOT EXISTS "ofapi_commands_chatter_created_idx"
	ON "ofapi_commands" USING btree ("chatter_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ofapi_commands_page_lane_created_idx"
	ON "ofapi_commands" USING btree ("page_id", "conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "ofapi_commands_dedupe_expires_idx"
	ON "ofapi_commands" USING btree ("dedupe_expires_at");
