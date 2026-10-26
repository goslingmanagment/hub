-- agency-hub:rollback-compatible — two new tables, a nullable column and a wider state check; the previous image never names the tables or the column and never meets a superseded fact (it reads only the states it knows).
-- 0322_fan_fact_rebuilds.sql
--
-- Chat Memory: rebuilding a conversation's memory with the current prompt.
-- The owner asks for one (CLI `fan-facts:rebuild`) over the conversations of
-- some pages with a total budget. Each conversation, in turn: its AI facts are
-- superseded (kept, never shown or read again), then the facts lane reads its
-- whole history from the first message in windows, oldest first, carrying the
-- memory forward, up to where the live lane had read when the rebuild started.
-- The live lane leaves a conversation alone while its rebuild is open.
--
-- A rebuild's runs are ordinary fan_fact_runs rows with `rebuild_id`: they
-- count against the rebuild's budget, not the live lane's day cap, and the
-- conversation's progress is its newest one (a run that never reached the
-- model only pauses it, as in the live lane).
--
-- Erasure: a fan's rows go with the fan (cascade); a page's with the page.

create table if not exists fan_fact_rebuilds (
  id bigint generated always as identity primary key,
  prompt_version integer not null,
  budget_micro_usd bigint not null,
  note text,
  requested_at timestamptz not null default now(),
  constraint fan_fact_rebuilds_budget_check check (budget_micro_usd >= 0),
  constraint fan_fact_rebuilds_note_check check (note is null or length(note) <= 300)
);

create table if not exists fan_fact_rebuild_conversations (
  rebuild_id bigint not null references fan_fact_rebuilds(id) on delete cascade,
  page_id bigint not null references pages(id),
  conversation_ref text not null,
  fan_id bigint not null references fans(id) on delete cascade,
  -- The order the rebuild takes them in (the longest history first).
  position integer not null,
  state text not null default 'pending',
  -- Where the live lane had read when this conversation's rebuild started: it reads up to here.
  through_message_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  primary key (rebuild_id, page_id, conversation_ref),
  constraint fan_fact_rebuild_conversations_state_check check (state in ('pending', 'running', 'done', 'stopped'))
);

-- The open ones, for the lane (and for the live lane to leave them alone).
create index if not exists fan_fact_rebuild_conversations_open
  on fan_fact_rebuild_conversations (page_id, conversation_ref) where state in ('pending', 'running');

alter table fan_fact_runs add column if not exists rebuild_id bigint references fan_fact_rebuilds(id);
create index if not exists fan_fact_runs_rebuild on fan_fact_runs (rebuild_id, page_id, conversation_ref) where rebuild_id is not null;

alter table fan_facts drop constraint if exists fan_facts_state_check;
alter table fan_facts add constraint fan_facts_state_check check (state in ('active', 'closed', 'deleted', 'corrected', 'superseded'));

comment on table fan_fact_rebuilds is
  'Chat Memory: an owner-asked rebuild of conversations'' memory with the current facts prompt, within a total budget.';
comment on table fan_fact_rebuild_conversations is
  'Chat Memory: one conversation of a rebuild — its old AI facts superseded, its history read again from the first message.';
