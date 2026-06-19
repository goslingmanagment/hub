-- Shadow-only OFAPI spend projection for ChatGoose C3.
-- This table is a comparison/audit surface, not production revenue truth.
-- Desktop spend sweep stays unchanged until shadow comparison passes.

CREATE TABLE IF NOT EXISTS "ofapi_spend_projection_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"domain_key" text NOT NULL,
	"projection_status" text NOT NULL,
	"blocked_reason" text,
	"source_event_type" text NOT NULL,
	"source_idempotency_key" text NOT NULL,
	"journal_id" bigint NOT NULL,
	"fanout_seq" bigint,
	"ofapi_account_id" text NOT NULL,
	"page_id" bigint NOT NULL,
	"fan_platform_user_id" text,
	"transaction_id" text,
	"message_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"category" text,
	"currency" text,
	"gross_amount_mills" bigint,
	"creator_net_amount_mills" bigint,
	"event_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ofapi_spend_projection_status_check" CHECK (
		"projection_status" IN ('projected', 'blocked', 'skipped')
	),
	CONSTRAINT "ofapi_spend_projection_event_type_check" CHECK (
		"source_event_type" IN ('transactions.new', 'tips.received', 'messages.ppv.unlocked')
	),
	CONSTRAINT "ofapi_spend_projection_category_check" CHECK (
		"category" IS NULL OR "category" IN ('message', 'tip', 'subscription', 'post', 'stream', 'other')
	),
	CONSTRAINT "ofapi_spend_projection_currency_check" CHECK (
		"currency" IS NULL OR "currency" = 'USD'
	),
	CONSTRAINT "ofapi_spend_projection_event_status_check" CHECK (
		"event_status" IS NULL OR "event_status" IN ('pending', 'settled', 'reversed', 'estimated')
	)
);

DO $$ BEGIN
	ALTER TABLE "ofapi_spend_projection_events"
		ADD CONSTRAINT "ofapi_spend_projection_events_page_id_pages_id_fk"
		FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ofapi_spend_projection_events_domain_key_uniq"
	ON "ofapi_spend_projection_events" USING btree ("domain_key");
CREATE INDEX IF NOT EXISTS "ofapi_spend_projection_events_page_occurred_idx"
	ON "ofapi_spend_projection_events" USING btree ("page_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "ofapi_spend_projection_events_status_idx"
	ON "ofapi_spend_projection_events" USING btree ("projection_status", "source_event_type");
CREATE INDEX IF NOT EXISTS "ofapi_spend_projection_events_journal_idx"
	ON "ofapi_spend_projection_events" USING btree ("journal_id");
