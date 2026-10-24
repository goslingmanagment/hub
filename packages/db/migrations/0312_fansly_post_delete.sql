-- agency-hub:rollback-compatible — wider checks only: the previous image never writes a delete dispatch or a post_delete command, and refuses one it finds queued (its route is not in its list) before anything is sent.
-- 0312_fansly_post_delete.sql
--
-- Wall posts: the owner deletes a Fansly post Hub published (owner,
-- 2026-10-24). One more kind of a publication's dispatch, `delete` (mode
-- `delete`) — the publication's "once" for its deletion, beside its create and
-- its withdrawal — and one more write step, `post_delete`: ONE request, `POST
-- /post/<id>/delete` with no body (the contract §5,
-- docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md), sent once like
-- every write and never again after it may have gone.

set local lock_timeout = '5s';

alter table publication_dispatches drop constraint publication_dispatches_kind_check;
alter table publication_dispatches add constraint publication_dispatches_kind_check
  check (kind in ('create', 'withdraw', 'delete'));

alter table publication_dispatches drop constraint publication_dispatches_mode_check;
alter table publication_dispatches add constraint publication_dispatches_mode_check
  check (mode in ('scheduled', 'now', 'story', 'withdraw', 'delete'));

alter table fansly_write_commands drop constraint fansly_write_commands_step_check;
alter table fansly_write_commands add constraint fansly_write_commands_step_check check (step in (
  'upload_create', 'upload_part', 'upload_complete', 'upload_status',
  'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel', 'post_delete'));
