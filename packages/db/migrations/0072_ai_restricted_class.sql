-- Kernel Stage 29: the DP 6-A restricted capture class. Every gateway
-- generation stores its prompt blocks VERBATIM, the completion, and params;
-- acceptance lifecycle events correlate by the gateway-issued generation
-- ref. Owner-only reads; excluded from lake exports; inside the Stage 28
-- erasure reach. Capture starts at deploy — forward only, no backfill.
CREATE TABLE ai_generation_content (
  id bigserial PRIMARY KEY,
  usage_event_id bigint REFERENCES ai_usage_events(id) ON DELETE RESTRICT,
  generation_ref text NOT NULL UNIQUE,
  feature text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  page_id bigint,
  conversation_ref text,
  prompt_blocks jsonb NOT NULL,
  completion text NOT NULL,
  params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_generation_content_feature_created_idx
  ON ai_generation_content (feature, created_at);
CREATE INDEX ai_generation_content_page_conversation_idx
  ON ai_generation_content (page_id, conversation_ref);

CREATE TABLE ai_acceptance_events (
  id bigserial PRIMARY KEY,
  generation_ref text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('shown', 'inserted', 'edited', 'sent')),
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  source_observation_id bigint,
  UNIQUE (generation_ref, lifecycle, occurred_at)
);
CREATE INDEX ai_acceptance_events_generation_idx ON ai_acceptance_events (generation_ref);

-- The workboard closing classifier reroutes through the gateway; its spend
-- joins the ledger under its own feature.
ALTER TYPE "ai_usage_feature" ADD VALUE IF NOT EXISTS 'workboard-closing';

-- Internal (system-initiated) gateway completions carry no chatter: NULL
-- user_id = system lane, the Stage 9 credit-ledger precedent. Client-lane
-- dedup still rides the (user_id, client_event_id) unique — system calls
-- mint UUID client ids and never rely on it.
ALTER TABLE ai_usage_events ALTER COLUMN user_id DROP NOT NULL;
