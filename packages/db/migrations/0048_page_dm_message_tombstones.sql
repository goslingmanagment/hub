ALTER TABLE "page_dm_messages"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
