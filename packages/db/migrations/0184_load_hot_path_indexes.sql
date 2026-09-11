-- agency-hub:no-transaction
-- 0184: two indexes for the statements that stayed hot after the 2c6b42b7
-- query fixes (docs/diag/2026-09-11-agency-hub-load, slow-query log of the
-- 2026-09-12 00:12 UTC+3 deploy):
--
-- 1. sync_runs_running_idx — the sync planner (every minute) and the sync
--    monitor read the handful of runs with outcome = 'running' out of ~190k
--    rows; without a predicate index that is a 286 MB sequential scan per call
--    (twice per closeInactiveSyncRuns). A partial index on the running rows is
--    a few kilobytes.
-- 2. ofapi_webhook_events_page_received_idx — getLatestOfapiEventTimesForPages
--    and the event-type variant take max(received_at) per platform_account_id
--    (status <> 'pending'); with ~690k rows and only (received_at) /
--    (platform_account_id, fanout_seq) indexes each call scanned the 900 MB
--    heap (38 s). Per-account backward scans on (platform_account_id,
--    received_at) find the maximum in a handful of rows.
--
-- Same discipline as 0169/0177: non-transactional, drop an INVALID leftover
-- from an interrupted earlier attempt, then build CONCURRENTLY and idempotently
-- so inbound OFAPI deliveries never queue behind an ACCESS EXCLUSIVE build.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname in ('sync_runs_running_idx', 'ofapi_webhook_events_page_received_idx')
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_runs_running_idx
  on sync_runs (id) where outcome = 'running';

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_events_page_received_idx
  on ofapi_webhook_events (platform_account_id, received_at);
