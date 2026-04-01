CREATE TYPE "public"."dm_message_coverage_status" AS ENUM('pending_backfill', 'partial_window', 'complete');
CREATE TYPE "public"."dm_sender_role" AS ENUM('fan', 'model', 'system', 'unknown');
CREATE TYPE "public"."fan_flag" AS ENUM('whale', 'vip', 'risky');
CREATE TYPE "public"."notification_incident_kind" AS ENUM('auth_blocked', 'proxy_failed', 'stream_failed_threshold');
CREATE TYPE "public"."notification_incident_status" AS ENUM('open', 'resolved');
CREATE TYPE "public"."platform" AS ENUM('fansly', 'onlyfans');
CREATE TYPE "public"."page_sync_status" AS ENUM('idle', 'pending', 'running', 'retrying', 'blocked', 'paused');
CREATE TYPE "public"."sync_event_severity" AS ENUM('info', 'warn', 'error');
CREATE TYPE "public"."sync_http_attempt_state" AS ENUM('started', 'success', 'retry', 'failed');
CREATE TYPE "public"."sync_http_failure_kind" AS ENUM('timeout', 'transport', 'http', 'provider');
CREATE TYPE "public"."sync_request_source" AS ENUM('scheduled', 'manual', 'onboarding', 'recovery', 'anomaly', 'reset');
CREATE TYPE "public"."sync_run_outcome" AS ENUM('running', 'succeeded', 'partial', 'failed', 'skipped');
CREATE TYPE "public"."sync_stream" AS ENUM('light', 'followers', 'transactions', 'top_spenders', 'subscribers', 'dm_conversations', 'dm_messages', 'followers_reconcile');
CREATE TYPE "public"."sync_work_class" AS ENUM('live', 'history', 'maintenance');
CREATE TYPE "public"."transaction_inactive_reason" AS ENUM('missing_from_sync_window');
CREATE TYPE "public"."transaction_state" AS ENUM('pending', 'posted', 'unknown');
CREATE TYPE "public"."transaction_type" AS ENUM('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip', 'chargeback', 'refund', 'payout_reversal', 'other');
CREATE TYPE "public"."user_role" AS ENUM('owner', 'team_lead', 'chatter', 'content_manager');
CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"key_prefix" text NOT NULL,
	"token_digest" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "api_keys_key_prefix_unique" UNIQUE("key_prefix"),
	CONSTRAINT "api_keys_token_digest_unique" UNIQUE("token_digest")
);

CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" bigint,
	"target_user_id" bigint,
	"platform_account_id" bigint,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "auth_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "auth_sessions_token_digest_unique" UNIQUE("token_digest")
);

CREATE TABLE "daily_followers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"new_followers" integer DEFAULT 0 NOT NULL,
	"known_total_followers" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_followers_account_date_uniq" UNIQUE("platform_account_id","business_date")
);

CREATE TABLE "revenue_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"canonical_type" "transaction_type" NOT NULL,
	"transaction_state" "transaction_state" NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"gross_amount_mills" bigint DEFAULT 0 NOT NULL,
	"creator_net_amount_mills" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_daily_account_date_type_state_uniq" UNIQUE("platform_account_id","business_date","canonical_type","transaction_state")
);

CREATE TABLE "daily_subscribers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"new_subscribers" integer DEFAULT 0 NOT NULL,
	"active_subscribers" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_subscribers_account_date_uniq" UNIQUE("platform_account_id","business_date")
);

CREATE TABLE "egress_endpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"kind" text DEFAULT 'proxy' NOT NULL,
	"url" text NOT NULL,
	"encrypted_auth" text,
	"key_version" integer,
	"rate_limit_scope_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_endpoints_platform_account_id_unique" UNIQUE("platform_account_id")
);

CREATE TABLE "fan_flags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fan_id" bigint NOT NULL,
	"flag" "fan_flag" NOT NULL,
	"created_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_flags_fan_flag_uniq" UNIQUE("fan_id","flag")
);

