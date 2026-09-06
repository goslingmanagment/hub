-- Safe current marketing configuration. Exact responses remain captured;
-- sensitive command/postback bodies are encrypted before journaling.
CREATE TABLE ofapi_marketing_resources (
  id bigserial PRIMARY KEY,
  page_id bigint REFERENCES pages(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  upstream_id text NOT NULL,
  parent_id text NOT NULL DEFAULT '',
  data jsonb NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  credential_fingerprint text,
  observation_id bigint NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ofapi_marketing_resource_identity_idx
ON ofapi_marketing_resources(COALESCE(page_id,0),kind,parent_id,upstream_id);

CREATE TABLE ofapi_marketing_intents (
  id uuid PRIMARY KEY,
  page_id bigint REFERENCES pages(id) ON DELETE RESTRICT,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  body_encrypted text NOT NULL,
  body_hash text NOT NULL,
  preview jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('prepared','dispatching','succeeded','rejected','indeterminate')),
  response_observation_id bigint,
  error_code text,
  remote_id text,
  accounting_state text NOT NULL DEFAULT 'pending' CHECK(accounting_state IN ('pending','complete')),
  projection_state text NOT NULL DEFAULT 'pending' CHECK(projection_state IN ('pending','complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  settled_at timestamptz
);

-- Administrative configuration is projected from encrypted response observations,
-- separately from page business events. Receipt states make local repair resumable.
CREATE TABLE ofapi_marketing_projection_receipts (
  observation_id bigint PRIMARY KEY,
  page_id bigint REFERENCES pages(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1,
  projection_state text NOT NULL DEFAULT 'pending',
  accounting_state text NOT NULL DEFAULT 'pending',
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
