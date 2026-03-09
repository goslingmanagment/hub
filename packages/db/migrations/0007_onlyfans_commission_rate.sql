alter table platform_accounts
  add column if not exists commission_rate numeric(5,4) not null default 0;

update platform_accounts
set commission_rate = 0.2000
where platform = 'onlyfans'::platform
  and commission_rate = 0;

update transactions t
set net_amount_mills = round(t.amount_mills::numeric * (1 - pa.commission_rate))::bigint
from platform_accounts pa
where pa.id = t.platform_account_id
  and pa.platform = 'onlyfans'::platform;

delete from daily_revenue dr
using platform_accounts pa
where pa.id = dr.platform_account_id
  and pa.platform = 'onlyfans'::platform;

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
join platform_accounts pa on pa.id = t.platform_account_id
where pa.platform = 'onlyfans'::platform
  and t.canonical_type <> 'payout_reversal'::transaction_type
group by 1, 2, 3, 4
on conflict (
  platform_account_id,
  business_date,
  canonical_type,
  transaction_state
) do update set
  transaction_count = excluded.transaction_count,
  net_amount_mills = excluded.net_amount_mills,
  updated_at = excluded.updated_at;
