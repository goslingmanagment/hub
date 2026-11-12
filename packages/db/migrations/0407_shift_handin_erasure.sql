-- agency-hub:rollback-compatible — one trigger function replaced: it refuses everything the previous one did unless a transaction sets the erasure's setting, which the previous image never does.
-- 0407_shift_handin_erasure.sql
--
-- A handed-in version (0400) is the record of what was reported and never changes — but a line's note is a
-- person's words about a fan («секстинг, обещал вернуться»), and a fan's erasure must reach them. The one sanctioned
-- change: while the transaction-local setting `agency_hub.erasure` is `shift_handin_lines` (the fan scope of
-- services/erasure sets it around its own statement, `SHIFT_HANDIN_LINES_ERASURE`), an UPDATE may clear notes inside
-- `lines`, and nothing else: every other column as it was, as many lines, every line's other fields as they were, and
-- each note either as it was or JSON null. Sums, amounts, ids and counts cannot move. A DELETE is refused always.

set local lock_timeout = '5s';

create or replace function shift_handin_versions_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('agency_hub.erasure', true) = 'shift_handin_lines'
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
  'A handed-in version never changes; the one exception is a fan''s erasure clearing notes inside lines (setting agency_hub.erasure = shift_handin_lines, 0408).';
