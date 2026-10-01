-- 0226_fansly_ws_live_overlay.sql
--
-- Fansly Sync Engine, step 1 "Оверлей" (plan §7, §15 step 1): a captured
-- socket frame becomes visible in Hub within seconds, before REST confirms it.
--
-- dm_live_messages is the overlay of provisional messages. One row per
-- (page, Fansly message id). It holds only what the socket may say (plan
-- §7.3): text, sender, chat, normalized time, reply-to and the attachment fact
-- and type (ids only). Tips, PPV prices, purchases and media access stay
-- REST-only and have no column here. A deletion is a sticky mark: a late
-- create frame, a REST read or a replay never clears deleted_at. A deletion
-- that arrives before its create leaves a stub (no sender) that the create
-- later fills without touching the mark.
--
-- The overlay is written by one idempotent apply transaction per receipt:
-- overlay rows, the `message.live_observed` domain event and the receipt's
-- ack (live_state) commit together. Step 1 apply creates no work and makes no
-- HTTP request. A passive parity check later compares each row with the
-- legacy stores (page_dm_messages, message_archive) and records the verdict.
-- Readers do not read the overlay yet (a later PR adds the per-page switch).
--
-- fansly_ws_decode_receipts.live_state is the live ack of each captured frame:
--   legacy   captured before this migration; the live applier never replays it
--   pending  captured, not applied yet (the default for every new row)
--   applied  every message item of the frame is in the overlay
--   debt     a message item lacked a required field, the decoder hit its
--            bound, or the raw frame was unreachable
--   skipped  the frame carries no message item, or every one was erasure-fenced
-- The legacy metadata receipt (state/nodes/decoded_at) is unchanged; the live
-- apply settles it in the same transaction.
--
-- Purely additive, IF NOT EXISTS; the previous image never names the table or
-- the new columns, and its capture insert gets the column defaults.

create table if not exists dm_live_messages (
  page_id bigint not null references pages(id) on delete restrict,
  platform_message_id text not null check (platform_message_id ~ '^[0-9]{1,32}$'),
  -- Fansly groupId (= page_dm_threads.platform_conversation_id =
  -- message_archive.conversation_ref). Null only on a deletion stub whose
  -- frame named no group.
  platform_conversation_id text check (platform_conversation_id ~ '^[0-9]{1,32}$'),
  -- Null only on a deletion stub; a create frame always carries a sender.
  sender_platform_user_id text,
  is_sent_by_page boolean,
  created_at timestamptz,
  content text,
  in_reply_to_message_id text,
  in_reply_to_root_message_id text,
  attachments jsonb not null default '[]'::jsonb,
  message_type integer,
  correlation_id text,
  field_mask integer not null default 0,
  decoder_version integer not null,
  source_observation_id bigint,
  source_received_at timestamptz,
  first_visible_at timestamptz,
  confirm_due_at timestamptz,
  confirmed_at timestamptz,
  confirm_source text check (confirm_source in ('page_dm_messages', 'message_archive')),
  confirm_outcome text check (confirm_outcome in ('match', 'mismatch', 'not_found', 'excluded')),
  mismatch_fields text[],
  deleted_at timestamptz,
  delete_observation_id bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (page_id, platform_message_id)
);

create index if not exists dm_live_messages_thread
  on dm_live_messages (page_id, platform_conversation_id, created_at desc);
create index if not exists dm_live_messages_confirm_due
  on dm_live_messages (confirm_due_at) where confirmed_at is null and confirm_due_at is not null;
create index if not exists dm_live_messages_first_visible
  on dm_live_messages (first_visible_at) where first_visible_at is not null;
create index if not exists dm_live_messages_confirmed
  on dm_live_messages (confirmed_at) where confirmed_at is not null;

comment on table dm_live_messages is
  'Provisional Fansly DM messages from the account socket (plan §7): socket-only fields, sticky deletion, parity verdict against REST. No money fields.';
comment on column dm_live_messages.field_mask is
  'Bit mask of the optional socket fields the create frame carried: 1 content, 2 inReplyTo, 4 inReplyToRoot, 8 attachments, 16 type, 32 correlationId.';
comment on column dm_live_messages.first_visible_at is
  'When the message first became visible in Hub (the apply commit). dm_visible_lag = first_visible_at - created_at.';
comment on column dm_live_messages.confirm_due_at is
  'When the passive parity check next looks for this message in the legacy stores; null on a deletion stub.';
comment on column dm_live_messages.confirm_outcome is
  'Parity verdict: match / mismatch (mismatch_fields) against the confirm_source copy; not_found when no REST copy appeared within the window; excluded when the chat is excluded from message sync.';
comment on column dm_live_messages.deleted_at is
  'Sticky deletion mark from a socket deletion frame; nothing clears it.';

alter table fansly_ws_decode_receipts
  add column if not exists live_state text not null default 'legacy',
  add column if not exists live_decoder_version integer,
  add column if not exists live_applied_at timestamptz;
-- Existing rows keep 'legacy' (catalog-only default above); every row the
-- capture transaction inserts from now on starts 'pending'.
alter table fansly_ws_decode_receipts alter column live_state set default 'pending';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fansly_ws_decode_receipts_live_state_check') then
    alter table fansly_ws_decode_receipts add constraint fansly_ws_decode_receipts_live_state_check
      check (live_state in ('legacy', 'pending', 'applied', 'debt', 'skipped')) not valid;
  end if;
end $$;

create index if not exists fansly_ws_decode_live_pending
  on fansly_ws_decode_receipts (observation_id) where live_state = 'pending';
create index if not exists fansly_ws_decode_live_debt
  on fansly_ws_decode_receipts (live_applied_at) where live_state = 'debt';

comment on column fansly_ws_decode_receipts.live_state is
  'Live overlay ack: legacy (pre-overlay, never replayed), pending, applied, debt, skipped. Set only in the transaction that writes the overlay rows.';
comment on column fansly_ws_decode_receipts.live_decoder_version is
  'FANSLY_WS_LIVE_DECODER_VERSION that acked this receipt.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on dm_live_messages to read_only;
  end if;
end $$;