CREATE TABLE "fan_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"author_user_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "page_fan_aliases" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"alias" text NOT NULL,
	"source_note_id" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "page_fan_aliases_pkey" PRIMARY KEY("platform_account_id","fan_id","alias")
);

CREATE TABLE "page_fan_external_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"provider" "platform" NOT NULL,
	"external_note_id" text NOT NULL,
	"content_type" integer,
	"title" text,
	"body" text,
	"created_at_external" timestamp with time zone,
	"updated_at_external" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "page_fan_external_notes_account_provider_external_note_uniq" UNIQUE("platform_account_id","provider","external_note_id")
);

CREATE TABLE "page_fans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"total_creator_net_mills" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_follower" boolean DEFAULT false NOT NULL,
	"follower_since" timestamp with time zone,
	"is_subscriber" boolean DEFAULT false NOT NULL,
	"subscriber_since" timestamp with time zone,
	"subscription_expires_at" timestamp with time zone,
	"auto_renew" boolean,
	"page_alias" text,
	"page_alias_source" text,
	"page_alias_source_note_id" text,
	"page_alias_synced_at" timestamp with time zone,
	"last_transaction_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_fans_fan_account_uniq" UNIQUE("fan_id","platform_account_id")
);

CREATE TABLE "fan_profiles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"created_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_profiles_fan_page_version_uniq" UNIQUE("fan_id","platform_account_id","version"),
	CONSTRAINT "fan_profiles_version_check" CHECK ("fan_profiles"."version" > 0)
);

CREATE TABLE "fan_spend_daily" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"business_date" date NOT NULL,
	"canonical_type" "transaction_type" NOT NULL,
	"transaction_state" "transaction_state" NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"gross_amount_mills" bigint DEFAULT 0 NOT NULL,
	"creator_net_amount_mills" bigint DEFAULT 0 NOT NULL,
	"last_transaction_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_spend_daily_pkey" PRIMARY KEY("platform_account_id","fan_id","business_date","canonical_type","transaction_state")
);

CREATE TABLE "fan_spend_lifetime" (
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"gross_amount_mills" bigint DEFAULT 0 NOT NULL,
	"creator_net_amount_mills" bigint DEFAULT 0 NOT NULL,
	"last_transaction_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fan_spend_lifetime_pkey" PRIMARY KEY("platform_account_id","fan_id")
);

CREATE TABLE "fan_summaries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"author_user_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "fan_username_aliases" (
	"fan_id" bigint NOT NULL,
	"username" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fan_username_aliases_pkey" PRIMARY KEY("fan_id","username")
);

CREATE TABLE "fans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_user_id" text NOT NULL,
	"username" text,
	"display_name" text,
	"created_at_external" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fans_platform_user_uniq" UNIQUE("platform","platform_user_id")
);

CREATE TABLE "models" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_slug_unique" UNIQUE("slug")
);

CREATE TABLE "notification_incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_key" text NOT NULL,
	"kind" "notification_incident_kind" NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"stream" "sync_stream",
	"status" "notification_incident_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"error_code" text,
	"error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_incidents_incident_key_unique" UNIQUE("incident_key")
);

CREATE TABLE "page_credentials" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"encrypted_session" text NOT NULL,
	"key_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_credentials_platform_account_id_unique" UNIQUE("platform_account_id")
);

