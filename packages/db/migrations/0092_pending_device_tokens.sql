-- Crash-safe Desktop enrollment.  A reservation is deliberately stored in a
-- separate table and uses a prefix unknown to older Core releases, so a Core
-- rollback can never authenticate a token before the new client has durably
-- staged it and explicitly activated it.

create table pending_device_tokens (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  label text not null default '',
  token_digest text not null unique,
  key_prefix text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index pending_device_tokens_user_idx
  on pending_device_tokens (user_id);

create index pending_device_tokens_expiry_idx
  on pending_device_tokens (expires_at);

-- A revoke-all increments this generation under the same user-row lock.  An
-- issuance/reservation request that began before the revocation must not wake
-- afterward and publish a credential the revocation never saw.
alter table users
  add column device_token_epoch bigint not null default 0;
