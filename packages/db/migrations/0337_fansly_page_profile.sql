-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0337_fansly_page_profile.sql
--
-- The page's own Fansly profile, read out of `/account/me` (journaled as
-- `account_me` since 2026-07: every hour by `account.poll`, more often by the
-- page browser's site). Until now no reader parsed it; these rows are its
-- typed copy (apps/runtime/src/sync/fansly/lib/page-profile.ts), written by
-- `account.poll`'s apply and by `fansly:profile-backfill` from the journal.
--
--   fansly_page_profile_versions  one row per distinct profile CONTENT a page
--                                 showed: display name, bio, location, avatar
--                                 and banner, social links, the badges Fansly
--                                 awarded (leaderboard «Top 500 …»), pinned
--                                 posts, walls, profile flags. Seeing the same
--                                 content again only widens first/last seen,
--                                 so the order answers are applied in does not
--                                 matter; the current profile is the version
--                                 seen last.
--   fansly_page_profile_daily     the counters under the profile per UTC day,
--                                 from the day's last answer: followers,
--                                 subscribers, likes, the timeline's media
--                                 counts, stories, the stream's status, the
--                                 earnings balance (mills).
--
-- The e-mail, the online status, the other wallets and the agency's own lists
-- of the account are not copied.

set local lock_timeout = '5s';

create table if not exists fansly_page_profile_versions (
  page_id bigint not null references pages(id) on delete restrict,
  content_sha256 text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  first_observation_id bigint not null,
  last_observation_id bigint not null,
  username text,
  display_name text,
  about text,
  location text,
  avatar_media_ref text,
  banner_media_ref text,
  -- [{ providerId, handle }]
  socials jsonb not null default '[]'::jsonb,
  -- [{ badgeRef, badgeType, title, description, awardedAt }]
  badges jsonb not null default '[]'::jsonb,
  -- [{ postRef, wallRef, pos, pinnedAt }]
  pinned_posts jsonb not null default '[]'::jsonb,
  -- [{ wallRef, pos, name, description, private, mainWall, defaultWall }]
  walls jsonb not null default '[]'::jsonb,
  profile_flags integer,
  account_flags integer,
  profile_access_flags integer,
  primary key (page_id, content_sha256),
  constraint fansly_page_profile_versions_seen_check check (first_seen_at <= last_seen_at)
);

create index if not exists fansly_page_profile_versions_page_seen_idx
  on fansly_page_profile_versions (page_id, last_seen_at desc);

create table if not exists fansly_page_profile_daily (
  page_id bigint not null references pages(id) on delete restrict,
  day date not null,
  followers bigint,
  subscribers bigint,
  post_likes bigint,
  media_likes bigint,
  images bigint,
  videos bigint,
  bundles bigint,
  bundle_images bigint,
  bundle_videos bigint,
  stories integer,
  has_active_stories boolean,
  stream_status smallint,
  earnings_balance_mills bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, day)
);

comment on table fansly_page_profile_versions is
  'Fansly page profile (0337): one row per distinct profile content /account/me showed (name, bio, location, socials, badges, pinned posts, walls); first/last seen widen on every answer.';
comment on table fansly_page_profile_daily is
  'Fansly page profile (0337): the counters under the profile per UTC day, from the day''s last /account/me answer; money in mills.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_page_profile_versions, fansly_page_profile_daily to read_only;
  end if;
end $$;
