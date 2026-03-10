update transactions t
set gross_amount_mills = round(
  (t.creator_net_amount_mills::numeric * 10000) / (10000 - t.raw_destination_tax)
)::bigint
from platform_accounts pa
where pa.id = t.platform_account_id
  and pa.platform = 'fansly'::platform
  and t.raw_destination_tax is not null
  and t.raw_destination_tax > 0
  and t.raw_destination_tax < 10000
  and t.gross_amount_mills = t.source_destination_amount_mills
  and t.source_destination_amount_mills = t.creator_net_amount_mills;

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
       (timezone('Europe/Moscow', t.occurred_at)::date) as business_date,
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
       (timezone('Europe/Moscow', t.occurred_at)::date) as business_date,
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
