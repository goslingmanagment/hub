-- agency-hub:rollback-compatible — two columns with a false default and checks and triggers that refuse only rows naming a test model or a test person; none exist before the seed, and the previous image never names them.
-- 0412_sandbox_realm.sql
--
-- The test realm (products plan 2026-11-13 §8 «Тестовая команда на проде»): a test team on production that every
-- role is accepted under, and that nothing live ever sees. Additive: nothing existing changes value.
--
-- models.is_test   the model is a test model: its pages are test pages (a page is test THROUGH its model).
-- people.is_test   the person is a test person: their logins are test logins (a login is test THROUGH its person,
--                  `person_logins`; a login without a person is live).
--
-- Both marks are fixed at birth: a model or a person never moves between the realms (the triggers refuse it), so
-- whatever was live stays live. What the database holds to (the server's realm module,
-- apps/runtime/src/services/sandbox/realm.ts, says the same first):
--   - a test person has no Telegram (no id, no handle): the people-messages outbox can never reach them;
--   - a person works, is scheduled on and opens only pages of their own realm; a login is linked to a person of the
--     realm of the pages it opens;
--   - a page never moves to a model of the other realm;
--   - an agent key's pages are all of one realm;
--   - a matter about a test page is a test person's, by name (never a role: a role is the live owner's lane);
--   - the people-messages outbox takes no message for a test login.
-- Removing the test team is the owner's word: `sandbox:remove` (apps/runtime/src/services/sandbox/remove.ts).

set local lock_timeout = '5s';

alter table models add column if not exists is_test boolean not null default false;
alter table people add column if not exists is_test boolean not null default false;

alter table people drop constraint if exists people_test_no_telegram_check;
alter table people add constraint people_test_no_telegram_check
  check (not is_test or (telegram_user_id is null and telegram_handle is null));

create index if not exists models_is_test_idx on models (id) where is_test;
create index if not exists people_is_test_idx on people (id) where is_test;

comment on column models.is_test is
  'A test model (0412): its pages are the test realm, which no live principal, feed or routine reads. Fixed at birth.';
comment on column people.is_test is
  'A test person (0412): their logins work only test pages; no Telegram. Fixed at birth.';

