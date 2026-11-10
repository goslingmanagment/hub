-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — two new indexes only: the previous image never names them.
-- 0364_ofapi_webhook_delivery_scans_idx.sql
--
-- Three frequent reads of ofapi_webhook_delivery_scans read the whole table
-- (pg_stat_user_tables on 2026-11-10: 332 780 seq scans on 6 991 rows; the
-- table grows by 120–240 rows a day, so every read gets slower):
--
-- * delivery-history coverage (getWebhookDeliveryHistoryCoverage, the
--   per-minute signal and every «new audience» read): `max(window_end) …
--   where webhook_id = $1 and state = 'complete'` and `min(created_at) …
--   where webhook_id = $1`, two seq scans, ~4 ms;
-- * the scan worker's latest scan: `… where webhook_id = $1
--   order by created_at desc limit 1`, a seq scan and a top-N sort;
-- * auto-redelivery candidates: the same `max(window_end)` frontier.
--
-- The only index, (webhook_id, state, created_at desc), serves none of them:
-- the first two need created_at for the whole webhook, the frontier needs
-- window_end. (webhook_id, created_at desc) gives the latest scan and the
-- first scan from either end; the partial (webhook_id, window_end desc) over
-- complete scans gives the frontier as its first entry.
--
-- Same discipline as 0359/0360: the scan worker writes this table every
-- minute, so build CONCURRENTLY outside a transaction (no write is blocked),
-- after dropping an INVALID leftover of an interrupted attempt. The table is
-- 2 MB: each build takes milliseconds.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname in ('ofapi_webhook_delivery_scans_webhook_created_idx', 'ofapi_webhook_delivery_scans_complete_window_idx')
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_delivery_scans_webhook_created_idx
  on ofapi_webhook_delivery_scans (webhook_id, created_at desc);

-- agency-hub:statement
create index concurrently if not exists ofapi_webhook_delivery_scans_complete_window_idx
  on ofapi_webhook_delivery_scans (webhook_id, window_end desc)
  where state = 'complete';
