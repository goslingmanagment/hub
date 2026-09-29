-- media_stats: the queue row's own evidence that a post or the account
-- statistics showed the media. The media plane queues a media item only from
-- those origins, and a media first seen in a DM keeps first_origin =
-- 'dm_sidecar' for good. Without this column, the DM-only queue repair
-- (fansly:media-stats-prune-dm-only) had to find the post in creator_posts,
-- which another projector writes, possibly later than the media plane queued
-- the row. The enqueue now stamps the row in the same statement, so the repair
-- keeps what the enqueue queued. Nullable, no default: existing rows start
-- unproven (null), and the repair's other evidence covers them.
ALTER TABLE subject_refresh_state
  ADD COLUMN media_shown_outside_dm_at timestamptz;

COMMENT ON COLUMN subject_refresh_state.media_shown_outside_dm_at IS
  'media_stats only: the earliest observation from a post or the account statistics that queued or re-confirmed this row; null for rows queued before 0222 and for rows the first-enable seed queued.';
