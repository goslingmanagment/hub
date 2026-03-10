delete from daily_revenue dr
using platform_accounts pa
where pa.id = dr.platform_account_id
  and pa.platform = 'fansly'::platform;

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
join platform_accounts pa on pa.id = t.platform_account_id
where pa.platform = 'fansly'::platform
  and t.canonical_type <> 'payout_reversal'::transaction_type
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

delete from spender_daily_facts sdf
using platform_accounts pa
where pa.id = sdf.platform_account_id
  and pa.platform = 'fansly'::platform;

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
join platform_accounts pa on pa.id = t.platform_account_id
where pa.platform = 'fansly'::platform
  and t.fan_id is not null
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

delete from spender_lifetime_page slp
using platform_accounts pa
where pa.id = slp.platform_account_id
  and pa.platform = 'fansly'::platform;

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
join platform_accounts pa on pa.id = sdf.platform_account_id
where pa.platform = 'fansly'::platform
group by 1, 2
on conflict (platform_account_id, fan_id) do update set
  gross_amount_mills = excluded.gross_amount_mills,
  creator_net_amount_mills = excluded.creator_net_amount_mills,
  last_transaction_at = excluded.last_transaction_at,
  updated_at = excluded.updated_at;

update fan_pages fp
set total_creator_net_mills = coalesce((
      select slp.creator_net_amount_mills
      from spender_lifetime_page slp
      where slp.platform_account_id = fp.platform_account_id
        and slp.fan_id = fp.fan_id
    ), 0)::bigint
from platform_accounts pa
where pa.id = fp.platform_account_id
  and pa.platform = 'fansly'::platform;

delete from daily_followers df
using platform_accounts pa
where pa.id = df.platform_account_id
  and pa.platform = 'fansly'::platform;

insert into daily_followers (
  platform_account_id,
  business_date,
  new_followers,
  known_total_followers,
  updated_at
)
select pf.platform_account_id,
       ((pf.followed_at at time zone 'UTC')::date) as business_date,
       count(*)::int,
       case
         when ((pf.followed_at at time zone 'UTC')::date) = ((now() at time zone 'UTC')::date)
           then max(pa.follower_count)::integer
         else null::integer
       end,
       now()
from page_follows pf
join platform_accounts pa on pa.id = pf.platform_account_id
where pa.platform = 'fansly'::platform
group by 1, 2
on conflict (
  platform_account_id,
  business_date
) do update set
  new_followers = excluded.new_followers,
  known_total_followers = excluded.known_total_followers,
  updated_at = excluded.updated_at;

delete from daily_subscribers ds
using platform_accounts pa
where pa.id = ds.platform_account_id
  and pa.platform = 'fansly'::platform;

with fansly_pages as (
  select id as platform_account_id
  from platform_accounts
  where platform = 'fansly'::platform
),
date_series as (
  select fp.platform_account_id,
         generate_series(
           coalesce(
             (
               select min((ps.source_created_at at time zone 'UTC')::date)
               from page_subscriptions ps
               where ps.platform_account_id = fp.platform_account_id
             ),
             (now() at time zone 'UTC')::date
           ),
           (now() at time zone 'UTC')::date,
           interval '1 day'
         )::date as business_date
  from fansly_pages fp
),
new_subscribers as (
  select ps.platform_account_id,
         ((ps.source_created_at at time zone 'UTC')::date) as business_date,
         count(*)::int as new_subscribers
  from page_subscriptions ps
  join platform_accounts pa on pa.id = ps.platform_account_id
  where pa.platform = 'fansly'::platform
  group by 1, 2
),
active_subscribers as (
  select ds.platform_account_id,
         ds.business_date,
         count(ps.id)::int as active_subscribers
  from date_series ds
  left join page_subscriptions ps
    on ps.platform_account_id = ds.platform_account_id
   and coalesce((ps.source_created_at at time zone 'UTC')::date, ds.business_date) <= ds.business_date
   and coalesce((ps.ends_at at time zone 'UTC')::date, ds.business_date) >= ds.business_date
  group by 1, 2
)
insert into daily_subscribers (
  platform_account_id,
  business_date,
  new_subscribers,
  active_subscribers,
  updated_at
)
select ds.platform_account_id,
       ds.business_date,
       coalesce(ns.new_subscribers, 0),
       coalesce(ac.active_subscribers, 0),
       now()
from date_series ds
left join new_subscribers ns
  on ns.platform_account_id = ds.platform_account_id
 and ns.business_date = ds.business_date
left join active_subscribers ac
  on ac.platform_account_id = ds.platform_account_id
 and ac.business_date = ds.business_date
on conflict (
  platform_account_id,
  business_date
) do update set
  new_subscribers = excluded.new_subscribers,
  active_subscribers = excluded.active_subscribers,
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
where pa.platform = 'fansly'::platform
on conflict (platform_account_id) do update set
  last_rebuilt_at = excluded.last_rebuilt_at,
  updated_at = excluded.updated_at;
