-- 0287: the Anthropic accounts Hub spends, and which one paid for each call.
--
-- The owner keeps several Anthropic accounts, each with its own prepaid API
-- credit. Their keys stay in the environment (ANTHROPIC_API_KEYS, label=key
-- in spending order); this table is what Hub knows about each account by its
-- label: the owner's order and on/off, whether the account is serving, ran
-- out of credit or has a key Anthropic no longer accepts, and the balance the
-- owner last read in the Anthropic console. A key never lands here — only a
-- short fingerprint (to notice a replaced key) and its last four characters.
--
-- Anthropic has no API for an account's remaining credit, so the balance is
-- the owner's reading at balance_snapshot_at minus what Hub spent through the
-- account since then (ai_usage_events.provider_account_id). Money is micro-USD
-- (1 000 000 = $1), BIGINT like every other AI spend sum.
--
-- status: active = in rotation; exhausted = Anthropic refused for credit
-- (status_changed_at), retried no sooner than next_probe_at; invalid = 401 on
-- the key, out of rotation until the key under the label changes.
--
-- ai_usage_events.provider_account_id: the account that served the call;
-- null for rows before this release, non-Anthropic calls and a call that never
-- reached an account. Nullable, no default: catalog only. The previous image
-- never names the table or the column and inserts by named columns.

set local lock_timeout = '5s';

create table if not exists ai_provider_accounts (
  id bigserial primary key,
  provider text not null default 'anthropic',
  label text not null,
  priority integer not null,
  enabled boolean not null default true,
  status text not null default 'active',
  status_reason text,
  status_changed_at timestamptz,
  next_probe_at timestamptz,
  key_fingerprint text,
  key_hint text,
  last_success_at timestamptz,
  balance_snapshot_micro_usd bigint,
  balance_snapshot_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_provider_accounts_provider_label_uniq unique (provider, label),
  constraint ai_provider_accounts_provider_check check (provider in ('anthropic')),
  constraint ai_provider_accounts_status_check check (status in ('active', 'exhausted', 'invalid')),
  constraint ai_provider_accounts_balance_check check (
    (balance_snapshot_micro_usd is null) = (balance_snapshot_at is null)
    and (balance_snapshot_micro_usd is null or balance_snapshot_micro_usd >= 0)
  )
);

comment on table ai_provider_accounts is
  'Anthropic accounts Hub spends (keys stay in ANTHROPIC_API_KEYS): order, on/off, credit/key status, owner balance reading.';

alter table ai_usage_events
  add column if not exists provider_account_id bigint
    references ai_provider_accounts(id) on delete set null;

comment on column ai_usage_events.provider_account_id is
  'The Anthropic account (ai_provider_accounts) that served the call; null before 0287 and for calls that reached none.';
