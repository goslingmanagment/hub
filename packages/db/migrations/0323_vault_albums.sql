-- agency-hub:rollback-compatible — two nullable columns and wider checks only: the previous image never reads the columns, never writes a vault album, a `vault` dispatch or an album step, and refuses an album command it finds queued (its route is not in its list) before anything is sent.
-- 0323_vault_albums.sql
--
-- Vault albums on Fansly (owner, 2026-10-26): a Fansly page's vault album
-- made exactly as an agent lists it — new files uploaded to the vault, then
-- the album created when it does not exist yet, then every file of the list
-- added in one request, last first, so the album shows them in the list's
-- order (Fansly shows an album newest-added first; adding a file it already
-- holds moves it to the top). Captured live on the test model 2026-10-26
-- (docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md §13).
--
-- - `publications.kind` `vault_album`: its text is the album's title;
-- - `publications.vault_album_ref`: the album it fills — an existing one the
--   draft found by its title, or the one its create made (set when it went);
-- - two more write steps: `album_create` (`POST /vault/albums`) and
--   `album_media` (`POST /vault/albums/media`), and the dispatch mode `vault`;
-- - an agent key may approve publications (`approve:publications`, owner
--   2026-10-27: approval after the owner's «да» in the chat); a revision an
--   agent approved names its key beside the key's owner.

set local lock_timeout = '5s';

alter table publications drop constraint publications_kind_check;
alter table publications add constraint publications_kind_check
  check (kind in ('fyp_post', 'subscriber_post', 'paid_post', 'story', 'vault_album'));

alter table publications add column vault_album_ref text;

alter table publication_revisions add column approved_by_agent_key_id bigint references agent_keys(id) on delete restrict;

alter table publication_dispatches drop constraint publication_dispatches_mode_check;
alter table publication_dispatches add constraint publication_dispatches_mode_check
  check (mode in ('scheduled', 'now', 'story', 'withdraw', 'delete', 'vault'));

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel', 'post_delete',
  'album_create', 'album_media'));

alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications'
    ]::text[]
  );
