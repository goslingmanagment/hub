-- agency-hub:rollback-compatible — a nullable column on shift_handin_candidates, a partial index, a one-time backfill of the new column on open candidates and a trigger function that refuses everything 0432 did plus a change of the new column: the previous image never names the column, its inserts leave it null and its updates never touch it.
-- 0440_shift_handin_expected_reviewer.sql
--
-- Expected reviewer snapshot at hand-in (OA-002): `shift_handin_candidates.expected_reviewer_person_id` records which
-- active reviewer agent (people.kind = 'agent', state <> 'left', same realm, holding a live key with
-- `review:shift_reports` on ALL pages of the shift) was expected to check the candidate when it was handed in (null
-- when none covered all shift pages). Issuing, rotating or revoking a reviewer key afterwards never changes the phase
-- or review expectation of an already handed-in shift.
--
-- Open candidates at rollout receive their provable expected reviewer once without changing any report's phase or
-- state; then `shift_handin_candidates_immutable()` is recreated to freeze `expected_reviewer_person_id` alongside the
-- rest of the candidate's content (every rule of 0425 and 0432 preserved).

set local lock_timeout = '5s';

alter table shift_handin_candidates
  add column if not exists expected_reviewer_person_id bigint references people(id) on delete restrict;

comment on column shift_handin_candidates.expected_reviewer_person_id is
  'Expected reviewer agent person recorded at hand-in (0440): active reviewer of the shift''s realm covering all shift pages; null when no review is expected. Immutable once recorded; inherited on remake.';

create index if not exists shift_handin_candidates_reviewer_awaiting_idx
  on shift_handin_candidates (expected_reviewer_person_id, made_at, id)
  where superseded_at is null and gengar_answered_at is null and expected_reviewer_person_id is not null;

-- One-time backfill of open candidates at rollout, without changing any report's phase or state.
-- A candidate already in `confirm` within the 10-minute window with no answer provably went straight to `confirm`
-- with no reviewer expected at hand-in, so it stays null.
with backfilled as (
  select c.id as candidate_id,
         (
           select p.id
           from shifts s
           join lateral (
             select array_agg(distinct pg.id) as page_ids,
                    count(*) as total_pages,
                    count(pg.id) as resolved_pages
             from jsonb_array_elements(s.pages) as sp(item)
             left join pages pg on pg.label = sp.item ->> 'pageLabel'
           ) shift_pages on true
           join people p on p.kind = 'agent'
             and p.state <> 'left'
             and p.is_test = shift_handin_report_is_test(h.id)
           where s.id = h.shift_id
             and shift_pages.total_pages > 0
             and shift_pages.resolved_pages = shift_pages.total_pages
             and exists (
               select 1
               from person_agent_keys pak
               join agent_keys k on k.id = pak.agent_key_id
               where pak.person_id = p.id
                 and 'review:shift_reports' = any(k.capabilities)
                 and k.revoked_at is null
                 and k.expires_at > now()
                 and k.page_ids @> shift_pages.page_ids
             )
           order by p.code, p.id
           limit 1
         ) as reviewer_person_id
  from shift_handin_candidates c
  join shift_handins h on h.id = c.handin_id
  where c.superseded_at is null
    and c.confirmed_at is null
    and c.expected_reviewer_person_id is null
    and (h.phase = 'checking' or c.gengar_answered_at is not null or c.made_at <= now() - interval '10 minutes')
)
update shift_handin_candidates c
set expected_reviewer_person_id = b.reviewer_person_id
from backfilled b
where c.id = b.candidate_id
  and b.reviewer_person_id is not null;

create or replace function shift_handin_candidates_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm' and shift_handin_report_is_test(old.handin_id) then
      return old;
    end if;
    raise exception 'shift_handin_candidates rows are never deleted';
  end if;
  if new.handin_id is distinct from old.handin_id or new.number is distinct from old.number
    or new.made_at is distinct from old.made_at or new.door is distinct from old.door
    or new.actor_user_id is distinct from old.actor_user_id or new.agent_key_id is distinct from old.agent_key_id
    or new.telegram_message_ref is distinct from old.telegram_message_ref
    or new.telegram_sender_id is distinct from old.telegram_sender_id or new.cutoff_at is distinct from old.cutoff_at
    or new.total_mills is distinct from old.total_mills or new.pages is distinct from old.pages
    or new.off_platform is distinct from old.off_platform or new.comment is distinct from old.comment
    or new.model_comments is distinct from old.model_comments
    or new.rule_version is distinct from old.rule_version
    or new.expected_reviewer_person_id is distinct from old.expected_reviewer_person_id then
    raise exception 'shift_handin_candidates content is immutable (a correction is a new candidate)';
  end if;
  if new.lines is distinct from old.lines then
    if coalesce(current_setting('agency_hub.erasure', true), '') <> 'shift_handin_lines'
      or jsonb_array_length(new.lines) <> jsonb_array_length(old.lines)
      or (select bool_or((n.value - 'note') is distinct from (o.value - 'note'))
            from jsonb_array_elements(new.lines) with ordinality as n(value, i)
            join jsonb_array_elements(old.lines) with ordinality as o(value, i) using (i)) then
      raise exception 'shift_handin_candidates lines are immutable (only the fan erasure clears a note)';
    end if;
  end if;
  return new;
end
$$;
