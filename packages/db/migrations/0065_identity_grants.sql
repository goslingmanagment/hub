-- Kernel Stage 22: identity substrate — device tokens (human-bound, expiring
-- bearer credentials), the append-only access-grant log that replaces
-- hard-deleted page assignments, the must-change-password flag, and the
-- workboard attribution columns. user_page_assignments stays in place as the
-- read path / shadow check until the grant read-path flip; its drop ships in
-- its own later migration, owner-acknowledged.

create table if not exists device_tokens (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  label text not null default '',
  token_digest text not null unique,
  key_prefix text not null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists device_tokens_user_idx on device_tokens (user_id);
create index if not exists device_tokens_expiry_idx on device_tokens (expires_at);

create table if not exists access_grants (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  scope_type text not null check (scope_type in ('org','model','page')),
  scope_id bigint not null default 0,
  granted_by bigint references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_by bigint references users(id) on delete set null,
  revoked_at timestamptz
);
create index if not exists access_grants_user_active_idx on access_grants (user_id) where revoked_at is null;
create index if not exists access_grants_scope_idx on access_grants (scope_type, scope_id);

alter table users add column if not exists must_change_password boolean not null default false;

alter table workboard_contact_log
  add column if not exists acted_by_user_id bigint references users(id) on delete set null;
alter table workboard_snoozes
  add column if not exists created_by_user_id bigint references users(id) on delete set null;

-- Backfill: every current page assignment becomes an active page-scope grant.
-- granted_by NULL is the legacy marker; granted_at preserves the assignment's
-- creation time. Idempotent via the NOT EXISTS guard.
insert into access_grants (user_id, scope_type, scope_id, granted_at)
select upa.user_id, 'page', upa.platform_account_id, upa.created_at
from user_page_assignments upa
where not exists (
  select 1 from access_grants g
  where g.user_id = upa.user_id
    and g.scope_type = 'page'
    and g.scope_id = upa.platform_account_id
    and g.revoked_at is null
);
