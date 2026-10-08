-- 0253_page_link_stat_snapshots_net_revenue.sql
--
-- OnlyFans traffic sources, the link series (plan 2026-10-08, PR 6,
-- migration B): the money in a link snapshot is named for what it is, and
-- three vendor fields the series dropped are kept.
--
-- `revenue.total` of OFAPI's stored tracking/trial-link lists is the creator's
-- NET: after the 20 % OnlyFans fee and after refunds and chargebacks (proved
-- to the cent on two links; the vendor documents the same). It has been
-- stored as revenue_gross_mills since 0111, a name that invites a reader to
-- take the fee off a second time.
--
--   revenue_net_mills          the same value under its true name. The
--                              backfill copies revenue_gross_mills into it on
--                              every row that has one (production,
--                              2026-10-09: 9 399 of 9 421 rows; the other 22
--                              are unknown money and stay null).
--   revenue_chargebacks_mills  vendor `revenue.chargebacks`: the positive
--                              amount ALREADY excluded from revenue.total
--                              (informational — never subtract it again).
--   trial_days                 vendor `subscribeDays` of a trial link (the
--                              free period it grants); null on tracking links.
--   tags                       vendor `tags`, the link's labels in the OFAPI
--                              cabinet; '{}' = the vendor said "no tags".
--
-- Unknown stays null, never 0 or '{}': a revenue block still computing or
-- missing leaves both money columns null, a field the vendor did not send
-- leaves its column null. The three new vendor fields are not backfilled —
-- the raw lists are in the journal (link_stats_tracking / link_stats_trial)
-- if the past is ever wanted.
--
-- revenue_gross_mills is NOT renamed or dropped: the previous image writes
-- it, and traffic-control's SQL reads it (`coalesce(s.revenue_gross_mills,
-- -1)`). The new image keeps writing the same value into both columns, and
-- Hub's readers take coalesce(revenue_net_mills, revenue_gross_mills).
--
-- Rollback-compatible. The previous image inserts snapshots by column name
-- and names none of the four new columns: its rows get a null
-- revenue_net_mills, which the coalesce above reads through, and null
-- chargebacks, trial length and tags, which is what "unknown" means here.
--
-- LOCKING: ADD COLUMN takes ACCESS EXCLUSIVE on page_link_stat_snapshots
-- (≈ 9 400 rows, 3.3 MB, written only by the link-stats lane a few times a
-- day, read by nothing interactive) and holds it through the backfill to the
-- end of the runner's transaction. lock_timeout keeps the wait brief: if the
-- lock is not had in 5 s this aborts and the deploy rolls back.

set local lock_timeout = '5s';

alter table page_link_stat_snapshots
  add column if not exists revenue_net_mills bigint,
  add column if not exists revenue_chargebacks_mills bigint,
  add column if not exists trial_days integer,
  add column if not exists tags text[];

update page_link_stat_snapshots
   set revenue_net_mills = revenue_gross_mills
 where revenue_net_mills is null
   and revenue_gross_mills is not null;

comment on column page_link_stat_snapshots.revenue_gross_mills is
  'Deprecated name: creator net after the OnlyFans fee. Read revenue_net_mills.';
comment on column page_link_stat_snapshots.revenue_net_mills is
  'Vendor revenue.total in mills: the creator''s net after the OnlyFans fee and after refunds and chargebacks. Null = unknown (revenue block missing, still computing, or unparseable). Rows written by an image older than migration 0253 have it only in revenue_gross_mills: read coalesce(revenue_net_mills, revenue_gross_mills).';
comment on column page_link_stat_snapshots.revenue_chargebacks_mills is
  'Vendor revenue.chargebacks in mills: the positive amount already excluded from revenue_net_mills (do not subtract it again). Null = unknown.';
comment on column page_link_stat_snapshots.trial_days is
  'Vendor subscribeDays of a trial link: the free period it grants, in days. Null on tracking links and when unknown.';
comment on column page_link_stat_snapshots.tags is
  'Vendor tags of the link, as sent. Empty array = the vendor sent none; null = unknown (not sent, or not a list of strings).';
