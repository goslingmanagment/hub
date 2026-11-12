-- agency-hub:rollback-compatible — two new tables and three nullable columns: the previous image never names them.
-- 0404_sale_claims.sql
--
-- Заявки и договорённости (ecosystem plan 2026-11-12, package G): what people
-- say about a sale reaches the other side and, when they do not agree, the
-- owner; the owner's decisions; the owner's word on «мимо площадки».
--
-- sale_owner_decisions — the owner's decision of whose a sale is, an input of
--   the one rule (sale-rule.ts) before the rule itself (plan §4.1):
--   kind         split (shares [{userId, percent}], summing to 100) | nobody («никому») | pot (a pot's slug)
--   outcome      first | second | half | nobody — the answer of a dispute; imported — from the ledger
--   rule_home    the sale's home when it was decided: a whole sale given on a nobody's sale is the owner's
--                claim of it (it stops applying when later facts find a holder), any other a decision
--   who, when, why: decided_by_user_id, decided_at, note; an imported one keeps said_by and the ledger's id.
--   A decision is never changed: a new one supersedes it (state superseded). An imported one whose sale
--   the text did not name waits for the owner to link it (needs_link, its words in ledger_ref).
-- sale_claims — one statement that touches another person, from a handed-in report: «моё» on a sale the
--   rule or another person's handed-in report gives to someone else, «делим с …», a sale counted in two
--   reports for more than its net (kind double), a ledger question (kind imported):
--   state        asked (the other side's matter is open) → agreed | owner (the owner's matter is open)
--                → decided; withdrawn — the claimant's report no longer counts it
--   answer       agree | disagree, with a line of why, who, when and through which door
--   escalated    when and why it went to the owner: disagree | silence (24 hours) | no_side | double
--   Sales only: no rate, accrual or payout is here.
-- shift_handin_versions.made_for — why the system made a version on someone's decision (null: the person
--   handed it in): {"kind": "claim", "claimId", "outcome"} or {"kind": "off_platform", "offPlatformId", "decision"}.
-- off_platform_sales.page_id, decided_note — where a confirmed amount counts, and the owner's why.

set local lock_timeout = '5s';

create table if not exists sale_owner_decisions (
  id bigserial primary key,
  transaction_id bigint,
  page_id bigint references pages(id) on delete restrict,
  kind text not null,
  shares jsonb not null default '[]'::jsonb,
  pot text,
  outcome text not null,
  rule_home text,
  note text,
  decided_by_user_id bigint references users(id) on delete restrict,
  decided_at timestamptz not null,
  said_by text,
  source text not null,
  ledger_decision_id integer,
  ledger_ref jsonb,
  needs_link boolean not null default false,
  state text not null default 'active',
  superseded_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint sale_owner_decisions_kind_check check (kind in ('split', 'nobody', 'pot')),
  constraint sale_owner_decisions_outcome_check check (outcome in ('first', 'second', 'half', 'nobody', 'imported')),
  constraint sale_owner_decisions_source_check check (source in ('dispute', 'ledger')),
  constraint sale_owner_decisions_state_check check (state in ('active', 'superseded')),
  constraint sale_owner_decisions_shares_check check (jsonb_typeof(shares) = 'array'),
  constraint sale_owner_decisions_pot_check check ((kind = 'pot') = (pot is not null)),
  constraint sale_owner_decisions_link_check check (needs_link = (transaction_id is null)),
  constraint sale_owner_decisions_note_check check (note is null or length(note) <= 4000)
);

create unique index if not exists sale_owner_decisions_active_idx on sale_owner_decisions (transaction_id)
  where state = 'active' and transaction_id is not null;
create unique index if not exists sale_owner_decisions_ledger_idx on sale_owner_decisions (ledger_decision_id)
  where ledger_decision_id is not null;

create table if not exists sale_claims (
  id bigserial primary key,
  transaction_id bigint,
  page_id bigint references pages(id) on delete restrict,
  kind text not null,
  claimant_user_id bigint references users(id) on delete restrict,
  claimant_handin_id bigint references shift_handins(id) on delete restrict,
  claimant_version integer,
  statement text,
  share_with_user_id bigint references users(id) on delete restrict,
  claimant_note text,
  claimed_at timestamptz not null,
  side_user_id bigint references users(id) on delete restrict,
  side_shift_id bigint references shifts(id) on delete restrict,
  state text not null,
  answer text,
  answer_note text,
  answered_at timestamptz,
  answered_by_user_id bigint references users(id) on delete restrict,
  answered_by_agent_key_id bigint references agent_keys(id) on delete restrict,
  answer_door text,
  answer_ref text,
  escalated_at timestamptz,
  escalated_why text,
  decision_id bigint references sale_owner_decisions(id) on delete restrict,
  closed_at timestamptz,
  ledger_question_id integer,
  question text,
  who_text text,
  ledger_ref jsonb,
  needs_link boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sale_claims_kind_check check (kind in ('claim', 'double', 'imported')),
  constraint sale_claims_state_check check (state in ('asked', 'agreed', 'owner', 'decided', 'withdrawn')),
  constraint sale_claims_statement_check check (statement is null or statement in ('mine', 'share')),
  constraint sale_claims_share_check check ((statement = 'share') = (share_with_user_id is not null)),
  constraint sale_claims_answer_check check (answer is null or answer in ('agree', 'disagree')),
  constraint sale_claims_answered_check check ((answer is null) = (answered_at is null)),
  constraint sale_claims_door_check check (answer_door is null or answer_door in ('extension', 'workboard', 'telegram')),
  constraint sale_claims_escalated_check check (escalated_why is null or escalated_why in ('disagree', 'silence', 'no_side', 'double', 'imported')),
  constraint sale_claims_report_check check (kind = 'imported' or (claimant_user_id is not null and claimant_handin_id is not null and transaction_id is not null)),
  constraint sale_claims_link_check check (needs_link = (transaction_id is null)),
  constraint sale_claims_note_check check (claimant_note is null or length(claimant_note) <= 300),
  constraint sale_claims_answer_note_check check (answer_note is null or length(answer_note) between 1 and 300),
  constraint sale_claims_ref_check check (answer_ref is null or length(answer_ref) between 1 and 300)
);

-- One claim of a report on a sale against one other side (none: the owner's alone).
create unique index if not exists sale_claims_report_idx on sale_claims (claimant_handin_id, transaction_id, coalesce(side_user_id, 0))
  where kind in ('claim', 'double');
create unique index if not exists sale_claims_ledger_idx on sale_claims (ledger_question_id) where ledger_question_id is not null;
create index if not exists sale_claims_sale_idx on sale_claims (transaction_id) where transaction_id is not null;
create index if not exists sale_claims_open_idx on sale_claims (state, claimed_at) where state in ('asked', 'owner', 'agreed');
create index if not exists sale_claims_side_idx on sale_claims (side_user_id, state) where side_user_id is not null;

comment on table sale_owner_decisions is
  'The owner''s decision of whose a sale is (0404): an input of the one rule before the rule; never changed, a new one supersedes it.';
comment on table sale_claims is
  'A statement of a handed-in report that touches another person, its answer and the owner''s decision (0404). Sales only.';

alter table shift_handin_versions add column if not exists made_for jsonb;
comment on column shift_handin_versions.made_for is
  'Why the system made this version on someone''s decision; null — the person handed it in (0404).';

alter table off_platform_sales
  add column if not exists page_id bigint references pages(id) on delete restrict,
  add column if not exists decided_note text;
comment on column off_platform_sales.page_id is 'The page a confirmed amount counts on (0404).';
