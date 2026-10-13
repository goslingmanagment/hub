-- 0270_message_archive_fansly_markers.sql
--
-- R20 HF-7д0 (chat-extension, Project Unite): Fansly's automation markers of
-- a message, kept in the archive with a presence flag, for the transcript's
-- `[Automatic / mass message]` label. HF-7д will read them; nothing reads
-- them yet.
--
--   message_type       vendor `type` (2 = the page's mass message, 1 = an
--                      ordinary one); null when not observed or not an int4.
--   correlation_id     vendor `correlationId`, a native id ('0' = none);
--                      null when not observed or not a native id.
--   marker_field_mask  which of the two any applied material head carried,
--                      in the live overlay's bits (type 16, correlationId 32:
--                      dm_live_messages.field_mask). Null = no head carrying
--                      them has reached the row: UNKNOWN, not "no marker".
--
-- Writer: the archive projection's material-head upsert
-- (applyMessageEventsToArchive), from the Fansly sync-pull sidecar head. A
-- head that does not carry a marker leaves its value and bit as they are.
-- No backfill: rows projected before this stay unknown until their message is
-- observed again (or a later replay of the journal re-emits their heads).
--
-- message_archive_shadow gets the same columns: the W10 rebuild writes the
-- shadow through the same upsert and then renames it onto message_archive.
--
-- LOCKING: three nullable columns without a default on each table: catalog
-- only, no rewrite, no scan, no index, no validation. ADD COLUMN still takes
-- ACCESS EXCLUSIVE for the catalog change (message_archive ≈ 890k rows,
-- 756 MB on 2026-10-13; the shadow is empty between rebuilds), and a waiting
-- ALTER queues every later reader behind it. lock_timeout keeps that wait
-- brief: if the lock is not had in 5 s the migration aborts and the deploy
-- rolls back.
--
-- Rollback-compatible: the previous image names its columns in every insert,
-- update and copy of these tables, and its `select ma.*` readers map named
-- fields only, so it runs unchanged beside the three columns.

set local lock_timeout = '5s';

alter table message_archive
  add column if not exists message_type integer,
  add column if not exists correlation_id text,
  add column if not exists marker_field_mask integer;

alter table message_archive_shadow
  add column if not exists message_type integer,
  add column if not exists correlation_id text,
  add column if not exists marker_field_mask integer;

comment on column message_archive.message_type is
  'Fansly message `type` as observed (2 = the page''s mass message). Null = not observed or unusable; read marker_field_mask for which.';
comment on column message_archive.correlation_id is
  'Fansly message `correlationId` as observed (''0'' = none). Null = not observed or unusable; read marker_field_mask for which.';
comment on column message_archive.marker_field_mask is
  'Which automation markers a material head carried: 16 = type, 32 = correlationId (dm_live_messages.field_mask bits). Null = unknown.';
