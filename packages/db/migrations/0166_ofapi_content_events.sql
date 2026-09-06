-- S11a: vendor queue evidence is independent of individual-message command custody.
CREATE TABLE ofapi_chat_queue_state (
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  queue_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('updated','finished')),
  queue_date timestamptz,
  state jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  source_event_id bigint NOT NULL,
  source_observation_id bigint NOT NULL,
  PRIMARY KEY(page_id,queue_id)
);
CREATE INDEX ofapi_chat_queue_state_page_observed_idx ON ofapi_chat_queue_state(page_id,observed_at DESC);
COMMENT ON TABLE ofapi_chat_queue_state IS 'Rebuildable OFAPI queue flags and progress evidence, never proof of a recipient send';
