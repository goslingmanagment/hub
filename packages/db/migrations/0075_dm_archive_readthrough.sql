-- Fast-reply freshness PR4: REST-readthrough provenance on the cold archive.
-- rest_material_* record the LAST readthrough observation that materially
-- advanced a row (never fake journal ids; no FK to observations — parked/
-- tiered partitions would break it). source_journal_id drops NOT NULL:
-- REST-inserted rows have no webhook journal row (writers keep it required
-- in their webhook input types; no reader/zod/erasure consumes it; the btree
-- tolerates NULLs). Single transaction, no CONCURRENTLY (fast catalog-only
-- changes). rest_platform_changed_at is DEFERRED to Wave 2.
ALTER TABLE dm_message_archive
  ADD COLUMN rest_material_observation_id bigint,
  ADD COLUMN rest_material_observed_at timestamptz;
ALTER TABLE dm_message_archive
  ALTER COLUMN source_journal_id DROP NOT NULL;
