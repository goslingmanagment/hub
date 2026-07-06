-- MACHINE-GENERATED OUTPUT TABLE (analytics_fan_ltv) — Kernel Stage 28
-- metrics model v1. Lifetime value per platform fan identity across every
-- page: net mills, activity bounds, transaction count. Chargebacks/refunds
-- carry negative amounts in the ledger, so LTV is naturally net-of-reversals.
create table analytics_fan_ltv as
select f.platform,
       f.platform_user_id,
       max(f.username) as username,
       count(t.id)::int as transaction_count,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint as ltv_net_mills,
       min(t.occurred_at) as first_transaction_at,
       max(t.occurred_at) as last_transaction_at
from fans f
join transactions t on t.fan_id = f.id
where t.is_active = true
  and t.canonical_type <> 'payout_reversal'
group by 1, 2;
