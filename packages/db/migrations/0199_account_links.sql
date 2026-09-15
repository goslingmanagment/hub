-- Decision 349 (unified chatter account, PR-1A): one-time invite and
-- password-reset links, plus the client version a device token last presented.
-- Additive only; nothing is dropped, nothing is rewritten. Links are never
-- deleted: a used / expired / revoked row stays as a fact (DP 7).
create table account_links (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null check (kind in ('invite', 'password_reset')),
  -- sha256 of the raw token; the raw token is returned once at creation and
  -- never stored, audited or logged. key_prefix is the display handle.
  token_digest text not null unique,
  key_prefix text not null,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb
);
create index account_links_user_idx on account_links(user_id);
-- At most ONE active link per user: every writer takes the user row lock first
-- (users -> account_links order) and this index is the database-level belt.
create unique index account_links_one_active_uidx
  on account_links(user_id)
  where used_at is null and revoked_at is null;

-- Р7: written by the same UPDATE as last_used_at on every authenticated use.
alter table device_tokens add column last_client_version text;
