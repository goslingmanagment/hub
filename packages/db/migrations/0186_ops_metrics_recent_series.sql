-- agency-hub:no-transaction
-- Bound listRecentOpsMetricSamples by stored series and requested rows, rather
-- than all retained samples: next (metric, quantile) prefix, then newest N.
-- Both prefix columns are NOT NULL and use their table/default collation.
-- Keep the existing (metric, sampled_at) and sampled_at indexes for the other
-- metric reads and retention. This is an additive, rollback-compatible index.
-- A cancelled concurrent build may leave an invalid index: remove only that
-- leftover before retrying, following 0169/0177/0184's migrator protocol.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'ops_metric_samples_series_time_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists ops_metric_samples_series_time_idx
  on ops_metric_samples (metric, quantile, sampled_at desc) include (value_ms);
