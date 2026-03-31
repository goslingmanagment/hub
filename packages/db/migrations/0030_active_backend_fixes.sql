create type dm_message_coverage_status as enum (
  'pending_backfill',
  'partial_window',
  'complete'
);

create type transaction_inactive_reason as enum (
  'missing_from_sync_window'
);

alter table platform_accounts
  alter column follower_count drop not null,
  alter column follower_count drop default,
  alter column subscriber_count drop not null,
  alter column subscriber_count drop default;

update platform_accounts
set follower_count = null,
    subscriber_count = null
where platform = 'onlyfans';

alter table page_dm_conversations
  add column message_coverage_status dm_message_coverage_status not null default 'pending_backfill';

update page_dm_conversations
set message_coverage_status = case
      when message_backfill_complete = true and stored_message_count < 25
        then 'complete'::dm_message_coverage_status
      else 'pending_backfill'::dm_message_coverage_status
    end,
    message_backfill_complete = case
      when message_backfill_complete = true and stored_message_count < 25
        then true
      else false
    end;

drop index if exists page_dm_conversations_backfill_idx;

create index page_dm_conversations_backfill_idx
  on page_dm_conversations (
    platform_account_id,
    is_visible,
    message_coverage_status,
    last_message_sync_at
  );

alter table transactions
  add column is_active boolean not null default true,
  add column inactive_reason transaction_inactive_reason,
  add column inactivated_at timestamptz;

create index transactions_account_active_occurred_idx
  on transactions (platform_account_id, is_active, occurred_at);
