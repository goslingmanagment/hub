-- agency-hub:rollback-compatible — two trigger functions replaced: each refuses everything the previous one did unless a transaction sets the test realm's removal setting, which the previous image never does, and then only for a test person's rows.
-- 0425_sandbox_remove_reports.sql
--
-- A handed-in report (versions 0400, candidates 0412) is never deleted — but the test team's reports (0414) are not
-- records of the agency, and taking the team away (`sandbox:remove`, the owner's word, apps/runtime/src/services/sandbox/
-- remove.ts) has to take them. The one sanctioned DELETE: while the transaction-local setting `agency_hub.sandbox_remove`
-- is `test_realm`, a row whose report is a TEST person's (by the report's person or its login, 0414 `hub_person_is_test`
-- / `hub_user_is_test`) may be deleted. The setting alone opens nothing live: a live row stays refused whatever is set.
-- Every UPDATE rule (0407, 0412) is unchanged.

set local lock_timeout = '5s';

create or replace function shift_handin_report_is_test(p_handin_id bigint) returns boolean
language sql stable as $$
  select coalesce((
    select hub_person_is_test(h.person_id) or hub_user_is_test(h.user_id) from shift_handins h where h.id = p_handin_id
  ), false)
$$;

comment on function shift_handin_report_is_test(bigint) is
  'Whether a handed-in report is a test person''s (0414): the one DELETE the report tables allow is of such a row, while the test realm is being removed (0425).';

create or replace function shift_handin_versions_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('agency_hub.sandbox_remove', true) = 'test_realm' and shift_handin_report_is_test(old.handin_id) then
      return old;
    end if;
    raise exception 'shift_handin_versions rows are immutable (a new submission is a new version)';
  end if;
  if current_setting('agency_hub.erasure', true) = 'shift_handin_lines'
     and (to_jsonb(new) - 'lines') = (to_jsonb(old) - 'lines')
     and jsonb_array_length(new.lines) = jsonb_array_length(old.lines)
     and not exists (
       select 1
       from jsonb_array_elements(old.lines) with ordinality as was(line, i)
       join jsonb_array_elements(new.lines) with ordinality as got(line, i) using (i)
       where case
         when jsonb_typeof(was.line) = 'object' and jsonb_typeof(got.line) = 'object'
           then (was.line - 'note') is distinct from (got.line - 'note')
             or coalesce(got.line -> 'note', 'null'::jsonb) not in ('null'::jsonb, coalesce(was.line -> 'note', 'null'::jsonb))
         else was.line is distinct from got.line
       end
     ) then
    return new;
  end if;
  raise exception 'shift_handin_versions rows are immutable (a new submission is a new version)';
end
$$;

comment on function shift_handin_versions_immutable() is
  'A handed-in version never changes; the exceptions: a fan''s erasure clearing notes inside lines (agency_hub.erasure = shift_handin_lines, 0407), and the removal of the test realm deleting a test person''s version (agency_hub.sandbox_remove = test_realm, 0425).';

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
    or new.rule_version is distinct from old.rule_version then
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
