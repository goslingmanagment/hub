-- Decision #136 follow-up: fan_profiles rows carry the SOURCE generation
-- time (when the client's Scan actually ran) separately from created_at
-- (the hub append time). Without it, a delayed re-push of an old cached
-- Scan (extension E22 retry) resets the dossier's apparent age to zero and
-- the AI feature lane wrongly keeps its volatile sections (stage / open
-- loops / strategy). Null = written by a client that predates the field;
-- the reader falls back to created_at.
ALTER TABLE "fan_profiles"
  ADD COLUMN IF NOT EXISTS "source_generated_at" timestamptz;