CREATE TABLE "page_dm_threads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint,
	"platform_conversation_id" text NOT NULL,
	"partner_platform_user_id" text,
	"partner_username" text,
	"partner_display_name" text,
	"conversation_flags" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"subscription_tier_id" text,
	"last_message_id" text,
	"last_unread_message_id" text,
	"last_message_at" timestamp with time zone,
	"last_message_sender_id" text,
	"last_message_sender_role" "dm_sender_role" DEFAULT 'unknown' NOT NULL,
	"last_message_preview" text,
	"last_fan_message_at" timestamp with time zone,
	"last_model_message_at" timestamp with time zone,
	"stored_message_count" integer DEFAULT 0 NOT NULL,
	"newest_stored_message_id" text,
	"oldest_stored_message_id" text,
	"message_coverage_status" "dm_message_coverage_status" DEFAULT 'pending_backfill' NOT NULL,
	"message_backfill_complete" boolean DEFAULT false NOT NULL,
	"last_message_sync_at" timestamp with time zone,
	"is_visible" boolean DEFAULT true NOT NULL,
	"last_seen_generation" bigint,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_dm_threads_account_conversation_uniq" UNIQUE("platform_account_id","platform_conversation_id"),
	CONSTRAINT "page_dm_threads_stored_message_count_check" CHECK ("page_dm_threads"."stored_message_count" between 0 and 25)
);

CREATE TABLE "page_dm_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"platform_message_id" text NOT NULL,
	"sender_platform_user_id" text,
	"sender_role" "dm_sender_role" DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"total_tip_amount_cents" integer DEFAULT 0 NOT NULL,
	"in_reply_to_message_id" text,
	"in_reply_to_root_message_id" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_dm_messages_conversation_message_uniq" UNIQUE("conversation_id","platform_message_id")
);

CREATE TABLE "page_fan_identities" (
	"platform_account_id" bigint NOT NULL,
	"source_identity_key" text NOT NULL,
	"correlation_account_id" text,
	"account_id" text,
	"fan_id" bigint,
	"gross_amount_mills" bigint DEFAULT 0 NOT NULL,
	"creator_net_amount_mills" bigint DEFAULT 0 NOT NULL,
	"source_window_started_at" timestamp with time zone NOT NULL,
	"source_window_ended_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_fan_identities_pkey" PRIMARY KEY("platform_account_id","source_identity_key")
);

CREATE TABLE "page_follows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_follow_id" text NOT NULL,
	"followed_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_generation" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "page_follows_account_follow_uniq" UNIQUE("platform_account_id","platform_follow_id")
);

CREATE TABLE "page_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_subscription_id" text NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"platform_history_id" text,
	"subscription_tier_id" text,
	"subscription_tier_name" text,
	"subscription_tier_color" text,
	"plan_id" text,
	"raw_status" integer NOT NULL,
	"canonical_status" text NOT NULL,
	"price_mills" bigint NOT NULL,
	"renew_price_mills" bigint NOT NULL,
	"auto_renew" boolean,
	"billing_cycle_days" integer,
	"duration_days" integer,
	"renew_date" timestamp with time zone,
	"source_created_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"last_seen_generation" bigint,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_subscriptions_platform_subscription_id_unique" UNIQUE("platform_subscription_id")
);

CREATE TABLE "pages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"model_id" bigint NOT NULL,
	"platform" "platform" NOT NULL,
	"commission_rate" numeric(5, 4) DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"external_page_id" text,
	"username" text,
	"display_name" text,
	"follower_count" integer,
	"subscriber_count" integer,
	"egress_endpoint_id" bigint,
	"earnings_balance_mills" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_light_sync_at" timestamp with time zone,
	"last_follower_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_label_unique" UNIQUE("label"),
	CONSTRAINT "pages_platform_external_id_uniq" UNIQUE("platform","external_page_id")
);

CREATE TABLE "projection_watermarks" (
	"platform_account_id" bigint PRIMARY KEY NOT NULL,
	"last_rebuilt_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sync_rate_limits" (
	"provider" "platform" NOT NULL,
	"scope" text NOT NULL,
	"egress_key" text NOT NULL,
	"min_spacing_ms" integer NOT NULL,
	"next_available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_rate_limits_pkey" PRIMARY KEY("provider","scope","egress_key")
);

CREATE TABLE "sync_raw_payloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" bigint NOT NULL,
	"sync_run_id" bigint,
	"stream" "sync_stream",
	"request_seq" bigint,
	"source" "sync_request_source",
	"endpoint" text NOT NULL,
	"request_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb NOT NULL,
	"mapper_version" text NOT NULL,
	"payload_kind" text NOT NULL,
	"status_code" integer,
	"error_message" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL
);

