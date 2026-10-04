-- 0237_sync_attempt_route_intervals.sql
--
-- Fansly Sync Engine, the audit of the route budgets (invariant I19): the
-- admission records on the attempt the intervals it applied, as it records the
-- pause it applied (`pause_ms`). The permanent audit (the alert evaluator and
-- `sync switch check`) then compares every pair of adjacent actual sends of a
-- page's route, and of its family, with the number the later send was admitted
-- under — not with a copy of the policy.
--
--   route_interval_ms   the shortest gap its route allowed after the route's
--                       previous send when the attempt was admitted: the
--                       route's effective rate (a 429's slowdown included)
--   family_interval_ms  the same for the route's family; null when the route
--                       belongs to no family
--
-- Both are null on an attempt admitted before this migration: the audit reads
-- such a pair as `inconclusive`, never as a pass.
--
-- Purely additive: two nullable columns without a default (catalog-only). The
-- previous image never names them (it inserts sync_attempts by named
-- columns), so it runs unchanged after a rollback; its attempts carry no
-- interval and their pairs read `inconclusive`. The table-level read_only
-- grant of 0228 covers both.
alter table sync_attempts add column if not exists route_interval_ms integer;
alter table sync_attempts add column if not exists family_interval_ms integer;

comment on column sync_attempts.route_interval_ms is
  'I19: the interval (ms) of the attempt''s route at its effective rate when it was admitted; null before 0237.';
comment on column sync_attempts.family_interval_ms is
  'I19: the interval (ms) of the route''s family when the attempt was admitted; null for a route without a family (and before 0237).';
