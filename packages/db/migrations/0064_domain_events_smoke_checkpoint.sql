-- Kernel Stage 21: the event-stream v2 smoke consumer's durable state — one
-- row holding the resume cursor and the conformance counters (gaps/duplicates
-- must stay zero; the row is the production instrument's memory across worker
-- restarts).
create table if not exists domain_events_smoke_checkpoint (
  id smallint primary key default 1 check (id = 1),
  cursor text not null,
  frames_seen bigint not null default 0,
  gap_count bigint not null default 0,
  duplicate_count bigint not null default 0,
  updated_at timestamptz not null default now()
);
