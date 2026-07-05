-- Stage 14: dedicated UTC-day credit counter for the historical transactions
-- backfill (scope 'backfill' in reserveOfapiDayCredits). Mirrors the audience
-- counter pair; additive and inert until the CLI runs.
ALTER TABLE ofapi_credit_state
  ADD COLUMN backfill_spend_day date,
  ADD COLUMN backfill_spent_credits integer NOT NULL DEFAULT 0;
