-- 0128: G5 slice 3c-1 — a captured body may now live ONLY in the
-- content-addressed catalog (§7 of
-- investigations/storage-compaction-architecture-2026-08-11.md).
--
-- WHAT CHANGES. `observations.payload` and `sync_raw_payloads.response_payload`
-- stop being NOT NULL, and each table gains a CHECK that a row must address AT
-- LEAST ONE copy of its body:
--
--     payload IS NOT NULL OR payload_object_id IS NOT NULL
--
-- That CHECK is the core invariant of the whole slice. Dropping NOT NULL on its
-- own would make "a capture with no body anywhere" a representable state —
-- exactly the state DP 7 exists to forbid — so the two statements belong in one
-- migration and neither is meaningful without the other. What is being relaxed
-- is not "a body is required" but "the body is required IN THIS COLUMN": slices
-- 0–2 built the second location and taught every reader to resolve it, so the
-- requirement moves rather than weakens.
--
-- NOTHING IN THIS MIGRATION NULLS AN EXISTING BODY. It only makes the state
-- legal. The writer that produces it is gated by `capture_cas_pointer_only_pages`
-- (default '' = fully off) and refuses to skip the inline body unless the catalog
-- write for that same capture already succeeded and left a reference on the row.
-- The historical rewrite of rows written before this slice is 3c-2 and does not
-- ride here.
--
-- NOT VALID, and here the verification is not theoretical: every row that
-- exists at deploy time was written under the old NOT NULL, so `payload IS NOT
-- NULL` holds for all of history and the constraint is vacuously true — the
-- same argument 0124 made for the reference CHECK, but with a stronger premise
-- (a column constraint the database itself enforced, not a column this project
-- created null). Validating would scan ~35 GB of heap+TOAST for zero
-- information on a box whose free space is the reason this project exists. NOT
-- VALID does NOT weaken enforcement: PostgreSQL checks every INSERT and every
-- UPDATE against it from this moment on (verified on PG16). If a future slice
-- wants the formal validation, `ALTER TABLE … VALIDATE CONSTRAINT` takes only
-- SHARE UPDATE EXCLUSIVE and stays available.
--
-- WHAT IS DELIBERATELY LEFT NOT NULL.
--   * `observations.payload_hash` — computed by the producer from the payload
--     OBJECT before the insert (services/sync/shared.ts hashes
--     JSON.stringify(observedPayload); repositories/observations.ts writes what
--     it is handed). It never reads the inline column, so it is set identically
--     for a pointer-only row and stays the row's own fingerprint of the fact.
--   * `sync_raw_payloads.request_params`, `mapper_version`, `payload_kind`,
--     `retain_until` — envelope metadata, not derived from the body.
--   * The slice-3a typed columns (`harvest_*`, `response_tips`) are nullable
--     already and are derived from the same object, before this decision.
-- WHAT ELSE READS THESE COLUMNS AT THE SCHEMA LEVEL, checked one by one. No
-- trigger, view, generated column or CHECK anywhere in this database touches
-- either body. ONE index does: 0096's partial EXPRESSION index on
-- `observations ((payload->>'machineId'), split_part(idempotency_key,':',2))`,
-- and it needs nothing from this migration — the expression over a NULL jsonb
-- yields NULL, which indexes as a null entry rather than erroring, and slice 3a
-- already gave that lookup a typed twin (0126, `harvest_machine_id`) written at
-- capture time so a pointer-only row is found by the OTHER arm of the same
-- predicate. Everything else that digs into a body is application SQL — the
-- slice-3a fallback arms and erasure's `payload::text like` subject match — and
-- each already reads SQL NULL as "no match", which for a pointer-only row is
-- answered instead by the catalog arm landed in slice 3b.
--
-- LOCKING: both statements per table are catalog-only (DROP NOT NULL rewrites
-- nothing; a NOT VALID CHECK scans nothing), but they still take a brief ACCESS
-- EXCLUSIVE on the parent and — for `observations` — on every partition, since
-- DROP NOT NULL recurses. lock_timeout keeps that brief: if a long reader holds
-- the table this aborts and the deploy retries, rather than queueing ahead of
-- every writer in the system (§S3).
--
-- No down-path. Re-adding NOT NULL after a single pointer-only row exists would
-- fail, and "fixing" it would mean inventing a body for a row whose body is
-- elsewhere. The rollback for this slice is the flag, and the flag only governs
-- rows not yet written.

SET LOCAL lock_timeout = '2s';

ALTER TABLE "observations"
  ALTER COLUMN "payload" DROP NOT NULL;

ALTER TABLE "observations"
  ADD CONSTRAINT "observations_payload_presence_check"
  CHECK ("payload" IS NOT NULL OR "payload_object_id" IS NOT NULL)
  NOT VALID;

ALTER TABLE "sync_raw_payloads"
  ALTER COLUMN "response_payload" DROP NOT NULL;

ALTER TABLE "sync_raw_payloads"
  ADD CONSTRAINT "sync_raw_payloads_payload_presence_check"
  CHECK ("response_payload" IS NOT NULL OR "payload_object_id" IS NOT NULL)
  NOT VALID;
