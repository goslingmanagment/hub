-- agency-hub:rollback-compatible — a data fix of a column the previous image never names.
-- 0331_ai_usage_short_recap_effort.sql
--
-- 0329 backfilled reasoning_effort from the effort a request asked for. A
-- short Recap (fan-summary, summaryMode short) runs with adaptive thinking
-- switched off whatever it asked: Opus 5.5, which cannot run without
-- thinking, at low; every other model with no thinking ("off"). The gateway
-- records it so since 0329; this fixes the rows backfilled before.

UPDATE ai_usage_events AS event
SET reasoning_effort = CASE WHEN event.model = 'anthropic:claude-opus-5-5' THEN 'low' ELSE 'off' END
FROM ai_generation_content AS content
WHERE content.usage_event_id = event.id
  AND event.feature = 'fan-summary'
  AND content.params->>'summaryMode' = 'short'
  AND event.reasoning_effort IS DISTINCT FROM CASE WHEN event.model = 'anthropic:claude-opus-5-5' THEN 'low' ELSE 'off' END;
