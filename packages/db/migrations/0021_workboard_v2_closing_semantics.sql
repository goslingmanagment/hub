-- Workboard v2: L2 (Haiku) semantic conversation read. Additive.
-- The classifier now reads the fan's tail in conversation context and returns a
-- semantic `state` (buy_signal / question / complaint / smalltalk / cold / closing)
-- plus a short `reason`, feeding both the needs_reply detector and the urgency axis.
-- See docs/workboard-v2-priority-design.md §6.

ALTER TABLE "wb_closing_cache" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "wb_closing_cache" ADD COLUMN IF NOT EXISTS "reason" text;
