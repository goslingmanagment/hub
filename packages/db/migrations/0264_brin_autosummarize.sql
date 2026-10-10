-- agency-hub:no-transaction
-- 0264: every BRIN index summarizes a page range as soon as the next one opens.
--
-- A BRIN range is summarized only when something asks: VACUUM,
-- brin_summarize_new_values(), or, with autosummarize, autovacuum as soon as an
-- insert opens the next range. No BRIN index here had autosummarize, so every
-- range written since a table's last vacuum stayed unsummarized, and a scan
-- reads an unsummarized range whole. On prod (2026-10-10) the minutely
-- canonicalize sample (golden-signals.ts: `domain_events.created_at` within the
-- last 10 minutes) read ~27 000 pages of domain_events_2026_10 written since
-- its last autovacuum, plus the tail of every older partition (events of old
-- occurred_at months are appended today): ~200 MB a run, 73% of the blocks the
-- database read in that window. domain_events is insert-only and its heap
-- follows created_at (correlation 0.997), so summarized ranges are tight.
--
-- Each statement runs in its own transaction:
-- 1. switch autosummarize on. ALTER INDEX takes ACCESS EXCLUSIVE on the index
--    (not the table), and every insert into the partition opens that index, so
--    each switch waits at most 1 s for its lock and then retries, instead of
--    queueing writes behind a long reader;
-- 2. summarize what is already written. brin_summarize_new_values reads only
--    unsummarized ranges, under SHARE UPDATE EXCLUSIVE (no conflict with reads
--    or writes). Old partitions receive too few inserts for autovacuum to reach
--    their tails for months.
--
-- Postgres keeps no storage options on a partitioned index, and a partition
-- created later clones the parent's: ensureDomainEventPartitions switches each
-- new partition's BRIN itself. A new BRIN index must be created
-- `with (autosummarize = on)`; tests/brin-autosummarize.integration.test.ts
-- fails otherwise.
-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format(
  $statement$do $do$
begin
  for attempt in 1..40 loop
    begin
      set local lock_timeout = '1s';
      alter index %1$I.%2$I set (autosummarize = on);
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock index %%.%% to switch autosummarize on', %1$L, %2$L;
end
$do$$statement$,
  n.nspname,
  c.relname
) as statement
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_am am on am.oid = c.relam
where c.relkind = 'i'
  and am.amname = 'brin'
  and n.nspname = 'public'
  and not exists (
    select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as o(option)
    where o.option in ('autosummarize=on', 'autosummarize=true')
  )
order by c.relname;

-- agency-hub:statement
-- agency-hub:execute-returned-statements
select format('select brin_summarize_new_values(%L::regclass)', format('%I.%I', n.nspname, c.relname)) as statement
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_am am on am.oid = c.relam
where c.relkind = 'i'
  and am.amname = 'brin'
  and n.nspname = 'public'
order by c.relname;
