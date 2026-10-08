-- agency-hub:no-transaction
-- 0250: the Spenders money stamp asks, on every Spenders read and for every
-- OFAPI-fed page in scope, whether a transactions.new delivery received since
-- the page's last spender rebuild is still on its way into the numbers
-- (getOfapiMoneyStreamStates). Those deliveries are ~0.1 % of the webhook
-- journal (~1 000 of ~790 000 rows on prod, 2026-10-08), and no existing index
-- reaches them by page and time:
--
--   - ofapi_webhook_events_page_received_idx (0184) walks every delivery of
--     the page since the rebuild — thousands a day, unbounded on a quiet page;
--   - ofapi_webhook_events_received_idx walks every delivery of every page;
--   - ofapi_webhook_events_spend_candidates_idx (0143) is keyed by id alone.
--
-- Measured on prod (read-only), the same probe on the existing indexes:
-- 115 ms for the free page two days after its last rebuild, 3.3 s for a
-- month-old bound. This partial index holds only transactions.new rows, keyed
-- the way the probe reads them, so the probe touches the page's few money
-- deliveries since the rebuild and nothing else.
--
-- The predicate is a contract with the query: it must spell
-- `event_type = 'transactions.new'` as a constant for the planner to prove the
-- index usable (tests/migration-invariants.test.ts and the plan test in
-- tests/spenders-money-as-of.integration.test.ts pin both sides).
--
-- Same discipline as 0143/0184: non-transactional, an INVALID leftover from an
-- interrupted earlier attempt is dropped first, then CONCURRENTLY and
-- idempotently, so inbound OFAPI deliveries never queue behind an ACCESS
-- EXCLUSIVE build.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'ofapi_webhook_events_transactions_page_received_idx'
  and n.nspname = 'public'
  and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_events_transactions_page_received_idx
  on ofapi_webhook_events (platform_account_id, received_at)
  where event_type = 'transactions.new';
