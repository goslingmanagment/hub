-- agency-hub:rollback-compatible — two new tables only: the previous image never names them.
-- 0309_winback.sql
--
-- Chat Memory week 3 (docs/plans/2026-10-24-chat-memory/week-3.md §2–3): win
-- back. The extension's «Вернуть» tab lists a few fans per page to win back —
-- payers silent for two weeks, subscriptions about to end without renewal,
-- new subscribers nobody wrote to — and the chatter picks an approach with one
-- tap and writes in their own words. Hub records the approach and counts the
-- result; it never assigns one and credits no sale.
--
-- `winback_approaches`: the owner's list; a retired one stays for the results
-- of its attempts. `winback_attempts`: one per pick — page, fan, chat, who,
-- which approach, why the fan was listed, when — journaled in `observations`
-- first (`observation_id`). Results (a reply within 72 hours, a purchase within 7
-- days, spend in 30 days) are counted on read from the first message the
-- chatter sent the fan after the pick (client_send_attributions).
--
-- Erasure: a fan's attempts go with the fan (cascade); a page's with the page.

create table if not exists winback_approaches (
  id bigint generated always as identity primary key,
  label text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_by_user_id bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint winback_approaches_label_check check (length(label) between 1 and 80)
);

create unique index if not exists winback_approaches_label_unique on winback_approaches (lower(label));

insert into winback_approaches (label, sort_order) values
  ('Деталь из памяти', 1),
  ('Бесплатное фото', 2),
  ('Мягкий PPV', 3)
on conflict do nothing;

create table if not exists winback_attempts (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  fan_id bigint not null references fans(id) on delete cascade,
  fan_ref text not null,
  conversation_ref text,
  user_id bigint not null references users(id),
  approach_id bigint not null references winback_approaches(id),
  reason text not null,
  picked_at timestamptz not null default now(),
  observation_id bigint,
  constraint winback_attempts_reason_check check (reason in ('silent', 'expiring', 'new_unattended'))
);

-- A page's attempts over a period (the results) and a fan's last one (the cool-down).
create index if not exists winback_attempts_page_picked on winback_attempts (page_id, picked_at);
create index if not exists winback_attempts_fan on winback_attempts (page_id, fan_id, picked_at desc);

comment on table winback_approaches is
  'Chat Memory: the owner''s list of win-back approaches a chatter picks from with one tap.';
comment on table winback_attempts is
  'Chat Memory: one win-back pick of a chatter (page, fan, approach, why listed); results are counted on read.';
