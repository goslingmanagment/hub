-- Coach/recap generations (spec §5) send a CANONICAL conversation_ref (the
-- Fansly groupId) plus a SEPARATE fan_ref, so a fan-scope Stage 28 erasure
-- keyed only on conversation_ref = <fanId> would miss them. Capture the fan the
-- generation is ABOUT so erasure reaches these rows via (conversation_ref = ref
-- OR fan_ref = ref). Forward-only: legacy rows keep fan_ref NULL and stay
-- reachable by their conversation_ref = fanId shape. The table is young (0072),
-- so a plain (non-concurrent) CREATE INDEX is fine.
ALTER TABLE ai_generation_content ADD COLUMN IF NOT EXISTS fan_ref text;
CREATE INDEX IF NOT EXISTS ai_generation_content_page_fan_idx
  ON ai_generation_content (page_id, fan_ref) WHERE fan_ref IS NOT NULL;
