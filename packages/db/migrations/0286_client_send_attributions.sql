-- 0286_client_send_attributions.sql
--
-- Who sent each outgoing message (send-attribution-v1). The old OnlyFans
-- desktop sent through the hub's OFAPI commands, so every send of it carries
-- its chatter (ofapi_commands.chatter_user_id). With OnlyMonster ChatSpace the
-- chatter presses ChatSpace's own Send and the hub lost that. The chat
-- extension observes each human send in the composer and, once the page's own
-- response named the platform's message id, reports one fact per message:
-- this page, this message, this fan, observed then, with a price or media or
-- neither. The chatter is the hub's own knowledge — the user of the token that
-- reported it — never a field of the client's.
--
-- One row per platform message of a page: the key is (platform, page_id,
-- platform_message_id), the first report wins and a repeat changes nothing.
-- The row joins the message archive by the same key (message_archive:
-- account_id, platform, message_ref; dm_message_archive: platform_account_id,
-- platform_message_id), and through it the PPV purchases (page_dm_messages
-- .purchased_at, message_media_offers).
--
-- No text of a message is ever stored: the archive has it.
--
-- Platform-neutral on purpose: `source` names the client that observed the
-- send (`chatspace-extension` for now; a Fansly client adds its own value in
-- its own migration), and `conversation_ref` is there for a platform whose
-- chats have ids of their own (Fansly's group). On OnlyFans the chat is the
-- fan and the column stays null.
--
-- No scheduled deletion: payroll and sales read it for as long as the archive
-- keeps the messages. Erasure: page-owned (page inventory), and a fan's rows go
-- with the fan (fan_ref, conversation_ref). The previous image never names the
-- table: purely additive.

create table if not exists client_send_attributions (
  platform text not null references platforms(key),
  page_id bigint not null references pages(id),
  platform_message_id text not null,
  fan_ref text not null,
  conversation_ref text,
  user_id bigint not null references users(id),
  source text not null,
  priced boolean not null,
  with_media boolean not null,
  -- The client's clock when the page confirmed the send; recorded_at is the hub's.
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- The reporting client's x-client-version, when it was a readable one.
  client_version text,
  constraint client_send_attributions_pkey primary key (platform, page_id, platform_message_id),
  constraint client_send_attributions_message_check check (platform_message_id ~ '^[1-9][0-9]{0,29}$'),
  constraint client_send_attributions_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_send_attributions_conversation_ref_check check (
    conversation_ref is null or conversation_ref ~ '^[1-9][0-9]{0,29}$'
  ),
  constraint client_send_attributions_source_check check (source in ('chatspace-extension')),
  constraint client_send_attributions_client_version_check check (
    client_version is null or length(client_version) between 1 and 64
  )
);

-- A page's sends over a period (sales by chatter, per page).
create index if not exists client_send_attributions_page_observed
  on client_send_attributions (page_id, observed_at);

-- One chatter's sends over a period, across pages (payroll).
create index if not exists client_send_attributions_user_observed
  on client_send_attributions (user_id, observed_at);

-- Fan erasure finds a fan's rows without walking the page.
create index if not exists client_send_attributions_fan
  on client_send_attributions (page_id, fan_ref);

comment on table client_send_attributions is
  'Who sent each outgoing message (send-attribution-v1): the chatter of the token that reported a human send the client observed, first report wins. No message text.';
