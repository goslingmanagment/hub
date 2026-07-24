-- Stage 1A of the family-wide error-handling overhaul is expand-only:
-- nullable ledger detail, reader-first incident kinds, a default-off critical
-- paging switch, and durable delivery infrastructure. No existing row is
-- backfilled and no producer is activated by this migration.

ALTER TABLE "ai_usage_events"
  ADD COLUMN "error_code" text,
  ADD COLUMN "failure_phase" text,
  ADD COLUMN "provider_http_status" integer;

CREATE INDEX "ai_usage_events_failure_reason_window_idx"
  ON "ai_usage_events" ("provider", "error_code", "completed_at" DESC)
  WHERE "gateway_outcome" = 'failed';

ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'ai_provider_billing';

ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'ai_provider_failed';

ALTER TABLE "telegram_settings"
  ADD COLUMN "ai_critical_alerts_enabled" boolean DEFAULT false NOT NULL;

CREATE TABLE "notification_delivery_outbox" (
  "id" bigserial PRIMARY KEY,
  "notification_incident_id" bigint NOT NULL
    REFERENCES "notification_incidents"("id") ON DELETE RESTRICT,
  "transition" text NOT NULL,
  "transition_at" timestamptz NOT NULL,
  "channel" text NOT NULL,
  "paging_policy" text NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "message_text" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "lease_token" text,
  "lease_expires_at" timestamptz,
  "last_error" text,
  "suppression_reason" text,
  "delivered_at" timestamptz,
  "exhausted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notification_delivery_outbox_transition_check"
    CHECK ("transition" IN ('opened', 'reopened', 'resolved')),
  CONSTRAINT "notification_delivery_outbox_channel_check"
    CHECK ("channel" IN ('telegram')),
  CONSTRAINT "notification_delivery_outbox_paging_policy_check"
    CHECK ("paging_policy" IN ('sync_failure', 'ai_critical')),
  CONSTRAINT "notification_delivery_outbox_state_check"
    CHECK ("state" IN ('pending', 'leased', 'delivered', 'suppressed', 'exhausted')),
  CONSTRAINT "notification_delivery_outbox_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "notification_delivery_outbox_max_attempts_check"
    CHECK ("max_attempts" > 0),
  CONSTRAINT "notification_delivery_outbox_transition_channel_uniq"
    UNIQUE ("notification_incident_id", "transition", "transition_at", "channel")
);

CREATE INDEX "notification_delivery_outbox_ready_idx"
  ON "notification_delivery_outbox" ("available_at", "created_at")
  WHERE "state" = 'pending';

CREATE INDEX "notification_delivery_outbox_expired_lease_idx"
  ON "notification_delivery_outbox" ("lease_expires_at")
  WHERE "state" = 'leased';

CREATE INDEX "notification_delivery_outbox_incident_idx"
  ON "notification_delivery_outbox" ("notification_incident_id", "created_at" DESC);
