-- agency-hub:rollback-compatible — four new tables only: the previous image never names them.
-- 0311_shift_reports.sql
--
-- Chat Memory week 4 (docs/plans/2026-10-24-chat-memory/week-4.md §2): the
-- draft shift report. Hub lists the sales (net) on the pages a chatter was
-- active on during their actual shift, each with the facts (who sent the PPV,
-- who else wrote to the fan in 48 hours); the chatter marks each one
-- («моё», «делим с …», «не моё»), may fix the amount, and confirms. Hub credits
-- no sale: the marks are the people's.
--
-- `shift_report_marks`: one mark per chatter and sale (`transaction_id`, no FK:
-- a fan's erasure anonymizes transactions, never deletes them).
-- `shift_reports`: a confirmed shift of a chatter, and `shift_report_lines` the
-- lines as confirmed — what the payout export reads: the amount credited to the
-- chatter for each sale (a share is the owner's split of the net).
-- `shift_report_resolutions`: the owner's decision on a disputed sale (two
-- «моё», or a «делим» the other side did not agree to): who gets what percent
-- of its net. The export takes it instead of the disputed lines.
--
-- Erasure: a page's marks, lines and resolutions go with the page; a report
-- stays (it holds no page).

create table if not exists shift_report_marks (
  user_id bigint not null references users(id),
  transaction_id bigint not null,
  page_id bigint not null references pages(id),
  mark text not null,
  share_with_user_id bigint references users(id),
  -- The chatter's own net amount for the sale, when Hub's is wrong; null — Hub's.
  amount_mills bigint,
  note text,
  marked_at timestamptz not null default now(),
  constraint shift_report_marks_pkey primary key (user_id, transaction_id),
  constraint shift_report_marks_mark_check check (mark in ('mine', 'share', 'not_mine')),
  constraint shift_report_marks_share_check check ((mark = 'share') = (share_with_user_id is not null)),
  constraint shift_report_marks_amount_check check (amount_mills is null or amount_mills >= 0),
  constraint shift_report_marks_note_check check (note is null or length(note) <= 300)
);

create index if not exists shift_report_marks_transaction on shift_report_marks (transaction_id);
create index if not exists shift_report_marks_page on shift_report_marks (page_id);

create table if not exists shift_reports (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  confirmed_at timestamptz not null default now(),
  credited_net_mills bigint not null,
  constraint shift_reports_user_start unique (user_id, started_at),
  constraint shift_reports_window_check check (ended_at > started_at)
);

create table if not exists shift_report_lines (
  report_id bigint not null references shift_reports(id) on delete cascade,
  transaction_id bigint not null,
  page_id bigint not null references pages(id),
  mark text not null,
  share_with_user_id bigint references users(id),
  net_mills bigint not null,
  credited_mills bigint not null,
  occurred_at timestamptz not null,
  constraint shift_report_lines_pkey primary key (report_id, transaction_id),
  constraint shift_report_lines_mark_check check (mark in ('mine', 'share', 'not_mine'))
);

create index if not exists shift_report_lines_page on shift_report_lines (page_id, occurred_at);

create table if not exists shift_report_resolutions (
  transaction_id bigint primary key,
  page_id bigint not null references pages(id),
  -- [{"userId": 27, "percent": 50}, …]; the percents sum to 100.
  shares jsonb not null,
  decided_by_user_id bigint not null references users(id),
  decided_at timestamptz not null default now(),
  constraint shift_report_resolutions_shares_check check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 5)
);

create index if not exists shift_report_resolutions_page on shift_report_resolutions (page_id);

comment on table shift_report_marks is 'Chat Memory: a chatter''s mark on one sale of their shift (mine / share / not mine), never Hub''s.';
comment on table shift_reports is 'Chat Memory: a shift report a chatter confirmed; its lines are what the payout export reads.';
comment on table shift_report_lines is 'Chat Memory: the lines of a confirmed shift report, as confirmed.';
comment on table shift_report_resolutions is 'Chat Memory: the owner''s split of a disputed sale between chatters, in percent of its net.';
