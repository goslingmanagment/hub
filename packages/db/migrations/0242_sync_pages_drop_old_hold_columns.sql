-- 0242_sync_pages_drop_old_hold_columns.sql
--
-- Fansly Sync Engine, step 4 (plan §15 row 4, owner decision №26; step 3b
-- 4-5, S4-33): the old hold columns of the page row go. The last of the
-- three releases that take them away.
--
-- Until the hold set (`sync_holds`, 0240) a page's holds lived in its row of
-- `sync_pages`: one hold slot — `hold_kind`, `hold_until`, `hold_since`,
-- `hold_detail` (a second hold carried inside the detail), and the ladder
-- step 0241 dropped — under two CHECKs (`sync_pages_hold_kind_check`,
-- `sync_pages_hold_pair_check`), and `resource_holds`: the breakers by
-- resource file, with the routes' state under its `route:state` key. A
-- page's holds are its rows of `sync_holds` now. This drops what was left of
-- the old store: the five columns and the two CHECKs.
--
-- The three releases, each a safe rollback target of the next:
--   S4-31  nothing reads the columns back; every hold write still rewrites
--          them from the rows (for the hold-set release, which lets the
--          columns win over the rows);
--   S4-32  the rewrite is gone: no statement selects, writes or returns the
--          columns, the drizzle table does not map them, and `sync_pages` is
--          read and written by named columns only, never by `*`. They are
--          stale from that deploy on;
--   S4-33  this migration.
-- So the image before this one runs unchanged without the columns — provided
-- it is the S4-32 image. The one before THAT ends every hold write by
-- rewriting the five columns, and would fail each of them here: this ships
-- only after the S4-32 release has been deployed and has run, never in the
-- deploy that brings it.
--
-- Nothing else of the page row goes. `network_failure_streak` is a counter,
-- not a hold: the build reads and writes it, and it stays.
--
-- Nothing but the column defaults and the two CHECKs depends on the columns
-- (no index, view, trigger, function or column grant names one): no CASCADE.
-- The CHECKs are dropped by name, first; dropping the columns would take
-- them along. IF EXISTS throughout: applying it twice changes nothing.
--
-- LOCKING: one ALTER TABLE, catalog-only (no rewrite, no scan), but it takes
-- ACCESS EXCLUSIVE on sync_pages, and every actor transaction of the previous
-- image — still running while this runs — holds a row lock there.
-- lock_timeout keeps the wait brief: if the lock is not had in 5 s this
-- aborts, the deploy fails and rolls back, and the release is retried, rather
-- than queueing every reader of the table behind it (the 0124 pattern, as
-- 0241).
--
-- No down-path. What the columns said was history: each page's holds as the
-- last release that wrote them left them.

set local lock_timeout = '5s';

alter table sync_pages
  drop constraint if exists sync_pages_hold_pair_check,
  drop constraint if exists sync_pages_hold_kind_check,
  drop column if exists hold_kind,
  drop column if exists hold_until,
  drop column if exists hold_since,
  drop column if exists hold_detail,
  drop column if exists resource_holds;
