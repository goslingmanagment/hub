-- Workboard v2: per-page runtime settings for the L2 (Haiku) closing classifier.
-- Each column is nullable = "inherit the env default". Lets an owner toggle the
-- feature, change the daily call cap, or pin a model per page from the dashboard,
-- without a redeploy. See docs/workboard-v2-priority-design.md §6.

CREATE TABLE IF NOT EXISTS "wb_closing_settings" (
	"platform_account_id" bigint PRIMARY KEY NOT NULL,
	"enabled" boolean,
	"daily_cap_max" integer,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "wb_closing_settings" ADD CONSTRAINT "wb_closing_settings_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
