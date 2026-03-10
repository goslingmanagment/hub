do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'amount_mills'
  ) then
    alter table transactions rename column amount_mills to gross_amount_mills;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'destination_amount_mills'
  ) then
    alter table transactions rename column destination_amount_mills to source_destination_amount_mills;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'net_amount_mills'
  ) then
    alter table transactions rename column net_amount_mills to creator_net_amount_mills;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'daily_revenue'
      and column_name = 'net_amount_mills'
  ) then
    alter table daily_revenue rename column net_amount_mills to creator_net_amount_mills;
  end if;
end $$;

alter table daily_revenue
  add column if not exists gross_amount_mills bigint not null default 0;

create table if not exists fan_username_aliases (
  fan_id bigint not null references fans(id) on delete cascade,
  username text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  constraint fan_username_aliases_pkey primary key (fan_id, username)
);

create index if not exists fan_username_aliases_username_idx
  on fan_username_aliases (username);

create table if not exists spender_daily_facts (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint not null references fans(id) on delete cascade,
  business_date date not null,
  canonical_type transaction_type not null,
  transaction_state transaction_state not null,
  transaction_count integer not null default 0,
  gross_amount_mills bigint not null default 0,
  creator_net_amount_mills bigint not null default 0,
  last_transaction_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint spender_daily_facts_pkey primary key (
    platform_account_id,
    fan_id,
    business_date,
    canonical_type,
    transaction_state
  )
);

create index if not exists spender_daily_facts_account_date_fan_idx
  on spender_daily_facts (platform_account_id, business_date, fan_id);

create index if not exists spender_daily_facts_fan_account_date_idx
  on spender_daily_facts (fan_id, platform_account_id, business_date);

create table if not exists spender_lifetime_page (
  platform_account_id bigint not null references platform_accounts(id) on delete cascade,
  fan_id bigint not null references fans(id) on delete cascade,
  gross_amount_mills bigint not null default 0,
  creator_net_amount_mills bigint not null default 0,
  last_transaction_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint spender_lifetime_page_pkey primary key (platform_account_id, fan_id)
);

create index if not exists spender_lifetime_page_fan_account_idx
  on spender_lifetime_page (fan_id, platform_account_id);

create table if not exists spender_projection_watermarks (
  platform_account_id bigint primary key references platform_accounts(id) on delete cascade,
  last_rebuilt_at timestamptz not null,
  updated_at timestamptz not null default now()
);

insert into fan_username_aliases (
  fan_id,
  username,
  first_seen_at,
  last_seen_at
)
select f.id,
       f.username,
       f.first_seen_at,
       f.last_seen_at
from fans f
where f.username is not null
  and btrim(f.username) <> ''
on conflict (fan_id, username) do update set
  first_seen_at = least(fan_username_aliases.first_seen_at, excluded.first_seen_at),
  last_seen_at = greatest(fan_username_aliases.last_seen_at, excluded.last_seen_at);

delete from daily_revenue;

insert into daily_revenue (
  platform_account_id,
  business_date,
  canonical_type,
  transaction_state,
  transaction_count,
  gross_amount_mills,
  creator_net_amount_mills,
  updated_at
)
select t.platform_account_id,
       (
         timezone(
           case
             when pa.platform = 'onlyfans'::platform then 'UTC'
             else 'Europe/Moscow'
           end,
           t.occurred_at
         )::date
       ) as business_date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       now()
from transactions t
join platform_accounts pa on pa.id = t.platform_account_id
where t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4
on conflict (
  platform_account_id,
  business_date,
  canonical_type,
  transaction_state
) do update set
  transaction_count = excluded.transaction_count,
  gross_amount_mills = excluded.gross_amount_mills,
  creator_net_amount_mills = excluded.creator_net_amount_mills,
  updated_at = excluded.updated_at;

delete from spender_daily_facts;

insert into spender_daily_facts (
  platform_account_id,
  fan_id,
  business_date,
  canonical_type,
  transaction_state,
  transaction_count,
  gross_amount_mills,
  creator_net_amount_mills,
  last_transaction_at,
  updated_at
)
select t.platform_account_id,
       t.fan_id,
       (
         timezone(
           case
             when pa.platform = 'onlyfans'::platform then 'UTC'
             else 'Europe/Moscow'
           end,
           t.occurred_at
         )::date
       ) as business_date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       max(t.occurred_at),
       now()
from transactions t
join platform_accounts pa on pa.id = t.platform_account_id
where t.fan_id is not null
  and t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4, 5
on conflict (
  platform_account_id,
  fan_id,
  business_date,
  canonical_type,
  transaction_state
) do update set
  transaction_count = excluded.transaction_count,
  gross_amount_mills = excluded.gross_amount_mills,
  creator_net_amount_mills = excluded.creator_net_amount_mills,
  last_transaction_at = excluded.last_transaction_at,
  updated_at = excluded.updated_at;

delete from spender_lifetime_page;

insert into spender_lifetime_page (
  platform_account_id,
  fan_id,
  gross_amount_mills,
  creator_net_amount_mills,
  last_transaction_at,
  updated_at
)
select sdf.platform_account_id,
       sdf.fan_id,
       coalesce(sum(sdf.gross_amount_mills), 0)::bigint,
       coalesce(sum(sdf.creator_net_amount_mills), 0)::bigint,
       max(sdf.last_transaction_at),
       now()
from spender_daily_facts sdf
group by 1, 2
on conflict (platform_account_id, fan_id) do update set
  gross_amount_mills = excluded.gross_amount_mills,
  creator_net_amount_mills = excluded.creator_net_amount_mills,
  last_transaction_at = excluded.last_transaction_at,
  updated_at = excluded.updated_at;

insert into spender_projection_watermarks (
  platform_account_id,
  last_rebuilt_at,
  updated_at
)
select pa.id,
       now(),
       now()
from platform_accounts pa
on conflict (platform_account_id) do update set
  last_rebuilt_at = excluded.last_rebuilt_at,
  updated_at = excluded.updated_at;
