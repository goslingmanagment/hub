ALTER TABLE "fans"
  ADD COLUMN "deleted_detected_at" timestamp with time zone,
  ADD COLUMN "deleted_last_detected_at" timestamp with time zone;

UPDATE "fans" f
SET "deleted_detected_at" = COALESCE(f."last_seen_at", now()),
    "deleted_last_detected_at" = COALESCE(f."last_seen_at", now())
WHERE f."deleted_detected_at" IS NULL
  AND f."platform" = 'fansly'
  AND NULLIF(btrim(COALESCE(f."username", '')), '') IS NULL
  AND NULLIF(btrim(COALESCE(f."display_name", '')), '') IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "page_fans" pf
    WHERE pf."fan_id" = f."id"
      AND NULLIF(btrim(COALESCE(pf."page_alias", '')), '') IS NOT NULL
  );

CREATE INDEX "fans_deleted_detected_idx"
  ON "fans" ("platform", "deleted_detected_at");
