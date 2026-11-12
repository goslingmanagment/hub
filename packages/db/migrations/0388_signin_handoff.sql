-- agency-hub:rollback-compatible — a new table and a nullable column the previous image never names; a narrow session's token has its own digest form, so the previous image finds no row for it and refuses it rather than reading it as a full session.
-- 0388_signin_handoff.sql
--
-- One sign-in for people across the names Hub serves (ecosystem plan §3.2).
-- Cookies stay host-only; a sign-in crosses from one name to another by a
-- one-time code.
--
-- auth_sessions.narrow_device_token_id — set on a NARROW web session: the one
-- the chat extension opens from its device token (POST /api/v1/auth/web-link).
-- It opens only the team's place (NARROW_WEB_SESSION_OPERATIONS), is refused
-- every owner route, and stops signing in the moment its device token is
-- revoked or expires. Null — a full session, as before.
--
-- auth_handoff_codes — one-time codes, 60 s, single use. Never in
-- account_links (its kinds and its one-active-link index are the invitation's).
--   code_digest     sha256 of the code; the code itself is never stored
--   kind            session — the caller's own session, planted on another name
--                             of Hub (a host-only cookie there);
--                   narrow  — a narrow session to be opened from a device token;
--                   server  — «who is this» for another machine's server
--                             (ContentOps), which never receives a session token
--   target          the origin the code may be accepted on (session, narrow), or
--                   the server client's name (server)
--   session_id      the session that minted it (session, server)
--   device_token_id the device token a narrow session will live by (narrow)
--   state_digest    sha256 of the browser's state cookie on the target (session):
--                   a code is accepted only by the browser that asked for it
--   sealed_session  the session token, sealed with a key derived from the code
--                   (session): unreadable without the code; nulled on use
--   next            where the accept leads, checked when the code was minted
--   grant_digest    sha256 of the handle a server client re-checks the sign-in
--                   with (server, after its redeem)
-- Codes are kept as facts once used or expired; there is nothing secret left in
-- them then (the sealed token is gone, the code was never stored).
--
-- The read_only role is deliberately NOT granted: these are credentials.

set local lock_timeout = '5s';

alter table auth_sessions
  add column narrow_device_token_id bigint references device_tokens(id) on delete cascade;

create index auth_sessions_narrow_device_token_idx
  on auth_sessions(narrow_device_token_id)
  where narrow_device_token_id is not null;

create table auth_handoff_codes (
  id bigserial primary key,
  code_digest text not null unique,
  kind text not null check (kind in ('session', 'narrow', 'server')),
  target text not null check (length(target) between 1 and 300),
  user_id bigint not null references users(id) on delete cascade,
  session_id bigint references auth_sessions(id) on delete cascade,
  device_token_id bigint references device_tokens(id) on delete cascade,
  state_digest text,
  sealed_session text,
  next text not null check (length(next) between 1 and 2048),
  expires_at timestamptz not null,
  used_at timestamptz,
  grant_digest text unique,
  created_at timestamptz not null default now(),
  constraint auth_handoff_codes_kind_shape check (
    case kind
      when 'session' then session_id is not null and device_token_id is null
        and state_digest is not null and (sealed_session is not null or used_at is not null)
      when 'narrow' then session_id is null and device_token_id is not null
        and state_digest is null and sealed_session is null
      else session_id is not null and device_token_id is null
        and state_digest is null and sealed_session is null
    end
  ),
  constraint auth_handoff_codes_grant_server_only check (grant_digest is null or kind = 'server')
);

create index auth_handoff_codes_user_idx on auth_handoff_codes(user_id);
create index auth_handoff_codes_session_idx on auth_handoff_codes(session_id) where session_id is not null;
