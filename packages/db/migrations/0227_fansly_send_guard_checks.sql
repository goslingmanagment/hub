-- 0227_fansly_send_guard_checks.sql
--
-- Fansly Sync Engine plan §2.4 «проверка, а не вера» and §10, on top of the
-- 0225 send guard:
--
-- fansly_send_log.lease_until: the lease the capture was granted (DB clock),
--   written by the capture statement itself. An attempt still held past it
--   kept its page closed until it completed or its holder was confirmed gone;
--   the acceptance report (`fansly-send-guard report`) reads closed periods
--   from it. Null on rows captured before this migration.
--
-- fansly_send_pace_cursor: one row, the id of the newest journal row the pace
--   check has examined. Every minute the api compares each new send with its
--   neighbours (by sent_at, all sources) and raises an incident for any pair
--   of sends of one page closer than the pause setting in force for the later
--   one. The cursor makes that check durable across restarts: every journal
--   row is examined, none twice by design.
--
-- Purely additive: a nullable column without a default (catalog-only) and a new
-- table; the previous image names neither.
alter table fansly_send_log add column if not exists lease_until timestamptz;

comment on column fansly_send_log.lease_until is
  'The capture''s lease end (DB clock). An attempt not completed by then kept its page closed until completion or a confirmed termination.';

create table if not exists fansly_send_pace_cursor (
  id smallint primary key default 1,
  after_id bigint not null default 0,
  checked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint fansly_send_pace_cursor_singleton check (id = 1),
  constraint fansly_send_pace_cursor_after_id_check check (after_id >= 0)
);

insert into fansly_send_pace_cursor (id) values (1) on conflict (id) do nothing;

comment on table fansly_send_pace_cursor is
  'Plan §2.4/§10: the newest fansly_send_log id the minutely pace check (any two sends of a page closer than the setting) has examined.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_send_pace_cursor to read_only;
  end if;
end $$;
