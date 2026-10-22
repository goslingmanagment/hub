-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0294_fansly_creator_stats_audience.sql
--
-- Fansly's creator statistics of 2026-10 (`/account/stats/*`, map:
-- reference/fansly-creator-stats §5.5–5.9), the audience plane: what the
-- `creator-stats.audience`, `creator-stats.audience-daily`,
-- `creator-stats.media-shown` polls and the `creator-stats.audience-history`
-- walk read. The answer is in `observations` first (kinds `creator_stats_geo`,
-- `creator_stats_tags`, `creator_stats_media_benchmarks`,
-- `creator_stats_media_shown`, `creator_stats_active_hours`); these rows are
-- its typed copy, written by the resource's apply.
--
--   fansly_creator_stats_geo          `geo`: per surface, window and country —
--                                     views (`rows[]`) and profile visits
--                                     (`profileRows[]`) merged; a side the
--                                     country is not among is null
--   fansly_creator_stats_tags         `tags` `rows[]`: per surface, tag kind,
--                                     window and tag — totals and lift
--   fansly_creator_stats_tag_series   `tags` `series[]`: views per tag and UTC day
--   fansly_creator_stats_tag_names    `tags` `aggregationData.tags[]`: the tag text
--   fansly_creator_stats_benchmarks   `media/benchmarks`: per surface, window and
--                                     video-length bucket, the creator's own averages
--   fansly_creator_stats_media_shown  `media/shown`: per surface, the different
--                                     videos shown over `hours` hours whose last
--                                     hour starts at `end_hour`
--   fansly_creator_stats_active_hours `activehours`: per surface, window, UTC
--                                     weekday (0 = Sunday) and UTC hour
--
-- A window route answers for its whole window: `after_day` … `before_day` (both
-- included) is the window the server served, one day for the steady geo, a
-- calendar month or 400 days for history. Codes (source, kind, tag id,
-- country) are stored as served; labels are read-time. A row is replaced only
-- by an answer received at the same instant or later (`captured_at`, then
-- `observation_id`). Coverage: capture_coverage, plane `creator_stats_audience`.

set local lock_timeout = '5s';

create table if not exists fansly_creator_stats_geo (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  after_day date not null,
  before_day date not null,
  -- Upper-case ISO code as served; '' is Fansly's "Unknown".
  country text not null,
  views bigint,
  image_views bigint,
  video_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  avg_watch_percent numeric,
  avg_watch_ms numeric,
  profile_visits bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, after_day, before_day, country),
  constraint fansly_creator_stats_geo_days_check check (after_day <= before_day)
);

create table if not exists fansly_creator_stats_tags (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  -- 1 = the tags viewers browsed by, 2 = the tags of posts.
  kind smallint not null,
  after_day date not null,
  before_day date not null,
  tag_id text not null,
  views bigint,
  image_views bigint,
  video_views bigint,
  watch_ms bigint,
  image_watch_ms bigint,
  completed_views bigint,
  watch_pct_sum numeric,
  -- Percentage points over the page's other viewers; null when not served.
  lift_points numeric,
  lift_video_views bigint,
  -- The answer's `liftAvailable` (false over 120 days).
  lift_available boolean,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, kind, after_day, before_day, tag_id),
  constraint fansly_creator_stats_tags_days_check check (after_day <= before_day)
);

create table if not exists fansly_creator_stats_tag_series (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  kind smallint not null,
  tag_id text not null,
  day date not null,
  views bigint,
  image_views bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, kind, tag_id, day)
);

create table if not exists fansly_creator_stats_tag_names (
  page_id bigint not null references pages(id) on delete restrict,
  tag_id text not null,
  tag text not null,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, tag_id)
);

create table if not exists fansly_creator_stats_benchmarks (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  after_day date not null,
  before_day date not null,
  length_bucket smallint not null,
  -- The video-length range in ms as served; max_ms 0 is the open last bucket.
  min_ms bigint,
  max_ms bigint,
  media_count bigint,
  views bigint,
  video_views bigint,
  watch_ms bigint,
  completed_views bigint,
  watch_pct_sum numeric,
  avg_watch_percent numeric,
  completion_rate numeric,
  avg_watch_ms numeric,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, after_day, before_day, length_bucket),
  constraint fansly_creator_stats_benchmarks_days_check check (after_day <= before_day)
);

create table if not exists fansly_creator_stats_media_shown (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  -- The start of the span's last hour, as served (`endHour`).
  end_hour timestamptz not null,
  hours smallint not null,
  media_shown bigint,
  previous_media_shown bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, end_hour, hours),
  constraint fansly_creator_stats_media_shown_hours_check check (hours > 0)
);

create table if not exists fansly_creator_stats_active_hours (
  page_id bigint not null references pages(id) on delete restrict,
  source smallint not null,
  after_day date not null,
  before_day date not null,
  -- UTC (asked with timezoneOffsetMinutes=0); weekday 0 = Sunday.
  weekday smallint not null,
  hour smallint not null,
  views bigint,
  image_views bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, source, after_day, before_day, weekday, hour),
  constraint fansly_creator_stats_active_hours_days_check check (after_day <= before_day),
  constraint fansly_creator_stats_active_hours_cell_check check (weekday between 0 and 6 and hour between 0 and 23)
);

comment on table fansly_creator_stats_geo is
  'Fansly creator statistics (0294): /account/stats/geo per surface, served window and country — views and profile visits, as served.';
comment on table fansly_creator_stats_tags is
  'Fansly creator statistics (0294): /account/stats/tags rows — a tag''s totals and lift over one served window and surface.';
comment on table fansly_creator_stats_tag_series is
  'Fansly creator statistics (0294): /account/stats/tags series — a tag''s views per UTC day and surface. No row inside a covered window is a zero.';
comment on table fansly_creator_stats_media_shown is
  'Fansly creator statistics (0294): /account/stats/media/shown — different videos a surface showed over hours hours ending with end_hour.';
comment on table fansly_creator_stats_active_hours is
  'Fansly creator statistics (0294): /account/stats/activehours — views per UTC weekday and hour over one served window and surface.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_creator_stats_geo, fansly_creator_stats_tags, fansly_creator_stats_tag_series,
      fansly_creator_stats_tag_names, fansly_creator_stats_benchmarks, fansly_creator_stats_media_shown,
      fansly_creator_stats_active_hours to read_only;
  end if;
end $$;
