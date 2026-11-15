-- agency-hub:rollback-compatible — two checks widened: the previous image never writes the new state nor a given order without its message, and a failed deploy switches back before any order is «Проверен».
-- 0419_custom_order_checked.sql
--
-- Заказ кастома, «Проверен» (products plan 2026-11-13 §4.5, package C3): the team's customs lead (with a team lead —
-- the lead) checked the card, decided what was unclear and gave the order to shooting; ContentOps «Съёмка» takes it
-- from there. Who leads each step is one rule over the team records (apps/runtime/src/services/custom-orders/
-- leaders.ts); the step itself is a row of the order's history like every other.
--   custom_orders.state  recorded → paid → checked → at_model → … (a routine may still put a recorded or paid order
--                        straight at the model, as before)
--   custom_orders.given_at  «Отдан» by a person's word: given_at without given_message_ref (an order given before the
--                        hub saw the chat — the four of 12–14.11 —, a chat the hub does not read). A message still
--                        needs its time.

set local lock_timeout = '5s';

alter table custom_orders drop constraint if exists custom_orders_state_check;
alter table custom_orders add constraint custom_orders_state_check check (
  state in ('recorded', 'paid', 'checked', 'at_model', 'partly', 'shot', 'revision', 'refused', 'given', 'closed', 'cancelled')
);

alter table custom_orders drop constraint if exists custom_orders_given_check;
alter table custom_orders add constraint custom_orders_given_check check (
  (given_message_ref is null or given_message_ref ~ '^[1-9][0-9]{0,29}$') and (given_message_ref is null or given_at is not null)
);
