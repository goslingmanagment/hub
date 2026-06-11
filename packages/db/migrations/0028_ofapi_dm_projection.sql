-- OFAPI live DM projection (Phase 1 of docs/ofapi-integration-plan.md).
-- Projection bookkeeping lives on the webhook journal row, separate from the
-- settle/fanout columns: the projection never blocks or fails the settle path,
-- and the minutely sweep retries 'pending'/'failed' rows. projection_status:
-- 'none' (event type is not projected) | 'pending' | 'projected' | 'skipped' |
-- 'failed'. page_dm_messages.purchased_at records OFAPI messages.ppv.unlocked
-- for messages we hold; the (account, message) index serves the projection's
-- by-message lookups (deleted / ppv.unlocked / tips.received notifications).

ALTER TABLE "ofapi_webhook_events" ADD COLUMN IF NOT EXISTS "projection_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "ofapi_webhook_events" ADD COLUMN IF NOT EXISTS "projection_error" text;
ALTER TABLE "ofapi_webhook_events" ADD COLUMN IF NOT EXISTS "projection_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "ofapi_webhook_events" ADD COLUMN IF NOT EXISTS "projected_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "ofapi_webhook_events_projection_idx"
  ON "ofapi_webhook_events" ("projection_status", "id")
  WHERE "projection_status" in ('pending', 'failed');

ALTER TABLE "page_dm_messages" ADD COLUMN IF NOT EXISTS "purchased_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "page_dm_messages_account_message_idx"
  ON "page_dm_messages" ("platform_account_id", "platform_message_id");
