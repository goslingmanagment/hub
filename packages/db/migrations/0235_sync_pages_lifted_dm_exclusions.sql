-- 0235_sync_pages_lifted_dm_exclusions.sql
--
-- Fansly Sync Engine, step 3 (design S3-06; owner decision №8, plan §9а):
-- chats the legacy engine excluded from message sync — no fan profile in the
-- conversation list's aggregation (`partner_missing_from_aggregation_accounts`)
-- or an account lookup that never resolves the partner
-- (`partner_unresolvable_from_account_lookup`), marked in
-- `page_dm_threads.metadata.messageSyncExcludedReason` — are probed on the
-- first switched page (`sync excluded probe`). Where the API serves their
-- messages, the owner lifts the exclusion per page (`sync excluded lift`).
--
--   lifted_dm_exclusions  the exclusion reasons the engine no longer applies
--                         on this page: the lift clears the reason from the
--                         page's bound threads, and the engine's conversation
--                         list no longer assigns it to a bound thread. Empty
--                         (the default) for every page: nothing changes until
--                         the owner runs `sync excluded lift`.
--
-- Purely additive: ADD COLUMN with a constant default is catalog-only, the
-- check names the two reasons the shared vocabulary has. The previous image
-- never names the column (it selects sync_pages by named columns), so it runs
-- unchanged after a rollback. The table-level read_only grant of 0228 covers
-- the new column.
alter table sync_pages add column if not exists lifted_dm_exclusions text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_pages_lifted_dm_exclusions_check') then
    alter table sync_pages add constraint sync_pages_lifted_dm_exclusions_check
      check (lifted_dm_exclusions <@ array['partner_missing_from_aggregation_accounts', 'partner_unresolvable_from_account_lookup']::text[]) not valid;
  end if;
end $$;

-- One row per Fansly page: validating scans a handful of rows.
alter table sync_pages validate constraint sync_pages_lifted_dm_exclusions_check;

comment on column sync_pages.lifted_dm_exclusions is
  'Owner decision №8: DM exclusion reasons the engine no longer applies on this page (lifted by `sync excluded lift` after a positive probe).';
