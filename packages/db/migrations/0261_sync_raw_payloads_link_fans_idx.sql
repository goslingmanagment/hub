-- agency-hub:no-transaction
-- 0261: the link ↔ fan projection (0260) reads the fan sweep's journal pages
-- of one page in id order, after its cursor: once per page the sweep buys,
-- and from the start when link-fans:reproject rebuilds a page.
--
-- No index of sync_raw_payloads leads with page_id (prod 2026-10-09: 2.5M
-- rows, 991 MB), so that read would scan the heap. The three link_fans_*
-- endpoints are about 1 500 rows a day; a partial index keyed (page_id, id)
-- is small and keeps them in id order.
--
-- THE PREDICATE IS A CONTRACT WITH THE QUERY. The planner uses a partial
-- index only when the query's clauses imply its predicate; the reader
-- (packages/db/src/repositories/link-fans.ts, LINK_FAN_JOURNAL_ENDPOINTS_SQL)
-- spells the same endpoint list as constants. tests/migration-invariants
-- pins the two to the shared constant.
--
-- Same discipline as 0223: every lane writes sync_raw_payloads, so build
-- CONCURRENTLY outside a transaction, after dropping an INVALID leftover of an
-- interrupted earlier attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'sync_raw_payloads_link_fans_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists sync_raw_payloads_link_fans_idx
  on sync_raw_payloads (page_id, id)
  where endpoint in ('link_fans_tracking_subscribers', 'link_fans_tracking_spenders', 'link_fans_trial_subscribers');
