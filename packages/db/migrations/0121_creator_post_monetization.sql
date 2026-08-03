-- Fansly creator-post monetization. The timeline remains the authority for
-- cumulative post/goal heads; /tips?targetIds=... supplies immutable
-- fan-to-post rows. Both arrive raw-first and project from canonical events.

ALTER TABLE "creator_posts"
  ADD COLUMN "tip_amount_mills" bigint,
  ADD COLUMN "attachment_tip_amount_mills" bigint,
  ADD COLUMN "post_tip_total_mills" bigint,
  ADD COLUMN "tip_goal_linked" boolean,
  ADD COLUMN "tip_goal_ref" text,
  ADD COLUMN "tip_goal_label" text,
  ADD COLUMN "tip_goal_target_mills" bigint,
  ADD COLUMN "tip_goal_current_mills" bigint,
  ADD COLUMN "tip_goal_amounts_hidden" boolean,
  ADD CONSTRAINT "creator_posts_tip_amount_check" CHECK (
    "tip_amount_mills" IS NULL OR "tip_amount_mills" >= 0
  ),
  ADD CONSTRAINT "creator_posts_attachment_tip_amount_check" CHECK (
    "attachment_tip_amount_mills" IS NULL OR "attachment_tip_amount_mills" >= 0
  ),
  ADD CONSTRAINT "creator_posts_tip_total_check" CHECK (
    "post_tip_total_mills" IS NULL OR "post_tip_total_mills" >= 0
  ),
  ADD CONSTRAINT "creator_posts_tip_total_consistency_check" CHECK (
    "post_tip_total_mills" IS NOT DISTINCT FROM CASE
      WHEN "tip_amount_mills" IS NULL AND "attachment_tip_amount_mills" IS NULL THEN NULL
      ELSE coalesce("tip_amount_mills", 0) + coalesce("attachment_tip_amount_mills", 0)
    END
  ),
  ADD CONSTRAINT "creator_posts_tip_goal_ref_check" CHECK (
    "tip_goal_ref" IS NULL OR length("tip_goal_ref") > 0
  ),
  ADD CONSTRAINT "creator_posts_tip_goal_amount_check" CHECK (
    ("tip_goal_target_mills" IS NULL OR "tip_goal_target_mills" >= 0)
    AND ("tip_goal_current_mills" IS NULL OR "tip_goal_current_mills" >= 0)
  ),
  ADD CONSTRAINT "creator_posts_tip_goal_link_check" CHECK (
    CASE
      WHEN "tip_goal_linked" IS TRUE THEN "tip_goal_ref" IS NOT NULL
      ELSE "tip_goal_ref" IS NULL
        AND "tip_goal_label" IS NULL
        AND "tip_goal_target_mills" IS NULL
        AND "tip_goal_current_mills" IS NULL
        AND "tip_goal_amounts_hidden" IS NULL
    END
  );

CREATE TABLE "creator_post_tips" (
  "id"                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id"                  bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                    text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "platform_post_id"            text NOT NULL,
  "platform_tip_id"             text NOT NULL,
  "tip_sender_platform_user_id" text NOT NULL,
  "post_tip_amount_mills"       bigint NOT NULL,
  "occurred_at"                 timestamp with time zone NOT NULL,
  "receiver_transaction_ref"    text,
  "sender_transaction_ref"      text,
  "tip_goal_ref"                text,
  "tip_message_text"            text,
  "first_observed_at"           timestamp with time zone NOT NULL,
  "last_observed_at"            timestamp with time zone NOT NULL,
  "content_hash"                char(64) NOT NULL,
  "source_event_id"             bigint NOT NULL,
  "source_observation_id"       bigint NOT NULL,
  "source_account_seq"          bigint NOT NULL,
  "created_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "creator_post_tips_account_tip_post_uniq"
    UNIQUE ("account_id", "platform_tip_id", "platform_post_id"),
  CONSTRAINT "creator_post_tips_refs_check" CHECK (
    length("platform_post_id") > 0
    AND length("platform_tip_id") > 0
    AND length("tip_sender_platform_user_id") > 0
    AND ("receiver_transaction_ref" IS NULL OR length("receiver_transaction_ref") > 0)
    AND ("sender_transaction_ref" IS NULL OR length("sender_transaction_ref") > 0)
    AND ("tip_goal_ref" IS NULL OR length("tip_goal_ref") > 0)
  ),
  CONSTRAINT "creator_post_tips_amount_check" CHECK ("post_tip_amount_mills" >= 0),
  CONSTRAINT "creator_post_tips_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "creator_post_tips_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "creator_post_tips_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE INDEX "creator_post_tips_account_occurred_idx"
  ON "creator_post_tips" ("account_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "creator_post_tips_account_post_idx"
  ON "creator_post_tips" ("account_id", "platform_post_id", "occurred_at" DESC);
CREATE INDEX "creator_post_tips_account_sender_occurred_idx"
  ON "creator_post_tips"
    ("account_id", "tip_sender_platform_user_id", "occurred_at" DESC, "id" DESC);
CREATE INDEX "creator_post_tips_receiver_transaction_idx"
  ON "creator_post_tips" ("account_id", "receiver_transaction_ref")
  WHERE "receiver_transaction_ref" IS NOT NULL;
