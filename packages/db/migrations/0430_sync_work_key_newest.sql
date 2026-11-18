-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — one new index only: the previous image never names it.
-- 0430_sync_work_key_newest.sql
--
-- The last applied time of a key that works per subject
-- (lastLiveAppliedAtOverSubjects, repositories/sync/work.ts) reads the key's
-- 20 newest rows on a page, whatever their subject — for the Settings blocks
-- and the matters mirror, six pages a minute. The only index on the key,
-- sync_work_key_recent (page_id, resource, subject, id desc), orders by the
-- subject first, so "the key's newest ids" is a scan of the whole key and a
-- top-N sort: prod 2026-11-18, 7.77 ms and 1 917 buffers a call, 2 629 rows
-- read per key to keep 20 (dm-messages.head has ≈ 12k rows a page).
--
-- This index has the read's exact shape, so it stops at the limit, with no
-- sort. sync_work_key_recent stays: the breaker carry-forward and the status
-- of closed work read it by subject. Same discipline as 0359/0360: the engine
-- writes sync_work all the time, so build CONCURRENTLY outside a transaction,
-- after dropping an INVALID leftover of an interrupted attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'sync_work_key_newest'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_work_key_newest
  on sync_work (page_id, resource, id desc);
