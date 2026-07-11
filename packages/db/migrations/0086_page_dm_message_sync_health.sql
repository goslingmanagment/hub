-- Per-conversation circuit breaker for the OFAPI dm_messages sync: one
-- "poison" chat that times out at the vendor (60s transport abort, no HTTP
-- status) must not wedge a page's whole dm_messages stream — two pages never
-- completed a DM sync this way, and the poison chat id has changed three
-- times, so exclusion has to be earned per-failure, not hardcoded.
-- Failure bookkeeping with exponential backoff (next_retry_at) and a
-- quarantine window after repeated failures; candidate selection skips
-- excluded conversations and re-admits them implicitly once the windows
-- lapse. Operational sync state, not captured facts — rows are cleared on a
-- successful sync of the conversation and cascade away with their thread.
CREATE TABLE IF NOT EXISTS "page_dm_message_sync_health" (
  "conversation_id" bigint PRIMARY KEY REFERENCES "page_dm_threads"("id") ON DELETE CASCADE,
  "platform_account_id" bigint NOT NULL,
  "failure_count" integer NOT NULL DEFAULT 0,
  "error_class" text,
  "last_error" text,
  "last_attempt_at" timestamptz,
  "next_retry_at" timestamptz,
  "quarantine_until" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "page_dm_message_sync_health_account_quarantine_idx"
  ON "page_dm_message_sync_health" ("platform_account_id", "quarantine_until");
