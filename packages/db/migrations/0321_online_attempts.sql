-- agency-hub:rollback-compatible — one new table only: the previous image never names it.
-- 0321_online_attempts.sql
--
-- chat-extension «Онлайн»: the page's fans who came online, why to write to
-- each now, and a fast pass through them in one window. The list itself is read
-- from what Hub already holds (presence, chats, spend, subscriptions); this
-- table keeps what the chatters did there, shared by the page's team:
--
-- - `sent`: a message to the fan went from the window (its act: reply, hi,
--   ping or a template of the team's guide). A fan written to this way and
--   silent since is not offered again for three weeks;
-- - `dismissed` / `restored`: «Не предлагать» and its undo. The latest of the
--   two wins; the list says who marked the fan and when.
--
-- Every row is journaled in `observations` first (`observation_id`).
-- Erasure: a fan's rows go with the fan (cascade); a page's with the page.

create table if not exists online_attempts (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  fan_id bigint not null references fans(id) on delete cascade,
  fan_ref text not null,
  conversation_ref text,
  user_id bigint not null references users(id),
  action text not null,
  act text,
  template_id text,
  reason text,
  attempted_at timestamptz not null default now(),
  observation_id bigint,
  constraint online_attempts_action_check check (action in ('sent', 'dismissed', 'restored')),
  constraint online_attempts_act_check check (act is null or length(act) between 1 and 32),
  constraint online_attempts_template_check check (template_id is null or length(template_id) between 1 and 32)
);

-- A fan's latest rows (the cool-down and the mark) and a page's over a period.
create index if not exists online_attempts_fan on online_attempts (page_id, fan_id, attempted_at desc);
create index if not exists online_attempts_page_attempted on online_attempts (page_id, attempted_at);

comment on table online_attempts is
  'chat-extension «Онлайн»: a message sent from the window, or «Не предлагать» and its undo, journaled first.';
