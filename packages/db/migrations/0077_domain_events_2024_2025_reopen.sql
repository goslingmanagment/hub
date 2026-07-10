-- 0077: re-open the 2024–2025 domain_events range.
--
-- Migration 0057 created monthly partitions for 2024–2025; Stage 28 tiering
-- later exported and DETACHED every one of them into tiered_pending_drop
-- (they were near-empty: real platform facts start in 2026, and the Fansly
-- 1970 timestamp bug pushed historical DM events into pre_2024 instead).
-- The Wave-2 canonicalizer fix (asFanslyTimestamp) now dates Fansly
-- backscroll DMs correctly, so 2024/2025-dated events need a landing
-- partition again — without one every insert fails ExecFindPartition (23514)
-- and the source observation retries on every sweep, forever.
--
-- Fresh replays still carry the 0057 monthlies (tiering only detached them
-- on the deployed database), so first DETACH any that remain attached —
-- prod skips this loop entirely. DETACH only, never DROP: facts are
-- untouchable even when the partition should be empty by construction.
DO $$
DECLARE part text;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE p.relname = 'domain_events'
      AND n.nspname = 'public'
      AND c.relname ~ '^domain_events_202[45]_\d{2}$'
  LOOP
    EXECUTE format('ALTER TABLE domain_events DETACH PARTITION %I', part);
  END LOOP;
END $$;

-- YEARLY names on purpose: listTierablePartitions matches only _YYYY_MM
-- names, so these two stay hot like domain_events_pre_2024 — the tiering
-- job structurally cannot re-detach them (a re-detach is what emptied this
-- range the first time). The 1970-repair superseding events also land here:
-- their corrected occurred_at falls in this range.
CREATE TABLE "domain_events_2024" PARTITION OF "domain_events" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE "domain_events_2025" PARTITION OF "domain_events" FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
