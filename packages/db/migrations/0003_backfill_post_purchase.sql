update transactions
set canonical_type = 'post_purchase'::transaction_type
where raw_type in (32001, 32101)
  and canonical_type <> 'post_purchase'::transaction_type;

with affected_accounts as (
  select distinct platform_account_id
  from transactions
  where raw_type in (32001, 32101)
)
delete from daily_revenue
where platform_account_id in (
  select platform_account_id
  from affected_accounts
);

with affected_accounts as (
  select distinct platform_account_id
  from transactions
  where raw_type in (32001, 32101)
)
insert into daily_revenue (
  platform_account_id,
  business_date,
  canonical_type,
  transaction_state,
  transaction_count,
  net_amount_mills,
  updated_at
)
select t.platform_account_id,
       ((t.occurred_at at time zone 'Europe/Moscow')::date) as business_date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.net_amount_mills), 0)::bigint,
       now()
from transactions t
join affected_accounts aa on aa.platform_account_id = t.platform_account_id
where t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4;
