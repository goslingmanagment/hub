-- Stage 13 (transactions provenance, currency, single-writer gate), migration 1 of 2.
-- Additive only: provenance + currency on transactions, writer registry + status
-- on pages, provenance backfill from immutable inputs (raw_type prefix, page
-- platform, spend-shadow join). Migration 2 (0056) flips the fact-table FKs to
-- RESTRICT once the tombstone write path ships in the same deploy.
--
-- source_observation_id is a PLAIN bigint, not an FK: observations is
-- partitioned by received_at and its PK is (id, received_at) — PostgreSQL
-- cannot FK a partitioned table on id alone (the same limitation that forced
-- the observation_keys companion in 0054). The join is by id at read time;
-- writers only ever store ids handed back by insertObservation.

-- Safe in a transaction on PG >= 12; the value is first USED by code, never
-- inside this migration (same pattern as 0052/0054).
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'wrong_transactions_writer';

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "source" text,
  ADD COLUMN IF NOT EXISTS "source_observation_id" bigint,
  ADD COLUMN IF NOT EXISTS "currency" char(3) NOT NULL DEFAULT 'USD';

-- Writer registry. NULL = no writer assigned yet (Stage 14 assigns per page as
-- OFAPI truth ingest is enabled page-by-page). status formalizes the Stage 2
-- interim deleted_at column (0053) — nothing wrote it until now.
ALTER TABLE "pages"
  ADD COLUMN IF NOT EXISTS "transactions_writer" text,
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
ALTER TABLE "pages"
  DROP CONSTRAINT IF EXISTS "pages_transactions_writer_check";
ALTER TABLE "pages"
  ADD CONSTRAINT "pages_transactions_writer_check"
    CHECK ("transactions_writer" IN ('onlymonster', 'ofapi', 'fansly'));
ALTER TABLE "pages"
  DROP CONSTRAINT IF EXISTS "pages_status_check";
ALTER TABLE "pages"
  ADD CONSTRAINT "pages_status_check"
    CHECK ("status" IN ('active', 'deleted'));

-- Writer seed matching running reality (ofapiSpendTransactionIngestEnabled is
-- already ON in production — the gate must be a no-op for the live path on day
-- one, or the deploy itself would start refusing live writes).
UPDATE "pages" SET "transactions_writer" = CASE
  WHEN "platform" = 'fansly' THEN 'fansly'
  WHEN "platform" = 'onlyfans' AND "ofapi_account_id" IS NOT NULL THEN 'ofapi'
  ELSE NULL END
WHERE "transactions_writer" IS NULL;

-- Provenance backfill over immutable inputs; idempotent via source IS NULL.
-- Single statement (not batched): the table holds ~3k rows in production today
-- and this migration runs inside the per-file transaction anyway.
-- ofapi webhook-vs-rest split via the spend-shadow join is best-effort for
-- history (overlap classifies as webhook — acceptable; both are OFAPI truth);
-- writers stamp exact values from now on.
UPDATE "transactions" t SET "source" = CASE
  WHEN t."raw_type" LIKE 'ofapi:%' THEN
    CASE WHEN EXISTS (
      SELECT 1 FROM "ofapi_spend_projection_events" s
      WHERE s."page_id" = t."platform_account_id"
        AND s."transaction_id" = t."transaction_id"
        AND s."projection_status" = 'projected')
    THEN 'ofapi:webhook' ELSE 'ofapi:rest' END
  WHEN p."platform" = 'fansly' THEN 'fansly:rest'
  ELSE 'onlymonster' END
FROM "pages" p
WHERE p."id" = t."platform_account_id" AND t."source" IS NULL;

ALTER TABLE "transactions" ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_source_check";
-- Open set by design: text + CHECK, not a pgEnum, so later producers
-- (e.g. Stage 12's 'harvest') extend the list without enum surgery.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_source_check"
    CHECK ("source" IN ('onlymonster', 'ofapi:webhook', 'ofapi:rest', 'fansly:rest', 'harvest'));

CREATE INDEX IF NOT EXISTS "transactions_source_idx" ON "transactions" ("source");