CREATE TABLE "page_sync_cursors" (
	"page_id" bigint NOT NULL,
	"stream" "sync_stream" NOT NULL,
	"cursor_text" text,
	"cursor_timestamp" timestamp with time zone,
	"cursor_seq" bigint,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_succeeded_run_id" bigint,
	"last_succeeded_at" timestamp with time zone,
	CONSTRAINT "page_sync_cursors_pkey" PRIMARY KEY("page_id","stream")
);

CREATE TABLE "sync_http_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sync_run_id" bigint NOT NULL,
	"page_id" bigint NOT NULL,
	"request_seq" bigint,
	"source" "sync_request_source",
	"provider" "platform" NOT NULL,
	"stream" "sync_stream" NOT NULL,
	"operation" text NOT NULL,
	"logical_request_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" "sync_http_attempt_state" NOT NULL,
	"failure_kind" "sync_http_failure_kind",
	"http_status" integer,
	"retry_delay_ms" integer,
	"duration_ms" integer,
	"request_shape" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_shape" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);

CREATE TABLE "sync_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sync_run_id" bigint NOT NULL,
	"page_id" bigint NOT NULL,
	"request_seq" bigint,
	"source" "sync_request_source",
	"lease_token" text,
	"provider" "platform" NOT NULL,
	"stream" "sync_stream" NOT NULL,
	"event_type" text NOT NULL,
	"severity" "sync_event_severity" NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" bigint NOT NULL,
	"request_seq" bigint,
	"leased_seq" bigint,
	"source" "sync_request_source",
	"lease_token" text,
	"stream" "sync_stream" NOT NULL,
	"outcome" "sync_run_outcome" NOT NULL,
	"error_summary" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);

CREATE TABLE "page_sync_states" (
	"page_id" bigint NOT NULL,
	"stream" "sync_stream" NOT NULL,
	"status" "page_sync_status" DEFAULT 'idle' NOT NULL,
	"request_seq" bigint DEFAULT 0 NOT NULL,
	"leased_seq" bigint,
	"applied_seq" bigint DEFAULT 0 NOT NULL,
	"request_source" "sync_request_source",
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone,
	"enqueued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"progressed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"retry_kind" text,
	"retry_at" timestamp with time zone,
	"blocker_kind" text,
	"blocker_code" text,
	"blocker_message" text,
	"blocked_at" timestamp with time zone,
	"phase" text,
	"work_class" "sync_work_class",
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cadence_seconds" integer NOT NULL,
	"slot_offset_seconds" integer NOT NULL,
	"last_scheduled_slot" bigint DEFAULT -1 NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_sync_states_pkey" PRIMARY KEY("page_id","stream")
);

CREATE TABLE "telegram_delivery_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"notification_incident_id" bigint,
	"report_date" text,
	"message_id" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "telegram_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"daily_report_enabled" boolean DEFAULT true NOT NULL,
	"sync_failure_alerts_enabled" boolean DEFAULT true NOT NULL,
	"report_hour_utc" integer DEFAULT 9 NOT NULL,
	"encrypted_bot_token" text,
	"chat_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint,
	"transaction_id" text NOT NULL,
	"wallet_id" text,
	"account_id" text,
	"correlation_id" text,
	"correlation_account_id" text,
	"raw_type" text NOT NULL,
	"canonical_type" "transaction_type" NOT NULL,
	"transaction_state" "transaction_state" NOT NULL,
	"destination" integer,
	"raw_status" text NOT NULL,
	"gross_amount_mills" bigint NOT NULL,
	"source_destination_amount_mills" bigint NOT NULL,
	"creator_net_amount_mills" bigint NOT NULL,
	"raw_destination_tax" integer,
	"new_balance_mills" bigint,
	"sender_id" text,
	"receiver_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"inactive_reason" "transaction_inactive_reason",
	"inactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_account_transaction_uniq" UNIQUE("platform_account_id","transaction_id")
);

