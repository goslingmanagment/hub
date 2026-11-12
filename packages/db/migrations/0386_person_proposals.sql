-- agency-hub:rollback-compatible — one new table nothing of the previous image names.
-- 0386_person_proposals.sql
--
-- An agent's proposal about a person (ecosystem plan 2026-11-12, package A):
-- an agent key never changes a person itself — it proposes, and the proposal
-- waits for the owner's «да». Accepting applies the change through the same
-- service as the owner's own edit; rejecting keeps it as a fact. The «дела»
-- package surfaces the open ones; until then the owner reads them on the
-- person's card.
--
-- person_proposals — one proposal:
--   person_id       the person it is about; null — a new person (proposed_code)
--   proposed_code   the code of the new person
--   change          the change, in the shape of the owner's edit (or create) body, validated before it is stored
--   reason          why, in the agent's words (the person's own words go in as a quote with source_ref)
--   requested_by    who asked the agent (a Hub login or a person's code), if anyone
--   source_ref      where it was said: a message link or id
--   state           open -> accepted | rejected | withdrawn
--   decided_*       who decided and when, and the owner's line

set local lock_timeout = '5s';

create table if not exists person_proposals (
  id bigserial primary key,
  person_id bigint references people(id) on delete restrict,
  proposed_code text,
  change jsonb not null,
  reason text not null,
  requested_by text,
  source_ref text,
  agent_key_id bigint not null references agent_keys(id) on delete restrict,
  state text not null default 'open',
  decided_at timestamptz,
  decided_by_user_id bigint references users(id) on delete restrict,
  decision_note text,
  created_at timestamptz not null default now(),
  constraint person_proposals_target_check check ((person_id is null) <> (proposed_code is null)),
  constraint person_proposals_code_check check (proposed_code is null or proposed_code ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint person_proposals_change_check check (jsonb_typeof(change) = 'object'),
  constraint person_proposals_reason_check check (length(btrim(reason)) between 1 and 2000),
  constraint person_proposals_requested_by_check check (requested_by is null or length(requested_by) <= 100),
  constraint person_proposals_source_ref_check check (source_ref is null or length(source_ref) <= 500),
  constraint person_proposals_state_check check (state in ('open', 'accepted', 'rejected', 'withdrawn')),
  constraint person_proposals_decided_check check ((state = 'open') = (decided_at is null)),
  constraint person_proposals_note_check check (decision_note is null or length(decision_note) <= 2000)
);

create index if not exists person_proposals_open_idx on person_proposals (created_at) where state = 'open';
create index if not exists person_proposals_person_idx on person_proposals (person_id, created_at);
create index if not exists person_proposals_key_idx on person_proposals (agent_key_id, created_at);

comment on table person_proposals is
  'An agent''s proposal about a person (0386): it waits for the owner; accepting applies it through the owner''s edit.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on person_proposals to read_only;
  end if;
end
$$;
