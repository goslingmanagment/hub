-- agency-hub:rollback-compatible — three nullable columns on page_fans, a pair CHECK on two of them and a trigger that keeps the third right for every writer, the previous image's included; the previous image never names any of them.
-- 0374_page_fans_account_state.sql
--
-- A fan's account state on a page (the Spenders list, the chat header's fan
-- marks; `fan-account-state-v1`): the page's own answer (account_probe_at /
-- account_probe_resolved, 0224), when its «not seen» streak began, the
-- session-less public check (fans.public_*, 0259) and, apart, what a chatter's
-- browser last saw that the page's answer did not say.
--
-- 1. page_fans.account_miss_since — the start of the current «not seen»
--    streak: the answer time of the first answer that did not return the fan
--    after one that did (or after none). NO backfill: null on a «not seen» row
--    means the start is unknown. account_probe_at is the latest check, not the
--    first, so a backfill with it would date every old streak at its newest
--    re-check (and make a public check older than that look stale).
--    The trigger below is its one writer, so every writer of account_probe_*
--    keeps it right, the previous image's too (after a rollback it writes the
--    pair and never names this column):
--      - the answer turns to «not seen» (false) from anything else: the new
--        answer's account_probe_at;
--      - «not seen» to «not seen»: kept (null stays unknown);
--      - «seen» (true) or no answer (null): null.
--    An inserted «not seen» row starts its streak at its own answer.
--
-- 2. page_fans.account_client_seen / account_client_seen_at — the latest
--    observation of a chatter's browser (clientFanBadges `accountSeen`: it
--    read GET /account?ids= through the page's own session) that DISAGREED
--    with the page's stored answer, and when Hub received it (server time).
--    A signal, never the page's answer: it never writes account_probe_*,
--    which remove a fan from the fan queues and the outreach audiences; it
--    makes the page's own re-check (`fan-profiles.recheck`) due. A pair
--    CHECK keeps the two together.
--
-- LOCKING: ADD COLUMN, ADD CONSTRAINT and CREATE TRIGGER lock page_fans,
-- which the previous image's sync upserts briefly. lock_timeout keeps the wait
-- short: if the lock is not had in 5 s this aborts and the deploy rolls back
-- (the 0245 / 0259 pattern). The columns are catalog-only (nullable, no
-- default); the validation scans page_fans inside this transaction (≈ 123 000
-- rows, 33 MB on 2026-11-12, every value null): well under a second.

set local lock_timeout = '5s';

alter table page_fans
  add column if not exists account_miss_since timestamptz,
  add column if not exists account_client_seen boolean,
  add column if not exists account_client_seen_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'page_fans_account_client_seen_pair_check') then
    alter table page_fans add constraint page_fans_account_client_seen_pair_check
      check ((account_client_seen is null) = (account_client_seen_at is null)) not valid;
  end if;
end $$;

alter table page_fans validate constraint page_fans_account_client_seen_pair_check;

create or replace function page_fans_account_miss_since() returns trigger
language plpgsql as $$
begin
  if new.account_probe_resolved is distinct from false then
    -- Seen, or no answer: no «not seen» streak.
    new.account_miss_since := null;
  elsif tg_op = 'INSERT' then
    new.account_miss_since := coalesce(new.account_miss_since, new.account_probe_at);
  elsif old.account_probe_resolved is distinct from false then
    -- The first «not seen» after a «seen» (or after none): a new streak.
    new.account_miss_since := new.account_probe_at;
  else
    -- Still not seen: the streak keeps its start (null: unknown).
    new.account_miss_since := old.account_miss_since;
  end if;
  return new;
end
$$;

drop trigger if exists page_fans_account_miss_since on page_fans;
create trigger page_fans_account_miss_since
  before insert or update of account_probe_resolved, account_probe_at, account_miss_since on page_fans
  for each row execute function page_fans_account_miss_since();

comment on column page_fans.account_miss_since is
  '0374: the start of the current «not seen» streak of the page''s answer (account_probe_resolved = false): the answer time of its first miss. Kept by the trigger page_fans_account_miss_since. Null on a «not seen» row: the start is unknown (rows from before 0374).';
comment on column page_fans.account_client_seen is
  '0374: the latest chatter''s browser observation (clientFanBadges accountSeen) that disagreed with the page''s stored answer: true — the browser saw the account, false — it did not. A signal for the page''s re-check, never the page''s answer.';
comment on column page_fans.account_client_seen_at is
  '0374: when Hub received that observation (server time). Null with account_client_seen.';