CREATE TABLE "user_page_assignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_page_assignments_user_page_uniq" UNIQUE("user_id","platform_account_id")
);

CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"role" "user_role" NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);

CREATE TABLE "workboard_snoozes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform_account_id" bigint NOT NULL,
	"fan_id" bigint NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workboard_snoozes_platform_account_id_fan_id_key" UNIQUE("platform_account_id","fan_id")
);

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "daily_followers" ADD CONSTRAINT "daily_followers_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "revenue_daily" ADD CONSTRAINT "revenue_daily_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "daily_subscribers" ADD CONSTRAINT "daily_subscribers_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "egress_endpoints" ADD CONSTRAINT "egress_endpoints_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_flags" ADD CONSTRAINT "fan_flags_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_flags" ADD CONSTRAINT "fan_flags_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "fan_notes" ADD CONSTRAINT "fan_notes_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_notes" ADD CONSTRAINT "fan_notes_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_notes" ADD CONSTRAINT "fan_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "page_fan_aliases" ADD CONSTRAINT "page_fan_aliases_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fan_aliases" ADD CONSTRAINT "page_fan_aliases_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fan_external_notes" ADD CONSTRAINT "page_fan_external_notes_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fan_external_notes" ADD CONSTRAINT "page_fan_external_notes_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fans" ADD CONSTRAINT "page_fans_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fans" ADD CONSTRAINT "page_fans_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_profiles" ADD CONSTRAINT "fan_profiles_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_profiles" ADD CONSTRAINT "fan_profiles_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_profiles" ADD CONSTRAINT "fan_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "fan_spend_daily" ADD CONSTRAINT "fan_spend_daily_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_spend_daily" ADD CONSTRAINT "fan_spend_daily_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_spend_lifetime" ADD CONSTRAINT "fan_spend_lifetime_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_spend_lifetime" ADD CONSTRAINT "fan_spend_lifetime_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_summaries" ADD CONSTRAINT "fan_summaries_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_summaries" ADD CONSTRAINT "fan_summaries_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "fan_summaries" ADD CONSTRAINT "fan_summaries_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "fan_username_aliases" ADD CONSTRAINT "fan_username_aliases_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "notification_incidents" ADD CONSTRAINT "notification_incidents_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_credentials" ADD CONSTRAINT "page_credentials_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_dm_threads" ADD CONSTRAINT "page_dm_threads_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_dm_threads" ADD CONSTRAINT "page_dm_threads_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "page_dm_messages" ADD CONSTRAINT "page_dm_messages_conversation_id_page_dm_threads_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."page_dm_threads"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_dm_messages" ADD CONSTRAINT "page_dm_messages_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fan_identities" ADD CONSTRAINT "page_fan_identities_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_fan_identities" ADD CONSTRAINT "page_fan_identities_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "page_follows" ADD CONSTRAINT "page_follows_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_follows" ADD CONSTRAINT "page_follows_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_subscriptions" ADD CONSTRAINT "page_subscriptions_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_subscriptions" ADD CONSTRAINT "page_subscriptions_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pages" ADD CONSTRAINT "pages_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "projection_watermarks" ADD CONSTRAINT "projection_watermarks_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_raw_payloads" ADD CONSTRAINT "sync_raw_payloads_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_raw_payloads" ADD CONSTRAINT "sync_raw_payloads_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "page_sync_cursors" ADD CONSTRAINT "page_sync_cursors_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_sync_cursors" ADD CONSTRAINT "page_sync_cursors_last_succeeded_run_id_sync_runs_id_fk" FOREIGN KEY ("last_succeeded_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sync_http_attempts" ADD CONSTRAINT "sync_http_attempts_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_http_attempts" ADD CONSTRAINT "sync_http_attempts_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_run_events" ADD CONSTRAINT "sync_run_events_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_run_events" ADD CONSTRAINT "sync_run_events_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "page_sync_states" ADD CONSTRAINT "page_sync_states_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "telegram_delivery_attempts" ADD CONSTRAINT "telegram_delivery_attempts_notification_incident_id_notification_incidents_id_fk" FOREIGN KEY ("notification_incident_id") REFERENCES "public"."notification_incidents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "user_page_assignments" ADD CONSTRAINT "user_page_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_page_assignments" ADD CONSTRAINT "user_page_assignments_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_snoozes" ADD CONSTRAINT "workboard_snoozes_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "workboard_snoozes" ADD CONSTRAINT "workboard_snoozes_fan_id_fans_id_fk" FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_user_id","created_at");
CREATE INDEX "audit_events_page_idx" ON "audit_events" USING btree ("platform_account_id","created_at");
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
CREATE INDEX "auth_sessions_expiry_idx" ON "auth_sessions" USING btree ("expires_at");
CREATE INDEX "revenue_daily_account_date_idx" ON "revenue_daily" USING btree ("platform_account_id","business_date");
CREATE INDEX "fan_flags_fan_idx" ON "fan_flags" USING btree ("fan_id","created_at");
CREATE INDEX "fan_notes_fan_page_idx" ON "fan_notes" USING btree ("fan_id","platform_account_id","created_at");
CREATE INDEX "page_fan_aliases_platform_account_alias_idx" ON "page_fan_aliases" USING btree ("platform_account_id","alias");
CREATE INDEX "page_fan_aliases_fan_idx" ON "page_fan_aliases" USING btree ("fan_id");
CREATE INDEX "page_fan_external_notes_page_fan_provider_idx" ON "page_fan_external_notes" USING btree ("platform_account_id","fan_id","provider");
CREATE INDEX "page_fan_external_notes_page_fan_provider_active_idx" ON "page_fan_external_notes" USING btree ("platform_account_id","fan_id","provider","is_active");
CREATE INDEX "page_fans_platform_account_idx" ON "page_fans" USING btree ("platform_account_id");
CREATE INDEX "page_fans_platform_account_alias_idx" ON "page_fans" USING btree ("platform_account_id","page_alias");
CREATE INDEX "fan_profiles_latest_idx" ON "fan_profiles" USING btree ("platform_account_id","fan_id","version" DESC NULLS LAST);
CREATE INDEX "fan_profiles_history_idx" ON "fan_profiles" USING btree ("fan_id","platform_account_id","created_at" DESC NULLS LAST);
CREATE INDEX "fan_spend_daily_account_date_fan_idx" ON "fan_spend_daily" USING btree ("platform_account_id","business_date","fan_id");
CREATE INDEX "fan_spend_daily_fan_account_date_idx" ON "fan_spend_daily" USING btree ("fan_id","platform_account_id","business_date");
CREATE INDEX "fan_spend_lifetime_fan_account_idx" ON "fan_spend_lifetime" USING btree ("fan_id","platform_account_id");
CREATE INDEX "fan_summaries_fan_page_idx" ON "fan_summaries" USING btree ("fan_id","platform_account_id","created_at");
CREATE INDEX "fan_username_aliases_username_idx" ON "fan_username_aliases" USING btree ("username");
CREATE INDEX "notification_incidents_account_status_idx" ON "notification_incidents" USING btree ("platform_account_id","status");
CREATE INDEX "notification_incidents_status_seen_idx" ON "notification_incidents" USING btree ("status","last_seen_at");
CREATE INDEX "page_dm_threads_account_fan_idx" ON "page_dm_threads" USING btree ("platform_account_id","fan_id");
CREATE INDEX "page_dm_threads_visible_message_idx" ON "page_dm_threads" USING btree ("platform_account_id","is_visible","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE INDEX "page_dm_threads_visible_unread_idx" ON "page_dm_threads" USING btree ("platform_account_id","is_visible","unread_count" DESC NULLS LAST,"last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE INDEX "page_dm_threads_backfill_idx" ON "page_dm_threads" USING btree ("platform_account_id","is_visible","message_coverage_status","last_message_sync_at");
CREATE INDEX "page_dm_threads_generation_idx" ON "page_dm_threads" USING btree ("platform_account_id","last_seen_generation");
CREATE INDEX "page_dm_messages_conversation_created_idx" ON "page_dm_messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE INDEX "page_dm_messages_account_conversation_created_idx" ON "page_dm_messages" USING btree ("platform_account_id","conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
CREATE INDEX "page_fan_identities_fan_account_idx" ON "page_fan_identities" USING btree ("fan_id","platform_account_id");
CREATE INDEX "page_follows_fan_idx" ON "page_follows" USING btree ("fan_id");
CREATE INDEX "page_follows_generation_idx" ON "page_follows" USING btree ("platform_account_id","last_seen_generation");
CREATE INDEX "page_follows_active_followed_idx" ON "page_follows" USING btree ("platform_account_id","is_active","followed_at","id");
CREATE INDEX "page_subscriptions_account_idx" ON "page_subscriptions" USING btree ("platform_account_id","ends_at");
CREATE INDEX "page_subscriptions_generation_idx" ON "page_subscriptions" USING btree ("platform_account_id","last_seen_generation");
CREATE INDEX "page_subscriptions_current_idx" ON "page_subscriptions" USING btree ("platform_account_id","is_current","ends_at","id");
CREATE INDEX "pages_model_idx" ON "pages" USING btree ("model_id");
CREATE INDEX "sync_raw_payloads_retain_idx" ON "sync_raw_payloads" USING btree ("retain_until");
CREATE INDEX "sync_http_attempts_run_started_idx" ON "sync_http_attempts" USING btree ("sync_run_id","started_at");
CREATE INDEX "sync_http_attempts_logical_idx" ON "sync_http_attempts" USING btree ("sync_run_id","logical_request_id","attempt_number");
CREATE INDEX "sync_http_attempts_retention_idx" ON "sync_http_attempts" USING btree ("started_at");
CREATE INDEX "sync_run_events_run_emitted_idx" ON "sync_run_events" USING btree ("sync_run_id","emitted_at");
CREATE INDEX "sync_run_events_emitted_idx" ON "sync_run_events" USING btree ("emitted_at");
CREATE INDEX "sync_runs_page_stream_idx" ON "sync_runs" USING btree ("page_id","stream","started_at");
CREATE INDEX "page_sync_states_freshness_idx" ON "page_sync_states" USING btree ("stream","succeeded_at");
CREATE INDEX "page_sync_states_lease_idx" ON "page_sync_states" USING btree ("status","lease_expires_at");
CREATE INDEX "page_sync_states_runnable_idx" ON "page_sync_states" USING btree ("status","retry_at","page_id","stream");
CREATE INDEX "page_sync_states_schedule_idx" ON "page_sync_states" USING btree ("status","last_scheduled_slot","page_id","stream");
CREATE INDEX "telegram_delivery_attempts_kind_created_idx" ON "telegram_delivery_attempts" USING btree ("kind","created_at");
CREATE INDEX "transactions_pending_boundary_idx" ON "transactions" USING btree ("platform_account_id","transaction_state","occurred_at");
CREATE INDEX "transactions_account_occurred_idx" ON "transactions" USING btree ("platform_account_id","occurred_at");
CREATE INDEX "transactions_account_active_occurred_idx" ON "transactions" USING btree ("platform_account_id","is_active","occurred_at");
CREATE INDEX "transactions_fan_idx" ON "transactions" USING btree ("fan_id");
CREATE INDEX "user_page_assignments_page_idx" ON "user_page_assignments" USING btree ("platform_account_id");
CREATE INDEX "workboard_snoozes_lookup_idx" ON "workboard_snoozes" USING btree ("platform_account_id","fan_id","snoozed_until");
