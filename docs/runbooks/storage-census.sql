-- Read-only production storage census (storage audit 2026-10-16,
-- investigations/storage-audit-2026-10-16.md).
--
-- What it reads: the catalog, pg_stat counters, sizes, effective settings, and
-- bounded 24-hour slices over indexed time columns. What it never does: write,
-- lock a table, scan a large table whole, or sort a large result in temp.
-- Every statement runs in a READ ONLY transaction under statement_timeout;
-- a statement that hits it is cancelled and the census goes on.
--
-- Run on the server, from the repo checkout (the output carries no fan data:
-- sizes, counts, setting values, index names):
--
--   docker compose --env-file .env.production -f docker-compose.production.yml \
--     exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=0 -f -' \
--     < docs/runbooks/storage-census.sql > storage-census-$(date -u +%F).txt 2>&1
--
-- (Not in packages/db/migrations/: the runner applies every .sql file there.)

\pset pager off
\pset null '∅'
\timing off
set statement_timeout = '60s';
set lock_timeout = '1s';
set default_transaction_read_only = on;
set work_mem = '64MB';

\echo '== 1. server, database, WAL'
select version();
select now() as sampled_at,
       pg_size_pretty(pg_database_size(current_database())) as database,
       pg_database_size(current_database()) as database_bytes;
select count(*) as wal_files, pg_size_pretty(sum(size)) as wal_size from pg_ls_waldir();
select stats_reset from pg_stat_database where datname = current_database();
select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained
from pg_replication_slots;

\echo '== 2. settings that decide write volume and bloat (non-default and key ones)'
select name, setting, unit, source
from pg_settings
where name in (
  'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'autovacuum_work_mem',
  'wal_level', 'wal_compression', 'max_wal_size', 'min_wal_size', 'checkpoint_timeout',
  'full_page_writes', 'synchronous_commit', 'default_toast_compression',
  'autovacuum', 'autovacuum_max_workers', 'autovacuum_naptime', 'autovacuum_vacuum_cost_limit',
  'autovacuum_vacuum_cost_delay', 'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
  'autovacuum_vacuum_insert_scale_factor', 'autovacuum_freeze_max_age',
  'temp_file_limit', 'statement_timeout', 'idle_in_transaction_session_timeout',
  'logging_collector', 'log_min_duration_statement', 'log_statement', 'log_autovacuum_min_duration',
  'log_temp_files', 'track_io_timing', 'shared_preload_libraries', 'max_connections'
)
order by name;

\echo '== 3. tables by total size (partitions rolled into their root), with write counters'
with rel as (
  select case when rn.nspname = 'public' then root.relname else rn.nspname || '.' || root.relname end as relation,
         c.relispartition, c.oid, c.reltoastrelid, s.*
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_class root on root.oid = coalesce(pg_partition_root(c.oid), c.oid)
  join pg_namespace rn on rn.oid = root.relnamespace
  left join pg_stat_all_tables s on s.relid = c.oid
  where c.relkind in ('r', 'p', 'm')
    and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
)
select relation,
       count(*) filter (where relispartition) as parts,
       pg_size_pretty(sum(pg_total_relation_size(oid))) as total,
       pg_size_pretty(sum(pg_table_size(oid) - coalesce(pg_total_relation_size(nullif(reltoastrelid, 0)), 0))) as heap,
       pg_size_pretty(sum(coalesce(pg_total_relation_size(nullif(reltoastrelid, 0)), 0))) as toast,
       pg_size_pretty(sum(pg_indexes_size(oid))) as indexes,
       sum(n_live_tup) as live, sum(n_dead_tup) as dead,
       sum(n_tup_ins) as ins, sum(n_tup_upd) as upd, sum(n_tup_hot_upd) as hot_upd, sum(n_tup_del) as del,
       max(greatest(last_autovacuum, last_vacuum)) as last_vacuum
from rel
group by relation
order by sum(pg_total_relation_size(oid)) desc
limit 60;

\echo '== 4. partitions of the big partitioned tables'
select parent.relname as parent, c.relname as partition,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)) as toast,
       pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
       s.n_live_tup as live, s.n_tup_upd as upd, s.n_tup_hot_upd as hot_upd
from pg_inherits i
join pg_class c on c.oid = i.inhrelid
join pg_class parent on parent.oid = i.inhparent
left join pg_stat_all_tables s on s.relid = c.oid
where parent.relname in ('observations', 'domain_events', 'capture_payload_objects',
                         'capture_json_hot_bodies', 'capture_byte_hot_bodies')
  and pg_total_relation_size(c.oid) > 8192 * 16
order by parent.relname, c.relname;

\echo '== 5. parked / retired / shadow / snapshot relations'
select n.nspname, c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as total
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and (n.nspname = 'tiered_pending_drop'
       or c.relname ~ '(retired|shadow|snapshot|_old$|_bak|backup)')
order by pg_total_relation_size(c.oid) desc;

