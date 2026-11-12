-- agency-hub:rollback-compatible — six new tables nothing of the previous image names; nothing existing changes.
-- 0384_people.sql
--
-- The people registry (ecosystem plan 2026-11-12, package A), in shadow: one
-- record per person of the agency, a human and an agent alike (and a service login's holder, kind service). A login is not
-- a person: the owner holds two logins, a content manager none, a model or a
-- contractor none at all. Nothing reads this yet but its own routes, the agent
-- feed and the one-off import; access stays where it is (`users`,
-- `user_page_assignments`, `agent_keys`).
--
-- people — one person:
--   code               the stable code: the same in ledger (`people.slug`) and /OS (the card's file name), e.g. `grisha`
--   display_name       how the agency calls the person
--   kind               human | agent | service (a server-side or test login with no person behind it)
--   role               owner | team_lead | chatter | content_manager | contractor for a human; agent for an agent;
--                      service for a service — and only for them
--   state              invited -> set_up -> working -> left
--   left_on            the day the person left; only with state left, and may stay unknown
--   telegram_user_id   the person's Telegram id (one person per id)
--   telegram_handle    the @handle without the @
--   report_tag         the tag of the person's shift report post, e.g. `#maxim` (one person per tag)
--   onboarding         the onboarding steps as noted: [{step, doneAt, note}]
--   note               the owner's line about the person
--   import_notes       what the import found that disagrees, for the owner to settle: [{code, text}]
--   origin             owner (made on the screen) | import (the one-off import) | proposal (an agent's proposal accepted)
--
-- person_logins      a Hub login (`users`) -> its person; a login belongs to one person, a person may hold several.
--                    Nothing here touches the login itself (`users.username` stays as it is: scripts match by it).
-- person_agent_keys  an agent key -> its person, always of kind agent (the composite key enforces it).
-- person_working_pages  the pages a person works, in order (the first is the main one). NOT access: who may open a
--                    page stays `user_page_assignments`.
-- person_schedule_slots  the person's shift slot by Moscow time with the days it holds: person × page (null: every page
--                    of the person; a page's own line overrides it there) × start and end minute of the Moscow day (a slot
--                    may cross midnight: end before start; end 0 is written 00:00, 1440 is 24:00) × weekdays (null: not
--                    set) × valid from / to (null: not known / open). One of the inputs of the «whose sale» rule at a
--                    shift junction (owner 2026-11-12): the shift whose slot is running.
-- person_rights      narrow rights beside the role; the first one: customs_lead («ведёт кастомы»).
--
-- Nothing here is deleted by Hub on a schedule. Pay terms live in 0385, agents' proposals in 0386.

set local lock_timeout = '5s';

create table if not exists people (
  id bigserial primary key,
  code text not null,
  display_name text not null,
  kind text not null default 'human',
  role text not null,
  state text not null default 'invited',
  left_on date,
  telegram_user_id bigint,
  telegram_handle text,
  report_tag text,
  onboarding jsonb not null default '[]'::jsonb,
  note text,
  import_notes jsonb not null default '[]'::jsonb,
  origin text not null default 'owner',
  created_by_user_id bigint references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint people_code_key unique (code),
  -- The composite target of person_agent_keys: a key's person is of kind agent, by the database.
  constraint people_id_kind_key unique (id, kind),
  constraint people_code_check check (code ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint people_display_name_check check (length(btrim(display_name)) between 1 and 200),
  constraint people_kind_check check (kind in ('human', 'agent', 'service')),
  constraint people_role_check check (
    role in ('owner', 'team_lead', 'chatter', 'content_manager', 'contractor', 'agent', 'service')
  ),
  constraint people_agent_role_check check ((kind = 'agent') = (role = 'agent')),
  constraint people_service_role_check check ((kind = 'service') = (role = 'service')),
  constraint people_state_check check (state in ('invited', 'set_up', 'working', 'left')),
  constraint people_left_on_check check (left_on is null or state = 'left'),
  constraint people_telegram_user_id_check check (telegram_user_id is null or telegram_user_id > 0),
  constraint people_telegram_handle_check check (telegram_handle is null or telegram_handle ~ '^[A-Za-z0-9_]{3,64}$'),
  constraint people_report_tag_check check (report_tag is null or report_tag ~ '^#[^\s#]{1,63}$'),
  constraint people_note_check check (note is null or length(note) <= 2000),
  constraint people_onboarding_check check (jsonb_typeof(onboarding) = 'array'),
  constraint people_import_notes_check check (jsonb_typeof(import_notes) = 'array'),
  constraint people_origin_check check (origin in ('owner', 'import', 'proposal'))
);

create unique index if not exists people_telegram_user_id_uidx on people (telegram_user_id) where telegram_user_id is not null;
create unique index if not exists people_report_tag_uidx on people (lower(report_tag)) where report_tag is not null;
create index if not exists people_updated_at_idx on people (updated_at, id);

create table if not exists person_logins (
  user_id bigint primary key references users(id) on delete restrict,
  person_id bigint not null references people(id) on delete restrict,
  linked_at timestamptz not null default now(),
  linked_by_user_id bigint references users(id) on delete restrict
);
create index if not exists person_logins_person_idx on person_logins (person_id);

create table if not exists person_agent_keys (
  agent_key_id bigint primary key references agent_keys(id) on delete restrict,
  person_id bigint not null,
  person_kind text not null default 'agent',
  linked_at timestamptz not null default now(),
  linked_by_user_id bigint references users(id) on delete restrict,
  constraint person_agent_keys_kind_check check (person_kind = 'agent'),
  constraint person_agent_keys_person_fkey foreign key (person_id, person_kind) references people (id, kind) on delete restrict
);
create index if not exists person_agent_keys_person_idx on person_agent_keys (person_id);

create table if not exists person_working_pages (
  person_id bigint not null references people(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  position smallint not null,
  added_at timestamptz not null default now(),
  primary key (person_id, page_id),
  constraint person_working_pages_position_key unique (person_id, position),
  constraint person_working_pages_position_check check (position >= 0)
);
create index if not exists person_working_pages_page_idx on person_working_pages (page_id);

create table if not exists person_schedule_slots (
  id bigserial primary key,
  person_id bigint not null references people(id) on delete restrict,
  page_id bigint references pages(id) on delete restrict,
  start_minute smallint not null,
  end_minute smallint not null,
  weekdays text[],
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by_user_id bigint references users(id) on delete restrict,
  constraint person_schedule_slots_start_check check (start_minute between 0 and 1439),
  constraint person_schedule_slots_end_check check (end_minute between 0 and 1440),
  -- A shift lasts an hour to sixteen hours (scripts/people_roster.py in /OS reads the same bounds).
  constraint person_schedule_slots_length_check check (
    ((end_minute - start_minute + 1440) % 1440) between 60 and 960
  ),
  constraint person_schedule_slots_weekdays_check check (
    weekdays is null or weekdays <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]
  ),
  constraint person_schedule_slots_dates_check check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index if not exists person_schedule_slots_person_idx on person_schedule_slots (person_id, page_id, valid_from);
create index if not exists person_schedule_slots_page_idx on person_schedule_slots (page_id) where page_id is not null;

create table if not exists person_rights (
  person_id bigint not null references people(id) on delete restrict,
  "right" text not null,
  granted_at timestamptz not null default now(),
  granted_by_user_id bigint references users(id) on delete restrict,
  primary key (person_id, "right"),
  constraint person_rights_right_check check ("right" in ('customs_lead'))
);

comment on table people is
  'The people registry (0384): one record per person of the agency, human or agent; code is the same as in ledger and /OS. Logins, keys, working pages, schedule and rights hang off it.';
comment on column people.code is 'The stable code, the same in ledger (people.slug) and /OS (the card''s file name).';
comment on column people.import_notes is 'What the one-off import found that disagrees between the sources, for the owner to settle: [{code, text}].';
comment on table person_working_pages is 'The pages a person works, in order (0 is the main one). Not access: user_page_assignments stays the access table.';
comment on table person_schedule_slots is
  'A person''s shift slot by Moscow time and the days it holds, on every page of the person (page_id null) or one page; end_minute 0 is written 00:00, 1440 is 24:00; end before start crosses midnight.';
comment on table person_rights is 'Narrow rights beside the role: customs_lead («ведёт кастомы»).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on people, person_logins, person_agent_keys, person_working_pages, person_schedule_slots, person_rights to read_only;
  end if;
end
$$;
