-- Creator posts: capture remains in observations, canonical material remains
-- append-only in domain_events, and creator_posts is only the rebuildable
-- current-head projection. An empty/partial timeline is never deletion proof.

ALTER TYPE "sync_stream" ADD VALUE IF NOT EXISTS 'posts';

-- First-class post lineage in the canonical ledger. The partitioned parent
-- propagates the column to every attached partition; no FK is possible across
-- the partitioned observation/event ledgers, so integrity is by append protocol.
ALTER TABLE "domain_events" ADD COLUMN "post_ref" text;

CREATE TABLE "creator_posts" (
  "id"                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id"            bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"              text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "platform_post_id"      text NOT NULL,
  "text_plain"            text NOT NULL DEFAULT '',
  "published_at"          timestamp with time zone NOT NULL,
  "first_observed_at"     timestamp with time zone NOT NULL,
  "last_observed_at"      timestamp with time zone NOT NULL,
  "content_hash"          char(64) NOT NULL,
  "attachment_count"      integer NOT NULL DEFAULT 0,
  "source_event_id"       bigint NOT NULL,
  "source_observation_id" bigint NOT NULL,
  "source_account_seq"    bigint NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_posts_account_post_uniq" UNIQUE ("account_id", "platform_post_id"),
  CONSTRAINT "creator_posts_post_id_check" CHECK (length("platform_post_id") > 0),
  CONSTRAINT "creator_posts_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_posts_attachment_count_check" CHECK ("attachment_count" >= 0),
  CONSTRAINT "creator_posts_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_posts_observed_order_check" CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "creator_posts_account_published_idx"
  ON "creator_posts" ("account_id", "published_at" DESC, "id" DESC);
CREATE INDEX "creator_posts_account_observed_idx"
  ON "creator_posts" ("account_id", "last_observed_at" DESC, "id" DESC);

-- OFAPI creator-post collection uses the governed capture-before-parse job
-- plane (decision #158), not the generic read gateway.
ALTER TABLE "ofapi_capture_jobs"
  DROP CONSTRAINT "ofapi_capture_jobs_kind_check";
ALTER TABLE "ofapi_capture_jobs"
  ADD CONSTRAINT "ofapi_capture_jobs_kind_check" CHECK (
    "kind" IN (
      'chat_paginate',
      'campaign_snapshot',
      'head_repair',
      'account_export',
      'export_import',
      'post_paginate'
    )
  );
