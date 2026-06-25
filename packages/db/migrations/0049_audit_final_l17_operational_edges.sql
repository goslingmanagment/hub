-- Audit-final L17 operational hardening.

ALTER TABLE "ofapi_spend_projection_events"
  DROP CONSTRAINT IF EXISTS "ofapi_spend_projection_events_page_id_pages_id_fk";

ALTER TABLE "ofapi_spend_projection_events"
  ALTER COLUMN "page_id" DROP NOT NULL;

ALTER TABLE "ofapi_spend_projection_events"
  ADD CONSTRAINT "ofapi_spend_projection_events_page_id_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE SET NULL;
