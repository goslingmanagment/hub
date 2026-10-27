-- agency-hub:rollback-compatible — a new table only: the previous image never names it.
-- 0324_client_note_attributions.sql
--
-- Who wrote each Fansly note (note-attribution-v1). Fansly notes live on
-- Fansly; the hub's sync reads them into page_fan_external_notes (by Fansly's
-- note id, `external_note_id`) but nothing recorded who wrote one. The chat
-- extension writes notes through the page's own session and, once Fansly
-- confirmed a write, reports one fact: this note of this fan, created, edited
-- or deleted, from which control of its notes panel, and for a questionnaire
-- write the labels of the fields it changed. The writer is the hub's own
-- knowledge (the user of the token that reported), never a field of the client's.
--
-- One row per write event of a page: the key is (platform, page_id, event_id),
-- the client's own id of the write; the first report wins and a repeat changes
-- nothing. A note has many rows (its creation, every edit, its deletion); the
-- row joins page_fan_external_notes on (page, fan_ref = fan_id,
-- note_ref = external_note_id).
--
-- No title or text of a note is ever stored here: the sync has the note.
-- `fields` holds questionnaire labels («Возраст», «Питомцы»), never values.
--
-- No scheduled deletion. Erasure: page-owned (page inventory), and a fan's rows
-- go with the fan (fan_ref).

set local lock_timeout = '5s';

create table if not exists client_note_attributions (
  platform text not null references platforms(key),
  page_id bigint not null references pages(id),
  event_id uuid not null,
  fan_ref text not null,
  note_ref text not null,
  note_kind text not null,
  action text not null,
  origin text,
  fields text[],
  user_id bigint not null references users(id),
  source text not null,
  -- The client's clock when Fansly confirmed the write; recorded_at is the hub's.
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  client_version text,
  -- The fact's row in `observations` (no foreign key: the journal is partitioned and tiered).
  observation_id bigint,
  constraint client_note_attributions_pkey primary key (platform, page_id, event_id),
  constraint client_note_attributions_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_note_attributions_note_ref_check check (note_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_note_attributions_note_kind_check check (note_kind in ('note', 'custom_name')),
  constraint client_note_attributions_action_check check (action in ('created', 'edited', 'deleted')),
  constraint client_note_attributions_origin_check check (
    origin is null or origin in ('quick', 'editor', 'field', 'fill', 'undo', 'list', 'name')
  ),
  constraint client_note_attributions_fields_check check (
    fields is null or (cardinality(fields) between 1 and 20)
  ),
  constraint client_note_attributions_source_check check (source in ('fansly-extension')),
  constraint client_note_attributions_client_version_check check (
    client_version is null or length(client_version) between 1 and 64
  )
);

-- A fan's notes and who wrote them (the agent's «who left this note»); also fan erasure.
create index if not exists client_note_attributions_fan
  on client_note_attributions (page_id, fan_ref, observed_at);

-- One note's history.
create index if not exists client_note_attributions_note
  on client_note_attributions (page_id, note_ref, observed_at);

-- One chatter's writes over a period, across pages.
create index if not exists client_note_attributions_user_observed
  on client_note_attributions (user_id, observed_at);

comment on table client_note_attributions is
  'Who wrote each Fansly note (note-attribution-v1): the chatter of the token that reported a confirmed note write of the extension, one row per write event, first report wins. No note title or text.';
