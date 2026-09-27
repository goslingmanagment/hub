-- 0213_ai_media_accelerator_reads.sql
--
-- AI media describer, Fansly freshness accelerator (docs/runbooks/ai-media-describe.md).
-- Ships OFF (AI_MEDIA_DESCRIBE_FANSLY_ACCELERATOR_ENABLED).
--
-- When a WebSocket frame says a fan just sent media, the hub may read the head
-- of that one conversation (one dm_messages page, `before` null) so the image
-- is described before the chatter's first reply. Each row is one requested
-- read; `admitted_at` marks a physical attempt and is the agency-wide rolling
-- 24 h budget (conservative: an attempt admitted and then lost still counts).
-- Operational custody: replay or a rebuild must never grant the budget again.
--
-- Purely additive, IF NOT EXISTS; no existing table changes.
create table if not exists ai_media_accelerator_reads (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  group_ref text not null,
  message_ref text not null,
  requested_at timestamptz not null default now(),
  status text not null default 'pending',
  outcome text,
  request_id text,
  admitted_at timestamptz,
  finished_at timestamptz,
  constraint ai_media_accelerator_reads_message_uniq unique (page_id, message_ref),
  constraint ai_media_accelerator_reads_status_check
    check (status in ('pending', 'admitted', 'done', 'skipped', 'failed'))
);

create index if not exists ai_media_accelerator_reads_pending_idx
  on ai_media_accelerator_reads (page_id, requested_at)
  where status = 'pending';

create index if not exists ai_media_accelerator_reads_admitted_idx
  on ai_media_accelerator_reads (admitted_at)
  where admitted_at is not null;

create index if not exists ai_media_accelerator_reads_group_idx
  on ai_media_accelerator_reads (page_id, group_ref, admitted_at);
