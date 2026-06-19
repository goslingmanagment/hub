-- Forward-only cold DM archive for OFAPI message webhooks.
-- This is not the capped operational page_dm_messages store and not the raw
-- webhook journal. It stores normalized, governed transcript facts and keeps
-- only stable media metadata: no signed/raw media URLs.

CREATE TABLE IF NOT EXISTS "dm_message_archive" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" platform NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"ofapi_account_id" text NOT NULL,
	"platform_conversation_id" text,
	"fan_platform_user_id" text,
	"platform_message_id" text NOT NULL,
	"sender_platform_user_id" text,
	"sender_role" dm_sender_role DEFAULT 'unknown' NOT NULL,
	"is_sent_by_me" boolean DEFAULT false NOT NULL,
	"message_created_at" timestamp with time zone,
	"text_plain" text DEFAULT '' NOT NULL,
	"price_mills" bigint,
	"is_opened" boolean,
	"is_tip" boolean DEFAULT false NOT NULL,
	"tip_amount_mills" bigint DEFAULT 0 NOT NULL,
	"in_reply_to_message_id" text,
	"deleted_at" timestamp with time zone,
	"source" text NOT NULL,
	"source_event_type" text NOT NULL,
	"source_idempotency_key" text NOT NULL,
	"source_journal_id" bigint NOT NULL,
	"source_fanout_seq" bigint,
	"source_received_at" timestamp with time zone NOT NULL,
	"raw_shape_version" text DEFAULT 'ofapi-message-v1' NOT NULL,
	"media_metadata" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retention_policy" text DEFAULT 'default' NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_message_archive_source_check" CHECK (
		"source" IN ('webhook', 'command', 'rest_reconcile', 'rest_backfill')
	),
	CONSTRAINT "dm_message_archive_event_type_check" CHECK (
		"source_event_type" IN ('messages.received', 'messages.sent', 'messages.deleted')
	),
	CONSTRAINT "dm_message_archive_tip_nonnegative_check" CHECK ("tip_amount_mills" >= 0),
	CONSTRAINT "dm_message_archive_price_nonnegative_check" CHECK (
		"price_mills" IS NULL OR "price_mills" >= 0
	)
);

DO $$ BEGIN
	ALTER TABLE "dm_message_archive"
		ADD CONSTRAINT "dm_message_archive_platform_account_id_pages_id_fk"
		FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "dm_message_archive_platform_account_message_uniq"
	ON "dm_message_archive" USING btree ("platform", "ofapi_account_id", "platform_message_id");
CREATE INDEX IF NOT EXISTS "dm_message_archive_page_message_created_idx"
	ON "dm_message_archive" USING btree ("platform_account_id", "message_created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "dm_message_archive_page_conversation_idx"
	ON "dm_message_archive" USING btree ("platform_account_id", "platform_conversation_id", "message_created_at" DESC);
CREATE INDEX IF NOT EXISTS "dm_message_archive_retain_until_idx"
	ON "dm_message_archive" USING btree ("retain_until");
CREATE INDEX IF NOT EXISTS "dm_message_archive_source_journal_idx"
	ON "dm_message_archive" USING btree ("source_journal_id");
