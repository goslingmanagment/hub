-- Kernel Stage 31: the desktop's acceptance lifecycle includes 'copied'
-- (an existing cmd:ai.feedback action). Stage 29's CHECK predates the
-- client wiring — widen it; everything else about the table stands.
ALTER TABLE ai_acceptance_events
  DROP CONSTRAINT ai_acceptance_events_lifecycle_check;
ALTER TABLE ai_acceptance_events
  ADD CONSTRAINT ai_acceptance_events_lifecycle_check
  CHECK (lifecycle IN ('shown', 'copied', 'inserted', 'edited', 'sent'));
