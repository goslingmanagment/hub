-- agency-hub:rollback-compatible — new tables and a wider queue-plane check; the previous image never names them.
-- 0293_fansly_creator_stats_media.sql
--
-- Fansly's creator statistics of 2026-10 (`/account/stats/*`, map:
-- reference/fansly-creator-stats §5.3–5.4), the media plane: what the
-- `creator-stats.media-top` poll reads from `/account/stats/media/top` and the
-- `creator-stats.media` walk reads per media offer from `/account/stats/media`.
-- The answer is in `observations` first (kinds `creator_stats_media_top`,
-- `creator_stats_media`); these rows are its typed copy, written by the
-- resource's apply.
--
--   fansly_creator_stats_media_daily        `media[].daily[]`: per offer, media,
--                                           surface (`source` as served) and UTC
--                                           day, every counter served
--   fansly_creator_stats_media_hourly       `media[].hours[]`: the same counters
--                                           per hour (no unique viewers); Fansly
--                                           keeps about two days of them
--   fansly_creator_stats_media_totals       `media[].totals` + retention: the
--                                           all-time figure of one surface as
--                                           served on a UTC day (it changes, so
--                                           it is a dated snapshot)
--   fansly_creator_stats_media_tags         `media[].tags[]`: a viewer tag's
--                                           totals over one asked window
--   fansly_creator_stats_media_tag_series   `tagSeries[]`: a tag's views a day
--   fansly_creator_stats_media_likes        `likes[]`: likes and unlikes of an
--                                           offer per surface and day
--   fansly_creator_stats_media_top          `/account/stats/media/top`: the
--                                           ranking of one surface and window
--                                           (`media_type` 0 = both kinds)
--
-- Fansly sends a row only for a bucket with activity: no row inside a window
-- the walk read (the queue row's `backfill_cursor.through` per surface, the
-- coverage plane `creator_stats_media`) is a zero. Codes (source, media type,
-- tag kind) are stored as served; labels are read-time. A row is replaced only
-- by an answer received at the same instant or later (`captured_at`, then
-- `observation_id`).
--
-- The walk's queue is `subject_refresh_state` plane `creator_stats_media` (one
-- row per media offer): the check of its planes widens by that one name.

set local lock_timeout = '5s';

alter table subject_refresh_state drop constraint subject_refresh_state_plane_check;
alter table subject_refresh_state add constraint subject_refresh_state_plane_check check (plane in (
  'media_stats', 'post_replies', 'post_engagement', 'of_post_stats',
  'fan_earnings_lifetime', 'fan_earnings_monthly', 'fan_earnings_attribution', 'fansly_ws_dm',
  'creator_stats_media'
));

create table if not exists fansly_creator_stats_media_daily (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  media_id text not null,
  source smallint not null,
  day date not null,
  media_type smallint,
  views bigint,
  impressions bigint,
  unique_viewers bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  replays bigint,
  duration_ms bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, media_id, source, day)
);

create table if not exists fansly_creator_stats_media_hourly (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  media_id text not null,
  source smallint not null,
  hour_start timestamptz not null,
  media_type smallint,
  views bigint,
  impressions bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  replays bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, media_id, source, hour_start)
);

create table if not exists fansly_creator_stats_media_totals (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  media_id text not null,
  source smallint not null,
  captured_day date not null,
  media_type smallint,
  views bigint,
  impressions bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  replays bigint,
  duration_ms bigint,
  -- `retention[]` as served: `[{ "percent": 0…95, "stillWatching": 0…1 }]`
  -- (empty for an image).
  retention jsonb not null default '[]'::jsonb,
  retention_sample_size bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, media_id, source, captured_day)
);

create table if not exists fansly_creator_stats_media_tags (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  media_id text not null,
  source smallint not null,
  tag_id text not null,
  -- 1 = a tag viewers browsed by, 2 = a tag of the post.
  kind smallint not null,
  after_day date not null,
  before_day date not null,
  -- The tag's text from the answer's `aggregationData.tags`; null when absent.
  tag text,
  media_type smallint,
  views bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, media_id, source, tag_id, kind, after_day, before_day),
  constraint fansly_creator_stats_media_tags_days_check check (after_day <= before_day)
);

create table if not exists fansly_creator_stats_media_tag_series (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  source smallint not null,
  tag_id text not null,
  kind smallint not null,
  day date not null,
  tag text,
  views bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, source, tag_id, kind, day)
);

create table if not exists fansly_creator_stats_media_likes (
  page_id bigint not null references pages(id) on delete restrict,
  media_offer_id text not null,
  source smallint not null,
  day date not null,
  likes bigint,
  unlikes bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, media_offer_id, source, day)
);

create table if not exists fansly_creator_stats_media_top (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  -- 1 images, 2 videos, 0 both (the request named no type).
  media_type smallint not null,
  order_by text not null,
  after_day date not null,
  before_day date not null,
  media_offer_id text not null,
  media_id text not null,
  rank integer not null,
  best_media_id text,
  -- The offer's likes and unlikes over the window.
  offer_likes bigint,
  offer_unlikes bigint,
  item_media_type smallint,
  views bigint,
  impressions bigint,
  unique_viewers bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  replays bigint,
  duration_ms bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  -- One row per offer and media of a window; the newest answer of the window
  -- is the ranking (an offer it no longer lists keeps its older row).
  primary key (page_id, source, media_type, order_by, after_day, before_day, media_offer_id, media_id),
  constraint fansly_creator_stats_media_top_days_check check (after_day <= before_day)
);

comment on table fansly_creator_stats_media_daily is
  'Fansly creator statistics (0293): /account/stats/media daily[] per offer, media, source and UTC day, as served. No row inside a read window is a zero.';
comment on table fansly_creator_stats_media_totals is
  'Fansly creator statistics (0293): /account/stats/media totals + retention of one named surface, all-time, as served on captured_day.';
comment on table fansly_creator_stats_media_top is
  'Fansly creator statistics (0293): /account/stats/media/top per surface, media type, order and window; the newest observation of a window is its ranking.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_creator_stats_media_daily, fansly_creator_stats_media_hourly,
      fansly_creator_stats_media_totals, fansly_creator_stats_media_tags, fansly_creator_stats_media_tag_series,
      fansly_creator_stats_media_likes, fansly_creator_stats_media_top to read_only;
  end if;
end $$;
