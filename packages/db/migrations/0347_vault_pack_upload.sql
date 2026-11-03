-- agency-hub:rollback-compatible — wider checks only: the previous image never writes an `album_rename` step or a part's later try, and refuses an album rename it finds queued (its route is not in its list) before anything is sent.
-- 0347_vault_pack_upload.sql
--
-- Vault packs (owner, 2026-11-03): ~85 files / 4.5 GB into one vault album in
-- about a quarter of an hour, unattended after approval.
--
-- - A part of an upload whose PUT ended unknown (a network error, a proxy
--   hiccup) is sent again — the same presigned URL, the same bytes: S3 keeps
--   the last PUT of a part — up to three tries. A later try is its own
--   command, `media:N/part:K/try:T` (T = 2, 3), beside the first `media:N/part:K`.
-- - `album_rename` (`POST /vault/albums/media/rename`): a card of the album
--   renamed to its file's name, one command per file (`media:N`) — a file
--   Fansly already had comes back as its old media, under its old name.

set local lock_timeout = '5s';

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel', 'post_delete',
  'album_create', 'album_media', 'album_rename'));

alter table fansly_write_commands drop constraint fansly_write_commands_item_check;
alter table fansly_write_commands add constraint fansly_write_commands_item_check
  check (item = ''
    or item ~ '^(media|preview):[0-9]+(/(part|poll):[0-9]+)?$'
    or item ~ '^(media|preview):[0-9]+/part:[0-9]+/try:[23]$'
    or item ~ '^attachment:[1-9]$');
