-- Dedicated UTC-day credit counter for the link-stats reconcile (scope
-- 'link_stats' in reserveOfapiDayCredits). Mirrors the backfill counter pair;
-- additive and inert until the flag enables the job. Isolates the link-stats
-- quota from the chargebacks backfill lane in BOTH directions.
ALTER TABLE ofapi_credit_state
  ADD COLUMN link_stats_spend_day date,
  ADD COLUMN link_stats_spent_credits integer NOT NULL DEFAULT 0;
