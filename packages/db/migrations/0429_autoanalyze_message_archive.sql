-- agency-hub:rollback-compatible — storage parameters only: no column, no row, nothing an image names.
-- 0429_autoanalyze_message_archive.sql
--
-- message_archive is analyzed about once a week, so the planner believes the
-- archive holds nothing after the last analyze, and every read of the last
-- days is planned for one row. With the cluster's defaults (50 rows + 10 % of
-- the table) a 1.22 M-row archive is analyzed only after ~122 000 changes;
-- it takes ~17 500 a day (inserts plus content and deletion updates), so
-- about every seven days. No index leads with occurred_at
-- (message_archive_account_occurred_idx has it second), so the planner cannot
-- read the true upper end from an index either.
--
-- Production, 2026-11-18 18:19 UTC: relkind r, no reloptions, reltuples
-- 1 219 855, heap 606 MB; n_mod_since_analyze 114 208, last_autoanalyze null
-- since the 2026-11-12 restart; the last histogram bound of occurred_at is
-- 2026-11-11 17:13. A window after that bound, 2026-11-15 → 2026-11-18 15:00:
-- estimated 1 row, actual 15 860. A window inside it, 2026-11-05 → 11-08:
-- estimated 14 149, actual 12 873. The archive is read by recent windows in
-- about ten of the top statements (the shift review, «Онлайн», the shift's
-- fans and inputs, reply-delay counts, sale and PPV facts); reply-delay
-- counts took a nested loop on that one-row estimate: 7–18 s a screen.
--
-- An analyze once 5 000 rows changed, whatever the table's size: about every
-- seven hours at today's change rate, three or four times a day. It samples
-- 30 000 rows (default_statistics_target 100), a second or so. Vacuum, the
-- insert-triggered vacuum and anti-wraparound vacuums keep their defaults.
-- The pending changes already exceed 5 000: the first analyze runs within a
-- couple of autovacuum naptimes after the deploy.
--
-- Re-measure (read-only):
--   select n_mod_since_analyze, last_autoanalyze, autoanalyze_count
--     from pg_stat_user_tables where relname = 'message_archive';
--   select (histogram_bounds::text::timestamptz[])[array_upper(histogram_bounds::text::timestamptz[], 1)]
--     from pg_stats where tablename = 'message_archive' and attname = 'occurred_at';
--   explain select 1 from message_archive where occurred_at >= now() - interval '3 days';

set local lock_timeout = '5s';

alter table message_archive set (autovacuum_analyze_threshold = 5000, autovacuum_analyze_scale_factor = 0);