\echo '== 6. indexes over 1 MB: size and scans since the stats reset (idx_scan = 0 is a drop candidate)'
select s.relname as table_name, s.indexrelname as index_name,
       pg_size_pretty(pg_relation_size(s.indexrelid)) as size,
       s.idx_scan, s.idx_tup_read,
       i.indisunique as is_unique, i.indisprimary as is_primary
from pg_stat_all_indexes s
join pg_index i on i.indexrelid = s.indexrelid
where s.schemaname not in ('pg_catalog', 'pg_toast', 'information_schema')
  and pg_relation_size(s.indexrelid) > 1024 * 1024
order by pg_relation_size(s.indexrelid) desc
limit 150;

\echo '== 7. update churn: tables with the most updates and their HOT share'
select relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) as hot_pct,
       n_live_tup, n_dead_tup, last_autovacuum
from pg_stat_all_tables
where schemaname not in ('pg_catalog', 'pg_toast', 'information_schema') and n_tup_upd > 10000
order by n_tup_upd desc
limit 40;

\echo '== 8. effective storage flags per running process (runtime heartbeat snapshot)'
select role, last_seen_at,
       running -> 'values' -> 'captureCasDualWritePages' ->> 'value' as cas_dual_write_pages,
       running -> 'values' -> 'captureCasPointerOnlyPages' ->> 'value' as cas_pointer_only_pages,
       running -> 'values' -> 'captureCasReadMode' ->> 'value' as cas_read_mode,
       running -> 'values' -> 'syncHttpTraceFile' ->> 'value' as http_trace_file,
       running -> 'values' -> 'ofapiDmColdArchiveEnabled' ->> 'value' as ofapi_dm_cold_archive,
       running -> 'values' -> 'agentReadPlaneMode' ->> 'value' as agent_read_plane
from runtime_instances
order by role, last_seen_at desc;

\echo '== 9. capture rewrite runs (what of the historical compaction has run)'
select id, operation, scope_table, scope_month, phase, dry_run, verdict, started_at, completed_at
from capture_rewrite_runs
order by id desc
limit 30;

\echo '== 10. domain_events written in the last 24 h, by type (BRIN on created_at)'
select type, count(*) as events,
       pg_size_pretty(sum(pg_column_size(data))) as data_size,
       round(avg(octet_length(dedup_key))) as avg_key_len
from domain_events
where created_at >= now() - interval '24 hours'
group by type
order by count(*) desc;

\echo '== 11. Fansly/OFAPI material re-observation: events per distinct message, last 24 h'
select account_id, count(*) as material_events, count(distinct message_ref) as distinct_messages,
       round(count(*)::numeric / nullif(count(distinct message_ref), 0), 2) as events_per_message
from domain_events
where created_at >= now() - interval '24 hours' and type = 'message.material_observed'
group by account_id
order by count(*) desc;

\echo '== 12. observations journaled in the last 24 h, by source and kind (per page, index range)'
select o.source, o.kind, count(*) as rows,
       count(*) filter (where o.payload is null) as pointer_only,
       pg_size_pretty(sum(coalesce(pg_column_size(o.payload), 0))) as inline_payload
from pages p
cross join lateral (
  select source, kind, payload from observations
  where account_id = p.id and received_at >= now() - interval '24 hours'
) o
group by o.source, o.kind
order by sum(coalesce(pg_column_size(o.payload), 0)) desc;

\echo '== 13. engine attempts in the last 24 h, by resource (per page, index range)'
select a.resource, count(*) as attempts, count(*) filter (where a.evidence) as evidence_rows,
       pg_size_pretty(sum(pg_column_size(a.request))) as request_json
from pages p
cross join lateral (
  select resource, evidence, request from sync_attempts
  where page_id = p.id and admitted_at >= now() - interval '24 hours'
) a
group by a.resource
order by count(*) desc;

\echo '== 14. OFAPI webhooks in the last 24 h'
select count(*) as deliveries,
       pg_size_pretty(sum(coalesce(octet_length(raw_body), 0))) as raw_body,
       pg_size_pretty(sum(pg_column_size(payload))) as parsed_payload
from ofapi_webhook_events
where received_at >= now() - interval '24 hours';

\echo '== 15. message stores: rows and bytes per row (planner estimates, no scan)'
select c.relname, c.reltuples::bigint as est_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       case when c.reltuples > 0 then round(pg_total_relation_size(c.oid) / c.reltuples) end as bytes_per_row
from pg_class c
where c.relname in ('message_archive', 'page_dm_messages', 'dm_message_archive', 'dm_live_messages',
                    'page_dm_threads', 'ai_generation_content', 'fansly_ws_decode_receipts')
order by pg_total_relation_size(c.oid) desc;

\echo '== 16. sessions that hold back vacuum'
select state, count(*), max(now() - xact_start) as oldest_xact
from pg_stat_activity
where datname = current_database()
group by state;

\echo '== done'
