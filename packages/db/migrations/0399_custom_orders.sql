-- agency-hub:rollback-compatible — four new tables, and two check lists widened: the previous image never names the tables, never writes the new capability or right and ignores them where it reads them.
-- 0399_custom_orders.sql
--
-- The custom order as one object (ecosystem plan 2026-11-12, package I): from
-- the fan's chat to the fan's hands. Today an order is a Telegram card copied
-- from chat to chat; here it exists once, from `/tz` (Gengar's agent key) or
-- «Записать кастом» in the fan's panel, and every door names the same order by
-- its code `K-<id>` (the card text carries it). `fan_customs` (0310) stays as
-- it is and empty: the extension's routes are served from this table.
--
-- custom_orders — one order:
--   page_id / fan_id   may be unknown («не подтверждено»): an imported order often has the buyer only as a
--                      string (`buyer`) and no page. Never guessed; a person confirms them later.
--   buyer              the buyer as the card names them (a link or a name) while the fan is not confirmed
--   fan_erased_at      the fan was erased: the order stays, its fan link and buyer are gone (erasure service)
--   conversation_ref   the fan's chat on the page (Fansly the group, OnlyFans the fan), for the delivery hint
--   card               the card's fields as the team writes them: date, name, price («100$ тир Master + 50$»),
--                      duration, task, photos, clothes, face, notes, urgency, deadline note, attachments (links)
--   deadline_on        the deadline as a Moscow day (the card's «До ДД.ММ.ГГГГ», or set on the board)
--   state              recorded → paid → at_model → shot → given → closed; partly (сдан частично),
--                      revision (правка), refused (отказ модели, the reason in state_note), cancelled.
--                      `paid` may come after `at_model` («после готовности»): payments are their own rows.
--   state_at           when the current state began (the checks count from it)
--   state_note         the reason of a refusal, what a revision or a partial delivery is about
--   state_ref          the model's message the state comes from (`tg:<chat>/<topic>/<msg>`)
--   given_message_ref  the page's platform message that carried the media to the fan; given_at — when
--   accepted_by        the chatter who took the order (null for an imported one)
--   origin             extension | agent | workboard | import
--   contentops_ref     the ContentOps order (`<model>/<order id>`), kept as it was
--   source_text        the card's whole text as it was posted in Telegram (an imported or a reported card)
--   parts_done         the parts the model delivered whole: video, photos (the card says which are wanted)
--   person_fields      the card's fields a person edited: an agent's later edit of one of them is refused
--   version            grows with every change: an agent's edit names the version it read
--
-- custom_order_payments — the sales that pay an order: zero or more `transactions.id` of the fan (a tip, a
--   tier, a subscription). One sale pays at most one order (the primary key). An order never creates income:
--   the sales do. No FK to transactions: a fan's erasure anonymizes them, never deletes them.
-- custom_order_cards — the Telegram card messages of an order (`tg:<chat>/<topic>/<msg>`): the chatters'
--   copy, the model's group copy. A card belongs to one order (the primary key).
-- custom_order_messages — the significant messages of an order in Telegram, as the reader of the models' groups
--   records them: a repost of the card, a delivery (the model's line, verbatim excerpt), a revision request
--   (several in one message: `ordinal`; `done_at` when it is fixed), a confirmation, a note. One row per message
--   and ordinal: a repeat changes nothing.
-- custom_sale_dismissals — «не кастом»: a sale the custom check pointed at that a person said is not one.
--
-- The history of every change is in object_events (0382), object_type `custom_order`.
-- Erasure: a fan's erasure keeps the order and anonymizes it; a page's erasure deletes its orders.
--
-- The lists widened here are rewritten whole: they carry every value of the migrations before (`introspect:agent_keys`
-- is 0396's, the agents' doors).
--   agent_keys: `write:customs` — create, update and read custom orders (Gengar `/tz`, the reader of the models' groups).
--   person_rights: `records_customs` — «записывает кастомы в системе»: the person gets the custom checks'
--   matters (an unrecorded custom, «отдайте фану»). Off by default.

set local lock_timeout = '5s';

create table if not exists custom_orders (
  id bigint generated always as identity (start with 101) primary key,
  page_id bigint references pages(id) on delete restrict,
  fan_id bigint references fans(id) on delete set null,
  buyer text,
  fan_erased_at timestamptz,
  conversation_ref text,
  card jsonb not null default '{}'::jsonb,
  deadline_on date,
  state text not null default 'recorded',
  state_at timestamptz not null default now(),
  state_note text,
  state_ref text,
  given_message_ref text,
  given_at timestamptz,
  accepted_by_user_id bigint references users(id) on delete restrict,
  origin text not null,
  contentops_ref text,
  source_text text,
  parts_done text[] not null default '{}',
  person_fields text[] not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint custom_orders_state_check check (
    state in ('recorded', 'paid', 'at_model', 'partly', 'shot', 'revision', 'refused', 'given', 'closed', 'cancelled')
  ),
  constraint custom_orders_origin_check check (origin in ('extension', 'agent', 'workboard', 'import')),
  constraint custom_orders_card_check check (jsonb_typeof(card) = 'object' and octet_length(card::text) <= 65536),
  constraint custom_orders_buyer_check check (buyer is null or length(buyer) between 1 and 300),
  constraint custom_orders_note_check check (state_note is null or length(state_note) between 1 and 500),
  constraint custom_orders_state_ref_check check (state_ref is null or length(state_ref) between 3 and 200),
  constraint custom_orders_given_check check (
    (given_message_ref is null or given_message_ref ~ '^[1-9][0-9]{0,29}$') and ((given_message_ref is null) = (given_at is null))
  ),
  constraint custom_orders_given_state_check check (state not in ('given', 'closed') or given_at is not null),
  constraint custom_orders_contentops_ref_check check (contentops_ref is null or length(contentops_ref) between 3 and 200),
  constraint custom_orders_source_text_check check (source_text is null or length(source_text) between 1 and 8000),
  constraint custom_orders_parts_check check (parts_done <@ array['video', 'photos']::text[]),
  constraint custom_orders_version_check check (version >= 1)
);

create unique index if not exists custom_orders_contentops_ref_uidx on custom_orders (contentops_ref) where contentops_ref is not null;
create index if not exists custom_orders_fan_idx on custom_orders (fan_id, page_id) where fan_id is not null;
create index if not exists custom_orders_page_state_idx on custom_orders (page_id, state, state_at);
create index if not exists custom_orders_state_idx on custom_orders (state, state_at);

create table if not exists custom_order_payments (
  transaction_id bigint primary key,
  order_id bigint not null references custom_orders(id) on delete cascade,
  added_by_user_id bigint references users(id) on delete restrict,
  added_at timestamptz not null default now()
);
create index if not exists custom_order_payments_order_idx on custom_order_payments (order_id);

create table if not exists custom_order_cards (
  telegram_ref text primary key,
  order_id bigint not null references custom_orders(id) on delete cascade,
  posted_at timestamptz,
  author text,
  added_at timestamptz not null default now(),
  constraint custom_order_cards_author_check check (author is null or length(author) between 1 and 120),
  constraint custom_order_cards_ref_check check (telegram_ref ~ '^tg:[a-z0-9_]+/[0-9]+(/[0-9]+)?$')
);
create index if not exists custom_order_cards_order_idx on custom_order_cards (order_id);

create table if not exists custom_order_messages (
  id bigint generated always as identity primary key,
  order_id bigint not null references custom_orders(id) on delete cascade,
  telegram_ref text not null,
  ordinal smallint not null default 0,
  kind text not null,
  part text,
  posted_at timestamptz,
  author text,
  excerpt text,
  done_at timestamptz,
  added_at timestamptz not null default now(),
  constraint custom_order_messages_key unique (order_id, telegram_ref, ordinal),
  constraint custom_order_messages_ref_check check (telegram_ref ~ '^tg:[a-z0-9_]+/[0-9]+(/[0-9]+)?$'),
  constraint custom_order_messages_kind_check check (kind in ('repost', 'delivery', 'revision', 'confirmation', 'note')),
  constraint custom_order_messages_part_check check (part is null or (kind = 'delivery' and part in ('video', 'photos'))),
  constraint custom_order_messages_ordinal_check check (ordinal between 0 and 50),
  constraint custom_order_messages_author_check check (author is null or length(author) between 1 and 120),
  constraint custom_order_messages_excerpt_check check (excerpt is null or length(excerpt) between 1 and 500),
  constraint custom_order_messages_done_check check (done_at is null or kind = 'revision')
);
create index if not exists custom_order_messages_ref_idx on custom_order_messages (telegram_ref);

create table if not exists custom_sale_dismissals (
  transaction_id bigint primary key,
  user_id bigint references users(id) on delete restrict,
  dismissed_at timestamptz not null default now()
);

comment on table custom_orders is
  'Заказ кастома (0399): one order from the fan''s chat to the fan''s hands; code K-<id>. fan_customs (0310) stays empty.';
comment on table custom_order_payments is 'The sales that pay a custom order; one sale pays at most one order. Never income.';
comment on table custom_order_cards is 'The Telegram card messages of a custom order (tg:<chat>/<topic>/<msg>); a card belongs to one order.';
comment on table custom_order_messages is 'The significant Telegram messages of a custom order: repost, delivery, revision, confirmation, note; one row per message and ordinal.';
comment on table custom_sale_dismissals is '«Не кастом»: a sale the custom check pointed at that a person said is not a custom.';

alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications',
      'approve:vault_albums',
      'write:fan_queues',
      'read:content',
      'read:team',
      'withdraw:publications',
      'delete:posts',
      'look:media',
      'write:matters',
      'read:pay_terms',
      'propose:people',
      'signin:contentops',
      'signin:taskindex',
      'signin:monitor',
      'write:reports',
      'write:system_state',
      'introspect:agent_keys',
      'write:customs'
    ]::text[]
  );

alter table person_rights
  drop constraint person_rights_right_check,
  add constraint person_rights_right_check check ("right" in ('customs_lead', 'records_customs'));
