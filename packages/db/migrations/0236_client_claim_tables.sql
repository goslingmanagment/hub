-- 0236_client_claim_tables.sql
--
-- chat-extension greeting lease and send custody (hub-pr-plan H-7a;
-- chat-extension architecture §6.7.7–§6.7.9, §8.6 H-7). Three separate facts
-- about one OnlyFans fan of one page:
--
--   client_fan_leases    who is working on the fan's first greeting right now:
--                        a 120 s lease a human renews while working; expired
--                        lazily by the next action on the fan, never by a timer
--   client_greetings     the fan's first greeting is confirmed (receipt + echo
--                        of one message id, a proven native send, or a manual
--                        resolve), with the group whose remaining parts its
--                        owner may still send
--   client_send_custody  one attempt to send one part of a group: dispatching
--                        holds the fan with no expiry until sent, failed (only
--                        with evidence the native queue never took it) or a
--                        manual resolve; registered native sends are recorded
--                        here as already sent
--
-- No route writes these yet (H-7b adds them behind owner switches), so the
-- tables stay empty until then. No scheduled deletion: custody is the record
-- that stops a second greeting. Erasure: page-owned (page inventory), and a
-- fan's rows go with the fan (fan_ref). A desktop greeting is never copied
-- here: the repository reads it from ofapi_commands through the predicate of
-- ofapi_commands_follower_outreach_uniq (0195).
--
-- Message ids use the one OnlyFans id shape of the client contract
-- (^[1-9][0-9]{0,29}$), the same as fan_ref.
--
-- Purely additive; the previous image never names these tables.

create table if not exists client_fan_leases (
  lease_id uuid primary key,
  page_id bigint not null references pages(id),
  fan_ref text not null,
  user_id bigint not null references users(id),
  instance_id uuid not null,
  state text not null,
  expires_at timestamptz not null,
  renew_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_fan_leases_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_fan_leases_state_check check (state in ('active', 'released', 'expired')),
  constraint client_fan_leases_renew_count_check check (renew_count >= 0)
);

-- One live lease per fan.
create unique index if not exists client_fan_leases_active
  on client_fan_leases (page_id, fan_ref) where state = 'active';

create table if not exists client_greetings (
  page_id bigint not null references pages(id),
  fan_ref text not null,
  owner_user_id bigint references users(id),
  generation_ref text,
  variant smallint,
  part_count smallint,
  confirmed_at timestamptz not null,
  first_message_ref text,
  first_attempt_id uuid,
  source text not null,
  primary key (page_id, fan_ref),
  constraint client_greetings_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_greetings_generation_ref_check check (
    generation_ref is null or length(generation_ref) between 1 and 100
  ),
  constraint client_greetings_variant_check check (variant is null or variant between 0 and 2),
  constraint client_greetings_part_count_check check (part_count is null or part_count between 1 and 10),
  constraint client_greetings_first_message_ref_check check (
    first_message_ref is null or first_message_ref ~ '^[1-9][0-9]{0,29}$'
  ),
  constraint client_greetings_source_check check (source in ('preview-send', 'native-register', 'resolve'))
);

