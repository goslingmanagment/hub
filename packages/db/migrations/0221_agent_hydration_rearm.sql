-- 0221: hydration re-arm — a run refused before its first vendor request gives
-- its approval back instead of failing it.
--
-- The Fansly targeted backfill can refuse at the page's door without a single
-- vendor request: another stream of the page is mid-chunk, the page lease is
-- held, a regular chunk is parked on the thread, or the page's targeted queue
-- slot is taken. Settling the approval `failed` there threw away an
-- authorization for work that never started (2026-09-27..29: 135 of 150
-- auto-approvals, all labelled `vendor_unavailable`). The executor now moves
-- such a row `dispatching -> approved`, capped by dispatch_count, and the
-- journal needs a kind that says so: recording it as `approved` would read as a
-- second decision nobody made.
--
-- Widening only. No row changes; every existing event keeps its kind.

ALTER TABLE "agent_hydration_events"
  DROP CONSTRAINT "agent_hydration_events_kind_check";
ALTER TABLE "agent_hydration_events"
  ADD CONSTRAINT "agent_hydration_events_kind_check" CHECK ("kind" IN (
    'created', 'approved', 'rejected', 'dispatched', 'rearmed', 'settled', 'expired', 'failed'
  ));
