-- OFAPI (onlyfansapi.com) webhook receiver + SSE fanout (ChatMuse real-time track).
-- pages.ofapi_account_id maps the webhook envelope's "acct_…" id to a core page;
-- ofapi_webhook_config holds the singleton registration (signing secret encrypted,
-- previous secret kept for a rotation grace window); ofapi_webhook_events journals
-- deliveries, deduped by the x-ofapi-idempotency-key header. fanout_seq is assigned
-- in settle order (not receive order) and backs Last-Event-ID replay for
-- GET /api/v1/events/stream — late settles (pg-boss retries, sweep) would otherwise
-- be invisible to cursors that already advanced past their receive-time id.
-- See docs/decisions.md #48.

ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "ofapi_account_id" text;
ALTER TABLE "pages" ADD CONSTRAINT "pages_ofapi_account_uniq" UNIQUE("ofapi_account_id");

CREATE TABLE IF NOT EXISTS "ofapi_webhook_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"external_webhook_id" text,
	"endpoint_url" text NOT NULL,
	"account_scope" text DEFAULT 'global' NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_signing_secret" text NOT NULL,
	"previous_encrypted_signing_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS "ofapi_webhook_events_fanout_seq";

CREATE TABLE IF NOT EXISTS "ofapi_webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"ofapi_account_id" text,
	"platform_account_id" bigint,
	"payload" jsonb NOT NULL,
	"sync_event" jsonb,
	"fanout_seq" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "ofapi_webhook_events_idempotency_uniq" UNIQUE("idempotency_key")
);

ALTER TABLE "ofapi_webhook_events" ADD CONSTRAINT "ofapi_webhook_events_platform_account_id_pages_id_fk" FOREIGN KEY ("platform_account_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "ofapi_webhook_events_received_idx" ON "ofapi_webhook_events" USING btree ("received_at");
CREATE INDEX IF NOT EXISTS "ofapi_webhook_events_status_idx" ON "ofapi_webhook_events" USING btree ("status","id");
CREATE UNIQUE INDEX IF NOT EXISTS "ofapi_webhook_events_fanout_seq_uniq" ON "ofapi_webhook_events" USING btree ("fanout_seq") WHERE "fanout_seq" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ofapi_webhook_events_replay_idx" ON "ofapi_webhook_events" USING btree ("platform_account_id","fanout_seq") WHERE "fanout_seq" IS NOT NULL;
