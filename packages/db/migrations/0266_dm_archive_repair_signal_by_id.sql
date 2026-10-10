-- agency-hub:no-transaction
-- 0266: the corrections reconciler's work list reads its rows in id order
-- from an index of its own, instead of walking the whole archive.
--
-- listDmRepairSignalRows (dm-message-candidate.ts) pages
--   material_fingerprint is distinct from emitted_fingerprint
--   and material_fingerprint is not null
-- by id, across every page. 0076's partial index leads with
-- platform_account_id, so it cannot give that order, and the planner prices
-- `is distinct from` at ~99.5% of the rows (two columns, no statistics). It
-- therefore walked the primary key until it had 100 rows: on prod
-- (2026-10-10) 100 037 rows removed by filter, 45 428 buffers and ~0.1-0.2 s
-- a run every minute, for a list that is empty in the steady state. The old
-- index had no scan since 2026-10-03.
--
-- A partial index on (id) gives the order directly, and the planner caps its
-- cost at the index's own (near-zero) tuple count, so it takes it. Its
-- predicate is the work list's: THE PREDICATE IS A CONTRACT WITH THE QUERY
-- (tests/dm-repair-signal-index.integration.test.ts pins both). HOT updates of
-- these columns were already impossible under 0076's index, so writes pay
-- nothing new. Built CONCURRENTLY after dropping an INVALID leftover of an
-- interrupted attempt (the 0261 discipline), then the unused 0076 index goes.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'dm_message_archive_repair_signal_id_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists dm_message_archive_repair_signal_id_idx
  on dm_message_archive (id)
  where material_fingerprint is distinct from emitted_fingerprint and material_fingerprint is not null;

-- agency-hub:statement
drop index concurrently if exists dm_message_archive_repair_signal_idx;
