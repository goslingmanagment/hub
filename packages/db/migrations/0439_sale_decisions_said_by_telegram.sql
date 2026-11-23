-- agency-hub:rollback-compatible — one nullable column only: the previous image never names it, and its inserts leave it null.
-- 0439_sale_decisions_said_by_telegram.sql
--
-- «Чья продажа» «со слов»: the sender of the Telegram message a decision was recorded from through the agent's door
-- (its numeric Telegram id, the door's `--sender`). A decision recorded from the owner's own message — the id the people
-- registry gives the person whose role is owner — is the owner's word: through the agent's door only the owner's own
-- message changes it. Null — not recorded «со слов», or recorded before this migration: nothing is relabelled.

set local lock_timeout = '5s';

alter table sale_owner_decisions add column if not exists said_by_telegram_id bigint;

alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_said_by_telegram_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_said_by_telegram_check
  check (said_by_telegram_id is null or said_by_telegram_id > 0);

comment on column sale_owner_decisions.said_by_telegram_id is
  'The Telegram id of the sender of the message a decision «со слов» was recorded from; null — none recorded (every decision before 0439).';
