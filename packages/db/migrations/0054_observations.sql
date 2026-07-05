-- Stage 7: universal append-only observations journal (the kernel capture
-- spine). Partitioned monthly by received_at; PG requires partition-key
-- inclusion in unique constraints, so dedup lives in the unpartitioned
-- companion observation_keys (source, idempotency_key) — see the stage spec
-- status header. No FK on account_id BY DESIGN (unmapped accounts are
-- captured; integrity is the insert protocol's job). No down-path: dropping a
-- fact ledger is an owner-gated erasure, not a rollback.

CREATE TABLE "observations" (
  "id"                 bigint GENERATED ALWAYS AS IDENTITY,
  "source"             text NOT NULL CHECK ("source" IN
                         ('webhook','pull','client_capture','readthrough','command_result','operator')),
  "producer"           text NOT NULL,
  -- FK -> platforms.key arrives with Stage 18; plain text until then.
  "platform"           text,
  "account_id"         bigint,
  "native_account_ref" text,
  "kind"               text NOT NULL,
  "payload"            jsonb NOT NULL,
  "payload_hash"       bytea NOT NULL,
  "idempotency_key"    text NOT NULL,
  "observed_at"        timestamp with time zone,
  "received_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "actor_principal_id" bigint,
  "parse_version"      integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id", "received_at")
) PARTITION BY RANGE ("received_at");

CREATE INDEX "observations_account_received_idx" ON "observations" ("account_id", "received_at");
CREATE INDEX "observations_kind_received_idx"    ON "observations" ("kind", "received_at");
CREATE INDEX "observations_parse_idx"            ON "observations" ("parse_version", "received_at");

-- Dedup companion (unpartitioned): inserted in the same transaction as the
-- journal row, carrying the pre-allocated id. ON CONFLICT DO NOTHING here is
-- the duplicate signal — no journal write, no rollback (composable inside the
-- webhook receiver's transaction).
CREATE TABLE "observation_keys" (
  "source"          text NOT NULL,
  "idempotency_key" text NOT NULL,
  "observation_id"  bigint NOT NULL,
  "received_at"     timestamp with time zone NOT NULL,
  PRIMARY KEY ("source", "idempotency_key")
);

-- Initial partitions: the full deploy year (empty past months cost nothing
-- and keep clock-frozen test fixtures inside the covered range) plus runway;
-- the daily pre-create job maintains a 3-month lead thereafter and pages the
-- owner if the lead ever drops below 2 months.
CREATE TABLE "observations_2026_01" PARTITION OF "observations" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "observations_2026_02" PARTITION OF "observations" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "observations_2026_03" PARTITION OF "observations" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "observations_2026_04" PARTITION OF "observations" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "observations_2026_05" PARTITION OF "observations" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "observations_2026_06" PARTITION OF "observations" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "observations_2026_07" PARTITION OF "observations" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "observations_2026_08" PARTITION OF "observations" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "observations_2026_09" PARTITION OF "observations" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "observations_2026_10" PARTITION OF "observations" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "observations_2026_11" PARTITION OF "observations" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "observations_2026_12" PARTITION OF "observations" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Partition pre-creation failure / shrinking lead pages the owner.
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'observations_partitions';
