-- agency-hub:rollback-compatible — one new table nothing of the previous image names.
-- 0999_people_messages.sql
--
-- Сообщения людям (ecosystem plan 2026-11-12, package S): every message the server's own sender
-- makes for a person or a work chat in Telegram, with what it is and what became of it. The
-- sender is off twice as merged: no bot token (env PEOPLE_TELEGRAM_BOT_TOKEN) and no kind on
-- (live setting peopleMessageKinds), so every row is `held` and nothing leaves the server.
--
--   kind             the kind (a row of code: apps/runtime/src/services/people-messages/kinds.ts)
--   idempotency_key  the matter's reason key or the object's version: the same object and kind
--                    never make a second message
--   recipient        `person` (their Telegram id, from the people registry) or `chat` (a work
--                    chat and topic, from the live setting peopleMessageChats)
--   to_words         to whom, in words, for the owner's screen
--   object_*         what it is about (a shift, a handed-in version, an order, a matter)
--   text             the exact text; an invitation's one-time link is not kept
--   state            held: nothing left (held_reason says why); sending: the one attempt is under
--                    way; sent; failed: Telegram refused; unknown: the attempt did not say. A held
--                    row never sends later, and nothing is ever repeated by itself.
--
-- Rows are kept: nothing here is deleted. The read_only role is not granted: a payout text
-- carries money.

set local lock_timeout = '5s';

create table if not exists people_messages (
  id bigserial primary key,
  kind text not null,
  idempotency_key text not null,
  recipient text not null,
  recipient_user_id bigint references users(id) on delete restrict,
  telegram_chat_id text,
  telegram_topic_id bigint,
  to_words text not null,
  object_type text,
  object_id text,
  about text not null,
  text text not null,
  event_at timestamptz not null,
  state text not null,
  held_reason text,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  settled_at timestamptz,
  telegram_message_id bigint,
  error text,
  constraint people_messages_key_uidx unique (idempotency_key),
  constraint people_messages_recipient_check check (recipient in ('person', 'chat')),
  constraint people_messages_state_check check (state in ('held', 'sending', 'sent', 'failed', 'unknown')),
  constraint people_messages_held_check check ((state = 'held') = (held_reason is not null)),
  constraint people_messages_held_reason_check check (
    held_reason is null or held_reason in ('kind_off', 'no_token', 'no_telegram', 'no_chat', 'cap', 'before_on')),
  constraint people_messages_attempt_check check (state = 'held' or attempted_at is not null),
  constraint people_messages_text_check check (length(text) between 1 and 4096),
  constraint people_messages_key_check check (length(idempotency_key) between 1 and 300)
);

create index if not exists people_messages_kind_created_idx on people_messages (kind, created_at desc);
create index if not exists people_messages_sending_idx on people_messages (attempted_at) where state = 'sending';

comment on table people_messages is
  'Сообщения людям (0999, package S): every message the server''s sender made, held or sent; one per idempotency key, never repeated by itself.';
