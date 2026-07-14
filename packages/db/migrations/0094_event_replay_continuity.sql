-- A sequence gap is not proof of loss (nextval survives rollback), while a
-- deleted replayable prefix is. Cleanup therefore starts its global contiguous
-- floor at zero. The pre-upgrade stream did, however, advertise sequence
-- last_value as its current cursor; keep that consumed high-water separately so
-- a valid legacy cursor does not become "ahead" after every retained tail row
-- was cleaned. It is not a replay floor and cannot skip a retained barrier.
--
-- The table lock drains/blocks every settle UPDATE while the sequence is read.
-- A consumed-but-rolled-back value is safe here: no row can later commit at or
-- below it, and the next settle allocates a strictly larger value.
LOCK TABLE "ofapi_webhook_events" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "ofapi_fanout_replay_state" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "replay_floor" bigint DEFAULT 0 NOT NULL,
  "legacy_high_water" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ofapi_fanout_replay_state_singleton_check" CHECK ("singleton"),
  CONSTRAINT "ofapi_fanout_replay_state_floor_check" CHECK ("replay_floor" >= 0),
  CONSTRAINT "ofapi_fanout_replay_state_legacy_high_water_check" CHECK ("legacy_high_water" >= 0)
);

INSERT INTO "ofapi_fanout_replay_state" (
  "singleton",
  "replay_floor",
  "legacy_high_water"
)
SELECT
  true,
  0,
  CASE WHEN "is_called" THEN "last_value" ELSE 0 END
FROM "ofapi_webhook_events_fanout_seq";
