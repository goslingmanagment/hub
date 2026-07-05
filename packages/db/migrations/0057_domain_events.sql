-- Stage 8: canonical domain_events log — the queryable vocabulary layer over
-- the Stage 7 observations journal. Partitioned monthly by occurred_at
-- (provider timestamps: backfills reach 2024, so historical partitions exist
-- from the earliest known fact plus a MINVALUE catch-all). Same
-- partitioned-unique limitation as 0054: uniqueness lives in the
-- unpartitioned companions — domain_event_keys (cross-producer dedup) and
-- domain_event_seq (gapless per-account ordering under a counter-row lock).
-- No FK on observation_id BY DESIGN (no FK across partitions; integrity is
-- the append protocol's job). No down-path: a derived-events ledger is
-- rebuildable by replay, but dropping it live is an owner call.

CREATE TABLE "domain_events" (
  "id"               bigint GENERATED ALWAYS AS IDENTITY,
  "account_id"       bigint NOT NULL,
  "account_seq"      bigint NOT NULL,
  "type"             text NOT NULL,
  "occurred_at"      timestamp with time zone NOT NULL,
  -- Platform-native fan id; platform_identities FK arrives with Stage 18+.
  "fan_identity_ref" text,
  "conversation_ref" text,
  "message_ref"      text,
  "transaction_ref"  text,
  "data"             jsonb NOT NULL,
  "schema_version"   integer NOT NULL,
  "observation_id"   bigint NOT NULL,
  "dedup_key"        text NOT NULL,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

CREATE INDEX "domain_events_account_seq_idx"   ON "domain_events" ("account_id", "account_seq");
CREATE INDEX "domain_events_type_occurred_idx" ON "domain_events" ("type", "occurred_at");

-- Cross-producer dedup companion: inserted in the same transaction carrying
-- the pre-allocated event id; ON CONFLICT DO NOTHING = duplicate signal.
CREATE TABLE "domain_event_keys" (
  "account_id"  bigint NOT NULL,
  "dedup_key"   text NOT NULL,
  "event_id"    bigint NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("account_id", "dedup_key")
);

-- Per-account gapless sequence counter; appendDomainEvents takes FOR UPDATE
-- on the account row for the whole batch, so seq assignment is serial per
-- account under any job/worker concurrency.
CREATE TABLE "domain_event_seq" (
  "account_id" bigint PRIMARY KEY,
  "next_seq"   bigint NOT NULL DEFAULT 1
);

-- Historical range: earliest known fact is 2024 (transaction backfills), so
-- partitions cover 2024-01 through the deploy horizon + runway; anything
-- older than 2024 lands in the MINVALUE catch-all. The daily pre-create job
-- (Stage 7''s, now managing both tables) maintains a 3-month lead thereafter.
CREATE TABLE "domain_events_pre_2024" PARTITION OF "domain_events" FOR VALUES FROM (MINVALUE) TO ('2024-01-01');

CREATE TABLE "domain_events_2024_01" PARTITION OF "domain_events" FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE "domain_events_2024_02" PARTITION OF "domain_events" FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE "domain_events_2024_03" PARTITION OF "domain_events" FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
CREATE TABLE "domain_events_2024_04" PARTITION OF "domain_events" FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');
CREATE TABLE "domain_events_2024_05" PARTITION OF "domain_events" FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');
CREATE TABLE "domain_events_2024_06" PARTITION OF "domain_events" FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE "domain_events_2024_07" PARTITION OF "domain_events" FOR VALUES FROM ('2024-07-01') TO ('2024-08-01');
CREATE TABLE "domain_events_2024_08" PARTITION OF "domain_events" FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');
CREATE TABLE "domain_events_2024_09" PARTITION OF "domain_events" FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');
CREATE TABLE "domain_events_2024_10" PARTITION OF "domain_events" FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
CREATE TABLE "domain_events_2024_11" PARTITION OF "domain_events" FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
CREATE TABLE "domain_events_2024_12" PARTITION OF "domain_events" FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
CREATE TABLE "domain_events_2025_01" PARTITION OF "domain_events" FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE "domain_events_2025_02" PARTITION OF "domain_events" FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE "domain_events_2025_03" PARTITION OF "domain_events" FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE "domain_events_2025_04" PARTITION OF "domain_events" FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE "domain_events_2025_05" PARTITION OF "domain_events" FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE "domain_events_2025_06" PARTITION OF "domain_events" FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE "domain_events_2025_07" PARTITION OF "domain_events" FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE "domain_events_2025_08" PARTITION OF "domain_events" FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE "domain_events_2025_09" PARTITION OF "domain_events" FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE "domain_events_2025_10" PARTITION OF "domain_events" FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE "domain_events_2025_11" PARTITION OF "domain_events" FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE "domain_events_2025_12" PARTITION OF "domain_events" FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE "domain_events_2026_01" PARTITION OF "domain_events" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "domain_events_2026_02" PARTITION OF "domain_events" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "domain_events_2026_03" PARTITION OF "domain_events" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "domain_events_2026_04" PARTITION OF "domain_events" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "domain_events_2026_05" PARTITION OF "domain_events" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "domain_events_2026_06" PARTITION OF "domain_events" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "domain_events_2026_07" PARTITION OF "domain_events" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "domain_events_2026_08" PARTITION OF "domain_events" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "domain_events_2026_09" PARTITION OF "domain_events" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "domain_events_2026_10" PARTITION OF "domain_events" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "domain_events_2026_11" PARTITION OF "domain_events" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "domain_events_2026_12" PARTITION OF "domain_events" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
