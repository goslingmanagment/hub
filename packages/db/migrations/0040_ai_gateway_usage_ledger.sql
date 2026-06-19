-- ChatMuse AI gateway ledger metadata (Decision #26).
-- This migration is storage-only: provider execution and quota enforcement remain
-- separately gated and are not enabled by adding these columns.

ALTER TABLE "ai_usage_events"
	ADD COLUMN IF NOT EXISTS "page_id" bigint,
	ADD COLUMN IF NOT EXISTS "provider" text,
	ADD COLUMN IF NOT EXISTS "provider_response_id" text,
	ADD COLUMN IF NOT EXISTS "cost_micro_usd" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "cost_approximate" boolean DEFAULT false NOT NULL,
	ADD COLUMN IF NOT EXISTS "quota_accepted" boolean,
	ADD COLUMN IF NOT EXISTS "gateway_outcome" text;

DO $$ BEGIN
	ALTER TABLE "ai_usage_events"
		ADD CONSTRAINT "ai_usage_events_page_id_pages_id_fk"
		FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE SET NULL;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "ai_usage_events"
		ADD CONSTRAINT "ai_usage_events_cost_micro_usd_nonnegative"
		CHECK ("cost_micro_usd" >= 0);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "ai_usage_events"
		ADD CONSTRAINT "ai_usage_events_provider_check"
		CHECK ("provider" IS NULL OR "provider" IN ('anthropic', 'openrouter'));
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
	ALTER TABLE "ai_usage_events"
		ADD CONSTRAINT "ai_usage_events_gateway_outcome_check"
		CHECK (
			"gateway_outcome" IS NULL
			OR "gateway_outcome" IN ('completed', 'failed', 'cancelled', 'quota_denied')
		);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ai_usage_events_page_completed_idx"
	ON "ai_usage_events" USING btree ("page_id", "completed_at");

CREATE INDEX IF NOT EXISTS "ai_usage_events_provider_response_idx"
	ON "ai_usage_events" USING btree ("provider", "provider_response_id")
	WHERE "provider_response_id" IS NOT NULL;
