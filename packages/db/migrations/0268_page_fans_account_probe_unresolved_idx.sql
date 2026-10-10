-- agency-hub:no-transaction
-- 0268: the Fansly public lookup reads the fans a page's lookup missed from a
-- partial index instead of scanning page_fans.
--
-- pickFanslyPublicLookupBatch (fansly-public-lookup.ts) runs for every batch
-- the sync engine's public lookup admits (~2 a minute on prod). Its
-- page_lookup_miss demand is `page_fans where account_probe_resolved is
-- false`: 51 of 71 776 rows on prod (2026-10-10), read by a sequential scan
-- of the whole table (4 199 buffers, most of what is left of a run once the
-- query says IS FALSE). This index holds just those rows, with the column the
-- demand reads, so the branch becomes an index-only scan of a few pages.
-- THE PREDICATE IS A CONTRACT WITH THE QUERY: the query must keep saying
-- `account_probe_resolved is false` (tests/fansly-public-lookup-due-list.
-- integration.test.ts pins both). Built CONCURRENTLY after dropping an
-- INVALID leftover of an interrupted attempt (the 0261 discipline).
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'page_fans_account_probe_unresolved_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists page_fans_account_probe_unresolved_idx
  on page_fans (fan_id) include (account_probe_at)
  where account_probe_resolved is false;
