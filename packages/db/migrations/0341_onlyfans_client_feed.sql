-- agency-hub:rollback-compatible — widens two CHECKs, adds two nullable columns and a new table; the previous image never writes the new values.

-- The OnlyFans feed from the chat extension on OnlyMonster ChatSpace
-- (services/client-onlyfans-feed.ts). From 2026-11-01 the hub has no
-- OnlyFansAPI: what a chatter's ChatSpace already receives is passed on.
--
-- - `chatspace` joins the page's transactions writers: the one-writer gate moves
--   per page from `ofapi` to it (`onlyfans-feed:take-money`).
-- - Its rows keep their own sources, apart from every other writer's, because
--   chatter pay reports read this money: `chatspace:ws` — a purchase or a tip
--   the page's socket announced (gross only; the net is OnlyFans' 80 %);
--   `chatspace:ledger` — a row of the page's sales ledger as OnlyMonster gave it.
-- - `onlyfans_feed_money_claims`: a purchase seen by the socket, the ledger and
--   an earlier writer is ONE transaction; each later sighting claims the row
--   that already counts it instead of writing another one. One row per sighting
--   key, and a row is claimed at most once per kind of sighting.
-- - `page_fans.platform_spend`: the fan's lifetime sums by type as OnlyFans
--   itself counts them (gross dollars), with when they were read. Money stays
--   transactions-based; this is the platform's own figure beside it.

set local lock_timeout = '5s';

ALTER TABLE "pages"
  DROP CONSTRAINT IF EXISTS "pages_transactions_writer_check";
ALTER TABLE "pages"
  ADD CONSTRAINT "pages_transactions_writer_check"
    CHECK ("transactions_writer" IN ('onlymonster', 'ofapi', 'fansly', 'chatspace'));

ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_source_check";
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_source_check"
    CHECK ("source" IN ('onlymonster', 'ofapi:webhook', 'ofapi:rest', 'fansly:rest', 'harvest', 'chatspace:ws', 'chatspace:ledger'));

ALTER TABLE "page_fans"
  ADD COLUMN IF NOT EXISTS "platform_spend" jsonb,
  ADD COLUMN IF NOT EXISTS "platform_spend_observed_at" timestamptz;

CREATE TABLE IF NOT EXISTS "onlyfans_feed_money_claims" (
  "platform_account_id" bigint NOT NULL REFERENCES "pages" ("id") ON DELETE RESTRICT,
  -- The sighting: `ws:tip:<tip>`, `ws:ppv:message:<message>`, `ws:ppv:post:<post>:<fan digest>`, `ledger:<id>`.
  "feed_key" text NOT NULL,
  -- `ws` or `ledger`: a row is claimed at most once by each.
  "sighting" text NOT NULL CHECK ("sighting" IN ('ws', 'ledger')),
  -- The transactions row that counts this purchase.
  "transaction_row_id" bigint NOT NULL REFERENCES "transactions" ("id") ON DELETE CASCADE,
  "observation_id" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("platform_account_id", "feed_key")
);
CREATE UNIQUE INDEX IF NOT EXISTS "onlyfans_feed_money_claims_row_sighting_uniq"
  ON "onlyfans_feed_money_claims" ("transaction_row_id", "sighting");
