-- agency-hub:no-transaction
-- 0143: the OFAPI spend-projection sweep stops walking the whole journal.
--
-- `sweepOfapiSpendProjections` runs `* * * * *` and asks for the next 200
-- candidates by id. Measured on prod 2026-08-23 (EXPLAIN ANALYZE, read-only):
--
--   Limit  (actual time=19391.920..19391.922 rows=0 loops=1)
--     Buffers: shared hit=211484 read=168929
--     ->  Index Scan using ofapi_webhook_events_pkey  (rows=1125)
--           Rows Removed by Filter: 571266
--
-- Nineteen seconds and ~380 000 block reads EVERY MINUTE through a 128 MB
-- shared_buffers, to return nothing: the PK walk is the only ordered path to
-- `order by id`, so the sweep re-reads all 570 k rows of the largest
-- unpartitioned table in the system to find the ~1.1 k that carry a spend
-- event type. Together with the health-floor probes (0144) these two jobs were
-- 81-89 % of all block reads on the box.
--
-- The index is PARTIAL on exactly the sweep's constant clauses and keyed by
-- `id` alone, so it serves both the filter and the ordering: the scan starts at
-- the first candidate and stops after 200.
--
-- THE PREDICATE IS A CONTRACT WITH THE QUERY. PostgreSQL may only use a partial
-- index when the query's own clauses IMPLY the predicate, and implication over
-- a list of constants is proven by structural equality — a list that differs in
-- content or in ORDER, or a query that binds the values as parameters instead
-- of constants, silently drops back to the plan above. The list is pinned in
-- ONE place (OFAPI_SPEND_PROJECTION_EVENT_TYPES in
-- packages/db/src/repositories/ofapi.ts, emitted into the query as SQL
-- constants) and tests/migration-invariants.test.ts fails if this file and that
-- constant ever disagree.
--
-- CONCURRENTLY: a partial index still evaluates its predicate over every heap
-- row, and an ordinary CREATE INDEX would hold ACCESS EXCLUSIVE on
-- ofapi_webhook_events for the duration — webhook capture (DP 7) would block
-- behind it. Not partitioned, so no per-leaf dance is needed here.

-- A backend/process failure during CREATE INDEX CONCURRENTLY leaves an INVALID
-- index behind, and `if not exists` would then skip that unusable shell
-- forever. Drop it first if (and only if) it is invalid.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'ofapi_webhook_events_spend_candidates_idx'
  and n.nspname = 'public'
  and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_events_spend_candidates_idx
  on ofapi_webhook_events (id)
  where event_type in ('transactions.new', 'messages.ppv.unlocked', 'tips.received')
    and status <> 'pending'
    and platform_account_id is not null;
