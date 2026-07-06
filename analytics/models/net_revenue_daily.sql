-- MACHINE-GENERATED OUTPUT TABLE (analytics_net_revenue_daily) — Kernel
-- Stage 28 metrics model v1. An INDEPENDENT recomputation of net revenue by
-- page/model/day straight from the transactions ledger — it must reconcile
-- exactly with the revenue_daily rollups the reports serve (the Stage 33
-- serving swap is gated on that reconciliation).
-- Reportable types = every canonical type whose reporting bucket is not
-- "excluded" (packages/shared types.ts): the one excluded type today is
-- payout_reversal.
-- Until the first partition tiers (~2027-01) every fact is hot, so the model
-- reads Postgres only; the lake UNION arrives when lake data exists.
create table analytics_net_revenue_daily as
select t.platform_account_id,
       p.label as page_label,
       m.slug as model_slug,
       (timezone('UTC', t.occurred_at))::date as business_date,
       count(*)::int as transaction_count,
       coalesce(sum(t.gross_amount_mills), 0)::bigint as gross_amount_mills,
       coalesce(sum(t.creator_net_amount_mills), 0)::bigint as net_amount_mills
from transactions t
join pages p on p.id = t.platform_account_id
join models m on m.id = p.model_id
where t.is_active = true
  and t.canonical_type <> 'payout_reversal'
group by 1, 2, 3, 4;
