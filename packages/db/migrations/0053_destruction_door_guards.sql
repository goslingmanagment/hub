-- Stage 2 (kernel destruction-door guards): hard-deletes become markers.
-- All columns nullable/additive; NULL = active row. No FK changes here — the
-- 38 pages.id CASCADE FKs stay until Stage 13's soft-delete standard.

-- Interim tombstone substrate for admin page deletion (Stage 13 formalizes
-- status and flips the FKs to RESTRICT; nothing writes this column yet).
ALTER TABLE "pages"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- Workboard undo writes a retraction marker instead of deleting the row.
ALTER TABLE "workboard_contact_log"
  ADD COLUMN IF NOT EXISTS "retracted_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "workboard_contact_log_active_idx"
  ON "workboard_contact_log" ("platform_account_id", "fan_id")
  WHERE "retracted_at" IS NULL;

-- Reclassify soft-supersedes verdicts instead of wholesale delete. The spec's
-- "keep prior rows + new run writes fresh rows" requires the (page, message)
-- uniqueness to apply to ACTIVE rows only, so the full unique constraint
-- becomes a partial unique index on superseded_at IS NULL.
ALTER TABLE "wb_closing_cache"
  ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
ALTER TABLE "wb_closing_cache"
  DROP CONSTRAINT IF EXISTS "wb_closing_cache_message_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "wb_closing_cache_message_active_uniq"
  ON "wb_closing_cache" ("platform_account_id", "platform_message_id")
  WHERE "superseded_at" IS NULL;
