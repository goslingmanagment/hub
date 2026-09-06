-- Delivery attempts are permanent facts; delivery_uuid groups retries and is
-- deliberately NOT unique. Business payloads remain in the observation journal.
CREATE TABLE ofapi_webhook_delivery_attempts (
  webhook_id text NOT NULL,
  attempt_id bigint NOT NULL,
  delivery_uuid text NOT NULL,
  event_type text NOT NULL,
  attempt_number integer NOT NULL,
  succeeded boolean NOT NULL,
  status_code integer,
  error_type text,
  idempotency_key text,
  ofapi_account_id text,
  account_refs jsonb NOT NULL DEFAULT '[]',
  redelivered_from text,
  source_created_at timestamptz NOT NULL,
  observation_id bigint NOT NULL,
  observation_received_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(webhook_id,attempt_id)
);
CREATE INDEX ofapi_webhook_delivery_group_idx ON ofapi_webhook_delivery_attempts(webhook_id,delivery_uuid);
CREATE INDEX ofapi_webhook_delivery_time_idx ON ofapi_webhook_delivery_attempts(webhook_id,source_created_at DESC,attempt_id DESC);

CREATE TABLE ofapi_webhook_delivery_scans (
  id uuid PRIMARY KEY,
  webhook_id text NOT NULL,
  credential_fingerprint text NOT NULL,
  observed_team text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','running','complete','failed')),
  next_offset integer NOT NULL DEFAULT 0,
  captured_attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK(window_start<=window_end)
);
CREATE INDEX ofapi_webhook_delivery_scan_state_idx ON ofapi_webhook_delivery_scans(webhook_id,state,created_at DESC);

CREATE TABLE ofapi_webhook_redelivery_intents (
  id uuid PRIMARY KEY,
  webhook_id text NOT NULL,
  attempt_id bigint NOT NULL,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK(state IN ('dispatching','accepted','rejected','indeterminate')),
  redelivery_uuid text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY(webhook_id,attempt_id) REFERENCES ofapi_webhook_delivery_attempts(webhook_id,attempt_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ofapi_webhook_redelivery_active_attempt_uniq
ON ofapi_webhook_redelivery_intents(webhook_id,attempt_id)
WHERE state IN ('dispatching','accepted','indeterminate');

-- Saved policy and confirmed remote application are different states. False
-- history_enabled is the default; deploy cannot start even a free new collector.
CREATE TABLE ofapi_webhook_collection_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  version bigint NOT NULL DEFAULT 0,
  desired_groups jsonb NOT NULL DEFAULT '[]',
  applied_groups jsonb NOT NULL DEFAULT '[]',
  history_enabled boolean NOT NULL DEFAULT false,
  apply_state text NOT NULL DEFAULT 'pending' CHECK(apply_state IN ('pending','applying','applied','failed')),
  apply_token uuid,
  apply_started_at timestamptz,
  applied_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ofapi_webhook_collection_policy(id) VALUES(true);
