-- Reverse of packages/db/migrations/0068_platforms_reference.sql.
-- Passport rule: rehearse 0068 AND this file on a staging copy before prod.
-- (Cannot live in packages/db/migrations/ — the runner pattern-matches every
-- .sql file there and would try to apply it.)
--
-- Rehearsed locally 2026-07-06 on postgres:16 (apply 0068 → this file →
-- re-apply 0068 body): both directions clean, see stage-18 Progress notes.

BEGIN;

CREATE TYPE platform AS ENUM ('fansly', 'onlyfans');

ALTER TABLE pages DROP CONSTRAINT pages_platform_fk;
ALTER TABLE pages ALTER COLUMN platform TYPE platform USING platform::platform;

ALTER TABLE sync_http_attempts DROP CONSTRAINT sync_http_attempts_provider_fk;
ALTER TABLE sync_http_attempts ALTER COLUMN provider TYPE platform USING provider::platform;

ALTER TABLE sync_run_events DROP CONSTRAINT sync_run_events_provider_fk;
ALTER TABLE sync_run_events ALTER COLUMN provider TYPE platform USING provider::platform;

ALTER TABLE sync_rate_limits DROP CONSTRAINT sync_rate_limits_provider_fk;
ALTER TABLE sync_rate_limits ALTER COLUMN provider TYPE platform USING provider::platform;

ALTER TABLE fans DROP CONSTRAINT fans_platform_fk;
ALTER TABLE fans ALTER COLUMN platform TYPE platform USING platform::platform;

ALTER TABLE page_fan_external_notes DROP CONSTRAINT page_fan_external_notes_provider_fk;
ALTER TABLE page_fan_external_notes ALTER COLUMN provider TYPE platform USING provider::platform;

ALTER TABLE dm_message_archive DROP CONSTRAINT dm_message_archive_platform_fk;
ALTER TABLE dm_message_archive ALTER COLUMN platform TYPE platform USING platform::platform;

DROP TABLE platforms;

-- NOTE: also delete the 0068 row from the migrations journal table if you
-- intend to re-apply it later via the runner.

COMMIT;
