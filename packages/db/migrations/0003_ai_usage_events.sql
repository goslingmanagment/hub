create type "ai_usage_feature" as enum (
  'fast-reply',
  'improve-draft',
  'help-me',
  'fan-summary',
  'chat-review',
  'ping',
  'hi-greeting'
);

create table "ai_usage_events" (
  "id" bigserial primary key,
  "user_id" bigint not null references "users"("id") on delete cascade,
  "client_event_id" text not null,
  "feature" "ai_usage_feature" not null,
  "model" text not null,
  "input_tokens" integer not null,
  "output_tokens" integer not null,
  "cache_write_tokens" integer not null,
  "cache_read_tokens" integer not null,
  "conversation_id" text,
  "duration_ms" integer,
  "is_cache_hit" boolean not null default false,
  "is_regeneration" boolean not null default false,
  "completed_at" timestamp with time zone not null,
  "ingested_at" timestamp with time zone not null default now(),
  constraint "ai_usage_events_user_client_event_uniq" unique ("user_id", "client_event_id"),
  constraint "ai_usage_events_input_tokens_nonnegative" check ("input_tokens" >= 0),
  constraint "ai_usage_events_output_tokens_nonnegative" check ("output_tokens" >= 0),
  constraint "ai_usage_events_cache_write_tokens_nonnegative" check ("cache_write_tokens" >= 0),
  constraint "ai_usage_events_cache_read_tokens_nonnegative" check ("cache_read_tokens" >= 0),
  constraint "ai_usage_events_duration_ms_nonnegative" check ("duration_ms" is null or "duration_ms" >= 0)
);

create index "ai_usage_events_user_completed_idx"
  on "ai_usage_events" using btree ("user_id", "completed_at");

create index "ai_usage_events_completed_idx"
  on "ai_usage_events" using btree ("completed_at");
