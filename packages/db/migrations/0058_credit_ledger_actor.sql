-- Stage 9 (read-gateway capture-through + read attribution): who spent each
-- read. Additive + nullable; historical reads are unattributable by design
-- (recorded fact, not a gap to chase) — no backfill.

ALTER TABLE "ofapi_credit_ledger"
  ADD COLUMN IF NOT EXISTS "actor_user_id" bigint REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "ofapi_credit_ledger_actor_idx"
  ON "ofapi_credit_ledger" ("actor_user_id", "occurred_at");

-- Capture-tee overflow pages the owner (fail-open is bounded to this
-- producer; the counter + incident keep the gap visible).
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'read_gateway_capture';
