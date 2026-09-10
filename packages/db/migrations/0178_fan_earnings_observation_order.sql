-- Equal provider timestamps need a replay-stable receipt order. Legacy rows
-- resolve equal-time ordering lazily through their exact source event until
-- a newer receipt or projection rebuild populates this column.
ALTER TABLE fan_earnings_stats
  ADD COLUMN source_observation_id bigint NOT NULL DEFAULT 0;
