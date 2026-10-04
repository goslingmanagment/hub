-- 0241_sync_pages_drop_hold_step.sql
--
-- Fansly Sync Engine, step 4 (plan §15 row 4, owner decision №26; step 3b
-- 4-5, design S4-31): the first old hold column goes.
--
-- `sync_pages.hold_step` was the ladder step of the page-wide 429 hold
-- (5 s → 10 s → … → 300 s). A 429 has held only its route since step 3b, and
-- the hold set (`sync_holds`, 0240) keeps a ladder step per route
-- (`route_budget`) and per resource file (`resource_breaker`). The release
-- that brought the hold set names the column nowhere: no statement selects,
-- writes or returns it, the drizzle table does not map it, and `sync_pages`
-- is read and written by named columns only. So the previous image runs
-- unchanged without it — provided that image carries the hold set: an older
-- one selects the column by name, which is why this ships only after the
-- hold-set release has been deployed.
--
-- The other old hold columns stay (`hold_kind`, `hold_until`, `hold_since`,
-- `hold_detail`, `resource_holds`): the hold writers still rewrite them from
-- the page's rows, because the previous image compares them with the rows
-- when it acquires a page and lets the columns win. They go, with their
-- CHECKs, once no image that reads or writes them is a rollback target (two
-- releases after this one). `network_failure_streak` is a counter, not a
-- hold, and stays.
--
-- LOCKING: DROP COLUMN is catalog-only but takes ACCESS EXCLUSIVE on
-- sync_pages, and every actor transaction of the previous image — still
-- running while this runs — holds a row lock there. lock_timeout keeps the
-- wait brief: if the lock is not had in 5 s this aborts, the deploy fails and
-- rolls back, and the release is retried, rather than queueing every reader
-- of the table behind it (the 0124 pattern).
--
-- No down-path. The column held 0 on every page (nothing has stepped it
-- since a 429 holds its route).

set local lock_timeout = '5s';

alter table sync_pages drop column if exists hold_step;
