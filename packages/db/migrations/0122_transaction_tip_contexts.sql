-- Exact Fansly tip context recovered from the `/message` response sidecar.
-- The provider tip id is the same opaque ref stored in
-- transactions.correlation_id; request_params.groupId supplies the captured
-- conversation. source_raw_payload_id/captured_at prove tip identity plus
-- conversation scope; the separate tip_message_* pair proves the exact raw
-- whose note won the knowledge-monotonic merge. Raw payloads remain the
-- authority and this table is an idempotent, rebuildable materialization.

CREATE TABLE "transaction_tip_contexts" (
  "id"                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id"                bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                  text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "platform_tip_id"           text NOT NULL,
  "captured_conversation_ref" text NOT NULL,
  "tip_message_text"          text,
  "tip_message_source_raw_payload_id" bigint
    REFERENCES "sync_raw_payloads"("id") ON DELETE SET NULL,
  "tip_message_captured_at"   timestamp with time zone,
  "tip_amount_mills"          bigint,
  "occurred_at"               timestamp with time zone NOT NULL,
  "sender_platform_user_id"   text NOT NULL,
  "receiver_platform_user_id" text,
  "source_raw_payload_id"     bigint
    REFERENCES "sync_raw_payloads"("id") ON DELETE SET NULL,
  "captured_at"               timestamp with time zone NOT NULL,
  "provenance"                text NOT NULL,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "transaction_tip_contexts_account_tip_uniq"
    UNIQUE ("account_id", "platform_tip_id"),
  CONSTRAINT "transaction_tip_contexts_refs_check" CHECK (
    length("platform_tip_id") > 0
    AND length("captured_conversation_ref") > 0
    AND length("sender_platform_user_id") > 0
    AND ("receiver_platform_user_id" IS NULL OR length("receiver_platform_user_id") > 0)
  ),
  CONSTRAINT "transaction_tip_contexts_amount_check" CHECK (
    "tip_amount_mills" IS NULL OR "tip_amount_mills" >= 0
  ),
  CONSTRAINT "transaction_tip_contexts_tip_message_lineage_check" CHECK (
    (
      "tip_message_text" IS NULL
      AND "tip_message_source_raw_payload_id" IS NULL
      AND "tip_message_captured_at" IS NULL
    )
    OR (
      "tip_message_text" IS NOT NULL
      AND "tip_message_captured_at" IS NOT NULL
    )
  ),
  CONSTRAINT "transaction_tip_contexts_provenance_check" CHECK (
    "platform" = 'fansly'
    AND "provenance" = 'fansly_dm_tip_sidecar'
  )
);

CREATE INDEX "transaction_tip_contexts_account_occurred_idx"
  ON "transaction_tip_contexts" ("account_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "transaction_tip_contexts_account_conversation_occurred_idx"
  ON "transaction_tip_contexts"
    ("account_id", "captured_conversation_ref", "occurred_at" DESC, "id" DESC);
CREATE INDEX "transaction_tip_contexts_source_raw_payload_idx"
  ON "transaction_tip_contexts" ("source_raw_payload_id");
CREATE INDEX "transaction_tip_contexts_tip_message_source_raw_payload_idx"
  ON "transaction_tip_contexts" ("tip_message_source_raw_payload_id");

-- Historical recovery walks only Fansly `/message` capture rows by raw id.
-- A partial keyset index prevents unrelated retained payload families from
-- turning replay into a full journal scan.
CREATE INDEX "sync_raw_payloads_dm_tip_context_backfill_idx"
  ON "sync_raw_payloads" ("id")
  WHERE "endpoint" = 'dm_messages' AND "payload_kind" = 'dm_messages';
