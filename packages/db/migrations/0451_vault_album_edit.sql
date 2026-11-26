-- agency-hub:rollback-compatible — a wider step check, looser checks on commands without a publication, three nullable columns with their check and an index: the previous image never writes an `album_edit` command, and refuses one it finds queued (its route is not in its list) before anything is sent.
-- 0451_vault_album_edit.sql
--
-- An agent renames a Fansly vault album (its own title, not a card's name):
-- `album_edit` (`POST /vault/albums/edit`, the contract §13, live on the test
-- model 2026-11-27), a `fansly_write_commands` row without a dispatch or a
-- publication, as an agent's cancel or delete of a post (0369). It carries the
-- album, the new title and the description as Hub knew it when it was asked
-- (Fansly clears a description the request leaves out). One attempt, as every
-- write; at most one queued or sending per album of a page.

set local lock_timeout = '5s';

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel', 'post_delete',
  'album_create', 'album_media', 'album_rename', 'album_read', 'album_edit'));

alter table fansly_write_commands
  add column album_ref text,
  add column album_title text,
  add column album_description text;

alter table fansly_write_commands
  drop constraint fansly_write_commands_post_only_check,
  -- Without a publication: a cancel or a delete of its named post, or an album's new title.
  add constraint fansly_write_commands_post_only_check check (
    dispatch_id is not null
    or (step in ('post_cancel', 'post_delete') and item = '' and post_ref is not null)
    or (step = 'album_edit' and item = '' and album_ref is not null)
  ),
  add constraint fansly_write_commands_album_edit_check check (
    (step = 'album_edit') = (album_ref is not null)
    and (album_ref is null or (
      dispatch_id is null
      and album_ref ~ '^[0-9]{1,30}$'
      and album_title is not null and length(btrim(album_title)) between 1 and 120
      and album_description is not null and length(album_description) <= 2000
    ))
    and (album_ref is not null or (album_title is null and album_description is null))
  );

create unique index fansly_write_commands_album_edit_once_uidx on fansly_write_commands (page_id, album_ref)
  where step = 'album_edit' and state in ('queued', 'sending');

create index fansly_write_commands_album_edit_idx on fansly_write_commands (page_id, album_ref, id desc)
  where step = 'album_edit';
