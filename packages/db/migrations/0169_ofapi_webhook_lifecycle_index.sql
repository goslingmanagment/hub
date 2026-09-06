-- agency-hub:no-transaction
-- 0169: the webhook lifecycle lookup index, moved out of 0157.
--
-- 0157 originally created ofapi_webhook_lifecycle_resource_idx with a plain
-- CREATE INDEX inside the migration transaction. ofapi_webhook_events holds
-- 570k+ rows in production; an ordinary build takes ACCESS EXCLUSIVE on the
-- table for its whole duration, and every inbound OFAPI delivery would queue
-- behind it past the vendor's 10 s timeout — capture-first (DP 7) forbids
-- exactly that. The 0143 spend-candidates index is the precedent: mark the
-- migration non-transactional, drop an INVALID leftover from an interrupted
-- earlier attempt, then build CONCURRENTLY and idempotently.
--
-- The definition is unchanged from the 0157 draft: DB-only lifecycle summaries
-- look up a known resource id, never scan payloads across the whole journal.
-- The expression and predicate use only columns that exist since 0157
-- (capture_state, projection_status, payload, event_type, id), so this file
-- has no dependency on anything that follows it.

-- A backend/process failure during CREATE INDEX CONCURRENTLY leaves an INVALID
-- index behind, and `if not exists` would then skip that unusable shell
-- forever. Drop it first if (and only if) it is invalid.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'ofapi_webhook_lifecycle_resource_idx'
  and n.nspname = 'public'
  and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_lifecycle_resource_idx
  on ofapi_webhook_events ((payload->'payload'->>'id'), event_type, id desc)
  where capture_state = 'accepted' and projection_status = 'projected';
