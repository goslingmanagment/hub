-- Pre-flip hardening for the decision #50 flags (pre-deploy audit F9).
-- The audience sweep's daily ceiling was checked against a ledger-attributed
-- SUM that cannot see in-flight requests, so concurrent streams near the cap
-- could each pass the check and overspend. The sweep gets its own UTC-day
-- counter pair on the ofapi_credit_state singleton: budget checks become one
-- conditional update (reserve-before-request), settled to _meta actuals after
-- the response. The existing spend_day/spent_credits pair keeps serving the
-- global (DM) budget the same way.

ALTER TABLE "ofapi_credit_state" ADD COLUMN IF NOT EXISTS "audience_spend_day" date;
ALTER TABLE "ofapi_credit_state" ADD COLUMN IF NOT EXISTS "audience_spent_credits" integer DEFAULT 0 NOT NULL;
