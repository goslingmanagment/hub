-- Workboard v2: an append-only activity log of L2 (Haiku) classifier runs.
-- One row per page per run (cron or manual), powering the dashboard's run logger.
-- See docs/workboard-v2-priority-design.md §6.

CREATE TABLE IF NOT EXISTS "wb_classifier_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"trigger" text NOT NULL,
	"model" text,
	"classified" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"deferred" integer DEFAULT 0 NOT NULL,
	"cleared" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "wb_classifier_runs" ADD CONSTRAINT "wb_classifier_runs_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "wb_classifier_runs_created_idx" ON "wb_classifier_runs" USING btree ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "wb_classifier_runs_page_idx" ON "wb_classifier_runs" USING btree ("platform_account_id","created_at" DESC);
