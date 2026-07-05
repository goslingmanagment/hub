-- Stage 10 (platform-neutral message archive): the projection fed by
-- message.* domain events, backfilled from dm_message_archive (frozen as a
-- source, writer keeps running until cutover), the hot table, and replayed
-- observations. Rebuildable by one command — a projection, never a fact
-- store; upstream facts live in observations/domain_events.
--
-- NAMING DEVIATION (recorded in the stage Progress): the spec's generic
-- watermark table name projection_watermarks is ALREADY taken by the spender
-- rebuild timestamps table — the generic per-account event high-water lives
-- in projection_seq_watermarks instead.

CREATE TABLE "message_archive" (
  "id"                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Stage 13 fact-table policy: RESTRICT (13 deployed before this stage).
  "account_id"         bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"           text NOT NULL,
  "native_account_ref" text,
  "conversation_ref"   text,
  "message_ref"        text NOT NULL,
  "fan_native_id"      text,
  "sender_role"        text NOT NULL DEFAULT 'unknown',
  "is_sent_by_me"      boolean NOT NULL DEFAULT false,
  "occurred_at"        timestamp with time zone,
  "text_plain"         text NOT NULL DEFAULT '',
  "price_mills"        bigint,
  "is_tip"             boolean NOT NULL DEFAULT false,
  "tip_amount_mills"   bigint NOT NULL DEFAULT 0,
  "in_reply_to_ref"    text,
  "media_metadata"     jsonb NOT NULL DEFAULT '[]',
  "deleted_at"         timestamp with time zone,
  "source_event_id"    bigint,
  "backfill_source"    text,
  "archived_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE ("account_id", "platform", "message_ref")
);
CREATE INDEX "message_archive_account_conv_idx"
  ON "message_archive" ("account_id", "conversation_ref", "occurred_at");
CREATE INDEX "message_archive_account_occurred_idx"
  ON "message_archive" ("account_id", "occurred_at");
CREATE INDEX "message_archive_text_search_idx"
  ON "message_archive" USING gin (to_tsvector('simple', "text_plain"));

-- The standard per-account event high-water shape; later projections reuse it.
CREATE TABLE "projection_seq_watermarks" (
  "projection" text NOT NULL,
  "account_id" bigint NOT NULL,
  "high_seq"   bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("projection", "account_id")
);
