-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — one new index only: the previous image never names it.
-- 0360_page_dm_threads_partner_idx.sql
--
-- A chat with another page of ours is no fan's (notOwnAccountChatSql,
-- repositories/shift-sql.ts): «Разбор смены» and «Смены» leave out every
-- chat whose thread's partner is one of our pages — on Fansly the page's own
-- messages of such a chat name nobody (lora-2 → lora-3 came out a fan). The
-- set of those threads is read once a query, from our pages' account ids; with
-- no index on the partner it is a scan of every thread (prod 2026-11-08: 58k
-- rows, 22–31 ms, twice a shift read, for 13 threads).
--
-- Same discipline as 0359: sync writes page_dm_threads all the time, so build
-- CONCURRENTLY outside a transaction, after dropping an INVALID leftover of an
-- interrupted attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'page_dm_threads_partner_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists page_dm_threads_partner_idx
  on page_dm_threads (partner_platform_user_id);
