-- 0085: A2b (decision #135) — projection_debt: the repair ledger for
-- rebuildable projections.
--
-- Incident 05..11.07: the page_dm_threads summary recompute (finalize) hit
-- the 0026 CHECK constraint inside the SAME transaction as the message
-- upsert + checkpoint advance, so one bad summary wedged the page's whole
-- dm_messages stream (251-270 consecutive 23514s) while /health/sync said
-- ok. The facts are journaled at fetch time (sync_raw_payloads +
-- observations) and the thread summary is a rebuildable projection — so a
-- finalize/checkpoint failure now records a row here and the stream moves
-- on; the 5-minute repair sweep re-runs the recompute and resolves.
--
-- No delete-based retention (DP 7): resolved rows keep resolved_at set and
-- stay as the incident audit trail. No FKs on purpose — a debt row must
-- never block page operations.
CREATE TABLE "projection_debt" (
  "id"                  bigserial PRIMARY KEY,
  "kind"                text NOT NULL,
  "platform_account_id" bigint NOT NULL,
  "conversation_id"     bigint NOT NULL,
  "error_summary"       text,
  "attempts"            integer NOT NULL DEFAULT 1,
  "first_seen_at"       timestamptz NOT NULL DEFAULT now(),
  "last_attempt_at"     timestamptz NOT NULL DEFAULT now(),
  "resolved_at"         timestamptz
);

-- One LIVE debt row per projection target (repeat failures bump attempts on
-- the open row); resolved history accumulates beneath it.
CREATE UNIQUE INDEX "projection_debt_unresolved_uniq"
  ON "projection_debt" ("kind", "conversation_id")
  WHERE "resolved_at" IS NULL;
