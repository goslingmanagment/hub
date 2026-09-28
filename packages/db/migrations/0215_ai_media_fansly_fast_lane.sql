-- 0215_ai_media_fansly_fast_lane.sql
--
-- AI media describer, Fansly fast lane (docs/runbooks/ai-media-describe.md).
-- Ships OFF (AI_MEDIA_DESCRIBE_FANSLY_FAST_LANE_MODE = off).
--
-- The fast lane reads a conversation's head right after the hub's own WS
-- frame says a fan sent media, outside the page's sync lease but through the
-- same egress pacing. Its requests share ai_media_accelerator_reads (and the
-- agency-wide rolling 24 h cap) with the in-chunk accelerator:
--   lane               'chunk' (the DM-chunk step) or 'fast'
--   frame_received_at  when the hub's WS frame arrived (latency metric)
--   generation         the page's credential/proxy generation of that frame;
--                      a read never uses a newer or older session
--   dispatched_at      the physical HTTP start (after the pacing wait)
--   http_status        the provider's answer, when there was one
-- Plus one small health row per page for the "unavailable > 10 min" incident.
--
-- Purely additive, IF NOT EXISTS; no existing row changes meaning.
alter table ai_media_accelerator_reads add column if not exists lane text not null default 'chunk';
alter table ai_media_accelerator_reads add column if not exists frame_received_at timestamptz;
alter table ai_media_accelerator_reads add column if not exists generation text;
alter table ai_media_accelerator_reads add column if not exists dispatched_at timestamptz;
alter table ai_media_accelerator_reads add column if not exists http_status integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_media_accelerator_reads_lane_check') then
    alter table ai_media_accelerator_reads
      add constraint ai_media_accelerator_reads_lane_check check (lane in ('chunk', 'fast'));
  end if;
end $$;

create table if not exists ai_media_fast_lane_health (
  page_id bigint primary key references pages(id) on delete cascade,
  unavailable_since timestamptz,
  reason text,
  cooldown_until timestamptz,
  updated_at timestamptz not null default now()
);
