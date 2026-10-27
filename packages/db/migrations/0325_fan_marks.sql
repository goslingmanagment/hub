-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0325_fan_marks.sql
--
-- Fan marks in the Fansly chat header (chat-extension, 2026-10-27): two
-- warnings about the open fan, read by `clientFanMarks`.
--
-- 1. «💩 Бомж»: the fan is in a Fansly user list whose label says «бомж» on
--    any of the agency's Fansly pages. `fan-lists.poll` reads each page's
--    lists every 6 hours (`/lists/account`) and walks the members of the
--    lists so labelled (`/lists/itemsnew`). The answers are in `observations`
--    first (kinds `account_lists`, `list_items`); these rows are their typed
--    copy, written by the resource's apply.
--      page_fan_lists          every list of the page, as last served
--      page_fan_list_members   a fan seen in a walked list: since when, the
--                              walk that saw him last; a full walk retires the
--                              members it did not see (is_active = false)
--      page_fan_list_walks     the page's last full walk
--
-- 2. «Блоклист»: the fan's username is named by a fansly.com link in the
--    Telegram group FANSLY BLOCKLIST (a community blacklist of Fansly
--    members), which Hub's own Telegram account reads, read-only. Only posts
--    that name at least one profile are kept.
--      fansly_blocklist_posts     a post: when, by whom, its text, its edit,
--                                 when Hub saw it gone
--      fansly_blocklist_handles   each profile a post names (key: lowercase)
--      fansly_blocklist_reader    the reader's place in the group's history
--
-- Erasure: a fan's memberships go with the fan (cascade); a page's rows with
-- the page (the erasure inventory). The blocklist is a public group's posts,
-- not a page's or a fan's capture.

set local lock_timeout = '5s';

create table if not exists page_fan_lists (
  page_id bigint not null references pages(id) on delete restrict,
  list_ref text not null,
  label text not null,
  list_type integer,
  item_count integer,
  -- False once a lists answer no longer names it.
  is_active boolean not null default true,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, list_ref)
);

create table if not exists page_fan_list_members (
  page_id bigint not null references pages(id) on delete restrict,
  list_ref text not null,
  fan_id bigint not null references fans(id) on delete cascade,
  -- The start of the current membership: the walk that first saw him there
  -- (again, after a walk had retired him).
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_seen_generation bigint not null,
  is_active boolean not null default true,
  primary key (page_id, list_ref, fan_id),
  foreign key (page_id, list_ref) references page_fan_lists (page_id, list_ref) on delete cascade
);

-- The marks read: a fan's current memberships on every page.
create index if not exists page_fan_list_members_fan on page_fan_list_members (fan_id) where is_active;

create table if not exists page_fan_list_walks (
  page_id bigint primary key references pages(id) on delete restrict,
  generation bigint not null,
  completed_at timestamptz not null,
  lists_walked integer not null,
  members_seen integer not null
);

create table if not exists fansly_blocklist_posts (
  chat_id bigint not null,
  message_id bigint not null,
  posted_at timestamptz not null,
  edited_at timestamptz,
  author_name text,
  text text not null,
  -- When a re-read of the group's newest messages no longer found it.
  deleted_at timestamptz,
  first_read_at timestamptz not null,
  read_at timestamptz not null,
  primary key (chat_id, message_id)
);

create table if not exists fansly_blocklist_handles (
  chat_id bigint not null,
  message_id bigint not null,
  handle_key text not null,
  -- As the post wrote it.
  handle text not null,
  primary key (chat_id, message_id, handle_key),
  foreign key (chat_id, message_id) references fansly_blocklist_posts (chat_id, message_id) on delete cascade,
  constraint fansly_blocklist_handles_key_check check (handle_key = lower(handle_key) and length(handle_key) between 1 and 64)
);

create index if not exists fansly_blocklist_handles_key on fansly_blocklist_handles (handle_key);

create table if not exists fansly_blocklist_reader (
  chat_id bigint primary key,
  -- The newest and the oldest message read; the backfill goes on below the oldest.
  head_message_id bigint,
  tail_message_id bigint,
  backfill_done_at timestamptz,
  -- The last run that read the group to its end.
  read_at timestamptz,
  -- Telegram asked to wait (FLOOD_WAIT) until then.
  flood_until timestamptz,
  messages_read bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table page_fan_lists is
  'Fan marks (0325): the Fansly user lists of a page as /lists/account last served them.';
comment on table page_fan_list_members is
  'Fan marks (0325): fans seen in a page''s user list labelled «бомж» (/lists/itemsnew); a full walk retires the members it did not see.';
comment on table fansly_blocklist_posts is
  'Fan marks (0325): posts of the Telegram group FANSLY BLOCKLIST that name a fansly.com profile, read by Hub''s own account.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on page_fan_lists, page_fan_list_members, page_fan_list_walks,
      fansly_blocklist_posts, fansly_blocklist_handles, fansly_blocklist_reader to read_only;
  end if;
end $$;
