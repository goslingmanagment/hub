-- agency-hub:rollback-compatible — the current registry stays writable and maintains the dated records.
set local lock_timeout = '5s';

lock table person_working_pages, people in share row exclusive mode;

create table person_working_page_periods (
  person_id bigint not null references people(id) on delete cascade,
  page_id bigint not null references pages(id) on delete cascade,
  from_day date not null,
  to_day date check (to_day >= from_day),
  primary key (person_id, page_id, from_day)
);
create unique index person_working_page_current on person_working_page_periods(person_id, page_id) where to_day is null;
create trigger person_working_page_periods_realm before insert or update on person_working_page_periods
  for each row execute function hub_realm_person_page();

-- Reordering pages rewrites the current roster, so added_at cannot date a pre-existing assignment.
insert into person_working_page_periods (person_id, page_id, from_day)
select person_id, page_id, date '2026-01-01' from person_working_pages;

create function track_person_working_page() returns trigger language plpgsql as $$
declare
  day date := coalesce(nullif(current_setting('agency_hub.staffing_day', true), '')::date,
                       (statement_timestamp() at time zone 'Europe/Moscow')::date);
begin
  if tg_op = 'DELETE' then
    delete from person_working_page_periods
      where person_id = old.person_id and page_id = old.page_id and from_day >= day and to_day is null;
    update person_working_page_periods set to_day = day - 1
      where person_id = old.person_id and page_id = old.page_id and to_day is null;
  else
    -- Removing and reinserting an unchanged page (including a reorder) preserves its original start.
    update person_working_page_periods set to_day = null
      where person_id = new.person_id and page_id = new.page_id and to_day = day - 1;
    if not found then
      insert into person_working_page_periods (person_id, page_id, from_day) values (new.person_id, new.page_id, day);
    end if;
  end if;
  return null;
end
$$;
create trigger track_working_page after insert or delete on person_working_pages
  for each row execute function track_person_working_page();

-- A page may be assigned while a person is still invited. Keep the dates of actual working status independently.
create table person_working_periods (
  person_id bigint not null references people(id) on delete cascade,
  from_day date not null,
  to_day date check (to_day >= from_day),
  primary key (person_id, from_day)
);
create unique index person_working_current on person_working_periods(person_id) where to_day is null;
-- Registry edits preserve status transitions even though the old page list had no dates.
-- Imported legacy workers, and workers with no registry audit, share the roster baseline.
with history as (
  select p.id as person_id, a.id, a.event_type, a.metadata ->> 'state' as state,
    (a.created_at at time zone 'Europe/Moscow')::date as day, p.origin
  from audit_events a join people p on p.code = a.metadata ->> 'code'
  where a.event_type = 'person.created' or (a.event_type = 'person.updated' and a.metadata ? 'state')
), events as (
  select person_id, id, case when origin = 'import' and event_type = 'person.created' then date '2026-01-01' else day end as day,
    coalesce(state, 'invited') as state from history
  union all
  select p.id, 0, date '2026-01-01',
    case when p.state = 'left' and p.left_on > date '2026-01-01' then 'working' else p.state end
  from people p where not exists (select 1 from history h where h.person_id = p.id)
  union all
  select h.person_id, 0, date '2026-01-01', 'working' from history h join people p on p.id = h.person_id
  where h.origin = 'import' and h.event_type = 'person.created' and h.state = 'left' and p.left_on > date '2026-01-01'
), effective as (
  select e.person_id, e.id,
    case when e.state = 'left' and p.state = 'left' and p.left_on is not null and
      e.id = max(e.id) over (partition by e.person_id) then p.left_on else e.day end as day, e.state
  from events e join people p on p.id = e.person_id
  union all
  select p.id, 1, p.left_on, 'left' from people p
    where p.state = 'left' and p.left_on is not null and not exists (select 1 from history h where h.person_id = p.id)
), daily as (
  select distinct on (person_id, day) person_id, day, state from effective order by person_id, day, id desc
), transitions as (
  select person_id, day, state, lag(state) over (partition by person_id order by day) as previous from daily
), spans as (
  select person_id, day, state, lead(day) over (partition by person_id order by day) - 1 as last_day
  from transitions where state is distinct from previous
)
insert into person_working_periods (person_id, from_day, to_day)
select person_id, day, last_day from spans where state = 'working';

create function track_person_working_state() returns trigger language plpgsql as $$
declare
  day date := coalesce(nullif(current_setting('agency_hub.staffing_day', true), '')::date,
                       (statement_timestamp() at time zone 'Europe/Moscow')::date);
  start_day date;
begin
  if tg_op = 'UPDATE' and old.state = new.state and old.left_on is not distinct from new.left_on then return null; end if;
  if new.state = 'working' then
    -- A return on the effective departure day continues the same working period.
    update person_working_periods set to_day = null where person_id = new.id
      and from_day <= day and (to_day is null or to_day >= day - 1);
    if not found then
      insert into person_working_periods(person_id, from_day) values (new.id, day);
    end if;
  elsif tg_op = 'UPDATE' and (old.state = 'working' or (old.state = 'left' and new.state = 'left')) then
    if new.state = 'left' then day := coalesce(new.left_on, day); end if;
    select max(from_day) into start_day from person_working_periods where person_id = new.id;
    if day <= start_day then
      delete from person_working_periods where person_id = new.id and from_day = start_day;
    else
      update person_working_periods set to_day = day - 1 where person_id = new.id and from_day = start_day;
    end if;
  end if;
  return null;
end
$$;
create trigger track_working_state after insert or update of state, left_on on people
  for each row execute function track_person_working_state();

alter table sale_homes add column suggested_person_id bigint references people(id) on delete set null;
