-- agency-hub:rollback-compatible — a new table; the previous image never names it.
-- 0296_voice_provider_health_state.sql
--
-- The ElevenLabs account check (services/voice-provider-health.ts, every
-- 30 min) keeps its latest answer here for the owner's dashboard: the state,
-- when it last checked, and the last reading of the subscription. A failed
-- check keeps the last reading and says when it failed. The readings' history
-- is in ops_metric_samples (vendor_elevenlabs_*). One row.

create table voice_provider_health_state (
  id integer primary key default 1,
  state text not null,
  checked_at timestamptz not null,
  http_status integer,
  read_at timestamptz,
  tier text,
  subscription_status text,
  character_count bigint,
  character_limit bigint,
  next_reset_at timestamptz,
  low_threshold_chars integer,
  updated_at timestamptz not null default now(),
  constraint voice_provider_health_state_singleton_check check (id = 1),
  constraint voice_provider_health_state_state_check check (state in (
    'healthy',
    'characters_low',
    'characters_out',
    'subscription_inactive',
    'key_rejected',
    'unreadable',
    'check_failed'
  )),
  constraint voice_provider_health_state_counts_check check (
    (character_count is null or character_count >= 0)
    and (character_limit is null or character_limit >= 0)
    and (low_threshold_chars is null or low_threshold_chars >= 0)
  )
);
