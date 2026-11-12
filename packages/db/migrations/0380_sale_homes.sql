-- agency-hub:rollback-compatible — one new table only: the previous image never names it.
-- 0380_sale_homes.sql
--
-- Whose each sale is, by the one rule (apps/runtime services/sale-rule.ts, the
-- port of the agency ledger's internal/split with the owner's newer answers),
-- one row per sale (`transaction_id`, no FK: a fan's erasure anonymizes
-- transactions, never deletes them). For Hub's own screens, drafts and checks
-- and for the comparison with the ledger; no screen reads it yet.
--
-- home — shift / visit (a person's work, or several: `shares`), pot (`pot`),
--   waiting (a PPV waits for its sender's next shift till `waits_until`),
--   decide (several shifts held it, none of their people wrote last: the
--   owner decides), nobody, before_rule (the payout sheets' weeks), unknown
--   (the facts are not whole).
-- shares — [{userId, workRef, shiftId, percent, mills}]: workRef is the work's
--   `<userId>:<startedAt>`, shiftId its row in `shifts` when it has one; mills
--   sum to the net, except a «моё» with a lower own amount.
-- reason — why, in the rule's words (sale-rule.ts SALE_HOME_REASONS).
-- rule_version — the rule that computed it; computed_at — when.
--
-- Erasure: a page's rows go with the page; they hold no fan.

create table if not exists sale_homes (
  transaction_id bigint primary key,
  page_id bigint not null references pages(id),
  occurred_at timestamptz not null,
  net_mills bigint not null,
  home text not null,
  reason text not null,
  pot text,
  waits_until timestamptz,
  shares jsonb not null default '[]'::jsonb,
  rule_version text not null,
  computed_at timestamptz not null,
  constraint sale_homes_home_check check (home in ('shift', 'visit', 'pot', 'waiting', 'decide', 'nobody', 'before_rule', 'unknown')),
  constraint sale_homes_shares_check check (jsonb_typeof(shares) = 'array'),
  constraint sale_homes_pot_check check ((home = 'pot') = (pot is not null)),
  constraint sale_homes_waits_check check ((home = 'waiting') = (waits_until is not null))
);

create index if not exists sale_homes_page_at on sale_homes (page_id, occurred_at);
create index if not exists sale_homes_at on sale_homes (occurred_at);

comment on table sale_homes is 'Whose each sale is by the one rule (sale-rule.ts), with the reason and the rule version; in shadow.';
