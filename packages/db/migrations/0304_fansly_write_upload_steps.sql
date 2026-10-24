-- agency-hub:rollback-compatible — wider checks only: the previous image never writes the new steps or items, and none is written before the stand verifies the upload routes.
-- 0304_fansly_write_upload_steps.sql
--
-- Wall posts PR 8: an upload's own requests become commands of their own, one
-- attempt each like every write. `upload_part` — one part of a file's bytes
-- PUT to the storage URL the upload's create named (item `media:<n>/part:<k>`;
-- its ETag is its result); `upload_status` — one read of the upload as Fansly
-- holds it on mediav2 until its media is parsed, and the read that reconciles
-- a completion whose answer was lost (item `media:<n>/poll:<k>`). A part is
-- sent once: a part that failed is the upload that failed.

set local lock_timeout = '5s';

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel'));

alter table fansly_write_commands drop constraint fansly_write_commands_item_check;
alter table fansly_write_commands add constraint fansly_write_commands_item_check
  check (item = '' or item ~ '^(media|preview):[0-9]+(/(part|poll):[0-9]+)?$');
