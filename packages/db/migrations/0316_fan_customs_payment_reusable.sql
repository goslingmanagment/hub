-- agency-hub:rollback-compatible — one partial unique index swapped for a narrower one; the previous image never offers a payment a custom ever held, so it never writes past it.
-- 0316_fan_customs_payment_reusable.sql
--
-- Chat Memory week 4 (0310): one custom per payment — while the custom lives.
-- A cancelled custom (often a slip of the finger) gives its tip back: Hub
-- offers it again, and another custom may take it.

drop index if exists fan_customs_payment_unique;
create unique index if not exists fan_customs_payment_unique_live on fan_customs (payment_transaction_id)
  where payment_transaction_id is not null and state <> 'cancelled';
