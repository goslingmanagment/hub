-- 0083: W10 (B10, decision #134) — message_archive shadow rebuild table.
--
-- The Stage 10 rebuild (delete + event replay) is structurally lossy: the
-- replay reads only ATTACHED domain_events partitions, and the delete
-- destroys legacy-seed rows (source_event_id IS NULL, backfill_source IN
-- ('dm_message_archive','hot_table')) whose hot originals may already be
-- pruned — for those rows the archive IS the only copy. The build spec
-- rejected in-place rebuild (docs/fastreply-freshness-build-spec.md); the
-- chosen direction is a SHADOW build: lift + replay + backfill into this
-- table, prove fidelity by set difference, then atomically swap it into
-- place (rename old → message_archive_retired_<ts>, shadow → message_archive,
-- rename indexes, force-reset the projection watermark).
--
-- Same shape as message_archive (0059) column for column; index/constraint
-- names are distinct so both tables coexist until the switch renames the
-- shadow's to the canonical names. Deploy is inert: nothing reads or writes
-- this table until the archive:rebuild-* CLI machinery runs.

CREATE TABLE "message_archive_shadow" (
  "id"                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  "content_pending"    boolean NOT NULL DEFAULT false,
  "deleted_at"         timestamp with time zone,
  "source_event_id"    bigint,
  "backfill_source"    text,
  "archived_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "message_archive_shadow_account_platform_message_ref_key"
    UNIQUE ("account_id", "platform", "message_ref")
);
CREATE INDEX "message_archive_shadow_account_conv_idx"
  ON "message_archive_shadow" ("account_id", "conversation_ref", "occurred_at");
CREATE INDEX "message_archive_shadow_account_occurred_idx"
  ON "message_archive_shadow" ("account_id", "occurred_at");
CREATE INDEX "message_archive_shadow_text_search_idx"
  ON "message_archive_shadow" USING gin (to_tsvector('simple', "text_plain"));
