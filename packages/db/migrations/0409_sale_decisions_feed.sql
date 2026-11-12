-- agency-hub:rollback-compatible — one new table and a trigger that only writes it: the previous image never names the table, and its writes of decisions still pass.
-- 0409_sale_decisions_feed.sql
--
-- The decisions feed (review R2b-B): every change of a decision about whose a sale is, for the ledger to follow Hub
-- instead of keeping a second writer (pots, a nobody's sale given to a person, a report line's agreement).
--
-- sale_decision_changes — one row per change of a `sale_owner_decisions` row, written by its trigger in the writer's
--   own transaction, whoever the writer is (the owner's dispute, the agent's door, the import, a link, a cancel):
--   made | superseded | cancelled | linked (tied to its sale) | applied (taken into a post) | changed.
--   `seq` — its place in the feed: given when a read of the feed finds it committed, after every place given before,
--   one read at a time (the mechanism of shift_handin_feed, 0405): a change committed late gets a later place, so no
--   cursor ever passes it. Every decision written before this table has its «made» (and its «superseded» or
--   «cancelled») placed here in id order.

set local lock_timeout = '5s';

create table if not exists sale_decision_changes (
  id bigserial primary key,
  -- A page's erasure removes its decisions (erasure/index.ts): their changes go with them.
  decision_id bigint not null references sale_owner_decisions(id) on delete cascade,
  change text not null,
  at timestamptz not null default clock_timestamp(),
  seq bigint,
  constraint sale_decision_changes_change_check check (change in ('made', 'superseded', 'cancelled', 'linked', 'applied', 'changed')),
  constraint sale_decision_changes_seq_key unique (seq)
);

create index if not exists sale_decision_changes_unplaced_idx on sale_decision_changes (id) where seq is null;

create or replace function sale_decision_changed() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into sale_decision_changes (decision_id, change) values (new.id, 'made');
  elsif new.state is distinct from old.state then
    insert into sale_decision_changes (decision_id, change) values (new.id, case new.state when 'superseded' then 'superseded' when 'cancelled' then 'cancelled' else 'changed' end);
  elsif new.transaction_id is distinct from old.transaction_id then
    insert into sale_decision_changes (decision_id, change) values (new.id, 'linked');
  elsif new.applied_at is distinct from old.applied_at then
    insert into sale_decision_changes (decision_id, change) values (new.id, 'applied');
  elsif new.shares is distinct from old.shares or new.kind is distinct from old.kind or new.pot is distinct from old.pot or new.note is distinct from old.note then
    insert into sale_decision_changes (decision_id, change) values (new.id, 'changed');
  end if;
  return null;
end;
$$;

drop trigger if exists sale_decision_changed on sale_owner_decisions;
create trigger sale_decision_changed after insert or update on sale_owner_decisions
  for each row execute function sale_decision_changed();

-- The decisions already written: their «made», then how they ended, placed in id order.
insert into sale_decision_changes (decision_id, change, at)
select id, 'made', created_at from sale_owner_decisions
where not exists (select 1 from sale_decision_changes c where c.decision_id = sale_owner_decisions.id)
order by id;
insert into sale_decision_changes (decision_id, change, at)
select id, state, coalesce(superseded_at, cancelled_at, created_at) from sale_owner_decisions
where state in ('superseded', 'cancelled')
  and not exists (select 1 from sale_decision_changes c where c.decision_id = sale_owner_decisions.id and c.change = sale_owner_decisions.state)
order by id;
update sale_decision_changes c set seq = placed.seq
from (select id, row_number() over (order by id) as seq from sale_decision_changes where seq is null) placed
where c.id = placed.id;

-- sale_decision_feed_held — the changes the decisions feed held back for an agent key (a decision of a page outside
--   the key's pages): listed on every read of that key until it may read them, then served once at their own place
--   (the mechanism of shift_handin_feed_held, 0408).
create table if not exists sale_decision_feed_held (
  agent_key_id bigint not null references agent_keys(id) on delete cascade,
  change_id bigint not null references sale_decision_changes(id) on delete cascade,
  held_at timestamptz not null default clock_timestamp(),
  primary key (agent_key_id, change_id)
);
