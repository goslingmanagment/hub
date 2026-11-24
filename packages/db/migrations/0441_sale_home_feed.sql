-- agency-hub:rollback-compatible — new feed/queue tables and a trigger on sale_homes that only writes sale_home_changes; the previous image never names them and its writes of sale_homes still pass.
-- 0441_sale_home_feed.sql
--
-- The sale homes feed: every computed home in `sale_homes` (upsert or retract), for the agency ledger to follow Hub as
-- the single source of truth for whose each sale is (with the person and report day of every share).
--
-- sale_home_changes — one row per change of a `sale_homes` row, written by its trigger in the writer's own transaction.
--   No FK on `sale_homes`: a `retract` row outlives the deleted home (vanished sale or page erasure). `page_id` and
--   `is_test` are captured at trigger time so DELETEs (including page erasure) always know the page and realm.
--   `seq` — its place in the feed, assigned once committed under an advisory lock (the mechanism of 0405/0409): a
--   change committed late gets a later place, so a cursor never passes it. Every row already in `sale_homes` (including
--   rows with empty `shares`) is backfilled here as an initial consistent snapshot.
-- sale_home_feed_held — changes held back for an agent key whose page grant does not include the sale's page: listed on
--   every read until granted, then moved to a new place at the end of the feed.
-- sale_home_refresh_due — affected Moscow days queued by sale-rule input writers in their own transactions; a monotone
--   `generation` per day lets the refresh handler clear only the exact generation it computed.

set local lock_timeout = '5s';

create table if not exists sale_home_changes (
  id bigserial primary key,
  transaction_id bigint not null,
  page_id bigint not null references pages(id),
  is_test boolean not null,
  op text not null,
  at timestamptz not null default clock_timestamp(),
  seq bigint,
  constraint sale_home_changes_op_check check (op in ('upsert', 'retract')),
  constraint sale_home_changes_seq_key unique (seq)
);

create index if not exists sale_home_changes_unplaced_idx on sale_home_changes (id) where seq is null;
create index if not exists sale_home_changes_realm_seq_idx on sale_home_changes (is_test, seq) where seq is not null;

create or replace function sale_home_changed() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into sale_home_changes (transaction_id, page_id, is_test, op)
    values (new.transaction_id, new.page_id, hub_page_is_test(new.page_id), 'upsert');
  elsif tg_op = 'UPDATE' then
    if (new.page_id, new.occurred_at, new.net_mills, new.home, new.reason, new.pot, new.waits_until, new.shares, new.rule_version)
      is distinct from (old.page_id, old.occurred_at, old.net_mills, old.home, old.reason, old.pot, old.waits_until, old.shares, old.rule_version)
    then
      insert into sale_home_changes (transaction_id, page_id, is_test, op)
      values (new.transaction_id, new.page_id, hub_page_is_test(new.page_id), 'upsert');
    end if;
  elsif tg_op = 'DELETE' then
    -- During sandbox:remove the whole test realm is being torn down (including pages): never re-populate changes with test page_ids.
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm' and hub_page_is_test(old.page_id) then
      return null;
    end if;
    insert into sale_home_changes (transaction_id, page_id, is_test, op)
    values (old.transaction_id, old.page_id, hub_page_is_test(old.page_id), 'retract');
  end if;
  return null;
end;
$$;

drop trigger if exists sale_home_changed on sale_homes;
create trigger sale_home_changed after insert or update or delete on sale_homes
  for each row execute function sale_home_changed();

-- Initial consistent snapshot: every existing sale_homes row (including rows with empty shares) placed in occurred_at order.
insert into sale_home_changes (transaction_id, page_id, is_test, op, at)
select h.transaction_id, h.page_id, hub_page_is_test(h.page_id), 'upsert', h.computed_at
from sale_homes h
where not exists (select 1 from sale_home_changes c where c.transaction_id = h.transaction_id)
order by h.occurred_at, h.transaction_id;

update sale_home_changes c set seq = placed.seq
from (
  select id, (select coalesce(max(seq), 0) from sale_home_changes) + row_number() over (order by id) as seq
  from sale_home_changes where seq is null
) placed
where c.id = placed.id;

create table if not exists sale_home_feed_held (
  agent_key_id bigint not null references agent_keys(id) on delete cascade,
  change_id bigint not null references sale_home_changes(id) on delete cascade,
  held_at timestamptz not null default clock_timestamp(),
  primary key (agent_key_id, change_id)
);

create table if not exists sale_home_refresh_due (
  day date primary key,
  generation bigint not null default 1,
  queued_at timestamptz not null default clock_timestamp()
);

-- Queue every day already present in `sale_homes` so the due pass enriches pre-0441 shares with `personCode`,
-- `reportDate`, and `daySource` through the shared landing logic.
-- Deduplicate `day` BEFORE evaluating `clock_timestamp()` (which is volatile per row and breaks SELECT DISTINCT).
insert into sale_home_refresh_due (day, generation, queued_at)
select d.day, 1, clock_timestamp()
from (
  select distinct (occurred_at at time zone 'Europe/Moscow')::date as day
  from sale_homes
  where occurred_at >= '2026-11-02T00:00:00+03:00'::timestamptz
) d
on conflict (day) do update set
  generation = sale_home_refresh_due.generation + 1,
  queued_at = clock_timestamp();
