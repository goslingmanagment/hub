-- 0259_fans_public_lookup.sql
--
-- The session-less public Fansly account reader (arena "vanished chat", plan
-- §7, owner decisions Р1, Р2 (а); release R5, PR12 — migration M4 of plan §9).
-- The reader in the `sync` process asks Fansly, without any session, whether a
-- fan's account exists (`GET /account?ids=`, through its own egress — 0258),
-- and writes what it found here. It is OFF by default
-- (`fanslyPublicLookupEnabled`) and has no proxy until the owner sets one.
--
-- 1. fans.public_checked_at, fans.public_found: the reader's latest answer for
--    the fan — when Fansly answered, and whether the account was among the
--    accounts it returned. Both null: never checked. A pair CHECK keeps them
--    together. The chatters' banner and the agent route read the partner's
--    pair as the cause of a chat Fansly no longer serves (plan §8 (а)): found
--    → probably blocked, not found → probably deleted, none → unchecked.
--
-- 2. fansly_public_lookup_queue: the fans the OWNER asked to be checked once
--    (`pnpm cli sync public-lookup recheck-marks`: the fans carrying the legacy
--    deleted mark, 1 207 on 2026-10-09). A row is done once the fan has an
--    answer newer than its request: found → the deleted mark is cleared
--    (Р2 (а)), not found → it stays. The rest of the reader's demand (the
--    partner of an established unavailability episode, a fan a page's lookup
--    missed) is read from those tables and needs no row. fan_id references
--    fans ON DELETE CASCADE: a fan erasure deletes the fans row and its queue
--    row with it (the erasure counts cascade children by `fan_id`).
--
-- 3. fansly_public_lookup_state: the reader's own state, one row.
--    - pending_token / pending_since: the attempt admitted and not yet
--      settled. It is written in the transaction that journals the attempt in
--      fansly_send_log, on the connection that holds the reader's advisory
--      lock, and cleared only in the transaction that settles it (its answer
--      applied, or the stop it causes). While it is set no reader sends: the
--      next pass settles it from the journal (fansly_send_log and the raw
--      answer in observations), without a request — across a restart too.
--    - A stop — the first 429, 401/403, network failure, answer off the
--      contract, or an attempt whose outcome is unknown (`indeterminate`) — is
--      written with its reason and stays until the owner resumes the reader
--      (`pnpm cli sync public-lookup resume`); a Retry-After is kept as
--      retry_not_before, which no resume shortens. stop_first_batch: no answer
--      was ever accepted before it. stop_incident_at: when the owner's
--      incident for this stop was confirmed open; until then every pass tries
--      to open it again.
--    - first_answer_at / last_answer_at: the accepted answers.
--
-- Rollback-compatible: two nullable columns without a default on fans
-- (catalog-only), their CHECK added NOT VALID and validated (≈ 56 000 rows,
-- all null), two new tables, their index and a seed row. The previous image
-- never names any of them: it reads and writes fans by named columns (drizzle's
-- mapping and raw SQL alike; no statement selects fans.* or a row of it as
-- JSON), so it runs unchanged after a rollback — without a reader; what the
-- reader wrote stays, and the previous image shows every cause `unchecked`.
-- A fan erasure of the previous image deletes the fans row; the queue row goes
-- with it (ON DELETE CASCADE).
--
-- LOCKING: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on fans, which
-- the previous image's sync upserts briefly. lock_timeout keeps the wait short:
-- if the lock is not had in 5 s this aborts and the deploy rolls back (the 0245
-- pattern). The validation scans fans under a lock that lets writes through.

set local lock_timeout = '5s';

alter table fans
  add column if not exists public_checked_at timestamptz,
  add column if not exists public_found boolean;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fans_public_check_pair_check') then
    alter table fans add constraint fans_public_check_pair_check
      check ((public_checked_at is null) = (public_found is null)) not valid;
  end if;
end $$;

alter table fans validate constraint fans_public_check_pair_check;

comment on column fans.public_checked_at is
  'Arena R5: when the session-less public account reader last had Fansly''s answer for this fan (null: never checked).';
comment on column fans.public_found is
  'Arena R5: whether that answer returned the account (true: it exists — a chat it stopped serving is probably a block; false: probably deleted). Null with public_checked_at.';

create table if not exists fansly_public_lookup_queue (
  fan_id bigint primary key references fans(id) on delete cascade,
  reason text not null,
  enqueued_at timestamptz not null default now(),
  done_at timestamptz,
  found boolean,
  mark_cleared boolean,
  constraint fansly_public_lookup_queue_reason_check check (reason in ('deleted_mark')),
  constraint fansly_public_lookup_queue_done_check check (
    (done_at is null and found is null and mark_cleared is null)
    or (done_at is not null and found is not null and mark_cleared is not null)
  )
);

create index if not exists fansly_public_lookup_queue_pending_idx
  on fansly_public_lookup_queue (enqueued_at, fan_id)
  where done_at is null;

comment on table fansly_public_lookup_queue is
  'Arena R5: fans the owner asked the public reader to check once (recheck-marks: the legacy deleted marks). Done when the fan has an answer newer than enqueued_at; mark_cleared = the answer found the account and the deleted mark was taken off.';

create table if not exists fansly_public_lookup_state (
  id smallint primary key default 1,
  stopped_at timestamptz,
  stop_reason text,
  stop_http_status integer,
  stop_detail text,
  retry_not_before timestamptz,
  first_answer_at timestamptz,
  last_answer_at timestamptz,
  resumed_at timestamptz,
  pending_token uuid,
  pending_since timestamptz,
  stop_first_batch boolean,
  stop_incident_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint fansly_public_lookup_state_singleton_check check (id = 1),
  constraint fansly_public_lookup_state_pending_check check ((pending_token is null) = (pending_since is null)),
  constraint fansly_public_lookup_state_stop_check check (
    (stopped_at is null and stop_reason is null and stop_http_status is null and stop_detail is null
      and stop_first_batch is null and stop_incident_at is null)
    or (stopped_at is not null and stop_first_batch is not null
      and stop_reason in ('rate_limited', 'auth_refused', 'network', 'off_contract', 'indeterminate'))
  )
);

insert into fansly_public_lookup_state (id) values (1) on conflict (id) do nothing;

comment on table fansly_public_lookup_state is
  'Arena R5: the session-less public account reader''s state (one row): the attempt admitted and not yet settled (no request while it is set), a stop (reason, status, detail, first batch, incident confirmed) until the owner resumes it, the Retry-After it honours, its first and latest accepted answers.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_public_lookup_state to read_only;
  end if;
end $$;
