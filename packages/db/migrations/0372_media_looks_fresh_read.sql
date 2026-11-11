-- agency-hub:rollback-compatible — looser NOT NULLs, wider checks, one more nullable column and a rebuilt partial index on a table only media looks use: the previous image writes none of the new values and reads the rows as it did.
-- 0372_media_looks_fresh_read.sql
--
-- Media looks, second slice (owner 2026-11-11): a look at a PUBLISHED post or
-- a VAULT file. Their signed locations are not in any verbatim journal, so the
-- page's engine first reads the post (`posts.by_ids`) or the file's vault page
-- (`vault.media`) — `media-look.resolve`, one API read at the page's pace —
-- picks the image from that answer in memory, and hands it, sealed, to the
-- look's image request (`media-look.fetch`). Until that read answers, the look
-- does not know which file a post's index names, or what it fetches.
--
--   status 'resolving'   the engine's read of the post or the vault page is
--                        queued; then 'queued' for the image, as before
--   source_kind          + 'post_read' (a published post), 'vault_read' (a vault file)
--   post_ref, attachment_index   null for a vault file
--   media_ref, media_type, variant   null until the read answered
--   vault_album_ref      the vault album the file's read pages through (a vault file)
--
-- No URL is stored here either: the read's apply seals it into the image
-- work's secret parameters (`sync_work.secret_params`, nulled when it closes).

set local lock_timeout = '5s';

alter table media_looks
  alter column post_ref drop not null,
  alter column attachment_index drop not null,
  alter column media_ref drop not null,
  alter column media_type drop not null,
  alter column variant drop not null,
  add column if not exists vault_album_ref text;

alter table media_looks
  drop constraint media_looks_status_check,
  add constraint media_looks_status_check check (
    status in ('resolving', 'queued', 'fetched', 'ready', 'failed', 'expired')
  ),
  drop constraint media_looks_source_kind_check,
  add constraint media_looks_source_kind_check check (source_kind in ('schedule_read', 'post_read', 'vault_read')),
  -- Known once the read answered: only a look still resolving, or one that
  -- failed before it knew its file, goes without them.
  add constraint media_looks_resolved_check check (
    status in ('resolving', 'failed') or (media_ref is not null and media_type is not null and variant is not null)
  ),
  -- A post's file names its post and index; a vault file its album.
  add constraint media_looks_target_check check (
    (source_kind = 'vault_read' and post_ref is null and attachment_index is null and media_ref is not null and vault_album_ref is not null)
    or (source_kind <> 'vault_read' and post_ref is not null and attachment_index is not null and vault_album_ref is null)
  ),
  add constraint media_looks_vault_album_check check (vault_album_ref is null or vault_album_ref ~ '^[0-9]{1,24}$');

-- One look in flight per page, the read's phase included.
drop index if exists media_looks_one_in_flight;
create unique index media_looks_one_in_flight on media_looks (page_id) where status in ('resolving', 'queued', 'fetched');

comment on column media_looks.vault_album_ref is 'The vault album a vault file''s read pages through (vault.media), or null.';
