-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0292_fansly_creator_stats_account.sql
--
-- Fansly's creator statistics of 2026-10 (`/account/stats/*`, map:
-- reference/fansly-creator-stats), the account plane: what the
-- `creator-stats.account` poll and the `creator-stats.history` walk read from
-- `/account/stats/series` and `/account/stats/summary`. The answer is in
-- `observations` first (kinds `creator_stats_series`, `creator_stats_summary`);
-- these rows are its typed copy, written by the resource's apply.
--
--   fansly_creator_stats_views          series `views`: per hour or UTC day and
--                                       surface (`source` as served: 0 For You,
--                                       1 timeline …), every counter served
--   fansly_creator_stats_profile        series `profile`: visits, unique
--                                       visitors, watch time per bucket and source
--   fansly_creator_stats_follows        series `follows`: follows, unfollows
--   fansly_creator_stats_subscriptions  series `subscriptions`: per tier
--   fansly_creator_stats_revenue        series `revenue`: per hour, day or month
--                                       and product type, money in mills
--   fansly_creator_stats_levels         summary `levels`: follower and
--                                       subscriber count at each UTC day
--   fansly_creator_stats_tier_levels    summary `subscriptions.byTier[].levels`
--   fansly_creator_stats_tiers          the tiers the summary names
--   fansly_creator_stats_engagement     summary `engagement`: comments, post
--                                       likes, media likes (per source) a day
--   fansly_creator_stats_windows        summary window totals: every
--                                       `{ value, previous }` of one asked window
--                                       (uniques are not additive, so a window's
--                                       own numbers are kept as served)
--
-- Fansly sends a row only for a bucket with activity: no row inside a window
-- the coverage (capture_coverage, plane `creator_stats_account`) says was read
-- is a zero. Codes (source, productType, tierId) are stored as served; labels
-- are read-time. A row is replaced only by an answer received at the same
-- instant or later (`captured_at`, then `observation_id`).

set local lock_timeout = '5s';

create table if not exists fansly_creator_stats_views (
  page_id bigint not null references pages(id) on delete restrict,
  granularity text not null,
  bucket_start timestamptz not null,
  source smallint not null,
  views bigint,
  impressions bigint,
  unique_viewers bigint,
  video_views bigint,
  completed_views bigint,
  watch_ms bigint,
  watch_pct_sum numeric,
  replays bigint,
  image_views bigint,
  image_impressions bigint,
  unique_image_viewers bigint,
  image_watch_ms bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, granularity, bucket_start, source),
  constraint fansly_creator_stats_views_granularity_check check (granularity in ('hour', 'day'))
);

create table if not exists fansly_creator_stats_profile (
  page_id bigint not null references pages(id) on delete restrict,
  granularity text not null,
  bucket_start timestamptz not null,
  source smallint not null,
  profile_visits bigint,
  unique_visitors bigint,
  profile_watch_ms bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, granularity, bucket_start, source),
  constraint fansly_creator_stats_profile_granularity_check check (granularity in ('hour', 'day', 'month'))
);

create table if not exists fansly_creator_stats_follows (
  page_id bigint not null references pages(id) on delete restrict,
  granularity text not null,
  bucket_start timestamptz not null,
  follows bigint,
  unfollows bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, granularity, bucket_start),
  constraint fansly_creator_stats_follows_granularity_check check (granularity in ('hour', 'day', 'month'))
);

create table if not exists fansly_creator_stats_subscriptions (
  page_id bigint not null references pages(id) on delete restrict,
  granularity text not null,
  bucket_start timestamptz not null,
  tier_id text not null,
  subscriptions_new bigint,
  subscriptions_renewed bigint,
  subscriptions_expired bigint,
  subscriptions_cancelled bigint,
  subscriptions_moved_in bigint,
  subscriptions_moved_out bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, granularity, bucket_start, tier_id),
  constraint fansly_creator_stats_subscriptions_granularity_check check (granularity in ('hour', 'day', 'month'))
);

create table if not exists fansly_creator_stats_revenue (
  page_id bigint not null references pages(id) on delete restrict,
  granularity text not null,
  bucket_start timestamptz not null,
  product_type integer not null,
  transactions bigint,
  gross_mills bigint,
  net_mills bigint,
  refunds bigint,
  refunded_gross_mills bigint,
  refunded_net_mills bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, granularity, bucket_start, product_type),
  constraint fansly_creator_stats_revenue_granularity_check check (granularity in ('hour', 'day', 'month'))
);

create table if not exists fansly_creator_stats_levels (
  page_id bigint not null references pages(id) on delete restrict,
  day date not null,
  follower_count bigint,
  subscriber_count bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, day)
);

create table if not exists fansly_creator_stats_tier_levels (
  page_id bigint not null references pages(id) on delete restrict,
  tier_id text not null,
  day date not null,
  subscriber_count bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, tier_id, day)
);

create table if not exists fansly_creator_stats_tiers (
  page_id bigint not null references pages(id) on delete restrict,
  tier_id text not null,
  name text,
  color text,
  position integer,
  active boolean,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, tier_id)
);

create table if not exists fansly_creator_stats_engagement (
  page_id bigint not null references pages(id) on delete restrict,
  day date not null,
  metric text not null,
  -- The surface of a media like; -1 for the page-level comments and post likes.
  source smallint not null,
  value bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, day, metric, source),
  constraint fansly_creator_stats_engagement_metric_check check (metric in ('comments', 'post_likes', 'media_likes'))
);

create table if not exists fansly_creator_stats_windows (
  page_id bigint not null references pages(id) on delete restrict,
  after_day date not null,
  before_day date not null,
  -- The summary section: views, profile, follows, subscriptions, revenue,
  -- engagement, account.
  scope text not null,
  -- The section's row: a source, a product type, a tier id; '' for the
  -- section's own totals.
  ref text not null,
  metric text not null,
  value numeric,
  previous numeric,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, after_day, before_day, scope, ref, metric),
  constraint fansly_creator_stats_windows_days_check check (after_day <= before_day)
);

comment on table fansly_creator_stats_views is
  'Fansly creator statistics (0292): /account/stats/series family views per hour or UTC day and source, as served. No row inside a covered window is a zero.';
comment on table fansly_creator_stats_revenue is
  'Fansly creator statistics (0292): /account/stats/series family revenue per hour, UTC day or month and product type; money in mills, refunds as served.';
comment on table fansly_creator_stats_levels is
  'Fansly creator statistics (0292): /account/stats/summary levels — follower and subscriber count at each UTC day.';
comment on table fansly_creator_stats_windows is
  'Fansly creator statistics (0292): every { value, previous } pair of one /account/stats/summary window, per section (scope) and row (ref).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_creator_stats_views, fansly_creator_stats_profile, fansly_creator_stats_follows,
      fansly_creator_stats_subscriptions, fansly_creator_stats_revenue, fansly_creator_stats_levels,
      fansly_creator_stats_tier_levels, fansly_creator_stats_tiers, fansly_creator_stats_engagement,
      fansly_creator_stats_windows to read_only;
  end if;
end $$;
