-- Kernel Stage 25: golden-signal samples (the acceptance instrument for the
-- multi-worker rollout). A scheduled sampler computes the five lags (capture,
-- canonicalization, projection, command settle, SSE delivery) and appends
-- p50/p95 rows minutely. Ops-class data: bounded retention rides Stage 28's
-- tiering; until then the sampler prunes rows older than 14 days.
CREATE TABLE IF NOT EXISTS ops_metric_samples (
  id bigserial PRIMARY KEY,
  metric text NOT NULL,
  value_ms bigint NOT NULL,
  quantile text NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_metric_samples_metric_time_idx
  ON ops_metric_samples (metric, sampled_at DESC);

-- Golden-signal threshold breaches ride the existing incident machinery.
ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'golden_signal_lag';
