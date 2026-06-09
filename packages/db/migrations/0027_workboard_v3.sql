-- Workboard v3 (shift plan + reason codes). Additive; v1/v2 workboard tables and
-- all sync tables untouched. See docs/workboard-v3-prd.md.

CREATE TYPE "public"."workboard_v3_segment" AS ENUM('subscriber', 'spender', 'fresh', 'gray', 'mass_active', 'dead', 'archived');
CREATE TYPE "public"."workboard_v3_touch_type" AS ENUM('personal', 'manual', 'broadcast');
CREATE TYPE "public"."workboard_v3_section" AS ENUM('purchase', 'needs_reply', 'risk', 'scheduled');
CREATE TYPE "public"."workboard_v3_plan_item_source" AS ENUM('initial', 'live', 'refill');
CREATE TYPE "public"."workboard_v3_plan_item_status" AS ENUM('pending', 'in_progress', 'done', 'skipped', 'snoozed', 'expired');
CREATE TYPE "public"."workboard_v3_dossier_source" AS ENUM('history', 'transactions_only');

CREATE TABLE IF NOT EXISTS "workboard_v3_fan_state" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"segment" "workboard_v3_segment" NOT NULL,
	"has_ever_replied" boolean DEFAULT false NOT NULL,
	"freeloader" boolean DEFAULT false NOT NULL,
	"do_not_touch" boolean DEFAULT false NOT NULL,
	"do_not_touch_reason" text,
	"dead_attempts" integer DEFAULT 0 NOT NULL,
	"dead_sleep_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"last_personal_touch_at" timestamp with time zone,
	"last_any_touch_at" timestamp with time zone,
	"cadence_due_at" timestamp with time zone,
	"response_rate_90d" numeric(4, 3),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workboard_v3_fan_state_pkey" PRIMARY KEY("platform_account_id","fan_id")
);

CREATE TABLE IF NOT EXISTS "workboard_v3_shifts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"chatter_user_id" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"summary" jsonb
);

CREATE TABLE IF NOT EXISTS "workboard_v3_touches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"shift_id" bigint,
	"chatter_user_id" bigint,
	"type" "workboard_v3_touch_type" NOT NULL,
	"opened_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"model_message_pk" bigint,
	"outcome_replied_at" timestamp with time zone,
	"outcome_purchase_at" timestamp with time zone,
	"outcome_computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "workboard_v3_plan_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"shift_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"section" "workboard_v3_section" NOT NULL,
	"source" "workboard_v3_plan_item_source" DEFAULT 'initial' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "workboard_v3_plan_item_status" DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_touch_id" bigint,
	"skip_reason" text
);

CREATE TABLE IF NOT EXISTS "dm_broadcast_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"first_sent_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "dm_broadcast_messages" (
	"message_pk" bigint PRIMARY KEY NOT NULL,
	"group_id" bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "dialog_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"conversation_id" bigint NOT NULL,
	"last_fan_message_pk" bigint,
	"verdict" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dialog_reads_conversation_message_uniq" UNIQUE("conversation_id","last_fan_message_pk")
);

CREATE TABLE IF NOT EXISTS "fan_dossiers" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"dossier" jsonb NOT NULL,
	"source" "workboard_v3_dossier_source" NOT NULL,
	"coverage_at_build" text,
	"model" text,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_dossiers_pkey" PRIMARY KEY("platform_account_id","fan_id")
);

