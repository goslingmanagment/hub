-- 0255_page_link_stat_runs_attempts.sql
--
-- OnlyFans traffic sources, the link series (plan 2026-10-08, PR 2,
-- migration A): every attempt to read a page's tracking or trial links is a
-- row of page_link_stat_runs, not only the walks that finished.
--
-- Until now a request that failed, a page that was skipped (no OFAPI mapping,
-- dead session) and a pass that never ran left nothing in the series: the
-- holes of 04.09, 05.09, 25.09 and 07.10 were found by counting windows by
-- hand. From this release the series itself says what happened.
--
--   status  two new values beside complete / partial / truncated:
--     failed   the request or the write failed; the error is in `reason`;
--     skipped  no attempt was made; `reason` says why (page_unmapped,
--              page_auth_dead, ofapi_mapping_changed,
--              ofapi_client_not_configured, window_missed).
--            Neither carries snapshots, exactly like `truncated`.
--   reason            null on a clean `complete`. On `partial` the caveats,
--                     comma-separated in a fixed order: binding_changed,
--                     inventory_vanished, empty_unverified, all_items_skipped
--                     or items_skipped, multi_page. On `truncated` what
--                     stopped the walk; on `failed` the error text.
--   window_at         the scheduled window the attempt belongs to. Null on
--                     rows written before this release and by the previous
--                     image.
--   attempt           1 for the first row of a (page, kind, window), then 2,
--                     3, … in the order the rows were written.
--   ofapi_account_id  the OFAPI account the page was bound to when the
--                     attempt was made (null: the page had no mapping, or it
--                     is not known).
--
-- The backfill names the account on the existing rows from the custody
-- history (ofapi_account_bindings): a row whose pulled_at lies inside a
-- binding's [valid_from, valid_to) gets that account; a row later than every
-- closed interval of its page gets the page's current account when that
-- binding's start is unknown (the 0150 seed, `mapping_at_migration`). A row
-- that matches no binding, or more than one, stays null. Production,
-- 2026-10-08: 617 rows, each matches exactly one binding (pages 8 and 9:
-- 22.07 → 03.09 under the second account, from 05.09 under the current one).
--
-- Rollback-compatible. The previous image inserts runs by column name with
-- the three old statuses only; `attempt` takes its default and the other
-- three columns stay null. It reads runs through an explicit
-- status in ('complete', 'partial') list (the empty-inventory guard), so it
-- never sees a failed or skipped row. traffic-control's SQL selects the same
-- two statuses and names none of the new columns.
--
-- LOCKING: ADD COLUMN and the constraint swap take ACCESS EXCLUSIVE on
-- page_link_stat_runs (≈ 620 rows, written twice a day, read by nothing
-- interactive). lock_timeout keeps the wait brief: if the lock is not had in
-- 5 s this aborts and the deploy rolls back.

set local lock_timeout = '5s';

alter table page_link_stat_runs
  add column if not exists reason text,
  add column if not exists window_at timestamptz,
  add column if not exists attempt smallint not null default 1,
  add column if not exists ofapi_account_id text;

alter table page_link_stat_runs
  drop constraint if exists page_link_stat_runs_status_check;
alter table page_link_stat_runs
  add constraint page_link_stat_runs_status_check
  check (status in ('complete', 'partial', 'truncated', 'failed', 'skipped')) not valid;
alter table page_link_stat_runs
  validate constraint page_link_stat_runs_status_check;

update page_link_stat_runs r
   set ofapi_account_id = matched.account_id
  from (
    select run.id, min(b.account_id) as account_id
      from page_link_stat_runs run
      join pages p on p.id = run.platform_account_id
      join ofapi_account_bindings b on b.page_id = run.platform_account_id
     where run.ofapi_account_id is null
       and (
         (b.valid_from is not null
            and run.pulled_at >= b.valid_from
            and (b.valid_to is null or run.pulled_at < b.valid_to))
         or (b.valid_from is null
            and b.valid_to is null
            and b.account_id = p.ofapi_account_id
            and run.pulled_at >= coalesce((
              select max(closed.valid_to)
                from ofapi_account_bindings closed
               where closed.page_id = b.page_id
                 and closed.valid_to is not null
            ), '-infinity'::timestamptz))
       )
     group by run.id
    having count(*) = 1
  ) matched
 where r.id = matched.id;

comment on column page_link_stat_runs.status is
  'complete = the list was read whole in one response and nothing was dropped (the only status that proves a link is absent); partial = read whole, with a caveat in reason; truncated = the walk was stopped; failed = the request or the write failed; skipped = no attempt was made. Only complete and partial carry snapshots.';
comment on column page_link_stat_runs.reason is
  'Null on a clean complete. partial: comma-separated caveats (binding_changed, inventory_vanished, empty_unverified, all_items_skipped | items_skipped, multi_page). truncated: what stopped the walk. failed: the error text. skipped: page_unmapped, page_auth_dead, ofapi_mapping_changed, ofapi_client_not_configured, window_missed.';
comment on column page_link_stat_runs.window_at is
  'The scheduled window the attempt belongs to (UTC). Null on rows older than migration 0255 and on rows written by an image that predates it.';
comment on column page_link_stat_runs.attempt is
  'Ordinal of the row within its (page, link kind, window): 1 for the first attempt.';
comment on column page_link_stat_runs.ofapi_account_id is
  'The OFAPI account the page was bound to when the attempt was made; null when the page had no mapping or the account is not known.';
