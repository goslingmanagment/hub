do $$
begin
  alter type sync_stream add value if not exists 'top_spenders';
exception
  when duplicate_object then null;
end
$$;

create table if not exists page_top_spenders (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  correlation_account_id text not null,
  account_id text,
  fan_id bigint references fans(id) on delete set null,
  gross_amount_mills bigint not null default 0,
  creator_net_amount_mills bigint not null default 0,
  source_window_started_at timestamptz not null,
  source_window_ended_at timestamptz not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_top_spenders_pkey primary key (platform_account_id, correlation_account_id)
);

create index if not exists page_top_spenders_fan_account_idx
  on page_top_spenders (fan_id, platform_account_id);

with ranked as (
  select id,
         row_number() over (
           partition by conversation_id
           order by created_at desc, platform_message_id desc, id desc
         ) as rn
  from page_dm_messages
),
deleted as (
  delete from page_dm_messages
  where id in (
    select id
    from ranked
    where rn > 25
  )
  returning 1
)
select count(*) from deleted;

with ordered as (
  select conversation_id,
         platform_message_id,
         sender_role,
         created_at,
         id,
         row_number() over (
           partition by conversation_id
           order by created_at desc, platform_message_id desc, id desc
         ) as rn_desc,
         row_number() over (
           partition by conversation_id
           order by created_at asc, platform_message_id asc, id asc
         ) as rn_asc
  from page_dm_messages
),
summaries as (
  select conversation_id,
         count(*)::int as stored_message_count,
         max(case when rn_desc = 1 then platform_message_id end) as newest_stored_message_id,
         max(case when rn_asc = 1 then platform_message_id end) as oldest_stored_message_id,
         max(case when sender_role = 'fan' then created_at end) as last_fan_message_at,
         max(case when sender_role = 'model' then created_at end) as last_model_message_at
  from ordered
  group by conversation_id
)
update page_dm_conversations c
set stored_message_count = coalesce(s.stored_message_count, 0),
    newest_stored_message_id = s.newest_stored_message_id,
    oldest_stored_message_id = s.oldest_stored_message_id,
    last_fan_message_at = s.last_fan_message_at,
    last_model_message_at = s.last_model_message_at,
    updated_at = now()
from summaries s
where c.id = s.conversation_id;

update page_dm_conversations c
set stored_message_count = 0,
    newest_stored_message_id = null,
    oldest_stored_message_id = null,
    last_fan_message_at = null,
    last_model_message_at = null,
    updated_at = now()
where not exists (
  select 1
  from page_dm_messages m
  where m.conversation_id = c.id
);

alter table page_dm_conversations
  drop constraint if exists page_dm_conversations_stored_message_count_check;

alter table page_dm_conversations
  add constraint page_dm_conversations_stored_message_count_check
  check (stored_message_count between 0 and 25);

insert into sync_provider_rate_limits (provider, scope, egress_key, min_spacing_ms)
values ('fansly', 'dm_messages', 'global', 5000)
on conflict (provider, scope, egress_key) do update
set min_spacing_ms = excluded.min_spacing_ms,
    updated_at = now();
