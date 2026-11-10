-- agency-hub:rollback-compatible — storage parameters only: no column, no row, nothing an image names.
-- 0363_autovacuum_ws_receipts_ai_usage.sql
--
-- Two tables whose hot read walks the dead index entries a vacuum would
-- remove, and which the cluster's defaults (50 rows + 20 % of the table)
-- vacuum only every one to two weeks. The opposite case of 0362: here the
-- table is big, the changes per day small against it.
--
-- fansly_ws_decode_receipts. Every receipt is inserted `pending` and updated
-- once to applied/skipped/debt; `live_state` is in two partial indexes, so no
-- update is HOT (n_tup_hot_upd = 0). The live timer polls
-- `live_state = 'pending'` every 5 s and the pending-age gauge every minute.
-- Production, 2026-11-10 03:50 UTC: 1.40 M live rows, 259 MB, ~25 000
-- receipts a day, no reloptions; n_dead_tup 135 544, last autovacuum
-- 2026-11-04 21:28 (5 in 30 days, trigger ≈ 270 000 dead rows ≈ 10 days).
-- 0 rows pending, yet the poll's Index Only Scan on fansly_ws_decode_live_pending
-- makes 7 834 heap fetches and 2 660 buffer hits, 10–13 ms, the same on a
-- second run: the scans do not mark these entries dead themselves. Not an old
-- snapshot (oldest backend xmin 144 xids, no replication slot, no prepared
-- transaction); about half of the 15 920 receipts applied since that vacuum
-- left such an entry, the skipped ones almost none. Why exactly (a MultiXact
-- xmax from the `for update` + savepoint ack is the suspect) is not
-- established; a vacuum removes them either way. A vacuum once 5 000 rows
-- changed: about every 5 hours, the poll walks a few hundred entries at most.
--
-- ai_usage_events. Every AI request first runs the stale-reservation sweep
-- (`markStaleAiGatewayReservationsFailed`) through the partial
-- ai_usage_events_open_reservation_idx. A Bitmap Index Scan never marks an
-- entry dead, so each finished reservation stays in that index until a
-- vacuum. Production, same time: 96 k rows, 67 MB, ~1 270 dead rows a day,
-- no reloptions; n_dead_tup 16 569, last autovacuum 2026-10-28 20:40 (trigger
-- ≈ 19 000 dead rows ≈ 15 days). The sweep: 3 945 index entries, 599 heap
-- pages, 0 rows, 21 ms cold. A vacuum once 2 000 rows changed: about every
-- 1.5 days, under ~500 entries.
--
-- Analyze, insert-triggered and anti-wraparound vacuums keep their defaults.
--
-- Re-measure (read-only):
--   select relname, n_dead_tup, last_autovacuum, autovacuum_count
--     from pg_stat_user_tables where relname in ('fansly_ws_decode_receipts', 'ai_usage_events');
--   explain (analyze, buffers) select observation_id from fansly_ws_decode_receipts
--     where live_state = 'pending' and observation_id > 0 order by observation_id limit 100;
--   explain (analyze, buffers) select id from ai_usage_events where provider is not null
--     and quota_accepted = true and gateway_outcome is null and completed_at < now() - interval '30 minutes';

set local lock_timeout = '5s';

alter table fansly_ws_decode_receipts set (autovacuum_vacuum_threshold = 5000, autovacuum_vacuum_scale_factor = 0);
alter table ai_usage_events set (autovacuum_vacuum_threshold = 2000, autovacuum_vacuum_scale_factor = 0);
