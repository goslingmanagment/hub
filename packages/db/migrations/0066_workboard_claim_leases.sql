-- Kernel Stage 23: soft "I'm working this fan" claim leases — coordination,
-- not access control (DP 4c note): TTL'd, owner visible on board reads,
-- non-blocking for a second chatter. One live claim per (page, fan); a
-- re-claim refreshes/steals the row (claimed_by swaps, released_at clears).
create table if not exists workboard_claim_leases (
  id bigserial primary key,
  platform_account_id bigint not null references pages(id) on delete cascade,
  fan_id bigint not null references fans(id) on delete cascade,
  claimed_by_user_id bigint not null references users(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  unique (platform_account_id, fan_id)
);
create index if not exists workboard_claim_leases_expiry_idx on workboard_claim_leases (expires_at);
