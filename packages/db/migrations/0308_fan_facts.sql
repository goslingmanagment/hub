-- agency-hub:rollback-compatible — one new table only: the previous image never names it.
-- 0308_fan_facts.sql
--
-- Chat Memory week 2 (docs/plans/2026-10-24-chat-memory/week-2.md §3): facts
-- from the chat. What the fan told about himself (`about`), what was promised
-- (`promise`) and what was agreed (`agreement`), each pointing to the one
-- message it comes from: the archive's own key (page, platform, message_ref)
-- in its chat (`conversation_ref`: on Fansly the group, on OnlyFans the fan).
--
-- `source`: `ai` — written by the facts lane after a conversation (its run in
-- `run_id`); `chatter` — a chatter's correction of a fact. `state`: `active`
-- is what the card shows and the AI features read; `closed` — the AI saw it
-- stop being true or done (`change_note` says why); `deleted` — a chatter
-- removed it; `corrected` — a chatter rewrote it, `replaced_by_fact_id` is the
-- rewrite. Nothing is deleted by a chatter: the row keeps who and when.
--
-- Erasure: a fan's facts go with the fan (cascade); a page's with the page.

create table if not exists fan_facts (
  id bigint generated always as identity primary key,
  fan_id bigint not null references fans(id) on delete cascade,
  page_id bigint not null references pages(id),
  platform text not null references platforms(key),
  conversation_ref text not null,
  kind text not null,
  text text not null,
  message_ref text not null,
  message_at timestamptz,
  source text not null,
  state text not null default 'active',
  run_id bigint,
  created_by_user_id bigint references users(id),
  created_at timestamptz not null default now(),
  changed_by_user_id bigint references users(id),
  changed_at timestamptz,
  change_note text,
  replaced_by_fact_id bigint references fan_facts(id),
  constraint fan_facts_kind_check check (kind in ('about', 'promise', 'agreement')),
  constraint fan_facts_text_check check (length(text) between 1 and 500),
  constraint fan_facts_source_check check (source in ('ai', 'chatter')),
  constraint fan_facts_state_check check (state in ('active', 'closed', 'deleted', 'corrected')),
  constraint fan_facts_message_check check (message_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint fan_facts_change_note_check check (change_note is null or length(change_note) <= 300)
);

-- A person's card: the active facts of its accounts.
create index if not exists fan_facts_fan_state on fan_facts (fan_id, state);
-- One conversation's facts, for the facts lane's next run.
create index if not exists fan_facts_conversation on fan_facts (page_id, conversation_ref, state);

comment on table fan_facts is
  'Chat Memory: facts from the chat about one fan (about / promise / agreement), each pointing to its message; written by the facts lane or corrected by a chatter.';
