-- agency-hub:rollback-compatible — four new tables and two wider checks: the previous image never names the tables and never writes the new right or capability.
-- 0400_shift_handins.sql
--
-- The shift report as an object of Hub (ecosystem plan 2026-11-12, package F):
-- one report per shift row (`shifts`, 0379), its draft edits, its immutable
-- submitted versions and the money a person says came past the platform. The
-- old `shift_reports` / `shift_report_*` tables (0311, 0318) are NOT these and
-- nothing here writes them: `agentTeamSales` still serves their marks to the
-- ledger, which applies them to sale homes.
--
-- shift_handins — one report per shift (Отчёт смены):
--   state             open (nothing submitted yet) | submitted (the newest version is the report)
--   comment           the draft's comment for the next shift and the owner, saved as typed
--   current_version   the newest submitted version; null while open
--   Accrued and paid are the ledger's states: read there, never stored here.
-- shift_handin_marks — what the person says of one sale of the draft, saved as made:
--   statement         null (the rule's word stands) | not_mine | share (with share_with_user_id) | mine
--   note              a short note of the line («секстинг, обещал вернуться»)
-- shift_handin_versions — one row per submission, never changed: through which door
--   (extension, workboard by the person's session; telegram by an agent key «со слов», with the
--   message reference and the sender's Telegram id the server checked against the person),
--   the lines as submitted (transaction id, page, net, the rule's home and share, the statement,
--   the note, the amount), the page sums, the total, the comment, the off-platform lines, and
--   whether the ledger said the report date was paid at that moment (null — not known).
--   A version holds no fan's name: a fan is reached through `transactions` at read time.
-- off_platform_sales — «мимо площадки»: money a person says came past the platform, with its
--   own permanent id; pending until the owner confirms it, never in the page sums before.
--   Withdrawn by the person while the draft is open; never deleted.
--
-- The person's switch «сдаёт смену в системе» is a narrow right of the people registry
-- (`submits_shift`); an agent key writes a report only with `write:shift_reports`. Both checks
-- are rewritten whole and carry every value of the migrations before this one.

set local lock_timeout = '5s';

create table if not exists shift_handins (
  id bigserial primary key,
  shift_id bigint not null references shifts(id) on delete restrict,
  user_id bigint not null references users(id) on delete restrict,
  person_id bigint references people(id) on delete restrict,
  report_date date not null,
  state text not null default 'open',
  comment text not null default '',
  current_version integer,
  submitted_at timestamptz,
  draft_updated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint shift_handins_shift_key unique (shift_id),
  constraint shift_handins_state_check check (state in ('open', 'submitted')),
  constraint shift_handins_version_check check (
    (state = 'submitted') = (current_version is not null and submitted_at is not null)
    and (current_version is null or current_version > 0)
  ),
  constraint shift_handins_comment_check check (length(comment) <= 2000)
);

create index if not exists shift_handins_user_date_idx on shift_handins (user_id, report_date);
create index if not exists shift_handins_person_idx on shift_handins (person_id, report_date) where person_id is not null;

create table if not exists shift_handin_marks (
  handin_id bigint not null references shift_handins(id) on delete restrict,
  transaction_id bigint not null,
  statement text,
  share_with_user_id bigint references users(id) on delete restrict,
  note text,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by_user_id bigint references users(id) on delete restrict,
  updated_by_agent_key_id bigint references agent_keys(id) on delete restrict,
  primary key (handin_id, transaction_id),
  constraint shift_handin_marks_statement_check check (statement is null or statement in ('mine', 'not_mine', 'share')),
  constraint shift_handin_marks_share_check check ((statement = 'share') = (share_with_user_id is not null)),
  constraint shift_handin_marks_note_check check (note is null or length(note) between 1 and 300)
);

create table if not exists shift_handin_versions (
  id bigserial primary key,
  handin_id bigint not null references shift_handins(id) on delete restrict,
  version integer not null,
  submitted_at timestamptz not null default clock_timestamp(),
  door text not null,
  actor_user_id bigint references users(id) on delete restrict,
  agent_key_id bigint references agent_keys(id) on delete restrict,
  telegram_message_ref text,
  telegram_sender_id bigint,
  total_mills bigint not null,
  pages jsonb not null default '[]'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  off_platform jsonb not null default '[]'::jsonb,
  comment text not null default '',
  day_paid boolean,
  rule_version text not null,
  constraint shift_handin_versions_key unique (handin_id, version),
  constraint shift_handin_versions_version_check check (version > 0),
  constraint shift_handin_versions_door_check check (door in ('extension', 'workboard', 'telegram')),
  -- «Со слов»: only an agent key submits through Telegram, and never without the message and its sender.
  constraint shift_handin_versions_agent_check check (
    (door = 'telegram') = (agent_key_id is not null)
    and (door <> 'telegram' or (telegram_message_ref is not null and telegram_sender_id is not null))
    and (door = 'telegram' or actor_user_id is not null)
  ),
  constraint shift_handin_versions_pages_check check (jsonb_typeof(pages) = 'array'),
  constraint shift_handin_versions_lines_check check (jsonb_typeof(lines) = 'array'),
  constraint shift_handin_versions_off_platform_check check (jsonb_typeof(off_platform) = 'array'),
  constraint shift_handin_versions_ref_check check (telegram_message_ref is null or length(telegram_message_ref) between 1 and 300)
);

-- The ledger's feed reads the versions in the order they were made.
create index if not exists shift_handin_versions_handin_idx on shift_handin_versions (handin_id, version);

-- A submitted version is the record of what was reported: it is never changed or removed.
create or replace function shift_handin_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'shift_handin_versions rows are immutable (a new submission is a new version)';
end
$$;

drop trigger if exists shift_handin_versions_immutable on shift_handin_versions;
create trigger shift_handin_versions_immutable before update or delete on shift_handin_versions
  for each row execute function shift_handin_versions_immutable();

create table if not exists off_platform_sales (
  id bigserial primary key,
  handin_id bigint not null references shift_handins(id) on delete restrict,
  user_id bigint not null references users(id) on delete restrict,
  amount_mills bigint not null,
  from_whom text not null,
  what_for text not null,
  state text not null default 'pending',
  created_at timestamptz not null default clock_timestamp(),
  created_by_user_id bigint references users(id) on delete restrict,
  created_by_agent_key_id bigint references agent_keys(id) on delete restrict,
  decided_at timestamptz,
  decided_by_user_id bigint references users(id) on delete restrict,
  constraint off_platform_sales_amount_check check (amount_mills > 0 and amount_mills <= 100000000),
  constraint off_platform_sales_from_check check (length(btrim(from_whom)) between 1 and 200),
  constraint off_platform_sales_what_check check (length(btrim(what_for)) between 1 and 300),
  constraint off_platform_sales_state_check check (state in ('pending', 'confirmed', 'rejected', 'withdrawn')),
  constraint off_platform_sales_decided_check check ((state in ('confirmed', 'rejected')) = (decided_at is not null))
);

create index if not exists off_platform_sales_handin_idx on off_platform_sales (handin_id, id);
create index if not exists off_platform_sales_pending_idx on off_platform_sales (created_at) where state = 'pending';

comment on table shift_handins is
  'Отчёт смены (0400): one per shift row; open until the first submission, then the newest version is the report. Accrued and paid stay the ledger''s.';
comment on table shift_handin_marks is
  'What the person says of a sale of the draft (не моё, делим с…, моё) and a note, saved as made.';
comment on table shift_handin_versions is
  'Every submission of a shift report, never changed: door, the agent''s message reference and sender, lines, page sums, total, comment.';
comment on table off_platform_sales is
  '«Мимо площадки»: money a person says came past the platform; pending until the owner confirms it, never in the page sums before.';

-- The person's switch: «сдаёт смену в системе».
alter table person_rights
  drop constraint person_rights_right_check,
  add constraint person_rights_right_check check ("right" in ('customs_lead', 'records_customs', 'submits_shift'));

comment on table person_rights is
  'Narrow rights beside the role: customs_lead («ведёт кастомы»), records_customs («записывает кастомы в системе»), submits_shift («сдаёт смену в системе»).';

-- `write:shift_reports`: an agent (Gengar's /smena) reads a person's draft and writes it «со слов».
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
      'write:shift_reports'
    ]::text[]
  );
