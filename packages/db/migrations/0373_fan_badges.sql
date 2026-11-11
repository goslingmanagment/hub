-- agency-hub:rollback-compatible — one new table nothing of the previous image names; its FK cascades with the fan.
-- 0373_fan_badges.sql
--
-- Fan badges (`clientFanBadges`, fan-badges-v1): the two badges the chat
-- extension draws beside a Fansly fan's name, as a chatter's browser read
-- them. Hub cannot read either itself:
--   - FBuddy's spending tier: the fan's spend summed over every creator who
--     shares spend with FBuddy, read in the chatter's own FBuddy sign-in;
--   - Fansly's «Recent Spender» mark of the fan's account (the blue card),
--     read in the page's session.
-- A badge is the fan's, not the page's: one row per fan. Only fans already
-- linked to a page the reporter is granted are kept.
--
-- fan_badges — one fan:
--   fbuddy_tier                basic | bronze | silver | gold | platinum, or none (FBuddy answered and has no tier
--                              for the fan); null: no browser has read it
--   fbuddy_tier_since          when this value was first reported (the last change)
--   fbuddy_tier_checked_at     when a browser last confirmed it; moved at most once a day while the value holds
--   recent_spender             Fansly's mark; null: no browser has read it
--   recent_spender_since, recent_spender_checked_at — the same, for the mark
--
-- Each change is journaled first (`observations`, kind client.fan_badges.v1,
-- only the changed fans and fields). A report of values Hub already has,
-- confirmed less than a day ago, writes nothing.
--
-- Erasure: fan_id cascades with the fans row; the fan erasure counts cascade
-- children by fan_id.

set local lock_timeout = '5s';

create table if not exists fan_badges (
  fan_id bigint primary key references fans(id) on delete cascade,
  fbuddy_tier text,
  fbuddy_tier_since timestamptz,
  fbuddy_tier_checked_at timestamptz,
  recent_spender boolean,
  recent_spender_since timestamptz,
  recent_spender_checked_at timestamptz,
  constraint fan_badges_fbuddy_tier_check check (
    fbuddy_tier is null or fbuddy_tier in ('basic', 'bronze', 'silver', 'gold', 'platinum', 'none')
  ),
  constraint fan_badges_fbuddy_tier_pair_check check (
    (fbuddy_tier is null) = (fbuddy_tier_since is null) and (fbuddy_tier is null) = (fbuddy_tier_checked_at is null)
  ),
  constraint fan_badges_recent_spender_pair_check check (
    (recent_spender is null) = (recent_spender_since is null)
    and (recent_spender is null) = (recent_spender_checked_at is null)
  )
);

comment on table fan_badges is
  'Fan badges (0373): FBuddy''s spending tier and Fansly''s «Recent Spender» mark of a fan, as chatters'' browsers read them; one row per fan.';
comment on column fan_badges.fbuddy_tier is
  'FBuddy''s spending tier across creators: basic, bronze, silver, gold, platinum; none — FBuddy answered and has no tier; null — never read.';
comment on column fan_badges.fbuddy_tier_checked_at is
  'When a browser last confirmed the tier; an unchanged tier moves it at most once a day.';
comment on column fan_badges.recent_spender_checked_at is
  'When a browser last confirmed the mark; an unchanged mark moves it at most once a day.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fan_badges to read_only;
  end if;
end
$$;
