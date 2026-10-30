-- agency-hub:rollback-compatible — a new table only; the previous image never names it.
-- 0338_fansly_page_settings.sql
--
-- The page's settings and standing on Fansly, read once a day by
-- `page-settings.daily` (apps/runtime/src/sync/fansly/lib/page-settings.ts):
-- the account switches, geo-blocks, timeline and DM permissions, watermark,
-- alerts, referral codes, pending balance, the account's tip goals and the
-- page's discovery labels and tags. The answers are in `observations` first;
-- this is their typed copy.
--
--   fansly_page_settings_versions  one row per route and distinct answer (the
--                                  body without the account's e-mail, and one
--                                  line in Russian); seeing it again only
--                                  widens first/last seen. A route's current
--                                  answer is its version seen last.

set local lock_timeout = '5s';

create table if not exists fansly_page_settings_versions (
  page_id bigint not null references pages(id) on delete restrict,
  route text not null,
  body_sha256 text not null,
  body jsonb,
  summary text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  first_observation_id bigint not null,
  last_observation_id bigint not null,
  primary key (page_id, route, body_sha256),
  constraint fansly_page_settings_versions_seen_check check (first_seen_at <= last_seen_at)
);

create index if not exists fansly_page_settings_versions_page_route_seen_idx
  on fansly_page_settings_versions (page_id, route, last_seen_at desc);

comment on table fansly_page_settings_versions is
  'Fansly page settings (0338): one row per route and distinct answer of page-settings.daily (geo-blocks, permissions, watermark, alerts, referrals, pending balance, tip goals, discovery tags); first/last seen widen.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_page_settings_versions to read_only;
  end if;
end $$;
