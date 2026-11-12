-- agency-hub:rollback-compatible — two new tables nothing of the previous image names.
-- 0394_onlyfans_vault_lists.sql
--
-- Hub knows the vault albums of OnlyFans (8-docs 2026-11-12-of-vault-album,
-- plan PR 3). A walk on request reads every vault list of a page through
-- OnlyFansAPI (GET /media/vault/lists, 30 a page, lightweight) as owner
-- actions marked `publication_read`: each answer is journaled in
-- observations first. Not a `vault_catalog` collection job: the latest job of
-- that category says whether the whole vault was read.
--
--   onlyfans_vault_lists       every vault list of the page as last seen:
--                              its id, name, type (custom, posts, messages,
--                              stories, streams, ...) and file count.
--                              missing_since is set only by a COMPLETE walk
--                              that no longer listed it; a walk cut short
--                              marks nothing; a list seen again is not missing.
--   onlyfans_vault_list_walks  per page: the pending request (the screen's
--                              «Обновить альбомы»; the minutely OnlyFans
--                              checks job answers it), the last complete walk,
--                              the last failed or cut-short one and why.

set local lock_timeout = '5s';

create table if not exists onlyfans_vault_lists (
  page_id bigint not null references pages(id) on delete restrict,
  list_ref text not null check (list_ref ~ '^[1-9][0-9]{0,19}$'),
  name text not null,
  list_type text not null,
  media_count integer check (media_count is null or media_count >= 0),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  missing_since timestamptz,
  primary key (page_id, list_ref)
);

-- The album lookup by exact title.
create index if not exists onlyfans_vault_lists_custom_name
  on onlyfans_vault_lists (page_id, name) where list_type = 'custom' and missing_since is null;

create table if not exists onlyfans_vault_list_walks (
  page_id bigint primary key references pages(id) on delete restrict,
  requested_at timestamptz,
  requested_by_user_id bigint references users(id) on delete restrict,
  completed_at timestamptz,
  completed_requests integer,
  failed_at timestamptz,
  failure text,
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on onlyfans_vault_lists, onlyfans_vault_list_walks to read_only;
  end if;
end
$$;
