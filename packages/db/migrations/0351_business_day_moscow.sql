-- agency-hub:rollback-compatible — data only: the derived daily rollups are re-dated, the schema is unchanged and the previous image reads and rewrites them as before.
-- 0351_business_day_moscow.sql
--
-- Hub's business day is Moscow midnight to midnight (owner 2026-11-04), the
-- day the shifts and the payout sheet already use; it was the UTC day, so a
-- night shift's money fell on two days. A sync rebuilds the money rollups only
-- from its window on, so the older days are re-dated here once, from the
-- transactions they are derived from (the same rows the rebuilds read). The
-- follower and subscriber rollups rebuild their whole series on every poll.

set local lock_timeout = '5s';

delete from revenue_daily;

insert into revenue_daily (
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
       timezone('Europe/Moscow', t.occurred_at)::date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       now()
from transactions t
join pages pa on pa.id = t.platform_account_id
where t.is_active = true
  and t.canonical_type <> 'payout_reversal'
group by 1, 2, 3, 4;

delete from fan_spend_daily;

insert into fan_spend_daily (
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
       timezone('Europe/Moscow', t.occurred_at)::date,
       t.canonical_type,
       t.transaction_state,
       count(*)::int,
       coalesce(sum(t.gross_amount_mills), 0)::bigint,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
       max(t.occurred_at),
       now()
from transactions t
where t.is_active = true
  and t.fan_id is not null
  and t.canonical_type <> 'payout_reversal'
group by 1, 2, 3, 4, 5;
