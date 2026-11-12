-- agency-hub:rollback-compatible — three new tables nothing of the previous image names.
-- 0382_matters.sql
--
-- Дела (ecosystem plan §2, §6, package D): one home for everything that waits
-- for a person, opened and closed by the key of its reason; and the history
-- of objects (who did what to a thing, on whose behalf, through which door).
--
-- matters — one row per reason key. A repeat of the finding updates the same
-- row; closing is idempotent; a closed key that comes back reopens its row (the
-- latch of notification_incidents). One writer per kind: the server's
-- mirrors own the kinds they mirror, an agent key only its own.
--   reason_key        `<kind>:<ref>`, stable: `send.held:<attempt id>`, `shift.report.missing:<shift id>`
--   kind              dotted words; the key starts with it
--   source            where the finding comes from: server (Hub's own check), agent, ledger, contentops, person
--   state             open | closed; closed_how: resolved | withdrawn | cause_gone (the condition went away)
--   title             one line a person reads
--   object_type/_id   the thing the matter is about (`client_send`, attempt id), or none
--   page_ids          the pages it is about; empty — no page (every page's)
--   owner_user_id     the person it waits for (a Hub user, until the people registry; `users.person_id` then
--                     leads to the person, so these rows stay as they are) — or owner_role: a role
--   watcher_user_ids  people who follow it (the bell of a later package; they do not widen who reads it)
--   money             the evidence carries money: only the owner reads such a matter
--   evidence          small JSON (≤ 8 KB): what the finding saw; never a fan's name or a message text
--   link              the console path where it is done
--   last_seen_at      when the finding was last confirmed
--
-- matter_checks — one row per kind a mirror keeps: when its source was last
-- asked and last answered (no answer is «не проверено», never a zero), and the
-- side-by-side count of the week of shadow (the old list's count against the
-- matters' own), so a mismatch is visible in SQL as well as in the log.
--
-- object_events — append-only. The history of a thing: a matter's opening,
-- update, closing and comments today, any object's later. actor_* empty — the
-- system; door: extension | workboard | telegram | api | system.
--
-- The read_only role is deliberately NOT granted: a matter may carry money
-- evidence, which only the owner reads.

set local lock_timeout = '5s';

create table if not exists matters (
  id bigserial primary key,
  reason_key text not null,
  kind text not null,
  source text not null,
  state text not null default 'open',
  closed_how text,
  title text not null,
  object_type text,
  object_id text,
  page_ids bigint[] not null default '{}',
  owner_user_id bigint references users(id),
  owner_role text,
  watcher_user_ids bigint[] not null default '{}',
  money boolean not null default false,
  evidence jsonb not null default '{}'::jsonb,
  link text,
  opened_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  constraint matters_reason_key_key unique (reason_key),
  constraint matters_kind_check check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(kind) <= 64),
  constraint matters_reason_key_check check (
    starts_with(reason_key, kind || ':') and length(reason_key) between length(kind) + 2 and 200
  ),
  constraint matters_source_check check (source in ('server', 'agent', 'ledger', 'contentops', 'person')),
  constraint matters_state_check check (
    (state = 'open' and closed_how is null and closed_at is null)
    or (state = 'closed' and closed_how in ('resolved', 'withdrawn', 'cause_gone') and closed_at is not null)
  ),
  constraint matters_owner_check check (num_nonnulls(owner_user_id, owner_role) = 1),
  constraint matters_owner_role_check check (owner_role is null or owner_role in ('owner', 'team_lead', 'chatter')),
  constraint matters_object_check check (
    (object_type is null) = (object_id is null)
    and (object_type is null or object_type ~ '^[a-z][a-z0-9_]{0,39}$')
    and (object_id is null or length(object_id) between 1 and 200)
  ),
  constraint matters_title_check check (length(title) between 1 and 300),
  constraint matters_link_check check (link is null or (left(link, 1) = '/' and length(link) <= 500)),
  constraint matters_evidence_check check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 8192)
);

-- What waits now, by kind: the reads and the mirrors' reconcile.
create index if not exists matters_open_kind_idx on matters (kind, opened_at) where state = 'open';
-- «Мои дела»: a person's open matters.
create index if not exists matters_open_owner_user_idx on matters (owner_user_id) where state = 'open' and owner_user_id is not null;

comment on table matters is
  'Дела (0382): what waits for a person, one row per reason key; opened, updated and closed by the key (the latch of notification_incidents).';
comment on column matters.owner_user_id is
  'The person the matter waits for, as a Hub user until the people registry; then users.person_id leads to the person and the row stays.';
comment on column matters.money is
  'The evidence carries money: only the owner reads the matter.';

create table if not exists matter_checks (
  kind text primary key,
  attempted_at timestamptz not null,
  answered_at timestamptz,
  error text,
  applicable boolean not null default true,
  capped boolean not null default false,
  legacy_count integer,
  matter_count integer,
  mismatch_since timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint matter_checks_kind_check check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(kind) <= 64),
  constraint matter_checks_error_check check (error is null or length(error) <= 300),
  constraint matter_checks_counts_check check (coalesce(legacy_count, 0) >= 0 and coalesce(matter_count, 0) >= 0)
);

comment on table matter_checks is
  'Дела (0382): per mirrored kind, when its source last answered (no answer is «не проверено») and the old list''s count beside the matters'' own.';

create table if not exists object_events (
  id bigserial primary key,
  object_type text not null,
  object_id text not null,
  event text not null,
  actor_user_id bigint references users(id),
  actor_agent_key_id bigint references agent_keys(id),
  on_behalf_of_user_id bigint references users(id),
  door text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint object_events_object_type_check check (object_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint object_events_object_id_check check (length(object_id) between 1 and 200),
  constraint object_events_event_check check (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(event) <= 64),
  constraint object_events_actor_check check (num_nonnulls(actor_user_id, actor_agent_key_id) <= 1),
  constraint object_events_door_check check (door in ('extension', 'workboard', 'telegram', 'api', 'system')),
  constraint object_events_changes_check check (jsonb_typeof(changes) = 'object' and octet_length(changes::text) <= 8192)
);

create index if not exists object_events_object_idx on object_events (object_type, object_id, id);

comment on table object_events is
  'История объекта (0382): who did what to a thing, on whose behalf, through which door; append-only.';
