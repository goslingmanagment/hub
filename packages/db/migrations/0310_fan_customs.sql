-- agency-hub:rollback-compatible — one new table only: the previous image never names it.
-- 0310_fan_customs.sql
--
-- Chat Memory week 4 (docs/plans/2026-10-24-chat-memory/week-4.md §1): a
-- custom lives in the fan's record from payment to «отдали». A chatter writes
-- what was ordered; Hub suggests the payment (the fan's recent tips) and the
-- delivery (media sent to the fan after the payment); the chatter confirms
-- each. Hub sets no state by itself.
--
-- `state`: `ordered` (written, not paid yet) → `paid` (`payment_transaction_id`)
-- → `delivered` (`delivered_message_ref`: the message that took it to the fan)
-- or `cancelled`. Who changed it last and when stays in the row. How the model
-- shoots it stays in Telegram.
--
-- No foreign key to transactions: a fan's erasure anonymizes them, it never
-- deletes them. Erasure: a fan's customs go with the fan (cascade); a page's
-- with the page.

create table if not exists fan_customs (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  fan_id bigint not null references fans(id) on delete cascade,
  conversation_ref text,
  description text not null,
  price_mills bigint,
  state text not null default 'ordered',
  payment_transaction_id bigint,
  paid_at timestamptz,
  delivered_message_ref text,
  delivered_at timestamptz,
  created_by_user_id bigint not null references users(id),
  created_at timestamptz not null default now(),
  changed_by_user_id bigint references users(id),
  changed_at timestamptz,
  constraint fan_customs_state_check check (state in ('ordered', 'paid', 'delivered', 'cancelled')),
  constraint fan_customs_description_check check (length(description) between 1 and 500),
  constraint fan_customs_price_check check (price_mills is null or price_mills >= 0),
  constraint fan_customs_message_check check (delivered_message_ref is null or delivered_message_ref ~ '^[1-9][0-9]{0,29}$')
);

create index if not exists fan_customs_fan on fan_customs (fan_id, state);
create index if not exists fan_customs_page_open on fan_customs (page_id, state, paid_at);
-- One custom per payment.
create unique index if not exists fan_customs_payment_unique on fan_customs (payment_transaction_id) where payment_transaction_id is not null;

comment on table fan_customs is
  'Chat Memory: a fan''s custom from payment to delivery, written and confirmed by chatters from Hub''s suggestions.';
