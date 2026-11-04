-- agency-hub:rollback-compatible — wider checks only: the previous image never writes an `album_read` step.
-- 0352_vault_album_read.sql
--
-- A vault album read back before it is called published (audit, 2026-11-04):
-- once its media are added, its head is read (`GET /media/vaultnew`, the
-- read the catalog walk already sends through the page's browser), one page a
-- command — `album_read`, item `read:N` — until it shows as many cards as were
-- added. The cards are renamed by the names that read shows, and the album's
-- files, their order and names are compared with the approval.

set local lock_timeout = '5s';

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel', 'post_delete',
  'album_create', 'album_media', 'album_rename', 'album_read'));

alter table fansly_write_commands drop constraint fansly_write_commands_item_check;
alter table fansly_write_commands add constraint fansly_write_commands_item_check
  check (item = ''
    or item ~ '^(media|preview):[0-9]+(/(part|poll):[0-9]+)?$'
    or item ~ '^(media|preview):[0-9]+/part:[0-9]+/try:[23]$'
    or item ~ '^attachment:[1-9]$'
    or item ~ '^read:[0-9]+$');
