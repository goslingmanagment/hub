-- agency-hub:rollback-compatible — one new index: the previous image never names it.
-- 0348_dm_live_sender_deleted.sql
--
-- The fan's deleted messages of a page (`clientDeletedMessages`,
-- deleted-messages-v1): the chat extension shows them in the Fansly chat
-- header (owner, 2026-11-03). A partial index over the deleted rows only
-- (about 1 500 of 115 000 on 2026-11-03), by page and sender: one fan's read
-- touches their own deleted messages, not the page's whole overlay.

set local lock_timeout = '5s';

create index if not exists dm_live_messages_sender_deleted
  on dm_live_messages (page_id, sender_platform_user_id, deleted_at desc)
  where deleted_at is not null;
