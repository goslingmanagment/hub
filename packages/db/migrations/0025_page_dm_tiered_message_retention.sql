ALTER TABLE "page_dm_threads"
  DROP CONSTRAINT IF EXISTS "page_dm_threads_stored_message_count_check";

ALTER TABLE "page_dm_threads"
  ADD CONSTRAINT "page_dm_threads_stored_message_count_check"
  CHECK ("stored_message_count" BETWEEN 0 AND 500);
