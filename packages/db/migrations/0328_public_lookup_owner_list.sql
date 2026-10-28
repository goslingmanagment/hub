-- agency-hub:rollback-compatible — widens one CHECK; the previous image never writes the new reason and reads every queue row as its owner's queue.
-- 0328_public_lookup_owner_list.sql
--
-- The public account reader's owner queue (0259) took only the legacy deleted
-- marks (`recheck-marks`). The owner now also queues a list of fans by Fansly
-- id (`sync public-lookup enqueue`, reason `owner_list`): e.g. the fans of a
-- page who neither follow nor subscribe, to tell a deleted account from one
-- that only left. The reader asks them first, in its own pace, as before.

set local lock_timeout = '5s';

alter table fansly_public_lookup_queue
  drop constraint if exists fansly_public_lookup_queue_reason_check;
alter table fansly_public_lookup_queue
  add constraint fansly_public_lookup_queue_reason_check check (reason in ('deleted_mark', 'owner_list'));

comment on table fansly_public_lookup_queue is
  'Arena R5: fans the owner asked the public reader to check once (recheck-marks: the legacy deleted marks, reason deleted_mark; enqueue: a list of Fansly ids, reason owner_list). Done when the fan has an answer newer than enqueued_at; mark_cleared = the answer found the account and the deleted mark was taken off.';