CREATE TABLE IF NOT EXISTS "workboard_v3_job_state" (
	"platform_account_id" bigint PRIMARY KEY NOT NULL,
	"broadcast_scanned_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Shared with v1/v2 — additive nullable column only.
ALTER TABLE "workboard_snoozes" ADD COLUMN IF NOT EXISTS "reason" text;

ALTER TABLE "workboard_v3_fan_state" ADD CONSTRAINT "workboard_v3_fan_state_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_fan_state" ADD CONSTRAINT "workboard_v3_fan_state_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_shifts" ADD CONSTRAINT "workboard_v3_shifts_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_shifts" ADD CONSTRAINT "workboard_v3_shifts_chatter_user_id_users_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_touches" ADD CONSTRAINT "workboard_v3_touches_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_touches" ADD CONSTRAINT "workboard_v3_touches_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_touches" ADD CONSTRAINT "workboard_v3_touches_shift_id_workboard_v3_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workboard_v3_shifts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workboard_v3_touches" ADD CONSTRAINT "workboard_v3_touches_chatter_user_id_users_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workboard_v3_touches" ADD CONSTRAINT "workboard_v3_touches_model_message_pk_page_dm_messages_id_fk" FOREIGN KEY ("model_message_pk") REFERENCES "public"."page_dm_messages"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "workboard_v3_plan_items" ADD CONSTRAINT "workboard_v3_plan_items_shift_id_workboard_v3_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workboard_v3_shifts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_plan_items" ADD CONSTRAINT "workboard_v3_plan_items_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_plan_items" ADD CONSTRAINT "workboard_v3_plan_items_resolved_by_touch_id_workboard_v3_touches_id_fk" FOREIGN KEY ("resolved_by_touch_id") REFERENCES "public"."workboard_v3_touches"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "dm_broadcast_groups" ADD CONSTRAINT "dm_broadcast_groups_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dm_broadcast_messages" ADD CONSTRAINT "dm_broadcast_messages_message_pk_page_dm_messages_id_fk" FOREIGN KEY ("message_pk") REFERENCES "public"."page_dm_messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dm_broadcast_messages" ADD CONSTRAINT "dm_broadcast_messages_group_id_dm_broadcast_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."dm_broadcast_groups"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dialog_reads" ADD CONSTRAINT "dialog_reads_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dialog_reads" ADD CONSTRAINT "dialog_reads_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dialog_reads" ADD CONSTRAINT "dialog_reads_conversation_id_page_dm_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."page_dm_threads"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dialog_reads" ADD CONSTRAINT "dialog_reads_last_fan_message_pk_page_dm_messages_id_fk" FOREIGN KEY ("last_fan_message_pk") REFERENCES "public"."page_dm_messages"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "fan_dossiers" ADD CONSTRAINT "fan_dossiers_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_dossiers" ADD CONSTRAINT "fan_dossiers_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_v3_job_state" ADD CONSTRAINT "workboard_v3_job_state_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "workboard_v3_fan_state_segment_idx" ON "workboard_v3_fan_state" USING btree ("platform_account_id","segment");
CREATE INDEX IF NOT EXISTS "workboard_v3_fan_state_cadence_idx" ON "workboard_v3_fan_state" USING btree ("platform_account_id","cadence_due_at");
CREATE INDEX IF NOT EXISTS "workboard_v3_shifts_page_started_idx" ON "workboard_v3_shifts" USING btree ("platform_account_id","started_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "workboard_v3_touches_page_fan_idx" ON "workboard_v3_touches" USING btree ("platform_account_id","fan_id","created_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "workboard_v3_touches_open_idx" ON "workboard_v3_touches" USING btree ("platform_account_id","confirmed_at","opened_at");
CREATE INDEX IF NOT EXISTS "workboard_v3_touches_outcome_idx" ON "workboard_v3_touches" USING btree ("platform_account_id","outcome_computed_at");
CREATE INDEX IF NOT EXISTS "workboard_v3_plan_items_shift_status_idx" ON "workboard_v3_plan_items" USING btree ("shift_id","status");
CREATE INDEX IF NOT EXISTS "workboard_v3_plan_items_fan_idx" ON "workboard_v3_plan_items" USING btree ("fan_id");
CREATE INDEX IF NOT EXISTS "dm_broadcast_groups_hash_idx" ON "dm_broadcast_groups" USING btree ("platform_account_id","content_hash","last_sent_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "dm_broadcast_messages_group_idx" ON "dm_broadcast_messages" USING btree ("group_id");
CREATE INDEX IF NOT EXISTS "dialog_reads_fan_timeline_idx" ON "dialog_reads" USING btree ("platform_account_id","fan_id","created_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "dialog_reads_conversation_idx" ON "dialog_reads" USING btree ("conversation_id","id" DESC NULLS LAST);
