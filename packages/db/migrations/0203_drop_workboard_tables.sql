-- Decision 378 (follow-up to Decision 376): drop the eight orphaned Workboard
-- v2 tables. Decision 376 removed the in-core module, its queues and its
-- schedules but deliberately left the tables behind, because a DROP shipped in
-- that same change would not have been rollback-compatible: the image it
-- replaced still wrote `workboard_state`. Since 301a127a no image on
-- production reads or writes any of these tables, so the drop is now
-- rollback-compatible and is listed as such in scripts/deploy-production.sh.
--
-- Every one of these tables is a rebuildable projection or a classifier
-- bookkeeping row. The facts they were derived from live in `observations`
-- and in the platform projections (page_fans, page_dm_threads, fans) and are
-- untouched here. At drop time `workboard_state` held ~67k rows (42 MB) and
-- the other seven were empty on production.
--
-- Transactional: the whole set goes or none of it does. Dropped child-first so
-- no FK to pages/fans/models/users has to be resolved by CASCADE.
DROP TABLE IF EXISTS "wb_classifier_runs";
DROP TABLE IF EXISTS "wb_llm_usage_daily";
DROP TABLE IF EXISTS "wb_closing_cache";
DROP TABLE IF EXISTS "wb_closing_settings";
DROP TABLE IF EXISTS "workboard_claim_leases";
DROP TABLE IF EXISTS "workboard_snoozes";
DROP TABLE IF EXISTS "workboard_contact_log";
DROP TABLE IF EXISTS "workboard_state";
