-- 0258_fansly_public_lookup_egress.sql
--
-- The session-less public Fansly account reader's egress (arena "vanished
-- chat", plan §7, owner decision Р1; release R5, PR11 — migration M5 of
-- plan §9). Nothing sends through it yet: the reader comes with the next
-- release.
--
-- 1. fansly_public_egress: the reader's own proxy, one row at most, stored the
--    way a page's proxy is stored (egress_endpoints): the URL, and the username
--    and password as one encrypted JSON with the key version that encrypted it.
--    No page owns it: no foreign key, no page column. The owner sets it (`pnpm
--    cli sync public-lookup proxy set`, the secret read from 1Password, never
--    from the repository); the egress resolver's `fansly_public` scope reads it
--    and lets requests through to Fansly's API host only. No row: no transport,
--    the reader sends nothing.
--
-- 2. fansly_send_log_source_check gains 'public_lookup': the reader journals
--    every request it sends there, with page_id null (as the identity check of
--    a session without a page does). The CHECK of 0225 is a closed list; the
--    new list is the old one plus that value (packages/fansly/src/send-guard.ts
--    FANSLY_SEND_SOURCES).
--
-- Rollback-compatible: the previous image never names fansly_public_egress,
-- never writes 'public_lookup' (it writes only values the old list has) and
-- reads fansly_send_log.source as text — a 'public_lookup' row (none exists
-- before the reader ships) is a journal row like any other to its reports.
--
-- LOCKING: replacing the CHECK takes ACCESS EXCLUSIVE on fansly_send_log,
-- which every Fansly send of the previous image's identity check writes (a
-- short insert or update). lock_timeout keeps the wait brief: if the lock is
-- not had in 5 s this aborts and the deploy rolls back (the 0245 pattern). The
-- new constraint is added NOT VALID (no scan under the exclusive lock) and
-- validated after (≈ 17 500 rows on 2026-10-08, every one inside the old list).

set local lock_timeout = '5s';

create table if not exists fansly_public_egress (
  id smallint primary key default 1,
  url text not null,
  encrypted_auth text,
  key_version integer,
  updated_at timestamptz not null default now(),
  constraint fansly_public_egress_singleton_check check (id = 1),
  constraint fansly_public_egress_auth_check check ((encrypted_auth is null) = (key_version is null))
);

comment on table fansly_public_egress is
  'Arena "vanished chat" R5: the session-less public account reader''s own proxy (one row): the URL and its encrypted auth, as egress_endpoints stores a page''s. No page owns or uses it.';
comment on column fansly_public_egress.encrypted_auth is
  'The proxy''s username and password as one encrypted JSON (key_version names the key); null for a proxy without auth.';

alter table fansly_send_log drop constraint if exists fansly_send_log_source_check;

alter table fansly_send_log add constraint fansly_send_log_source_check check (source in (
  'sync_stream', 'ws_hint', 'ai_accelerator', 'targeted_backfill', 'ai_fast_lane',
  'account_me_api', 'account_me_cli', 'endpoint_probe', 'replay_probe', 'alias_backfill',
  'onboarding', 'credentials_verify',
  'media_download', 'ws_connect', 'binding_preflight', 'ws_probe',
  'public_lookup'
)) not valid;

alter table fansly_send_log validate constraint fansly_send_log_source_check;

comment on column fansly_send_log.source is
  'Who sent (FANSLY_SEND_SOURCES): the legacy senders'' rows stay; onboarding and credentials_verify (an identity check without a page) and public_lookup (the session-less public account reader, page_id null) are still written.';
