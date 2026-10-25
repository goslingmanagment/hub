-- agency-hub:rollback-compatible — a wider check only: the previous image never writes a priced subscriber post, and refuses one it finds approved (its audience is not one it builds) before anything is sent.
-- 0314_publications_subscriber_price.sql
--
-- Wall posts: a Fansly subscriber post anyone else may buy (owner,
-- 2026-10-25). Its subscribers — of every tier, or of the tiers named — see
-- it free; whoever is not one of them pays its price (Fansly's "OR" of
-- permissions, captured on the test model 2026-10-25: the contract §3,
-- docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md). A price is
-- now a paid post's, or such a subscriber post's; a paid post still always
-- has one.

set local lock_timeout = '5s';

alter table publications drop constraint publications_price_check;
alter table publications add constraint publications_price_check
  check ((kind <> 'paid_post' or price_mills is not null)
     and (price_mills is null or (kind in ('paid_post', 'subscriber_post') and price_mills > 0)));
