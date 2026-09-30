-- agency-hub:no-transaction
-- 0223: two sync readers stop scanning whole journals for a handful of rows.
--
-- Prod, 2026-09-30 (plain EXPLAIN, pg_stat_statements since 2026-09-12):
--
-- 1. sync_raw_payloads_purchase_history_idx — every purchase_history chunk
--    reads its captures, its contract-probe pages and its storm verdicts
--    (listFanslyPurchaseHistoryCaptures x2, listFanslyPurchaseHistoryStormVerdicts)
--    by `page_id = $1 and endpoint = <x> order by id`. No index leads with
--    either column, so each is a Seq Scan + Sort of the 788 MB heap (2.5M
--    rows): 1.1k + 550 calls, 0.8-1.1 s mean, 25 s max, three per chunk before
--    any egress. The three endpoints are ~13k rows, so a partial index keyed
--    (page_id, endpoint, id) is under a megabyte and keeps them in id order.
--
--    THE PREDICATE IS A CONTRACT WITH THE QUERIES. The planner uses a partial
--    index only when a query's clauses imply its predicate. The storm read
--    spells its endpoint as a constant; the capture read binds it, which works
--    because node-postgres sends unnamed statements and those are always
--    planned with the bound value. A purchase-history endpoint read this way
--    must be added to the list; tests/migration-invariants.test.ts pins it to
--    the lane's constants.
--
-- 2. sync_http_attempts_dm_group_idx — the dm_messages 5xx breaker
--    (countRecentTerminalDmMessageConversationFailureStreak) reads one
--    thread's attempts by `page_id, stream = 'dm_messages', operation =
--    'messages', request_shape ->> 'groupId' = $2`, with no time bound, while
--    the dm_messages lease is held: a Seq Scan of the 598 MB heap, ~3 s mean,
--    38 s max. The index matches the query's constant clauses and expression
--    (~76k rows).
--
-- Same discipline as 0169/0177/0184: every lane writes both tables, so build
-- CONCURRENTLY outside a transaction, after dropping an INVALID leftover of an
-- interrupted earlier attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname in ('sync_raw_payloads_purchase_history_idx', 'sync_http_attempts_dm_group_idx')
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_raw_payloads_purchase_history_idx
  on sync_raw_payloads (page_id, endpoint, id)
  where endpoint in ('purchase_history', 'purchase_history_contract_probe', 'purchase_history_contract_storm');

-- agency-hub:statement
create index concurrently if not exists sync_http_attempts_dm_group_idx
  on sync_http_attempts (page_id, (request_shape ->> 'groupId'))
  where stream = 'dm_messages' and operation = 'messages';
