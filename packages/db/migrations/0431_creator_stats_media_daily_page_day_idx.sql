-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — one new index only: the previous image never names it.
-- 0431_creator_stats_media_daily_page_day_idx.sql
--
-- The agent dataset creator_stats_media_daily (agent-dataset-map.ts) reads one
-- page's window of days; ContentOps asks for it every hour (3, 8 and 40 days).
-- Its window column was `day::timestamptz`, a STABLE cast no index can hold,
-- and the table's only index is the primary key: every read scanned the whole
-- table (prod 2026-11-18: 500k rows, 12.8k buffers, ~110–190 ms) to keep ~600.
-- The source now writes the window column as `day::timestamp at time zone
-- 'UTC'` (the same instant: the server's TimeZone is UTC), which is IMMUTABLE;
-- this index has that exact expression after the page.
--
-- Same discipline as 0359: build CONCURRENTLY outside a transaction, after
-- dropping an INVALID leftover of an interrupted attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'fansly_creator_stats_media_daily_page_day_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists fansly_creator_stats_media_daily_page_day_idx
  on fansly_creator_stats_media_daily (page_id, ((day::timestamp at time zone 'UTC')));
