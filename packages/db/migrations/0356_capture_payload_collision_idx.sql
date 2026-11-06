-- agency-hub:rollback-compatible — one new partial index only: the previous image never names it.
-- 0356_capture_payload_collision_idx.sql
--
-- The hourly capture-payload parity check counts catalog objects with
-- collision_ordinal > 0 (countCapturePayloadCollisions). With no index that
-- count reads every partition of capture_payload_objects (pg_stat_statements
-- on 2026-11-06, since 2026-10-10): 642 calls, 427 ms mean, 10.3 M shared
-- blocks read from outside shared_buffers — 11.5 % of all Postgres block
-- reads. Each run reads the whole catalog (1.5 M rows, 30 099 pages, 235 MB
-- over 12 partitions) to find 0 rows: no collision has ever been recorded,
-- and the catalog has had no write since 2026-11-01.
--
-- The partial index holds only the rows the count looks for: empty today, so
-- the count becomes an index scan of a few empty pages. Built on the
-- partitioned parent it lands on every partition, and a partition created
-- later (`create table … partition of`, ensureCapturePayloadCatalogPartitions)
-- gets its own copy.
--
-- The build reads the 235 MB heap once and blocks catalog inserts for that
-- second or two; reads are not blocked, and no insert has happened since
-- 2026-11-01.

set local lock_timeout = '5s';

create index if not exists capture_payload_objects_collision_idx
  on capture_payload_objects (bucket_month)
  where collision_ordinal > 0;
