-- 0088 (#138 follow-up): a successful adaptive probe (giant chat that times
-- out at limit 100 but serves limit 20) was only remembered per-run — every
-- new run re-paid 4x60s timeouts before re-probing down. The working page
-- limit becomes sticky: probe success records it here, conversation starts
-- seed from it, and clearing failure bookkeeping preserves it (incremental
-- head fetches on a giant chat need the small limit too).
ALTER TABLE "page_dm_message_sync_health"
  ADD COLUMN "preferred_page_limit" integer;
