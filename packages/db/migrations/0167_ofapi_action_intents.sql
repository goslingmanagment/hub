-- Explicit owner actions share frozen custody and exactly one physical dispatch.
-- Anonymous admitted identities survive erasure to prevent a second dispatch.
CREATE TABLE ofapi_action_identities (id uuid PRIMARY KEY);

CREATE TABLE ofapi_action_intents (
 id uuid PRIMARY KEY,
 page_id bigint NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
 actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action text NOT NULL,
 body_hash text NOT NULL,
 body_encrypted text NOT NULL,
 subject_refs text[] NOT NULL DEFAULT '{}',
 state text NOT NULL CHECK(state IN ('prepared','dispatching','confirmed','partial','rejected','indeterminate','cancelled')),
 estimated_credits integer NOT NULL CHECK(estimated_credits >= 0),
 actual_credits integer,
 reserved_day date,
 reservation_settled boolean NOT NULL DEFAULT false,
 ledger_enabled boolean NOT NULL DEFAULT false,
 response_observation_id bigint,
 result_encrypted text,
 remote_id text,
 error_code text,
 accounting_state text NOT NULL DEFAULT 'pending' CHECK(accounting_state IN ('pending','complete')),
 created_at timestamptz NOT NULL DEFAULT now(),
 dispatched_at timestamptz,
 settled_at timestamptz
);
CREATE INDEX ofapi_action_page_created_idx ON ofapi_action_intents(page_id,created_at DESC);
-- The existing account/token key arbitrates uploads across chat and owner actions.
ALTER TABLE ofapi_media_token_custody ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE ofapi_media_token_custody ADD COLUMN action_intent_id uuid REFERENCES ofapi_action_intents(id) ON DELETE CASCADE;
ALTER TABLE ofapi_media_token_custody ADD CONSTRAINT ofapi_media_token_custody_owner_check
 CHECK ((command_id IS NULL) <> (action_intent_id IS NULL));
