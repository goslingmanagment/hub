-- 0289_sync_observed_site_requests.sql
--
-- Project Browser, variant Б (protocol minor 6, 2026-10-18): the site's own
-- requests a page's browser let go and observed are delivered to Hub for
-- sure. The operator keeps each observation (`siteSent`, `siteEnded`) until
-- the engine committed it and said so (`siteObservedAck`), and sends it
-- again until then; so the engine must take each request once however often
-- it is told, and an audit must be able to follow one request from its send
-- to the answer kept.
--
--   sync_observed_site_requests   one hop of one observed site request,
--                                 keyed by the page, the operator's key of
--                                 the request (minted when it first followed
--                                 it, the same over its redirects; a socket's
--                                 handshake, its connection id; an operator
--                                 before minor 6, the engine's own of its id
--                                 and send) and the hop under it (0 as it
--                                 first left, each redirect the next):
--     browser_request_id          the operator's id (CDP's network id; a
--                                 socket's connection id), as
--                                 sync_attempts.browser_request_id
--     attempt_id                  the attempt journaled for its send (null:
--                                 not yet — its answer was taken first)
--     credentials_generation,     the settings and the session it went under
--     session_fingerprint         (what an identity proof of it is judged by)
--     sent_recorded_at            when Hub journaled its send
--     end_status, end_error,      how it ended and when Hub committed that
--     ended_recorded_at           (with the holds its 429/401/403 set)
--     identity_recorded_at        when Hub took the account it named
--     response_buffer_id,         the buffer event that carried its answer
--     response_seq,               (`site.response`), the observation it was
--     response_observation_id,    journaled as (null: not written — a login,
--     response_recorded_at        a write), and when Hub took it
--
--   page_browsers.site_observed_unconfirmed, site_observed_oldest_at,
--   site_observed_dropped         what the operator keeps for the engine's
--                                 word, as its last state said
--                                 (state.siteObserved): how many, the oldest
--                                 one's instant, how many it dropped
--                                 unconfirmed since its start. Null: not said
--                                 (an operator before minor 6).
--
-- Size: one row per hop of the site's API requests and socket handshakes —
-- a few thousand a day per page. A journal of delivery, not a captured fact.
--
-- LOCKING: the table is new and empty; page_browsers is tiny (one row per
-- browser profile) and gains nullable columns without a default (catalog
-- only). lock_timeout keeps each wait brief: if a lock is not had in 5 s the
-- migration aborts and the deploy rolls back.
--
-- Rollback-compatible: the previous image never names the table or these
-- columns, and updates page_browsers by named columns only; it confirms no
-- observation, which an operator of minor 6 then takes as told once written.

set local lock_timeout = '5s';

create table if not exists sync_observed_site_requests (
  page_id bigint not null references pages(id) on delete cascade,
  request_key text not null,
  hop integer not null,
  browser_request_id text not null,
  attempt_id bigint,
  credentials_generation text,
  session_fingerprint text,
  sent_recorded_at timestamptz,
  end_status integer,
  end_error text,
  ended_recorded_at timestamptz,
  identity_recorded_at timestamptz,
  response_buffer_id uuid,
  response_seq bigint,
  response_observation_id bigint,
  response_recorded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint sync_observed_site_requests_pkey primary key (page_id, request_key, hop),
  constraint sync_observed_site_requests_check check (
    hop >= 0
    and length(request_key) between 1 and 128
    and length(browser_request_id) between 1 and 64
    and (attempt_id is null) = (sent_recorded_at is null)
    and (end_status is null or ended_recorded_at is not null)
    and (end_error is null or ended_recorded_at is not null)
    and (response_seq is null) = (response_buffer_id is null)
    and (response_seq is null) = (response_recorded_at is null)
    and (response_observation_id is null or response_seq is not null)
  )
);

create index if not exists sync_observed_site_requests_attempt_idx
  on sync_observed_site_requests (attempt_id) where attempt_id is not null;
create index if not exists sync_observed_site_requests_page_created_idx
  on sync_observed_site_requests (page_id, created_at);

comment on table sync_observed_site_requests is
  'Project Browser (0289, minor 6): one hop of an observed site request, keyed by (page_id, request_key, hop) — the operator''s key minted when it first followed the request (the same over its redirects) and the hop under it. Its send''s attempt and when Hub journaled it, its end and when committed, the buffer event of its answer and the observation it was kept as. A repeated siteSent finds its row: no second attempt.';

alter table page_browsers
  add column if not exists site_observed_unconfirmed integer,
  add column if not exists site_observed_oldest_at timestamptz,
  add column if not exists site_observed_dropped integer;

alter table page_browsers
  drop constraint if exists page_browsers_site_observed_check,
  add constraint page_browsers_site_observed_check check (
    (site_observed_unconfirmed is null) = (site_observed_dropped is null)
    and (site_observed_unconfirmed is null or site_observed_unconfirmed >= 0)
    and (site_observed_dropped is null or site_observed_dropped >= 0)
    and (site_observed_oldest_at is null or site_observed_unconfirmed > 0)
  );

comment on column page_browsers.site_observed_unconfirmed is
  'Project Browser (0289): the site''s observations the operator keeps for the engine''s word (state.siteObserved, minor 6); site_observed_oldest_at the oldest one''s instant, site_observed_dropped how many it dropped unconfirmed since its start. Null: not said.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select (site_observed_unconfirmed, site_observed_oldest_at, site_observed_dropped) on page_browsers to read_only;
    grant select on sync_observed_site_requests to read_only;
  end if;
end $$;
