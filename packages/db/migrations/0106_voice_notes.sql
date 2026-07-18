-- 0106_voice_notes.sql
CREATE TABLE IF NOT EXISTS "page_voice_profiles" (
  "platform_account_id" bigint PRIMARY KEY REFERENCES "pages"("id") ON DELETE CASCADE,
  "voice_id" text NOT NULL,
  "model" text NOT NULL DEFAULT 'eleven_v3',
  "settings" jsonb NOT NULL DEFAULT '{}',
  "output_format" text NOT NULL DEFAULT 'mp3_44100_128',
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "voice_notes" (
  "id" bigserial PRIMARY KEY,
  "user_id" bigint NOT NULL,
  "platform_account_id" bigint NOT NULL REFERENCES "pages"("id"),
  "conversation_ref" text NOT NULL,
  "source_generation_ref" text NOT NULL,
  "client_request_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "script_chars" integer NOT NULL,
  "original_script_sha256" text NOT NULL,
  "final_script_sha256" text NOT NULL,
  "script_edited" boolean NOT NULL,
  "profile_voice_id" text NOT NULL,
  "profile_model" text NOT NULL,
  "profile_settings" jsonb NOT NULL,
  "profile_output_format" text NOT NULL,
  "profile_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "attempt_token" uuid,
  "lease_until" timestamptz,
  "billed" boolean,
  "billed_chars" integer,
  "provider_request_id" text,
  "provider_trace_id" text,
  "provider_region" text,
  "duration_ms" integer,
  "audio_bytes" bytea,
  "audio_sha256" text,
  "audio_bytes_len" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "voice_notes_state_check" CHECK ("state" IN
    ('queued','dispatched','completed','failed_definite',
     'failed_after_dispatch','indeterminate','quota_denied','artifact_expired')),
  CONSTRAINT "voice_notes_chars_positive" CHECK ("script_chars" > 0),
  CONSTRAINT "voice_notes_audio_cap" CHECK ("audio_bytes_len" IS NULL OR "audio_bytes_len" <= 2097152)
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_notes_user_client_request"
  ON "voice_notes" ("user_id", "client_request_id");
CREATE INDEX IF NOT EXISTS "voice_notes_lease_idx"
  ON "voice_notes" ("state", "lease_until");
CREATE INDEX IF NOT EXISTS "voice_notes_purge_idx"
  ON "voice_notes" ("state", "created_at") WHERE "audio_bytes" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "voice_char_budget" (
  "scope" text NOT NULL,
  "utc_day" date NOT NULL,
  "spent_chars" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("scope", "utc_day")
);
