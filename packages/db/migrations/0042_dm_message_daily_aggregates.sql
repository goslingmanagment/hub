-- Aggregate-only DM analytics groundwork over the governed cold archive.
-- No transcript text, media URLs, or fan identifiers are copied into this table.
-- Rows are replaceable derived state and may be rebuilt from dm_message_archive.

CREATE TABLE IF NOT EXISTS "dm_message_daily_aggregates" (
	"platform_account_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"archive_rows" integer DEFAULT 0 NOT NULL,
	"inbound_messages" integer DEFAULT 0 NOT NULL,
	"outbound_messages" integer DEFAULT 0 NOT NULL,
	"deleted_messages" integer DEFAULT 0 NOT NULL,
	"distinct_conversations" integer DEFAULT 0 NOT NULL,
	"paid_outbound_messages" integer DEFAULT 0 NOT NULL,
	"paid_outbound_price_mills" bigint DEFAULT 0 NOT NULL,
	"tip_messages" integer DEFAULT 0 NOT NULL,
	"tip_amount_mills" bigint DEFAULT 0 NOT NULL,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"source_max_fanout_seq" bigint,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_message_daily_aggregates_pkey"
		PRIMARY KEY ("platform_account_id", "business_date"),
	CONSTRAINT "dm_message_daily_aggregates_counts_nonnegative_check" CHECK (
		"archive_rows" >= 0
		AND "inbound_messages" >= 0
		AND "outbound_messages" >= 0
		AND "deleted_messages" >= 0
		AND "distinct_conversations" >= 0
		AND "paid_outbound_messages" >= 0
		AND "paid_outbound_price_mills" >= 0
		AND "tip_messages" >= 0
		AND "tip_amount_mills" >= 0
	)
);

DO $$ BEGIN
	ALTER TABLE "dm_message_daily_aggregates"
		ADD CONSTRAINT "dm_message_daily_aggregates_platform_account_id_pages_id_fk"
		FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "dm_message_daily_aggregates_date_idx"
	ON "dm_message_daily_aggregates" USING btree ("business_date" DESC, "platform_account_id");
