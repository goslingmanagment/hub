do $$
begin
  alter type sync_stream add value if not exists 'dm_conversations';
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter type sync_stream add value if not exists 'dm_messages';
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type dm_sender_role as enum ('fan', 'model', 'system', 'unknown');
exception
  when duplicate_object then null;
end
$$;

create table if not exists page_dm_conversations (
  id bigserial primary key,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint references fans(id) on delete set null,
  platform_conversation_id text not null,
  partner_platform_user_id text,
  partner_username text,
  partner_display_name text,
  conversation_flags integer not null default 0,
  unread_count integer not null default 0,
  subscription_tier_id text,
  last_message_id text,
  last_unread_message_id text,
  last_message_at timestamptz,
  last_message_sender_id text,
  last_message_sender_role dm_sender_role not null default 'unknown',
  last_message_preview text,
  last_fan_message_at timestamptz,
  last_model_message_at timestamptz,
  stored_message_count integer not null default 0,
  newest_stored_message_id text,
  oldest_stored_message_id text,
  message_backfill_complete boolean not null default false,
  last_message_sync_at timestamptz,
  is_visible boolean not null default true,
  last_seen_generation bigint,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_dm_conversations_account_conversation_uniq unique (platform_account_id, platform_conversation_id),
  constraint page_dm_conversations_stored_message_count_check check (stored_message_count between 0 and 75)
);

create index if not exists page_dm_conversations_account_fan_idx
  on page_dm_conversations (platform_account_id, fan_id);

create index if not exists page_dm_conversations_visible_message_idx
  on page_dm_conversations (platform_account_id, is_visible, last_message_at desc, id desc);

create index if not exists page_dm_conversations_visible_unread_idx
  on page_dm_conversations (platform_account_id, is_visible, unread_count desc, last_message_at desc, id desc);

create index if not exists page_dm_conversations_backfill_idx
  on page_dm_conversations (platform_account_id, is_visible, message_backfill_complete, last_message_sync_at);

create index if not exists page_dm_conversations_generation_idx
  on page_dm_conversations (platform_account_id, last_seen_generation);

create table if not exists page_dm_messages (
  id bigserial primary key,
  conversation_id bigint not null references page_dm_conversations(id) on delete cascade,
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  platform_message_id text not null,
  sender_platform_user_id text,
  sender_role dm_sender_role not null default 'unknown',
  created_at timestamptz not null,
  content text not null default '',
  total_tip_amount_cents integer not null default 0,
  in_reply_to_message_id text,
  in_reply_to_root_message_id text,
  synced_at timestamptz not null default now(),
  constraint page_dm_messages_conversation_message_uniq unique (conversation_id, platform_message_id)
);

create index if not exists page_dm_messages_conversation_created_idx
  on page_dm_messages (conversation_id, created_at desc, id desc);

create index if not exists page_dm_messages_account_conversation_created_idx
  on page_dm_messages (platform_account_id, conversation_id, created_at desc, id desc);

insert into sync_provider_rate_limits (provider, scope, egress_key, min_spacing_ms)
values
  ('fansly', 'dm_conversations', 'global', 5000),
  ('fansly', 'dm_messages', 'global', 7500)
on conflict (provider, scope, egress_key) do nothing;
