-- 0229_send_guard_owner_engine.sql
--
-- Fansly Sync Engine design §2.7: the owner of the step-1 per-page send guard
-- (0225), the catch-all of the per-page switch at the wire.
--
--   owner_engine        'legacy' — the legacy engine's processes capture the
--                       page as before (every row, until the step-3 switch);
--                       'fansly_sync_engine' — no legacy capture succeeds, in
--                       any process, from any source: the capture statement
--                       requires owner_engine = 'legacy' and reports
--                       `engine_owned` otherwise. Only the switch flips it,
--                       and only while no legacy request holds the row
--                       (holder_token is null); only the rollback flips it
--                       back. The engine's live admission requires the flip
--                       (invariant I17).
--   engine_switched_at  when owner_engine last changed (null: never).
--
-- No row changes owner here: every existing and future row is 'legacy' by the
-- column default, so the legacy engine behaves exactly as before.
--
-- Purely additive, IF NOT EXISTS; the previous image never names either
-- column, and its capture statement (which does not test owner_engine) is
-- right for a table where every row is 'legacy'.
alter table fansly_page_send_guards
  add column if not exists owner_engine text not null default 'legacy',
  add column if not exists engine_switched_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fansly_page_send_guards_owner_engine_check') then
    alter table fansly_page_send_guards add constraint fansly_page_send_guards_owner_engine_check
      check (owner_engine in ('legacy', 'fansly_sync_engine')) not valid;
  end if;
end $$;

-- One row per Fansly page: validating scans a handful of rows.
alter table fansly_page_send_guards validate constraint fansly_page_send_guards_owner_engine_check;

comment on column fansly_page_send_guards.owner_engine is
  'Who may capture the page: legacy (the legacy engine, every process) or fansly_sync_engine (no legacy capture; the engine''s live admission requires it). Flipped only by the step-3 switch and its rollback.';
comment on column fansly_page_send_guards.engine_switched_at is
  'When owner_engine last changed; null if it never did.';

-- The table-level grant of 0225 already covers new columns; repeated so the
-- read role's access does not depend on the order of migrations.
do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_page_send_guards to read_only;
  end if;
end $$;
