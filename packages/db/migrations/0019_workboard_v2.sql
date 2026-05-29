-- Workboard v2 (priority engine). Additive; v1 workboard tables/queries untouched.
-- See docs/workboard-v2-priority-design.md.

CREATE TYPE "public"."workboard_tab" AS ENUM('subscribers', 'spenders', 'fresh_mass', 'old_mass', 'service');
CREATE TYPE "public"."workboard_mass_substate" AS ENUM('fresh', 'gray', 'active', 'dead', 'archived');
CREATE TYPE "public"."workboard_secondary_status" AS ENUM('recent_purchase', 'need_reply', 'due_now', 'later', 'dont_touch_today');
CREATE TYPE "public"."workboard_freeloader_status" AS ENUM('none', 'cooling', 'freeloader', 'ceiling');
CREATE TYPE "public"."workboard_contact_action" AS ENUM('opened', 'handled', 'snoozed');

CREATE TABLE IF NOT EXISTS "workboard_state" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"tab" "workboard_tab" NOT NULL,
	"mass_substate" "workboard_mass_substate",
	"value_score" numeric(5, 2) DEFAULT 0 NOT NULL,
	"urgency_score" numeric(5, 2) DEFAULT 0 NOT NULL,
	"rank_score" numeric(8, 3) DEFAULT 0 NOT NULL,
	"secondary_status" "workboard_secondary_status" DEFAULT 'later' NOT NULL,
	"value_tier" text DEFAULT 'new' NOT NULL,
	"urgency_severity" text DEFAULT 'normal' NOT NULL,
	"needs_reply" boolean DEFAULT false NOT NULL,
	"needs_human_triage" boolean DEFAULT false NOT NULL,
	"is_purchase_followup" boolean DEFAULT false NOT NULL,
	"why_now_code" text,
	"why_now_value" numeric(10, 2),
	"reason_chips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"followup_due_at" timestamp with time zone,
	"q_score" numeric(4, 3),
	"q_confidence" text DEFAULT 'low' NOT NULL,
	"value_confidence" text DEFAULT 'low' NOT NULL,
	"role_confidence" numeric(4, 3) DEFAULT 1 NOT NULL,
	"best_coverage_seen" "dm_message_coverage_status",
	"freeloader_status" "workboard_freeloader_status" DEFAULT 'none' NOT NULL,
	"freeloader_episodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifetime_free_episodes" integer DEFAULT 0 NOT NULL,
	"reactivation_attempted_at" timestamp with time zone,
	"service_reason" text,
	"last_eval_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workboard_state_pkey" PRIMARY KEY("platform_account_id","fan_id")
);

CREATE TABLE IF NOT EXISTS "workboard_contact_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"model_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"action" "workboard_contact_action" NOT NULL,
	"was_productive" boolean DEFAULT false NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workboard_state" ADD CONSTRAINT "workboard_state_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_state" ADD CONSTRAINT "workboard_state_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_contact_log" ADD CONSTRAINT "workboard_contact_log_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_contact_log" ADD CONSTRAINT "workboard_contact_log_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_contact_log" ADD CONSTRAINT "workboard_contact_log_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "workboard_state_tab_rank_idx" ON "workboard_state" USING btree ("platform_account_id","tab","rank_score" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "workboard_state_status_idx" ON "workboard_state" USING btree ("platform_account_id","tab","secondary_status");
CREATE INDEX IF NOT EXISTS "workboard_state_fan_idx" ON "workboard_state" USING btree ("fan_id","platform_account_id");
CREATE INDEX IF NOT EXISTS "workboard_contact_log_page_fan_acted_idx" ON "workboard_contact_log" USING btree ("platform_account_id","fan_id","acted_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "workboard_contact_log_model_fan_date_idx" ON "workboard_contact_log" USING btree ("model_id","fan_id","business_date");
CREATE INDEX IF NOT EXISTS "workboard_contact_log_page_date_idx" ON "workboard_contact_log" USING btree ("platform_account_id","business_date");
