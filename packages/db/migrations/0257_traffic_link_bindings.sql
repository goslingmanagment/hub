-- 0257_traffic_link_bindings.sql
--
-- OnlyFans traffic sources, bindings (plan 2026-10-08, PR 11, migration D):
-- who brings the traffic of an OnlyFans tracking or trial link, and since
-- when — "link → channel → contractor", each step with its dates.
--
-- Until now the bindings lived only in traffic-control (a SQLite file on the
-- owner's Mac), without dates, and the contractor was a property of the
-- channel that could change under it. Hub now keeps them; traffic-control,
-- the API and the datasets read them from here (later PRs).
--
--   traffic_contractors          who is paid for traffic: key (the /OS
--                                people slug, e.g. coraline-red) and title.
--   traffic_channels             a traffic channel of a model: key
--                                <model>.<channel> (e.g. lora.porntoki —
--                                traffic-control's channel ids are unique only
--                                inside a model), title, note. No status:
--                                "the channel is closed" is the end date of
--                                its rows below, so the state lives in one
--                                place.
--   traffic_channel_contractors  channel → contractor over [valid_from,
--                                valid_to): at any instant a channel has at
--                                most one contractor.
--   traffic_link_bindings        page × link kind × link id → channel over
--                                [valid_from, valid_to): at any instant a link
--                                has at most one channel.
--
-- valid_to null = open (still in force). Instants are UTC; a bare date given
-- to the CLI means 00:00 Europe/Moscow.
--
-- valid_from_basis says how much the start is worth (coordinator's
-- correction П9.7): `confirmed` — the coordinator or the owner confirmed this
-- start; `assumed_link_created` — the start is not known and the link's (for
-- a channel: its first link's) creation date stands in for it. The basis has
-- no default: every writer states it, so an unknown start is never stored as
-- an established one. Readers carry it on (`validFromBasis` in the
-- campaign_bindings dataset), and a channel total over an assumed stretch is
-- flagged.
--
-- "At most one at any instant" covers closed intervals too, so it cannot be
-- a unique index alone: the open-row partial unique indexes below are a
-- backstop, the full check is the writer's (repositories/traffic-bindings.ts:
-- every write of a link or a channel takes a transaction advisory lock on its
-- key, then checks overlaps against all of the key's rows, open and closed,
-- before it writes — П9.6). An exclusion constraint would need btree_gist,
-- which production does not have.
--
-- Written only by the owner's CLI (traffic:bindings:import / :set); every
-- change is an audit_events row. Page erasure deletes the page's
-- traffic_link_bindings (they name its links); channels, contractors and
-- their dates are agency configuration and stay.
--
-- Rollback-compatible: four new tables the previous image never names.
--
-- LOCKING: the foreign key to pages takes SHARE ROW EXCLUSIVE on pages for
-- the instant of the CREATE (page writers wait behind it); lock_timeout keeps
-- the wait brief — if the lock is not had in 5 s this aborts and the deploy
-- rolls back.

set local lock_timeout = '5s';

