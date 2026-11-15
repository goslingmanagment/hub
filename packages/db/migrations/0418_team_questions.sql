-- agency-hub:rollback-compatible — one new table; the previous image never reads or writes it.
-- 0418_team_questions.sql
--
-- A question to whoever decides (products plan 2026-11-13 §4.6): a chatter asks before doing what is the decider's to
-- allow — a discount over 50 %, sending a paid thing free, a custom's price, terms for a whale, a swap of a shift, being
-- late. ONE object with two doors (Workboard «Ждут вас» → «Спросить»; the extension's fan panel later, through the same
-- operations). Whoever decides is `deciderOf` of the page's model at the moment it is asked (the lead of the team, the
-- owner when there is none or the lead asks); the answer is «Можно» or «Нельзя» with a line, and comes back to the
-- asker. What waits is a matter (`question.asked` the decider's, `question.answered` the asker's), the service the one
-- writer of both. Nothing is deleted: a question asked by mistake is withdrawn, an answer read is marked seen.

set local lock_timeout = '5s';

create table if not exists team_questions (
  id bigint generated always as identity primary key,
  asker_user_id bigint not null references users(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  model_id bigint references models(id) on delete restrict,
  -- The fan it is about, when there is one: the platform's id of the fan on the page, and the name the asker saw.
  fan_ref text,
  fan_name text,
  kind text not null,
  text text not null,
  -- Who decides it: a lead's login; null — the owner.
  decider_user_id bigint references users(id) on delete restrict,
  -- Through which door it was asked: Workboard, the extension.
  door text not null default 'workboard',
  asked_at timestamptz not null default now(),
  state text not null default 'open',
  answer text,
  answer_text text,
  answered_by_user_id bigint references users(id) on delete restrict,
  answered_at timestamptz,
  -- The asker read the answer (their matter closes), or withdrew the question.
  seen_at timestamptz,
  withdrawn_at timestamptz,
  constraint team_questions_kind_check check (kind in ('discount_over_50', 'free_paid', 'custom_price', 'whale_terms', 'swap', 'late')),
  constraint team_questions_text_check check (length(btrim(text)) between 1 and 500),
  constraint team_questions_door_check check (door in ('workboard', 'extension')),
  constraint team_questions_state_check check (state in ('open', 'answered', 'withdrawn')),
  constraint team_questions_answer_check check ((state = 'answered') = (answer is not null) and (answer is null or answer in ('yes', 'no')))
);
create index if not exists team_questions_asker_idx on team_questions (asker_user_id, asked_at desc);
create index if not exists team_questions_open_idx on team_questions (state) where state = 'open';

comment on table team_questions is
  'A chatter''s question to whoever decides (0418): «Можно» / «Нельзя» with a line, back to the asker. Never deleted.';
