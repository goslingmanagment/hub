-- Provider aggregates are evidence, never additional ledger expenses. No retention deletes.
CREATE TABLE ofapi_vendor_usage_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id bigint NOT NULL,
  credential_fingerprint text NOT NULL,
  scope jsonb NOT NULL,
  data jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE INDEX ofapi_vendor_usage_scope_idx ON ofapi_vendor_usage_snapshots (credential_fingerprint, observed_at DESC);

-- Owner-declared restrictions of this exact server credential. These are not vendor scopes introspection.
CREATE TABLE ofapi_key_scope_declarations (
  credential_fingerprint text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  capabilities jsonb,
  account_ids jsonb,
  visibility text NOT NULL CHECK (visibility IN ('unknown','declared_team','declared_restricted')),
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ofapi_key_scope_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credential_fingerprint text NOT NULL,
  version integer NOT NULL,
  declaration jsonb NOT NULL,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (credential_fingerprint, version)
);
