-- 0239_retire_fansly_legacy_sync_states.sql
--
-- Fansly Sync Engine, step 4 (design S4-21 [E17]): the point of no return,
-- stage 2. The legacy page-sync executor serves no Fansly page since S4-10
-- (its planner and its leases are scoped to the platforms whose adapter
-- declares a stream: OnlyFans), and this release deletes the last way back to
-- it — the step-3 switch, its rollback and the `sync_pages` mode fence the
-- legacy pickers carried. The legacy stream rows of every Fansly page are
-- parked here for good, the 0097 pattern without its trigger:
--
--   status = 'paused', blocker_kind = 'retired',
--   blocker_code = 'fansly_sync_engine_owned', lease and retry fields cleared.
--
-- Every image treats a `retired` row as permanent: the runnable listing and
-- the lease need a row that is not paused and has no blocker, a resume skips
-- the kind, a reset keeps it paused, a request leaves a paused row paused. So
-- the executor's platform set and these rows keep it off a Fansly page
-- together, whatever build runs.
--
-- Data only: one update, no DDL. Request and applied sequences, cursors
-- (`page_sync_cursors`), runs and the rows of other platforms are untouched;
-- a row parked already is not rewritten. A Fansly page onboarded since step 4
-- (S4-05) has no such rows and gets none.
--
-- Before the deploy (read-only): every Fansly page is on the engine —
--   select count(*) from pages p left join sync_pages sp on sp.page_id = p.id
--    where p.platform = 'fansly' and p.status = 'active'
--      and sp.mode is distinct from 'live';                           -- 0
-- (2026-10-04: six pages, all `live`; 102 rows to park, none leased.)
--
-- Rollback-compatible: the previous image (S4-10 … S4-20) never seeds,
-- schedules, wakes, leases or resets a Fansly page's legacy state and its
-- rollback command refuses, so it runs unchanged on parked rows.
update page_sync_states st
   set status = 'paused',
       blocker_kind = 'retired',
       blocker_code = 'fansly_sync_engine_owned',
       blocker_message = 'Legacy Fansly sync streams are permanently retired; the page is read by the Fansly Sync Engine',
       blocked_at = coalesce(st.blocked_at, clock_timestamp()),
       leased_seq = null,
       lease_owner = null,
       lease_token = null,
       lease_heartbeat_at = null,
       lease_expires_at = null,
       retry_kind = null,
       retry_at = null,
       updated_at = clock_timestamp()
  from pages p
 where p.id = st.page_id
   and p.platform = 'fansly'
   and not (st.status = 'paused' and st.blocker_kind is not distinct from 'retired');
