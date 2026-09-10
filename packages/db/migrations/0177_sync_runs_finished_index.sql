-- agency-hub:no-transaction
-- A0/T0 includes a run that starts before the report but loses an attempt
-- inside it. Pair the existing started_at index with finished_at (including
-- NULLs) so overlapping and unfinished runs do not scan telemetry retention.
-- A failed concurrent build must be removed before IF NOT EXISTS can retry.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'sync_runs_finished_idx' and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_runs_finished_idx on sync_runs (finished_at);
