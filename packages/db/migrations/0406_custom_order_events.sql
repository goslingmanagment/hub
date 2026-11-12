-- agency-hub:rollback-compatible — four nullable columns, two indexes, checks every existing row passes, and telegram_ref no longer NOT NULL: the previous image writes every row with its link as before and never names the new columns.
-- 0406_custom_order_events.sql
--
-- Заказ кастома, an event's own identity (review of packages I and N, 2026-11-12). A message of an order was
-- known only by its Telegram link (and ordinal), so an order with no card could take no delivery, and a second
-- event under a link the order had already (ContentOps' retraction as a note) was dropped by the link's
-- uniqueness without a word. Now a row is either a Telegram message (`telegram_ref`, as before: the daily
-- routine, Gengar) or an event of a sender that has its own id of it (`event_ref`, unique per order: ContentOps'
-- delivery and retraction), the Telegram link then only its evidence (`evidence_ref`).
--   complete      a delivery: that part is whole now (null — recorded before this migration).
--   retracted_at  a delivery taken back (ContentOps «это другой заказ»): its part no longer counts.

set local lock_timeout = '5s';

alter table custom_order_messages alter column telegram_ref drop not null;

alter table custom_order_messages
  add column if not exists event_ref text,
  add column if not exists evidence_ref text,
  add column if not exists complete boolean,
  add column if not exists retracted_at timestamptz;

alter table custom_order_messages
  add constraint custom_order_messages_identity_check check ((telegram_ref is null) <> (event_ref is null)),
  add constraint custom_order_messages_event_ref_check check (
    event_ref is null or (event_ref ~ '^[a-z][a-z0-9_]*:[A-Za-z0-9._:-]{1,200}$' and event_ref !~ '^tg:')),
  add constraint custom_order_messages_evidence_check check (
    evidence_ref is null or (event_ref is not null and evidence_ref ~ '^tg:[a-z0-9_]+/[0-9]+(/[0-9]+)?$')),
  add constraint custom_order_messages_complete_check check (complete is null or kind = 'delivery'),
  add constraint custom_order_messages_retracted_check check (retracted_at is null or kind = 'delivery');

create unique index if not exists custom_order_messages_event_key
  on custom_order_messages (order_id, event_ref) where event_ref is not null;
create index if not exists custom_order_messages_evidence_idx
  on custom_order_messages (evidence_ref) where evidence_ref is not null;
