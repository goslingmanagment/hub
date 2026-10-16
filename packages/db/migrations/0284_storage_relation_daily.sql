-- 0284: one row per table per UTC day — its size and its write counters.
--
-- The disk check knew the filesystem and pg_database_size, but nothing kept
-- WHICH table grows, by how much a day, or which one is rewritten most:
-- every storage decision so far started with a one-off production census
-- (investigations/storage-compaction-architecture-2026-08-11.md §2, the
-- storage audit of 2026-10-16). The hourly disk check now writes this once a
-- day (services/db-disk-alert.ts → recordStorageRelationCensus).
--
-- A partitioned table is one row: its partitions roll up into their root, and
-- `partitions` says how many there were. Sizes are bytes on disk at
-- sampled_at; heap_bytes includes the free-space and visibility maps,
-- toast_bytes the TOAST table and its index. The counters are PostgreSQL's
-- cumulative pg_stat counters since its last statistics reset (a restart
-- after a crash, or an explicit reset): a day's writes are the difference
-- between two days while the counters only grew.
--
-- About two hundred narrow rows a day; kept, like the rest of ops history
-- that is too small to need a retention rule.
CREATE TABLE IF NOT EXISTS storage_relation_daily (
  sampled_on date NOT NULL,
  relation text NOT NULL,
  partitions integer NOT NULL,
  heap_bytes bigint NOT NULL,
  toast_bytes bigint NOT NULL,
  index_bytes bigint NOT NULL,
  total_bytes bigint NOT NULL,
  live_tuples bigint NOT NULL,
  dead_tuples bigint NOT NULL,
  inserts bigint NOT NULL,
  updates bigint NOT NULL,
  hot_updates bigint NOT NULL,
  deletes bigint NOT NULL,
  sampled_at timestamptz NOT NULL,
  CONSTRAINT storage_relation_daily_pkey PRIMARY KEY (sampled_on, relation)
);

-- One table's history, newest first.
CREATE INDEX IF NOT EXISTS storage_relation_daily_relation_idx
  ON storage_relation_daily (relation, sampled_on DESC);
