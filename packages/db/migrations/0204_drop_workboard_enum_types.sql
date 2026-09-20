-- Decision 380 (follow-up to Decisions 376 and 378): drop the five orphaned
-- Workboard v2 enum types. Decision 378 dropped the eight tables, but a
-- DROP TABLE does not cascade to the enum types its columns used, so
-- `workboard_tab`, `workboard_mass_substate`, `workboard_secondary_status`,
-- `workboard_freeloader_status` and `workboard_contact_action` — all created
-- by 0019_workboard_v2.sql — stayed behind in `pg_type` with no remaining
-- user. Verified unused: 0019 is the only migration that names them, every
-- column that did use them went away with its table in 0203, and no code in
-- packages/db, apps/ or tests/ references them.
--
-- Rollback-compatible against the image this deploy replaces (58dd9bea /
-- 82571f3c): that image neither reads nor writes these types, so it runs
-- unchanged after a rollback. Listed as such in scripts/deploy-production.sh.
--
-- Not touched here: the `workboard-closing` VALUE inside the `ai_usage_feature`
-- enum (0072_ai_restricted_class.sql). Postgres cannot drop an enum value
-- without rebuilding the type, and the value is inert.
--
-- Transactional: the whole set goes or none of it does. IF EXISTS keeps the
-- migration a no-op on a database where they were already removed by hand.
DROP TYPE IF EXISTS "workboard_contact_action";
DROP TYPE IF EXISTS "workboard_freeloader_status";
DROP TYPE IF EXISTS "workboard_secondary_status";
DROP TYPE IF EXISTS "workboard_mass_substate";
DROP TYPE IF EXISTS "workboard_tab";
