-- agency-hub:rollback-compatible — two new tables only: the previous image never names them.
-- 0306_chatter_activity.sql
--
-- Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §2): the
-- actual shift of a chatter, from the activity of the chat extension. While a
-- tab of a granted page is open, the extension's background beats once a
-- minute (`clientActivity`) with the pages it has open and how long ago the
-- person last typed, clicked or scrolled there; when its last tab closes or
-- the person signs out it beats once more with `closed`. No content of the
-- page, no message, no fan: only that a person had a page open and was active.
--
-- `chatter_activity_minutes`: one row per person, page and minute the page was
-- open; `input` — the person was active on it in that minute. The shift is
-- computed from these rows when it is read (services/chatter-shifts.ts).
-- `chatter_activity_instances`: one row per install of the extension of a
-- person — its last beat and whether that beat closed it — for «в разговоре»,
-- which drops when its chatter closes the extension.
--
-- Not journaled in `observations`: a beat is the client's own activity, not
-- platform data. No scheduled deletion. Erasure: page-owned (page inventory).

create table if not exists chatter_activity_minutes (
  user_id bigint not null references users(id),
  page_id bigint not null references pages(id),
  minute timestamptz not null,
  input boolean not null default false,
  -- The start of the minute, as the hub's clock truncates it (the writer: repositories/chatter-activity.ts).
  constraint chatter_activity_minutes_pkey primary key (user_id, page_id, minute)
);

-- A page's activity over a period (who was on the page when).
create index if not exists chatter_activity_minutes_page_minute
  on chatter_activity_minutes (page_id, minute);

create table if not exists chatter_activity_instances (
  user_id bigint not null references users(id),
  instance_id text not null,
  last_beat_at timestamptz not null,
  closed_at timestamptz,
  constraint chatter_activity_instances_pkey primary key (user_id, instance_id),
  constraint chatter_activity_instances_instance_check check (instance_id ~ '^[A-Za-z0-9_-]{8,64}$')
);

comment on table chatter_activity_minutes is
  'Chat Memory: the minutes a chatter had a page open in the chat extension, and whether they were active on it. The shift is computed from these rows on read.';
comment on table chatter_activity_instances is
  'Chat Memory: the last beat of each install of the chat extension of a chatter, and whether it closed the extension.';
