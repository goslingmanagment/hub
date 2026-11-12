-- agency-hub:rollback-compatible — one check widened, a column with a default, a nullable column, and stale parts taken off the orders in revision: the previous image never writes a request's part or names the columns, and reads the shorter parts_done as it read it before.
-- 0410_custom_order_revision_rounds.sql
--
-- Заказ кастома, readiness by the current round, per part (final review, round 2, 2026-11-12). A delivery marked
-- whole for one part closed every open revision request of the order, and a delivery that had been sent back for
-- revision counted as whole again once its replacement was taken back. Now a request is about a part or about the
-- whole order, and a part is ready only by a whole delivery newer than the last request about it, or by a word:
-- apps/runtime/src/services/custom-orders/rules.ts, `roundOf`.
--   custom_order_messages.part              a revision request: the part it is about (null — the whole order);
--                                           a delivery's part as before.
--   custom_order_messages.done_by_delivery  a revision request the round itself fixed — every part it is about came
--                                           whole after it: taking such a delivery back opens the request again.
--                                           False — fixed by a person's or the reader's word («снят»,
--                                           revision_done), which stays; and every request fixed before this column.
--   custom_orders.shot_by_hand_at           when a person last set «снят» by their own hand on the board. Their
--                                           word stands for every wanted part until a revision request newer than
--                                           it is about the part; a delivery taken back afterwards does not undo it.
--                                           Filled here from the orders' history (the last «снят» a person set,
--                                           unless a revision came after it).
--   custom_orders.parts_done                from now the parts ready in the current round. An order in revision
--                                           kept the parts of the round before: below it loses every part that no
--                                           whole delivery newer than its last request stands for («newer» as the
--                                           service reads it: the message's own time, else when the hub kept it,
--                                           then the row's id).

set local lock_timeout = '5s';

alter table custom_order_messages
  add column if not exists done_by_delivery boolean not null default false;

alter table custom_order_messages
  drop constraint if exists custom_order_messages_part_check,
  add constraint custom_order_messages_part_check check (
    part is null or (kind in ('delivery', 'revision') and part in ('video', 'photos'))),
  add constraint custom_order_messages_done_by_check check (
    not done_by_delivery or (kind = 'revision' and done_at is not null));

comment on column custom_order_messages.done_by_delivery is
  'A revision request fixed by the round''s own deliveries (0410): it opens again when one of them is taken back. False — fixed by a word.';

alter table custom_orders
  add column if not exists shot_by_hand_at timestamptz;

comment on column custom_orders.shot_by_hand_at is
  'When a person last set «снят» by hand on the board (0410): their word stands for every part until a newer revision request.';

update custom_orders o
set shot_by_hand_at = said.at
from (
  select object_id, max(created_at) as at from object_events
  where object_type = 'custom_order' and event = 'custom_order.shot' and actor_user_id is not null
  group by object_id
) said
where said.object_id = o.id::text
  and not exists (
    select 1 from object_events later
    where later.object_type = 'custom_order' and later.object_id = said.object_id
      and later.event = 'custom_order.revision' and later.created_at > said.at);

update custom_orders o
set parts_done = coalesce((
  select array_agg(p.part order by p.n)
  from unnest(o.parts_done) with ordinality as p(part, n)
  where exists (
    select 1 from custom_order_messages d
    where d.order_id = o.id and d.kind = 'delivery' and d.part = p.part and d.retracted_at is null and d.complete is not false
      and (coalesce(d.posted_at, d.added_at), d.id) > (
        select coalesce(r.posted_at, r.added_at), r.id from custom_order_messages r
        where r.order_id = o.id and r.kind = 'revision'
        order by coalesce(r.posted_at, r.added_at) desc, r.id desc
        limit 1))
), '{}'::text[])
where o.state = 'revision' and o.parts_done <> '{}'::text[];
