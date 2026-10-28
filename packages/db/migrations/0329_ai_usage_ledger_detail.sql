-- agency-hub:rollback-compatible — four nullable columns the previous image never names, and a backfill of one of them.
-- 0329_ai_usage_ledger_detail.sql
--
-- What a ledger row needs to explain its own price and to be checked against
-- the provider's usage report: the cache writes split by TTL (5m at 1.25x
-- input, 1h at 2x), the effort the request ran at and how many chat messages
-- its prompt held. All nullable: older rows and lanes that have no such thing
-- stay null.

ALTER TABLE ai_usage_events
  ADD COLUMN cache_write_5m_tokens integer,
  ADD COLUMN cache_write_1h_tokens integer,
  ADD COLUMN reasoning_effort text,
  ADD COLUMN context_messages integer;

ALTER TABLE ai_usage_events
  ADD CONSTRAINT ai_usage_events_cache_write_5m_tokens_nonnegative CHECK (cache_write_5m_tokens IS NULL OR cache_write_5m_tokens >= 0),
  ADD CONSTRAINT ai_usage_events_cache_write_1h_tokens_nonnegative CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0),
  ADD CONSTRAINT ai_usage_events_context_messages_nonnegative CHECK (context_messages IS NULL OR context_messages >= 0);

-- The gateway's rows carry the requested effort in their restricted record's
-- params. Opus 5.5 cannot run without thinking: it ran "off" at low.
UPDATE ai_usage_events AS event
SET reasoning_effort = CASE
    WHEN content.params->>'reasoningEffort' = 'off' AND event.model = 'anthropic:claude-opus-5-5' THEN 'low'
    ELSE content.params->>'reasoningEffort'
  END
FROM ai_generation_content AS content
WHERE content.usage_event_id = event.id
  AND content.params->>'reasoningEffort' IS NOT NULL
  AND event.reasoning_effort IS NULL;
