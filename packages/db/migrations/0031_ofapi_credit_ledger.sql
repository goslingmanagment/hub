-- OFAPI credit ledger (Phase 1 of docs/ofapi-parity-plan.md, D2-D5).
-- ofapi_credit_ledger is the append-only source of truth for OFAPI credit
-- movement: 'rest' rows carry server-reported _meta credits per request
-- (estimated=true when a 2xx response had no _meta), 'webhook_accrual' rows
-- post ceil(events/100) per UTC day from our own journal (idempotent via the
-- partial unique index on accrual_day), and reconciliation decomposes balance
-- drift into 'external' (ChatMuse + real webhook deductions) and 'refill'
-- rows. credits sign: positive = spent, negative = added. The ofapi_credit_state
-- day counter stays for fast budget checks and is updated in the same
-- transaction as 'rest' ledger inserts so the two can never disagree; it also
-- gains the reconciliation cursor (last walked balance observation).

CREATE TABLE IF NOT EXISTS "ofapi_credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"operation" text,
	"page_id" bigint,
	"http_status" integer,
	"credits" integer NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"balance_after" integer,
	"request_id" text,
	"accrual_day" date,
	"details" jsonb,
	CONSTRAINT "ofapi_credit_ledger_source_check" CHECK (
		"source" IN ('rest', 'webhook_accrual', 'external', 'refill', 'adjustment')
	)
);

ALTER TABLE "ofapi_credit_ledger" ADD CONSTRAINT "ofapi_credit_ledger_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "ofapi_credit_ledger_occurred_at_idx" ON "ofapi_credit_ledger" USING btree ("occurred_at");
CREATE INDEX IF NOT EXISTS "ofapi_credit_ledger_source_occurred_at_idx" ON "ofapi_credit_ledger" USING btree ("source","occurred_at");
-- Reconciliation walks balance observations in insertion order from a cursor.
CREATE INDEX IF NOT EXISTS "ofapi_credit_ledger_balance_observation_idx" ON "ofapi_credit_ledger" USING btree ("id") WHERE "balance_after" IS NOT NULL;
-- One webhook accrual row per UTC day, ever (upsert target).
CREATE UNIQUE INDEX IF NOT EXISTS "ofapi_credit_ledger_accrual_day_uniq" ON "ofapi_credit_ledger" USING btree ("accrual_day") WHERE "source" = 'webhook_accrual';

ALTER TABLE "ofapi_credit_state" ADD COLUMN IF NOT EXISTS "reconciled_through_ledger_id" bigint;
ALTER TABLE "ofapi_credit_state" ADD COLUMN IF NOT EXISTS "last_reconcile_at" timestamp with time zone;
ALTER TABLE "ofapi_credit_state" ADD COLUMN IF NOT EXISTS "last_drift_credits" integer;

ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'ofapi_burn_rate';
