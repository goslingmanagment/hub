-- agency-hub:rollback-compatible — new tables only; the previous image never names them.
-- 0339_fansly_tracking_link_days.sql
--
-- One Fansly tracking link's days, as its stats screen shows them, read by
-- `tracking-links.daily` (`/trackinglinks/stats`, `/trackinglinks/revenuestats`;
-- the answers are in `observations` first): its whole history once, then the
-- last 14 days every day (late corrections). Until now Hub had only the
-- links' cumulative counters, a snapshot a day since 2026-08-22.
--
--   fansly_tracking_link_days          clicks, claims, follows, subscriptions
--                                      a UTC day
--   fansly_tracking_link_revenue_days  revenue a UTC day and transaction type
--                                      (mills, gross and net as served)
--
-- Fansly sends a row only for a day with activity: inside a window read, no
-- row is a zero. A row is replaced only by an answer received at the same
-- instant or later (`captured_at`, then `observation_id`).

set local lock_timeout = '5s';

create table if not exists fansly_tracking_link_days (
  page_id bigint not null references pages(id) on delete restrict,
  link_ref text not null,
  day date not null,
  clicks bigint,
  claims bigint,
  follows bigint,
  subscriptions bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, link_ref, day)
);

create table if not exists fansly_tracking_link_revenue_days (
  page_id bigint not null references pages(id) on delete restrict,
  link_ref text not null,
  day date not null,
  revenue_type integer not null,
  gross_mills bigint,
  net_mills bigint,
  observation_id bigint not null,
  captured_at timestamptz not null,
  primary key (page_id, link_ref, day, revenue_type)
);

comment on table fansly_tracking_link_days is
  'Fansly tracking links (0339): /trackinglinks/stats per link and UTC day as served (clicks, claims, follows, subscriptions). No row inside a read window is a zero.';
comment on table fansly_tracking_link_revenue_days is
  'Fansly tracking links (0339): /trackinglinks/revenuestats per link, UTC day and transaction type; money in mills as served.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_tracking_link_days, fansly_tracking_link_revenue_days to read_only;
  end if;
end $$;
