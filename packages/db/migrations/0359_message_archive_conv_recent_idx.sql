-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — one new index only: the previous image never names it.
-- 0359_message_archive_conv_recent_idx.sql
--
-- The AI transcript reader (listArchiveConversationMessagesForAi,
-- repositories/message-archive.ts) reads one chat's newest rows with
-- `order by occurred_at desc nulls last, id desc limit n`, on every Fansly AI
-- generation. The only index on the chat, message_archive_account_conv_idx
-- (account_id, conversation_ref, occurred_at) ASC, scanned backward gives
-- DESC NULLS FIRST, so it cannot serve that order: Postgres reads every row of
-- the chat from the heap and top-N sorts it. Prod 2026-11-07, lora-1, limit
-- 100: a 21.5k-message chat reads 10 518 buffers in 280 ms, a 38.4k-message
-- chat 19 030 buffers in 174 ms warm; the Postgres slow log has 25 runs of
-- this query over 2 s since 2026-10-26 (max 4.2 s).
--
-- This index has the ORDER BY's exact shape, so the read becomes an index scan
-- that stops at the limit, with no sort. The ASC index stays: ASC readers use
-- it (12.9 M scans). Same discipline as 0261/0268: sync writes message_archive
-- all the time (1.2 M rows, 568 MB heap), so build CONCURRENTLY outside a
-- transaction, after dropping an INVALID leftover of an interrupted attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'message_archive_account_conv_recent_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists message_archive_account_conv_recent_idx
  on message_archive (account_id, conversation_ref, occurred_at desc nulls last, id desc);
