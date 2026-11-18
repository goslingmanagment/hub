-- agency-hub:rollback-compatible — a new column with a default on three tables and a trigger function that refuses everything it did before plus a change of the new column: the previous image never names the column, its inserts take the default and its updates never touch it.
-- 0432_shift_handin_model_comments.sql
--
-- A shift's report is posted as one post per model (a shift on two models' pages is two posts), and its one comment
-- «для следующей смены» went into every post. Now each model has its own: `model_comments` — an object, model slug →
-- text — beside `comment`, on the draft (shift_handins), frozen in a candidate (0412) and in a version (0400) like
-- `comment`. The comment of model M is `model_comments[M]` when the key is there (an empty text too: «nothing for this
-- model»), else `comment` (shift-handin-rules.ts `modelComment`): every report written before stays as it was. A write
-- that names no model sets `comment` and empties `model_comments`.
--
-- The candidate's content stays immutable: its trigger (newest 0425) is re-created with the new column among the
-- content, every other rule unchanged. A version's trigger (newest 0425) already refuses any change but the erasure of
-- line notes: it compares the whole row but `lines`.

set local lock_timeout = '5s';

alter table shift_handins add column if not exists model_comments jsonb not null default '{}'::jsonb;
alter table shift_handin_candidates add column if not exists model_comments jsonb not null default '{}'::jsonb;
alter table shift_handin_versions add column if not exists model_comments jsonb not null default '{}'::jsonb;

alter table shift_handins drop constraint if exists shift_handins_model_comments_check;
alter table shift_handins add constraint shift_handins_model_comments_check check (jsonb_typeof(model_comments) = 'object');
alter table shift_handin_candidates drop constraint if exists shift_handin_candidates_model_comments_check;
alter table shift_handin_candidates add constraint shift_handin_candidates_model_comments_check check (jsonb_typeof(model_comments) = 'object');
alter table shift_handin_versions drop constraint if exists shift_handin_versions_model_comments_check;
alter table shift_handin_versions add constraint shift_handin_versions_model_comments_check check (jsonb_typeof(model_comments) = 'object');

comment on column shift_handins.model_comments is
  'Each model''s own comment for the next shift, model slug → text (0432); a model without a key reads `comment`.';
comment on column shift_handin_candidates.model_comments is
  'As shift_handins.model_comments, frozen in the candidate (0432).';
comment on column shift_handin_versions.model_comments is
  'As shift_handins.model_comments, frozen in the version (0432).';

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
