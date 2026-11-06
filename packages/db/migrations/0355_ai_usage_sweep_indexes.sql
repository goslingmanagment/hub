-- agency-hub:rollback-compatible — two new indexes only: the previous image never names them.
-- 0355_ai_usage_sweep_indexes.sql
--
-- Two frequent AI statements read a whole table to find almost nothing
-- (pg_stat_statements on 2026-11-06, since 2026-10-10):
--
-- * The stale-reservation sweep runs before every AI gateway request
--   (36 477 calls, 25 ms mean, 1 row updated in all): a seq scan of
--   ai_usage_events' 92 000 rows. The partial index holds only provider
--   attempts still waiting for their outcome — 0 rows on 2026-11-06; a row
--   enters at reservation and leaves at finalize. Its predicate is the sweep's,
--   not just `gateway_outcome is null`, which would also keep 19 000 old rows
--   (April–July 2026) with no provider and no quota answer.
-- * The acceptance gauge of the per-minute golden-signals sampler counts the
--   last hour of ai_acceptance_events (38 394 calls, 14 ms mean): a seq scan of
--   117 000 rows to count a handful.
--
-- Both tables are small (33 MB and 13 MB of heap): each build blocks their
-- writes for well under a second.

set local lock_timeout = '5s';

create index if not exists ai_usage_events_open_reservation_idx
  on ai_usage_events (completed_at)
  where provider is not null and quota_accepted = true and gateway_outcome is null;

create index if not exists ai_acceptance_events_occurred_at_idx
  on ai_acceptance_events (occurred_at);
