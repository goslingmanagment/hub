-- agency-hub:rollback-compatible — two nullable columns on the feed's own claims table: the previous image never names them.
-- 0357_onlyfans_feed_ledger_settlement.sql
--
-- OnlyFans' own ledger settles a purchase another writer counted
-- (services/client-onlyfans-feed-money.ts). A ledger sighting that claims a
-- row OFAPI wrote `pending` used to change nothing on later readings: the row
-- of another writer is never changed, and OFAPI (off since 2026-11-01) was the
-- only path that settled it. On 2026-11-07, 83 claimed OFAPI rows of the two
-- OnlyFans pages were still `pending`, 61 of them with the ledger's `done`
-- journaled. The feed now records the ledger's `done` (or `undo`) on its OWN
-- claim, and readers count such a row as posted (settledTransactionStateSql);
-- the OFAPI row itself is never touched.

set local lock_timeout = '5s';

ALTER TABLE "onlyfans_feed_money_claims"
  -- The journal entry of the ledger reading that settled the purchase (`done`, or `undo` — charged back).
  ADD COLUMN IF NOT EXISTS "settled_observation_id" bigint,
  ADD COLUMN IF NOT EXISTS "settled_at" timestamptz;
