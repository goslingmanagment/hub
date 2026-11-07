-- agency-hub:rollback-compatible — a new table and one nullable column the previous image never names; the backfilled zero balances sit in columns it already reads.
-- 0358_ai_provider_account_credits.sql
--
-- An Anthropic account's balance without the owner's console reading
-- (services/ai-account-balance.ts). Anthropic has no balance API, and the
-- owner never typed one in, so the usage screen showed no balance, no
-- forecast and no warning. Hub now keeps the balance itself:
--   * a refusal for credit is an exact zero: the balance becomes $0 at that
--     moment (balance_snapshot_source = 'credit_refusal');
--   * money that comes in is a row here: the subscription's monthly credit
--     (kind 'monthly', one per renewal, `aiAccountCredits` setting) and the
--     owner's purchases (kind 'topup', typed in on the usage screen);
--   * balance = the last reading or zero + money in since − Hub's spend since.
-- Money is micro-USD (1 000 000 = $1), BIGINT like every other AI spend sum.
--
-- Backfill: an account without a balance gets its last known zero — now, if it
-- is out of credit; else the last time its out-of-credit latch opened.

set local lock_timeout = '5s';

alter table ai_provider_accounts
  add column if not exists balance_snapshot_source text;

comment on column ai_provider_accounts.balance_snapshot_source is
  'Where balance_snapshot_* came from: reading (the owner typed the console balance) or credit_refusal (Anthropic refused for credit: $0). Null = reading.';

create table if not exists ai_provider_account_credits (
  id bigint generated always as identity primary key,
  account_id bigint not null references ai_provider_accounts(id),
  kind text not null,
  amount_micro_usd bigint not null,
  credited_at timestamptz not null,
  -- monthly: the Moscow date of the renewal the credit belongs to.
  cycle_date date,
  -- monthly: revived (the account answered again after a zero) or schedule
  -- (3 days after the renewal, the account never ran dry); topup: dashboard.
  source text not null,
  actor_user_id bigint references users(id),
  created_at timestamptz not null default now(),
  constraint ai_provider_account_credits_kind_check check (kind in ('monthly', 'topup')),
  constraint ai_provider_account_credits_amount_check check (amount_micro_usd > 0),
  constraint ai_provider_account_credits_cycle_check check ((kind = 'monthly') = (cycle_date is not null))
);

create unique index if not exists ai_provider_account_credits_cycle_uniq
  on ai_provider_account_credits (account_id, cycle_date) where kind = 'monthly';

create index if not exists ai_provider_account_credits_account_time
  on ai_provider_account_credits (account_id, credited_at desc);

comment on table ai_provider_account_credits is
  'Money into an Anthropic account: the monthly subscription credit (one per renewal) and the owner''s purchases. Balance = last reading or zero + these since − Hub spend since.';

update ai_provider_accounts as account set
  balance_snapshot_micro_usd = 0,
  balance_snapshot_at = zero.at,
  balance_snapshot_source = 'credit_refusal',
  updated_at = now()
from (
  select candidate.id,
         coalesce(
           case when candidate.status = 'exhausted' then candidate.status_changed_at end,
           (select incident.opened_at
              from notification_incidents incident
             where incident.incident_key = 'ai_provider_billing:global:account:' || candidate.label
               and incident.error_code = 'provider_billing')
         ) as at
    from ai_provider_accounts candidate
   where candidate.balance_snapshot_at is null
) as zero
where account.id = zero.id
  and zero.at is not null;
