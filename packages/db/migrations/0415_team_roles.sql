-- agency-hub:rollback-compatible — two new tables and a trigger on one of them; the previous image never reads or writes them.
-- 0415_team_roles.sql
--
-- Teams (products plan 2026-11-13 §1 idea 4, §4.2): a team is a MODEL. A person is in the teams of the models of their
-- working pages (`person_working_pages`, not the pages their login was granted). What a person does for a team beyond
-- being in it is a record here, one table:
--
-- team_roles     kind lead     «ведёт команду»: decides the team's work matters (disputes «чья продажа» between its
--                              chatters, Gengar's disagreements), opens every shift review, leaves notes, grants view
--                              and customs on the model; never the pot, «мимо площадки», pay or access;
--                kind customs  «ведёт кастомы» of the model (the person right `customs_lead` is mirrored here for
--                              every model by the people service, its one writer);
--                kind view     «видит команду»: reads the model's team like a member, works nothing on it.
--                A record is never deleted: taking it back sets revoked_at; a new grant is a new row.
-- review_notes   a team lead's (or the owner's) note to a chatter on a shift or one chat of it: read by that chatter,
--                its author, the model's lead and the owner, never by the rest of the team.
--
-- The test realm (0414): a test person's records are of test models only, a live person's of live models only.

set local lock_timeout = '5s';

create table if not exists team_roles (
  id bigint generated always as identity primary key,
  person_id bigint not null references people(id) on delete restrict,
  model_id bigint not null references models(id) on delete restrict,
  kind text not null,
  granted_by_user_id bigint references users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_by_user_id bigint references users(id) on delete restrict,
  revoked_at timestamptz,
  constraint team_roles_kind_check check (kind in ('lead', 'customs', 'view'))
);
create unique index if not exists team_roles_live_key on team_roles (person_id, model_id, kind) where revoked_at is null;
create index if not exists team_roles_model_idx on team_roles (model_id, kind) where revoked_at is null;

comment on table team_roles is
  'Team records (0415): lead «ведёт команду», customs «ведёт кастомы», view «видит команду» of one model. Never deleted; revoked_at takes one back.';

create or replace function team_roles_same_realm() returns trigger language plpgsql as $$
begin
  if (select is_test from people where id = new.person_id) is distinct from (select is_test from models where id = new.model_id) then
    raise exception 'team_roles: a person and a model of different realms (0414)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists team_roles_same_realm on team_roles;
create trigger team_roles_same_realm before insert or update of person_id, model_id on team_roles
  for each row execute function team_roles_same_realm();

-- Today's right «ведёт кастомы» is of every model: one record per model for each person who holds it.
insert into team_roles (person_id, model_id, kind, granted_by_user_id, granted_at)
select r.person_id, m.id, 'customs', r.granted_by_user_id, r.granted_at
  from person_rights r
  join people p on p.id = r.person_id
  join models m on m.is_test = p.is_test
 where r."right" = 'customs_lead'
   and not exists (
     select 1 from team_roles t where t.person_id = r.person_id and t.model_id = m.id and t.kind = 'customs' and t.revoked_at is null
   );

create table if not exists review_notes (
  id bigint generated always as identity primary key,
  shift_id bigint not null references shifts(id) on delete restrict,
  chatter_user_id bigint not null references users(id) on delete restrict,
  -- One chat of the shift (`teamShiftReview`'s chat key); null — the note is about the whole shift.
  chat_key text,
  author_user_id bigint not null references users(id) on delete restrict,
  text text not null,
  created_at timestamptz not null default now(),
  constraint review_notes_text_check check (length(btrim(text)) between 1 and 2000)
);
create index if not exists review_notes_shift_idx on review_notes (shift_id);

comment on table review_notes is
  'A note on a shift review (0415): read by the chatter, the author, the model''s lead and the owner; not by the team.';
