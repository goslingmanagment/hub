-- H2 (INC-001): an explicit TERMINAL outcome for observations a canonicalizer
-- can prove will never yield a safe event — today a messages.ppv.unlocked
-- notification with no chat ref, whose only fan-looking id is the creator's.
--
-- The driver still stamps parse_version on such a row (an unstamped row holds
-- the family's backlog-age gauge up forever and pages golden_signal_lag), and
-- records WHY here, in the same transaction as the stamp. Before this table
-- the row was simply "stamped with zero events", indistinguishable from an
-- ordinary empty parse.
--
-- Content-free by construction: ids, the family lane/version, the kind and a
-- fixed reason code — never payload bytes. No FK to observations: that table
-- is partitioned and tiered (partitions detach), and this is an outcome log,
-- not a child row. One row per (observation, parse version): a later parser
-- version that replays the observation records its own verdict.
CREATE TABLE IF NOT EXISTS "observation_parse_quarantine" (
  "observation_id" bigint NOT NULL,
  "parse_version" integer NOT NULL,
  "source" text NOT NULL,
  "lane" text NOT NULL,
  "kind" text NOT NULL,
  "reason_code" text NOT NULL,
  "received_at" timestamptz NOT NULL,
  "quarantined_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("observation_id", "parse_version")
);

-- The quarantine gauge counts one (source, lane, version) at a time.
CREATE INDEX IF NOT EXISTS "observation_parse_quarantine_lane_idx"
  ON "observation_parse_quarantine" ("source", "lane", "parse_version");