create table if not exists client_send_custody (
  attempt_id uuid primary key,
  page_id bigint not null references pages(id),
  fan_ref text not null,
  user_id bigint not null references users(id),
  instance_id uuid not null,
  purpose text not null,
  origin text not null,
  generation_ref text not null,
  variant smallint not null,
  part_count smallint not null,
  part_index smallint not null,
  -- Null only for a registered native send: its body carries no revision.
  text_revision integer,
  request_hash bytea not null,
  lease_id uuid references client_fan_leases(lease_id),
  flag_revision integer,
  state text not null,
  ticket_hash bytea,
  ticket_expires_at timestamptz,
  platform_message_id text,
  failure_reason text,
  failure_http_status smallint,
  resolved_by_user_id bigint references users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_send_custody_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_send_custody_purpose_check check (purpose in ('greeting', 'preview-reply')),
  constraint client_send_custody_origin_check check (origin in ('preview-send', 'native-register')),
  constraint client_send_custody_generation_ref_check check (length(generation_ref) between 1 and 100),
  constraint client_send_custody_variant_check check (variant between 0 and 2),
  constraint client_send_custody_part_count_check check (part_count between 1 and 10),
  constraint client_send_custody_part_index_check check (part_index >= 0 and part_index < part_count),
  constraint client_send_custody_text_revision_check check (
    origin = 'native-register' or (text_revision is not null and text_revision >= 0)
  ),
  constraint client_send_custody_request_hash_check check (length(request_hash) = 32),
  constraint client_send_custody_flag_revision_check check (flag_revision is null or flag_revision >= 0),
  constraint client_send_custody_state_check check (
    state in ('dispatching', 'sent', 'failed', 'resolved_sent', 'resolved_not_sent')
  ),
  -- A preview send always got a one-time ticket (only its sha256 is kept); a
  -- registered native send never did and is recorded already sent.
  constraint client_send_custody_ticket_check check (
    (ticket_hash is null) = (ticket_expires_at is null)
    and (ticket_hash is null or length(ticket_hash) = 32)
    and case origin
      when 'preview-send' then ticket_hash is not null
      else ticket_hash is null and lease_id is null and state = 'sent'
    end
  ),
  constraint client_send_custody_platform_message_id_check check (
    platform_message_id is null or platform_message_id ~ '^[1-9][0-9]{0,29}$'
  ),
  -- A message id is the proof of a send: a sent part has one, a resolved-sent
  -- part may, and no other state carries one (it would take the page's slot
  -- in client_send_custody_message from the real send's proof).
  constraint client_send_custody_message_state_check check (
    case state
      when 'sent' then platform_message_id is not null
      when 'resolved_sent' then true
      else platform_message_id is null
    end
  ),
  -- failed only with evidence the native queue never took the part: the
  -- enqueue call returned nothing, or OnlyFans refused it with a 4xx other
  -- than 401 (a 401 proves nothing about the send). coalesce: a NULL check
  -- result would pass.
  constraint client_send_custody_failure_check check (
    coalesce(case failure_reason
      when 'not_enqueued' then state = 'failed' and failure_http_status is null
      when 'native_rejected' then state = 'failed'
        and failure_http_status between 400 and 499 and failure_http_status <> 401
      else failure_reason is null and state <> 'failed' and failure_http_status is null
    end, false)
  ),
  constraint client_send_custody_resolution_check check (
    (state in ('resolved_sent', 'resolved_not_sent'))
      = (resolved_at is not null and resolved_by_user_id is not null and resolution_note is not null)
    and (resolved_at is not null or (resolved_by_user_id is null and resolution_note is null))
  ),
  constraint client_send_custody_resolution_note_check check (
    resolution_note is null or length(resolution_note) between 1 and 500
  )
);

-- One open send per fan, across every user, instance and purpose.
create unique index if not exists client_send_custody_one_open
  on client_send_custody (page_id, fan_ref) where state = 'dispatching';
-- A part of a group is sent at most once; failed and resolved-not-sent free it.
create unique index if not exists client_send_custody_part_once
  on client_send_custody (page_id, fan_ref, generation_ref, variant, part_index)
  where state in ('dispatching', 'sent', 'resolved_sent');
-- A platform message is recorded once per page.
create unique index if not exists client_send_custody_message
  on client_send_custody (page_id, platform_message_id) where platform_message_id is not null;
-- The per-user preview-send rate window.
create index if not exists client_send_custody_rate
  on client_send_custody (user_id, created_at) where origin = 'preview-send';

comment on table client_fan_leases is
  'chat-extension (H-7a): the lease of one human and one client instance on working out a fan''s first greeting. 120 s, renewed explicitly; expired lazily by the next action on the fan.';
comment on column client_fan_leases.lease_id is 'The client''s leaseToken (a UUID it generates per claim).';
comment on column client_fan_leases.fan_ref is 'The fan''s OnlyFans user id (= chat id); erasure target.';
comment on column client_fan_leases.instance_id is 'The UUID of the client installation that holds the lease.';
comment on column client_fan_leases.state is 'active | released | expired.';

comment on table client_greetings is
  'chat-extension (H-7a): the fan''s first greeting is confirmed. One row per fan; a desktop greeting is read from ofapi_commands, never copied here.';
comment on column client_greetings.fan_ref is 'The fan''s OnlyFans user id; erasure target.';
comment on column client_greetings.owner_user_id is 'Who sent the first confirmed part; only they may send the rest of the group.';
comment on column client_greetings.generation_ref is 'The AI generation of the group (meta.requestId).';
comment on column client_greetings.first_message_ref is 'OnlyFans message id of the first confirmed part, when known.';
comment on column client_greetings.first_attempt_id is 'client_send_custody.attempt_id of the first confirmed part.';
comment on column client_greetings.source is 'preview-send | native-register | resolve.';

comment on table client_send_custody is
  'chat-extension (H-7a): one attempt to send one part of a group to a fan. dispatching holds the fan with no expiry; a dispatching row past ticket_expires_at reads as uncertain-held.';
comment on column client_send_custody.attempt_id is 'The client''s attemptId.';
comment on column client_send_custody.fan_ref is 'The fan''s OnlyFans user id; erasure target.';
comment on column client_send_custody.instance_id is 'The client installation that dispatched or registered it; sent/failed must come from it.';
comment on column client_send_custody.origin is 'preview-send (a dispatch with a ticket) | native-register (a proven send from the composer).';
comment on column client_send_custody.request_hash is 'sha256 of the attempt''s request: a repeat with another body is an attempt conflict.';
comment on column client_send_custody.lease_id is 'The lease a greeting dispatch was checked against, before the greeting was confirmed.';
comment on column client_send_custody.flag_revision is 'The client''s flagRevision at dispatch.';
comment on column client_send_custody.ticket_hash is 'sha256 of the one-time dispatch ticket; the ticket itself is returned once and never stored.';
comment on column client_send_custody.ticket_expires_at is 'Ticket expiry (10 s). Past it, an unresolved dispatch is uncertain-held, never released by time.';
comment on column client_send_custody.platform_message_id is 'The OnlyFans message id of the sent part.';
comment on column client_send_custody.failure_reason is 'not_enqueued | native_rejected (with failure_http_status 4xx other than 401).';
comment on column client_send_custody.resolution_note is 'The resolver''s note (owner or team lead), required with a manual resolve.';
