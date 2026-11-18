-- agency-hub:rollback-compatible — a column with a default and a nullable column on two small tables; the previous image never names them (its readers select the columns they know).
-- 0428_traffic_ledger_names_counter_page.sql
--
-- «Трафик → Источники»: what is paid to a contractor, and a source that works past links.
--
--   traffic_contractors.ledger_names   the contractor's names as the ledger's journal writes them in «Кому/Откуда»
--                                      (free text there). Hub reads what was paid from the ledger by these names and
--                                      stores no payment itself. Empty: Hub does not know whom to ask for.
--   traffic_channels.counter_page_id   a source that works past links (subscribers for subscribers on a free page):
--                                      its arrivals are that page's own counter of new subscribers
--                                      (daily_subscribers.new_subscribers). Null: the source is measured by its links.
--
-- Written only by the owner's CLI (traffic:contractors:ledger-names, traffic:channels:counter-page), audited like
-- the rest of these tables (repositories/traffic-bindings.ts). A page's erasure keeps the pages row, so the reference
-- stays; it is agency configuration, not the page's captured data. A page deleted outright clears it.
--
-- LOCKING: the foreign key to pages takes SHARE ROW EXCLUSIVE on pages for the instant of the ALTER; lock_timeout
-- keeps the wait brief — if the lock is not had in 5 s this aborts and the deploy rolls back.

set local lock_timeout = '5s';

create or replace function traffic_ledger_names_valid(names text[]) returns boolean
  language sql immutable
  as $$
    select cardinality(names) <= 20
       and not exists (select 1 from unnest(names) as name where name is null or length(btrim(name)) not between 1 and 200)
  $$;

alter table traffic_contractors add column if not exists ledger_names text[] not null default '{}';
alter table traffic_contractors drop constraint if exists traffic_contractors_ledger_names_check;
alter table traffic_contractors add constraint traffic_contractors_ledger_names_check check (traffic_ledger_names_valid(ledger_names));

alter table traffic_channels add column if not exists counter_page_id bigint references pages(id) on delete set null;

comment on column traffic_contractors.ledger_names is
  'The contractor''s names as the ledger''s journal writes them in «Кому/Откуда»: Hub reads what was paid by them (never stores it). At most 20, each 1–200 characters. Written by traffic:contractors:ledger-names.';
comment on column traffic_channels.counter_page_id is
  'A source without links: its arrivals are this page''s daily_subscribers.new_subscribers. Null: measured by its links. Written by traffic:channels:counter-page.';
