-- agency-hub:rollback-compatible — storage parameters only: no column, no row, nothing an image names.
-- 0362_autovacuum_tiny_hot_tables.sql
--
-- A dozen tables of a few rows are updated around the clock: heartbeats,
-- cursors, watermarks, the alert evaluator's marks. With the cluster's
-- defaults (50 changed rows plus 20 % / 10 % of a handful) autovacuum takes
-- each of them every minute — a vacuum AND an analyze. Production,
-- 2026-10-10 … 2026-11-10 (30 days): sync_alert_evaluations (42 rows)
-- 38 187 vacuums and 43 108 analyzes, pgboss.queue (51 rows) 40 536 and
-- 40 599, sync_pages (6 rows) 37 847 analyzes; some 390 000 runs in all,
-- 13 000 a day. Every analyze rewrites the table's pg_statistic rows (249 000
-- row updates a day) and its pg_class row: WAL, full-page images after each
-- checkpoint, catalog pages for the checkpointer (on 2026-11-10 a seventh of
-- the cluster's WAL was written outside any client statement).
--
-- These tables keep their shape: the planner learns nothing from a new
-- sample, and their updates are HOT, pruned page by page without a vacuum.
-- So: a vacuum once 2 000 rows changed, an analyze once 20 000 did, whatever
-- the table's size — about every twenty minutes and every few hours for the
-- busiest of them. Anti-wraparound vacuums are not touched.
--
-- sync_pages' TOAST table (planned_rr) was vacuumed every ten minutes for
-- its 6 rows: the same bound.
--
-- pg-boss makes its own schema when the runtime first starts, after the
-- migrations: on a fresh database its two tables are not there yet and keep
-- the defaults (a development database does not mind).

set local lock_timeout = '5s';

alter table sync_alert_evaluations set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table projection_seq_watermarks set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table domain_event_seq set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table notification_incident_recoveries set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table page_browsers set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table device_tokens set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table fansly_ws_connections set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table canonicalize_sweep_cursors set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table runtime_instances set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
alter table sync_pages set (
  autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0,
  autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0,
  toast.autovacuum_vacuum_threshold = 2000, toast.autovacuum_vacuum_scale_factor = 0
);

do $$
begin
  if to_regclass('pgboss.queue') is not null then
    alter table pgboss.queue set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
  end if;
  if to_regclass('pgboss.version') is not null then
    alter table pgboss.version set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 20000, autovacuum_analyze_scale_factor = 0);
  end if;
end
$$;
