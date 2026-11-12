-- agency-hub:rollback-compatible — a new table and a wider check: the previous image never names the table and never writes an album's dispatch (the kind vault_album is closed for OnlyFans there and here).
-- 0397_onlyfans_vault_album_runs.sql
--
-- The executor of an OnlyFans vault album (8-docs 2026-11-12-of-vault-album,
-- plan PR 4). One album is one publication of kind `vault_album` on an
-- OnlyFans page; its own minutely queue walks it step by step: the album
-- found by its exact title or created (one attempt), what it already holds,
-- the files uploaded one at a time from the folder's end, one request that
-- adds every id, the album read back.
--
--   onlyfans_vault_album_runs  one row per album publication that started:
--                              the approval it runs under, its step, the
--                              album, the price fixed when it was admitted
--                              and what it spent, each file's state (jsonb:
--                              its upload job, media id, outcome) and the
--                              run's notes (the create's lost answer, reads).
--
-- An album's dispatch (`publication_dispatches`, mode `vault`) holds its
-- "once" like any publication's, but its writes are several owner actions and
-- upload jobs named in the run, not one action: the check admits it without
-- `ofapi_action_intent_id`.

set local lock_timeout = '5s';

create table if not exists onlyfans_vault_album_runs (
  publication_id bigint primary key references publications(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  revision_id bigint not null references publication_revisions(id) on delete restrict,
  step text not null check (step in ('album', 'contents', 'uploads', 'add', 'read', 'done')),
  album_ref text check (album_ref is null or album_ref ~ '^[1-9][0-9]{0,19}$'),
  album_existed boolean not null default false,
  price_credits integer not null check (price_credits >= 0),
  spent_credits integer not null default 0 check (spent_credits >= 0),
  action_credits integer not null default 0 check (action_credits >= 0),
  stop_reason text,
  files jsonb not null,
  notes jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The albums running now: one per page, and the price they still hold.
create index if not exists onlyfans_vault_album_runs_running
  on onlyfans_vault_album_runs (page_id) where step <> 'done';

alter table publication_dispatches drop constraint publication_dispatches_ofapi_check;
alter table publication_dispatches add constraint publication_dispatches_ofapi_check
  check (platform <> 'onlyfans' or ofapi_action_intent_id is not null or mode = 'vault');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on onlyfans_vault_album_runs to read_only;
  end if;
end
$$;
