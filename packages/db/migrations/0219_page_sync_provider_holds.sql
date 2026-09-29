-- 0219_page_sync_provider_holds.sql
--
-- R04 (Fansly data-acquisition audit, 2026-09-29): a Fansly 429 is the
-- provider's rate limit for the page's session, yet it paused only the stream
-- that met it; every other stream of the page stayed leasable inside the
-- provider's window. One row per page holds ALL of that page's sync streams
-- (regular chunks, targeted runs, B1 wakes) until hold_until. It lives beside
-- page_sync_states on purpose: a Sync now, a B1 event or a planner tick
-- rewrites a stream's retry_at, and none of them may lift the page's hold.
-- Sibling rows, their failure streaks and health stay untouched.
--
--   hold_until      no stream of the page is leased before this instant
--   reason          why ('rate_limit': a Fansly HTTP 429)
--   stream          the stream whose failure armed the hold
--   sync_run_id     that failed run (its anomaly `page_provider_hold`)
--   retry_after_at  the provider's own Retry-After instant, unclamped; null
--                   when it named none (hold_until is then a fixed default)
--   armed_at        when the hold was armed or last extended
--
-- A passed hold is inert and stays as the page's last-hold record; the next
-- arm overwrites it. Purely additive, IF NOT EXISTS; the previous image never
-- names the table.
create table if not exists page_sync_provider_holds (
  page_id bigint primary key references pages(id) on delete cascade,
  hold_until timestamptz not null,
  reason text not null,
  stream sync_stream not null,
  sync_run_id bigint references sync_runs(id) on delete set null,
  retry_after_at timestamptz,
  armed_at timestamptz not null
);

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on page_sync_provider_holds to read_only;
  end if;
end $$;
