-- agency-hub:rollback-compatible — new tables and indexes, and one more value the agent_keys capability check admits; the previous image never names any of them.
-- 0297_publications.sql
--
-- Publications: wall posts Hub will publish on Fansly and OnlyFans
-- (docs/plans/2026-10-23-wall-posts, PR 1). Nothing here sends anything:
-- this is the core the sender (PR 4b, PR 6-9) and the screen (PR 2) build on.
--
--   publications               one post or story of one page: kind, text,
--                              media, publish time, price, status, author
--   publication_media          its files in order: media and paid-post
--                              previews, each from the page's vault (the
--                              platform's media id) or an uploaded file
--   publication_files          an uploaded file's identity: its model and
--                              the sha256 of its bytes. No bytes and no
--                              storage here: PR 3 adds where they live
--   publication_revisions      what a person approved, frozen: the canonical
--                              form (with the page's account, OnlyFans
--                              binding generation and model) and its sha256.
--                              Never updated
--   publication_status_events  every status change: when, from, to, who
--                              (a person, an agent key or Hub) and why
--   page_publishing_settings   per page: on/off (off by default), autostop,
--                              the paid-post price range, the repeat
--                              threshold, an optional hard daily limit
--
-- Two indexes for the repeat check (when did this file last go out on this
-- page): creator_posts.attachment_refs had none, and creator_media had none
-- by the file's media ref. Both tables are small (prod 2026-10-23:
-- creator_posts 28 MB, creator_media 39k rows), so they are built in this
-- transaction; every DDL waits at most 5 s for its lock.
--
-- agent_keys: one more capability, `write:publication_drafts` (draft
-- publications of the key's own pages; packages/contracts
-- agent-read-capabilities.ts).

set local lock_timeout = '5s';

create table publication_files (
  id bigserial primary key,
  model_id bigint not null references models(id) on delete restrict,
  content_sha256 char(64) not null,
  byte_size bigint,
  mime_type text,
  original_name text,
  created_by_user_id bigint references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint publication_files_model_content_uniq unique (model_id, content_sha256),
  constraint publication_files_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint publication_files_byte_size_check check (byte_size is null or byte_size > 0)
);

create table page_publishing_settings (
  page_id bigint primary key references pages(id) on delete cascade,
  enabled boolean not null default false,
  autostop_reason text,
  autostopped_at timestamptz,
  paid_price_min_mills bigint,
  paid_price_max_mills bigint,
  repost_threshold_days integer not null default 30,
  daily_limit integer,
  updated_by_user_id bigint references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint page_publishing_settings_price_pair_check
    check ((paid_price_min_mills is null) = (paid_price_max_mills is null)),
  constraint page_publishing_settings_price_range_check
    check (paid_price_min_mills is null or (paid_price_min_mills > 0 and paid_price_min_mills <= paid_price_max_mills)),
  constraint page_publishing_settings_repost_threshold_check
    check (repost_threshold_days between 1 and 365),
  constraint page_publishing_settings_daily_limit_check
    check (daily_limit is null or daily_limit between 1 and 10000),
  constraint page_publishing_settings_autostop_pair_check
    check ((autostop_reason is null) = (autostopped_at is null)),
  constraint page_publishing_settings_autostop_off_check
    check (not (enabled and autostopped_at is not null))
);

