-- agency-hub:rollback-compatible — one nullable column only: the previous image never names it, and its inserts leave it null.
-- 0438_custom_order_card_author.sql
--
-- Заказ кастома: who posted an order's Telegram card, by their numeric Telegram id (the reader of the chats gives it). The
-- card in the chatters' work chat names the order's taker («принял») when the order has none: the id resolves to the
-- person (`people.telegram_user_id`) and their living login working on the order's page — never a name, which two people
-- may share. The card's copy in the model's group names nobody; its author is kept as evidence alone. Null — not given
-- (every card before this migration).

alter table custom_order_cards add column if not exists author_telegram_id bigint;

alter table custom_order_cards drop constraint if exists custom_order_cards_author_telegram_check;
alter table custom_order_cards add constraint custom_order_cards_author_telegram_check
  check (author_telegram_id is null or author_telegram_id > 0);
