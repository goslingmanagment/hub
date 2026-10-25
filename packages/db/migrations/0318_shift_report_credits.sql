-- agency-hub:rollback-compatible — one new table: the previous image never names it.
-- 0318_shift_report_credits.sql
--
-- Chat Memory, the shift report's payout export: what a sale pays whom and on
-- which day, written once when the money appears and never recomputed. A
-- chatter's credit appears when they confirm the report holding the sale (on
-- the Moscow day their shift began); the halves of an agreed «делим» together,
-- once one of the two has a confirmed line (on that line's day); the owner's
-- split when he decides a dispute (on the sale's first recorded day). The
-- export sums the live rows whose day is in its window — who confirms what
-- later, a page taken away or a shift still going never moves a row.
--
-- A row is never edited. The owner's split supersedes the sale's earlier rows
-- (`superseded_at`) and writes its own; one live row per chatter and sale.
--
-- Erasure: a page's rows go with the page; no fan data here (the transaction id
-- only — a fan's erasure anonymizes transactions, never deletes them).

create table if not exists shift_report_credits (
  id bigint generated always as identity primary key,
  transaction_id bigint not null,
  user_id bigint not null references users(id),
  page_id bigint not null references pages(id),
  credited_mills bigint not null,
  -- The sale's net when the row was written, and whether the chatter's own amount replaced it.
  net_mills bigint not null,
  own_amount boolean not null default false,
  pay_day date not null,
  source text not null,
  recorded_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint shift_report_credits_source_check check (source in ('report', 'share', 'resolution')),
  constraint shift_report_credits_mills_check check (credited_mills >= 0)
);

create unique index if not exists shift_report_credits_live on shift_report_credits (transaction_id, user_id) where superseded_at is null;
create index if not exists shift_report_credits_day on shift_report_credits (pay_day);
create index if not exists shift_report_credits_page on shift_report_credits (page_id);

comment on table shift_report_credits is 'Chat Memory: what a sale pays a chatter and on which day, written once (the payout export sums the live rows).';
