-- No bulk rewrite: known legacy refs use material_observed_at as their clock
-- until touched. Legacy null refs remain unknown, so retained reply facts can
-- repair them without replacing a newer text/media head.
ALTER TABLE message_archive
  ADD COLUMN reply_parent_observed_at timestamptz,
  ADD COLUMN reply_root_observed_at timestamptz;
ALTER TABLE message_archive_shadow
  ADD COLUMN reply_parent_observed_at timestamptz,
  ADD COLUMN reply_root_observed_at timestamptz;
