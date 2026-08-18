-- 0125: G5 slice 3a — the queryable capture fields get typed columns of their
-- own (§6.4 of investigations/storage-compaction-architecture-2026-08-11.md).
--
-- ADDITIVE ONLY, and inert for every existing row: all five columns are created
-- NULL for all of history and only new writes populate them.
--
-- THE BLOCKER THIS REMOVES. Slices 0–2 moved every reader that SERVES a capture
-- body onto the content-addressed catalog. A different class of read stayed
-- behind: SQL that digs INSIDE the inline JSON and returns a FIELD, never the
-- body. `payload->>'machineId'`, `payload->'row'->>'tx_id'`,
-- `jsonb_build_object('tips', response_payload -> 'tips')` — the read seam has
-- nothing to route for these, and each one silently starts returning NULL the
-- moment the inline column stops being written. That is the last thing standing
-- between here and pointer-only writes, so each field becomes a narrow typed
-- column, populated at INSERT time from the same parsed object the inline
-- column receives (packages/db/src/capture-queryable-fields.ts).
--
--   observations.harvest_machine_id      payload->>'machineId'
--   observations.harvest_tx_id           payload->'row'->>'tx_id'
--   observations.harvest_tx_amount       payload->'row'->>'amount'
--   observations.harvest_tx_created_at   payload->'row'->>'created_at'
--   sync_raw_payloads.response_tips      jsonb_build_object('tips', … -> 'tips')
--
-- WHY text, NOT uuid / numeric / timestamptz. These columns must accept
-- WHATEVER the payload carried, because capture-first (DP 7) outranks tidiness:
-- a harvest row whose machineId is not a uuid, or whose amount is not a number,
-- must still journal. A typed column with a parse in front of it would turn a
-- malformed captured fact into a failed capture. text also reproduces `->>`
-- byte for byte, which is what keeps the fallback below equivalent to the
-- column that replaces it.
--
-- NO BACKFILL IN THIS MIGRATION, deliberately. Every harvest row and every
-- retained DM capture that exists today keeps a NULL typed column and is found
-- through the inline fallback in the query (`coalesce(...)`, or an OR arm where
-- coalesce would defeat an index — each one marked `CAS-INLINE-FALLBACK:` in
-- the source so the removal slice can grep them). Backfilling here would mean an
-- UPDATE over the whole of `observations` — a second row version for every
-- harvested fact, on the largest table in the system, for a column nothing reads
-- yet — which is precisely the amplification this project exists to remove. The
-- HISTORICAL REWRITE slice already walks that heap to null the inline bodies; it
-- populates these columns on the same pass, from the same tuple, at no extra
-- cost, and only then may the fallbacks be deleted.
--
-- THE INDEX IS A SEPARATE MIGRATION (0126). Only one of the migrated predicates
-- is index-backed today, its index must be built CONCURRENTLY across every
-- partition, and CREATE INDEX CONCURRENTLY cannot run inside a transaction —
-- which this migration is. Same split the harvest lookup already made once
-- (0090 added the column, 0096 built the index).
--
-- LOCKING: adding nullable columns with no default is a catalog-only change,
-- but it still takes a brief ACCESS EXCLUSIVE on the parent and every
-- partition. lock_timeout keeps that brief — if a long reader holds the table
-- this aborts and the deploy retries, rather than queueing ahead of every
-- writer (the 0124 pattern).
--
-- No down-path. These columns address captured facts.

SET LOCAL lock_timeout = '2s';

ALTER TABLE "observations"
  ADD COLUMN "harvest_machine_id" text,
  ADD COLUMN "harvest_tx_id" text,
  ADD COLUMN "harvest_tx_amount" text,
  ADD COLUMN "harvest_tx_created_at" text;

ALTER TABLE "sync_raw_payloads"
  ADD COLUMN "response_tips" jsonb;
