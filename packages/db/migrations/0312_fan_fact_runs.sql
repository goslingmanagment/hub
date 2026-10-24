-- agency-hub:rollback-compatible — a new table and a new ledger feature value; the previous image never names either.
-- 0312_fan_fact_runs.sql
--
-- Chat Memory week 2 (docs/plans/2026-10-24-chat-memory/week-2.md §3): the
-- facts lane. Once a conversation went quiet (no message for 15 minutes) and
-- the fan wrote since the last run, one AI run reads its new messages and the
-- current facts and records what to add and what to close (fan_facts, 0308).
--
-- One row per run, written BEFORE the provider call with the cost reserved
-- (the day's cap counts it) and the newest message the run reads: that window
-- is never sent again, whatever happens to the call — a run that did not end is
-- `outcome_unknown`, never retried. The next run starts after the newest
-- message of the last run.
--
-- Spend is the system ledger's (`ai_usage_events`, user NULL, feature
-- `fan-facts`). Erasure: a fan's runs go with the fan (cascade); a page's with
-- the page.

alter type ai_usage_feature add value if not exists 'fan-facts';

create table if not exists fan_fact_runs (
  id bigint generated always as identity primary key,
  page_id bigint not null references pages(id),
  conversation_ref text not null,
  fan_id bigint not null references fans(id) on delete cascade,
  model text not null,
  prompt_version integer not null,
  state text not null default 'running',
  -- The newest message the run reads: the next run starts after it.
  through_message_at timestamptz not null,
  messages_read integer not null,
  reserved_micro_usd bigint not null,
  cost_micro_usd bigint,
  facts_added integer,
  facts_closed integer,
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint fan_fact_runs_state_check check (state in ('running', 'done', 'failed', 'outcome_unknown')),
  constraint fan_fact_runs_error_check check (error_code is null or length(error_code) <= 120)
);

-- The conversation's last run (its watermark).
create index if not exists fan_fact_runs_conversation on fan_fact_runs (page_id, conversation_ref, through_message_at desc);
-- The day's spend against the cap.
create index if not exists fan_fact_runs_started on fan_fact_runs (started_at);

comment on table fan_fact_runs is
  'Chat Memory: one AI run of the facts lane over one quiet conversation, written before the call with its reserved cost; never retried.';
