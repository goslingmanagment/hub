-- 0212_ai_media_descriptions.sql
--
-- AI media describer (docs/runbooks/ai-media-describe.md).
--
-- CUSTODY EXCEPTION, owner ruling 2026-09-27 (answer 4 of the image arena):
-- for the AI path only, image bytes transit hub WORKER MEMORY on their way to
-- the provider (downscaled, metadata stripped). They are never written to disk,
-- a table, a log or the capture store. What rests here is TEXT: a short
-- description per chat media file, and where that file appeared. The previews
-- rule ("bytes only on chatters' machines", 0210) is unchanged.
--
-- Restricted class, like ai_generation_content: owner-only reads, excluded
-- from lake exports, inside fan and page erasure, never promoted into the fan
-- dossier. No TTL.
--
-- Three purely additive tables, IF NOT EXISTS; no existing table changes.

-- One row per (page, platform, media file, variant). The row is also the work
-- item: status + next_attempt_at + lease_until drive the describer sweep, and
-- lease_until is the single-flight guard (the ledger's unique
-- (user_id, client_event_id) index cannot dedupe NULL-user system rows).
create table if not exists ai_media_descriptions (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  platform text not null,
  -- The platform's media id: Fansly accountMedia id, OnlyFans media id.
  media_ref text not null,
  -- What is described: 'full' (a photo), 'poster' (one frame of a video/GIF,
  -- the platform's own poster) or 'preview' (a PPV teaser the fan sees free).
  variant text not null,
  media_kind text not null,
  sender_role text not null,
  -- The fan who SENT a fan-sent file (NULL for creator media): fan erasure
  -- deletes the description itself, not only its links.
  fan_platform_user_id text,
  status text not null,
  description text,
  model text,
  description_version integer,
  source text,
  source_observation_id bigint,
  content_sha256 text,
  usage_event_id bigint references ai_usage_events(id) on delete set null,
  error_code text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  -- Earliest message time seen for this file: the enable boundary compares it
  -- with the page policy's `since` (no historical processing).
  first_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  described_at timestamptz,
  constraint ai_media_descriptions_key_uniq unique (page_id, platform, media_ref, variant),
  constraint ai_media_descriptions_platform_check check (platform in ('fansly', 'onlyfans')),
  constraint ai_media_descriptions_variant_check check (variant in ('full', 'poster', 'preview')),
  constraint ai_media_descriptions_kind_check check (media_kind in ('photo', 'video', 'gif', 'bundle')),
  constraint ai_media_descriptions_sender_check check (sender_role in ('fan', 'model')),
  -- dormant = known, with a source, in a chat that is not "live" (no AI
  -- generation in 7 days): described only when a generation shows it.
  constraint ai_media_descriptions_status_check check (status in (
    'pending', 'awaiting_source', 'dormant', 'described', 'refused', 'unavailable',
    'failed', 'budget_deferred', 'outcome_unknown', 'skipped_policy')),
  constraint ai_media_descriptions_description_check
    check (description is null or length(description) <= 400),
  constraint ai_media_descriptions_attempts_check check (attempts >= 0)
);

-- The sweep's due queue.
create index if not exists ai_media_descriptions_due_idx
  on ai_media_descriptions (next_attempt_at)
  where status in ('pending', 'awaiting_source', 'budget_deferred');

-- Refusal memory by content, across every page and variant.
create index if not exists ai_media_descriptions_refused_sha_idx
  on ai_media_descriptions (content_sha256)
  where status = 'refused' and content_sha256 is not null;

-- Refusal-breaker window and daily outcome reads.
create index if not exists ai_media_descriptions_terminal_idx
  on ai_media_descriptions (described_at)
  where described_at is not null;

create index if not exists ai_media_descriptions_fan_idx
  on ai_media_descriptions (page_id, fan_platform_user_id)
  where fan_platform_user_id is not null;

-- Where each file appeared. One creator file can go to many fans (mass PPV
-- teasers), so links are many-per-description. Fan erasure deletes the fan's
-- links; a teaser's description (creator content, nothing about the fan) stays.
create table if not exists ai_media_description_links (
  description_id bigint not null references ai_media_descriptions(id) on delete cascade,
  page_id bigint not null references pages(id) on delete restrict,
  platform text not null,
  message_ref text not null,
  -- Canonical conversation: the Fansly groupId, the OnlyFans chat id.
  conversation_ref text,
  -- The fan on the other side of the conversation.
  fan_platform_user_id text,
  sender_role text not null,
  message_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (description_id, message_ref),
  constraint ai_media_description_links_sender_check check (sender_role in ('fan', 'model'))
);

create index if not exists ai_media_description_links_conversation_idx
  on ai_media_description_links (page_id, conversation_ref, message_at);

create index if not exists ai_media_description_links_fan_idx
  on ai_media_description_links (page_id, fan_platform_user_id)
  where fan_platform_user_id is not null;

-- The agency-wide describe budget, one row per UTC day: an atomic reservation
-- (images and micro-USD) is taken BEFORE each provider send, then settled to
-- the real cost. An outcome_unknown send keeps its reservation. The refusal
-- breaker latches here for the rest of the UTC day.
create table if not exists ai_media_describe_days (
  day date primary key,
  images_reserved integer not null default 0,
  micro_usd_reserved bigint not null default 0,
  refusals integer not null default 0,
  breaker_tripped_at timestamptz,
  breaker_reason text,
  updated_at timestamptz not null default now(),
  constraint ai_media_describe_days_counts_check
    check (images_reserved >= 0 and micro_usd_reserved >= 0 and refusals >= 0)
);

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on ai_media_describe_days to read_only;
  end if;
end $$;