-- The realm of a page / person / login. Null ids are live (no page: every page's, the live realm).
create or replace function hub_page_is_test(p_page_id bigint) returns boolean
language sql stable as $$
  select coalesce((select m.is_test from pages p join models m on m.id = p.model_id where p.id = p_page_id), false)
$$;

create or replace function hub_person_is_test(p_person_id bigint) returns boolean
language sql stable as $$
  select coalesce((select is_test from people where id = p_person_id), false)
$$;

create or replace function hub_user_is_test(p_user_id bigint) returns boolean
language sql stable as $$
  select coalesce((
    select pe.is_test from person_logins pl join people pe on pe.id = pl.person_id where pl.user_id = p_user_id
  ), false)
$$;

-- A mark is fixed at birth.
create or replace function hub_realm_mark_fixed() returns trigger
language plpgsql as $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'realm mark of %.% is fixed at birth (0412)', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists models_realm_fixed on models;
create trigger models_realm_fixed before update of is_test on models
  for each row execute function hub_realm_mark_fixed();
drop trigger if exists people_realm_fixed on people;
create trigger people_realm_fixed before update of is_test on people
  for each row execute function hub_realm_mark_fixed();

-- A page never changes realm through its model.
create or replace function hub_realm_page_model() returns trigger
language plpgsql as $$
begin
  if new.model_id is distinct from old.model_id
     and (select is_test from models where id = new.model_id) is distinct from
         (select is_test from models where id = old.model_id) then
    raise exception 'page % cannot move between the live and the test realm (0412)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists pages_realm_model on pages;
create trigger pages_realm_model before update of model_id on pages
  for each row execute function hub_realm_page_model();

-- A person and a page of one realm: working pages, schedule slots.
create or replace function hub_realm_person_page() returns trigger
language plpgsql as $$
begin
  if new.page_id is not null and hub_person_is_test(new.person_id) is distinct from hub_page_is_test(new.page_id) then
    raise exception 'person % and page % are of different realms (0412)', new.person_id, new.page_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists person_working_pages_realm on person_working_pages;
create trigger person_working_pages_realm before insert or update on person_working_pages
  for each row execute function hub_realm_person_page();
drop trigger if exists person_schedule_slots_realm on person_schedule_slots;
create trigger person_schedule_slots_realm before insert or update on person_schedule_slots
  for each row execute function hub_realm_person_page();

-- A login opens only pages of its realm.
create or replace function hub_realm_user_page() returns trigger
language plpgsql as $$
begin
  if hub_user_is_test(new.user_id) is distinct from hub_page_is_test(new.platform_account_id) then
    raise exception 'login % and page % are of different realms (0412)', new.user_id, new.platform_account_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists user_page_assignments_realm on user_page_assignments;
create trigger user_page_assignments_realm before insert or update on user_page_assignments
  for each row execute function hub_realm_user_page();

-- A login linked to a person keeps the pages it opens in that person's realm, and a test person's login is never
-- an existing live login (one that already opened a live page).
create or replace function hub_realm_person_login() returns trigger
language plpgsql as $$
declare
  person_test boolean := hub_person_is_test(new.person_id);
begin
  if exists (
    select 1 from user_page_assignments upa
    where upa.user_id = new.user_id and hub_page_is_test(upa.platform_account_id) is distinct from person_test
  ) then
    raise exception 'login % opens pages of the other realm than person % (0412)', new.user_id, new.person_id
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and hub_person_is_test(old.person_id) is distinct from person_test then
    raise exception 'login % cannot move between the live and the test realm (0412)', new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists person_logins_realm on person_logins;
create trigger person_logins_realm before insert or update on person_logins
  for each row execute function hub_realm_person_login();

-- An agent key's pages are of one realm.
create or replace function hub_realm_agent_key_pages() returns trigger
language plpgsql as $$
begin
  if (select count(distinct hub_page_is_test(page_id)) from unnest(new.page_ids) as page_id) > 1 then
    raise exception 'agent key % is granted pages of both realms (0412)', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists agent_keys_realm on agent_keys;
create trigger agent_keys_realm before insert or update of page_ids on agent_keys
  for each row execute function hub_realm_agent_key_pages();

-- A matter about a test page, or waiting for a test login, is a test person's by name, and about test pages only.
create or replace function hub_realm_matter() returns trigger
language plpgsql as $$
declare
  any_test_page boolean := exists (select 1 from unnest(new.page_ids) as page_id where hub_page_is_test(page_id));
  owner_test boolean := new.owner_user_id is not null and hub_user_is_test(new.owner_user_id);
begin
  if (any_test_page or owner_test) and not (
    owner_test and not exists (select 1 from unnest(new.page_ids) as page_id where not hub_page_is_test(page_id))
  ) then
    raise exception 'matter % mixes the live and the test realm (0412)', new.reason_key
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists matters_realm on matters;
create trigger matters_realm before insert or update of page_ids, owner_user_id, owner_role on matters
  for each row execute function hub_realm_matter();

-- The people-messages outbox takes nothing for a test login.
create or replace function hub_realm_people_message() returns trigger
language plpgsql as $$
begin
  if new.recipient_user_id is not null and hub_user_is_test(new.recipient_user_id) then
    raise exception 'people message % is for a test login (0412)', new.idempotency_key
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists people_messages_realm on people_messages;
create trigger people_messages_realm before insert or update of recipient_user_id on people_messages
  for each row execute function hub_realm_people_message();

-- The seed's sales carry their own provenance, `sandbox` (sandbox/seed.ts): the list is rewritten whole, as every
-- widening does; checked without the long lock first, then validated.
alter table transactions drop constraint if exists transactions_source_check;
alter table transactions add constraint transactions_source_check
  check (source in ('onlymonster', 'ofapi:webhook', 'ofapi:rest', 'fansly:rest', 'harvest', 'chatspace:ws', 'chatspace:ledger', 'sandbox'))
  not valid;
alter table transactions validate constraint transactions_source_check;
