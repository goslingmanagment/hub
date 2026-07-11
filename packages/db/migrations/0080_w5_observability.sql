-- 0080: W5 (B8+A25+A53+A14) — observability truthfulness.
--
-- Two new incident kinds for the ops watchdog (W5.2): the api-side deadman
-- that pages when the scheduler heartbeat or the golden-signal sampler goes
-- silent — the failure mode where "no alert" used to mean "no alerting".
-- ADD VALUE inside the runner's per-file transaction is safe on PG 16: the
-- new value only can't be USED in the same transaction, and this file never
-- uses it.
ALTER TYPE notification_incident_kind ADD VALUE 'scheduler_silent';
ALTER TYPE notification_incident_kind ADD VALUE 'ops_sampler_silent';

-- A14 sampler indexes (shape per the Stage-0 E9 EXPLAIN readout, 2026-07-11:
-- tables are small — webhook 143k rows, commands 4.4k, samples 95k,
-- domain_events 190k; seq scans 2-93 ms — so these ship as hygiene, plain
-- builds, no CONCURRENTLY dance. BRIN for the time-correlated append tables
-- (pg_stats correlation 0.84-0.99), btree/partial for the bounded lookups).

-- Sampler capture-latency window: processed_at > now()-10min.
CREATE INDEX IF NOT EXISTS ofapi_webhook_events_processed_at_brin
  ON ofapi_webhook_events USING brin (processed_at);

-- W5.1 pending-age gauge: min(received_at) over the unprocessed set.
CREATE INDEX IF NOT EXISTS ofapi_webhook_events_pending_received_idx
  ON ofapi_webhook_events (received_at) WHERE processed_at IS NULL;

-- Sampler canonicalize-latency window: de.created_at > now()-10min.
-- On the partitioned parent so children inherit (190k rows today).
CREATE INDEX IF NOT EXISTS domain_events_created_at_brin
  ON domain_events USING brin (created_at);

-- Sampler command-settle window: attempt_finished_at > now()-10min.
CREATE INDEX IF NOT EXISTS ofapi_commands_attempt_finished_at_idx
  ON ofapi_commands (attempt_finished_at) WHERE attempt_finished_at IS NOT NULL;

-- Retention prune predicate (sampled_at < cutoff) — the existing
-- (metric, sampled_at DESC) index doesn't lead with sampled_at.
CREATE INDEX IF NOT EXISTS ops_metric_samples_sampled_at_idx
  ON ops_metric_samples (sampled_at);
