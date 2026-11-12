-- agency-hub:rollback-compatible — one new table and its one row: the previous image never names it.
-- 0381_sale_rule_switch.sql
--
-- The switch of the screens to the one rule of whose a sale is (sale-rule.ts):
-- «Смены», «Люди», «Мои смены», the shift review and the morning report count
-- a sale where `sale_homes` puts it from `screens_from` (a Moscow day) on, and
-- by their own rule before it. Null — off: every screen counts as before. The
-- owner's date; one row.

create table if not exists sale_rule_switch (
  id boolean primary key default true,
  screens_from date,
  set_by text,
  set_at timestamptz,
  constraint sale_rule_switch_one_row check (id)
);

insert into sale_rule_switch (id) values (true) on conflict (id) do nothing;

comment on table sale_rule_switch is 'From which Moscow day the screens count a sale where sale_homes puts it; null — off.';
