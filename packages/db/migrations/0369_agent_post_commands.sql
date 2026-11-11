-- agency-hub:rollback-compatible — a wider capability check, looser NOT NULLs, a nullable column with its checks and index, and a new table: the previous image never writes the capability, a post_ref or a command without a publication, and never reads the new table.
-- 0369_agent_post_commands.sql
--
-- Hands on any post of a page (owner 2026-11-11): an agent key takes any post
-- of its pages off the platform's schedule — one placed there by hand too —
-- and, with the new `delete:posts`, deletes a published post, on the owner's
-- «да» for that post.
--
-- 1. `delete:posts`: deleting a published post of the key's pages.
-- 2. A Fansly cancel or delete of a post with no Hub publication: a
--    `fansly_write_commands` row without a dispatch or publication, carrying
--    the post itself (`post_ref`). Every cancel and delete now names its post,
--    and one unique index holds ONE live command per page, step and post,
--    whichever route asked for it (the owner's publication routes, an agent's
--    publication route, an agent's post route): a second exists only after the
--    first was refused, never beside one that went or may have gone.
-- 3. `agent_post_delete_slots`: a key's deletions over a rolling day, each
--    slot reserved before its command is sent (the daily ceiling,
--    AGENT_POST_DELETE_DAILY_LIMIT_PER_KEY). A slot is given back only when
--    Hub refused before any command existed; never when the outcome is
--    unknown.

set local lock_timeout = '5s';

alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications',
      'approve:vault_albums',
      'write:fan_queues',
      'read:content',
      'read:team',
      'withdraw:publications',
      'delete:posts'
    ]::text[]
  );

alter table fansly_write_commands
  alter column dispatch_id drop not null,
  alter column publication_id drop not null,
  add column post_ref text;

alter table fansly_write_commands
  -- A command belongs to a publication's dispatch, or to neither.
  add constraint fansly_write_commands_publication_pair_check check ((dispatch_id is null) = (publication_id is null)),
  -- Without a publication: only a cancel or a delete, of its named post.
  add constraint fansly_write_commands_post_only_check check (
    dispatch_id is not null or (step in ('post_cancel', 'post_delete') and item = '' and post_ref is not null)
  ),
  add constraint fansly_write_commands_post_ref_check check (
    post_ref is null or (step in ('post_cancel', 'post_delete') and post_ref ~ '^[0-9A-Za-z_-]{1,64}$')
  );

create unique index fansly_write_commands_post_once_uidx on fansly_write_commands (page_id, step, post_ref)
  where post_ref is not null and state <> 'refused';

create table agent_post_delete_slots (
  id bigserial primary key,
  agent_key_id bigint not null references agent_keys(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  platform text not null,
  post_ref text not null,
  reserved_at timestamptz not null default now(),
  -- Given back: Hub refused before any command of the post existed.
  released_at timestamptz,
  released_reason text,
  constraint agent_post_delete_slots_platform_check check (platform in ('fansly', 'onlyfans')),
  constraint agent_post_delete_slots_post_ref_check check (post_ref ~ '^[0-9A-Za-z_-]{1,64}$'),
  constraint agent_post_delete_slots_release_check check ((released_at is null) = (released_reason is null))
);

create index agent_post_delete_slots_key_idx on agent_post_delete_slots (agent_key_id, reserved_at desc)
  where released_at is null;
create index agent_post_delete_slots_page_idx on agent_post_delete_slots (page_id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on agent_post_delete_slots to read_only;
  end if;
end $$;
