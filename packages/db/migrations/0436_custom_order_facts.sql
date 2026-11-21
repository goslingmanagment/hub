-- agency-hub:rollback-compatible — nullable columns, one with a false default, and two new tables: the previous image never names them, so every order it writes keeps them empty, and it reads none of them.
-- 0436_custom_order_facts.sql
--
-- Заказ кастома, «Custom orders that keep themselves true» (project 2026-11-21, slice 1): the data the four facts of
-- an order are read from (paid, at the model, shot, given — packages/contracts/src/custom-order-rules.ts,
-- `customOrderFactsOf`, derived at read time and never cached on the row), what the reader and the checks pass will
-- write, and two new tables. Nothing writes them yet: the steps, the agent door and the pass come in the next slices,
-- behind the live switch `customsFacts` (off).
--
-- custom_orders:
--   price_mills        the agreed total, gross (the card's free-text `price` stays for people); null — not named.
--                      `paid` is «yes» only when the linked sales reach it, never while it is unknown.
--   deadline_default   the deadline was set by the system (`max(first payment, recorded) + 7 days`, «примерно»), not
--                      by the card or a person; a later edit of the deadline clears it.
--   paid_word          the owner's word on the payment, `{kind: gift | off_platform, note, by, at}`: an order shot
--                      without payment, or paid outside the platform. `paid` is «yes» while it stands.
--   hold_reason        the order waits on purpose (the fan is unreachable, a prop is awaited): it does not burn.
--   fan_asked_at/_ref  the fan asked where the order is (the fan's message); cleared when the page writes to the fan
--                      later, and on given.
--   issue              one sentence the agent writes when the sources disagree about the order, `{text ≤ 200, by, at}`;
--                      the order burns while it stands.
--   sent_at/_message_ref  every file of the order was sent to the fan and a priced one is not bought yet: «отправлен,
--                      фан не открыл» (`given` is «part»), no state change; cleared on given and on a revision.
--
-- custom_findings — one trace of a custom that has no order: a sale (a tip whose note says custom, a tier that includes
--   one), the fan's chat, the chatters' work chat, the model's group, a line of a shift report. `(source, ref)` names it
--   once: a dismissed one does not come back, a tier's next renewal is a new sale and a new finding. It belongs to its
--   page's realm (a finding of no known page is the live agency's). Resolved by recording an order (`recorded`),
--   linking an existing one (`linked`) or dismissing it with a reason from a list (`dismissed`):
--   not_custom (не кастом), sexting (выбрал секстинг), unused (не воспользовался), duplicate (дубль), test (тест).
-- custom_order_rejections — undo is remembered: a sale (`payment`) or a delivering message (`given`) the system or the
--   agent applied to an order and a person undid. The pass and the agent door never apply it to that order again; a
--   person who applies it by hand removes the row. `ref` is the sale (`transactions.id`) or the platform message.
--
-- Erasure (apps/runtime/src/services/erasure): a fan's erasure keeps an order and loses its words — the issue's text,
-- the paid word's note and the hold reason go with the order's other free text, the marks stay. A finding about the fan
-- keeps its source, status, sums and times and loses the fan, the quote and, for his chat, the reference. A page's
-- erasure deletes its findings; its orders take their rejections by FK.

set local lock_timeout = '5s';

alter table custom_orders
  add column if not exists price_mills bigint,
  add column if not exists deadline_default boolean not null default false,
  add column if not exists paid_word jsonb,
  add column if not exists hold_reason text,
  add column if not exists fan_asked_at timestamptz,
  add column if not exists fan_asked_ref text,
  add column if not exists issue jsonb,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_message_ref text;

alter table custom_orders
  add constraint custom_orders_price_check check (price_mills is null or price_mills > 0),
  add constraint custom_orders_paid_word_check check (
    paid_word is null or (jsonb_typeof(paid_word) = 'object' and coalesce(paid_word ->> 'kind', '') in ('gift', 'off_platform')
      and octet_length(paid_word::text) <= 2048)),
  add constraint custom_orders_hold_reason_check check (hold_reason is null or length(hold_reason) between 1 and 500),
  add constraint custom_orders_fan_asked_check check (
    (fan_asked_ref is null or fan_asked_ref ~ '^[1-9][0-9]{0,29}$') and (fan_asked_ref is null or fan_asked_at is not null)),
  add constraint custom_orders_issue_check check (
    issue is null or (jsonb_typeof(issue) = 'object' and length(coalesce(issue ->> 'text', '')) between 1 and 200
      and octet_length(issue::text) <= 2048)),
  add constraint custom_orders_sent_check check (
    (sent_message_ref is null or sent_message_ref ~ '^[1-9][0-9]{0,29}$') and ((sent_message_ref is null) = (sent_at is null)));

comment on column custom_orders.price_mills is 'The agreed total of a custom order, gross (0436); null — not named: «paid» is never yes while it is unknown.';
comment on column custom_orders.deadline_default is 'The deadline was set by the system, «примерно» (0436): recorded or first paid + 7 days. A later edit clears it.';
comment on column custom_orders.paid_word is 'The owner''s word on the payment (0436): {kind: gift | off_platform, note, by, at}.';
comment on column custom_orders.hold_reason is 'Why the order waits on purpose (0436): it does not burn while it stands.';
comment on column custom_orders.fan_asked_at is 'The fan asked where the order is (0436; the message: fan_asked_ref); cleared when the page writes to him later, and on given.';
comment on column custom_orders.issue is 'The sources disagree about the order (0436): {text ≤ 200, by, at}; it burns while it stands.';
comment on column custom_orders.sent_at is 'Every file was sent to the fan and a priced one is not bought yet (0436; the message: sent_message_ref); cleared on given and on a revision.';

create table if not exists custom_findings (
  id bigint generated always as identity primary key,
  source text not null,
  ref text not null,
  page_id bigint references pages(id) on delete restrict,
  fan_id bigint references fans(id) on delete set null,
  amount_mills bigint,
  quote text,
  happened_at timestamptz not null,
  status text not null default 'open',
  order_id bigint references custom_orders(id) on delete set null,
  dismiss_reason text,
  resolved_by_user_id bigint references users(id) on delete restrict,
  resolved_by_agent_key_id bigint references agent_keys(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint custom_findings_key unique (source, ref),
  constraint custom_findings_source_check check (source in ('sale', 'fan_chat', 'work_chat', 'model_group', 'shift_report')),
  constraint custom_findings_ref_check check (length(ref) between 1 and 200),
  constraint custom_findings_amount_check check (amount_mills is null or amount_mills > 0),
  constraint custom_findings_quote_check check (quote is null or length(quote) between 1 and 300),
  constraint custom_findings_status_check check (status in ('open', 'recorded', 'linked', 'dismissed')),
  constraint custom_findings_dismiss_check check (
    (dismiss_reason is null or dismiss_reason in ('not_custom', 'sexting', 'unused', 'duplicate', 'test'))
    and ((status = 'dismissed') = (dismiss_reason is not null))),
  constraint custom_findings_resolved_check check ((status = 'open') = (resolved_at is null))
);
create index if not exists custom_findings_open_idx on custom_findings (created_at) where status = 'open';
create index if not exists custom_findings_page_idx on custom_findings (page_id, status);
create index if not exists custom_findings_fan_idx on custom_findings (fan_id) where fan_id is not null;
create index if not exists custom_findings_order_idx on custom_findings (order_id) where order_id is not null;

create table if not exists custom_order_rejections (
  order_id bigint not null references custom_orders(id) on delete cascade,
  kind text not null,
  ref text not null,
  rejected_by_user_id bigint references users(id) on delete restrict,
  rejected_at timestamptz not null default now(),
  primary key (order_id, kind, ref),
  constraint custom_order_rejections_kind_check check (kind in ('payment', 'given')),
  constraint custom_order_rejections_ref_check check (ref ~ '^[1-9][0-9]{0,29}$')
);

comment on table custom_findings is
  'A trace of a custom with no order (0436): a sale, the fan''s chat, the work chat, the model''s group, a shift report line; (source, ref) once.';
comment on table custom_order_rejections is
  'Undo remembered (0436): a sale or a delivering message a person took off an order; never applied to that order again by the system or an agent.';
