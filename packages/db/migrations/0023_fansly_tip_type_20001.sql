update transactions t
set canonical_type = 'tip'::transaction_type
from platform_accounts pa
where pa.id = t.platform_account_id
  and pa.platform = 'fansly'::platform
  and t.raw_type = '20001'
  and t.canonical_type <> 'tip'::transaction_type;

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
delete from daily_revenue
where platform_account_id in (
  select platform_account_id
  from affected_accounts
);

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
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
       (timezone('UTC', t.occurred_at)::date) as business_date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       now()
from transactions t
join affected_accounts aa on aa.platform_account_id = t.platform_account_id
where t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4;

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
delete from spender_daily_facts
where platform_account_id in (
  select platform_account_id
  from affected_accounts
);

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
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
       (timezone('UTC', t.occurred_at)::date) as business_date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       max(t.occurred_at),
       now()
from transactions t
join affected_accounts aa on aa.platform_account_id = t.platform_account_id
where t.fan_id is not null
  and t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4, 5;

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
delete from spender_lifetime_page
where platform_account_id in (
  select platform_account_id
  from affected_accounts
);

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
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
join affected_accounts aa on aa.platform_account_id = sdf.platform_account_id
group by 1, 2;

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
update fan_pages fp
set total_creator_net_mills = coalesce((
      select slp.creator_net_amount_mills
      from spender_lifetime_page slp
      where slp.platform_account_id = fp.platform_account_id
        and slp.fan_id = fp.fan_id
    ), 0)::bigint
where fp.platform_account_id in (
  select platform_account_id
  from affected_accounts
);

with affected_accounts as (
  select distinct t.platform_account_id
  from transactions t
  join platform_accounts pa on pa.id = t.platform_account_id
  where pa.platform = 'fansly'::platform
    and t.raw_type = '20001'
)
insert into spender_projection_watermarks (
  platform_account_id,
  last_rebuilt_at,
  updated_at
)
select platform_account_id,
       now(),
       now()
from affected_accounts
on conflict (platform_account_id) do update set
  last_rebuilt_at = excluded.last_rebuilt_at,
  updated_at = excluded.updated_at;
