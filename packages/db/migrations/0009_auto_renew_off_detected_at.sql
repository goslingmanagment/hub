ALTER TABLE "page_fans"
  ADD COLUMN IF NOT EXISTS "auto_renew_off_detected_at" timestamp with time zone;

ALTER TABLE "page_subscriptions"
  ADD COLUMN IF NOT EXISTS "auto_renew_off_detected_at" timestamp with time zone;

UPDATE "page_fans"
SET "auto_renew_off_detected_at" = COALESCE("last_seen_at", now())
WHERE "auto_renew" = false
  AND "auto_renew_off_detected_at" IS NULL;

UPDATE "page_subscriptions"
SET "auto_renew_off_detected_at" = COALESCE("last_seen_at", now())
WHERE "auto_renew" = false
  AND "auto_renew_off_detected_at" IS NULL;
