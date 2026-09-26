-- H2 (2026-09-26, amends #265): automatic redelivery of undelivered business
-- webhooks next to the owner's manual action.
--
-- An intent now records its origin. A manual intent keeps its owner actor; an
-- automatic intent has no human actor. The column default keeps every existing
-- row and an older application binary on 'manual', so an application rollback
-- stays valid with this schema present.
--
-- 'not_sent' records a claimed intent whose request was refused locally before
-- any vendor egress (credential, credit-accounting or key-scope readiness). It
-- is not a provider outcome: it neither blocks another intent nor counts
-- toward a daily limit. Anything that may have reached OFAPI remains
-- accepted, rejected or indeterminate.
ALTER TABLE ofapi_webhook_redelivery_intents
  DROP CONSTRAINT ofapi_webhook_redelivery_intents_state_check,
  ADD CONSTRAINT ofapi_webhook_redelivery_intents_state_check
    CHECK (state IN ('dispatching', 'accepted', 'rejected', 'indeterminate', 'not_sent')),
  ADD COLUMN origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN business_key text,
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD CONSTRAINT ofapi_webhook_redelivery_intents_origin_check
    CHECK (origin IN ('manual', 'auto')),
  ADD CONSTRAINT ofapi_webhook_redelivery_intents_actor_check
    CHECK ((origin = 'manual') = (actor_user_id IS NOT NULL)),
  ADD CONSTRAINT ofapi_webhook_redelivery_intents_auto_key_check
    CHECK (origin <> 'auto' OR business_key IS NOT NULL);

-- The business key is the provider idempotency key of the redelivered attempt.
UPDATE ofapi_webhook_redelivery_intents i SET business_key = a.idempotency_key
FROM ofapi_webhook_delivery_attempts a
WHERE a.webhook_id = i.webhook_id AND a.attempt_id = i.attempt_id AND i.business_key IS NULL;

-- One automatic request per business key, ever, whatever its provider outcome:
-- a rejected or indeterminate automatic POST is never repeated automatically.
-- A local refusal ('not_sent') sent nothing and does not use the key's shot.
CREATE UNIQUE INDEX ofapi_webhook_redelivery_auto_business_key_uniq
  ON ofapi_webhook_redelivery_intents(webhook_id, business_key)
  WHERE origin = 'auto' AND state <> 'not_sent';
-- Key-level guards and the history view look intents up by business key.
CREATE INDEX ofapi_webhook_redelivery_business_key_idx
  ON ofapi_webhook_redelivery_intents(webhook_id, business_key);
-- Manual and automatic requests have separate UTC-day counters.
CREATE INDEX ofapi_webhook_redelivery_origin_day_idx
  ON ofapi_webhook_redelivery_intents(origin, created_at);

-- Automatic redelivery state (one row). enabled_at is non-null exactly while
-- the feature is enabled: the moment the worker first saw the switch on. A
-- failure whose business key has any attempt before it is never redelivered
-- automatically; switching off clears it and a later switch-on records a new
-- moment. paused_until stops automatic requests after a request that did not
-- end accepted, so a systemic failure costs at most one business key per
-- pause; pause_count doubles the pause on consecutive failures and an
-- accepted request resets it.
CREATE TABLE ofapi_webhook_auto_redelivery_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled_at timestamptz,
  paused_until timestamptz,
  pause_count integer NOT NULL DEFAULT 0 CHECK (pause_count >= 0),
  pause_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
