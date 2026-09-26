-- agency-hub:no-transaction
-- 0208: delivery-attempt indexes for automatic webhook redelivery (H2).
--
-- ofapi_webhook_delivery_attempts is a live table (75k rows, 49 MB on
-- 2026-09-26) written by every history page. An ordinary CREATE INDEX blocks
-- those writes for the whole build, so this file follows the 0143/0169
-- precedent: non-transactional, drop an INVALID leftover of an interrupted
-- earlier attempt, then build CONCURRENTLY and idempotently.
--
-- 1. ofapi_webhook_delivery_failed_business_idx serves the once-per-tick
--    candidate scan: failed attempts with a business key in the 7-day window.
--    THE PREDICATE IS A CONTRACT WITH THE QUERY: the scan in
--    selectOfapiAutoRedeliveryCandidates spells `not a.succeeded and
--    a.idempotency_key is not null` as SQL constants, so it implies it.
-- 2. ofapi_webhook_delivery_business_key_idx serves every per-key lookup: the
--    newest attempt of a key, its earlier/successful attempts and the
--    key-level intent guards.

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname in ('ofapi_webhook_delivery_failed_business_idx', 'ofapi_webhook_delivery_business_key_idx')
  and n.nspname = 'public'
  and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_delivery_failed_business_idx
  on ofapi_webhook_delivery_attempts (webhook_id, source_created_at)
  where not succeeded and idempotency_key is not null;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_delivery_business_key_idx
  on ofapi_webhook_delivery_attempts (webhook_id, idempotency_key)
  where idempotency_key is not null;
