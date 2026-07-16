-- OF mirror S2: rebuildable per-chat coverage proof.
-- The immutable proof remains in observations/domain_events; this table is
-- only the latest serving view and can be truncated/replayed.

CREATE TABLE ofapi_message_coverage (
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  chat_id text NOT NULL,
  classification text NOT NULL,
  source text NOT NULL,
  frozen_head_id text NOT NULL,
  oldest_message_id text,
  target jsonb NOT NULL,
  target_hash char(64) NOT NULL,
  page_chain_hash char(64) NOT NULL,
  raw_count integer NOT NULL,
  accepted_count integer NOT NULL,
  boundary_duplicate_count integer NOT NULL,
  explicitly_irrelevant_count integer NOT NULL,
  rejected_count integer NOT NULL,
  parse_debt integer NOT NULL,
  required_serving_high_water bigint NOT NULL,
  proof_observation_id bigint NOT NULL,
  proof_observation_received_at timestamptz NOT NULL,
  proof_policy_version text NOT NULL,
  source_contract_version text NOT NULL,
  parser_version text NOT NULL,
  source_account_seq bigint NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, chat_id),
  CONSTRAINT ofapi_message_coverage_classification_check CHECK (
    classification IN ('continuous_history', 'verified_unavailable', 'explicit_open_debt')
  ),
  CONSTRAINT ofapi_message_coverage_source_check CHECK (
    source IN ('pagination_exhausted', 'export_artifact', 'harvest_import')
  ),
  CONSTRAINT ofapi_message_coverage_target_check CHECK (jsonb_typeof(target) = 'object'),
  CONSTRAINT ofapi_message_coverage_hash_check CHECK (
    target_hash ~ '^[0-9a-f]{64}$' AND page_chain_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ofapi_message_coverage_counts_check CHECK (
    raw_count >= 0
    AND accepted_count >= 0
    AND boundary_duplicate_count >= 0
    AND explicitly_irrelevant_count >= 0
    AND rejected_count >= 0
    AND parse_debt >= 0
    AND required_serving_high_water >= 0
    AND source_account_seq > 0
  )
);

CREATE INDEX ofapi_message_coverage_classification_idx
  ON ofapi_message_coverage (classification, page_id);
