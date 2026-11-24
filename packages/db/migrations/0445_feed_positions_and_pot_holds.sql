-- agency-hub:rollback-compatible — additional feed bookkeeping and auto-post holds.
set local lock_timeout = '5s';

create table feed_positions (
  feed text primary key,
  last_seq bigint not null
);

-- Take the writers' locks before sampling existing positions. Statement triggers
-- also capture positions assigned by the previous image during a rolling deploy.
select pg_advisory_xact_lock(hashtextextended('sale_decision_changes', 0));
select pg_advisory_xact_lock(hashtextextended('sale_home_changes', 0));
select pg_advisory_xact_lock(hashtextextended('pot_distribution_changes', 0));

insert into feed_positions select 'sale_decision_changes', coalesce(max(seq), 0) from sale_decision_changes;
insert into feed_positions select 'sale_home_changes', coalesce(max(seq), 0) from sale_home_changes;
insert into feed_positions select 'pot_distribution_changes', coalesce(max(seq), 0) from pot_distribution_changes;

create function record_feed_position() returns trigger language plpgsql as $$
declare
  placed bigint;
begin
  select max(seq) into placed from placed_rows;
  update feed_positions set last_seq = placed where feed = tg_table_name and last_seq < placed;
  return null;
end
$$;

create trigger record_feed_position after update on sale_decision_changes
  referencing new table as placed_rows for each statement execute function record_feed_position();
create trigger record_feed_position after update on sale_home_changes
  referencing new table as placed_rows for each statement execute function record_feed_position();
create trigger record_feed_position after update on pot_distribution_changes
  referencing new table as placed_rows for each statement execute function record_feed_position();

create index pot_distribution_changes_distribution_idx on pot_distribution_changes (distribution_id, id);

create table pot_auto_post_holds (
  transaction_id bigint not null references transactions(id) on delete cascade,
  pot_id bigint not null references pots(id) on delete cascade,
  participants text[] not null,
  primary key (transaction_id, pot_id)
);

-- Keep the posting's intake and sale day when a later decision or erasure changes its source.
alter table pot_distribution_parts add column sale_day date, add column intake text;

create function snapshot_pot_part_intake() returns trigger language plpgsql as $$
begin
  select (h.occurred_at at time zone 'Europe/Moscow')::date,
    case when coalesce(nullif(h.pot, ''), 'obshak') <> 'obshak' then 'explicit' else h.reason end
    into new.sale_day, new.intake from sale_homes h where h.transaction_id = new.transaction_id;
  return new;
end
$$;
create trigger snapshot_pot_part_intake before insert on pot_distribution_parts
  for each row execute function snapshot_pot_part_intake();
