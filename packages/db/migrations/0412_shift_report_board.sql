-- agency-hub:rollback-compatible — three new tables, nullable columns, columns with defaults and wider checks: the previous image never names the new tables or columns and never writes the new values.
-- 0412_shift_report_board.sql
--
-- The «Отчёт» board (products plan 2026-11-13, package R): phases of a shift report on top of what 0400–0409 keep.
-- A version (`shift_handin_versions`) still means a COUNTED report and everything that reads versions keeps its
-- meaning (the ledger's feed, the claims pass, the post). What is new sits beside it:
--
-- shift_handins.phase — the board's chip:
--   draft     «Черновик»: nothing handed in, the person edits
--   checking  «Проверка»: a candidate is handed in, Hub and Gengar check it (10 minutes at most, the server's timer)
--   confirm   «Подтвердите»: the person signs the candidate a second time
--   counted   «Учтён»: the newest version is the report (state = submitted)
--   fixing    «Правка»: the person edits again; the counted version stands until a new one is confirmed
--   phase_at — when it entered the phase. `state` keeps meaning «a version exists».
-- shift_handin_candidates — what «Сдать смену» records, never a version (the ledger never sees it): the draft exactly as
--   handed in at `cutoff_at` (lines, page sums, total, comment, «мимо площадки»), who and through which door. Its content
--   never changes (trigger; the fan erasure may clear a line's note, as for versions); only its check moves:
--   hub_check (per page: {pageLabel, state, foundCount, foundMills, at}), hub_checked_at, gengar_answered_at and
--   gengar_clean (Gengar's answer), superseded_at/superseded_by (a correction or a re-check made a newer one),
--   confirmed_version/confirmed_at (the version «Подтверждаю» made from it).
-- shift_handin_proposals — Gengar's corrections of a candidate, shown as cards under the sale and never written as the
--   person's own word: kind owner_change (whose: from → to, with the delta of the person's sum) or note; why (one or two
--   sentences), the messages it read; state proposed → declined | accepted, late — it came after the report was counted
--   (a matter for the person; nothing changes by itself). after_counted keeps that once it is answered.
-- shift_handin_marks — two more words on one's own sale: give (to a colleague, to_user_id; settled at once in their
--   favour) and pot (no longer mine; whether it joins a pot is the owner's).
-- sale_claims — origin: version (born from a handed-in version, as before) | draft (asked from the draft at «Спросить»);
--   silence_at — a day of silence settled it for the one who asked (the one who lost may still dispute).
-- sale_sightings — «Нет в Hub»: a sale the site showed (the extension saw the site's own list) that Hub does not hold:
--   page, platform reference, kind, fan, time, gross, net, who saw it on which device; matched_transaction_id once Hub
--   holds it; added_handin_id once a person added it to their report.
--
-- `review:shift_reports`: an agent (Gengar) reads the candidates waiting for a check and answers «замечаний нет» or
-- proposals. It never confirms. The capability check is rewritten whole and carries every value before it.

set local lock_timeout = '5s';

alter table shift_handins
  add column if not exists phase text not null default 'draft',
  add column if not exists phase_at timestamptz;

alter table shift_handins drop constraint if exists shift_handins_phase_check;
alter table shift_handins add constraint shift_handins_phase_check
  check (phase in ('draft', 'checking', 'confirm', 'counted', 'fixing'));

create index if not exists shift_handins_checking_idx on shift_handins (phase_at) where phase in ('checking', 'confirm');

comment on column shift_handins.phase is
  'The board''s phase (0412): draft, checking, confirm, counted, fixing. state keeps meaning «a version exists».';

create table if not exists shift_handin_candidates (
  id bigserial primary key,
  handin_id bigint not null references shift_handins(id) on delete restrict,
  number integer not null,
  made_at timestamptz not null default clock_timestamp(),
  door text not null,
  actor_user_id bigint references users(id) on delete restrict,
  agent_key_id bigint references agent_keys(id) on delete restrict,
  telegram_message_ref text,
  telegram_sender_id bigint,
  cutoff_at timestamptz not null,
  total_mills bigint not null,
  pages jsonb not null default '[]'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  off_platform jsonb not null default '[]'::jsonb,
  comment text not null default '',
  rule_version text not null,
  hub_check jsonb not null default '[]'::jsonb,
  hub_checked_at timestamptz,
  gengar_answered_at timestamptz,
  gengar_clean boolean,
  superseded_at timestamptz,
  superseded_by bigint references shift_handin_candidates(id) on delete restrict,
  confirmed_version integer,
  confirmed_at timestamptz,
  constraint shift_handin_candidates_key unique (handin_id, number),
  constraint shift_handin_candidates_number_check check (number > 0),
  constraint shift_handin_candidates_door_check check (door in ('extension', 'workboard', 'telegram')),
  constraint shift_handin_candidates_agent_check check (
    (door = 'telegram') = (agent_key_id is not null)
    and (door <> 'telegram' or (telegram_message_ref is not null and telegram_sender_id is not null))
    and (door = 'telegram' or actor_user_id is not null)
  ),
  constraint shift_handin_candidates_json_check check (
    jsonb_typeof(pages) = 'array' and jsonb_typeof(lines) = 'array' and jsonb_typeof(off_platform) = 'array'
    and jsonb_typeof(hub_check) = 'array'
  ),
  constraint shift_handin_candidates_ref_check check (telegram_message_ref is null or length(telegram_message_ref) between 1 and 300),
  constraint shift_handin_candidates_gengar_check check ((gengar_answered_at is null) = (gengar_clean is null)),
  constraint shift_handin_candidates_superseded_check check (superseded_by is null or superseded_at is not null),
  constraint shift_handin_candidates_confirmed_check check ((confirmed_version is null) = (confirmed_at is null))
);

create index if not exists shift_handin_candidates_handin_idx on shift_handin_candidates (handin_id, number);
create index if not exists shift_handin_candidates_open_idx on shift_handin_candidates (made_at)
  where superseded_at is null and confirmed_at is null;

-- What was handed in is the record the person signs: only its check moves. The fan erasure may clear a line's note
-- (the same setting as for versions, 0407), and then nothing else of the row may change.
create or replace function shift_handin_candidates_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
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

drop trigger if exists shift_handin_candidates_immutable on shift_handin_candidates;
create trigger shift_handin_candidates_immutable before update or delete on shift_handin_candidates
  for each row execute function shift_handin_candidates_immutable();

create table if not exists shift_handin_proposals (
  id bigserial primary key,
  candidate_id bigint not null references shift_handin_candidates(id) on delete restrict,
  handin_id bigint not null references shift_handins(id) on delete restrict,
  transaction_id bigint not null,
  kind text not null,
  from_word text,
  from_user_id bigint references users(id) on delete restrict,
  to_word text,
  to_user_id bigint references users(id) on delete restrict,
  note text,
  delta_mills bigint not null default 0,
  why text not null,
  message_refs jsonb not null default '[]'::jsonb,
  state text not null default 'proposed',
  after_counted boolean not null default false,
  agent_key_id bigint not null references agent_keys(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  answered_at timestamptz,
  answered_by_user_id bigint references users(id) on delete restrict,
  constraint shift_handin_proposals_kind_check check (kind in ('owner_change', 'note')),
  constraint shift_handin_proposals_word_check check (
    (from_word is null or from_word in ('mine', 'not_mine', 'share', 'give', 'pot', 'rule'))
    and (to_word is null or to_word in ('mine', 'not_mine', 'share', 'give', 'pot', 'rule'))
    and ((kind = 'owner_change') = (to_word is not null))
    and ((kind = 'note') = (note is not null))
  ),
  constraint shift_handin_proposals_note_check check (note is null or length(note) between 1 and 300),
  constraint shift_handin_proposals_why_check check (length(btrim(why)) between 1 and 600),
  constraint shift_handin_proposals_refs_check check (jsonb_typeof(message_refs) = 'array'),
  constraint shift_handin_proposals_state_check check (state in ('proposed', 'declined', 'accepted', 'late')),
  constraint shift_handin_proposals_answered_check check ((state in ('declined', 'accepted')) = (answered_at is not null))
);

create index if not exists shift_handin_proposals_candidate_idx on shift_handin_proposals (candidate_id, transaction_id);
create index if not exists shift_handin_proposals_handin_idx on shift_handin_proposals (handin_id, state);

alter table shift_handin_marks add column if not exists to_user_id bigint references users(id) on delete restrict;
alter table shift_handin_marks drop constraint if exists shift_handin_marks_statement_check;
alter table shift_handin_marks add constraint shift_handin_marks_statement_check
  check (statement is null or statement in ('mine', 'not_mine', 'share', 'give', 'pot'));
alter table shift_handin_marks drop constraint if exists shift_handin_marks_give_check;
alter table shift_handin_marks add constraint shift_handin_marks_give_check check ((statement = 'give') = (to_user_id is not null));

alter table sale_claims
  add column if not exists origin text not null default 'version',
  add column if not exists silence_at timestamptz;
alter table sale_claims drop constraint if exists sale_claims_origin_check;
alter table sale_claims add constraint sale_claims_origin_check check (origin in ('version', 'draft'));

create table if not exists sale_sightings (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  platform_ref text not null,
  kind text not null,
  fan_ref text,
  fan_name text,
  occurred_at timestamptz not null,
  gross_mills bigint,
  net_mills bigint not null,
  seen_by_user_id bigint references users(id) on delete restrict,
  seen_by_device_token_id bigint references device_tokens(id) on delete restrict,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  matched_transaction_id bigint,
  matched_at timestamptz,
  added_handin_id bigint references shift_handins(id) on delete restrict,
  added_at timestamptz,
  added_by_user_id bigint references users(id) on delete restrict,
  constraint sale_sightings_ref_key unique (page_id, platform_ref),
  constraint sale_sightings_ref_check check (length(platform_ref) between 1 and 200),
  constraint sale_sightings_kind_check check (length(kind) between 1 and 64),
  constraint sale_sightings_fan_check check ((fan_ref is null or length(fan_ref) between 1 and 200) and (fan_name is null or length(fan_name) between 1 and 200)),
  constraint sale_sightings_money_check check (net_mills >= 0 and net_mills <= 100000000 and (gross_mills is null or (gross_mills >= 0 and gross_mills <= 100000000))),
  constraint sale_sightings_matched_check check ((matched_transaction_id is null) = (matched_at is null)),
  constraint sale_sightings_added_check check ((added_handin_id is null) = (added_at is null))
);

create index if not exists sale_sightings_open_idx on sale_sightings (page_id, occurred_at) where matched_transaction_id is null;

comment on table shift_handin_candidates is
  'What «Сдать смену» records (0412): the draft as handed in at cutoff_at, checked by Hub and Gengar; never a version, the ledger never sees it.';
comment on table shift_handin_proposals is
  'Gengar''s corrections of a handed-in candidate (0412): cards under a sale; applied only by the person''s confirmation.';
comment on table sale_sightings is
  '«Нет в Hub» (0412): a sale the site showed that Hub does not hold; matched once Hub holds it.';

-- `review:shift_reports`: Gengar's check after the hand-in.
alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications',
      'approve:vault_albums',
      'write:fan_queues',
      'read:content',
      'read:team',
      'withdraw:publications',
      'delete:posts',
      'look:media',
      'write:matters',
      'read:pay_terms',
      'propose:people',
      'signin:contentops',
      'signin:taskindex',
      'signin:monitor',
      'write:reports',
      'write:system_state',
      'introspect:agent_keys',
      'write:customs',
      'write:shift_reports',
      'review:shift_reports'
    ]::text[]
  );
