-- OFAPI DM bootstrap/reconcile (Phase 2 of docs/ofapi-integration-plan.md).
-- ofapi_credit_state is a singleton tracking the OFAPI credit budget across all
-- pages: per-UTC-day spend (enforces OFAPI_DM_DAILY_CREDIT_BUDGET) and the
-- last _meta._credits.balance observed on any REST response (enforces
-- OFAPI_CREDIT_FLOOR; surfaced by ops/admin views). Credits are account-global
-- at OFAPI, so this is deliberately not per page.

CREATE TABLE IF NOT EXISTS "ofapi_credit_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"spend_day" date,
	"spent_credits" integer DEFAULT 0 NOT NULL,
	"last_balance" integer,
	"last_balance_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
