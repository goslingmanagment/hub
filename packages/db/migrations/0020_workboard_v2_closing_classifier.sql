-- Workboard v2 Stage 2: L2 (Haiku) closing classifier. Additive.
-- See docs/workboard-v2-priority-design.md §6.

CREATE TABLE IF NOT EXISTS "wb_closing_cache" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"platform_message_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"needs_reply" boolean NOT NULL,
	"layer" text NOT NULL,
	"model" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wb_closing_cache_message_uniq" UNIQUE("platform_account_id","platform_message_id")
);

CREATE TABLE IF NOT EXISTS "wb_llm_usage_daily" (
	"platform_account_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"feature" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wb_llm_usage_daily_pkey" PRIMARY KEY("platform_account_id","business_date","feature")
);

ALTER TABLE "wb_closing_cache" ADD CONSTRAINT "wb_closing_cache_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "wb_llm_usage_daily" ADD CONSTRAINT "wb_llm_usage_daily_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "wb_closing_cache_page_idx" ON "wb_closing_cache" USING btree ("platform_account_id","classified_at");
