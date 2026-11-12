-- agency-hub:rollback-compatible — nullable columns, wider checks and a scrub of copied words: the previous image never names the columns, writes none of the new values and reads the scrubbed rows as before.
-- 0407_shift_reports_review_2.sql
--
-- Review round 2b of the shift report and the claims.
--
-- shift_handin_versions.report_date — the shift's report date when the version was made (`shifts.report_date` then):
--   a night shift whose first word came before midnight is reported on the day it ended in, not frozen at the
--   first mark's. The report's own `shift_handins.report_date` follows its newest version. Null — a version older
--   than this column (its report's date stands for it).

set local lock_timeout = '5s';

alter table shift_handin_versions add column if not exists report_date date;
comment on column shift_handin_versions.report_date is
  'The shift''s report date when this version was made; null — older than 0407 (the report''s date stands).';

-- One home and one writer for «чья продажа» (review R2b-3): what the team's chat agent records «со слов» — a decision
-- about a sale and a question about one — is written here through the agent's door, no longer in the ledger.
--
-- sale_owner_decisions — gains what the agent records:
--   kind         + off_platform (money a fan paid outside the platform, into a person's report by their word: no sale,
--                never an input of the rule)
--   outcome      + said (recorded «со слов»: the owner's ruling or the chatters' agreement, `said_by` says whose)
--   source       + agent
--   state        + cancelled (with cancel_note, cancelled_at); a newer one still supersedes
--   said_at, source_link, agent_key_id — when it was said, the message, the key that recorded it
--   applied_*    — the report a post-based person's decision was taken into (the person, the date, when)
--   ledger_ref   — the words that name a sale not tied yet (page, fan reference — never a name —, moment, net), the
--                ledger's for an imported decision, the agent's for one recorded «со слов»
-- sale_claims — a question the agent asks about a sale (kind question): asked_of owner (the owner's matter) or chatters
--   (they settle it themselves); answered by a decision, by words (answer_text), or closed (close_note).

alter table sale_owner_decisions
  add column if not exists said_at timestamptz,
  add column if not exists source_link text,
  add column if not exists agent_key_id bigint references agent_keys(id) on delete restrict,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_note text,
  add column if not exists applied_user_id bigint references users(id) on delete restrict,
  add column if not exists applied_report_date date,
  add column if not exists applied_at timestamptz;

alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_kind_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_kind_check check (kind in ('split', 'nobody', 'pot', 'off_platform'));
alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_outcome_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_outcome_check check (outcome in ('first', 'second', 'half', 'nobody', 'imported', 'said'));
alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_source_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_source_check check (source in ('dispute', 'ledger', 'agent'));
alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_state_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_state_check check (state in ('active', 'superseded', 'cancelled'));
-- Money outside the platform names no sale and waits for no link.
alter table sale_owner_decisions drop constraint if exists sale_owner_decisions_link_check;
alter table sale_owner_decisions add constraint sale_owner_decisions_link_check
  check (needs_link = (transaction_id is null and kind <> 'off_platform'));
alter table sale_owner_decisions add constraint sale_owner_decisions_cancel_check
  check ((state = 'cancelled') = (cancelled_at is not null) and (cancel_note is null or length(cancel_note) between 1 and 4000));
alter table sale_owner_decisions add constraint sale_owner_decisions_source_link_check
  check (source_link is null or length(source_link) between 1 and 300);

alter table sale_claims
  add column if not exists asked_of text,
  add column if not exists source_link text,
  add column if not exists asked_by_agent_key_id bigint references agent_keys(id) on delete restrict,
  add column if not exists answer_text text,
  add column if not exists close_note text;

alter table sale_claims drop constraint if exists sale_claims_kind_check;
alter table sale_claims add constraint sale_claims_kind_check check (kind in ('claim', 'double', 'imported', 'question'));
alter table sale_claims drop constraint if exists sale_claims_report_check;
alter table sale_claims add constraint sale_claims_report_check
  check (kind in ('imported', 'question') or (claimant_user_id is not null and claimant_handin_id is not null and transaction_id is not null));
alter table sale_claims drop constraint if exists sale_claims_escalated_check;
alter table sale_claims add constraint sale_claims_escalated_check
  check (escalated_why is null or escalated_why in ('disagree', 'silence', 'no_side', 'double', 'imported', 'question'));
alter table sale_claims add constraint sale_claims_question_check
  check ((kind = 'question') = (asked_of is not null) and (asked_of is null or asked_of in ('owner', 'chatters'))
    and (answer_text is null or length(answer_text) between 1 and 2000) and (close_note is null or length(close_note) between 1 and 2000)
    and (source_link is null or length(source_link) between 1 and 300));

-- What was copied from the ledger names the sale by its page, fan reference, moment and net: never the fan's name, and
-- the ledger's note lives in the decision's own note (review R2b-3c).
update sale_owner_decisions set ledger_ref = ledger_ref - 'fanName' - 'note'
  where ledger_ref is not null and (ledger_ref ->> 'fanName' is not null or ledger_ref ->> 'note' is not null);
update sale_claims set ledger_ref = ledger_ref - 'fanName' - 'note'
  where ledger_ref is not null and (ledger_ref ->> 'fanName' is not null or ledger_ref ->> 'note' is not null);
-- A dispute's title carries the page, the amount, the day and the people, never a fan's name (review R2b-3c); a
-- question says it is one, and one asked of the chatters that nobody answered says so and since when (review R2b-6).
-- The titles of the questions carried over quoted the ledger's question: here they say their page and people; an open
-- one is titled in full (amount, day, «5 нояб.») again by the next pass of the claims.
update matters m
  set title = case when c.ledger_ref ->> 'askedOf' = 'chatters'
      then 'Вопрос чаттерам без ответа с ' || to_char(c.claimed_at at time zone 'Europe/Moscow', 'DD.MM')
      else 'Вопрос «чья продажа» из ledger' end
    || coalesce(': ' || nullif(concat_ws(', ', p.label, c.who_text), ''), '')
  from sale_claims c left join pages p on p.id = c.page_id
  where m.kind = 'sale.dispute' and m.reason_key = 'sale.dispute:q' || c.id::text;
-- The owner's open disputes that are only questions asked of the chatters and never answered, tied to their sale.
update matters m
  set title = 'Вопрос чаттерам без ответа с ' || to_char(q.since at time zone 'Europe/Moscow', 'DD.MM')
    || coalesce(': ' || nullif(concat_ws(', ', q.label, q.who), ''), '')
  from (
    select c.transaction_id, min(c.claimed_at) as since, max(p.label) as label, max(c.who_text) as who
    from sale_claims c left join pages p on p.id = c.page_id
    where c.kind = 'imported' and c.state = 'owner' and c.ledger_ref ->> 'askedOf' = 'chatters' and c.transaction_id is not null
    group by c.transaction_id
  ) q
  where m.kind = 'sale.dispute' and m.state = 'open' and m.reason_key = 'sale.dispute:' || q.transaction_id::text
    and not exists (
      select 1 from sale_claims o where o.transaction_id = q.transaction_id and o.state in ('owner', 'asked') and o.kind in ('claim', 'double')
    );

-- shift_handin_feed_held — the versions the ledger's feed held back for an agent key (a line of a page outside the key's
--   pages, review R2b-4): listed on every read of that key until it may read them, then served once — at their own
--   place, ahead of the new ones — and removed here. The cursor passing a held version never loses it.
create table if not exists shift_handin_feed_held (
  agent_key_id bigint not null references agent_keys(id) on delete cascade,
  version_id bigint not null references shift_handin_versions(id) on delete restrict,
  held_at timestamptz not null default clock_timestamp(),
  primary key (agent_key_id, version_id)
);
