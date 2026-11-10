-- agency-hub:no-transaction
-- agency-hub:rollback-compatible — a new index only: the previous image never names it.
-- 0365_message_media_offers_page_bundle_idx.sql
--
-- The ledger's sale facts (listSaleFacts, the team sales and the shift
-- review) find the page's message that carried a Fansly purchase: by the
-- offer's media id first (indexed by message_media_offers_page_offer_idx),
-- then, when that finds nothing, by the bundle id. The bundle look-up had no
-- index: a bitmap scan of the page's offers one by one, ~43 ms a sale and
-- ~33k rows thrown away each time (production, 2026-11-10: 34 of 602 Fansly
-- PPV purchases of 30 days reach it). (page_id, bundle_ref) over the rows that
-- carry a bundle (73k of 189k) turns it into an index look-up.
--
-- Same discipline as 0359/0360/0364: the capture lane writes this table all
-- the time, so build CONCURRENTLY outside a transaction (no write is
-- blocked), after dropping an INVALID leftover of an interrupted attempt.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('drop index concurrently if exists %I.%I', n.nspname, i.relname) as statement
from pg_class i
join pg_namespace n on n.oid = i.relnamespace
join pg_index x on x.indexrelid = i.oid
where i.relname = 'message_media_offers_page_bundle_idx'
  and n.nspname = 'public' and not x.indisvalid;

-- agency-hub:statement
create index concurrently if not exists message_media_offers_page_bundle_idx
  on message_media_offers (page_id, bundle_ref)
  where bundle_ref is not null;
