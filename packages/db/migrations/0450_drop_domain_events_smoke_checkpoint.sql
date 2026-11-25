-- agency-hub:rollback-compatible — drops the retired Stage 21 smoke helper table domain_events_smoke_checkpoint; no code in the current or previous image reads or writes it.
-- 0450_drop_domain_events_smoke_checkpoint.sql
--
-- Removes `domain_events_smoke_checkpoint` (created by migration 0064 for the
-- retired v2 smoke consumer) so no non-partition helper table remains under
-- the `domain_events_` prefix (BL-A10).

set local lock_timeout = '5s';

drop table if exists domain_events_smoke_checkpoint;