create table if not exists traffic_contractors (
  id bigserial primary key,
  key text not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traffic_contractors_key_uniq unique (key),
  constraint traffic_contractors_key_check check (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint traffic_contractors_title_check check (length(btrim(title)) between 1 and 200)
);

create table if not exists traffic_channels (
  id bigserial primary key,
  key text not null,
  title text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traffic_channels_key_uniq unique (key),
  constraint traffic_channels_key_check check (key ~ '^[a-z0-9][a-z0-9_-]{0,63}\.[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint traffic_channels_title_check check (length(btrim(title)) between 1 and 200),
  constraint traffic_channels_note_check check (note is null or length(note) between 1 and 2000)
);

create table if not exists traffic_channel_contractors (
  id bigserial primary key,
  channel_id bigint not null references traffic_channels(id) on delete restrict,
  contractor_id bigint not null references traffic_contractors(id) on delete restrict,
  valid_from timestamptz not null,
  valid_to timestamptz,
  valid_from_basis text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traffic_channel_contractors_interval_check check (valid_to is null or valid_to > valid_from),
  constraint traffic_channel_contractors_basis_check check (valid_from_basis in ('confirmed', 'assumed_link_created')),
  constraint traffic_channel_contractors_note_check check (note is null or length(note) between 1 and 2000)
);

-- Backstop of "one contractor per channel": one open row per channel.
create unique index if not exists traffic_channel_contractors_open_uniq
  on traffic_channel_contractors (channel_id) where valid_to is null;
-- A channel's history in order (the overlap check, the readers).
create index if not exists traffic_channel_contractors_channel_idx
  on traffic_channel_contractors (channel_id, valid_from);
create index if not exists traffic_channel_contractors_contractor_idx
  on traffic_channel_contractors (contractor_id, valid_from);

create table if not exists traffic_link_bindings (
  id bigserial primary key,
  platform_account_id bigint not null references pages(id) on delete restrict,
  link_kind text not null,
  platform_link_id text not null,
  channel_id bigint not null references traffic_channels(id) on delete restrict,
  valid_from timestamptz not null,
  valid_to timestamptz,
  valid_from_basis text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traffic_link_bindings_link_kind_check check (link_kind in ('tracking', 'trial')),
  constraint traffic_link_bindings_link_id_check check (platform_link_id ~ '^[0-9]{1,20}$'),
  constraint traffic_link_bindings_interval_check check (valid_to is null or valid_to > valid_from),
  constraint traffic_link_bindings_basis_check check (valid_from_basis in ('confirmed', 'assumed_link_created')),
  constraint traffic_link_bindings_note_check check (note is null or length(note) between 1 and 2000)
);

-- Backstop of "one channel per link": one open row per link.
create unique index if not exists traffic_link_bindings_open_uniq
  on traffic_link_bindings (platform_account_id, link_kind, platform_link_id) where valid_to is null;
-- A link's history in order (the overlap check, the readers).
create index if not exists traffic_link_bindings_link_idx
  on traffic_link_bindings (platform_account_id, link_kind, platform_link_id, valid_from);
create index if not exists traffic_link_bindings_channel_idx
  on traffic_link_bindings (channel_id, valid_from);

comment on table traffic_contractors is
  'OnlyFans traffic sources (plan 2026-10-08, PR 11): who is paid for a channel''s traffic. key = the /OS people slug. Written only by the owner''s CLI (traffic:bindings:*), audited.';
comment on table traffic_channels is
  'OnlyFans traffic sources (PR 11): a traffic channel of a model, key <model>.<channel>. No status: a closed channel is the end date of its rows in traffic_channel_contractors / traffic_link_bindings.';
comment on table traffic_channel_contractors is
  'OnlyFans traffic sources (PR 11): channel → contractor over [valid_from, valid_to). At most one contractor per channel at any instant (closed rows included): the writer locks the channel key and checks overlaps; the open-row unique index is a backstop.';
comment on table traffic_link_bindings is
  'OnlyFans traffic sources (PR 11): page × link kind × link id → channel over [valid_from, valid_to). At most one channel per link at any instant (closed rows included): the writer locks the link key and checks overlaps; the open-row unique index is a backstop. Deleted by page erasure.';
comment on column traffic_channel_contractors.valid_from_basis is
  'confirmed: the coordinator or the owner confirmed this start; assumed_link_created: unknown start, the channel''s first link creation stands in for it (never shown as established).';
comment on column traffic_link_bindings.valid_from_basis is
  'confirmed: the coordinator or the owner confirmed this start; assumed_link_created: unknown start, the link''s creation stands in for it (never shown as established).';
comment on column traffic_link_bindings.platform_link_id is
  'The OnlyFans link id (page_link_stat_snapshots.platform_link_id); a binding may name a link the series has not seen yet.';
comment on column traffic_link_bindings.valid_to is
  'End of the binding (exclusive); null while it is in force.';
comment on column traffic_channel_contractors.valid_to is
  'End of the contractor''s term on the channel (exclusive); null while it is in force.';