create table publications (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  kind text not null,
  status text not null default 'draft',
  version integer not null default 1,
  text text not null default '',
  publish_at timestamptz not null,
  expires_at timestamptz,
  wall_refs text[] not null default '{}',
  tier_refs text[] not null default '{}',
  price_mills bigint,
  repost boolean not null default false,
  -- The last draft check (spec §8.1), refreshed on every create, edit and
  -- approval attempt: [{code, severity, ...}].
  findings jsonb not null default '[]',
  author_kind text not null,
  author_user_id bigint references users(id) on delete restrict,
  author_agent_key_id bigint references agent_keys(id) on delete restrict,
  -- An agent's create is replayable: the same key and body answer the same row.
  idempotency_key text,
  approved_revision_id bigint,
  platform_post_ref text,
  status_reason text,
  previous_publication_id bigint references publications(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  constraint publications_kind_check
    check (kind in ('fyp_post', 'subscriber_post', 'paid_post', 'story')),
  constraint publications_status_check
    check (status in ('draft', 'approved', 'submitting', 'scheduled', 'processing', 'published',
                      'not_published', 'rejected', 'unknown', 'missed', 'withdrawn', 'cancelled')),
  constraint publications_version_check check (version >= 1),
  constraint publications_author_check check (
    (author_kind = 'human' and author_user_id is not null and author_agent_key_id is null)
    or (author_kind = 'agent' and author_agent_key_id is not null and author_user_id is null)
  ),
  -- A price is a paid post's and only a paid post's: mills, never zero.
  constraint publications_price_check
    check ((kind = 'paid_post') = (price_mills is not null) and (price_mills is null or price_mills > 0)),
  constraint publications_expiry_check check (expires_at is null or expires_at > publish_at),
  -- A draft carries no approval; everything past approval carries the one it
  -- was approved with (a cancelled draft never had one).
  constraint publications_approved_revision_check check (
    (status <> 'draft' or approved_revision_id is null)
    and (status in ('draft', 'cancelled') or approved_revision_id is not null)
  ),
  constraint publications_platform_post_ref_check
    check (platform_post_ref is null or length(platform_post_ref) > 0),
  constraint publications_idempotency_key_check
    check (idempotency_key is null or (author_kind = 'agent' and length(idempotency_key) between 1 and 200))
);

create index publications_page_publish_idx on publications (page_id, publish_at, id);
create index publications_status_publish_idx on publications (status, publish_at, id);
-- "It did not go out" drafts one replacement per publication.
create unique index publications_previous_uidx on publications (previous_publication_id)
  where previous_publication_id is not null;
-- One platform post is claimed by one publication of its page: a post must not
-- be counted as two publications, nor two publications pass as one post.
create unique index publications_page_platform_post_uidx on publications (page_id, platform_post_ref)
  where platform_post_ref is not null;
create unique index publications_agent_idempotency_uidx on publications (author_agent_key_id, idempotency_key)
  where idempotency_key is not null;

create table publication_media (
  publication_id bigint not null references publications(id) on delete cascade,
  role text not null,
  position integer not null,
  source text not null,
  platform_media_ref text,
  file_id bigint references publication_files(id) on delete restrict,
  constraint publication_media_pkey primary key (publication_id, role, position),
  constraint publication_media_role_check check (role in ('media', 'preview')),
  constraint publication_media_position_check check (position >= 0),
  constraint publication_media_source_check check (
    (source = 'vault' and platform_media_ref is not null and length(platform_media_ref) > 0 and file_id is null)
    or (source = 'file' and file_id is not null and platform_media_ref is null)
  )
);

create index publication_media_vault_idx on publication_media (platform_media_ref)
  where platform_media_ref is not null;
create index publication_media_file_idx on publication_media (file_id)
  where file_id is not null;

create table publication_revisions (
  id bigserial primary key,
  publication_id bigint not null references publications(id) on delete cascade,
  fingerprint char(64) not null,
  form jsonb not null,
  -- The page as approved, beside the form for the check before dispatch.
  -- No foreign keys: these are what WAS true at approval.
  page_id bigint not null,
  platform_account_ref text,
  ofapi_account_ref text,
  ofapi_binding_generation integer not null,
  model_id bigint not null,
  approved_by_user_id bigint not null references users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  constraint publication_revisions_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$')
);

create index publication_revisions_publication_idx on publication_revisions (publication_id, id);

alter table publications
  add constraint publications_approved_revision_fkey
  foreign key (approved_revision_id) references publication_revisions(id)
  deferrable initially deferred;

-- What a person approved stays exactly what they approved.
create function publication_revisions_refuse_update() returns trigger
language plpgsql as $$
begin
  raise exception 'publication_revisions rows are immutable (revision %)', old.id
    using errcode = 'restrict_violation';
end
$$;

create trigger publication_revisions_immutable
  before update on publication_revisions
  for each row execute function publication_revisions_refuse_update();

create table publication_status_events (
  id bigserial primary key,
  publication_id bigint not null references publications(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_kind text not null,
  actor_user_id bigint references users(id) on delete restrict,
  actor_agent_key_id bigint references agent_keys(id) on delete restrict,
  reason text,
  revision_id bigint references publication_revisions(id) on delete cascade,
  at timestamptz not null default now(),
  constraint publication_status_events_actor_check check (
    (actor_kind = 'human' and actor_user_id is not null and actor_agent_key_id is null)
    or (actor_kind = 'agent' and actor_agent_key_id is not null and actor_user_id is null)
    or (actor_kind = 'hub' and actor_user_id is null and actor_agent_key_id is null)
  ),
  constraint publication_status_events_status_check check (
    to_status in ('draft', 'approved', 'submitting', 'scheduled', 'processing', 'published',
                  'not_published', 'rejected', 'unknown', 'missed', 'withdrawn', 'cancelled')
    and (from_status is null or from_status in ('draft', 'approved', 'submitting', 'scheduled', 'processing',
                  'published', 'not_published', 'rejected', 'unknown', 'missed', 'withdrawn', 'cancelled'))
  )
);

create index publication_status_events_publication_idx on publication_status_events (publication_id, id);

-- The repeat check: which posts of a page carry a given attachment id.
create index creator_posts_attachment_refs_gin on creator_posts using gin (attachment_refs jsonb_path_ops);
-- ... and which Fansly offers (accountMedia) wrap a given file of the page.
create index creator_media_page_media_idx on creator_media (page_id, media_ref) where media_ref is not null;

alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts'
    ]::text[]
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on publications, publication_media, publication_files, publication_revisions,
      publication_status_events, page_publishing_settings to read_only;
  end if;
end $$;
