-- agency-hub:rollback-compatible — a new table and a new incident kind; the previous image never names either.
-- 0298_publication_dispatches.sql
--
-- Publications (docs/plans/2026-10-23-wall-posts, plan PR 4b): every command
-- Hub sends to a platform for a publication — the post or story itself
-- ("create") and, later, its withdrawal ("withdraw"). One row per publication
-- and kind, enforced here: a publication goes to the platform at most once
-- (spec §8.1 "Один раз"), whatever the scheduler, a restart or two workers do.
--
-- On OnlyFans the command is an owner action (ofapi_action_intents), whose own
-- state machine sends it at most once and keeps the response; this row ties it
-- to the publication and the approval it was sent under.

set local lock_timeout = '5s';

-- Autostop of a page's publishing (spec §8.3) pages the owner as its own
-- incident kind, one per page (subKey = the platform).
alter type notification_incident_kind add value if not exists 'publishing_stopped';

create table publication_dispatches (
  id bigserial primary key,
  publication_id bigint not null references publications(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  revision_id bigint not null references publication_revisions(id) on delete restrict,
  kind text not null,
  platform text not null,
  ofapi_action_intent_id uuid references ofapi_action_intents(id) on delete restrict,
  -- What the command asked for: a post into the platform's schedule, a post
  -- now (its time was minutes away), or a story at its time.
  mode text not null,
  created_at timestamptz not null default now(),
  constraint publication_dispatches_kind_check check (kind in ('create', 'withdraw')),
  constraint publication_dispatches_platform_check check (platform in ('fansly', 'onlyfans')),
  constraint publication_dispatches_mode_check check (mode in ('scheduled', 'now', 'story', 'withdraw')),
  constraint publication_dispatches_ofapi_check check (platform <> 'onlyfans' or ofapi_action_intent_id is not null),
  constraint publication_dispatches_once_uniq unique (publication_id, kind)
);

create index publication_dispatches_created_idx on publication_dispatches (platform, created_at);
create index publication_dispatches_page_created_idx on publication_dispatches (page_id, created_at);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on publication_dispatches to read_only;
  end if;
end $$;
