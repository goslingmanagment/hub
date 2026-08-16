-- 0124: G5 slice 1 — the envelope references into the content-addressed
-- capture payload catalog (§6.3 of
-- investigations/storage-compaction-architecture-2026-08-11.md).
--
-- ADDITIVE ONLY, and inert until a page is named in the
-- `capture_cas_dual_write_pages` setting (default '' = fully off). The inline
-- bodies — observations.payload and sync_raw_payloads.response_payload — REMAIN
-- THE AUTHORITY. Nothing reads these columns to serve a payload in this slice;
-- the only reader is the bounded parity verifier
-- (packages/db/src/repositories/capture-payload-parity.ts), which compares the
-- catalog copy against the inline authority and never repairs either one.
--
--   observations.(payload_bucket_month, payload_object_id)
--   sync_raw_payloads.(payload_bucket_month, payload_object_id)
--
-- ofapi_webhook_events keeps its two pairs (parsed_*, raw_*) for a later slice:
-- exact wire bytes need the exact_bytes representation and a webhook seam of
-- their own, and mixing that into the pull-capture canary would widen the blast
-- radius of the first writer for no extra evidence.
--
-- WHY THERE IS NO FOREIGN KEY, deliberately.
-- The catalog's primary key is the composite (bucket_month, object_id) of a
-- PARTITIONED table. PostgreSQL 16 will accept a foreign key to it, so this is
-- a choice, not a limitation:
--   * every insert into `observations` and `sync_raw_payloads` — the two
--     largest and hottest write paths in the system, ~34k rows/day and ~19 GB
--     of TOAST between them — would pay a referential check against a
--     partitioned parent, i.e. a partition lookup plus an index probe, on the
--     path that must never slow down (capture-first, DP 7);
--   * an FK also takes a lock on the referenced partition, which puts the
--     catalog's future partition maintenance (detach/attach for the cold tier)
--     in the way of live capture;
--   * the failure the FK would prevent — a ref pointing at an object that is
--     not there — is exactly what the parity verifier already looks for, on a
--     bounded sample, and reports as an incident rather than as a capture
--     failure. A dangling ref must never cost us the captured fact.
-- Slice 0 made the same call in the other direction: the bodies DO carry an FK
-- to the catalog (they are small, low-rate, and a body without its identity row
-- is unreadable by construction), while the envelope side is left to the
-- verifier. Same reasoning, applied per write-rate.
--
-- The two-directional CHECK is the invariant that IS enforced in the database:
-- a half-set reference (a month with no object, or an object with no month) is
-- an address that cannot be resolved — silent unreachability wearing the shape
-- of a valid row. Mirrors capture_payload_locations' locator CHECK from 0123.
--
-- NOT VALID, and never validated: both columns are created NULL for every row
-- that already exists, so the constraint is vacuously true for all of history —
-- validating it would scan ~35 GB of heap+TOAST across both tables for zero
-- information, on a box whose free space is the reason this project exists.
-- NOT VALID does NOT weaken enforcement: PostgreSQL checks every INSERT and
-- every UPDATE against it from this moment on (verified on PG16). If a future
-- slice ever wants the formal validation, `ALTER TABLE … VALIDATE CONSTRAINT`
-- takes only SHARE UPDATE EXCLUSIVE and stays available.
--
-- NO INDEXES on these columns in this slice, on purpose. This is a WRITE-ONLY
-- stage: no query resolves a payload through them, and the parity verifier
-- deliberately samples by scanning a BOUNDED window of the most recent rows in
-- primary-key order (a backward index scan capped at a few thousand rows), so
-- it needs no index of its own. A partial index would be small, but an index
-- on a column nothing reads is bloat we would then have to justify removing —
-- and it would have to be created on every observations partition. The pointer
-- slice, which does resolve reads through these columns, is where an index is
-- earned by a real query plan.
--
-- LOCKING: adding a nullable column with no default and a NOT VALID check is a
-- catalog-only change, but it still takes a brief ACCESS EXCLUSIVE on the
-- parent and every partition. lock_timeout keeps that brief: if a long reader
-- holds the table, this aborts and the deploy retries rather than queueing
-- behind it and stalling every writer in the meantime (§S3).
--
-- No down-path. These columns address captured facts; dropping them is an
-- owner-gated act, not a rollback.

SET LOCAL lock_timeout = '2s';

ALTER TABLE "observations"
  ADD COLUMN "payload_bucket_month" date,
  ADD COLUMN "payload_object_id" bigint;

ALTER TABLE "observations"
  ADD CONSTRAINT "observations_payload_ref_check"
  CHECK (("payload_bucket_month" IS NULL) = ("payload_object_id" IS NULL))
  NOT VALID;

ALTER TABLE "sync_raw_payloads"
  ADD COLUMN "payload_bucket_month" date,
  ADD COLUMN "payload_object_id" bigint;

ALTER TABLE "sync_raw_payloads"
  ADD CONSTRAINT "sync_raw_payloads_payload_ref_check"
  CHECK (("payload_bucket_month" IS NULL) = ("payload_object_id" IS NULL))
  NOT VALID;

-- The parity verifier's alarm. A mismatch between an inline body and its
-- catalog copy is an INTEGRITY fact, not a capacity one: reusing db_disk_usage
-- or observations_partitions would page the owner with a false story about
-- which subsystem is broken. Latched per condition through the incident layer's
-- subKey, like every other global check.
--
-- Added here (rather than in slice 0) because this is the slice that turns on
-- the first writer — until now the kind would have paged about nothing. This is
-- also the incident kind the collision path in
-- repositories/capture-payloads.ts settlePayloadObject will use when it is
-- wired: a non-empty candidate set with no matching body IS a sha256 collision
-- inside one scope+month and must page.
ALTER TYPE "notification_incident_kind"
  ADD VALUE IF NOT EXISTS 'capture_payload_parity';
