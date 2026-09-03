-- Rebuildable file metadata, distinct from offer identity (decision #238).
CREATE TABLE "creator_raw_media" (
  "page_id" bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform" text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "media_ref" text NOT NULL CHECK (length("media_ref") > 0),
  "owner_account_ref" text,
  "filename" text,
  "media_type" integer,
  "provider_type" text,
  "mime_type" text,
  "duration_ms" bigint CHECK ("duration_ms" >= 0),
  "original_width" integer CHECK ("original_width" >= 0),
  "original_height" integer CHECK ("original_height" >= 0),
  "width" integer CHECK ("width" >= 0),
  "height" integer CHECK ("height" >= 0),
  "frame_rate_milli" bigint CHECK ("frame_rate_milli" >= 0),
  "created_at_platform" timestamptz,
  "updated_at_platform" timestamptz,
  "source_kind" text NOT NULL,
  "first_origin" text NOT NULL,
  "first_observed_at" timestamptz NOT NULL,
  "last_observed_at" timestamptz NOT NULL,
  "content_hash" char(64) NOT NULL,
  "source_event_id" bigint NOT NULL,
  "source_observation_id" bigint NOT NULL,
  "source_account_seq" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "creator_raw_media_pkey" PRIMARY KEY ("page_id", "media_ref")
);
CREATE INDEX "creator_raw_media_page_observed_idx"
  ON "creator_raw_media" ("page_id", "first_observed_at", "media_ref");

ALTER TABLE "creator_vault_album_members" ADD COLUMN "custom_filename" text;

-- Latest proven full unfiltered inventory; partial walks never enter here.
CREATE TABLE creator_vault_album_scans (
  page_id bigint NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  vault_kind text NOT NULL CHECK (vault_kind = 'creator'),
  album_ref text NOT NULL,
  walk_ref text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  seen_media_refs text[] NOT NULL,
  expected_count integer NOT NULL CHECK (expected_count >= 0),
  pages integer NOT NULL CHECK (pages > 0),
  source_event_id bigint NOT NULL,
  source_observation_id bigint NOT NULL,
  source_account_seq bigint NOT NULL,
  PRIMARY KEY (page_id, vault_kind, album_ref)
);
