-- A2a unstick (decision #135): drop the 0026 upper bound on
-- page_dm_threads.stored_message_count. Stage 1's prune stand-down
-- (PAGE_DM_PRUNE_ENABLED=false) made stored DM history nondecreasing, so any
-- active conversation eventually crosses 1000 and the finalize recount
-- (23514) wedges the page's whole dm_messages stream — lora-1/lora-2 were
-- down 05..11.07 this way. The retention cap is selection policy in code;
-- the DB keeps only the integrity floor. A bounded upper guard returns with
-- the prune-as-cache protocol (Stage 28 / plan step C3), not before.
ALTER TABLE "page_dm_threads"
  DROP CONSTRAINT IF EXISTS "page_dm_threads_stored_message_count_check";

ALTER TABLE "page_dm_threads"
  ADD CONSTRAINT "page_dm_threads_stored_message_count_check"
  CHECK ("stored_message_count" >= 0);
