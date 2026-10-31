-- agency-hub:rollback-compatible — a new table only; the previous image never reads or writes it.

-- The page's poll of ChatSpace for the OnlyFans feed (services/client-onlyfans-poll.ts): the owner allowed the
-- extension light reads of ChatSpace (the new subscribers, the sales ledger), ChatSpace's own requests at its own
-- pace. The hub lends a page's poll to one tab of the team at a time, the agency's always-on tab first, and keeps
-- the newest item of each list the feed brought: a poll reads back to it and no further.

set local lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "onlyfans_feed_poll_leases" (
  "platform_account_id" bigint PRIMARY KEY REFERENCES "pages" ("id") ON DELETE RESTRICT,
  -- Who holds the page's poll now, and whether it is the agency's always-on tab.
  "user_id" bigint,
  "server" boolean NOT NULL DEFAULT false,
  "granted_at" timestamptz,
  -- When the page's next poll may be lent.
  "next_at" timestamptz NOT NULL DEFAULT now(),
  -- When the always-on tab last asked: while it is recent, only it is lent the poll.
  "server_seen_at" timestamptz,
  -- The newest new-subscriber notification and ledger row the feed brought, by their own time.
  "subscribers_cursor" text,
  "subscribers_cursor_at" timestamptz,
  "ledger_cursor" text,
  "ledger_cursor_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
