-- agency-hub:rollback-compatible — three nullable columns; the previous image never reads or writes them.

-- «Новые» on a page fed by ChatSpace (services/client-audience-new.ts): its coverage follows the page's poll of
-- ChatSpace's own notifications, not OFAPI's webhook delivery history. The tab that held the poll reports how its
-- pass went (`clientOnlyfansPoll` with `passed`): when each list was last read back to the hub's cursor, and when a
-- pass last failed.

set local lock_timeout = '5s';

ALTER TABLE "onlyfans_feed_poll_leases"
  ADD COLUMN IF NOT EXISTS "subscribers_passed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "ledger_passed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "failed_at" timestamptz;
